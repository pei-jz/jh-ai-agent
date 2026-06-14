// jhai-adapter — client SDK for the JHAI "AI Hub" (Part B).
//
// An app (JHEditor/JHER/JHWBSManager) imports this, declares its TOOLS / INTENTS
// / CONTEXT / RESULT renderers, and calls start(). The SDK:
//   • dials JHAI's `ws://<jhai>/mcp/ws?app=<name>&token=…` (outbound; connection
//     = dynamic registration) and acts as the MCP SERVER over it — answering
//     initialize / tools/list / tools/call from registered handlers.
//   • runIntent()/chat() create a task (POST /api/tasks) scoped to this app and
//     subscribe to the task WS, dispatching the final `result` envelope to the
//     registered renderer (and exposing apply-actions).
//
// Transport is hidden (Part A / T1 outbound WS). Dependency-free: uses standard
// WebSocket + fetch (injectable for tests). MCP semantics throughout.
//
// See docs/design/ai-hub-client-adapter-sdk.md.

export function createJhaiAdapter(options = {}) {
    return new JhaiAdapter(options);
}

function httpToWs(url) {
    return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

class JhaiAdapter {
    /**
     * @param {object} opts
     * @param {string} opts.app           server name (scopes behavior.mcp_servers)
     * @param {string} opts.jhaiBaseUrl   e.g. "http://127.0.0.1:8123"
     * @param {string} opts.authToken     JHAI connection token (shared secret)
     * @param {function} [opts.WebSocketImpl]  WebSocket ctor (default globalThis.WebSocket)
     * @param {function} [opts.fetchImpl]      fetch fn (default globalThis.fetch)
     * @param {object}   [opts.serverInfo]     { name, version }
     */
    constructor(opts) {
        if (!opts.app) throw new Error('createJhaiAdapter: `app` is required');
        if (!opts.jhaiBaseUrl) throw new Error('createJhaiAdapter: `jhaiBaseUrl` is required');
        this.app = opts.app;
        this.baseUrl = opts.jhaiBaseUrl.replace(/\/+$/, '');
        this.token = opts.authToken || '';
        this._WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
        this.serverInfo = opts.serverInfo || { name: opts.app, version: '0.1.0' };
        this.protocolVersion = '2024-11-05';

        this.tools = new Map();          // name → { def, handler }
        this.intents = new Map();        // id → intent object
        this.contextProvider = null;
        this.resultRenderers = new Map();// kind → fn(payload, actions, envelope)
        this.actionHandlers = new Map(); // type → fn(apply)

        this._ws = null;
        this._stopped = false;
        this._reconnectMs = 1000;
        this.onLog = null;
    }

    // ── Declarations ────────────────────────────────────────────────────────

    /** Register a tool. handler(args, ctx) → string | { content:[{type:'text',text}] }. */
    registerTool({ name, description = '', inputSchema, handler }) {
        if (!name || typeof handler !== 'function') {
            throw new Error('registerTool requires { name, handler }');
        }
        const schema = inputSchema || { type: 'object', properties: {}, required: [], additionalProperties: false };
        this.tools.set(name, { def: { name, description, inputSchema: schema }, handler });
        return this;
    }

    /** Register a named AI action. { id, title?, systemPrompt?, tools?[], resultKind? }. */
    registerIntent(intent) {
        if (!intent || !intent.id) throw new Error('registerIntent requires { id }');
        this.intents.set(intent.id, intent);
        return this;
    }

    /** Provide live context (e.g. () => ({ app, windowId, documentId })). */
    setContextProvider(fn) { this.contextProvider = fn; return this; }

    /** Renderer for a result kind: fn(payload, actions, envelope). */
    onResult(kind, fn) { this.resultRenderers.set(kind, fn); return this; }

    /** Handler that applies an action of `type`: fn(apply). */
    registerActionHandler(type, fn) { this.actionHandlers.set(type, fn); return this; }

    /** Apply an action object ({ label, apply:{ type, ... } }) via its handler. */
    applyAction(action) {
        const apply = action && action.apply ? action.apply : action;
        const fn = apply && this.actionHandlers.get(apply.type);
        if (fn) return fn(apply);
        this._log(`No action handler for type "${apply && apply.type}"`);
        return undefined;
    }

    // ── Connection (MCP server role over outbound WS) ────────────────────────

    async start() {
        if (!this._WS) throw new Error('No WebSocket implementation available');
        this._stopped = false;
        this._connect();
        return this;
    }

    stop() {
        this._stopped = true;
        if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
    }

    _wsUrl() {
        const base = httpToWs(this.baseUrl);
        const q = `app=${encodeURIComponent(this.app)}&token=${encodeURIComponent(this.token)}`;
        return `${base}/mcp/ws?${q}`;
    }

    _connect() {
        const ws = new this._WS(this._wsUrl());
        this._ws = ws;
        ws.onmessage = (ev) => this._onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
        ws.onclose = () => {
            this._ws = null;
            if (!this._stopped) {
                const delay = this._reconnectMs;
                this._reconnectMs = Math.min(this._reconnectMs * 2, 15000);
                setTimeout(() => { if (!this._stopped) this._connect(); }, delay);
            }
        };
        ws.onopen = () => { this._reconnectMs = 1000; this._log(`MCP WS connected as "${this.app}"`); };
        ws.onerror = (e) => this._log(`MCP WS error: ${e && e.message ? e.message : e}`);
    }

    _send(obj) {
        if (this._ws && this._ws.readyState === 1) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    /** Handle one inbound JSON-RPC frame (JHAI = MCP client). */
    async _onFrame(text) {
        let msg;
        try { msg = JSON.parse(String(text).trim()); } catch { return; }
        if (!msg || msg.jsonrpc !== '2.0') return;

        // Notifications (no id) — ignore (e.g. notifications/initialized).
        if (msg.id === undefined || msg.id === null) return;

        try {
            const result = await this._handleRpc(msg.method, msg.params || {});
            this._send({ jsonrpc: '2.0', id: msg.id, result });
        } catch (e) {
            this._send({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: e && e.message ? e.message : String(e) },
            });
        }
    }

    async _handleRpc(method, params) {
        switch (method) {
            case 'initialize':
                return {
                    protocolVersion: this.protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: this.serverInfo,
                };
            case 'tools/list':
                return { tools: [...this.tools.values()].map(t => t.def) };
            case 'tools/call': {
                const entry = this.tools.get(params.name);
                if (!entry) throw new Error(`Unknown tool: ${params.name}`);
                const ctx = (params._meta && params._meta.jhai) ? params._meta.jhai : {};
                const out = await entry.handler(params.arguments || {}, ctx);
                return this._normalizeToolResult(out);
            }
            default:
                throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
        }
    }

    _normalizeToolResult(out) {
        if (out && typeof out === 'object' && Array.isArray(out.content)) return out;
        const text = typeof out === 'string' ? out : JSON.stringify(out ?? null);
        return { content: [{ type: 'text', text }] };
    }

    // ── Running tasks (intent / freeform) + result handling ──────────────────

    /** Run a registered intent. Returns a promise that resolves with the result envelope (or null). */
    async runIntent(intentId, { prompt, context, images } = {}) {
        return this.runIntentTask(intentId, { prompt, context, images }).completed;
    }

    /** Freeform chat (no intent), still scoped to this app's tools + context. */
    async chat(prompt, { context, images } = {}) {
        return this.chatTask(prompt, { context, images }).completed;
    }

    /**
     * Run a registered intent as a streaming task handle.
     * @returns {{ taskId: Promise<string>, completed: Promise<object|null>, abort: function }}
     *   - taskId   resolves with the server task id once created
     *   - completed resolves with the final result envelope (or null)
     *   - abort()  cancels the task (DELETE /api/tasks/:id) + closes the WS
     *   onEvent(event, data) (if provided) receives EVERY task event
     *   (status / thought / tool_call / stream / result / complete / error).
     */
    runIntentTask(intentId, { prompt, context, images, onEvent } = {}) {
        const intent = this.intents.get(intentId);
        if (!intent) throw new Error(`Unknown intent: ${intentId}`);
        const inline = {
            systemPrompt: intent.systemPrompt,
            tools: intent.tools,
            resultKind: intent.resultKind,
            tier: intent.tier,
        };
        return this._runTask(prompt || intent.title || intentId, { intent: inline, context, images, onEvent });
    }

    /** Freeform task handle (no intent). Same shape as runIntentTask. */
    chatTask(prompt, { context, images, onEvent } = {}) {
        return this._runTask(prompt, { context, images, onEvent });
    }

    _runTask(prompt, { intent = null, context, images, onEvent } = {}) {
        let abortFn = () => {};
        let resolveTid;
        const taskId = new Promise((r) => { resolveTid = r; });
        const completed = (async () => {
            const tid = await this._createTask(prompt, { intent, context, images });
            resolveTid(tid);
            const handle = this._subscribeTaskHandle(tid, onEvent);
            abortFn = handle.abort;
            return handle.completed;
        })();
        // Swallow unhandled rejection if the caller only uses the handle's completed.
        taskId.catch(() => {});
        return { taskId, completed, abort: () => abortFn() };
    }

    async _createTask(prompt, { intent = null, context, images } = {}) {
        if (!this._fetch) throw new Error('No fetch implementation available');
        const mcpContext = context || (this.contextProvider ? this.contextProvider() : null);
        const behavior = { mcp_servers: [this.app] };
        if (intent) behavior.intent = intent;
        if (mcpContext) behavior.mcp_context = mcpContext;

        // First-class image channel. Images MUST be base64 data URLs
        // ("data:image/png;base64,…"); they're forwarded to the agent's LLM call
        // (re-attached for the first several steps). Sent at the top level — the
        // server reads `images` first, then falls back to behavior.mcp_context.images.
        const reqBody = { prompt, caller: this.app, behavior };
        if (Array.isArray(images) && images.length) reqBody.images = images;

        const res = await this._fetch(`${this.baseUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
            body: JSON.stringify(reqBody),
        });
        if (!res.ok) throw new Error(`Task create failed: HTTP ${res.status}`);
        const body = await res.json();
        const taskId = body.task_id || body.taskId;
        if (!taskId) throw new Error('Task create returned no task_id');
        return taskId;
    }

    /** Cancel a running task on the server. */
    async abortTask(taskId) {
        if (!this._fetch || !taskId) return;
        try {
            await this._fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` },
            });
        } catch (_) { /* best effort */ }
    }

    /**
     * Subscribe to a task's WS. Forwards every event to onEvent, dispatches
     * `result` to renderers, resolves on terminal event. Returns { completed, abort }.
     */
    _subscribeTaskHandle(taskId, onEvent) {
        let innerAbort = () => this.abortTask(taskId);
        const completed = new Promise((resolve, reject) => {
            const base = httpToWs(this.baseUrl);
            const url = `${base}/ws/tasks/${encodeURIComponent(taskId)}?token=${encodeURIComponent(this.token)}`;
            const ws = new this._WS(url);
            let lastEnvelope = null;
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} fn(v); } };

            innerAbort = () => { this.abortTask(taskId); done(resolve, lastEnvelope); };

            ws.onmessage = (ev) => {
                let packet;
                try { packet = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
                const event = packet.event;
                const data = packet.data || {};
                if (onEvent) { try { onEvent(event, data); } catch (_) {} }
                if (event === 'result' && data.envelope) {
                    lastEnvelope = data.envelope;
                    this._dispatchResult(data.envelope);
                } else if (event === 'complete') {
                    const finalEnv = lastEnvelope || { kind: 'markdown', summary: data.summary, payload: { md: data.summary || '' } };
                    done(resolve, finalEnv);
                } else if (event === 'error') {
                    done(reject, new Error(data.error || 'task error'));
                }
            };
            ws.onclose = () => done(resolve, lastEnvelope);
            ws.onerror = () => { /* let onclose settle */ };
        });
        return { completed, abort: () => innerAbort() };
    }

    _dispatchResult(envelope) {
        const fn = this.resultRenderers.get(envelope.kind);
        if (fn) {
            try { fn(envelope.payload, envelope.actions || [], envelope); }
            catch (e) { this._log(`result renderer error: ${e && e.message}`); }
        } else {
            this._log(`No renderer for result kind "${envelope.kind}"`);
        }
    }

    _log(m) { if (this.onLog) this.onLog(`[jhai-adapter] ${m}`); }
}
