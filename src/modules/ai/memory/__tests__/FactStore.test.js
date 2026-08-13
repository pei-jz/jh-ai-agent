import { describe, it, expect } from 'vitest';
import { mergeFacts, selectRelevantFacts, retentionScore, pruneFacts, applyConsolidation, capFactText, FACT_MAX_CHARS, factType, selectNormFacts } from '../FactStore.js';

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

// ── capFactText ──────────────────────────────────────────────────────────
// Every write path into facts.json goes through this. The Memory tab's manual
// edit used to assign the raw input, so a hand-edited fact could be unbounded
// while an agent-written one was capped — the store's own invariant depended on
// which door the text came in through.
describe('capFactText', () => {
    it('caps at FACT_MAX_CHARS', () => {
        expect(capFactText('x'.repeat(400))).toHaveLength(FACT_MAX_CHARS);
    });

    it('leaves shorter text untouched', () => {
        expect(capFactText('short fact')).toBe('short fact');
    });

    it('treats null/undefined as empty rather than "null"', () => {
        expect(capFactText(null)).toBe('');
        expect(capFactText(undefined)).toBe('');
    });

    it('is applied by mergeFacts on insert', () => {
        const facts = [];
        mergeFacts(facts, ['y'.repeat(500)]);
        expect(facts[0].fact).toHaveLength(FACT_MAX_CHARS);
    });

    it('is applied by applyConsolidation when a merge rewrites the text', () => {
        const facts = [
            { fact: 'alpha fact here', hits: 1, timestamp: 1 },
            { fact: 'beta fact here', hits: 1, timestamp: 2 },
        ];
        const next = applyConsolidation(facts, { merge: [{ into: 0, from: [1], text: 'z'.repeat(500) }] });
        expect(next[0].fact).toHaveLength(FACT_MAX_CHARS);
    });
});

// ── The promotion matrix (memory layers) ─────────────────────────────────
// Frequency alone is the wrong test for what becomes durable knowledge: a
// project rule is worth keeping the first time it is stated, while "edited
// ConfigView.js" is a diary entry however often it recurs.
describe('promotion', () => {
    it('promotes a NORM on first sighting, but at low confidence', () => {
        const facts = [];
        mergeFacts(facts, [{ text: 'Always run npm test before committing', kind: 'norm' }], 's1');
        expect(facts[0].type).toBe('semantic');
        expect(facts[0].confidence).toBeCloseTo(0.5);
    });

    it('raises a norm\'s confidence each time it is restated', () => {
        const facts = [];
        const f = [{ text: 'Always run npm test before committing', kind: 'norm' }];
        mergeFacts(facts, f, 's1');
        mergeFacts(facts, f, 's2');
        expect(facts[0].hits).toBe(2);
        expect(facts[0].confidence).toBeCloseTo(0.65);
    });

    it('holds an OBSERVATION in episodic memory until the third sighting', () => {
        const facts = [];
        const f = [{ text: 'The dashboard mounts Svelte islands', kind: 'observation' }];
        mergeFacts(facts, f, 's1', 'dashboard');
        expect(facts[0].type).toBe('episodic');
        mergeFacts(facts, f, 's2', 'dashboard');
        expect(facts[0].type).toBe('episodic');
        mergeFacts(facts, f, 's3', 'dashboard');
        expect(facts[0].type).toBe('semantic');
        expect(facts[0].confidence).toBeCloseTo(0.7);
    });

    it('counts an observation\'s sightings WITHIN one category', () => {
        // The same sentence noticed once each in three unrelated areas is weaker
        // evidence, not stronger — so those stay separate facts.
        const facts = [];
        const f = [{ text: 'The dashboard mounts Svelte islands', kind: 'observation' }];
        mergeFacts(facts, f, 's1', 'dashboard');
        mergeFacts(facts, f, 's2', 'billing');
        expect(facts).toHaveLength(2);
        expect(facts.every(x => x.type === 'episodic')).toBe(true);
    });

    it('discards a self-declared work log entirely', () => {
        const facts = [];
        mergeFacts(facts, [{ text: 'Edited ConfigView.js and fixed the tab', kind: 'worklog' }], 's1');
        expect(facts).toHaveLength(0);
    });

    it('upgrades an observation that is later restated as a rule', () => {
        const facts = [];
        mergeFacts(facts, [{ text: 'Use npm run build:prod for releases', kind: 'observation' }], 's1');
        expect(facts[0].type).toBe('episodic');
        mergeFacts(facts, [{ text: 'Use npm run build:prod for releases', kind: 'norm' }], 's2');
        expect(facts[0].kind).toBe('norm');
        expect(facts[0].type).toBe('semantic');
    });

    it('still accepts the legacy bare-string form', () => {
        const facts = [];
        mergeFacts(facts, ['The project uses Vite for bundling'], 's1');
        expect(facts[0].fact).toContain('Vite');
        expect(facts[0].kind).toBe('observation');
    });

    it('reads a fact with no type as semantic — nothing has to be migrated', () => {
        expect(factType({ fact: 'written before the layers existed' })).toBe('semantic');
        expect(factType({ fact: 'x', type: 'episodic' })).toBe('episodic');
    });

    it('records the session as evidence', () => {
        const facts = [];
        mergeFacts(facts, [{ text: 'Always run npm test before committing', kind: 'norm' }], 's1');
        expect(facts[0].evidence).toEqual(['session:s1']);
    });
});

describe('retention with layers', () => {
    it('drops a probationary episodic fact before an established one', () => {
        const now = Date.now();
        const episodic = { fact: 'a', hits: 1, timestamp: now, type: 'episodic' };
        const semantic = { fact: 'b', hits: 1, timestamp: now, type: 'semantic' };
        expect(retentionScore(semantic, now)).toBeGreaterThan(retentionScore(episodic, now));

        const facts = [episodic, semantic];
        pruneFacts(facts, 1, now);
        expect(facts[0].fact).toBe('b');
    });

    it('leaves legacy (type-less) facts at full weight', () => {
        const now = Date.now();
        expect(retentionScore({ hits: 1, timestamp: now }, now))
            .toBe(retentionScore({ hits: 1, timestamp: now, type: 'semantic' }, now));
    });
});

// Project RULES get their own standing budget instead of competing with
// observations on keyword relevance. "Run npm test before committing" shares no
// words with "fix the header alignment" and would never clear a relevance floor,
// yet it is exactly what must not be dropped (plan §4.5).
describe('selectNormFacts', () => {
    const norm = (fact, over = {}) => ({ fact, kind: 'norm', type: 'semantic', confidence: 0.5, hits: 1, timestamp: 1, ...over });

    it('returns only promoted norms', () => {
        const facts = [
            norm('Always run npm test before committing'),
            { fact: 'The dashboard mounts Svelte islands', kind: 'observation', type: 'semantic' },
            norm('probationary rule', { type: 'episodic' }),
        ];
        expect(selectNormFacts(facts).map(f => f.fact)).toEqual(['Always run npm test before committing']);
    });

    it('does NOT filter by relevance — a rule applies regardless of the task', () => {
        const facts = [norm('Always run npm test before committing')];
        // selectRelevantFacts would drop this for an unrelated query; this must not.
        expect(selectNormFacts(facts)).toHaveLength(1);
    });

    it('ranks the best-established rule first', () => {
        const facts = [
            norm('weakly held', { confidence: 0.5 }),
            norm('well established', { confidence: 0.9 }),
        ];
        expect(selectNormFacts(facts)[0].fact).toBe('well established');
    });

    it('caps the standing budget', () => {
        const facts = Array.from({ length: 9 }, (_, i) => norm(`rule number ${i}`));
        expect(selectNormFacts(facts, 3)).toHaveLength(3);
    });

    it('survives junk', () => {
        expect(selectNormFacts(null)).toEqual([]);
        expect(selectNormFacts([])).toEqual([]);
    });
});
