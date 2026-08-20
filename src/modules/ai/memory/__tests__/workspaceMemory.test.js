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
    writeFacts, writeEpisodes, writeCards,
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

// Editing memory writes into <workspace>/.agent, which the path guard only knows
// about for workspaces an AGENT SESSION has opened. Without registering it first,
// correcting a fact for a project the agent has not run in this app session
// failed outright: "outside all allowed roots".
//
// Ported from views/__tests__/configView.test.js, which asserted this by driving
// ConfigView.saveMemoryFacts() — but the ordering is this module's contract.
describe('the path guard is granted BEFORE any write', () => {
    function recorder(overrides = {}) {
        const calls = [];
        const fn = async (cmd, args) => {
            calls.push({ cmd, args });
            if (overrides[cmd]) return overrides[cmd](args);
            return null;
        };
        fn.calls = calls;
        fn.of = (cmd) => calls.filter(c => c.cmd === cmd);
        fn.order = () => calls.map(c => c.cmd);
        return fn;
    }

    const cases = [
        ['facts', writeFacts, [{ fact: 'a' }], 'C:/ws/.agent/long_term/facts.json'],
        ['episodes', writeEpisodes, [{ topic: 't' }], 'C:/ws/.agent/memory.json'],
        ['cards', writeCards, [{ id: 'L-1' }], 'C:/ws/.agent/memory/cards.jsonl'],
    ];

    for (const [name, writer, data, path] of cases) {
        it(`grants .agent then writes ${name} to its own file`, async () => {
            const inv = recorder();
            await writer('C:/ws', data, inv);
            expect(inv.of('set_allowed_roots')[0].args).toEqual({ roots: ['C:/ws/.agent'] });
            expect(inv.order().indexOf('set_allowed_roots'))
                .toBeLessThan(inv.order().indexOf('write_file'));
            expect(inv.of('write_file')[0].args.path).toBe(path);
        });
    }

    it('grants ONLY .agent, never the whole workspace', async () => {
        const inv = recorder();
        await writeFacts('C:/ws', [], inv);
        expect(inv.of('set_allowed_roots')[0].args.roots).not.toContain('C:/ws');
    });

    it('strips a trailing separator from the workspace path', async () => {
        const inv = recorder();
        await writeFacts('C:/ws/', [], inv);
        expect(inv.of('set_allowed_roots')[0].args).toEqual({ roots: ['C:/ws/.agent'] });
    });

    // An older backend would otherwise turn a recoverable save into a failure.
    it('still attempts the write when the backend has no such command', async () => {
        const inv = recorder({
            set_allowed_roots: () => { throw new Error('no such command'); },
        });
        await expect(writeFacts('C:/ws', [], inv)).resolves.toBeUndefined();
        expect(inv.of('write_file')).toHaveLength(1);
    });

    it('writes the overview through the same guard', async () => {
        const inv = recorder();
        await writeOverview('C:/ws', '- a note', inv, { generatedAt: '2026-08-18T00:00:00.000Z' });
        expect(inv.of('set_allowed_roots')[0].args).toEqual({ roots: ['C:/ws/.agent'] });
        const wf = inv.of('write_file')[0].args;
        expect(wf.path).toBe('C:/ws/.agent/memory/overview.md');
        expect(wf.content).toContain('<!-- generated: ');
        expect(wf.content).toContain('- a note');
    });
});
