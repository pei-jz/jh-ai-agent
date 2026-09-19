// What a run hands back when a LIMIT ends it, not `finish_task`.
//
// The reported case: four `run_subtask` researchers, each capped at 20 steps,
// each returning its parent one line — "⚠️ 未完了のまま停止しました" — after
// four minutes of reading the codebase. Seventeen minutes of work and four
// copies of "stopped", with every finding still sitting in the run's own trail.
//
// Three things had to be true and were not: the report must carry what the run
// found, the notice must name the setting that actually governs a sub-agent,
// and the Raw Log must record that a limit fired at all (a sub-agent's status
// feed is never forwarded to its parent, so the live line reached nobody).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

/** A script that never finishes: N reading turns, each with a thought. */
const readingScript = (n, prefix = 'step') =>
    Array.from({ length: n }, (_, i) =>
        toolStep('read_file', { path: `f${i}.js` }, `${prefix} ${i}: f${i}.js を確認`));

describe('a run stopped by a limit still reports what it did', () => {
    it('assembles a partial report from the thoughts and calls of the run', async () => {
        const h = makeHarness({ script: readingScript(30), config: { max_steps: 3 } });
        const res = await h.run('調べて');

        expect(res.stopReason).toMatchObject({ kind: 'step_limit', limit: 3 });
        // The model's own words, which until now were discarded with the run.
        expect(res.response).toMatch(/途中経過|Partial progress/);
        expect(res.response).toContain('f0.js を確認');
        // …and what it actually did, so the reader can judge how far it got.
        expect(res.response).toContain('read_file(f0.js)');
    });

    it('still says WHY it stopped and where the limit lives', async () => {
        const h = makeHarness({ script: readingScript(30), config: { max_steps: 3 } });
        const res = await h.run('調べて');
        expect(res.response).toContain('Max Agent Steps');
        expect(res.response).toMatch(/未完了|Stopped before finishing/);
    });

    it('does not manufacture a report when the model wrote a real one', async () => {
        // A substantive finish_task IS the deliverable; appending an assembled
        // "partial progress" section under it would read as a second, worse
        // report of the same work.
        const h = makeHarness({ script: [finishStep('結論: '.padEnd(600, '詳細'))] });
        const res = await h.run('まとめて');
        expect(res.stopReason).toBe(null);
        expect(res.response).not.toMatch(/途中経過|Partial progress/);
    });

    it('records the stop in the log, not only in the live status feed', async () => {
        // The Raw Log is rebuilt from stored telemetry, so a status line does
        // not survive a reload — and this is the one entry a user goes looking
        // for when a task "just stopped".
        const h = makeHarness({ script: readingScript(30), config: { max_steps: 3 } });
        await h.run('調べて');

        const limits = h.events.filter(e => e.event === 'log' && e.log?.method === 'LIMIT');
        expect(limits).toHaveLength(1);
        expect(limits[0].log.response).toMatchObject({
            kind: 'step_limit', limit: 3, scope: 'run',
        });
        expect(limits[0].log.response.setting).toContain('Max Agent Steps');
    });
});

describe('a sub-agent that runs out of steps', () => {
    /** Parent finishes immediately; the rest of the script is the child's. */
    const parentThenChild = (childTurns) => [
        finishStep('親は即完了 '.padEnd(600, '。')),
        ...readingScript(childTurns, 'sub'),
    ];

    it('is capped by the CONFIGURED sub-agent limit, not a source constant', async () => {
        const h = makeHarness({
            script: parentThenChild(40),
            config: { subtask_max_steps: 4 },
        });
        await h.run('親タスク');
        const before = h.toolCalls.length;

        await h.subtaskRunner({ brief: 'view層を調査して報告', role: 'researcher' }, () => {});

        // 4 steps, not the 20 that used to be hard-coded. (The child spends one
        // call per step; a couple of turns of slack for the loop's own nudges.)
        const childCalls = h.toolCalls.length - before;
        expect(childCalls).toBeLessThanOrEqual(6);
    });

    it('returns its findings to the parent instead of only "stopped"', async () => {
        const h = makeHarness({
            script: parentThenChild(40),
            config: { subtask_max_steps: 4 },
        });
        await h.run('親タスク');
        const report = await h.subtaskRunner({ brief: '調査して報告', role: 'researcher' }, () => {});

        expect(report).toContain('[Sub-agent report');
        expect(report).toMatch(/途中経過|Partial progress/);
        expect(report).toContain('sub 0: f0.js を確認');
    });

    it('points at the sub-agent setting, and not at one that would change nothing', async () => {
        // The old notice sent the reader to "Max Agent Steps" — the parent's
        // ceiling, which has no effect whatsoever on a child's step count.
        const h = makeHarness({
            script: parentThenChild(40),
            config: { subtask_max_steps: 4 },
        });
        await h.run('親タスク');
        const report = await h.subtaskRunner({ brief: '調査して報告', role: 'researcher' }, () => {});

        expect(report).toContain('Max Sub-agent Steps');
        expect(report).not.toContain('→ Max Agent Steps');
    });
});
