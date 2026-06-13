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
 * Merge newly-extracted facts into `facts` (mutated in place), deduping by exact
 * normalized text OR strong word-overlap (Jaccard ≥ 0.7) so re-phrasings of the
 * same fact bump a hit count instead of piling up. Facts < 8 chars are ignored.
 * @returns the same `facts` array (for chaining)
 */
export function mergeFacts(facts, newFacts, sessionId = null) {
    if (!Array.isArray(facts) || !Array.isArray(newFacts)) return facts;
    for (const raw of newFacts) {
        const text = String(raw || '').trim();
        if (!text || text.length < 8) continue;
        const n = norm(text);
        const ws = wordSet(text);
        const existing = facts.find(f => norm(f.fact) === n || jaccard(wordSet(f.fact), ws) >= SIM_THRESHOLD);
        if (existing) {
            existing.hits = (existing.hits || 1) + 1;
            existing.timestamp = Date.now();
        } else {
            facts.push({
                fact: text.substring(0, 300),
                date: new Date().toISOString().split('T')[0],
                timestamp: Date.now(),
                sessionId: sessionId || null,
                hits: 1,
            });
        }
    }
    return facts;
}

/**
 * Retention score for pruning: hit count decayed by age with a 90-day
 * half-life. A fact reaffirmed often stays; one never re-referenced fades.
 */
export function retentionScore(f, now = Date.now()) {
    const ageDays = Math.max(0, (now - (f.timestamp || 0)) / 86_400_000);
    return (f.hits || 1) * Math.pow(0.5, ageDays / 90);
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
            target.fact = m.text.trim().substring(0, 300);
        }
    }

    const next = facts.filter((_, i) => !removeSet.has(i) && !mergedFrom.has(i));
    if (next.length < Math.ceil(facts.length * 0.3)) return facts; // refuse mass deletion
    return next;
}

/**
 * Select the top-`limit` facts most relevant to `query` (keyword overlap), ties
 * broken by recency then original order. Returns an array of fact objects.
 */
export function selectRelevantFacts(facts, query = '', limit = 5) {
    if (!Array.isArray(facts) || facts.length === 0) return [];
    const scored = facts.map((f, idx) => ({
        f,
        score: relevanceScore({ summary: f.fact, topic: '', actions: [], keyFiles: [] }, query),
        idx,
    }));
    scored.sort((a, b) => b.score - a.score || (b.f.timestamp || 0) - (a.f.timestamp || 0) || b.idx - a.idx);
    return scored.slice(0, limit).map(s => s.f);
}
