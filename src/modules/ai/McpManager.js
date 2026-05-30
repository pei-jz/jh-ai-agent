import { invoke } from '@tauri-apps/api/core';
import { McpClient } from './McpClient.js';

export class McpManager {
    constructor() {
        this.clients = new Map();
        this.serversConfig = { mcpServers: {} };
    }

    async init() {
        await this.loadConfig();
        await this.startAll();
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

        const client = new McpClient(name, config.command, config.args || [], config.env || {});
        const success = await client.start();
        if (success) {
            this.clients.set(name, client);
        }
    }

    async stopAll() {
        for (const client of this.clients.values()) {
            await client.stop();
        }
        this.clients.clear();
    }

    getAllTools() {
        const allTools = [];
        for (const client of this.clients.values()) {
            const serverTools = client.tools.map(t => ({
                ...t,
                _serverName: client.name
            }));
            allTools.push(...serverTools);
        }
        return allTools;
    }

    async callTool(serverName, toolName, args) {
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`Server ${serverName} not found`);
        return await client.callTool(toolName, args);
    }

    async addServer(name, command, args = [], env = {}) {
        if (!this.serversConfig.mcpServers) {
            this.serversConfig.mcpServers = {};
        }
        const config = { command, args, env };
        this.serversConfig.mcpServers[name] = config;
        await this.saveConfig();
        return this.startClient(name, config);
    }

    async removeServer(name) {
        if (this.serversConfig.mcpServers && this.serversConfig.mcpServers[name]) {
            delete this.serversConfig.mcpServers[name];
            await this.saveConfig();
        }
        const client = this.clients.get(name);
        if (client) {
            client.stop();
            this.clients.delete(name);
        }
    }
}

export const mcpManager = new McpManager();
