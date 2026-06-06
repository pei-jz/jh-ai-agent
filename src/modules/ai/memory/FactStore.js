// FactStore — PURE operations on the durable "facts" array (long-term memory).
// Extracted from ConversationMemory (Phase 2). Operates on a passed `facts`
// array (no `this`), so it's unit-testable; the I/O (load/save JSON) stays in
// ConversationMemory.

import { relevanceScore } from './MemoryScoring.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const wordSet = (s) => new Set(norm(s).split(/\W+/).filter(w => w.length > 2));
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
