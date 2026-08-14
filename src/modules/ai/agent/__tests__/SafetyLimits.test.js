import { describe, it, expect } from 'vitest';
import { normalizeSafetyLimits, SAFETY_DEFAULTS, resolveRecallArm, CONTROL_GROUP_SHARE } from '../SafetyLimits.js';

describe('normalizeSafetyLimits', () => {
    it('returns defaults for empty/missing config', () => {
        expect(normalizeSafetyLimits()).toEqual(SAFETY_DEFAULTS);
        expect(normalizeSafetyLimits({})).toEqual(SAFETY_DEFAULTS);
    });

    it('parses valid integer fields', () => {
        const r = normalizeSafetyLimits({ max_steps: 50, token_budget: 100000, no_progress_window: 8 });
        expect(r.maxSteps).toBe(50);
        expect(r.tokenBudget).toBe(100000);
        expect(r.noProgressWindow).toBe(8);
    });

    it('falls back to default on invalid/negative/non-numeric ints', () => {
        const r = normalizeSafetyLimits({ max_steps: -5, token_budget: 'abc', no_progress_window: '' });
        expect(r.maxSteps).toBe(SAFETY_DEFAULTS.maxSteps);
        expect(r.tokenBudget).toBe(SAFETY_DEFAULTS.tokenBudget);
        expect(r.noProgressWindow).toBe(SAFETY_DEFAULTS.noProgressWindow);
    });

    it('accepts numeric strings for ints', () => {
        expect(normalizeSafetyLimits({ max_steps: '30' }).maxSteps).toBe(30);
    });

    it('clamps history_budget_ratio to (0,1]', () => {
        expect(normalizeSafetyLimits({ history_budget_ratio: 0.5 }).historyBudgetRatio).toBe(0.5);
        expect(normalizeSafetyLimits({ history_budget_ratio: 1 }).historyBudgetRatio).toBe(1);
        expect(normalizeSafetyLimits({ history_budget_ratio: 0 }).historyBudgetRatio).toBe(SAFETY_DEFAULTS.historyBudgetRatio);
        expect(normalizeSafetyLimits({ history_budget_ratio: 2 }).historyBudgetRatio).toBe(SAFETY_DEFAULTS.historyBudgetRatio);
        expect(normalizeSafetyLimits({ history_budget_ratio: 'x' }).historyBudgetRatio).toBe(SAFETY_DEFAULTS.historyBudgetRatio);
    });

    it('clamps history_compress_ratio to (0,1]', () => {
        expect(normalizeSafetyLimits({ history_compress_ratio: 0.6 }).historyCompressRatio).toBe(0.6);
        expect(normalizeSafetyLimits({ history_compress_ratio: 1 }).historyCompressRatio).toBe(1);
        expect(normalizeSafetyLimits({ history_compress_ratio: 0 }).historyCompressRatio).toBe(SAFETY_DEFAULTS.historyCompressRatio);
        expect(normalizeSafetyLimits({ history_compress_ratio: 2 }).historyCompressRatio).toBe(SAFETY_DEFAULTS.historyCompressRatio);
        expect(normalizeSafetyLimits({}).historyCompressRatio).toBe(0.5);
    });

    it('validates plan_mode (off/auto/always), defaulting on bad input', () => {
        expect(normalizeSafetyLimits({ plan_mode: 'off' }).planMode).toBe('off');
        expect(normalizeSafetyLimits({ plan_mode: 'always' }).planMode).toBe('always');
        expect(normalizeSafetyLimits({ plan_mode: 'bogus' }).planMode).toBe(SAFETY_DEFAULTS.planMode);
        expect(normalizeSafetyLimits({}).planMode).toBe('auto');
    });

    it('clamps agent_temperature to [0,2]', () => {
        expect(normalizeSafetyLimits({ agent_temperature: 0 }).agentTemperature).toBe(0);
        expect(normalizeSafetyLimits({ agent_temperature: 1.3 }).agentTemperature).toBe(1.3);
        expect(normalizeSafetyLimits({ agent_temperature: 3 }).agentTemperature).toBe(SAFETY_DEFAULTS.agentTemperature);
        expect(normalizeSafetyLimits({ agent_temperature: -1 }).agentTemperature).toBe(SAFETY_DEFAULTS.agentTemperature);
    });

    // Reported: "the Fast model switches to Deep at step 15" — on every run, at
    // any step limit, including unlimited. The threshold read `maxIterations`,
    // which this module has never returned (it is `maxSteps`), so it silently
    // fell through to 30 × 0.5. Step-based promotion is off unless asked for.
    it('leaves step-based tier promotion OFF by default', () => {
        expect(normalizeSafetyLimits({}).escalateAtStep).toBe(0);
        expect(SAFETY_DEFAULTS.escalateAtStep).toBe(0);
    });

    it('never derives a threshold from the step limit', () => {
        // The old expression turned any max_steps into a promotion point.
        expect(normalizeSafetyLimits({ max_steps: 30 }).escalateAtStep).toBe(0);
        expect(normalizeSafetyLimits({ max_steps: 0 }).escalateAtStep).toBe(0);
    });

    it('takes an explicit step when one is configured', () => {
        expect(normalizeSafetyLimits({ escalate_at_step: 40 }).escalateAtStep).toBe(40);
        expect(normalizeSafetyLimits({ escalate_at_step: -5 }).escalateAtStep).toBe(0);
        expect(normalizeSafetyLimits({ escalate_at_step: 'x' }).escalateAtStep).toBe(0);
    });

    it('validates memory_recall (on/off/auto), defaulting on bad input', () => {
        expect(normalizeSafetyLimits({ memory_recall: 'off' }).memoryRecall).toBe('off');
        expect(normalizeSafetyLimits({ memory_recall: 'on' }).memoryRecall).toBe('on');
        expect(normalizeSafetyLimits({ memory_recall: 'sometimes' }).memoryRecall).toBe('auto');
    });

    it('MEASURES by default — a small share of runs is the control group', () => {
        // 'on' cannot answer whether recall helps, and a memory layer nobody can
        // evaluate is the failure this design is arranged against.
        expect(normalizeSafetyLimits({}).memoryRecall).toBe('auto');
        expect(SAFETY_DEFAULTS.memoryRecall).toBe('auto');
    });

    // Phase routing changes WHICH MODEL answers, mid-task. That is not a change
    // to make on someone's behalf, so anything but an explicit "on" is off.
    it('validates phase_routing (on/off), defaulting OFF on anything unclear', () => {
        expect(normalizeSafetyLimits({ phase_routing: 'on' }).phaseRouting).toBe('on');
        expect(normalizeSafetyLimits({ phase_routing: 'off' }).phaseRouting).toBe('off');
        expect(normalizeSafetyLimits({ phase_routing: 'yes' }).phaseRouting).toBe('off');
        expect(normalizeSafetyLimits({ phase_routing: true }).phaseRouting).toBe('off');
        expect(normalizeSafetyLimits({}).phaseRouting).toBe('off');
        expect(SAFETY_DEFAULTS.phaseRouting).toBe('off');
    });
});

// The A/B arm this run belongs to. Assigned by the system rather than by the
// user, because a human toggling the switch would toggle it by mood or by task
// type — and the arms would then differ in the work they were given, not in the
// thing being tested.
describe('resolveRecallArm', () => {
    it('recalls by default and never in the off arm', () => {
        expect(resolveRecallArm('on')).toBe(true);
        expect(resolveRecallArm(undefined)).toBe(true);
        expect(resolveRecallArm('off')).toBe(false);
    });

    it('holds back roughly the control share under auto', () => {
        expect(resolveRecallArm('auto', () => 0)).toBe(false);                       // in the control slice
        expect(resolveRecallArm('auto', () => CONTROL_GROUP_SHARE - 0.001)).toBe(false);
        expect(resolveRecallArm('auto', () => CONTROL_GROUP_SHARE)).toBe(true);      // boundary belongs to recall
        expect(resolveRecallArm('auto', () => 0.99)).toBe(true);
    });

    // This used to assert the control group was a MINORITY (≤ 0.2), on the
    // reasoning that withheld runs cost the user something real. They do — but
    // the sample size a comparison needs is set by the SMALLER arm, so a 10%
    // control made the whole measurement need ~890 runs where an even split
    // needs ~178. A control group small enough to be painless is one that never
    // produces an answer, which is a worse deal than the one it was avoiding.
    // Bounded on both sides now: over half would starve the arm being measured.
    it('splits the arms evenly enough that the comparison can converge', () => {
        expect(CONTROL_GROUP_SHARE).toBeGreaterThanOrEqual(0.3);
        expect(CONTROL_GROUP_SHARE).toBeLessThanOrEqual(0.5);
    });
});
