// read_file's batch arm.
//
// Investigation was the loop's most expensive phase for the dullest reason: the
// model knew it needed five files and had to spend five round trips saying so,
// each re-sending the whole system prompt and history. `paths` collapses that
// into one call.
//
// The property that makes batching safe to PREFER is partial failure: one bad
// path must not discard the good reads, or the model falls back to reading one
// at a time and the feature is worse than useless.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { handleReadFile, READ_MANY_MAX_FILES } = await import('../handlers/readOnlyHandlers.js');

/** A ToolExecutor stand-in with an in-memory filesystem. */
function makeCtx(files) {
    return {
        workspacePath: 'C:/work',
        _fileCache: new Map(),
        resolvePath: (p) => (p.startsWith('C:/') ? p : `C:/work/${p}`),
        async _readFileSmart(resolved) {
            if (Object.prototype.hasOwnProperty.call(files, resolved)) {
                return { ok: true, path: resolved, content: files[resolved], note: '' };
            }
            return { ok: false, error: `Error: file not found: ${resolved}` };
        },
    };
}

const FILES = {
    'C:/work/a.js': 'const a = 1;\nexport default a;',
    'C:/work/b.js': 'const b = 2;\nexport default b;',
    'C:/work/c.js': 'line1\nline2\nline3\nline4\nline5',
};

let ctx;
beforeEach(() => { ctx = makeCtx(FILES); });

describe('batch read', () => {
    it('returns every requested file in one result', async () => {
        const out = await handleReadFile(ctx, { paths: ['a.js', 'b.js'] }, () => {}, null);
        expect(out).toContain('C:/work/a.js');
        expect(out).toContain('C:/work/b.js');
        expect(out).toContain('const a = 1;');
        expect(out).toContain('const b = 2;');
        expect(out).toMatch(/Read 2 of 2 file/);
    });

    it('numbers lines per file, restarting at 1', async () => {
        const out = await handleReadFile(ctx, { paths: ['a.js', 'b.js'] }, () => {}, null);
        expect(out).toContain('1\tconst a = 1;');
        expect(out).toContain('1\tconst b = 2;');
    });

    // The one that decides whether batching is safe to prefer.
    it('a missing path does NOT discard the files that were readable', async () => {
        const out = await handleReadFile(ctx, { paths: ['a.js', 'nope.js', 'b.js'] }, () => {}, null);
        expect(out).toContain('const a = 1;');
        expect(out).toContain('const b = 2;');
        expect(out).toMatch(/1 could not be read/);
        expect(out).toContain('nope.js');
    });

    it('reports every failure when nothing could be read', async () => {
        const out = await handleReadFile(ctx, { paths: ['x.js', 'y.js'] }, () => {}, null);
        expect(out).toMatch(/Read 0 of 2 file/);
        expect(out).toMatch(/2 could not be read/);
    });

    it('de-duplicates repeated paths', async () => {
        const out = await handleReadFile(ctx, { paths: ['a.js', 'a.js', 'a.js'] }, () => {}, null);
        expect(out).toMatch(/Read 1 of 1 file/);
        expect(out.match(/const a = 1;/g)).toHaveLength(1);
    });

    it('caps the file count and says so', async () => {
        const many = Array.from({ length: READ_MANY_MAX_FILES + 5 }, (_, i) => `f${i}.js`);
        const ctxMany = makeCtx(Object.fromEntries(many.map(p => [`C:/work/${p}`, 'x'])));
        const out = await handleReadFile(ctxMany, { paths: many }, () => {}, null);
        expect(out).toMatch(new RegExp(`Read ${READ_MANY_MAX_FILES} of ${READ_MANY_MAX_FILES} file`));
        expect(out).toMatch(/5 path\(s\) beyond the .*-file cap/);
    });

    it('applies `limit` per file and points at the continuation', async () => {
        const out = await handleReadFile(ctx, { paths: ['c.js'], limit: 2 }, () => {}, null);
        expect(out).toContain('1\tline1');
        expect(out).toContain('2\tline2');
        expect(out).not.toContain('3\tline3');
        expect(out).toMatch(/3 more lines/);
        expect(out).toContain('offset=3');
    });

    it('feeds the session cache, so compaction can restore what it read', async () => {
        await handleReadFile(ctx, { paths: ['a.js', 'b.js'] }, () => {}, null);
        expect(ctx._fileCache.get('C:/work/a.js').content).toBe(FILES['C:/work/a.js']);
        expect(ctx._fileCache.get('C:/work/b.js').readCount).toBe(1);
    });

    it('reads concurrently rather than one after another', async () => {
        let inFlight = 0;
        let peak = 0;
        const slow = makeCtx(FILES);
        slow._readFileSmart = async (resolved) => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return { ok: true, path: resolved, content: 'x', note: '' };
        };
        await handleReadFile(slow, { paths: ['a.js', 'b.js', 'c.js'] }, () => {}, null);
        expect(peak).toBeGreaterThan(1);
    });
});

describe('single read is unchanged', () => {
    it('still works when only `path` is given', async () => {
        const out = await handleReadFile(ctx, { path: 'a.js' }, () => {}, 'C:/work/a.js');
        expect(out).toContain('--- C:/work/a.js (2 lines) ---');
        expect(out).toContain('1\tconst a = 1;');
        expect(out).not.toMatch(/Read \d+ of/);   // no batch header
    });

    it('an empty or absent `paths` falls through to the single path', async () => {
        for (const paths of [[], null, undefined, ['   ']]) {
            const out = await handleReadFile(ctx, { path: 'a.js', paths }, () => {}, 'C:/work/a.js');
            expect(out).toContain('const a = 1;');
            expect(out).not.toMatch(/Read \d+ of/);
        }
    });

    it('honours offset+limit on a single read', async () => {
        const out = await handleReadFile(ctx, { path: 'c.js', offset: 2, limit: 2 }, () => {}, 'C:/work/c.js');
        expect(out).toContain('showing lines 2-3 of 5');
        expect(out).toContain('2\tline2');
        expect(out).not.toContain('1\tline1');
    });
});
