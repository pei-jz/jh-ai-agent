// What a CONTINUATION of a finished task starts from.
//
// Continuing a completed task builds a brand-new AgentController, and for a long
// time that meant the follow-up began knowing only what the previous run had
// SAID: no tool results, no file cache, no map of where the work had been. The
// symptom users reported was the agent re-reading the same code it had just
// finished editing, one follow-up after another.
//
// Three pieces close that, and each is tested where it lives:
//   • the request/answer trail plus the work-state block  → server/router.rs
//   • the phase decision for a follow-up                  → modelPhaseRouter.test.js
//   • the file cache surviving the run boundary           → HERE, plus the
//     TaskBridge hand-off in bridge/__tests__/taskBridge.test.js
//
// The property that matters most here is honesty: a carried entry is content the
// agent has on DISK, not content in its conversation, and the note it gets must
// not claim otherwise. Telling a model "you already have this" when it does not
// is worse than saying nothing at all — it proceeds without the file.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { ToolExecutor } = await import('../ToolExecutor.js');
const { handleReadFile } = await import('../tools/handlers/readOnlyHandlers.js');

/** A cache as a finished run would leave it. */
function priorCache(entries) {
    return new Map(entries.map(([path, e]) => [path, {
        content: e.content,
        readCount: e.readCount ?? 1,
        readAt: e.readAt ?? 1000,
        editedAt: e.editedAt ?? null,
    }]));
}

describe('adoptFileCache', () => {
    let ex;
    beforeEach(() => { ex = new ToolExecutor(); });

    it('installs the previous run cache at session start', async () => {
        ex.adoptFileCache(priorCache([['C:/w/a.js', { content: 'const a = 1;' }]]));
        await ex.startSession('C:/w');
        expect(ex.getFileCache().get('C:/w/a.js').content).toBe('const a = 1;');
    });

    it('marks what it carried, because that content is NOT in the conversation', async () => {
        ex.adoptFileCache(priorCache([['C:/w/a.js', { content: 'x' }]]));
        await ex.startSession('C:/w');
        expect(ex.getFileCache().get('C:/w/a.js').carriedOver).toBe(true);
    });

    it('keeps the most recently touched files when the cache is oversized', async () => {
        const many = [];
        for (let i = 0; i < 60; i++) {
            many.push([`C:/w/f${i}.js`, { content: `// ${i}`, readAt: 1000 + i }]);
        }
        const adopted = ex.adoptFileCache(priorCache(many));
        await ex.startSession('C:/w');
        expect(adopted).toBe(40);
        expect(ex.getFileCache().has('C:/w/f59.js')).toBe(true);   // newest kept
        expect(ex.getFileCache().has('C:/w/f0.js')).toBe(false);   // oldest dropped
    });

    it('starts clean when there is nothing to adopt', async () => {
        expect(ex.adoptFileCache(null)).toBe(0);
        expect(ex.adoptFileCache(new Map())).toBe(0);
        await ex.startSession('C:/w');
        expect(ex.getFileCache().size).toBe(0);
    });

    it('lists what it carried, marking which files the earlier run EDITED', async () => {
        ex.adoptFileCache(priorCache([
            ['C:/w/read.js', { content: 'r', readAt: 2000 }],
            ['C:/w/edited.js', { content: 'e', readAt: 1000, editedAt: 3000 }],
        ]));
        await ex.startSession('C:/w');
        expect(ex.carriedFiles()).toEqual([
            { path: 'C:/w/edited.js', edited: true },
            { path: 'C:/w/read.js', edited: false },
        ]);
    });

    it('drops the carried mark once this run touches the file', async () => {
        ex.adoptFileCache(priorCache([['C:/w/a.js', { content: 'const a = 1;' }]]));
        await ex.startSession('C:/w');
        const ctx = {
            _fileCache: ex.getFileCache(),
            resolvePath: (p) => p,
            async _readFileSmart(path) { return { ok: true, path, content: 'const a = 1;' }; },
        };
        await handleReadFile(ctx, { path: 'C:/w/a.js' }, null, 'C:/w/a.js');
        expect(ctx._fileCache.get('C:/w/a.js').carriedOver).toBeFalsy();
    });
});

describe('the re-read note', () => {
    const ctxWith = (cache, content) => ({
        _fileCache: cache,
        resolvePath: (p) => p,
        async _readFileSmart(path) { return { ok: true, path, content }; },
    });

    it('never claims a carried file is already in context', async () => {
        const cache = new Map([['C:/w/a.js', {
            content: 'const a = 1;', readCount: 1, readAt: 1000, editedAt: null, carriedOver: true,
        }]]);
        const out = await handleReadFile(ctxWith(cache, 'const a = 1;'), { path: 'C:/w/a.js' }, null, 'C:/w/a.js');
        expect(out).toContain('UNCHANGED since the earlier run of this task');
        expect(out).not.toContain('already have this content in context');
        // The content is still delivered — that is the whole point.
        expect(out).toContain('const a = 1;');
    });

    it('says the earlier run edited it, when it did', async () => {
        const cache = new Map([['C:/w/a.js', {
            content: 'const a = 1;', readCount: 0, readAt: null, editedAt: 5000, carriedOver: true,
        }]]);
        const out = await handleReadFile(ctxWith(cache, 'const a = 1;'), { path: 'C:/w/a.js' }, null, 'C:/w/a.js');
        expect(out).toContain('this is the file that run edited');
    });

    it('keeps the in-session wording for a file read twice in ONE run', async () => {
        const cache = new Map([['C:/w/a.js', {
            content: 'const a = 1;', readCount: 1, readAt: 1000, editedAt: null,
        }]]);
        const out = await handleReadFile(ctxWith(cache, 'const a = 1;'), { path: 'C:/w/a.js' }, null, 'C:/w/a.js');
        expect(out).toContain('already have this content in context');
    });

    it('says nothing when the file CHANGED since it was cached', async () => {
        const cache = new Map([['C:/w/a.js', {
            content: 'const a = 1;', readCount: 1, readAt: 1000, editedAt: null, carriedOver: true,
        }]]);
        const out = await handleReadFile(ctxWith(cache, 'const a = 2;'), { path: 'C:/w/a.js' }, null, 'C:/w/a.js');
        expect(out).not.toContain('UNCHANGED');
    });
});
