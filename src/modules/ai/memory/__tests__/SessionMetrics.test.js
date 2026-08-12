// SessionMetrics — the numbers Step 1 is now judged on.
//
// The original gate (failure recurrence rate) produced ~0.2 observations per
// session, which cannot carry a decision. These produce one or more each run, so
// what they mean has to be exact.

import { describe, it, expect, vi } from 'vitest';
import {
    explorationCost, reReads, parseRecipe, followsRecipe, followThrough,
    sessionMetrics, compareArms, appendSessionMetrics, parseMetrics,
} from '../SessionMetrics.js';

const e = (i, tool, target) => ({ i, tool, target, ok: true });

describe('explorationCost', () => {
    it('counts the calls made before the first edit', () => {
        expect(explorationCost([
            e(1, 'grep_search'), e(2, 'read_file', 'a.js'), e(3, 'write_file', 'a.js'),
        ])).toBe(2);
    });

    it('is 0 when the agent edited straight away', () => {
        expect(explorationCost([e(1, 'write_file', 'a.js')])).toBe(0);
    });

    it('is null when nothing was edited — there is no "before" to measure', () => {
        expect(explorationCost([e(1, 'read_file', 'a.js')])).toBeNull();
        expect(explorationCost([])).toBeNull();
    });

    it('does not treat run_command as the end of exploration', () => {
        // "explore → run the tests → explore more → edit" is one exploration,
        // not a run that started editing at step 2.
        expect(explorationCost([
            e(1, 'grep_search'), e(2, 'run_command'), e(3, 'read_file', 'a.js'), e(4, 'write_file', 'a.js'),
        ])).toBe(3);
    });
});

describe('reReads', () => {
    it('counts reading the same file twice', () => {
        expect(reReads([e(1, 'read_file', 'a.js'), e(2, 'read_file', 'b.js'), e(3, 'read_file', 'a.js')])).toBe(1);
    });
    it('ignores different files and non-read tools', () => {
        expect(reReads([e(1, 'read_file', 'a.js'), e(2, 'write_file', 'a.js'), e(3, 'grep_search')])).toBe(0);
    });
});

describe('followThrough — did the agent do what the card said?', () => {
    it('parses a recipe from the card text', () => {
        expect(parseRecipe('read_file → write_file')).toEqual(['read_file', 'write_file']);
        expect(parseRecipe('read_file -> write_file')).toEqual(['read_file', 'write_file']);
        expect(parseRecipe('')).toEqual([]);
    });

    it('matches the order as a subsequence, allowing unrelated calls between', () => {
        const events = [e(2, 'read_file', 'a.js'), e(3, 'grep_search'), e(4, 'write_file', 'a.js')];
        expect(followsRecipe(events, ['read_file', 'write_file'], 1)).toBe(true);
    });

    it('does not count the order happening in reverse', () => {
        expect(followsRecipe([e(2, 'write_file', 'a.js'), e(3, 'read_file', 'a.js')], ['read_file', 'write_file'], 1)).toBe(false);
    });

    it('ignores what happened BEFORE the card was shown', () => {
        const events = [e(1, 'read_file', 'a.js'), e(2, 'write_file', 'a.js')];
        expect(followsRecipe(events, ['read_file', 'write_file'], 5)).toBe(false);
    });

    it('scores only the cards that make a checkable claim', () => {
        // A locator ("X is in Y") recommends no tool order, so counting it as
        // followed or ignored would be noise either way.
        const events = [e(2, 'read_file', 'a.js'), e(3, 'write_file', 'a.js')];
        const out = followThrough(events, [
            { id: 'L-1', at: 1, recipe: 'read_file → write_file' },
            { id: 'I-2', at: 1, recipe: '' },
        ]);
        expect(out).toEqual({ checked: 1, followed: 1, rate: 1 });
    });

    it('reports advice that was injected and ignored', () => {
        const out = followThrough([e(2, 'write_file', 'a.js')], [{ id: 'L-1', at: 1, recipe: 'read_file → write_file' }]);
        expect(out).toEqual({ checked: 1, followed: 0, rate: 0 });
    });

    it('is null — not zero — when nothing checkable was shown', () => {
        expect(followThrough([], []).rate).toBeNull();
    });
});

describe('sessionMetrics', () => {
    it('produces one row describing the run', () => {
        const row = sessionMetrics({
            events: [e(1, 'grep_search'), e(2, 'read_file', 'a.js'), e(3, 'write_file', 'a.js')],
            shownLog: [{ id: 'L-1', at: 1, recipe: 'read_file → write_file' }],
            failures: [{ unresolved: false }, { unresolved: true }],
            iterations: 3, recall: 'on', memoryChars: 180, sessionId: 's1', date: '2026-08-11',
        });
        expect(row).toMatchObject({
            recall: 'on', iterations: 3, toolCalls: 3, explorationCost: 2,
            failures: 2, unresolvedFailures: 1, cardsShown: 1, followChecked: 1, followed: 1,
        });
    });

    it('records the arm even when nothing was recalled', () => {
        expect(sessionMetrics({ recall: 'off' }).recall).toBe('off');
    });
});

describe('compareArms', () => {
    const row = (over) => ({ recall: 'on', iterations: 10, toolCalls: 12, explorationCost: 5, reReads: 1, failures: 1, ...over });

    it('reports the difference as on − off, so a negative delta is the win', () => {
        const out = compareArms([
            row({ recall: 'on', iterations: 8, explorationCost: 3 }),
            row({ recall: 'off', iterations: 12, explorationCost: 7 }),
        ]);
        expect(out.delta.iterations).toBe(-4);
        expect(out.delta.explorationCost).toBe(-4);
        expect(out.comparable).toBe(true);
    });

    it('refuses to report a delta from one arm alone', () => {
        // An A/B with no B is not a result, and presenting it as one is how a
        // memory layer gets declared a success without evidence.
        const out = compareArms([row(), row()]);
        expect(out.comparable).toBe(false);
        expect(out.delta.iterations).toBeNull();
        expect(out.on.runs).toBe(2);
        expect(out.off.runs).toBe(0);
    });

    it('pools follow-through across the recall arm only', () => {
        const out = compareArms([
            row({ followChecked: 2, followed: 1 }),
            row({ followChecked: 2, followed: 2 }),
            row({ recall: 'off', followChecked: 9, followed: 0 }),
        ]);
        expect(out.followThroughRate).toBeCloseTo(0.75);
    });

    it('survives an empty or junk input', () => {
        expect(compareArms([]).comparable).toBe(false);
        expect(compareArms(null).on.runs).toBe(0);
    });
});

describe('metrics file', () => {
    it('appends without dropping earlier rows', async () => {
        const invoke = vi.fn(async (cmd) => (cmd === 'read_file' ? '{"sessionId":"old"}\n' : null));
        await appendSessionMetrics({ workspacePath: 'C:/ws', invoke, row: { sessionId: 'new' } });
        const write = invoke.mock.calls.find(c => c[0] === 'write_file');
        expect(write[1].path).toBe('C:/ws/.agent/trace/metrics.jsonl');
        expect(parseMetrics(write[1].content).map(r => r.sessionId)).toEqual(['old', 'new']);
    });

    it('writes the first row into a file that does not exist yet', async () => {
        const invoke = vi.fn(async (cmd) => { if (cmd === 'read_file') throw new Error('ENOENT'); return null; });
        await appendSessionMetrics({ workspacePath: 'C:/ws', invoke, row: { sessionId: 'first' } });
        const write = invoke.mock.calls.find(c => c[0] === 'write_file');
        expect(parseMetrics(write[1].content)).toEqual([{ sessionId: 'first' }]);
    });

    it('never throws, and does nothing without a workspace', async () => {
        const invoke = vi.fn(async () => { throw new Error('disk full'); });
        await expect(appendSessionMetrics({ workspacePath: 'C:/ws', invoke, row: { a: 1 } })).resolves.toBe(false);
        await expect(appendSessionMetrics({ invoke, row: { a: 1 } })).resolves.toBe(false);
    });

    it('skips corrupt lines when reading back', () => {
        expect(parseMetrics('{"a":1}\nnot json\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
    });
});
