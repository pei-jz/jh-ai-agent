// Phase routing, end to end through the REAL AgentController loop.
//
// ModelPhaseRouter's own tests cover the policy in isolation. What they cannot
// show is that the loop actually FIRES the events — a phase machine nobody calls
// is a phase machine that always says "execute". These tests assert on the model
// override handed to each LLM call, which is the thing that costs money.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

const FAST = 'i1:flash';
const DEEP = 'i2:kimi';

const routed = (over = {}) => ({
    fast_model_id: FAST,
    deep_model_id: DEEP,
    phase_routing: 'on',
    plan_mode: 'off',        // plan-first is tested separately; keep the gate out
    ...over,
});

/** A summary long enough to count as a deliverable (a thin one gets nudged). */
const REPORT = '結論: '.padEnd(500, '詳細');

/** A prompt TaskComplexity judges complex, so the run opens in the plan phase. */
const COMPLEX = 'Refactor the authentication module across all services, '
    + 'update every caller, add tests, and migrate the config schema.';

describe('phase routing — off by default', () => {
    it('does not move the model when the setting is absent', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { fast_model_id: FAST, deep_model_id: DEEP, plan_mode: 'off' },
            script: [toolStep('read_file', { path: 'a.js' }), finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        // Old behaviour: one tier chosen up front and held.
        expect(new Set(h.modelsPerCall).size).toBe(1);
    });
});

describe('phase routing — a complex task', () => {
    it('plans on deep, implements on fast, verifies on deep', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed(),
            script: [
                // 1. planning — registers the subtask list
                toolStep('task_progress', { action: 'set', items: ['a', 'b'] }),
                // 2. implementing
                toolStep('write_file', { path: 'a.js', content: 'x' }),
                // 3. finishing → review
                finishStep(REPORT),
            ],
        });
        await h.run(COMPLEX);

        const [plan, exec, review] = h.modelsPerCall;
        expect(plan).toBe(DEEP);
        expect(exec).toBe(FAST);
        expect(review).toBe(FAST);   // the finish TURN is still execution…
        // …and the phase moved when finish_task was seen, which is what the
        // review gate and any follow-up turn will run on.
        expect(h.state.agent._phase).toBe('review');
        expect(h.state.agent._modelOverride).toBe(DEEP);
    });

    it('drops to fast as soon as a file is written, without waiting for the step cap', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed(),
            script: [
                toolStep('write_file', { path: 'a.js', content: 'x' }),
                toolStep('read_file', { path: 'a.js' }),
                finishStep(REPORT),
            ],
        });
        await h.run(COMPLEX);
        expect(h.modelsPerCall[0]).toBe(DEEP);   // first turn is still planning
        expect(h.modelsPerCall[1]).toBe(FAST);   // it wrote a file → execution
    });

    it('announces the switch so the user can see what they are paying for', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed(),
            script: [
                toolStep('task_progress', { action: 'set', items: ['a'] }),
                finishStep(REPORT),
            ],
        });
        await h.run(COMPLEX);
        expect(h.sawMessage(/フェーズ別ルーティング/)).toBe(true);
        expect(h.sawMessage(/モデル切替/)).toBe(true);
    });
});

describe('phase routing — a simple task', () => {
    // A one-line fix has nothing to plan, so it should never touch the deep tier.
    it('runs entirely on fast', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed(),
            script: [toolStep('read_file', { path: 'a.js' }), finishStep(REPORT)],
        });
        await h.run('fix the typo in the README');
        expect(h.modelsPerCall.every(m => m === FAST)).toBe(true);
    });
});

describe('phase routing — the guards', () => {
    it('stays off when only one tier is configured', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed({ deep_model_id: '' }),
            script: [finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        expect(h.state.agent._phaseRouting).toBe(false);
    });

    // DirectChat has a live model picker; a global tier silently overriding the
    // user's dropdown choice is the bug tier routing already had to fix once.
    it('never overrides an interactive chat model', async () => {
        const h = makeHarness({
            caller: 'DirectChat',
            config: routed(),
            script: [finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        expect(h.state.agent._phaseRouting).toBe(false);
        expect(h.modelsPerCall.every(m => m === null)).toBe(true);
    });
});

describe('phase routing — the run report', () => {
    it('records where the tokens went, so the cost claim can be checked', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: routed(),
            script: [
                toolStep('task_progress', { action: 'set', items: ['a'] }),
                toolStep('write_file', { path: 'a.js', content: 'x' }),
                finishStep(REPORT),
            ],
        });
        await h.run(COMPLEX);
        const report = h.events.map(e => e.log)
            .find(l => l && l.stepLabel === '📊 Efficiency Report');
        const pr = report.response.phase_routing;
        expect(pr.fast_model).toBe(FAST);
        expect(pr.deep_model).toBe(DEEP);
        expect(pr.tokens_by_phase.plan).toBeGreaterThan(0);
        expect(pr.tokens_by_phase.execute).toBeGreaterThan(0);
        expect(pr.execute_escalated).toBe(false);
    });

    it('says "off" when the feature is not in use', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            script: [finishStep(REPORT)],
        });
        await h.run('anything');
        const report = h.events.map(e => e.log)
            .find(l => l && l.stepLabel === '📊 Efficiency Report');
        expect(report.response.phase_routing).toBe('off');
    });
});
