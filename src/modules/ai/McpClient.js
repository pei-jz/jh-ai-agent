import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * McpClient handles communication with an MCP server over stdio.
 *
 * Uses custom Rust commands (mcp_spawn / mcp_write / mcp_kill) instead of
 * the tauri-plugin-shell API, which requires an explicit command scope
 * whitelist. The Rust side spawns any executable without restrictions.
 *
 * Auto-restarts the server process up to 3 times on unexpected exit.
 *
 * Fix notes:
 *   - _restartCount is reset to 0 after each successful connection so that
 *     transient crashes don't permanently exhaust the restart budget.
 *   - pendingRequests are rejected (not leaked) before every restart and in stop().
 */
export class McpClient {
    constructor(name, command, args = [], env = {}) {
        this.name = name;
        this.command = command;
        this.args = args;
        this.env = env;
        this.processId = null;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.capabilities = null;
        this.tools = [];
        this.onLog = null;
        this._lineBuffer = '';
        this._stopped = false;
        this._restartCount = 0;
        this._unlisteners = [];
    }

    async start() {
        this._stopped = false;
        this._restartCount = 0;
        return this._doStart();
    }

    /** Reject every in-flight request with the given reason. */
    _rejectAllPending(reason) {
        for (const [, pending] of this.pendingRequests) {
            try { pending.reject(new Error(reason)); } catch (_) {}
        }
        this.pendingRequests.clear();
    }

    async _doStart() {
        // Reject any requests that were in-flight on the previous process —
        // their response can never arrive now that we're restarting.
        this._rejectAllPending(`MCP server "${this.name}" restarted — request cancelled`);

        // Clean up any previous Tauri event listeners
        for (const fn_ of this._unlisteners) {
            try { fn_(); } catch (_) {}
        }
        this._unlisteners = [];
        this._lineBuffer = '';

        this.processId = `mcp_${this.name}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        try {
            // Register stdout listener BEFORE spawning to avoid missing early lines
            const stdoutUnlisten = await listen(`mcp-stdout-${this.processId}`, (event) => {
                const line = event.payload;
                if (typeof line === 'string' && line.trim()) {
                    this.handleMessage(line.trim());
                }
            });
            this._unlisteners.push(stdoutUnlisten);

            const stderrUnlisten = await listen(`mcp-stderr-${this.processId}`, (event) => {
                if (this.onLog) this.onLog(`[${this.name}] ${event.payload}`);
            });
            this._unlisteners.push(stderrUnlisten);

            const exitUnlisten = await listen(`mcp-exit-${this.processId}`, async (event) => {
                if (this._stopped) return;
                const code = event.payload;
                if (this._restartCount < 3) {
                    this._restartCount++;
                    const delay = 2000 * this._restartCount;
                    console.warn(`[MCP] "${this.name}" exited (code ${code}), restarting in ${delay}ms (attempt ${this._restartCount}/3)...`);
                    if (this.onLog) this.onLog(`[${this.name}] プロセスが終了しました。${delay}ms後に再起動します...`);
                    await new Promise(r => setTimeout(r, delay));
                    if (!this._stopped) {
                        try { await this._doStart(); } catch (e) {
                            console.error(`[MCP] Failed to restart "${this.name}":`, e);
                        }
                    }
                } else {
                    console.error(`[MCP] "${this.name}" crashed ${this._restartCount} times, giving up.`);
                    if (this.onLog) this.onLog(`[${this.name}] 3回再起動を試みましたが失敗しました。`);
                }
            });
            this._unlisteners.push(exitUnlisten);

            // Spawn the process via custom Rust command (no shell plugin scope limits)
            await invoke('mcp_spawn', {
                processId: this.processId,
                command: this.command,
                args: this.args,
                env: this.env || {},
            });

            // MCP handshake
            const initResult = await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'JHAiAgent', version: '0.1.0' }
            });
            this.capabilities = initResult.capabilities;
            await this.notification('notifications/initialized', {});

            // Discover tools
            const toolsResult = await this.request('tools/list', {});
            this.tools = toolsResult.tools || [];

            // ── Successful connection: reset restart counter so a later crash gets
            // the full 3-attempt budget again, not the remnant from this restart.
            this._restartCount = 0;

            return true;
        } catch (e) {
            console.error(`Failed to start MCP server "${this.name}":`, e);
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
                    if (msg.error) {
                        pending.reject(msg.error);
                    } else {
                        pending.resolve(msg.result);
                    }
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
                reject(new Error(`MCP request timed out (${method}) on server "${this.name}"`));
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
            invoke('mcp_write', { processId: this.processId, data: msg + '\n' }).catch(e => {
                this.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`MCP write failed: ${e}`));
            });
        });
    }

    async notification(method, params) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        await invoke('mcp_write', { processId: this.processId, data: msg + '\n' });
    }

    async callTool(name, arguments_ = {}) {
        return this.request('tools/call', { name, arguments: arguments_ });
    }

    async stop() {
        this._stopped = true;

        // Unregister Tauri event listeners
        for (const fn_ of this._unlisteners) {
            try { fn_(); } catch (_) {}
        }
        this._unlisteners = [];

        // Reject all in-flight requests — the process is going away.
        this._rejectAllPending(`MCP server "${this.name}" stopped`);

        if (this.processId) {
            try { await invoke('mcp_kill', { processId: this.processId }); } catch (_) {}
            this.processId = null;
        }
    }
}
