// ModelPhaseRouter — the policy behind "switch models inside one task".
//
// This is the piece with opinions in it, and the opinions are load-bearing in
// both directions: put the deep model in the wrong place and the feature costs
// MORE than leaving it off, put the fast model in the wrong place and the run
// plans badly. So the transitions get tests, not a comment saying they are
// obvious.

import { describe, it, expect } from 'vitest';
import {
    PHASE_TIER, PLAN_PHASE_MAX_STEPS, DEEP_PHASE_TOKEN_SHARE,
    initialPhase, advancePhase, modelForPhase, phaseLabel,
    modelRates, blendedRate, estimateSavings,
} from '../ModelPhaseRouter.js';

const TIERS = { fast: 'i1:flash', deep: 'i2:kimi' };
const ON = { enabled: true };

describe('PHASE_TIER', () => {
    it('spends the expensive model on judgement, not on volume', () => {
        expect(PHASE_TIER.plan).toBe('deep');
        expect(PHASE_TIER.review).toBe('deep');
        expect(PHASE_TIER.execute).toBe('fast');
    });
});

describe('initialPhase', () => {
    it('is execute when the feature is off, whatever the task looks like', () => {
        expect(initialPhase({ enabled: false, planFirst: true, complex: true })).toBe('execute');
    });

    it('opens in plan for a plan-first task', () => {
        expect(initialPhase({ ...ON, freshTurn: true, planFirst: true })).toBe('plan');
    });

    it('opens in plan for a task judged complex', () => {
        expect(initialPhase({ ...ON, freshTurn: true, complex: true })).toBe('plan');
    });

    it('skips the plan phase for a simple task — a one-line fix owes nothing to the deep tier', () => {
        expect(initialPhase({ ...ON, freshTurn: true })).toBe('execute');
    });

    // The expensive mistake: a continuation turn already HAS its plan, so
    // re-entering the plan phase would put the deep model on execution.
    it('never re-plans on a continuation turn', () => {
        expect(initialPhase({ ...ON, freshTurn: false, planFirst: true, complex: true })).toBe('execute');
    });
});

describe('advancePhase', () => {
    it('leaves plan when a file-modifying tool runs — writing files is not planning', () => {
        expect(advancePhase('plan', 'mutation')).toBe('execute');
    });

    it('leaves plan when the subtask list is registered', () => {
        expect(advancePhase('plan', 'plan-done')).toBe('execute');
    });

    it('holds plan while the plan-first gate is still pending', () => {
        expect(advancePhase('plan', 'mutation', { planFirstPending: true })).toBe('plan');
        expect(advancePhase('plan', 'step', { iteration: 99, planFirstPending: true })).toBe('plan');
    });

    it('releases the deep model on the plan step cap', () => {
        expect(advancePhase('plan', 'step', { iteration: PLAN_PHASE_MAX_STEPS })).toBe('plan');
        expect(advancePhase('plan', 'step', { iteration: PLAN_PHASE_MAX_STEPS + 1 })).toBe('execute');
    });

    it('enters review on finish_task', () => {
        expect(advancePhase('execute', 'finish')).toBe('review');
    });

    // Without this, one review bounce leaves the rest of a long run on the deep
    // model — the saving quietly disappears on exactly the tasks that are
    // expensive enough to care about.
    it('returns to execute when a review sends the task back', () => {
        expect(advancePhase('review', 'reopen')).toBe('execute');
    });

    it('does not walk backwards on an ordinary step', () => {
        expect(advancePhase('execute', 'step', { iteration: 50 })).toBe('execute');
        expect(advancePhase('review', 'step', { iteration: 50 })).toBe('review');
    });

    it('ignores an unknown event rather than throwing', () => {
        expect(advancePhase('execute', 'nonsense')).toBe('execute');
    });
});

describe('modelForPhase', () => {
    it('returns null when routing is off, so the caller keeps its own choice', () => {
        expect(modelForPhase('plan', TIERS, { enabled: false })).toBeNull();
    });

    it('returns null when no tier is configured', () => {
        expect(modelForPhase('plan', {}, ON)).toBeNull();
    });

    it('maps each phase to its tier', () => {
        expect(modelForPhase('plan', TIERS, ON)).toBe('i2:kimi');
        expect(modelForPhase('execute', TIERS, ON)).toBe('i1:flash');
        expect(modelForPhase('review', TIERS, ON)).toBe('i2:kimi');
    });

    it('falls back across tiers rather than returning nothing', () => {
        expect(modelForPhase('plan', { fast: 'i1:flash' }, ON)).toBe('i1:flash');
        expect(modelForPhase('execute', { deep: 'i2:kimi' }, ON)).toBe('i2:kimi');
    });

    it('promotes only EXECUTE when the long-run escalation has fired', () => {
        const esc = { enabled: true, escalated: true };
        expect(modelForPhase('execute', TIERS, esc)).toBe('i2:kimi');
        expect(modelForPhase('plan', TIERS, esc)).toBe('i2:kimi');
        expect(modelForPhase('review', TIERS, esc)).toBe('i2:kimi');
    });
});

describe('phaseLabel', () => {
    it('names every phase', () => {
        for (const p of ['plan', 'execute', 'review']) {
            expect(phaseLabel(p)).toBeTruthy();
            expect(phaseLabel(p)).not.toBe(p);
        }
    });
});

describe('modelRates', () => {
    const inst = (over) => ({ id: 'i1', name: 'A', model: 'm', ...over });

    it('keys rates by the id:model composite the routing selects speak', () => {
        const r = modelRates([inst({ cost_per_1m_input: 3, cost_per_1m_output: 15 })]);
        expect(Object.keys(r)).toEqual(['i1:m']);
        expect(r['i1:m'].label).toBe('A (m)');
    });

    // A zero rate would render as "100% cheaper", which is worse than saying
    // nothing — so a connection with no prices entered is simply absent.
    it('omits a connection with no rates rather than defaulting it to zero', () => {
        expect(modelRates([inst({})])).toEqual({});
        expect(modelRates([inst({ cost_per_1m_input: 0, cost_per_1m_output: 0 })])).toEqual({});
    });

    it('defaults cache-read to a tenth of input, the common provider ratio', () => {
        const r = modelRates([inst({ cost_per_1m_input: 3, cost_per_1m_output: 15 })]);
        expect(r['i1:m'].cacheRead).toBeCloseTo(0.3);
    });

    it('keeps an explicit cache rate', () => {
        const r = modelRates([inst({ cost_per_1m_input: 3, cost_per_1m_cache_read: 0.5, cost_per_1m_output: 15 })]);
        expect(r['i1:m'].cacheRead).toBe(0.5);
    });

    it('survives a missing or malformed list', () => {
        expect(modelRates(undefined)).toEqual({});
        expect(modelRates('nope')).toEqual({});
    });
});

describe('blendedRate', () => {
    // Agent runs are overwhelmingly input: the history is re-sent every step.
    it('weights input far above output', () => {
        expect(blendedRate({ input: 1, output: 100 })).toBeLessThan(10);
    });
});

describe('estimateSavings', () => {
    // The user's own example: Kimi K3 at $3/M in vs DeepSeek Flash at $0.3/M in.
    const instances = [
        { id: 'i1', name: 'DeepSeek', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
        { id: 'i2', name: 'Kimi', model: 'k3', cost_per_1m_input: 3, cost_per_1m_output: 15 },
    ];
    const rates = modelRates(instances);
    const tiers = { fast: 'i1:flash', deep: 'i2:k3' };

    it('reports a saving in the range those rates imply', () => {
        const s = estimateSavings(tiers, rates);
        expect(s.savedPct).toBeGreaterThan(50);
        expect(s.routed).toBeLessThan(s.baseline);
    });

    it('prices the baseline as an all-deep run, which is what it replaces', () => {
        const s = estimateSavings(tiers, rates);
        expect(s.baseline).toBeCloseTo(blendedRate(rates['i2:k3']));
    });

    it('leaves the deep share of the volume on the deep model', () => {
        const s = estimateSavings(tiers, rates);
        const expected = blendedRate(rates['i2:k3']) * DEEP_PHASE_TOKEN_SHARE
            + blendedRate(rates['i1:flash']) * (1 - DEEP_PHASE_TOKEN_SHARE);
        expect(s.routed).toBeCloseTo(expected);
    });

    it('declines to estimate when a tier has no rates entered', () => {
        expect(estimateSavings({ fast: 'i1:flash', deep: 'nope:x' }, rates)).toBeNull();
        expect(estimateSavings(tiers, {})).toBeNull();
        expect(estimateSavings(undefined, rates)).toBeNull();
    });

    it('reports no saving when both tiers are the same price', () => {
        const flat = modelRates([
            { id: 'i1', name: 'A', model: 'a', cost_per_1m_input: 3, cost_per_1m_output: 15 },
            { id: 'i2', name: 'B', model: 'b', cost_per_1m_input: 3, cost_per_1m_output: 15 },
        ]);
        expect(estimateSavings({ fast: 'i1:a', deep: 'i2:b' }, flat).savedPct).toBe(0);
    });
});
