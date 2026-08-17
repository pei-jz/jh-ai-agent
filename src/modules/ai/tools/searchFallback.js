// searchFallback — what to try when a search returns NOTHING.
//
// A zero-result search is the point where an investigation either recovers or
// stalls, and today it returned one flat line ("No matches for /…/") with no
// information in it. A strong model degrades its own query at that point —
// full identifier → distinctive substring → case-insensitive → different
// vocabulary — but that is a STRATEGY, not a tool feature, and a weaker model
// simply repeats the failed query or starts reading files one at a time. That
// is the difference in investigation time, and it is cheaper to fix in the tool
// than to hope for it from the model.
//
// Everything here is pure so the ladder can be tested without a backend. The
// handlers (readOnlyHandlers.js) run it and label the relaxed results clearly,
// because a result the model believes came from ITS query would be worse than
// no result at all.

import { levenshtein } from './FuzzyPath.js';

/** Regex metacharacters. A pattern containing any is not a plain identifier. */
const META = /[.*+?^${}()|[\]\\/]/;

/**
 * Is this pattern just a name — something we can safely take apart?
 * `handleRunCommand` is; `function\s+foo` and `TODO|FIXME` are not.
 */
export function isPlainIdentifier(pattern) {
    const p = String(pattern || '').trim();
    if (!p || META.test(p)) return false;
    return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(p);
}

/**
 * Split an identifier into the words it is made of.
 *   supportsNativeTools → [supports, Native, Tools]
 *   run_study_pass      → [run, study, pass]
 *   HTTPServer          → [HTTP, Server]
 */
export function identifierTokens(name) {
    const s = String(name || '').trim();
    if (!s) return [];
    return s
        .split(/[_\-$]+/)
        .flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/g) || [])
        .filter(Boolean);
}

/**
 * The token most worth searching for on its own.
 *
 * "Most distinctive" is approximated by length: in `supportsNativeTools` the
 * useful retry is `Native`, not `supports` — but a generic word is still a far
 * better probe than the whole identifier, which matched nothing. Returns '' when
 * the pattern is not an identifier or has only one token (nothing to relax to).
 */
export function distinctiveToken(pattern) {
    if (!isPlainIdentifier(pattern)) return '';
    const tokens = identifierTokens(pattern).filter(t => t.length >= 4);
    if (tokens.length < 2) return '';
    return tokens.reduce((best, t) => (t.length > best.length ? t : best), '');
}

/** Escape a literal string for use as a regex pattern. */
export function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names closest to `query`, for a "did you mean" line.
 *
 * Distance is normalised by the length of the longer string so a 2-character
 * slip is judged very differently on `id` than on `supportsNativeTools`. An
 * exact substring match always wins — a query that IS contained in a name is
 * not a typo, it is a narrower spelling of the same thing.
 *
 * @param {string[]} names candidate symbol names
 * @param {string} query what was searched for
 * @param {{limit?:number, maxRatio?:number}} [opts]
 * @returns {string[]} best candidates, closest first (may be empty)
 */
export function suggestNames(names, query, { limit = 5, maxRatio = 0.34 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const seen = new Set();
    const scored = [];
    for (const raw of (Array.isArray(names) ? names : [])) {
        const name = String(raw || '');
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const contains = key.includes(q) || q.includes(key);
        const dist = levenshtein(q, key);
        const ratio = dist / Math.max(q.length, key.length, 1);
        if (!contains && ratio > maxRatio) continue;
        scored.push({ name, rank: contains ? -1 : ratio, dist });
    }
    return scored
        .sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map(s => s.name);
}
