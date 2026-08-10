// MemoryScoring — PURE text/scoring helpers for conversation memory.
// Extracted from ConversationMemory (Phase 2) for isolated unit testing.

/**
 * Escape active XML-ish tags in remembered text so injected memory can't pollute
 * the system prompt's structured sections. Non-strings pass through unchanged.
 */
export function sanitizeXmlTags(text) {
    if (typeof text !== 'string') return text;
    return text.replace(
        /<(\/?)(artifacts|artifact|active_file|other_open_files|terminal_output|linter_diagnostics|user_selected_context|knowledge_items)(\s[^>]*)?>/gi,
        (match, slash, tagName, attrs) => `[${slash || ''}${tagName}${attrs || ''}]`
    );
}

// CJK ranges: Hiragana/Katakana, CJK Unified Ideographs (+ext A), half-width
// Katakana, Hangul. Used to detect runs that have no word boundaries.
const CJK_RUN_RE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ가-힣]+/g;

/**
 * Tokenize text into comparable units that work for BOTH spaced languages and
 * CJK. Latin/digit words (≥3 chars) are kept as-is; CJK runs — which have no
 * spaces, so the old `split(/\W+/)` produced nothing for Japanese — are broken
 * into character bigrams. Pure; returns a Set of lowercase strings.
 */
export function textUnits(text) {
    const s = String(text || '').toLowerCase();
    const units = new Set();
    for (const w of s.split(/[^a-z0-9_.\-]+/)) {
        if (w.length > 2) units.add(w);
    }
    const runs = s.match(CJK_RUN_RE) || [];
    for (const run of runs) {
        if (run.length === 1) { units.add(run); continue; }
        for (let i = 0; i < run.length - 1; i++) units.add(run.slice(i, i + 2));
    }
    return units;
}

/**
 * Relevance of a memory entry to a query (0–1). No external calls.
 * Matching is unit-overlap where a unit is a latin word OR a CJK character
 * bigram (so Japanese queries actually match — the previous whitespace-token
 * approach scored ~0 on Japanese). Empty/unit-less query ⇒ 0.5 (treat equally).
 * @param {{topic?:string,summary?:string,actions?:string[],keyFiles?:string[]}} entry
 * @param {string} query
 */
export function relevanceScore(entry, query) {
    if (!query) return 0.5;
    const qUnits = textUnits(query);
    if (qUnits.size === 0) return 0.5;

    const fields = [
        entry.topic || '',
        entry.summary || '',
        (entry.actions || []).join(' '),
        (entry.keyFiles || []).join(' '),
    ].join(' ').toLowerCase();

    let hits = 0;
    for (const u of qUnits) if (fields.includes(u)) hits++;
    return hits / qUnits.size;
}

/**
 * Heuristic importance of a conversation message for compaction (higher = keep
 * verbatim). No LLM call. Rewards plans/decisions/errors/file-mods/user
 * instructions; penalizes bulky tool-result dumps and system nudges.
 * @param {{role?:string, content?:string}} msg
 * @returns {number}
 */
export function scoreMessageImportance(msg) {
    const c = (msg && msg.content) || '';
    const lc = c.toLowerCase();
    let score = 0;

    if (/plan\.md|\[plan\]|計画書|実装計画/i.test(c)) score += 5;
    if (/(decided|decision|approach|strategy|conclusion|方針|結論|implement|let's|plan to)/i.test(lc)) score += 2;
    if (/error|エラー|failed|失敗|exception|traceback|stack trace/i.test(lc)) score += 2;
    if (/write_file|multi_replace|create_dir|delete_file|move_file/i.test(c)) score += 2;
    if (msg && msg.role === 'user' && !c.startsWith('Tool Execution Results') && !c.startsWith('[System')) score += 2;
    if (/[\/\\][\w.\-]+\.\w+/.test(c)) score += 1;

    if (c.startsWith('Tool Execution Results')) score -= 1;
    if (c.startsWith('[System')) score -= 2;
    if (c.length > 4000) score -= 1;

    return score;
}
