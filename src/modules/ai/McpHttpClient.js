import { invoke } from '@tauri-apps/api/core';

/**
 * McpHttpClient — MCP client for the outbound "Streamable HTTP" transport
 * (MCP spec 2025-03-26), connecting JHAI OUT to a remote MCP server.
 *
 * Mirrors the McpClient (stdio) public surface — `start()`, `tools`,
 * `callTool()`, `stop()`, `lastError`, `onLog` — so McpManager can treat both
 * transports uniformly. All JSON-RPC / session logic lives here in JS (same
 * design as the stdio client); the actual HTTP POST is delegated to the Rust
 * `mcp_http_send` bridge to avoid webview CORS limits.
 *
 * Config shape (see McpManager.startClient):
 *   {
 *     transport: 'http',
 *     url: 'https://example.com/mcp',           // required
 *     headers: { Authorization: 'Bearer …' },   // optional extra headers
 *   }
 *
 * Notes on the transport:
 *  - Every JSON-RPC message is sent as an HTTP POST with
 *    `Accept: application/json, text/event-stream`.
 *  - The server may answer either a single JSON object
 *    (`Content-Type: application/json`) or an SSE stream
 *    (`Content-Type: text/event-stream`). This client handles both; for SSE it
 *    reads `data:` lines and resolves the matching JSON-RPC response.
 *  - Stateful servers return an `mcp-session-id` header on `initialize`; it is
 *    captured and echoed back on subsequent requests.
 */
export class McpHttpClient {
    constructor(name, url, headers = {}) {
        this.name = name;
        this.url = url;
        this.headers = headers;
        this.requestId = 1;
        this.capabilities = null;
        this.tools = [];
        this.onLog = null;
        this.sessionId = null;
        this._stopped = false;
        // Diagnostics for startup-failure reporting (surfaced in the UI tooltip).
        this.lastError = null;
    }

    _buildHeaders() {
        const h = Object.entries(this.headers || {});
        if (this.sessionId) h.push(['Mcp-Session-Id', this.sessionId]);
        // Advertise the protocol revision we speak (helps servers that version).
        h.push(['MCP-Protocol-Version', '2025-03-26']);
        return h;
    }

    async start() {
        this._stopped = false;
        try {
            const initResult = await this.request('initialize', {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'JHAiAgent', version: '0.1.0' }
            });
            this.capabilities = initResult.capabilities;
            await this.notification('notifications/initialized', {});

            const toolsResult = await this.request('tools/list', {});
            this.tools = toolsResult.tools || [];
            this.lastError = null;
            return true;
        } catch (e) {
            const stage = this.capabilities ? 'tools/list' : 'connect/handshake';
            this.lastError = {
                message: `[${stage}] ${e?.message || e}\n\nURL: ${this.url}`,
                stage,
                at: new Date().toISOString(),
            };
            console.error(`Failed to start MCP(HTTP) server "${this.name}":`, this.lastError.message);
            return false;
        }
    }

    /**
     * Send one JSON-RPC request and await its result.
     * Handles both plain-JSON and SSE responses.
     */
    async request(method, params, timeoutMs = 30000) {
        const id = this.requestId++;
        const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const resp = await this._post(msg, timeoutMs);
        return this._extractResult(resp, id, method);
    }

    /** Notifications have no id; the server may reply 202 with an empty body. */
    async notification(method, params) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        await this._post(msg, 15000);
    }

    async callTool(name, arguments_ = {}, meta = null) {
        const params = { name, arguments: arguments_ };
        if (meta) params._meta = meta;
        return this.request('tools/call', params);
    }

    async stop() {
        this._stopped = true;
        // Stateless HTTP: nothing to tear down locally. Best-effort session
        // termination for stateful servers is intentionally omitted (DELETE is
        // optional in the spec and not all servers implement it).
        this.sessionId = null;
    }

    // ── internal ────────────────────────────────────────────────────────────

    async _post(body, timeoutMs) {
        const invokePromise = invoke('mcp_http_send', {
            url: this.url,
            body,
            headers: this._buildHeaders(),
        });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`MCP(HTTP) request timed out on "${this.name}"`)), timeoutMs)
        );
        const resp = await Promise.race([invokePromise, timeoutPromise]);
        if (resp && resp.session_id) this.sessionId = resp.session_id;
        return resp;
    }

    /**
     * Parse the bridge response ({status, content_type, body}) and return the
     * JSON-RPC result for `id`. Throws on HTTP error / JSON-RPC error / timeout.
     */
    _extractResult(resp, id, method) {
        if (!resp) throw new Error(`MCP(HTTP) "${this.name}" returned no response`);
        if (resp.status === 202) return {}; // accepted, no body (notifications)
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`MCP(HTTP) "${this.name}" HTTP ${resp.status}: ${String(resp.body).slice(0, 300)}`);
        }

        const ct = String(resp.content_type || '');
        const body = String(resp.body || '');

        if (ct.includes('text/event-stream')) {
            // Collect JSON-RPC messages from `data:` lines; find our response id.
            const messages = [];
            for (const line of body.split(/\r?\n/)) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try { messages.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
            }
            const match = messages.find(m => m.id === id);
            if (!match) throw new Error(`MCP(HTTP) "${this.name}" SSE: no response for id ${id} (${method})`);
            if (match.error) throw new Error(match.error.message || JSON.stringify(match.error));
            return match.result;
        }

        // Default: application/json — single JSON-RPC response object.
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            throw new Error(`MCP(HTTP) "${this.name}" returned non-JSON body (${ct}): ${body.slice(0, 200)}`);
        }
        if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        return parsed.result;
    }
}
