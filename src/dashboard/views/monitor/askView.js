// askView — what an `ask` run shows instead of a timeline.
//
// docs/design/information-architecture.md §4 is the contract this implements.
// The short version: an `ask` run is a CONVERSATION, so it renders as
//
//     あなたの発話 → （進行を示す 1 行）→ 回答
//
// and nothing else. Tool calls are not steps you watch go by; they are how the
// answer got made, and they belong behind one folded line.
//
// This is a REDUCTION of the same timeline the build path renders, not a second
// timeline. Switching the filter to "Raw Log" gives the full item list back
// unchanged — the escape hatch is deliberate (§4-4), and it only works because
// nothing is thrown away here.
//
// Pure: the view passes items in and renders what comes out.

/**
 * The kinds that ARE the conversation.
 *
 *   turn        — what was said, either side
 *   deliverable — present_result: the answer itself
 *   document    — a produced file, which an ask run can still have (a report)
 *   ask         — the agent asking BACK; hiding it would deadlock the run
 *   confirm     — an approval request. An `ask` run should not produce one
 *                 (read-only tools), but if one appears it must be visible:
 *                 a hidden approval is a run that never continues.
 *   error       — a failure is an answer too
 */
export const CONVERSATION_KINDS = new Set([
    'turn', 'deliverable', 'document', 'run', 'ask', 'confirm', 'error',
]);

/**
 * Kinds that are machinery — the work of producing the answer.
 * `fold` and `group` are the build view's own scaffolding and have nothing to
 * fold in a conversation, so they are dropped rather than counted.
 */
const SCAFFOLD_KINDS = new Set(['fold', 'group']);

/** A short label for one withheld item, for the folded list. */
function toolLabel(item) {
    const t = item?.tool || item?.name || item?.kind || '';
    const target = item?.target || item?.path || '';
    return target ? `${t} ${target}` : String(t);
}

/**
 * Reduce a timeline to the conversation, plus a summary of what was withheld.
 *
 * @param {Array} items the same items the build view renders
 * @returns {{items: Array, tools: {count: number, lines: string[]}|null}}
 *   `tools` is null when there is nothing withheld — the folded row hides
 *   itself rather than saying "0 tools", which is noise on a question the agent
 *   answered from what it already knew.
 */
export function askStream(items) {
    const list = Array.isArray(items) ? items : [];
    const kept = [];
    const withheld = [];

    for (const item of list) {
        const kind = item?.kind;
        if (CONVERSATION_KINDS.has(kind)) { kept.push(item); continue; }
        if (SCAFFOLD_KINDS.has(kind)) continue;
        withheld.push(item);
    }

    return {
        items: kept,
        tools: withheld.length
            ? { count: withheld.length, lines: withheld.map(toolLabel).filter(Boolean) }
            : null,
    };
}

/**
 * The progress line's text.
 *
 * ONE line, always. It shows elapsed seconds while the model is being waited on
 * and is OVERWRITTEN — not appended to — while a tool runs, which is the whole
 * behaviour §4-2 pins: three tool calls still produce one line.
 *
 * The 0.1s resolution is deliberate and is not a measurement: it is the smallest
 * signal that says "this is moving". Per-step durations belong to the build view.
 *
 * @param {number} elapsedMs
 * @param {string|null} status the current tool status, if a tool is running
 */
export function thinkLabel(elapsedMs, status = null) {
    if (status) return String(status);
    const secs = Math.max(0, Number(elapsedMs) || 0) / 1000;
    return `Thinking... (${secs.toFixed(1)}s)`;
}
