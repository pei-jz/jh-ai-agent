// SymbolIndex — extract DEFINITIONS (functions / classes / structs / …) from
// source text, so the agent can ask "where is X defined?" instead of grepping
// for a name and wading through every call site.
//
// Why not tree-sitter (yet): tree-sitter means a native crate plus a C grammar
// per language in the Tauri build — a heavy dependency to add, and it can only
// be exercised through the app. This module is PURE (string in → symbols out),
// so it is fully unit-tested and ships with zero build risk. `extractSymbols`
// is the seam: a tree-sitter backend can replace the per-language regex passes
// later without touching the tool, the handler, or the tests' expectations.
//
// Accuracy: conventional declarations are matched reliably; deliberately exotic
// formatting may be missed. Misses degrade to "not listed", never to a wrong
// file:line — the agent can still fall back to grep_search.

import { parseSymbols as treeSitterParse } from './TreeSitterSymbols.js';

/**
 * Extract definitions, preferring the tree-sitter backend when it is configured
 * and able to load, falling back to the regex passes otherwise.
 *
 * The two produce the same shape; tree-sitter additionally fills `parent` (the
 * enclosing class/impl/trait) and captures multi-line signatures exactly.
 * @returns {Promise<{symbols: Array, backend: 'tree-sitter'|'regex'}>}
 */
export async function extractSymbolsBest(path, content) {
    const lang = languageOf(path);
    if (lang) {
        try {
            const viaTs = await treeSitterParse(path, content, lang);
            if (Array.isArray(viaTs)) return { symbols: viaTs, backend: 'tree-sitter' };
        } catch (_) { /* fall through to regex */ }
    }
    return { symbols: extractSymbols(path, content), backend: 'regex' };
}

/** Language id from a file path, or '' when unsupported. */
export function languageOf(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) return 'js';
    if (ext === 'rs') return 'rust';
    if (ext === 'py') return 'python';
    return '';
}

/** Strip a trailing line comment so it can't be mistaken for a signature. */
function clean(line) {
    return String(line).replace(/\s+$/, '');
}

// Per-language definition patterns. Each entry: [regex, kind, nameGroup].
// Regexes are anchored at line start (with optional indentation) so a call
// like `foo(bar)` never registers as a definition of `foo`.
const PATTERNS = {
    js: [
        [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', 1],
        [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class', 1],
        // ── TypeScript type-level declarations ──
        [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', 1],
        [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/, 'type', 1],
        [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum', 1],
        // const foo = (…) => / const foo = async (…) => / const foo = function
        [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function', 1],
        // Object-literal members: `  save: async (x) => x,` / `  fn: function () {}`
        [/^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'method', 1],
        // Class / object shorthand methods: `  foo(a, b) {` — excludes control keywords.
        [/^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, 'method', 1],
    ],
    rust: [
        [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_][\w]*)/, 'function', 1],
        [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/, 'struct', 1],
        [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/, 'enum', 1],
        [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/, 'trait', 1],
        [/^\s*impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_][\w]*)/, 'impl', 1],
        [/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)/, 'type', 1],
    ],
    python: [
        [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, 'function', 1],
        [/^\s*class\s+([A-Za-z_][\w]*)/, 'class', 1],
    ],
};

// JS keywords that look like a method call at indentation (`if (x) {`).
const JS_NOT_METHODS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else',
    'try', 'with', 'super', 'constructor_placeholder',
]);

/**
 * Extract definitions from source text.
 * @param {string} path used for language detection and the returned location
 * @param {string} content file text
 * @returns {Array<{name,kind,line,path,signature,exported}>} line is 1-based
 */
export function extractSymbols(path, content) {
    const lang = languageOf(path);
    if (!lang || typeof content !== 'string' || !content) return [];
    const patterns = PATTERNS[lang];
    const out = [];
    const lines = content.split('\n');
    let inBlockComment = false;
    let inTemplate = false;   // inside a multi-line `template literal`

    /** Unescaped backticks on a line — an odd count flips template state. */
    const flipsTemplate = (s) => ((s.match(/(?<!\\)`/g) || []).length % 2) === 1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        // ── Inside a multi-line template literal ──────────────────────────
        // Its contents are DATA, not code: a `function foo() {}` written inside
        // a SQL/HTML template must not be indexed as a definition.
        if (lang === 'js' && inTemplate) {
            if (flipsTemplate(raw)) inTemplate = false;
            continue;
        }

        // Skip comments so a commented-out definition isn't indexed.
        if (lang === 'js' || lang === 'rust') {
            const trimmed = raw.trim();
            if (inBlockComment) {
                if (trimmed.includes('*/')) inBlockComment = false;
                continue;
            }
            if (trimmed.startsWith('/*')) {
                if (!trimmed.includes('*/')) inBlockComment = true;
                continue;
            }
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        } else if (lang === 'python' && raw.trim().startsWith('#')) {
            continue;
        }

        for (const [re, kind, group] of patterns) {
            const m = raw.match(re);
            if (!m) continue;
            const name = m[group];
            if (!name) continue;
            if (lang === 'js' && kind === 'method' && JS_NOT_METHODS.has(name)) continue;
            out.push({
                name,
                kind,
                line: i + 1,
                path,
                signature: clean(raw).trim().slice(0, 200),
                exported: /^\s*(?:export\b|pub\b)/.test(raw),
            });
            break;   // one symbol per line
        }

        // A line that OPENS a template literal puts the following lines in
        // data mode (this line itself was still matched above, since the
        // declaration precedes the backtick).
        if (lang === 'js' && flipsTemplate(raw)) inTemplate = true;
    }
    return out;
}

/**
 * Rank symbols against a query. Exact name wins, then prefix, then substring;
 * exported symbols outrank private ones at equal match quality.
 * @param {Array} symbols
 * @param {string} query
 * @param {{kind?:string, limit?:number}} opts
 */
export function matchSymbols(symbols, query, opts = {}) {
    const q = String(query || '').trim().toLowerCase();
    const { kind = '', limit = 50 } = opts;
    if (!q) return [];
    const scored = [];
    for (const s of symbols || []) {
        if (kind && s.kind !== kind) continue;
        const n = String(s.name || '').toLowerCase();
        let score = 0;
        if (n === q) score = 100;
        else if (n.startsWith(q)) score = 70;
        else if (n.includes(q)) score = 40;
        else continue;
        if (s.exported) score += 5;
        scored.push({ ...s, score });
    }
    return scored
        .sort((a, b) => b.score - a.score
            || a.path.localeCompare(b.path)
            || a.line - b.line)
        .slice(0, limit);
}

/** Human/LLM-readable listing: "path:line  kind name — signature". */
export function formatSymbols(matches, { query = '', total = null } = {}) {
    if (!matches || matches.length === 0) {
        return `No symbol definitions matching "${query}".`;
    }
    const header = total != null && total > matches.length
        ? `${matches.length} of ${total} definitions matching "${query}":`
        : `${matches.length} definition(s) matching "${query}":`;
    const rows = matches.map(m => {
        // `parent` is only filled by the tree-sitter backend; it is what tells
        // `Alpha.run` apart from `Beta.run`.
        const qualified = m.parent ? `${m.parent}.${m.name}` : m.name;
        return `${m.path}:${m.line}  [${m.kind}] ${qualified}${m.exported ? ' (exported)' : ''}\n    ${m.signature}`;
    });
    return `${header}\n${rows.join('\n')}`;
}
