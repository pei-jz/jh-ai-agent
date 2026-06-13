import { describe, it, expect } from 'vitest';
import { normalizeSafetyLimits, SAFETY_DEFAULTS } from '../SafetyLimits.js';

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
});
