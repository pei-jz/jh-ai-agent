// logs — pure rendering helpers for the Monitor's "All Logs" view (P4 split
// from MonitorView.js). The core loop of renderAllLogs (grouping log events
// into steps, choosing each step's summary, counting requests) is extracted
// here as a pure state machine; the view supplies the per-line formatters and
// HTML escaping so the extracted logic stays DOM-free and testable.

/**
 * Build the ordered "steps + init" list from raw log entries. Each step is
 * { stepId, summary, chatEntries, lines[] }. `lineHtmlFor` formats one log
 * event into HTML (or '' to skip); `isChatLog` decides which entries are CHAT
 * calls; `extractThoughtSummary` pulls the step summary from a thought event.
 *
 * @param {Array} logs the raw log events
 * @param {object} fmt
 * @param {(log:object)=>string} fmt.lineHtmlFor
 * @param {(data:object)=>boolean} fmt.isChatLog
 * @param {(raw:string)=>string} fmt.extractThoughtSummary
 * @param {(isoStr:string)=>string} fmt.formatTime
 * @param {Function|null} fmt.onRequestDivider called before each new request
 * @returns {{init:Array<string>, steps:Array<object>, totalSteps:number, requestStepIndexes:Array<number>}}
 *   requestStepIndexes: the step indexes (0-based, into `steps`) where a NEW
 *   request begins — the view inserts a request divider there.
 */
export function buildLogSteps(logs, fmt) {
    const SKIP_EVENTS = new Set(['token_usage', 'stream', 'confirm_resolved']);

    const init = [];
    const steps = [];
    const requestStepIndexes = [];
    let current = null;   // { stepId, summary, firstTool, chatEntries, lines, time }
    let lastStepNum = null;
    let stepCount = 0;
    let requestNum = 0;

    const flushStep = () => {
        if (!current) return;
        const finalSummary = current.summary
            || (current.firstTool ? `Used ${current.firstTool}` : 'Reasoning step (no output)');
        steps.push({
            stepId: current.stepId,
            summary: finalSummary,
            chatEntries: current.chatEntries,
            lines: current.lines,
            time: current.time,
            isLatest: stepCount === 0, // set below (stepCount known only at end)
        });
        current = null;
    };

    for (const log of (Array.isArray(logs) ? logs : [])) {
        // Skip noise events
        if (SKIP_EVENTS.has(log.event)) continue;

        // Step boundary marker
        if (log.event === 'status' && log.data.message?.startsWith('Thinking... (step ')) {
            flushStep();
            const m = log.data.message.match(/\(step (\d+)\)/);
            const stepId = m ? parseInt(m[1]) : stepCount + 1;
            // New request when the step counter restarts (num <= previous) or
            // this is the first step overall.
            if (lastStepNum === null || stepId <= lastStepNum) {
                requestNum++;
                if (fmt.onRequestDivider) fmt.onRequestDivider(requestNum);
                // This step begins a new request — record its index in `steps`.
                // (The step is appended by flushStep below, so we remember the
                // count of steps ALREADY flushed = the future index.)
                requestStepIndexes.push(steps.length);
            }
            lastStepNum = stepId;
            stepCount++;
            current = {
                stepId,
                summary: '',
                firstTool: null,
                chatEntries: [],
                lines: [],
                time: log.timestamp ? fmt.formatTime(log.timestamp) : '',
            };
            continue;
        }

        if (!current) {
            // Pre-step events → the synthetic Init list.
            const line = fmt.lineHtmlFor(log);
            if (line) init.push(line);
            continue;
        }

        // CHAT API call → collect for button (not inline).
        if (log.event === 'log' && fmt.isChatLog(log.data)) {
            current.chatEntries.push(log.data);
            continue;
        }

        // Thought → extract summary
        if (log.event === 'thought') {
            const raw = typeof log.data.text === 'string' ? log.data.text : JSON.stringify(log.data.text);
            current.summary = fmt.extractThoughtSummary(raw);
        }

        // First tool call → fallback summary
        if (log.event === 'tool_call' && !current.firstTool) {
            current.firstTool = log.data.name || null;
        }

        const line = fmt.lineHtmlFor(log);
        if (line) current.lines.push(line);
    }

    flushStep();

    // Mark the last step as "latest" (matches the original renderAllLogs).
    if (steps.length > 0) steps[steps.length - 1].isLatest = true;
    for (const s of steps) s.isLatest = s.isLatest || false;

    return { init, steps, totalSteps: stepCount, requestStepIndexes };
}

/**
 * What a step's CHAT button says: the calls it covers, totalled.
 *
 * Data rather than markup, so the component that draws it does not have to
 * parse it back out again. chatButtonHtml below is the string form, kept for
 * the raw-log path that still assembles HTML.
 */
export function chatButtonLabel(entries = []) {
    const sum = (f) => entries.reduce((s, c) => s + (f(c) || 0), 0);
    const prompt = sum(c => c.usage?.prompt_tokens);
    const completion = sum(c => c.usage?.completion_tokens);
    const cached = sum(c => c.usage?.cache_read_input_tokens);
    const ms = sum(c => c.duration);
    const last = entries[entries.length - 1] || {};
    const status = last.status || 200;
    return {
        text: `CHAT ${status} · ↑${prompt}t${cached > 0 ? ` ⚡${cached}t` : ''} ↓${completion}t · ${ms}ms`,
        isError: status >= 400 || !!last.error,
    };
}

/**
 * Build the CHAT button markup for a step (pure).
 */
export function chatButtonHtml(chatUid, entries) {
    const totalPrompt     = entries.reduce((s, c) => s + (c.usage?.prompt_tokens || 0), 0);
    const totalCompletion = entries.reduce((s, c) => s + (c.usage?.completion_tokens || 0), 0);
    const totalCached     = entries.reduce((s, c) => s + (c.usage?.cache_read_input_tokens || 0), 0);
    const totalDur        = entries.reduce((s, c) => s + (c.duration || 0), 0);
    const lastEntry = entries[entries.length - 1];
    const statusCode = lastEntry.status || 200;
    const isErr = statusCode >= 400 || lastEntry.error;
    const cachedTxt = totalCached > 0 ? ` ⚡${totalCached}t` : '';
    return `<button class="mstep-chat-btn${isErr ? ' err' : ''}" data-chat-uid="${chatUid}">CHAT ${statusCode} · ↑${totalPrompt}t${cachedTxt} ↓${totalCompletion}t · ${totalDur}ms</button>`;
}

/**
 * The request divider markup (pure).
 */
export function requestDividerHtml(requestNum, preview) {
    const p = preview ? ` — ${preview}` : '';
    return `<div class="mturn-divider mturn-request"><span>▼ Request ${requestNum}${p}</span></div>`;
}
