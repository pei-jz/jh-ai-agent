// FailureSignature — PURE normalization of a tool failure into a stable key.
//
// Step 0 of docs/scratch/agent-memory-learning.plan.md. Nothing here does I/O or
// calls an LLM: text in → { kind, loc, message, signature } out, so the rules
// that decide "is this the SAME failure as last time?" are unit-testable and
// pinned by tests rather than re-derived in each caller.
//
// Three passes, in this order — the order is load-bearing:
//   1. redact()        secrets / PII out FIRST, so nothing downstream can ever
//                      persist them (the recorder has no other entry point).
//   2. normalizeError() volatile detail out (paths, hashes, timestamps, offsets),
//                      line numbers moved to `loc` rather than discarded — they
//                      are useless for matching but useful when showing a card.
//   3. signatureOf()   the key: tool + error kind + file extension.
//
// On hashing: the signature is a READABLE composite string, not a digest. A hash
// would only shorten it, at the cost of collisions (which would then need a
// secondary check) and of being unreadable in a log or in the Memory tab. The
// separate `fingerprint()` exists for the one place a short id is wanted — a
// card id — where collisions are harmless.

/**
 * Secret / PII patterns, applied in order. Exported so the table is visible to
 * tests: a redaction that silently stops matching is the kind of bug that is
 * only discovered by reading a leaked file.
 * Each entry replaces the WHOLE match unless it has a `keep` group, in which
 * case group 1 is preserved and the rest is masked.
 */
export const SECRET_PATTERNS = [
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
    { kind: 'key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
    { kind: 'key', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
    { kind: 'connstr', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/\S+/gi },
    // url with inline credentials — scheme kept, credentials + host masked
    { kind: 'urlcreds', re: /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@\S+/gi },
    { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    // secret-ish assignment: api_key=…, token: "…", password = …
    {
        kind: 'secret',
        re: /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',;)]{6,}/gi,
        keep: true,
    },
    // Home directory — the account name is PII, and on this project it is often
    // non-ASCII (C:\Users\裴京植), so the name class must not be [A-Za-z].
    { kind: 'user', re: /\b([A-Za-z]:[\\/]Users[\\/])[^\\/\s"';,)]+/g, keep: true },
    { kind: 'user', re: /(\/(?:home|Users)\/)[^/\s"';,)]+/g, keep: true },
];

/**
 * Mask secrets / PII. Every persistence path for failure data must call this
 * first — it is the only reason the trace files are safe to keep in a repo
 * working tree, and the only reason `scope: global` sharing could ever be
 * considered later.
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
    let out = String(text ?? '');
    for (const { kind, re, keep } of SECRET_PATTERNS) {
        out = out.replace(re, (m, g1) => (keep ? `${g1}[REDACTED:${kind}]` : `[REDACTED:${kind}]`));
    }
    return out;
}

/**
 * Error kinds, matched in order — FIRST match wins, so the table is ordered
 * most-specific first. `permission_denied` leads because a user refusal is not
 * a defect to learn a fix for (RecoveryHints already says "do not retry"), and
 * misfiling it as one would teach the agent to work around its own user.
 */
export const ERROR_KINDS = [
    { kind: 'permission_denied', re: /(user denied|denied by user|blocked by user|permission settings \(deny\)|was not approved|denied —|denied\.)/i },
    { kind: 'syntax_gate', re: /(syntax gate|syntaxerror|unexpected token|invalid json)/i },
    { kind: 'build_failure', re: /(build failed|compilation (?:failed|error)|cargo (?:check|build) failed|vite build|error\[e\d+\]|ts\d{4}:)/i },
    { kind: 'test_failure', re: /(tests? failed|assertionerror|expected .* (?:to|but) |\d+ failed\b)/i },
    { kind: 'edit_mismatch', re: /(does not match|no occurrence|not found in (?:the )?file|anchor|stale|already applied)/i },
    { kind: 'invalid_range', re: /(invalid line range|out of range|line \d+ exceeds)/i },
    { kind: 'not_found', re: /(does not exist|not found|no such file|cannot find)/i },
    { kind: 'conflict', re: /(already exists|destination already)/i },
    { kind: 'invalid_pattern', re: /invalid (?:regex|glob|include_glob|pattern)/i },
    { kind: 'invalid_args', re: /(requires (?:a |both |")|missing (?:required )?(?:parameter|argument)|must start with)/i },
    { kind: 'timeout', re: /(timed out|timeout (?:of )?\d|etimedout)/i },
    { kind: 'network', re: /(econnrefused|enotfound|network (?:error|down)|fetch failed|socket hang up|5\d{2} (?:internal|bad gateway|service))/i },
    { kind: 'unavailable', re: /(is not available|not supported|unsupported)/i },
];

/** Classify an error message. Returns 'unknown' when nothing matches. */
export function errorKind(text) {
    const s = String(text ?? '');
    for (const { kind, re } of ERROR_KINDS) if (re.test(s)) return kind;
    return 'unknown';
}

/**
 * Pull out the first `file.ext:line` (or "line N") mention. The line number is
 * deliberately kept OUT of the signature — two failures at different lines are
 * the same failure — but thrown away entirely it stops being possible to show
 * the user where the lesson came from.
 * @returns {string} e.g. "ConfigView.js:816", or '' when absent
 */
export function extractLoc(text) {
    const s = String(text ?? '');
    const m = s.match(/([\w.\-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/);
    if (m) return `${m[1]}:${m[2]}`;
    const l = s.match(/\bline\s+(\d+)/i);
    return l ? `line ${l[1]}` : '';
}

/**
 * Strip the volatile parts of an error message so two occurrences of the same
 * failure produce the same text.
 *
 * Conservative on numbers by design: only long runs (≥4 digits) and numbers in
 * known-volatile positions (position/offset/byte/line/column) are masked. A
 * blanket digit strip would erase meaningful ones — "expected 3 arguments",
 * "error[E0412]" — and merge genuinely different failures.
 */
export function normalizeMessage(text) {
    return String(text ?? '')
        .replace(/[A-Za-z]:[\\/][^\s"';,)]+/g, '<path>')          // C:\a\b\c
        .replace(/(?:\.{0,2}\/)[\w.\-]+(?:\/[\w.\-]+)+/g, '<path>') // /a/b/c, ./a/b
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
        .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
        .replace(/\b(position|offset|byte|line|column|col)\s+\d+/gi, '$1 <n>')
        .replace(/\b\d{4,}\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Full normalization of one error string.
 * @returns {{kind: string, loc: string, message: string}}
 */
export function normalizeError(text) {
    const safe = redact(text);
    return { kind: errorKind(safe), loc: extractLoc(safe), message: normalizeMessage(safe) };
}

/** Lowercased extension INCLUDING the dot, or '' when there is none. */
export function extOf(path) {
    const base = String(path ?? '').split(/[\\/]/).pop() || '';
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * One spelling per file: workspace-relative, forward slashes.
 *
 * Tool calls name files however the model happened to write them, so the same
 * file arrives as `src/a.js`, `C:/ws/src/a.js` and `C:\ws\src\a.js`. Stored raw,
 * those became THREE cards for one location — measured on the real store: 85 of
 * 131 locator cards held an absolute path, and 18 files existed under two or
 * three spellings, each consuming a slot in a three-slot brief.
 *
 * Also makes the store portable: a card keyed on `C:\cusor_workspace\...` is
 * dead the moment the workspace moves.
 *
 * Comparison is case-insensitive because Windows paths are, but the ORIGINAL
 * casing is preserved — `MemoryTab.svelte` has to stay openable.
 */
export function relativeTarget(target, root = '') {
    const p = String(target ?? '').split('\\').join('/');
    const raw = String(root ?? '').split('\\').join('/').replace(/\/+$/, '');
    if (!raw || !p) return p;
    // The target reached us through redact(), the workspace root did not — so for
    // a workspace under the user's home directory (`C:\Users\alice\projects\foo`,
    // the ordinary case) the target reads `C:/Users/[REDACTED:user]/projects/foo/…`
    // and never matches the raw root. Every locator then kept an absolute path.
    // It went unnoticed because this project's own workspace sits outside the
    // home directory, which is the one layout where the bug cannot appear.
    for (const r of [raw, redact(raw)]) {
        if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p.slice(r.length + 1);
    }
    return p;
}

/**
 * The failure key: which tool, what kind of error, on what type of file.
 * Readable on purpose (see the header note on hashing).
 * @param {{tool?: string, kind?: string, ext?: string}} parts
 */
export function signatureOf({ tool, kind, ext } = {}) {
    return `${tool || 'unknown'}|${kind || 'unknown'}|${ext || '-'}`;
}

/**
 * The path-ish thing a call acted on, used to decide whether a later SUCCESS
 * resolved this failure. Falls back to '' for tools that act on no file.
 */
export function targetOf(args) {
    if (!args || typeof args !== 'object') return '';
    for (const k of ['path', 'file', 'file_path', 'from', 'target']) {
        if (typeof args[k] === 'string' && args[k]) return args[k];
    }
    // read_file's batch form carries no `path`. One target is all this can
    // return, so take the first — enough for the extension-keyed signature and
    // for locator insights, which is what the trace uses this for.
    if (Array.isArray(args.paths)) {
        const first = args.paths.find(p => typeof p === 'string' && p.trim());
        if (first) return first;
    }
    return '';
}

/**
 * Which argument carries the SEARCH TERM, per search tool. A search whose result
 * the agent then acted on is a discovery ("where does X live?") — the positive
 * counterpart of a failure, and the thing worth remembering in a large codebase.
 */
export const SEARCH_QUERY_ARG = {
    grep_search: 'pattern',
    glob: 'pattern',
    symbol_search: 'query',
};

/**
 * The search term of a repo-search call, redacted and capped. '' for anything
 * that is not a repo search (web_search is excluded on purpose — it teaches
 * nothing about THIS codebase).
 */
export function queryOf(tool, args) {
    const key = SEARCH_QUERY_ARG[String(tool || '')];
    if (!key || !args || typeof args !== 'object') return '';
    const raw = args[key];
    return typeof raw === 'string' ? redact(raw).substring(0, 120) : '';
}

/**
 * Shape of the arguments (sorted key names), NOT their values — values carry
 * secrets and paths, the shape is what distinguishes "called with an anchor"
 * from "called with a line range". Used as the secondary check when a signature
 * hits, so a card learned for one call form is not applied to another.
 */
export function argShapeOf(args) {
    if (!args || typeof args !== 'object') return '';
    return Object.keys(args)
        .filter(k => args[k] !== null && args[k] !== undefined)
        .sort()
        .join(',');
}

/**
 * Short non-cryptographic digest (FNV-1a, 8 hex chars). For card ids and file
 * names only — never for deciding whether two failures match.
 */
export function fingerprint(str) {
    let h = 0x811c9dc5;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
