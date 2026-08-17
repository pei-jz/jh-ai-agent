// readOnlyHandlers — read-only tool handlers extracted from ToolExecutor
// (Part A refactor). These are thin I/O wrappers around Tauri `invoke` (or
// `fetch`) plus result formatting; they hold no state. Each takes the
// ToolExecutor instance as `ctx` for the few helpers/fields it needs
// (resolvePath, workspacePath, onToolEvent) so behavior is identical to when
// the bodies lived inline in the executeTool switch.
//
// Coverage: this directory is I/O glue (excluded from the unit-coverage gate,
// like dashboard/utils/resultView.js). Pure logic stays in FuzzyPath/FileEdit.

import { invoke } from '@tauri-apps/api/core';
import { extractSymbolsBest, matchSymbols, formatSymbols, languageOf } from '../SymbolIndex.js';
import { configureTreeSitter } from '../TreeSitterSymbols.js';
import { distinctiveToken, escapeRegex, suggestNames } from '../searchFallback.js';
import { CodeIndexClient, renderSymbolHits, renderDeps } from '../../memory/CodeIndex.js';

// Enable the tree-sitter backend once, lazily: the grammars are ~2MB of wasm
// served from the app bundle, so they load only if symbol_search is used. If
// anything here fails, SymbolIndex silently falls back to its regex passes.
let _tsConfigured = false;
function ensureTreeSitterConfigured() {
    if (_tsConfigured) return;
    _tsConfigured = true;
    try {
        configureTreeSitter({
            wasmBase: '/tree-sitter/',
            initOptions: { locateFile: (name) => `/tree-sitter/${name}` },
            loadRuntime: async () => {
                const mod = await import('web-tree-sitter');
                return mod.default || mod;
            },
        });
    } catch (_) { /* stays on the regex backend */ }
}

/** list_files — directory listing, dirs-first then files, with size annotation. */
export async function handleListFiles(ctx, args, onAgentStatus, resolvedPath) {
    onAgentStatus?.(`Exploring directory: ${resolvedPath}...`);
    const entries = await invoke('read_dir', { path: resolvedPath });
    if (!Array.isArray(entries) || entries.length === 0) {
        return `(empty) ${resolvedPath}`;
    }
    // Format: dirs first (alpha), then files (alpha), with size annotation.
    // This is much easier for the LLM to parse than the raw entry objects.
    const fmtSize = (b) => {
        if (!Number.isFinite(b)) return '';
        if (b < 1024) return `${b}B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
        return `${(b / 1024 / 1024).toFixed(1)}MB`;
    };
    const dirs  = entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => !e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    const lines = [];
    lines.push(`--- ${resolvedPath} (${dirs.length} dirs, ${files.length} files) ---`);
    for (const d of dirs)  lines.push(`📁 ${d.name}/`);
    for (const f of files) {
        const sz = fmtSize(f.size);
        lines.push(`📄 ${f.name}${sz ? `  (${sz})` : ''}`);
    }
    return lines.join('\n');
}

/** Most files one read_file call may fetch. */
export const READ_MANY_MAX_FILES = 20;
/** Total characters a batch read may return before the rest are summarised out. */
export const READ_MANY_MAX_CHARS = 400_000;

/**
 * read_file — one file, or several in one call.
 *
 * The batch form exists because investigation was the loop's most expensive
 * phase for the silliest reason: the model knew it needed five files and had to
 * spend five round trips saying so. Each trip re-sends the whole system prompt
 * and history, so N files cost N full requests rather than one.
 *
 * A failure on one path does NOT fail the batch. That is the property that makes
 * batching safe to prefer: if one path in five is wrong, an all-or-nothing call
 * would throw away four good reads and the model would fall back to reading them
 * one at a time — the exact behaviour this is meant to replace.
 */
export async function handleReadFile(ctx, args, onAgentStatus, resolvedPath) {
    const many = Array.isArray(args?.paths)
        ? args.paths.filter(p => typeof p === 'string' && p.trim())
        : [];
    if (many.length > 0) {
        return handleReadMany(ctx, many, args, onAgentStatus);
    }

    onAgentStatus?.(`Reading file: ${resolvedPath}...`);
    const readRes = await ctx._readFileSmart(resolvedPath);
    if (!readRes.ok) return readRes.error;
    const readPath = readRes.path;     // may be fuzzy-corrected from resolvedPath
    const fileContent = readRes.content;
    const pathNote = readRes.note || '';

    // ── Session file cache update ──────────────────────────
    // Cache stores the FULL content regardless of slicing — the cache
    // is used by ConversationMemory.compactHistory to restore content
    // verbatim, and slicing is just a per-call presentation concern.
    // Re-read suppression nudge: if the file was already accessed this
    // session and its content is unchanged, the agent already has this
    // in context — discourage redundant whole-file re-reads (the #1
    // token sink). Content is still returned, so this is safe.
    let reReadNote = '';
    if (ctx._fileCache) {
        const normPath = readPath.replace(/\\/g, '/');
        const existing = ctx._fileCache.get(normPath);
        if (existing && (existing.readAt || existing.editedAt) && existing.content === fileContent) {
            reReadNote = `ℹ️ ${readPath} is UNCHANGED since you last accessed it this session — ` +
                `you already have this content in context. Avoid re-reading whole files: use grep_search ` +
                `to locate text, or offset+limit for a specific region.\n`;
        }
        ctx._fileCache.set(normPath, {
            content: fileContent,
            readCount: (existing?.readCount || 0) + 1,
            readAt: Date.now(),
            editedAt: existing?.editedAt || null
        });
    }

    // ── Slicing & line-numbering ──────────────────────────
    // Default cap = 2000 lines (matches Claude Code's Read tool).
    // Returning a line-numbered view costs ~6-8 chars per line of overhead
    // but lets the LLM reference exact lines in its OBSERVE/PLAN reasoning
    // and gives multi_replace_file_content a clear anchor when extracting
    // old_text snippets.
    const DEFAULT_LIMIT = 2000;
    const allLines = fileContent.split('\n');
    const total = allLines.length;

    let offset = Number.isFinite(args.offset) && args.offset >= 1 ? Math.floor(args.offset) : 1;
    let limit  = Number.isFinite(args.limit)  && args.limit  >= 1 ? Math.floor(args.limit)  : DEFAULT_LIMIT;

    if (offset > total) {
        return `Error: offset ${offset} exceeds file length (${total} lines) for ${readPath}. ` +
            `Use offset between 1 and ${total}, or omit to start from the beginning.`;
    }

    const startIdx = offset - 1;
    const endIdx   = Math.min(total, startIdx + limit);
    const slice    = allLines.slice(startIdx, endIdx);

    // Pad line numbers to constant width for alignment.
    const lastLineNo = endIdx;
    const numWidth = String(lastLineNo).length;
    const numbered = slice
        .map((line, i) => `${String(startIdx + 1 + i).padStart(numWidth, ' ')}\t${line}`)
        .join('\n');

    // Header tells the LLM exactly what range it's looking at.
    const showingAll = (offset === 1 && endIdx === total);
    const header = showingAll
        ? `--- ${readPath} (${total} lines) ---\n`
        : `--- ${readPath} (showing lines ${offset}-${endIdx} of ${total}) ---\n`;
    const footer = endIdx < total
        ? `\n... [${total - endIdx} more lines — call read_file again with offset=${endIdx + 1} to continue]`
        : '';

    return pathNote + reReadNote + header + numbered + footer;
}

/**
 * The batch arm of read_file.
 *
 * Reads run CONCURRENTLY — they are independent `invoke` round trips, and doing
 * them in sequence would give back most of what batching just saved.
 */
async function handleReadMany(ctx, rawPaths, args, onAgentStatus) {
    // De-duplicate first: a model listing the same file twice should not be
    // charged for it twice, and the re-read nudge would fire on its own request.
    const unique = [...new Set(rawPaths.map(p => p.trim()))];
    const over = unique.length - READ_MANY_MAX_FILES;
    const paths = unique.slice(0, READ_MANY_MAX_FILES);

    onAgentStatus?.(`Reading ${paths.length} files...`);

    const limit = Number.isFinite(args?.limit) && args.limit >= 1
        ? Math.floor(args.limit) : 2000;

    const results = await Promise.all(paths.map(async (p) => {
        const resolved = ctx.resolvePath(p);
        const res = await ctx._readFileSmart(resolved);
        if (!res.ok) return { path: p, error: res.error };
        return { path: p, resolved: res.path, content: res.content, note: res.note || '' };
    }));

    const sections = [];
    const failed = [];
    let budget = READ_MANY_MAX_CHARS;
    let truncatedFiles = 0;

    for (const r of results) {
        if (r.error) {
            // Inline, not fatal — the other files in the batch still come back.
            failed.push(`${r.path}: ${r.error.replace(/^Error:\s*/, '')}`);
            continue;
        }

        // Same session-cache bookkeeping as a single read, so a batched read
        // counts for re-read suppression and for compaction restore.
        if (ctx._fileCache) {
            const normPath = r.resolved.replace(/\\/g, '/');
            const existing = ctx._fileCache.get(normPath);
            ctx._fileCache.set(normPath, {
                content: r.content,
                readCount: (existing?.readCount || 0) + 1,
                readAt: Date.now(),
                editedAt: existing?.editedAt || null,
            });
        }

        const allLines = r.content.split('\n');
        const total = allLines.length;
        const shown = Math.min(total, limit);
        const numWidth = String(shown).length;
        const numbered = allLines.slice(0, shown)
            .map((line, i) => `${String(i + 1).padStart(numWidth, ' ')}\t${line}`)
            .join('\n');

        const head = shown === total
            ? `--- ${r.resolved} (${total} lines) ---`
            : `--- ${r.resolved} (showing lines 1-${shown} of ${total}) ---`;
        const tail = shown < total
            ? `\n... [${total - shown} more lines — read_file with path="${r.resolved}", offset=${shown + 1}]`
            : '';
        const section = `${r.note}${head}\n${numbered}${tail}`;

        if (section.length > budget) {
            // Stop cleanly at the budget rather than returning a prompt the
            // model cannot fit: say which files were dropped so it can ask again.
            truncatedFiles = results.length - sections.length - failed.length;
            break;
        }
        budget -= section.length;
        sections.push(section);
    }

    const parts = [`Read ${sections.length} of ${paths.length} file(s).`];
    if (over > 0) {
        parts.push(`[${over} path(s) beyond the ${READ_MANY_MAX_FILES}-file cap were not read — call again for the rest.]`);
    }
    if (truncatedFiles > 0) {
        parts.push(`[${truncatedFiles} file(s) omitted: the batch hit the ${READ_MANY_MAX_CHARS.toLocaleString()}-character cap. Read them in a follow-up call.]`);
    }
    if (failed.length > 0) {
        parts.push(`[${failed.length} could not be read]\n` + failed.map(f => `  - ${f}`).join('\n'));
    }
    return parts.join('\n') + '\n\n' + sections.join('\n\n');
}

/**
 * What to do when a grep found nothing.
 *
 * The old answer was one line — "No matches" — which is where an investigation
 * stalls: the model has to invent the next query with no new information, and a
 * weaker one just re-runs the same search or falls back to reading files one at
 * a time. So we spend at most two more greps walking the ladder a careful
 * engineer would walk anyway:
 *
 *   1. the same pattern, case-insensitively   (a capitalisation slip)
 *   2. the most distinctive WORD of the identifier, case-insensitively
 *      (`supportsNativeTools` → `Native`: a rename, a typo, or the wrong half
 *       of a name remembered)
 *
 * Relaxed hits are labelled with the pattern that actually produced them. A
 * result the model mistakes for its own query would be worse than none.
 * Both retries only run on the zero-result path, so a normal search costs the
 * same as before.
 */
async function grepZeroResultLadder(ctx, args, searchRoot, filesSearched) {
    const base = {
        path: searchRoot,
        includeGlob: args.include_glob || null,
        maxResults: Number.isFinite(args.max_results) ? args.max_results : null,
        contextLines: Number.isFinite(args.context_lines) ? args.context_lines : null,
    };
    const render = (matches, pattern, note) => {
        const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`);
        return `${note}\nFound ${matches.length} match(es) for /${pattern}/:\n${lines.join('\n')}`;
    };
    const tried = [`/${args.pattern}/${args.case_insensitive ? ' (case-insensitive)' : ''}`];

    // 1. Case-insensitive — skipped when the caller already asked for it.
    if (!args.case_insensitive) {
        try {
            const res = await invoke('grep_search', { ...base, pattern: args.pattern, caseInsensitive: true });
            const matches = res?.matches || [];
            if (matches.length > 0) {
                ctx.onToolEvent?.('grep_search', { pattern: args.pattern, matchCount: matches.length });
                return render(
                    matches, args.pattern,
                    `ℹ️ No case-sensitive match; retried CASE-INSENSITIVELY and found results. ` +
                    `The name is spelled differently than you typed.`,
                );
            }
            tried.push(`/${args.pattern}/ (case-insensitive)`);
        } catch (_) { /* keep walking the ladder */ }
    }

    // 2. The most distinctive word of the identifier.
    const token = distinctiveToken(args.pattern);
    if (token) {
        try {
            const pattern = escapeRegex(token);
            const res = await invoke('grep_search', { ...base, pattern, caseInsensitive: true });
            const matches = res?.matches || [];
            if (matches.length > 0) {
                ctx.onToolEvent?.('grep_search', { pattern, matchCount: matches.length });
                return render(
                    matches, pattern,
                    `ℹ️ "${args.pattern}" does not appear anywhere. Retried with its most distinctive ` +
                    `word "${token}" (case-insensitive) — these are NOT matches for your original query, ` +
                    `but they are where that word lives.`,
                );
            }
            tried.push(`/${pattern}/ (case-insensitive)`);
        } catch (_) { /* fall through to the honest empty answer */ }
    }

    return `No matches in ${searchRoot} (${filesSearched} files searched).` +
        (args.include_glob ? ` Filter: ${args.include_glob}` : '') +
        `\nTried: ${tried.join(', ')}.` +
        `\nThe name does not exist in this tree under any casing. Try symbol_search for a ` +
        `definition, a shorter/different word, or glob to locate the file by name — ` +
        `do NOT repeat these same patterns.`;
}

/** grep_search — regex search with a literal-string tolerant fallback. */
export async function handleGrepSearch(ctx, args, onAgentStatus) {
    const searchRoot = args.path ? ctx.resolvePath(args.path) : ctx.workspacePath;
    onAgentStatus?.(`Searching: /${args.pattern}/ in ${searchRoot}...`);
    try {
        const res = await invoke('grep_search', {
            pattern: args.pattern,
            path: searchRoot,
            includeGlob: args.include_glob || null,
            caseInsensitive: !!args.case_insensitive,
            maxResults: Number.isFinite(args.max_results) ? args.max_results : null,
            contextLines: Number.isFinite(args.context_lines) ? args.context_lines : null
        });
        const { matches = [], files_searched = 0, truncated = false } = res || {};
        ctx.onToolEvent?.('grep_search', { pattern: args.pattern, matchCount: matches.length });
        if (matches.length === 0) {
            return await grepZeroResultLadder(ctx, args, searchRoot, files_searched);
        }
        const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`);
        const header = `Found ${matches.length} match(es)` +
            (truncated ? ' (truncated)' : '') +
            ` across ${files_searched} files for /${args.pattern}/:`;
        return `${header}\n${lines.join('\n')}` +
            (truncated ? `\n[Result truncated. Narrow the search with include_glob or a more specific pattern.]` : '');
    } catch (e) {
        const emsg = String(e?.message || e || '');
        // Tolerant fallback: a malformed regex is the most common grep
        // failure (the model wrote an unescaped metachar). Retry once
        // treating the pattern as a LITERAL string before giving up.
        const looksRegexError = /regex|parse|repetition|unclosed|unrecognized|invalid/i.test(emsg);
        if (looksRegexError) {
            const literal = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                const res = await invoke('grep_search', {
                    pattern: literal,
                    path: searchRoot,
                    includeGlob: args.include_glob || null,
                    caseInsensitive: !!args.case_insensitive,
                    maxResults: Number.isFinite(args.max_results) ? args.max_results : null,
                    contextLines: Number.isFinite(args.context_lines) ? args.context_lines : null
                });
                const { matches = [], files_searched = 0, truncated = false } = res || {};
                ctx.onToolEvent?.('grep_search', { pattern: args.pattern, matchCount: matches.length });
                const note = `ℹ️ Your pattern wasn't valid regex; searched for it as a LITERAL string instead.\n`;
                if (matches.length === 0) {
                    return note + `No matches for "${args.pattern}" (literal) in ${searchRoot} (${files_searched} files).`;
                }
                const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`);
                return note + `Found ${matches.length} match(es)${truncated ? ' (truncated)' : ''} across ${files_searched} files for "${args.pattern}" (literal):\n${lines.join('\n')}`;
            } catch (_) { /* fall through to original error */ }
        }
        return `Error: grep_search failed — ${emsg}` +
            (looksRegexError ? ` (pattern is not valid regex; escape metachars like ( ) [ ] { } . * + ? | \\ or pass a simpler literal substring)` : '');
    }
}

/** glob — filename glob matching. */
export async function handleGlob(ctx, args, onAgentStatus) {
    const searchRoot = args.path ? ctx.resolvePath(args.path) : ctx.workspacePath;
    onAgentStatus?.(`Globbing: ${args.pattern} in ${searchRoot}...`);
    try {
        const res = await invoke('glob_files', {
            pattern: args.pattern,
            path: searchRoot,
            maxResults: Number.isFinite(args.max_results) ? args.max_results : null
        });
        const { files = [], truncated = false } = res || {};
        if (files.length === 0) {
            return `No files match glob '${args.pattern}' under ${searchRoot}.`;
        }
        return `Found ${files.length}${truncated ? '+' : ''} file(s) matching '${args.pattern}':\n` +
            files.join('\n') +
            (truncated ? `\n[Result truncated — narrow the pattern or pass max_results.]` : '');
    } catch (e) {
        return `Error: glob failed — ${e?.message || e}`;
    }
}

export async function handleFetchUrl(ctx, args, onAgentStatus) {
    const { url, headers: extraHeaders } = args;
    if (!url || !/^https?:\/\//i.test(url)) {
        return 'Error: url must start with http:// or https://';
    }
    onAgentStatus?.(`Fetching: ${url}`);
    try {
        const headerList = [];
        if (Array.isArray(extraHeaders)) {
            for (const h of extraHeaders) {
                if (h && typeof h.name === 'string' && h.name) {
                    headerList.push([h.name, String(h.value ?? '')]);
                }
            }
        } else if (extraHeaders && typeof extraHeaders === 'object') {
            for (const [k, v] of Object.entries(extraHeaders)) {
                headerList.push([k, String(v)]);
            }
        }
        
        let proxy = null;
        // The SSRF guard lives in the Rust command (it is what opens the socket);
        // this only forwards the user's opt-out list. A read failure therefore
        // means a STRICTER fetch, never a looser one.
        let allowHosts = null;
        try {
            const cfg = await invoke('get_ai_config');
            proxy = cfg?.proxy_url || null;
            allowHosts = Array.isArray(cfg?.fetch_allowed_hosts) ? cfg.fetch_allowed_hosts : null;
        } catch (_) { /* no config — deny-by-default still applies backend-side */ }

        const text = await invoke('fetch_url', {
            url,
            headers: headerList.length > 0 ? headerList : null,
            proxy,
            allowHosts,
        });
        return text;
    } catch (e) {
        return `Error fetching URL: ${e.message || e}`;
    }
}

/**
 * web_search — Tavily API web search. The LLM passes a QUERY (not a
 * URL); we return ranked {title, url, snippet} so it can fetch_url a REAL link
 * instead of guessing endpoints from memory (the main cause of 404 thrash).
 *
 * The HTTP request runs server-side (Rust `web_search` command) via Tavily.
 */
export async function handleWebSearch(ctx, args, onAgentStatus) {
    const query = (args?.query ?? args?.q ?? '').toString().trim();
    if (!query) return 'Error: web_search requires a non-empty "query" string.';
    const maxResults = Math.min(Math.max(parseInt(args?.max_results, 10) || 5, 1), 10);
    onAgentStatus?.(`Searching the web: ${query}`);
    try {
        // Honor the configured proxy (best-effort).
        let proxy = null;
        try { proxy = (await invoke('get_ai_config'))?.proxy_url || null; } catch (_) {}

        const data = await invoke('web_search', { query, proxy });
        
        const results = data.results || [];
        const out = results.slice(0, maxResults).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.content
        }));

        if (out.length === 0) {
            return `No web results for "${query}". The search API returned empty results. Rephrase the query, or if you already know a specific URL call fetch_url directly.`;
        }
        const list = out.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
        ).join('\n\n');
        return `Web search results for "${query}" (top ${out.length}):\n\n${list}\n\n` +
            `NEXT: pick the most relevant result and call fetch_url on its URL above — do NOT invent a different URL.`;
    } catch (e) {
        return `Error: web_search failed (${e.message || e}). If you already know a likely URL, use fetch_url directly instead of guessing.`;
    }
}

/**
 * symbol_search — find DEFINITIONS (function / class / struct / trait / …) by
 * name, instead of grepping a name and getting every call site back.
 *
 * Globs candidate source files, extracts their definitions with the pure
 * SymbolIndex, then ranks by match quality. Parsing lives in SymbolIndex.js
 * (unit-tested); this wrapper is just I/O + formatting.
 */
/** Wall-clock budget for the SCAN path. Past it we answer with what we have. */
const SYMBOL_SCAN_BUDGET_MS = 20000;
/** How many files to read+parse concurrently in the scan path. */
const SYMBOL_SCAN_CONCURRENCY = 8;

/**
 * Does an index hit satisfy the caller's path / glob narrowing?
 *
 * Only the narrowing forms that are cheap and unambiguous are honored here;
 * anything else makes the caller fall back to the scan rather than silently
 * answering from a differently-scoped index.
 */
function indexHitMatches(hit, { rootPrefix, extensions }) {
    const p = String(hit?.path || '').replace(/\\/g, '/');
    if (!p) return false;
    if (rootPrefix && !p.toLowerCase().startsWith(rootPrefix)) return false;
    if (extensions && extensions.length) {
        const ext = p.toLowerCase().split('.').pop();
        if (!extensions.includes(ext)) return false;
    }
    return true;
}

/**
 * Extensions a glob restricts to, when that is all it does ("*.js",
 * "**\/*.{ts,tsx}"). Returns null when the glob says something more (a
 * directory shape, a name pattern) that this cheap check cannot honor.
 */
function extensionsFromGlob(glob) {
    const g = String(glob || '').trim();
    if (!g) return [];
    const m = /^(?:\*\*\/)?\*\.(?:\{([^}]+)\}|([A-Za-z0-9]+))$/.exec(g);
    if (!m) return null;
    return (m[1] ? m[1].split(',') : [m[2]]).map(s => s.trim().toLowerCase()).filter(Boolean);
}

export async function handleSymbolSearch(ctx, args, onAgentStatus) {
    const query = String(args?.query || '').trim();
    if (!query) return 'Error: symbol_search requires a non-empty "query" (the symbol name to find).';
    const searchRoot = args?.path ? ctx.resolvePath(args.path) : ctx.workspacePath;
    const kind = String(args?.kind || '').trim();
    const limit = Number.isFinite(args?.max_results) ? Math.max(1, Math.min(200, args.max_results)) : 50;

    // Ask the INDEX first. When the workspace has been studied this is a single
    // index seek instead of globbing and re-parsing thousands of files, which is
    // where the order-of-magnitude token and time saving comes from. Nothing
    // indexed (or no study yet) falls through to the scan below, so the tool
    // never depends on the index existing.
    //
    // `path` / `include_glob` used to DISABLE this shortcut outright, which is
    // backwards: narrowing the search is exactly when the caller is being
    // careful, and it dropped them onto the slow path. Both are cheap filters
    // over the hits instead — and when a glob is richer than an extension list
    // we fall through rather than answer from the wrong scope.
    const extensions = extensionsFromGlob(args?.include_glob);
    // Near-misses found via the index, kept for the "did you mean" line if the
    // scan below also comes up empty.
    let nearMisses = [];
    if (extensions !== null) {
        try {
            const idx = new CodeIndexClient({ workspacePath: ctx.workspacePath, invoke });
            const hits = await idx.findSymbol(query, { kind, limit });
            const rootPrefix = args?.path ? String(searchRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
            const kept = hits.filter(h => indexHitMatches(h, { rootPrefix, extensions }));
            if (kept.length) {
                onAgentStatus?.(`Symbol index: ${query} (${kept.length} hit(s))`);
                return renderSymbolHits(kept, query);
            }
            // Nothing matched the query as spelled. The index knows every symbol
            // name in the workspace, so a typo or a half-remembered name is
            // answerable here for the cost of one more seek: probe with the
            // distinctive WORD of the identifier and keep whatever is closest.
            const token = distinctiveToken(query);
            if (token) {
                const probe = await idx.findSymbol(token, { kind, limit: 60 });
                const scoped = probe.filter(h => indexHitMatches(h, { rootPrefix, extensions }));
                const best = new Set(suggestNames(scoped.map(h => h.name), query, { limit: 5 }));
                nearMisses = scoped.filter(h => best.has(h.name)).slice(0, 5);
            }
        } catch (_) { /* index unavailable — scan instead */ }
    }

    // Default to the source types SymbolIndex understands.
    const pattern = args?.include_glob || '**/*.{js,jsx,mjs,cjs,ts,tsx,rs,py,java}';

    onAgentStatus?.(`Searching symbols: ${query} in ${searchRoot}...`);
    try {
        const res = await invoke('glob_files', { pattern, path: searchRoot, maxResults: 2000 });
        const files = (res?.files || []).filter(f => languageOf(f));
        if (files.length === 0) {
            return `No indexable source files under ${searchRoot} (pattern: ${pattern}).`;
        }
        // Read + extract. A file that fails to read is skipped, not fatal.
        // Files are processed in small CONCURRENT batches: one await per file in
        // series made a few hundred files an IPC round-trip queue, and the whole
        // pass is bounded by SYMBOL_SCAN_BUDGET_MS so a stalled backend can only
        // cost that much before the tool answers with what it already parsed.
        ensureTreeSitterConfigured();
        const deadline = Date.now() + SYMBOL_SCAN_BUDGET_MS;
        const all = [];
        let backend = 'regex';
        let scanned = 0;
        let timedOut = false;
        for (let i = 0; i < files.length; i += SYMBOL_SCAN_CONCURRENCY) {
            if (Date.now() > deadline) { timedOut = true; break; }
            const batch = files.slice(i, i + SYMBOL_SCAN_CONCURRENCY);
            const parsed = await Promise.all(batch.map(async (file) => {
                let content;
                try { content = await invoke('read_file', { path: file }); } catch (_) { return null; }
                if (typeof content !== 'string') return null;
                try { return await extractSymbolsBest(file, content); } catch (_) { return null; }
            }));
            for (const r of parsed) {
                if (!r) continue;
                scanned++;
                backend = r.backend;
                all.push(...r.symbols);
            }
        }
        const matches = matchSymbols(all, query, { kind, limit });
        const total = matchSymbols(all, query, { kind, limit: Number.MAX_SAFE_INTEGER }).length;
        ctx.onToolEvent?.('symbol_search', { query, matchCount: matches.length });
        const partial = timedOut
            ? `\n(NOTE: stopped after ${Math.round(SYMBOL_SCAN_BUDGET_MS / 1000)}s having scanned ${scanned} of ${files.length} files — narrow with \`path\`, or run "Study workspace" so this query hits the index instead.)`
            : '';
        if (matches.length === 0) {
            // "Did you mean" — from the names we just parsed, or from the index
            // probe above. A miss on a name the workspace nearly has is the
            // common case (a typo, the wrong half of a compound name), and
            // answering it here saves the model a round of blind guessing.
            const suggestions = suggestNames(all.map(s => s.name), query, { limit: 5 });
            const fromScan = suggestions.length
                ? all.filter(s => suggestions.includes(s.name))
                : [];
            const closest = fromScan.length ? fromScan : nearMisses;
            const didYouMean = closest.length
                ? `\nClosest names that DO exist:\n` +
                  closest.slice(0, 5).map(s => `  ${s.name} — ${s.path}:${s.line}`).join('\n') +
                  `\nRe-run symbol_search with one of these exact names if it is what you meant.`
                : '';
            return `No symbol definitions matching "${query}" in ${scanned} file(s)` +
                (kind ? ` (kind=${kind})` : '') +
                `. Try grep_search for usages, or a shorter query.${didYouMean}${partial}`;
        }
        return formatSymbols(matches, { query, total }) +
            `

(searched ${scanned} files via ${backend}; definitions only — use grep_search for call sites)${partial}`;
    } catch (e) {
        return `Error: symbol_search failed — ${e?.message || e}`;
    }
}


/**
 * code_deps — what a file depends on, or what depends on it.
 *
 * The reverse direction is the capability that did not exist before: "what
 * breaks if I change this" cannot be answered by reading the file, only by
 * having read every other one. The study pass does that once; this reads the
 * result.
 */
export async function handleCodeDeps(ctx, args, onAgentStatus) {
    const target = String(args?.path || '').trim();
    if (!target) return 'Error: code_deps requires "path" (the file to examine).';
    const direction = String(args?.direction || 'in').toLowerCase() === 'out' ? 'out' : 'in';
    const limit = Number.isFinite(args?.max_results) ? Math.max(1, Math.min(500, args.max_results)) : 60;
    // Hop count: 1 = direct neighbours only (the pre-4a behaviour). 2+ walks
    // the graph transitively — "what transitively depends on this". Capped at
    // 4 by the backend; anything beyond that is noise.
    const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(4, Math.round(args.depth))) : 1;

    const idx = new CodeIndexClient({ workspacePath: ctx.workspacePath, invoke });
    if (!idx.enabled) return 'Error: code_deps needs a workspace.';

    onAgentStatus?.(`Dependencies (${direction}${depth > 1 ? `, ${depth} hops` : ''}): ${target}`);
    try {
        const resolved = ctx.resolvePath(target);
        // The index stores whatever path the study pass globbed. Try the resolved
        // form first, then the literal argument, so both spellings work.
        let hits = await idx.deps(resolved, { direction, limit, depth });
        if (!hits.length && resolved !== target) hits = await idx.deps(target, { direction, limit, depth });
        return renderDeps(hits, target, direction, { depth });
    } catch (e) {
        return `Error: code_deps failed — ${e?.message || e}`;
    }
}
