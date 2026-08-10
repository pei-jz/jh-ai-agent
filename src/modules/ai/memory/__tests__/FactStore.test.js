import { describe, it, expect } from 'vitest';
import { mergeFacts, selectRelevantFacts, retentionScore, pruneFacts, applyConsolidation } from '../FactStore.js';

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

    it('merges Japanese near-duplicates via character bigrams', () => {
        const facts = [];
        mergeFacts(facts, ['データベースはPostgreSQLでAWS上にホストされている']);
        mergeFacts(facts, ['データベースはPostgreSQLでAWS上にホストされています']);
        expect(facts).toHaveLength(1);
        expect(facts[0].hits).toBe(2);
    });

    it('keeps different Japanese facts separate', () => {
        const facts = [];
        mergeFacts(facts, ['データベースはPostgreSQLでAWS上にホストされている']);
        mergeFacts(facts, ['フロントエンドはReactとViteで構築されている']);
        expect(facts).toHaveLength(2);
    });

    it('is safe for non-array inputs', () => {
        expect(mergeFacts(null, ['x'])).toBeNull();
        const facts = [];
        expect(mergeFacts(facts, null)).toBe(facts);
        expect(facts).toHaveLength(0);
    });
});

describe('retentionScore / pruneFacts', () => {
    const DAY = 86_400_000;
    it('decays hits with a 90-day half-life', () => {
        const now = Date.now();
        const fresh = { hits: 2, timestamp: now };
        const old = { hits: 2, timestamp: now - 90 * DAY };
        expect(retentionScore(fresh, now)).toBeCloseTo(2);
        expect(retentionScore(old, now)).toBeCloseTo(1);
    });
    it('prunes stale once-hot facts before fresh ones', () => {
        const now = Date.now();
        const facts = [
            { fact: 'stale hot', hits: 3, timestamp: now - 360 * DAY },  // 3 * 0.5^4 ≈ 0.19
            { fact: 'fresh', hits: 1, timestamp: now },                   // 1
            { fact: 'recent', hits: 1, timestamp: now - 10 * DAY },       // ≈ 0.93
        ];
        pruneFacts(facts, 2, now);
        expect(facts).toHaveLength(2);
        expect(facts.some(f => f.fact === 'stale hot')).toBe(false);
    });
    it('leaves arrays under the cap untouched', () => {
        const facts = [{ fact: 'a' }];
        expect(pruneFacts(facts, 5)).toHaveLength(1);
    });
});

describe('applyConsolidation', () => {
    const mk = () => ([
        { fact: 'uses Vite', hits: 1, timestamp: 100 },
        { fact: 'bundler is Vite', hits: 2, timestamp: 200 },
        { fact: 'temp note about today', hits: 1, timestamp: 50 },
        { fact: 'db is PostgreSQL', hits: 1, timestamp: 300 },
    ]);
    it('merges and removes per plan, summing hits and keeping newest timestamp', () => {
        const next = applyConsolidation(mk(), {
            remove: [2],
            merge: [{ into: 1, from: [0], text: 'The bundler is Vite' }],
        });
        expect(next).toHaveLength(2);
        const merged = next.find(f => /vite/i.test(f.fact));
        expect(merged.fact).toBe('The bundler is Vite');
        expect(merged.hits).toBe(3);
        expect(merged.timestamp).toBe(200);
    });
    it('ignores invalid indices', () => {
        const next = applyConsolidation(mk(), { remove: [99, -1], merge: [{ into: 99, from: [0] }] });
        expect(next).toHaveLength(4);
    });
    it('refuses a plan that would mass-delete the store', () => {
        const facts = mk();
        const next = applyConsolidation(facts, { remove: [0, 1, 2, 3] });
        expect(next).toBe(facts); // untouched
    });
    it('is safe for malformed plans', () => {
        const facts = mk();
        expect(applyConsolidation(facts, null)).toBe(facts);
        expect(applyConsolidation(facts, { remove: 'x', merge: 'y' })).toHaveLength(4);
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
    it('minScore drops facts unrelated to the query', () => {
        const facts = [
            { fact: 'auth uses JWT tokens', timestamp: 1 },
            { fact: 'styling uses tailwind css grid', timestamp: 2 },
        ];
        // Query overlaps only the auth fact → the unrelated one is filtered out.
        const top = selectRelevantFacts(facts, 'auth token', 5, 0.1);
        expect(top).toHaveLength(1);
        expect(top[0].fact).toMatch(/auth/);
    });
    it('minScore=0 keeps the old (no-floor) behaviour', () => {
        const facts = [
            { fact: 'auth uses JWT tokens', timestamp: 1 },
            { fact: 'styling uses tailwind', timestamp: 2 },
        ];
        expect(selectRelevantFacts(facts, 'auth', 5, 0)).toHaveLength(2);
    });
    it('empty query is unaffected by minScore (0.5 baseline clears the floor)', () => {
        const facts = [{ fact: 'anything', timestamp: 1 }];
        expect(selectRelevantFacts(facts, '', 5, 0.1)).toHaveLength(1);
    });
});
