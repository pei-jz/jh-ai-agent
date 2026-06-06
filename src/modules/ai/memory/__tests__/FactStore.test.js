import { describe, it, expect } from 'vitest';
import { mergeFacts, selectRelevantFacts } from '../FactStore.js';

describe('mergeFacts', () => {
    it('adds new facts and skips too-short ones', () => {
        const facts = [];
        mergeFacts(facts, ['The project uses Vite for bundling', 'short', ''], 's1');
        expect(facts).toHaveLength(1);
        expect(facts[0].fact).toContain('Vite');
        expect(facts[0].hits).toBe(1);
        expect(facts[0].sessionId).toBe('s1');
    });

    it('bumps hits on an exact (normalized) duplicate instead of adding', () => {
        const facts = [];
        mergeFacts(facts, ['The API base url is /api/v1']);
        mergeFacts(facts, ['the api base URL is /api/v1   ']); // case/space differs
        expect(facts).toHaveLength(1);
        expect(facts[0].hits).toBe(2);
    });

    it('merges strong near-duplicates via word overlap (Jaccard ≥ 0.7)', () => {
        const facts = [];
        mergeFacts(facts, ['Tokens are billed per million prompt and completion']);
        mergeFacts(facts, ['Tokens are billed per million completion and prompt extra']);
        expect(facts).toHaveLength(1);
        expect(facts[0].hits).toBe(2);
    });

    it('keeps genuinely different facts separate', () => {
        const facts = [];
        mergeFacts(facts, ['The database is PostgreSQL hosted on AWS']);
        mergeFacts(facts, ['The frontend framework is React with Vite']);
        expect(facts).toHaveLength(2);
    });

    it('is safe for non-array inputs', () => {
        expect(mergeFacts(null, ['x'])).toBeNull();
        const facts = [];
        expect(mergeFacts(facts, null)).toBe(facts);
        expect(facts).toHaveLength(0);
    });
});

describe('selectRelevantFacts', () => {
    it('returns [] for empty', () => {
        expect(selectRelevantFacts([], 'q')).toEqual([]);
        expect(selectRelevantFacts(null, 'q')).toEqual([]);
    });
    it('ranks by relevance and respects the limit', () => {
        const facts = [
            { fact: 'auth uses JWT tokens', timestamp: 1 },
            { fact: 'styling uses tailwind', timestamp: 2 },
            { fact: 'auth token refresh is automatic', timestamp: 3 },
        ];
        const top = selectRelevantFacts(facts, 'auth token', 2);
        expect(top).toHaveLength(2);
        expect(top.every(f => /auth/.test(f.fact))).toBe(true);
    });
    it('breaks ties by recency (newer first)', () => {
        const facts = [
            { fact: 'alpha beta gamma', timestamp: 10 },
            { fact: 'alpha beta gamma', timestamp: 20 },
        ];
        const top = selectRelevantFacts(facts, '', 1); // no query → equal relevance
        expect(top[0].timestamp).toBe(20);
    });
});
