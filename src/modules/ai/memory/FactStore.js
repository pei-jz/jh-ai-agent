// FactStore — PURE operations on the durable "facts" array (long-term memory).
// Extracted from ConversationMemory (Phase 2). Operates on a passed `facts`
// array (no `this`), so it's unit-testable; the I/O (load/save JSON) stays in
// ConversationMemory.

import { relevanceScore, textUnits } from './MemoryScoring.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Comparable units (latin words + CJK char bigrams). The previous \W+ word split
// produced an EMPTY set for Japanese facts, so jaccard was always 0 and Japanese
// near-duplicates never merged — they just piled up until the cap pruned them.
const wordSet = (s) => textUnits(s);
// Jaccard similarity of two word sets (0–1).
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
}
const SIM_THRESHOLD = 0.7; // high → only merge clear near-duplicates

/**
 * Hard cap on the stored text of one fact. Every write path goes through
 * `capFactText` — the length limit used to be an inline `substring(0, 300)`
 * repeated at each call site, so the Memory tab's manual edit (which is a write
 * path too) silently stored unbounded text.
 */
export const FACT_MAX_CHARS = 300;

/** Trim a fact to the stored length. Non-strings become ''. */
export function capFactText(text) {
    return String(text ?? '').substring(0, FACT_MAX_CHARS);
}

/**
 * The memory layer a fact has reached. A fact written before the layers existed
 * has no `type`; it reads as semantic, because it already survived the old
 * store's pruning and demoting it would silently discard working memory.
 */
export function factType(f) {
    return (f && f.type) || 'semantic';
}

/**
 * Promotion matrix (plan §1.2 B3). Frequency alone is the wrong test: "always
 * run npm test" is a project rule the first time it is stated, while "edited
 * ConfigView.js" is a diary entry however often it recurs. So the KIND decides
 * the bar, and the count only decides when an observation clears it.
 *
 *   norm         → semantic immediately, but at LOW confidence; re-statement
 *                  raises it. (Trusted early, not trusted much.)
 *   observation  → episodic until seen 3 times, then semantic.
 *   worklog      → never stored at all.
 *
 * Deliberately NOT trusting the summariser's own "durable" filter: if that
 * filter worked, consolidateFacts (which exists to drop stale and duplicated
 * facts at 80% of capacity) would have nothing to do.
 */
export const PROMOTION_HITS = { norm: 1, observation: 3 };

/** Re-evaluate one fact's layer and confidence after its hit count changed. */
export function applyPromotion(f) {
    const kind = f.kind || 'observation';
    const hits = f.hits || 1;
    if (kind === 'norm') {
        f.type = 'semantic';
        // Stated once: plausible. Restated: increasingly a rule.
        f.confidence = Math.min(0.9, 0.5 + 0.15 * (hits - 1));
    } else {
        const promoted = hits >= PROMOTION_HITS.observation;
        f.type = promoted ? 'semantic' : 'episodic';
        f.confidence = promoted ? 0.7 : 0.4;
    }
    return f;
}

/**
 * Merge newly-extracted facts into `facts` (mutated in place), deduping by exact
 * normalized text OR strong word-overlap (Jaccard ≥ 0.7) so re-phrasings of the
 * same fact bump a hit count instead of piling up. Facts < 8 chars are ignored.
 *
 * `newFacts` entries may be plain strings (legacy, and anything a model returns
 * in the old shape) or `{ text, kind }` from FactExtraction.
 *
 * Merging additionally requires the CATEGORY to agree, so an observation's three
 * sightings are three sightings in the same area of the project — the same fact
 * noticed once each in three unrelated tasks is weaker evidence, not stronger.
 *
 * @returns the same `facts` array (for chaining)
 */
export function mergeFacts(facts, newFacts, sessionId = null, category = '') {
    if (!Array.isArray(facts) || !Array.isArray(newFacts)) return facts;
    for (const raw of newFacts) {
        const cand = typeof raw === 'string' ? { text: raw, kind: 'observation' } : raw;
        const text = String(cand?.text || '').trim();
        if (!text || text.length < 8) continue;
        // A self-declared work log is not memory. Dropping it here — rather than
        // letting it in and pruning later — is what keeps the store readable.
        if (cand.kind === 'worklog') continue;

        const n = norm(text);
        const ws = wordSet(text);
        const sameCategory = (f) => !category || !f.category || f.category === category;
        const existing = facts.find(f => sameCategory(f)
            && (norm(f.fact) === n || jaccard(wordSet(f.fact), ws) >= SIM_THRESHOLD));

        if (existing) {
            existing.hits = (existing.hits || 1) + 1;
            existing.timestamp = Date.now();
            // A fact restated as a rule is upgraded; the reverse never happens.
            if (cand.kind === 'norm') existing.kind = 'norm';
            applyPromotion(existing);
        } else {
            const fact = {
                fact: capFactText(text),
                date: new Date().toISOString().split('T')[0],
                timestamp: Date.now(),
                sessionId: sessionId || null,
                hits: 1,
                kind: cand.kind || 'observation',
                category: category || '',
                scope: 'workspace',
                evidence: sessionId ? [`session:${sessionId}`] : [],
            };
            facts.push(applyPromotion(fact));
        }
    }
    return facts;
}

/**
 * Retention score for pruning: hit count decayed by age with a 90-day
 * half-life. A fact reaffirmed often stays; one never re-referenced fades.
 *
 * Weighted by layer since the split: an episodic fact is still on probation, so
 * it is the first thing dropped when the store overflows — the alternative is a
 * single-sighting observation displacing an established project rule.
 */
const TYPE_WEIGHT = { semantic: 1, procedural: 1, episodic: 0.6 };

export function retentionScore(f, now = Date.now()) {
    const ageDays = Math.max(0, (now - (f.timestamp || 0)) / 86_400_000);
    return (f.hits || 1) * (TYPE_WEIGHT[factType(f)] ?? 1) * Math.pow(0.5, ageDays / 90);
}

/**
 * Prune `facts` (in place) to `maxFacts` by retention score (decayed hits),
 * replacing the old "hits then timestamp" sort that let a once-hot stale fact
 * outlive everything. Returns the same array.
 */
export function pruneFacts(facts, maxFacts, now = Date.now()) {
    if (!Array.isArray(facts) || facts.length <= maxFacts) return facts;
    facts.sort((a, b) => retentionScore(b, now) - retentionScore(a, now));
    facts.length = maxFacts;
    return facts;
}

/**
 * Apply an LLM-produced consolidation plan to `facts`:
 *   { remove: [idx…], merge: [{ into: idx, from: [idx…], text?: string }] }
 * remove → stale / transient / contradicted facts to drop.
 * merge  → fold `from` facts into `into` (hits summed, newest timestamp kept,
 *          optional rewritten text). Invalid indices are ignored.
 * Safety valve: if the plan would drop more than 70% of the store (a garbage
 * LLM response), the original array is returned untouched.
 * Returns a NEW array (originals not mutated except merge-target updates).
 */
export function applyConsolidation(facts, plan) {
    if (!Array.isArray(facts) || !plan || typeof plan !== 'object') return facts;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < facts.length;

    const removeSet = new Set((Array.isArray(plan.remove) ? plan.remove : []).filter(valid));
    const mergedFrom = new Set();
    for (const m of (Array.isArray(plan.merge) ? plan.merge : [])) {
        if (!m || !valid(m.into)) continue;
        const target = facts[m.into];
        const from = (Array.isArray(m.from) ? m.from : []).filter(i => valid(i) && i !== m.into);
        for (const i of from) {
            mergedFrom.add(i);
            target.hits = (target.hits || 1) + (facts[i].hits || 1);
            target.timestamp = Math.max(target.timestamp || 0, facts[i].timestamp || 0);
        }
        if (typeof m.text === 'string' && m.text.trim().length >= 8) {
            target.fact = capFactText(m.text.trim());
        }
    }

    const next = facts.filter((_, i) => !removeSet.has(i) && !mergedFrom.has(i));
    if (next.length < Math.ceil(facts.length * 0.3)) return facts; // refuse mass deletion
    return next;
}

/**
 * Select the top-`limit` facts most relevant to `query` (keyword overlap), ties
 * broken by recency then original order. Returns an array of fact objects.
 * `minScore` (default 0 = no floor) drops facts below the relevance threshold, so
 * a query unrelated to a fact won't pull it into the prompt. relevanceScore is
 * hits/query-units in [0,1]; 0.5 for an empty query (so the floor never bites
 * when there's nothing to judge relevance against).
 */
export function selectRelevantFacts(facts, query = '', limit = 5, minScore = 0) {
    if (!Array.isArray(facts) || facts.length === 0) return [];
    const scored = facts.map((f, idx) => ({
        f,
        score: relevanceScore({ summary: f.fact, topic: '', actions: [], keyFiles: [] }, query),
        idx,
    }));
    const eligible = minScore > 0 ? scored.filter(s => s.score >= minScore) : scored;
    // Relevance first — confidence only breaks ties, so an established rule wins
    // over an equally-relevant single sighting without ever outranking a fact
    // that actually matches the query better.
    eligible.sort((a, b) => b.score - a.score
        || (b.f.confidence ?? 0.6) - (a.f.confidence ?? 0.6)
        || (b.f.timestamp || 0) - (a.f.timestamp || 0)
        || b.idx - a.idx);
    return eligible.slice(0, limit).map(s => s.f);
}
