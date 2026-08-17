// ToolDispatch — pure tool-call classification and ordering for the agent loop
// (P3 monolith split from AgentController.js). No view state; every input is
// passed in. The loop applies side effects (status events, tracing) around the
// decisions made here.

/**
 * Run one tool call through the executor and produce a normalized record.
 * Pure wrapper: the caller supplies the executor + tracing + status hooks.
 *
 * @param {object} opts
 * @param {object} opts.call  {name, args}
 * @param {object} opts.executor ToolExecutor-like ({executeTool})
 * @param {(msg:string)=>void} [opts.onStatus]
 * @param {Function} [opts.onConfirm]
 * @returns {Promise<{call:object, result:any, duration:number}>}
 */
export async function executeOneCall({ call, executor, onStatus, onConfirm }) {
    const toolStartTime = Date.now();
    const result = await executor.executeTool(call, (statusMsg) => {
        onStatus?.(statusMsg);
    }, onConfirm);
    return { call, result, duration: Date.now() - toolStartTime };
}

/**
 * Build the per-run tool-usage counters from a tool call batch.
 * @returns {object} name → count
 */
export function countToolUsage(toolCalls, counts) {
    const out = counts || {};
    for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
        out[tc.name] = (out[tc.name] || 0) + 1;
    }
    return out;
}

/**
 * True when a tool result string represents an error (starts with "Error").
 */
export function isErrorResult(result) {
    return typeof result === 'string' && result.startsWith('Error');
}

/**
 * Truncate a result for a status line (300 chars max, trailing ellipsis).
 */
export function summarizeForStatus(result) {
    if (typeof result !== 'string') return result;
    return result.length > 300 ? `${result.substring(0, 300)}...` : result;
}

/**
 * Decide whether images a tool produced can ride along to the LLM, and what
 * notice to emit. Pure — the loop pushes them into _pendingToolImages or
 * drops them with a notice.
 *
 * @returns {{attached:boolean, notice:string}}
 */
export function routeProducedImages({ producedImages, activeModel, modelSupportsVision }) {
    if (!producedImages || producedImages.length === 0) return { attached: false, notice: '' };
    if (typeof modelSupportsVision === 'function' && modelSupportsVision(activeModel)) {
        return { attached: true, notice: '' };
    }
    return {
        attached: false,
        notice: `\n[Note: ${producedImages.length} image(s) were extracted, but the active model (${activeModel || 'unknown'}) has no vision support so they could not be shown. Work from the text, or tell the user to switch to a vision-capable model.]`,
    };
}
