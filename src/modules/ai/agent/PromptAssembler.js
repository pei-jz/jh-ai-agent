// PromptAssembler — pure prompt & history assembly for the agent loop (P3
// monolith split from AgentController.js). None of these functions touch view
// state or `this`; every input arrives as an argument, so the loop's behaviour
// is byte-identical while the logic becomes directly unit-testable.
//
// Contents: present_result envelope validation, tool-arg hints, history
// character/text/hash helpers, tool-result-group compression, and the
// standards-aligned history writers (native + JSON-mode tool turns).

import { hashContent } from './CompressionMetrics.js';

/**
 * Fold `[{path, description}]` from the description generator onto the result's
 * file rows, mutating them in place. Path matching tolerates separator and
 * absolute/relative differences — the model echoes back whatever form it likes.
 * @returns {boolean} true when at least one description was applied
 */
export function applyDescriptions(files, items) {
    if (!Array.isArray(items)) return false;
    let applied = false;
    for (const item of items) {
        if (!item || !item.path || !item.description) continue;
        const norm = String(item.path).replace(/\\/g, '/');
        const match = files.find(f =>
            f.path === item.path ||
            f.path.replace(/\\/g, '/') === norm ||
            f.path.replace(/\\/g, '/').endsWith(norm));
        if (!match) continue;
        match.description = String(item.description).substring(0, 200);
        applied = true;
    }
    return applied;
}

/**
 * True when a present_result envelope actually carries a deliverable. Used to
 * stop an empty follow-up present_result from clobbering a good earlier one.
 */
export function envelopeHasContent(env) {
    if (!env || typeof env !== 'object') return false;
    const p = env.payload || {};
    const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
    switch (env.kind) {
        case 'answer':    return nonEmptyStr(p.text) || nonEmptyStr(p.answer);
        case 'code-edit': return Array.isArray(p.edits) && p.edits.length > 0;
        case 'file-list': return Array.isArray(p.files) && p.files.length > 0;
        case 'markdown':
        case 'table':
        default:          return nonEmptyStr(p.md) || nonEmptyStr(p.markdown) || nonEmptyStr(p.text);
    }
}

/**
 * A short, human-readable hint of what a tool call is acting on — the command
 * for run_command, the file basename for file tools, the query for searches.
 * Used to make progress lines (esp. sub-agent activity) describe the actual
 * work instead of just repeating a bare tool name. Returns '' when there's
 * nothing concise to show.
 */
export function toolArgHint(name, args) {
    try {
        const a = args || {};
        const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        switch (name) {
            case 'run_command':
                return String(a.command || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            case 'read_file':
            case 'write_file':
            case 'replace_lines':
            case 'multi_replace_file_content':
            case 'delete_file':
            case 'verify_syntax':
            case 'create_artifact':
                return base(a.path);
            case 'move_file':
                return base(a.to || a.from);
            case 'grep_search':
                return String(a.query || '').slice(0, 40);
            case 'list_files':
            case 'glob':
                return String(a.path || a.pattern || '').slice(0, 40);
            case 'web_search':
                return String(a.query || '').slice(0, 40);
            case 'run_subtask':
                return String(a.role || 'generic');
            default:
                return '';
        }
    } catch (_) { return ''; }
}

/** Total character weight of a history array (cheap proxy for token size). */
export function historyChars(history) {
    if (!Array.isArray(history)) return 0;
    let n = 0;
    for (const m of history) {
        const c = m && m.content;
        n += typeof c === 'string' ? c.length : (c ? JSON.stringify(c).length : 0);
    }
    return n;
}

/** All history text as one blob — for measuring what a summary preserved. */
export function historyText(history) {
    if (!Array.isArray(history)) return '';
    return history
        .map(m => (typeof m?.content === 'string' ? m.content : ''))
        .join('\n');
}

/**
 * Content hashes present BEFORE compaction but gone after — i.e. what the
 * compressor actually discarded. Lets CompressionMetrics upgrade a re-fetch
 * from "a compression happened in between" (correlation) to "this exact
 * content was dropped" (causation).
 */
export function droppedContentHashes(before, after) {
    const hashOf = (arr) => {
        const set = new Set();
        for (const m of (Array.isArray(arr) ? arr : [])) {
            if (typeof m?.content === 'string' && m.content) set.add(hashContent(m.content));
        }
        return set;
    };
    const kept = hashOf(after);
    const dropped = [];
    for (const h of hashOf(before)) {
        if (!kept.has(h)) dropped.push(h);
    }
    return dropped;
}

/**
 * True if a "Tool Execution Results:" message contains a successful read_file
 * result whose content is substantial but within `budget` chars — i.e. a file
 * snapshot worth preserving verbatim through compression (re-read suppression).
 */
export function resultGroupHasReadContent(content, budget) {
    if (typeof content !== 'string') return false;
    try {
        const marker = 'Tool Execution Results:\n';
        const j = content.indexOf(marker);
        if (j === -1) return false;
        const raw = content.substring(j + marker.length).trim();
        const end = raw.indexOf('\n[');
        const jsonStr = end !== -1 ? raw.substring(0, end) : raw;
        const results = JSON.parse(jsonStr);
        if (!Array.isArray(results)) return false;
        return results.some(r =>
            r && r.tool_call_name === 'read_file' &&
            typeof r.result === 'string' &&
            !r.result.startsWith('Error') &&
            r.result.length > 200 && r.result.length <= budget);
    } catch (_) {
        return false;
    }
}

/**
 * Write the assistant turn to history. NATIVE sessions get the standards-
 * aligned form — prose `content` + `tool_calls` array with ids (what the
 * model was RL-trained on; replaying turns as a JSON text envelope taught
 * weak models to answer in text). JSON-mode sessions keep the legacy text
 * envelope so that protocol stays self-consistent end to end.
 */
export function pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf) {
    if (!callIdOf || callIdOf.size === 0 || !toolCall?.tool_calls?.length) {
        history.push({ role: 'assistant', content: response });
        return;
    }
    const thought = genResult?.nativeTurn?.text
        || (typeof toolCall.thought === 'string' ? toolCall.thought : (toolCall.thought?.current_task || ''))
        || '';
    history.push({
        role: 'assistant',
        content: thought,
        tool_calls: toolCall.tool_calls.map((c, i) => ({
            id: callIdOf.get(c) || `call_syn_x_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
    });
}

/**
 * Write this iteration's tool results. Native → one role:"tool" message per
 * call (id-correlated; Rust converts per provider) + an optional trailing
 * user note; JSON-mode → the legacy single "Tool Execution Results:" user
 * message (byte-identical to the previous format).
 */
export function pushToolResultsTurn(history, results, native, tailText) {
    if (native) {
        for (const r of results) {
            history.push({
                role: 'tool',
                tool_call_id: r.id || 'call_unknown',
                name: r.tool_call_name,
                content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''),
            });
        }
        const tail = (tailText || '').trim();
        if (tail) history.push({ role: 'user', content: tail });
    } else {
        history.push({
            role: 'user',
            content: `Tool Execution Results:\n${JSON.stringify(results, null, 2)}${tailText || ''}`,
        });
    }
}

/**
 * Compress old tool-result groups in `history` (in place) to bound context
 * growth on long runs. Pure function of the history array — no view state.
 *
 * ── Compression policy (revised) ─────────────────────────────────
 *   • Keep the 3 most-recent tool result groups VERBATIM. This is the
 *     window inside which self-correction usually happens, and the
 *     full content (especially error diagnostics like "Closest matching
 *     region" diffs) is what enables the LLM to recover.
 *   • For older groups, summarize success results (name + "Completed")
 *     but keep error results with up to 2 KB of detail — errors are the
 *     only past content that consistently helps the LLM avoid repeating
 *     the same mistake.
 *   • Also scrub the *assistant* message immediately before any
 *     summarized error result: it contains the failed tool-call args
 *     (often a huge multiline old_text full of typos) which add noise
 *     and tempt the LLM to copy the bad version.
 */
export function compressToolResultsInHistory(history) {
    const KEEP_RECENT_RESULTS = 3;
    const ERROR_KEEP_CHARS    = 2000;

    // Pass 1: collect result GROUPS newest-first. A group is either the
    // legacy single "Tool Execution Results:" user message (JSON mode) or a
    // consecutive run of role:"tool" messages (native standards-aligned
    // history) — one group per agent iteration in both protocols.
    const groups = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === 'user' && typeof m.content === 'string' &&
            m.content.startsWith('Tool Execution Results:')) {
            groups.push({ kind: 'text', idx: i });
        } else if (m.role === 'tool') {
            let start = i;
            while (start - 1 >= 0 && history[start - 1].role === 'tool') start--;
            groups.push({ kind: 'native', start, end: i });
            i = start;   // skip past the whole run
        }
    }
    // groups is newest-first; the first KEEP_RECENT_RESULTS are exempt.
    const toCompress = groups.slice(KEEP_RECENT_RESULTS);
    if (toCompress.length === 0) return;

    // ── Re-read suppression: preserve the latest read_file SNAPSHOT verbatim ──
    // Stripping old read_file results to "(Completed)" discards the file's
    // content, so once a read ages out of the 3-recent window the agent has
    // nothing to work from and RE-READS the whole file — the dominant token
    // sink on long single-file edits. Keep the most-recent sizable read_file
    // result (one file, within a char budget) so the current snapshot stays
    // available and re-reads become unnecessary.
    const SNAPSHOT_CHAR_BUDGET = 40000;
    let preserveIdx = -1;         // legacy text-group message to keep verbatim
    let preserveNativeIdx = -1;   // native role:"tool" read_file message to keep
    for (const g of groups) { // newest-first
        if (g.kind === 'text') {
            if (resultGroupHasReadContent(history[g.idx]?.content, SNAPSHOT_CHAR_BUDGET)) {
                preserveIdx = g.idx;
                break;
            }
        } else {
            let found = -1;
            for (let j = g.end; j >= g.start; j--) {
                const m = history[j];
                if (m.name === 'read_file' && typeof m.content === 'string' &&
                    !m.content.startsWith('Error') &&
                    m.content.length > 500 && m.content.length <= SNAPSHOT_CHAR_BUDGET) {
                    found = j;
                    break;
                }
            }
            if (found !== -1) { preserveNativeIdx = found; break; }
        }
    }

    for (const g of toCompress) {
        // ── Native group: per role:"tool" message compression ─────────
        if (g.kind === 'native') {
            let hadNativeError = false;
            for (let j = g.start; j <= g.end; j++) {
                if (j === preserveNativeIdx) continue;   // latest file snapshot stays
                const m = history[j];
                if (typeof m.content !== 'string') continue;
                if (m.content.startsWith('Error')) {
                    hadNativeError = true;
                    if (m.content.length > ERROR_KEEP_CHARS) {
                        m.content = m.content.substring(0, ERROR_KEEP_CHARS) + '… [truncated]';
                    }
                } else if (m.content.length > 200) {
                    m.content = '(Completed — result summarized to save context)';
                }
            }
            // Scrub the failed call's args from the preceding assistant turn —
            // same rationale as the legacy path: huge typo-ridden old_text noise.
            if (hadNativeError && g.start > 0) {
                const prev = history[g.start - 1];
                if (prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
                    for (const tc of prev.tool_calls) {
                        if (tc?.function) {
                            tc.function.arguments = '{"_scrubbed":"prior call failed — args removed to keep context clean"}';
                        }
                    }
                }
            }
            continue;
        }

        const i = g.idx;
        if (i === preserveIdx) continue; // keep the latest file snapshot intact
        const original = history[i].content;
        let summary = '[System: Past tool execution results have been summarized.]';
        let hadError = false;

        try {
            const jsonStartIndex = original.indexOf('Tool Execution Results:\n');
            if (jsonStartIndex !== -1) {
                const rawJson = original.substring(jsonStartIndex + 'Tool Execution Results:\n'.length).trim();
                const jsonEnd = rawJson.indexOf('\n[');
                const jsonStr = jsonEnd !== -1 ? rawJson.substring(0, jsonEnd) : rawJson;
                try {
                    const results = JSON.parse(jsonStr);
                    if (Array.isArray(results)) {
                        const toolSummaries = results.map(r => {
                            const name = r.tool_call_name || 'unknown';
                            const resStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result || '');
                            const isError = resStr.startsWith('Error');
                            if (isError) {
                                hadError = true;
                                // ── Bug 2 fix: preserve up to ERROR_KEEP_CHARS of error detail ──
                                // so the LLM can still see the closest-region diff / fresh content
                                // from auto-recovery, instead of just "Error: ...(truncated)".
                                const errKept = resStr.length > ERROR_KEEP_CHARS
                                    ? resStr.substring(0, ERROR_KEEP_CHARS) + '… [truncated]'
                                    : resStr;
                                return `${name} →\n${errKept}`;
                            }
                            return `${name} (Completed)`;
                        });
                        summary = `[System: Past tool results — older entries summarized]\n${toolSummaries.join('\n\n')}`;
                    }
                } catch (_) { /* fall through to generic summary */ }
            }
        } catch (_) { /* fall through */ }

        history[i].content = summary;

        // ── Bug 5 fix: scrub the assistant message that came right before ──
        // If the previous turn was an assistant emitting tool_calls and the
        // result was an error, the args almost certainly contained the
        // typo-ridden old_text/new_text. Replace it with a thought-only stub
        // so the bad code doesn't pollute future context.
        if (hadError && i > 0 && history[i - 1].role === 'assistant') {
            const prev = history[i - 1];
            try {
                const parsed = typeof prev.content === 'string'
                    ? JSON.parse(prev.content)
                    : prev.content;
                if (parsed && (parsed.tool_calls || parsed.thought)) {
                    const names = Array.isArray(parsed.tool_calls)
                        ? parsed.tool_calls.map(tc => tc?.name || 'unknown').join(', ')
                        : 'unknown';
                    const thoughtKept = typeof parsed.thought === 'string'
                        ? (parsed.thought.length > 300 ? parsed.thought.slice(0, 300) + '…' : parsed.thought)
                        : '';
                    history[i - 1].content = JSON.stringify({
                        thought: thoughtKept,
                        tool_calls: `[scrubbed: prior call to ${names} failed — see next message for the error detail. Original args removed to keep context clean.]`
                    });
                }
            } catch (_) { /* not JSON or unexpected shape — leave as-is */ }
        }
    }
}
