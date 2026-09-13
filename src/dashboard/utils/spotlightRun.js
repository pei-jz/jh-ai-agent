// spotlightRun — Spotlight's answers, served by the real engine.
//
// Spotlight used to run its own loop: a private ToolExecutor, a hand-written
// JSON tool protocol (used even for models with native tool calling), and every
// connected app's MCP tools passed through with no allowlist — including
// JHEditor's read_workspace_file, gated only by the editor's own setting. It had
// no cost record, no safety guards, and a checkbox row for MCP servers that
// nothing read. That was the fourth conversation implementation in the app
// (docs/scratch/Report_20260913.md A10, §6-4).
//
// Now a question is a task on lane L2 — `ask × none` — marked ephemeral:
//
//   ask        a conversation that can only look
//   none       the model and the web; no file system, no MCP, no project context
//   ephemeral  not in the task list, not in history, not in memory — Spotlight
//              stays "the layer you use without switching windows and that keeps
//              nothing" (information-architecture.md §5). "Expand" is still how
//              an answer crosses into Work.
//
// Pure apart from the socket, which is injectable.

/** The behavior block for a Spotlight question. */
export function spotlightBehavior() {
    return {
        mode: 'iterative_agent',
        shape: 'ask',
        reach: 'none',
        ephemeral: true,
        // Explicit, and empty: an omitted list means "every server".
        mcp_servers: [],
    };
}

/** The POST /tasks body. */
export function spotlightTaskBody(prompt) {
    return {
        prompt: String(prompt || ''),
        caller: 'Spotlight',
        workspace_path: null,
        behavior: spotlightBehavior(),
    };
}

/**
 * Follow a task's socket until the run ends.
 *
 * Resolves with the ANSWER — `complete.answer` (what present_result delivered),
 * falling back to the summary and then to whatever streamed. Rejects on a
 * TERMINAL error only: the loop also emits recoverable errors mid-run (a retry),
 * and treating those as the end would show an error for a run that went on to
 * answer.
 *
 * @param {string} wsUrl
 * @param {object} [o]
 * @param {(chunk:string) => void} [o.onStream]
 * @param {(name:string) => void} [o.onTool]
 * @param {(message:string) => void} [o.onStatus]
 * @param {AbortSignal} [o.signal]   aborting resolves with '' (the caller moved on)
 * @param {Function} [o.WebSocketImpl]
 * @returns {Promise<string>}
 */
export function followTask(wsUrl, { onStream, onTool, onStatus, signal, WebSocketImpl } = {}) {
    const WS = WebSocketImpl || globalThis.WebSocket;
    return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WS(wsUrl); } catch (e) { reject(e); return; }

        let streamed = '';
        let settled = false;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch (_) { /* already closed */ }
            fn(value);
        };

        if (signal) {
            if (signal.aborted) { done(resolve, ''); return; }
            signal.addEventListener('abort', () => done(resolve, ''), { once: true });
        }

        ws.onmessage = (ev) => {
            let pkt;
            try { pkt = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
            const d = (pkt && pkt.data) || {};
            switch (pkt && pkt.event) {
                case 'stream':
                    if (d.chunk) { streamed += d.chunk; onStream?.(d.chunk); }
                    break;
                case 'tool_call':
                    if (d.name) onTool?.(d.name);
                    break;
                case 'status':
                    if (d.message) onStatus?.(d.message);
                    break;
                case 'complete':
                    done(resolve, d.answer || d.resultSummary?.answer || d.message || streamed);
                    break;
                case 'error':
                    if (d.terminal === true) done(reject, new Error(d.error || 'The run failed.'));
                    break;
                default:
                    break;
            }
        };
        ws.onerror = () => { /* onclose settles */ };
        ws.onclose = () => done(reject, new Error('The connection closed before the answer arrived.'));
    });
}
