import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { McpClient } from './McpClient.js';
import { McpWsClient } from './McpWsClient.js';
import { McpHttpClient } from './McpHttpClient.js';
import { intentRegistry } from './agent/IntentRegistry.js';
import { resourceRegistry, resolveResource, contentsToText } from './agent/ResourceRegistry.js';

export class McpManager {
    constructor() {
        /**
         * Notified whenever the set of connected apps changes. The Task view's
         * "connected apps" strip used to redraw only when the task did, so an
         * app that connected or dropped mid-run left a stale strip behind.
         * @type {Set<Function>}
         */
        this._watchers = new Set();
        this.clients = new Map();
        this.serversConfig = { mcpServers: {} };
        // name -> { message, stage, at } for servers that failed to start.
        this.startErrors = new Map();
        // Set once we've subscribed to inbound MCP-WS connections (T1).
        this._wsListenerReady = false;
    }

    /**
     * Subscribe to connection changes.
     * @param {Function} fn
     * @returns {Function} unsubscribe
     */
    onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        this._watchers.add(fn);
        return () => this._watchers.delete(fn);
    }

    /** Tell the watchers. A throwing watcher must not break a connection. */
    _notify() {
        for (const fn of this._watchers) {
            try { fn(); } catch (e) { console.warn('MCP change watcher failed:', e); }
        }
    }

    /** Returns the recorded startup error for a server, or null. */
    getError(name) {
        return this.startErrors.get(name) || null;
    }

    async init() {
        await this.loadConfig();
        await this.startAll();
        await this.listenForWsServers();
    }

    /**
     * Subscribe to inbound MCP-over-WebSocket connections (Part A / T1).
     * When an external app dials JHAI's `/mcp/ws?app=<name>`, the Rust bridge
     * emits `mcp-ws-connected` { app, connId }; we build an McpWsClient for it
     * (acting as the MCP client) and register it under the app name — so its
     * tools flow through getAllTools()/callTool() exactly like a stdio server.
     */
    async listenForWsServers() {
        if (this._wsListenerReady) return;
        this._wsListenerReady = true;
        await listen('mcp-ws-connected', async (event) => {
            const { app, connId } = event.payload || {};
            if (!app || !connId) return;
            await this.connectWsServer(app, connId);
        });
    }

    /** Build + handshake an McpWsClient for a freshly-connected app. */
    async connectWsServer(name, connId) {
        // If a previous connection for this app exists, retire it first.
        const existing = this.clients.get(name);
        if (existing) {
            try { await existing.stop(); } catch (_) {}
        }
        const client = new McpWsClient(name, connId);
        client.onClosed = () => {
            // Only drop if this exact connection is still the registered one.
            if (this.clients.get(name) === client) {
                this.clients.delete(name);
                intentRegistry.clearApp(name);
                resourceRegistry.clearApp(name);
                this._notify();
            }
        };
        const success = await client.start();
        if (success) {
            this.clients.set(name, client);
            // Named actions this app exposes — referenced later by id from
            // behavior.intent. Re-registering replaces the previous set.
            intentRegistry.setForApp(name, client.intents || []);
            resourceRegistry.setForApp(name, client.resources || []);
            this.startErrors.delete(name);
            this._notify();
        } else {
            this.startErrors.set(name, client.lastError || {
                message: `MCP(WS) サーバー "${name}" のハンドシェイクに失敗しました。`,
                stage: 'handshake',
                at: new Date().toISOString(),
            });
        }
        return success;
    }

    async loadConfig() {
        try {
            // Load config from Rust backend (which stores MCP config centrally)
            const config = await invoke('get_ai_config');
            if (config && config.mcp_servers) {
                // If it's a string, parse it, otherwise assign directly
                let mcp = typeof config.mcp_servers === 'string'
                    ? JSON.parse(config.mcp_servers)
                    : config.mcp_servers;

                // Defensive: handle the { mcpServers: {...} } wrapper that some users
                // enter by mistake (matching Claude Desktop's config format).
                if (mcp && mcp.mcpServers && typeof mcp.mcpServers === 'object' && !Array.isArray(mcp.mcpServers)) {
                    mcp = mcp.mcpServers;
                }

                this.serversConfig = { mcpServers: mcp || {} };
            } else {
                this.serversConfig = { mcpServers: {} };
            }
        } catch (e) {
            console.warn("Failed to load MCP config from central config:", e);
            this.serversConfig = { mcpServers: {} };
        }
    }

    async saveConfig() {
        try {
            const config = await invoke('get_ai_config');
            config.mcp_servers = this.serversConfig.mcpServers;
            await invoke('save_ai_config', { config });
        } catch (e) {
            console.error("Failed to save MCP config:", e);
        }
    }

    async startAll() {
        const servers = this.serversConfig.mcpServers || {};
        for (const [name, config] of Object.entries(servers)) {
            await this.startClient(name, config);
        }
    }

    async startClient(name, config) {
        if (this.clients.has(name)) {
            await this.clients.get(name).stop();
        }

        // Transport dispatch: `http` connects OUT to a remote MCP server over
        // Streamable HTTP (T2); anything else uses the local stdio subprocess.
        const client = (config.transport === 'http')
            ? new McpHttpClient(name, config.url, config.headers || {})
            : new McpClient(name, config.command, config.args || [], config.env || {});
        const success = await client.start();
        if (success) {
            this.clients.set(name, client);
            // stdio/HTTP servers can declare these too — the clients ask for
            // both during the handshake, so publish whatever came back.
            intentRegistry.setForApp(name, client.intents || []);
            resourceRegistry.setForApp(name, client.resources || []);
            this.startErrors.delete(name);
            this._notify();
        } else {
            // Preserve the failure reason so the UI can surface it (tooltip / detail).
            this.startErrors.set(name, client.lastError || {
                message: `MCP サーバー "${name}" の起動に失敗しました。`,
                stage: 'unknown',
                at: new Date().toISOString(),
            });
        }
        return success;
    }

    async stopAll() {
        for (const client of this.clients.values()) {
            await client.stop();
            // A stopped server can no longer answer resources/read, so its
            // entries must go too — otherwise the agent sees phantom documents.
            intentRegistry.clearApp(client.name);
            resourceRegistry.clearApp(client.name);
        }
        this.clients.clear();
        this._notify();
    }

    /** Every published resource, across all connected apps. */
    listResources() {
        return resourceRegistry.list();
    }

    /**
     * Read one published resource. `ref` is "app::uri", or a bare uri when only
     * one app publishes it.
     * @returns {Promise<{uri, app, mimeType?, text}>}
     */
    async readResource(ref) {
        const { resource, error, candidates } = resolveResource(ref, resourceRegistry);
        if (error === 'ambiguous') {
            const opts = candidates.map(c => c.key).join(', ');
            throw new Error(`Resource "${ref}" is published by several apps. Use one of: ${opts}`);
        }
        if (!resource) throw new Error(`Resource not found: ${ref}`);

        const client = this.clients.get(resource.app);
        if (!client) throw new Error(`App "${resource.app}" is no longer connected`);

        const result = await client.request('resources/read', { uri: resource.uri });
        return {
            uri: resource.uri,
            app: resource.app,
            mimeType: result?.contents?.[0]?.mimeType || resource.mimeType || '',
            text: contentsToText(result),
        };
    }

    /**
     * All tools from every connected MCP server.
     * @param {{wsOnly?:boolean}} opts
     *   wsOnly: true  → only tools from EXTERNAL-APP (WebSocket-dialed) servers
     *                    (e.g. JHEditor's get_buffer). These advertise the app's
     *                    live workspace and make no sense in a plain agent task.
     *           false → only tools from CONFIG servers (stdio/http).
     *           omit  → everything (current behaviour).
     * @returns {Array<{name:string, description?:string, _serverName:string, inputSchema?:object}>}
     */
    getAllTools(opts = {}) {
        const { wsOnly = null } = opts;
        const allTools = [];
        for (const client of this.clients.values()) {
            const isWs = client instanceof McpWsClient;
            if (wsOnly === true && !isWs) continue;
            if (wsOnly === false && isWs) continue;
            const serverTools = client.tools.map(t => ({
                ...t,
                _serverName: client.name
            }));
            allTools.push(...serverTools);
        }
        return allTools;
    }

    async callTool(serverName, toolName, args, meta = null) {
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`Server ${serverName} not found`);
        return await client.callTool(toolName, args, meta);
    }

    /**
     * Add a server. Two shapes are supported:
     *   stdio (local subprocess): addServer(name, { command, args?, env? })
     *   http  (remote Streamable HTTP): addServer(name, { transport:'http', url, headers? })
     * The legacy positional form addServer(name, command, args, env) is kept
     * for backward compatibility with existing callers.
     */
    async addServer(name, commandOrConfig, args = [], env = {}) {
        if (!this.serversConfig.mcpServers) {
            this.serversConfig.mcpServers = {};
        }
        const config = (typeof commandOrConfig === 'object' && commandOrConfig !== null)
            ? { ...commandOrConfig }
            : { command: commandOrConfig, args, env };
        this.serversConfig.mcpServers[name] = config;
        await this.saveConfig();
        return this.startClient(name, config);
    }

    async removeServer(name) {
        if (this.serversConfig.mcpServers && this.serversConfig.mcpServers[name]) {
            delete this.serversConfig.mcpServers[name];
            await this.saveConfig();
        }
        this.startErrors.delete(name);
        intentRegistry.clearApp(name);
        resourceRegistry.clearApp(name);
        this._notify();
        const client = this.clients.get(name);
        if (client) {
            client.stop();
            this.clients.delete(name);
        }
    }
}

export const mcpManager = new McpManager();
