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

/** read_file — slice + line-number a file, with session-cache + re-read nudge. */
export async function handleReadFile(ctx, args, onAgentStatus, resolvedPath) {
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
            return `No matches for /${args.pattern}/ in ${searchRoot} ` +
                `(${files_searched} files searched).` +
                (args.include_glob ? ` Filter: ${args.include_glob}` : '');
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
        try { proxy = (await invoke('get_ai_config'))?.proxy_url || null; } catch (_) {}

        const text = await invoke('fetch_url', { 
            url, 
            headers: headerList.length > 0 ? headerList : null,
            proxy 
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
