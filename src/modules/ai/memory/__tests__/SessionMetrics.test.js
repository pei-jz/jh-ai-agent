// SessionMetrics — the numbers Step 1 is now judged on.
//
// The original gate (failure recurrence rate) produced ~0.2 observations per
// session, which cannot carry a decision. These produce one or more each run, so
// what they mean has to be exact.

import { describe, it, expect, vi } from 'vitest';
import {
    explorationCost, reReads, parseRecipe, followsRecipe, followThrough,
    sessionMetrics, compareArms, appendSessionMetrics, parseMetrics, runsNeeded,
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

    // A control row's whole purpose is to say "these recipes were scored, and
    // none of them were shown". Counting shadow entries as shown would erase the
    // distinction and make the control arm look like a recall arm that happened
    // to do badly.
    it('separates cards that were shown from cards merely selected', () => {
        const row = sessionMetrics({
            events: [e(1, 'read_file', 'a.js'), e(2, 'write_file', 'a.js')],
            shownLog: [
                { id: 'L-1', at: 1, recipe: 'read_file → write_file', shadow: true },
                { id: 'L-2', at: 1, recipe: 'grep_search → read_file', shadow: true },
            ],
            recall: 'off', iterations: 2,
        });
        expect(row.cardsShown).toBe(0);
        expect(row.cardsSelected).toBe(2);
        // Still scored: this is the baseline the recall arm has to beat.
        expect(row.followChecked).toBe(2);
        expect(row.followed).toBe(1);
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

    it('reports the recall arm\'s own follow-through rate', () => {
        const out = compareArms([
            row({ followChecked: 2, followed: 1 }),
            row({ followChecked: 2, followed: 2 }),
            row({ recall: 'off', followChecked: 4, followed: 1 }),
        ]);
        expect(out.followThroughRate).toBeCloseTo(0.75);
        expect(out.followThrough.on).toMatchObject({ checked: 4, followed: 3 });
    });

    // The number that actually answers "is the advice doing anything". A raw
    // follow-through of 0.75 is unimpressive if the agent produces the same tool
    // order 0.70 of the time when nobody suggests it.
    it('subtracts the control arm\'s base rate to get the lift', () => {
        const out = compareArms([
            row({ followChecked: 4, followed: 3 }),                  // 0.75 with advice
            row({ recall: 'off', followChecked: 4, followed: 1 }),   // 0.25 without
        ]);
        expect(out.followThrough.baseline.rate).toBeCloseTo(0.25);
        expect(out.followThrough.lift).toBeCloseTo(0.5);
    });

    it('leaves the lift null while the control arm has scored nothing', () => {
        // Rows written before control runs shadow-scored recipes have
        // followChecked = 0 in the off arm. That is missing data, not a base
        // rate of zero — reading it as zero would report the full raw rate as
        // lift and overstate the effect by exactly the amount in question.
        const out = compareArms([
            row({ followChecked: 4, followed: 3 }),
            row({ recall: 'off', followChecked: 0, followed: 0 }),
        ]);
        expect(out.followThrough.baseline.rate).toBeNull();
        expect(out.followThrough.lift).toBeNull();
    });

    it('survives an empty or junk input', () => {
        expect(compareArms([]).comparable).toBe(false);
        expect(compareArms(null).on.runs).toBe(0);
    });

    // Rewording the injection starts a new experiment. Pooling the generations
    // would report the mean of two different treatments as the result of one —
    // and would do it silently, which is the worst version of that mistake.
    describe('wording generations', () => {
        const mixed = [
            row({ recall: 'on', iterations: 30, injectionVariant: 'v1' }),
            row({ recall: 'off', iterations: 30, injectionVariant: 'v1' }),
            row({ recall: 'on', iterations: 10, injectionVariant: 'v2-do-lines' }),
            row({ recall: 'off', iterations: 20, injectionVariant: 'v2-do-lines' }),
        ];

        it('compares only within the requested generation', () => {
            const out = compareArms(mixed, { variant: 'v2-do-lines' });
            expect(out.on.iterations).toBe(10);
            expect(out.off.iterations).toBe(20);
            expect(out.delta.iterations).toBe(-10);
        });

        it('reports how many rows it set aside, so 0 runs is not read as a bug', () => {
            expect(compareArms(mixed, { variant: 'v2-do-lines' }).skipped).toBe(2);
            expect(compareArms(mixed, { variant: 'v3' }).skipped).toBe(4);
            expect(compareArms(mixed, { variant: 'v3' }).comparable).toBe(false);
        });

        it('treats rows written before the field existed as the first generation', () => {
            const out = compareArms([row({ recall: 'on' }), row({ recall: 'off' })], { variant: 'v1' });
            expect(out.skipped).toBe(0);
            expect(out.comparable).toBe(true);
        });

        it('pools everything when no generation is named', () => {
            expect(compareArms(mixed).on.runs).toBe(2);
            expect(compareArms(mixed).skipped).toBe(0);
        });
    });
});

describe('runsNeeded', () => {
    const rows = (vals) => vals.map(v => ({ explorationCost: v }));

    it('scales with the spread, which is what makes the target large', () => {
        const tight = runsNeeded(rows([10, 10, 11, 9, 10, 10]));
        const wide = runsNeeded(rows([2, 20, 5, 30, 1, 22, 12, 8]));
        expect(wide.perArm).toBeGreaterThan(tight.perArm);
    });

    it('reports the mean and spread it derived the target from', () => {
        // Shown next to the target so the number can be argued with rather than
        // just believed: it is the spread, not the mean, that sets the target.
        const out = runsNeeded(rows([10, 20, 30, 20, 10, 20]));
        expect(out.mean).toBeCloseTo(18.33, 1);
        expect(out.sd).toBeCloseTo(7.53, 1);
        expect(out.perArm).toBe(Math.ceil(15.7 * out.sd ** 2 / (out.mean * 0.25) ** 2));
    });

    it('gives no target for a sample with no spread at all', () => {
        // Identical values mean the sample has not yet seen the variation it
        // will have; "0 runs needed" would be the wrong reading of that.
        expect(runsNeeded(rows([10, 10, 10, 10, 10, 10]))).toBeNull();
    });

    it('refuses to estimate from too few points', () => {
        // A target computed off four numbers would be a guess wearing a
        // precise-looking integer, and it is the integer people would act on.
        expect(runsNeeded(rows([5, 7, 6, 8]))).toBeNull();
        expect(runsNeeded([])).toBeNull();
        expect(runsNeeded(null)).toBeNull();
    });

    it('ignores rows where the metric is missing', () => {
        // explorationCost is null when a run never edited anything — that is not
        // a zero, and averaging it in would drag the mean toward one.
        const out = runsNeeded([...rows([20, 22, 21, 19, 20]), { explorationCost: null }, {}]);
        expect(out.mean).toBeCloseTo(20.4);
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
