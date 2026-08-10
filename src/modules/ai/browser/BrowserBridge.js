import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * BrowserBridge — drives the Playwright worker (worker.mjs) over the Rust
 * stdio process bridge (mcp_spawn / mcp_write / mcp_kill), speaking the same
 * line-oriented JSON-RPC protocol the worker implements.
 *
 * This mirrors how McpClient talks to stdio MCP servers, so no new Rust code
 * is required: we reuse the existing process-management commands. The bridge
 * is a lazy singleton — the worker is spawned on first use and reused across
 * calls within the app session.
 *
 * Graceful degradation: if the worker can't start (node missing, or Playwright
 * not installed), calls reject with a clear, actionable error instead of
 * crashing the agent.
 */
class BrowserBridge {
    constructor() {
        this.processId = null;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this._lineBuffer = '';
        this._unlisteners = [];
        this._starting = null;   // in-flight start promise (dedupe concurrent starts)
        this._available = null;  // cached availability probe result
    }

    /**
     * Resolve the on-disk path to the Playwright worker script. The worker
     * source is embedded in the Rust binary and materialised under the app
     * config dir by the `browser_worker_path` command, so it survives bundling
     * (import.meta.url would point inside the Vite bundle, not a real file).
     */
    async _workerInfo() {
        if (this._cachedWorkerInfo) return this._cachedWorkerInfo;
        // Rust returns { path, playwright_base }. Tolerate a legacy string return.
        const info = await invoke('browser_worker_path');
        this._cachedWorkerInfo = (typeof info === 'string')
            ? { path: info, playwright_base: null }
            : info;
        return this._cachedWorkerInfo;
    }

    /** Spawn the worker if not already running. Returns true when ready. */
    async _ensureStarted() {
        if (this.processId) return true;
        if (this._starting) return this._starting;
        this._starting = this._doStart().finally(() => { this._starting = null; });
        return this._starting;
    }

    async _doStart() {
        this.processId = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        this._lineBuffer = '';

        const stdoutUn = await listen(`mcp-stdout-${this.processId}`, (event) => {
            const line = event.payload;
            if (typeof line === 'string') this._handleLine(line);
        });
        const stderrUn = await listen(`mcp-stderr-${this.processId}`, (event) => {
            // Surface worker stderr (e.g. the "playwright not installed" hint).
            console.warn('[browser]', event.payload);
        });
        const exitUn = await listen(`mcp-exit-${this.processId}`, () => {
            this._teardown();
        });
        this._unlisteners = [stdoutUn, stderrUn, exitUn];

        try {
            const { path: workerPath, playwright_base: base } = await this._workerInfo();
            // Pass the resolved base so the worker's createRequire can find the
            // `playwright` package despite running from the config dir.
            const env = base ? { JHAI_PLAYWRIGHT_BASE: base } : {};
            await invoke('mcp_spawn', {
                processId: this.processId,
                command: 'node',
                args: [workerPath],
                env,
            });
            return true;
        } catch (e) {
            this._teardown();
            throw new Error(
                `Failed to start browser worker: ${e?.message || e}. ` +
                `Ensure Node.js is installed and on PATH.`
            );
        }
    }

    _teardown() {
        for (const fn of this._unlisteners) { try { fn(); } catch (_) {} }
        this._unlisteners = [];
        // Reject any in-flight requests — the worker is gone.
        for (const [, p] of this.pendingRequests) {
            try { p.reject(new Error('browser worker exited')); } catch (_) {}
        }
        this.pendingRequests.clear();
        this.processId = null;
    }

    _handleLine(line) {
        const t = line.trim();
        if (!t) return;
        let msg;
        try { msg = JSON.parse(t); } catch (_) { return; }
        if (msg.id === undefined) return;
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) return;
        this.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || String(msg.error)));
        else pending.resolve(msg.result);
    }

    /**
     * Send one JSON-RPC request to the worker and await its result.
     * Lazily starts the worker on first call.
     */
    async request(method, params = {}, timeoutMs = 30000) {
        await this._ensureStarted();
        const id = this.requestId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`browser request timed out (${method})`));
            }, timeoutMs);
            this.pendingRequests.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            const msg = JSON.stringify({ id, method, params });
            invoke('mcp_write', { processId: this.processId, data: msg + '\n' }).catch(e => {
                this.pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`browser write failed: ${e}`));
            });
        });
    }

    /** Kill the worker process (best-effort). */
    async stop() {
        if (!this.processId) return;
        try { await invoke('mcp_kill', { processId: this.processId }); } catch (_) {}
        this._teardown();
    }
}

export const browserBridge = new BrowserBridge();
