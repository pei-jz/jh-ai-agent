// FactExtraction — what the summariser is asked for, and how its answer is read.
//
// These two decide what can EVER reach long-term memory, so they are pinned here
// rather than left to drift inside a 750-line class.

import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt, parseSummary, normalizeFactCandidate, FACT_KINDS } from '../FactExtraction.js';

describe('buildSummaryPrompt', () => {
    const p = buildSummaryPrompt('do the thing', 'did the thing');

    it('asks for the fact KIND, not just the text', () => {
        // Without this, "always run npm test" and "edited ConfigView.js" arrive as
        // indistinguishable strings and the store cannot tell a rule from a diary.
        for (const kind of FACT_KINDS) expect(p).toContain(kind);
    });

    it('puts a USER CORRECTION first among the facts', () => {
        expect(p).toMatch(/user CORRECTED/);
        expect(p).toContain('outranks everything else');
    });

    it('asks for a category, which is what scopes an observation\'s repeat count', () => {
        expect(p).toContain('"category"');
    });

    it('carries the query and the response, truncated', () => {
        const long = buildSummaryPrompt('q'.repeat(900), 'r'.repeat(2000));
        expect(long).toContain('q'.repeat(500));
        expect(long).not.toContain('q'.repeat(501));
        expect(long).not.toContain('r'.repeat(1501));
    });
});

describe('normalizeFactCandidate', () => {
    it('accepts the object form', () => {
        expect(normalizeFactCandidate({ text: 'Use build:prod', kind: 'norm' }))
            .toEqual({ text: 'Use build:prod', kind: 'norm' });
    });

    it('accepts a bare string and treats it as an observation, not a rule', () => {
        // Legacy shape. Defaulting to "norm" would let one sighting from an older
        // model become a project rule at full confidence.
        expect(normalizeFactCandidate('The API base is /api/v1'))
            .toEqual({ text: 'The API base is /api/v1', kind: 'observation' });
    });

    it('falls back to observation for an unknown kind', () => {
        expect(normalizeFactCandidate({ text: 'x'.repeat(10), kind: 'gospel' }).kind).toBe('observation');
    });

    it('drops empties and non-objects', () => {
        expect(normalizeFactCandidate('')).toBeNull();
        expect(normalizeFactCandidate({ text: '   ' })).toBeNull();
        expect(normalizeFactCandidate(null)).toBeNull();
        expect(normalizeFactCandidate(42)).toBeNull();
    });

    it('caps the stored text', () => {
        expect(normalizeFactCandidate({ text: 'y'.repeat(500) }).text).toHaveLength(300);
    });
});

describe('parseSummary', () => {
    const json = (over = {}) => JSON.stringify({
        topic: 'Header fix', actions: ['a', 'b'], outcome: 'success',
        keyFiles: ['src/a.js'], category: 'settings screen', summary: 'shrank it',
        facts: [{ text: 'Always run npm test before commit', kind: 'norm' }],
        ...over,
    });

    it('reads the full entry, including the category', () => {
        const e = parseSummary(json(), { sessionId: 's1', now: Date.parse('2026-08-11T00:00:00Z') });
        expect(e.topic).toBe('Header fix');
        expect(e.category).toBe('settings screen');
        expect(e.date).toBe('2026-08-11');
        expect(e.sessionId).toBe('s1');
        expect(e.facts).toEqual([{ text: 'Always run npm test before commit', kind: 'norm' }]);
    });

    it('tolerates prose around the JSON', () => {
        expect(parseSummary(`Here you go:\n${json()}\nhope that helps`).topic).toBe('Header fix');
    });

    it('throws when there is no JSON at all, so the caller can fall back', () => {
        expect(() => parseSummary('I could not summarise that')).toThrow();
    });

    it('rejects an outcome outside the allowed set', () => {
        expect(parseSummary(json({ outcome: 'catastrophe' })).outcome).toBe('unknown');
    });

    it('survives missing and wrong-typed fields', () => {
        const e = parseSummary('{"topic":123}');
        expect(e.actions).toEqual([]);
        expect(e.keyFiles).toEqual([]);
        expect(e.facts).toEqual([]);
        expect(e.summary).toBe('');
    });

    it('caps the facts at three', () => {
        const many = json({ facts: Array.from({ length: 9 }, (_, i) => ({ text: `fact number ${i}`, kind: 'observation' })) });
        expect(parseSummary(many).facts).toHaveLength(3);
    });
});
