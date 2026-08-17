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
 * Fold full-width ASCII to half-width.
 *
 * Japanese input methods produce `ＭｏｎｉｔｏｒＶｉｅｗ．ｊｓ` for a filename typed without
 * switching modes. Left alone it shares not one unit with `MonitorView.js`, so a
 * memory about that file could not be recalled by the person most likely to want
 * it.
 */
function foldWidth(s) {
    return s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/**
 * Split an identifier into its parts: `MonitorView` → monitor, view;
 * `read_file` → read, file. Both sides of a recall gain from this — a card says
 * `multi_replace_file_content` and the prompt says "replace".
 */
function identifierParts(word) {
    return word
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .filter(p => p.length > 2)
        .map(p => p.toLowerCase());
}

/**
 * Tokenize text into comparable units that work for BOTH spaced languages and
 * CJK. Latin/digit words (≥3 chars) are kept as-is AND split on case/underscore
 * boundaries; CJK runs — which have no spaces, so the old `split(/\W+/)`
 * produced nothing for Japanese — are broken into character bigrams. Pure;
 * returns a Set of lowercase strings.
 */
export function textUnits(text) {
    const s = foldWidth(String(text || '')).toLowerCase();
    const original = foldWidth(String(text || ''));
    const units = new Set();
    for (const w of s.split(/[^a-z0-9_.\-]+/)) {
        if (w.length > 2) units.add(w);
    }
    // Case boundaries are lost by the lowercase pass above, so identifiers are
    // split from the ORIGINAL text.
    for (const w of original.split(/[^A-Za-z0-9_.\-]+/)) {
        if (w.length > 2) for (const p of identifierParts(w)) units.add(p);
    }
    const runs = s.match(CJK_RUN_RE) || [];
    for (const run of runs) {
        if (run.length === 1) { units.add(run); continue; }
        for (let i = 0; i < run.length - 1; i++) units.add(run.slice(i, i + 2));
    }
    return units;
}

// ── Cross-language concepts ────────────────────────────────────────────────
//
// The gap this closes: memory cards are minted from TOOL NAMES and error text,
// so they are English — `write_file|edit_mismatch|.svelte`, `read_file →
// write_file`. Prompts in this product are usually Japanese. "テストを追加して"
// and "run_command|test_failure" describe the same thing and share no character,
// so unit overlap scores exactly 0 and the memory is never recalled. Not a
// ranking problem: the layer is simply invisible from the other language.
//
// The proper fix is a shared embedding space; that means shipping a model, which
// is a product decision. This is the dependency-free 80%: a small domain
// glossary that maps both languages onto the same concept ids. Deliberately
// SMALL and specific to what this agent does — a broad thesaurus would make
// unrelated memories look relevant, which is worse than not recalling them.
const CONCEPTS = {
    edit: ['修正', '編集', '書き換', '直す', '直し', 'edit', 'modify', 'fix', 'patch', 'write'],
    add: ['追加', '新規', '作成', '実装', 'add', 'create', 'implement', 'new'],
    remove: ['削除', '消す', '除去', 'delete', 'remove', 'drop'],
    rename: ['名前', 'リネーム', '改名', 'rename'],
    test: ['テスト', '試験', '検証', 'test', 'spec', 'vitest', 'jest', 'assert'],
    build: ['ビルド', 'コンパイル', 'build', 'compile', 'bundle', 'cargo', 'vite'],
    error: ['エラー', '失敗', '不具合', 'バグ', '例外', 'error', 'fail', 'failure', 'bug', 'exception', 'panic'],
    search: ['検索', '探す', '調べ', '調査', 'search', 'grep', 'find', 'locate'],
    file: ['ファイル', 'file', 'path'],
    dir: ['ディレクトリ', 'フォルダ', 'directory', 'folder'],
    config: ['設定', 'コンフィグ', 'config', 'setting', 'option'],
    dependency: ['依存', 'インポート', 'import', 'dependency', 'require'],
    ui: ['画面', '表示', 'ビュー', 'ui', 'view', 'render', 'component', 'style'],
    doc: ['ドキュメント', '文書', '説明', 'readme', 'doc', 'document'],
    perf: ['遅い', '性能', '速度', 'パフォーマンス', 'slow', 'perf', 'performance', 'latency'],
    memory: ['記憶', 'メモリ', 'memory', 'recall', 'cache'],
    shell: ['コマンド', 'シェル', 'command', 'shell', 'terminal'],
    office: ['エクセル', 'ワード', 'excel', 'xlsx', 'docx', 'sheet', 'workbook'],
    git: ['コミット', 'ブランチ', 'git', 'commit', 'branch', 'diff'],
};

/** Reverse index: term → concept id. Built once. */
const TERM_TO_CONCEPT = (() => {
    const m = new Map();
    for (const [concept, terms] of Object.entries(CONCEPTS)) {
        for (const t of terms) m.set(t.toLowerCase(), concept);
    }
    return m;
})();

/**
 * Concept ids present in `text`, in either language.
 *
 * Substring matching, because Japanese has no word boundaries: "修正して" has to
 * match the term "修正". For latin terms that would over-match ("add" inside
 * "address"), so those are checked against extracted word units instead.
 */
export function conceptUnits(text) {
    const raw = foldWidth(String(text || '')).toLowerCase();
    if (!raw) return new Set();
    const words = textUnits(text);
    const out = new Set();
    for (const [term, concept] of TERM_TO_CONCEPT) {
        if (/^[a-z0-9]+$/.test(term)) {
            if (words.has(term)) out.add(concept);
        } else if (raw.includes(term)) {
            out.add(concept);
        }
    }
    return out;
}

/**
 * How much a concept-only match is worth relative to a literal one.
 *
 * Below 1 on purpose: sharing the idea of "test" is real evidence but weaker
 * than sharing the token `MonitorView.js`, and a concept match must not outrank
 * a literal one. Above the injection floor (MEMORY_MIN_RELEVANCE, 0.08) so a
 * cross-language match can actually clear it.
 */
export const CONCEPT_WEIGHT = 0.75;

/**
 * Relevance of a memory entry to a query (0–1). No external calls.
 *
 * Two independent signals, and the BETTER one wins rather than being averaged:
 *   • literal — unit overlap (latin words, identifier parts, CJK bigrams)
 *   • concept — shared domain concepts, which is what lets a Japanese prompt
 *     reach an English card at all
 * Averaging would drag a strong literal match down whenever the query happened
 * to carry no recognised concept, which is most one-word queries.
 *
 * Empty/unit-less query ⇒ 0.5 (treat equally).
 * @param {{topic?:string,summary?:string,actions?:string[],keyFiles?:string[]}} entry
 * @param {string} query
 */
export function relevanceScore(entry, query) {
    if (!query) return 0.5;
    const qUnits = textUnits(query);
    if (qUnits.size === 0) return 0.5;

    const fieldText = [
        entry.topic || '',
        entry.summary || '',
        (entry.actions || []).join(' '),
        (entry.keyFiles || []).join(' '),
    ].join(' ');
    const fields = fieldText.toLowerCase();
    const fieldUnits = textUnits(fieldText);

    let hits = 0;
    // Both the substring test (the original behaviour — catches a query unit
    // appearing inside a longer field word) and the unit test (catches an
    // identifier part the raw text does not contain contiguously).
    for (const u of qUnits) if (fields.includes(u) || fieldUnits.has(u)) hits++;
    const literal = hits / qUnits.size;

    const qConcepts = conceptUnits(query);
    if (qConcepts.size === 0) return literal;
    const fConcepts = conceptUnits(fieldText);
    let cHits = 0;
    for (const c of qConcepts) if (fConcepts.has(c)) cHits++;
    const concept = (cHits / qConcepts.size) * CONCEPT_WEIGHT;

    return Math.max(literal, concept);
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
