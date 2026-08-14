// workspaceMemory — reading and writing `<workspace>/.agent/`.
//
// The overview round-trip matters most: the note is the one memory that rides
// in every prompt, and it now carries a measured layer (conventions) in its
// front matter. A stamp that fails to survive a read+write would silently drop
// the measurements — the cheap half that keeps the note fresh — so the
// round-trip is tested explicitly.

import { describe, it, expect } from 'vitest';
import {
    memoryPaths, readOverview, writeOverview, parseCardsJsonl, serializeCardsJsonl,
} from '../workspaceMemory.js';

const invoke = (impl) => impl;
// A read_file mock that returns `content` for the overview path.
const overviewReader = (content) => async (_cmd, args) => {
    if (args?.path === 'C:/ws/.agent/memory/overview.md') return content;
    return undefined;
};

describe('memoryPaths', () => {
    it('uses forward slashes and the .agent dir', () => {
        const p = memoryPaths('C:/ws');
        expect(p.overview).toBe('C:/ws/.agent/memory/overview.md');
        expect(p.dir).toBe('C:/ws/.agent');
    });

    it('strips a trailing separator', () => {
        expect(memoryPaths('C:/ws/').overview).toBe('C:/ws/.agent/memory/overview.md');
    });
});

describe('readOverview / writeOverview round-trip', () => {
    it('keeps the measured conventions layer across a write+read', async () => {
        const conventions = {
            rules: [{ kind: 'suffix', rule: 'src/dao/*Dao.java', hits: 6, total: 6, share: 1, recipe: 'files ending in Dao under src/dao/' }],
            coverage: 1, sourceFiles: 6, assetFiles: 0, testFiles: 0,
        };
        let written = '';
        const wf = async (_cmd, args) => { written = args.content; };
        const rf = async (_cmd, args) => written;
        await writeOverview('C:/ws', '- the project', wf, '2026-08-13T00:00:00Z', conventions, 'abc1234');

        const out = await readOverview('C:/ws', rf);
        expect(out.text).toBe('- the project');
        expect(out.generatedAt).toBe('2026-08-13T00:00:00Z');
        expect(out.head).toBe('abc1234');
        expect(out.conventions).toEqual(conventions);
    });

    it('omits the conventions stamp when none are stored', async () => {
        let written = '';
        const wf = async (_cmd, args) => { written = args.content; };
        const rf = async (_cmd, args) => written;
        await writeOverview('C:/ws', '- note', wf, '2026-08-13T00:00:00Z');
        expect(written).not.toContain('conventions:');
        const out = await readOverview('C:/ws', rf);
        expect(out.conventions).toBeNull();
        expect(out.head).toBe('');
    });

    it('strips the front matter from the human-readable text', async () => {
        const raw = '<!-- generated: 2026-08-13T00:00:00Z -->\n<!-- head: abc1234 -->\n<!-- conventions: {"rules":[]} -->\n- a bullet\n';
        const out = await readOverview('C:/ws', overviewReader(raw));
        expect(out.text).toBe('- a bullet');
    });

    it('is never fatal on a missing file', async () => {
        const rf = async () => { throw new Error('no such file'); };
        const out = await readOverview('C:/ws', rf);
        expect(out).toEqual({ text: '', generatedAt: '', head: '', conventions: null });
    });
});

describe('cards jsonl', () => {
    it('round-trips objects, dropping corrupt lines', () => {
        const body = '{"a":1}\nnot json\n{"b":2}\n';
        const cards = parseCardsJsonl(body);
        expect(cards).toEqual([{ a: 1 }, { b: 2 }]);
        expect(serializeCardsJsonl(cards)).toBe('{"a":1}\n{"b":2}\n');
    });
});
