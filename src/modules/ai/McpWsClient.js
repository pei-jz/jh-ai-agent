import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * McpWsClient — MCP client over an INBOUND WebSocket (Part A / T1).
 *
 * An external app dialed JHAI's `/mcp/ws?app=<name>` and acts as the MCP SERVER
 * (tool provider); this class is the MCP CLIENT for that connection. The raw
 * frames are bridged through Rust (server/mcp_ws.rs):
 *   • incoming app→JHAI frames arrive as `mcp-ws-recv-{connId}` Tauri events
 *   • outgoing JHAI→app frames are sent via the `mcp_ws_send` command
 *   • `mcp-ws-closed-{connId}` signals the app disconnected
 *
 * Public interface mirrors McpClient (name / tools / callTool / stop / onLog)
 * so McpManager can treat stdio and WS servers polymorphically
 * (getAllTools / callTool need no changes). The JSON-RPC framing is duplicated
 * here intentionally to avoid touching the battle-tested stdio McpClient; a
 * future cleanup may hoist a shared JSON-RPC base.
 *
 * Unlike stdio there is NO auto-restart: if the socket closes, the app is gone
 * and will re-dial (which creates a fresh client via McpManager).
 */
export class McpWsClient {
    constructor(name, connId) {
        this.name = name;
        this.connId = connId;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.capabilities = null;
        this.tools = [];
        this.onLog = null;
        this.onClosed = null;          // McpManager sets this to deregister
        this._stopped = false;
        this._unlisteners = [];
        this.lastError = null;
    }

    _rejectAllPending(reason) {
        for (const [, pending] of this.pendingRequests) {
            try { pending.reject(new Error(reason)); } catch (_) {}
        }
        this.pendingRequests.clear();
    }

    async start() {
        this._stopped = false;
        try {
            // Wire incoming frames + close BEFORE the handshake so no early
            // response is missed.
            const recvUnlisten = await listen(`mcp-ws-recv-${this.connId}`, (event) => {
                const line = event.payload;
                if (typeof line === 'string' && line.trim()) {
                    this.handleMessage(line.trim());
                }
            });
            this._unlisteners.push(recvUnlisten);

            const closeUnlisten = await listen(`mcp-ws-closed-${this.connId}`, () => {
                if (this._stopped) return;
                this._rejectAllPending(`MCP WS server "${this.name}" disconnected`);
                if (this.onClosed) { try { this.onClosed(); } catch (_) {} }
            });
            this._unlisteners.push(closeUnlisten);

            // MCP handshake (JHAI = client role).
            const initResult = await this.request('initialize', {
                protocolVersion: '2024-11-05',
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
            this.lastError = {
                message: `[mcp-ws] ${e && e.message ? e.message : String(e)}`,
                stage: this.capabilities ? 'tools/list' : 'handshake',
                at: new Date().toISOString(),
            };
            console.error(`Failed to start MCP WS client "${this.name}":`, this.lastError.message);
            return false;
        }
    }

    handleMessage(line) {
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined) {
                const pending = this.pendingRequests.get(msg.id);
                if (pending) {
                    this.pendingRequests.delete(msg.id);
                    if (msg.error) pending.reject(msg.error);
                    else pending.resolve(msg.result);
                }
            } else if (msg.method === 'notifications/message') {
                if (this.onLog) this.onLog(`[${this.name}] ${msg.params?.text}`);
            }
        } catch (_) {
            // Ignore malformed lines
        }
    }

    request(method, params, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const id = this.requestId++;
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`MCP request timed out (${method}) on WS server "${this.name}"`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e && typeof e === 'object'
                        ? new Error(e.message || JSON.stringify(e))
                        : new Error(String(e)));
                }
            });

            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            invoke('mcp_ws_send', { connId: this.connId, data: msg + '\n' }).catch(e => {
                this.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`MCP WS send failed: ${e}`));
            });
        });
    }

    async notification(method, params) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        await invoke('mcp_ws_send', { connId: this.connId, data: msg + '\n' });
    }

    async callTool(name, arguments_ = {}, meta = null) {
        const params = { name, arguments: arguments_ };
        if (meta) params._meta = meta;   // per-task context (Part A / Phase 2)
        return this.request('tools/call', params);
    }

    async stop() {
        this._stopped = true;
        for (const fn_ of this._unlisteners) {
            try { fn_(); } catch (_) {}
        }
        this._unlisteners = [];
        this._rejectAllPending(`MCP WS server "${this.name}" stopped`);
        try { await invoke('mcp_ws_close', { connId: this.connId }); } catch (_) {}
    }
}
