/**
 * @jh/ai-client — minimal client library for invoking JH AI Agent
 * from sibling JH applications (JHEditor, JHER, JH Task Manager, …).
 *
 * Design goals:
 *   • Zero hard-coded profile names — caller fully owns the "behavior" object.
 *   • Pairs with the agent on first use: the app asks, a person approves, and
 *     the token lives in memory on both sides — never in a file.
 *   • Vanilla JS, no framework dependencies. Works in Tauri WebViews, Electron,
 *     plain browsers, and Node (with fetch + WebSocket polyfills if needed).
 *
 * Two execution modes are exposed:
 *
 *   client.invoke({prompt, behavior, context})
 *     → Promise<{ content, error?, taskId }>
 *     Use for single_shot work like "generate SQL", "suggest FKs".
 *     Waits for the task to complete and returns the final response text.
 *
 *   client.invokeAgent({prompt, behavior, context, chatContext, onStep, onConfirm, onLog})
 *     → { taskId, completed: Promise<{ content, modifiedFiles }>, abort() }
 *     Use for long-running iterative_agent work (refactoring, multi-step tasks)
 *     AND for multi-turn conversation (behavior.interaction: "ask"), which is
 *     what `chatContext` is for.
 *     Streams events back via the provided callbacks; the returned `completed`
 *     promise resolves when the agent declares finish_task (or rejects on error).
 *
 * Both modes accept the same `behavior` shape:
 *
 *   {
 *     mode: "single_shot" | "iterative_agent",
 *     system_prompt: string,
 *     enabled_tools: string[] | null,     // null = all; ["read_file",…] = subset
 *     max_iterations: number,             // 0 = unlimited
 *     response_format: "text" | "json" | "code",
 *     extra_instructions: string,         // appended after system_prompt
 *     interaction: "ask" | "build",       // question vs job — see below
 *   }
 *
 * ── Lanes ─────────────────────────────────────────────────────────────────
 * The server decides what a run is from `behavior.shape` and `behavior.reach`
 * (src/modules/ai/agent/RunLane.js). An app that says nothing gets `ask × app`:
 * its own MCP tools and the web, and no file system. Asking for more — a
 * workspace, or `build` — has to be explicit, and `build` without a workspace is
 * refused.
 *
 * ── Picking a mode ────────────────────────────────────────────────────────
 * `single_shot` is for a DETERMINISTIC ONE-WAY TRANSFORM: a commit message, a
 * summary, "give me this as JSON". One call, no tools, no history, no second
 * turn — those constraints are the feature (predictable latency and cost).
 *
 * It is the wrong mode for a CONVERSATION. It carries no prior turns, so a
 * follow-up like "explain that last part" arrives with nothing to refer to.
 * For that, use `invokeAgent` with `behavior.interaction: "ask"` and pass
 * `chatContext`: the run drops plan-first, task_progress and delegation, and
 * narrows its tools to read-only — a conversation served by the real engine.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 14300;

/**
 * A six-digit comparison code for a pairing request.
 *
 * Shown by BOTH ends: the agent's prompt draws it, and the app that asked has
 * to draw it too. The user compares. It exists for one attack — a background
 * process firing a request at the moment the user launches their editor, so the
 * prompt looks like the thing they just started — and a number the editor's own
 * window does not show is the tell.
 *
 * `crypto.getRandomValues` where it exists. The fallback is not
 * cryptographically strong, and does not need to be: guessing the code buys
 * nothing on its own, because the attacker would still have to be the process
 * the user is looking at.
 */
function pairingCode() {
    try {
        const a = new Uint32Array(1);
        globalThis.crypto.getRandomValues(a);
        return String(a[0] % 1000000).padStart(6, '0');
    } catch (_) {
        return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class JhAiClient {
    /**
     * @param {object} [options]
     * @param {string} [options.host]   Override host (defaults to 127.0.0.1 or discovered config)
     * @param {number} [options.port]   Override port
     * @param {string} [options.token]  Override auth token
     * @param {function} [options.readConfigFile] Async function(path) -> string,
     *        used to load the standard config file. Tauri callers should pass
     *        `(path) => invoke('read_file', { path })`. Browser callers can
     *        skip this and provide host/port/token directly.
     */
    constructor(options = {}) {
        this.host = options.host || DEFAULT_HOST;
        this.port = options.port || DEFAULT_PORT;
        // Held in memory for the life of this process and never written down.
        // The agent does not write it down either (src-tauri/src/server/
        // tokens.rs), so closing either end ends the grant.
        this.token = options.token || null;
        this.appName = options.appName || 'JH app';
        this._onPairing = options.onPairing || null;
        this._pairing = null;   // the in-flight pairing, so two calls share one
    }

    /**
     * Have a usable token, pairing if necessary.
     *
     * Pairing replaces reading %APPDATA%/JH/ai-connection.json, which was a
     * full-access credential in a file any process running as the user could
     * read — no approval, no record of who took it, no way to take it back from
     * one caller. Now the app asks, a person answers, and the token exists only
     * in the two processes' memory.
     *
     * Concurrent callers share ONE attempt. Without that, opening an editor
     * whose panel and status bar both talk to the agent would put two approval
     * prompts in front of the user for the same app.
     */
    async ready() {
        if (this.token) return;
        if (!this._pairing) {
            this._pairing = this._pair().finally(() => { this._pairing = null; });
        }
        await this._pairing;
    }

    /**
     * Ask, then wait for the answer.
     *
     * @returns {Promise<string>} the token
     */
    async _pair() {
        const code = pairingCode();
        const res = await fetch(`${this._baseUrl()}/pair/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app: this.appName, code }),
        });
        if (res.status === 429) {
            throw new Error(
                'J.H AI Agent is refusing further connection requests for a moment. '
                + 'Answer the prompt already on screen, or try again shortly.'
            );
        }
        if (!res.ok) {
            throw new Error(
                `Could not reach J.H AI Agent (HTTP ${res.status}). Is it running?`
            );
        }
        const { request_id: id, expires_in: expiresIn } = await res.json();

        // The host shows the code so the user can COMPARE it with the agent's
        // prompt. Without this half the code is worthless — it is a comparison,
        // and a comparison needs two things to look at.
        const done = this._onPairing?.({ code, expiresIn }) || (() => {});

        try {
            // Poll rather than hold a socket open: the answer is a human
            // deciding, which takes seconds, and a dropped connection during
            // that window would look like a denial.
            const deadline = Date.now() + (expiresIn || 120) * 1000;
            while (Date.now() < deadline) {
                await sleep(700);
                const poll = await fetch(`${this._baseUrl()}/pair/${id}`);
                if (poll.status === 404) break;   // expired out of the map
                if (!poll.ok) continue;
                const body = await poll.json();
                if (body.status === 'approved' && body.token) {
                    this.token = body.token;
                    return body.token;
                }
                if (body.status === 'denied') {
                    throw new Error('The connection was declined in J.H AI Agent.');
                }
                if (body.status === 'expired') break;
            }
            throw new Error('The connection request timed out with no answer.');
        } finally {
            try { done(); } catch (_) { /* the host's own teardown */ }
        }
    }

    /** Forget the token. The next call pairs again. */
    _forgetToken() { this.token = null; }

    _baseUrl() { return `http://${this.host}:${this.port}/api`; }
    _wsBase()  { return `ws://${this.host}:${this.port}/ws`; }

    async _post(path, body) {
        const res = await this._authed((token) => fetch(this._baseUrl() + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        }));
        return res.json();
    }

    /**
     * Run an authenticated request, re-pairing once if the token is not known.
     *
     * This is the case that happens most: the AGENT restarted. Its tokens live
     * in memory, so every app that was connected is now holding a string the
     * agent has never seen — and without this the app would report "not
     * reachable" and stay broken until the user restarted IT too. A 401 means
     * "you need to authenticate", so the client does, once, and retries.
     *
     * Only once: a second 401 after a fresh pairing is a real failure, and
     * retrying it in a loop would put an approval prompt on screen repeatedly.
     */
    async _authed(send) {
        await this.ready();
        let res = await send(this.token);
        if (res.status === 401) {
            this._forgetToken();
            await this.ready();
            res = await send(this.token);
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return res;
    }

    /**
     * Open J.H AI Agent with a request typed into its composer — NOT started.
     *
     * For work: an app that wants something DONE hands over the text, and the
     * user sends it from the agent, where the workspace picker, plan approval and
     * diff review are. Posting a build task from another app's text box skipped
     * all three.
     *
     * @param {{prompt?: string, workspace?: string|null}} [o]
     * @returns {Promise<boolean>} true once the agent accepted the hand-over
     */
    async compose({ prompt = '', workspace = null } = {}) {
        const res = await this._authed((token) => fetch(`${this._baseUrl()}/ui/compose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ prompt, workspace }),
        }));
        return res.ok;
    }

    /**
     * Single-shot invocation. Resolves with the final text response.
     * Use for "give me a SQL query", "suggest FKs", "summarize this".
     */
    async invoke({ prompt, behavior, context, caller, timeoutMs = 120000, onChunk = null } = {}) {
        if (!prompt) throw new Error('JhAiClient.invoke: prompt is required.');
        const finalBehavior = {
            mode: 'single_shot',
            // The lane, stated: one round trip, no tools, no workspace.
            shape: 'transform',
            ...behavior,
        };

        const { task_id } = await this._post('/tasks', {
            prompt,
            workspace_path: null,
            caller: caller || null,
            context: context !== undefined ? context : null,
            behavior: finalBehavior,
        });

        // Subscribe to the WebSocket to receive streaming + completion events.
        return new Promise((resolve, reject) => {
            const wsUrl = `${this._wsBase()}/tasks/${task_id}?token=${this.token}`;
            let ws;
            try { ws = new WebSocket(wsUrl); }
            catch (e) { return reject(e); }

            let content = '';
            let settled = false;
            const settle = (err, value) => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (_) {}
                if (err) reject(err); else resolve(value);
            };

            const timer = setTimeout(() => settle(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

            ws.onmessage = (ev) => {
                let pkt;
                try { pkt = JSON.parse(ev.data); } catch (_) { return; }
                if (!pkt) return;
                if (pkt.event === 'stream' && pkt.data && pkt.data.chunk) {
                    content += pkt.data.chunk;
                    // Deltas, as the provider emitted them — a caller that wants
                    // to paint progressively accumulates.
                    if (onChunk) { try { onChunk(pkt.data.chunk); } catch (_) {} }
                } else if (pkt.event === 'complete') {
                    clearTimeout(timer);
                    settle(null, {
                        taskId: task_id,
                        content: pkt.data?.answer || pkt.data?.message || content,
                    });
                } else if (pkt.event === 'error') {
                    clearTimeout(timer);
                    settle(new Error(pkt.data?.error || 'Task failed'));
                }
            };
            ws.onerror = (e) => settle(new Error('WebSocket error: ' + (e.message || 'unknown')));
            ws.onclose = () => {
                if (!settled) settle(null, { taskId: task_id, content });
            };
        });
    }

    /**
     * Iterative-agent invocation. Returns immediately with a handle that exposes
     * the task ID, a `completed` promise, and an abort() function. Real-time
     * events flow through the provided callbacks.
     */
    invokeAgent({
        prompt,
        behavior,
        context,
        // Prior turns of THIS conversation, as [{role, content}, …].
        //
        // A first-class field rather than something stuffed into `context`: the
        // server has carried `chat_context` end to end all along (router.rs
        // CreateTaskRequest → RunTaskPayload → TaskBridge → AgentController's
        // own `chatContext` parameter), and a caller that buried history inside
        // the opaque `context` blob reached the agent as caller metadata — so a
        // multi-turn conversation arrived with no memory of its earlier turns
        // and no error anywhere to say so.
        chatContext = [],
        workspacePath = null,
        caller = null,
        onStep = null,       // (stepEvent) => void  — receives status/thought/tool_call events
        onConfirm = null,    // (req) => Promise<boolean | string>  — approval prompts
        onLog = null,        // (logEntry) => void  — CHAT/TOOL telemetry
    } = {}) {
        if (!prompt) throw new Error('JhAiClient.invokeAgent: prompt is required.');

        const finalBehavior = {
            mode: 'iterative_agent',
            ...behavior,
        };

        // We return synchronously-resolvable handle objects. The actual task
        // creation happens in a self-executing async block.
        let abortFn = () => {};
        const completed = (async () => {
            const { task_id } = await this._post('/tasks', {
                prompt,
                workspace_path: workspacePath,
                caller: caller,
                context: context !== undefined ? context : null,
                behavior: finalBehavior,
                // Omitted rather than sent empty: the server distinguishes "no
                // prior turns" from "an empty history".
                chat_context: Array.isArray(chatContext) && chatContext.length > 0
                    ? chatContext
                    : undefined,
            });

            return new Promise((resolve, reject) => {
                const wsUrl = `${this._wsBase()}/tasks/${task_id}?token=${this.token}`;
                const ws = new WebSocket(wsUrl);
                let settled = false;
                let lastMessage = '';

                abortFn = async () => {
                    if (settled) return;
                    try {
                        await fetch(`${this._baseUrl()}/tasks/${task_id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${this.token}` },
                        });
                    } catch (_) {}
                    try { ws.close(); } catch (_) {}
                };

                ws.onmessage = async (ev) => {
                    let pkt;
                    try { pkt = JSON.parse(ev.data); } catch (_) { return; }
                    if (!pkt) return;

                    // Notify caller about progress events
                    if (onStep && ['status', 'thought', 'tool_call', 'file_modified', 'stream'].includes(pkt.event)) {
                        try { onStep(pkt); } catch (_) {}
                    }
                    if (onLog && pkt.event === 'log') {
                        try { onLog(pkt.data); } catch (_) {}
                    }

                    // Approval requests need an answer back over WS
                    if (pkt.event === 'confirm_request' && onConfirm) {
                        try {
                            const answer = await onConfirm(pkt.data);
                            ws.send(JSON.stringify({
                                event: 'confirm_response',
                                data: {
                                    confirmId: pkt.data.confirmId,
                                    approved: answer === false ? false : true,
                                    modifiedContent: typeof answer === 'string' ? answer : null,
                                }
                            }));
                        } catch (_) {
                            ws.send(JSON.stringify({
                                event: 'confirm_response',
                                data: { confirmId: pkt.data.confirmId, approved: false }
                            }));
                        }
                    }

                    if (pkt.event === 'complete') {
                        settled = true;
                        try { ws.close(); } catch (_) {}
                        resolve({
                            taskId: task_id,
                            // `answer` is the deliverable; `message` is finish_task's
                            // one-line summary. Returning the summary is what showed
                            // the JHEditor chat a sentence ABOUT an answer instead of
                            // the answer.
                            content: pkt.data?.answer || pkt.data?.message || lastMessage,
                            modifiedFiles: pkt.data?.modifiedFiles || [],
                        });
                    } else if (pkt.event === 'error') {
                        settled = true;
                        try { ws.close(); } catch (_) {}
                        reject(new Error(pkt.data?.error || 'Agent task failed'));
                    } else if (pkt.event === 'stream' && pkt.data?.chunk) {
                        lastMessage += pkt.data.chunk;
                    }
                };
                ws.onerror = (e) => {
                    if (!settled) {
                        settled = true;
                        reject(new Error('WebSocket error: ' + (e.message || 'unknown')));
                    }
                };
                ws.onclose = () => {
                    if (!settled) {
                        settled = true;
                        resolve({ taskId: task_id, content: lastMessage, modifiedFiles: [] });
                    }
                };
            });
        })();

        return {
            get taskId() { return completed.then(r => r.taskId); },
            completed,
            abort: () => abortFn(),
        };
    }
}

export default JhAiClient;
