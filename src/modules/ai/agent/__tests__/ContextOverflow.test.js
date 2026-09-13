// ContextOverflow — task 1a1fcea7: one grep result of 3.75M characters pushed
// a 16k-token run to a 1.46M-token request, and every later defence missed it.

import { describe, it, expect } from 'vitest';
import {
    clipText, isContextLengthError, fitHistoryToBudget, MAX_TOOL_RESULT_CHARS,
} from '../ContextOverflow.js';

const est = (h) => h.reduce((n, m) => n + Math.ceil(String(m.content ?? '').length / 4), 0);

describe('clipText', () => {
    it('leaves text within the limit alone', () => {
        expect(clipText('short', 100)).toBe('short');
    });

    it('keeps the head and the tail, and says what went', () => {
        const s = 'HEAD' + 'x'.repeat(10_000) + 'TAIL';
        const out = clipText(s, 1000);
        expect(out.startsWith('HEAD')).toBe(true);
        expect(out.endsWith('TAIL')).toBe(true);
        expect(out).toMatch(/characters omitted/);
        expect(out.length).toBeLessThan(1500);
    });

    it('defaults to the tool-result cap', () => {
        expect(clipText('y'.repeat(MAX_TOOL_RESULT_CHARS + 50)).length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 400);
    });
});

describe('isContextLengthError', () => {
    it.each([
        "This model's maximum context length is 1048576 tokens. However, you requested 1460042 tokens",
        'context_length_exceeded',
        'prompt is too long: 250000 tokens > 200000 maximum',
        'The input exceeds the context window of this model',
    ])('recognises %s', (msg) => {
        expect(isContextLengthError(new Error(msg))).toBe(true);
    });

    // The distinction that matters: a real tool-schema rejection must still fall
    // back to JSON mode.
    it.each([
        'Invalid schema for function "grep_search": additionalProperties is required',
        '401 Unauthorized',
        'fetch failed',
    ])('does not claim %s', (msg) => {
        expect(isContextLengthError(new Error(msg))).toBe(false);
    });
});

describe('fitHistoryToBudget', () => {
    const history = () => [
        { role: 'user', content: '[Original Goal] find the connection check' },
        { role: 'assistant', content: 'searching' },
        { role: 'tool', name: 'grep_search', content: 'm'.repeat(400_000) },
        { role: 'user', content: 'Consider these results' },
    ];

    // The pre-send trim kept "the goal + the last three" — and the giant result
    // WAS one of the last three.
    it('shrinks the one oversized message rather than dropping the small ones', () => {
        const out = fitHistoryToBudget(history(), 20_000, est);
        expect(est(out)).toBeLessThanOrEqual(20_000);
        expect(out).toHaveLength(4);
        expect(out[0].content).toBe('[Original Goal] find the connection check');
        expect(out[3].content).toBe('Consider these results');
        expect(out[2].content.length).toBeLessThan(80_001);
    });

    it('does not mutate the history it was given', () => {
        const h = history();
        fitHistoryToBudget(h, 20_000, est);
        expect(h[2].content.length).toBe(400_000);
    });

    it('stops when nothing is left worth clipping, instead of looping', () => {
        const h = [{ role: 'user', content: 'a'.repeat(1500) }, { role: 'user', content: 'b'.repeat(1500) }];
        expect(fitHistoryToBudget(h, 1, est)).toEqual(h);
    });

    it('ignores non-string content (images)', () => {
        const h = [{ role: 'user', content: [{ type: 'image_url' }] }, { role: 'tool', content: 'z'.repeat(50_000) }];
        const out = fitHistoryToBudget(h, 2_000, est);
        expect(out[0].content).toEqual([{ type: 'image_url' }]);
    });
});
