/**
 * @jh/ai-client — minimal client library for invoking JH AI Agent
 * from sibling JH applications (JHEditor, JHER, JH Task Manager, …).
 *
 * Design goals:
 *   • Zero hard-coded profile names — caller fully owns the "behavior" object.
 *   • Auto-discovers connection settings via the standard config path that
 *     JH AI Agent writes when the user clicks "Export Connection".
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
 *   client.invokeAgent({prompt, behavior, context, onStep, onConfirm, onLog})
 *     → { taskId, completed: Promise<{ content, modifiedFiles }>, abort() }
 *     Use for long-running iterative_agent work (refactoring, multi-step tasks).
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
 *   }
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 14300;

/**
 * Resolve the standard JH config path for the current platform.
 * Falls back to a local file lookup pattern that callers can override.
 */
function defaultConfigPath() {
    // Browser / WebView contexts don't have process.env or path APIs, so
    // the caller is expected to either pass settings explicitly or use the
    // Tauri/Electron host's file APIs to read this path themselves.
    // We surface the conventional paths as a constant so callers can use them.
    return {
        windows: '%APPDATA%/JH/ai-connection.json',
        macos:   '$HOME/Library/Application Support/JH/ai-connection.json',
        linux:   '${XDG_CONFIG_HOME:-$HOME/.config}/JH/ai-connection.json',
    };
}

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
        this.token = options.token || null;
        this._readConfigFile = options.readConfigFile || null;
        this._configLoaded = !!(options.host && options.port && options.token);
    }

    /**
     * Load settings from the standard config path if they weren't supplied
     * to the constructor. Call this before invoke() / invokeAgent() — or
     * just call invoke() directly; it will auto-load on first use.
     */
    async ready() {
        if (this._configLoaded) return;
        if (!this._readConfigFile) {
            throw new Error(
                'JhAiClient: no host/port/token provided and no readConfigFile function. ' +
                'Either pass {host, port, token} to the constructor, or supply ' +
                'readConfigFile to load the standard JH connection config file.'
            );
        }
        // Try platform-specific paths. The caller's readConfigFile is expected
        // to expand environment variables and return null/throw on missing files.
        const candidates = [
            '%APPDATA%/JH/ai-connection.json',
            '$HOME/Library/Application Support/JH/ai-connection.json',
            '$HOME/.config/JH/ai-connection.json',
        ];
        let lastErr = null;
        for (const path of candidates) {
            try {
                const raw = await this._readConfigFile(path);
                if (!raw) continue;
                const cfg = JSON.parse(raw);
                if (cfg && cfg.token && cfg.port) {
                    this.host = cfg.host || DEFAULT_HOST;
                    this.port = cfg.port;
                    this.token = cfg.token;
                    this._configLoaded = true;
                    return;
                }
            } catch (e) {
                lastErr = e;
                continue;
            }
        }
        throw new Error(
            'JhAiClient: could not auto-discover JH AI Agent connection settings. ' +
            'Open JH AI Agent → Settings → General and click "Export Connection". ' +
            (lastErr ? `(last error: ${lastErr.message || lastErr})` : '')
        );
    }

    _baseUrl() { return `http://${this.host}:${this.port}/api`; }
    _wsBase()  { return `ws://${this.host}:${this.port}/ws`; }

    async _post(path, body) {
        await this.ready();
        const res = await fetch(this._baseUrl() + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return res.json();
    }

    /**
     * Single-shot invocation. Resolves with the final text response.
     * Use for "give me a SQL query", "suggest FKs", "summarize this".
     */
    async invoke({ prompt, behavior, context, caller, timeoutMs = 120000 } = {}) {
        if (!prompt) throw new Error('JhAiClient.invoke: prompt is required.');
        const finalBehavior = {
            mode: 'single_shot',
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
                } else if (pkt.event === 'complete') {
                    clearTimeout(timer);
                    settle(null, {
                        taskId: task_id,
                        content: pkt.data?.message || content,
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
                            content: pkt.data?.message || lastMessage,
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

export { defaultConfigPath };
export default JhAiClient;
