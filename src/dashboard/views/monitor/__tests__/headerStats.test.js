// The header's arithmetic. Previously inlined in MonitorView between
// getElementById calls, so the only way to check the 85% danger threshold or the
// minute rollover was to run the app and squint at it.

import { describe, it, expect } from 'vitest';
import {
    fmtK, contextReading, contextGauge, elapsedText, startedText, compactTokens,
} from '../headerStats.js';

describe('fmtK', () => {
    it('switches precision with magnitude', () => {
        expect(fmtK(999)).toBe('999');
        expect(fmtK(1000)).toBe('1.0K');
        expect(fmtK(17554)).toBe('17.6K');
        // Past 100K the decimal is noise and costs width the header needs.
        expect(fmtK(128000)).toBe('128K');
    });

    it('treats junk as zero', () => {
        expect(fmtK(0)).toBe('0');
        expect(fmtK(undefined)).toBe('0');
        expect(fmtK(NaN)).toBe('0');
    });
});

describe('contextReading', () => {
    it('prefers the explicit context_used the agent reports', () => {
        const r = contextReading({ context_used: 42000, context_limit: 128000, prompt_tokens: 5 });
        expect(r).toEqual({ used: 42000, limit: 128000 });
    });

    it('otherwise sums the INPUT side, cache included', () => {
        // A cache read still occupies the window even though it is billed at a
        // tenth of the price — excluding it would understate how full it is.
        const r = contextReading({
            prompt_tokens: 1000, cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 500, completion_tokens: 7777,
        }, 128000);
        expect(r.used).toBe(10500);       // output is NOT part of the window
        expect(r.limit).toBe(128000);
    });

    it('falls back to the connection limit only when the event has none', () => {
        expect(contextReading({ prompt_tokens: 10, context_limit: 65536 }, 128000).limit).toBe(65536);
        expect(contextReading({ prompt_tokens: 10 }, 128000).limit).toBe(128000);
        expect(contextReading({ prompt_tokens: 10 }, 0).limit).toBe(0);
    });

    it('returns null for a tool-only step so the caller KEEPS the last reading', () => {
        // Drawing a zero here would read as "the context emptied".
        expect(contextReading({ completion_tokens: 40 })).toBe(null);
        expect(contextReading({})).toBe(null);
        expect(contextReading()).toBe(null);
    });
});

describe('contextGauge', () => {
    it('reports used / limit / percentage', () => {
        const g = contextGauge({ used: 64000, limit: 128000 });
        expect(g.label).toBe('64.0K / 128K (50%)');
        expect(g.pct).toBe(50);
        expect(g.danger).toBe(false);
    });

    it('flags danger from 85% — trimming is imminent', () => {
        expect(contextGauge({ used: 84, limit: 100 }).danger).toBe(false);
        expect(contextGauge({ used: 85, limit: 100 }).danger).toBe(true);
        expect(contextGauge({ used: 99, limit: 100 }).danger).toBe(true);
    });

    it('clamps past 100 rather than overflowing the bar', () => {
        expect(contextGauge({ used: 200, limit: 100 }).pct).toBe(100);
    });

    it('shows a question mark and NO fill when the window size is unknown', () => {
        // A bar cannot honestly show a fraction of "?".
        const g = contextGauge({ used: 9000, limit: 0 });
        expect(g.label).toBe('9.0K / ?');
        expect(g.pct).toBe(0);
    });

    it('is a dash before the first reading', () => {
        expect(contextGauge(null).label).toBe('—');
        expect(contextGauge(null).pct).toBe(0);
    });
});

describe('elapsedText', () => {
    const start = '2026-08-08T10:00:00Z';
    const at = (iso) => Date.parse(iso);

    it('counts to NOW while the run is live', () => {
        expect(elapsedText({ startedAt: start, running: true, now: at('2026-08-08T10:00:42Z') })).toBe('42s');
    });

    it('counts to the completion stamp once finished', () => {
        // Measuring a finished task against the clock made its elapsed time keep
        // growing while you looked at it.
        expect(elapsedText({
            startedAt: start, completedAt: '2026-08-08T10:00:30Z',
            running: false, now: at('2026-08-08T11:00:00Z'),
        })).toBe('30s');
    });

    it('rolls over into minutes', () => {
        expect(elapsedText({ startedAt: start, running: true, now: at('2026-08-08T10:01:00Z') })).toBe('1m 0s');
        expect(elapsedText({ startedAt: start, running: true, now: at('2026-08-08T10:06:56Z') })).toBe('6m 56s');
    });

    it('falls back to now when a finished task has no completion stamp', () => {
        expect(elapsedText({ startedAt: start, running: false, now: at('2026-08-08T10:00:10Z') })).toBe('10s');
    });

    it('never goes negative on a clock skew', () => {
        expect(elapsedText({ startedAt: start, running: true, now: at('2026-08-08T09:59:00Z') })).toBe('0s');
    });

    it('is a dash without a usable start time', () => {
        expect(elapsedText({ startedAt: '', running: true })).toBe('—');
        expect(elapsedText({ startedAt: 'not a date', running: true })).toBe('—');
        expect(elapsedText()).toBe('—');
    });
});

describe('startedText', () => {
    it('keeps the clock part, which is all the header has room for', () => {
        expect(startedText('2026-08-08T21:25:30Z')).toBe('21:25:30');
        expect(startedText('')).toBe('');
        expect(startedText(undefined)).toBe('');
    });
});

describe('compactTokens', () => {
    it('abbreviates thousands', () => {
        expect(compactTokens(999)).toBe('999');
        expect(compactTokens(12400)).toBe('12.4k');
        expect(compactTokens(2901720)).toBe('2901.7k');
    });

    it('treats junk as zero', () => {
        expect(compactTokens(undefined)).toBe('0');
        expect(compactTokens(null)).toBe('0');
    });
});
