// Tests for monitor/usageTotals.js — the token-usage fallback chain extracted
// from MonitorView.js (P4 split).

import { describe, it, expect } from 'vitest';
import { accumulateUsage, sumLogUsage, usageTotals } from '../usageTotals.js';

describe('accumulateUsage', () => {
    it('sums one token_usage event into an accumulator', () => {
        const acc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const out = accumulateUsage(acc, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
        expect(out).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
    });

    it('falls back to deriving total when total_tokens missing', () => {
        const acc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const out = accumulateUsage(acc, { prompt_tokens: 8, completion_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
        expect(out.total_tokens).toBe(14);
    });
});

describe('sumLogUsage', () => {
    it('sums every token_usage event in the log', () => {
        const logs = [
            { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
            { event: 'status', data: {} },
            { event: 'token_usage', data: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
        ];
        const out = sumLogUsage(logs);
        expect(out).toMatchObject({ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 });
    });

    it('ignores non-usage events and empty logs', () => {
        expect(sumLogUsage([{ event: 'status' }])).toMatchObject({ prompt_tokens: 0, total_tokens: 0 });
        expect(sumLogUsage([]).total_tokens).toBe(0);
    });
});

describe('usageTotals (the fallback chain)', () => {
    it('prefers the live accumulator when it has tokens', () => {
        const live = { total_tokens: 42 };
        expect(usageTotals({ live, stored: { total_tokens: 10 }, logs: [] })).toBe(live);
    });

    it('falls back to the stored task record', () => {
        const stored = { prompt_tokens: 7, total_tokens: 0 };
        expect(usageTotals({ live: {}, stored, logs: [] })).toBe(stored);
    });

    it('falls back to summing the logs', () => {
        const logs = [{ event: 'token_usage', data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }];
        const out = usageTotals({ live: {}, stored: null, logs });
        expect(out.total_tokens).toBe(3);
    });

    it('returns zeros when nothing has data', () => {
        expect(usageTotals({ live: {}, stored: null, logs: [] }).total_tokens).toBe(0);
    });
});
