import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { McpManager } = await import('../McpManager.js');
const { McpWsClient } = await import('../McpWsClient.js');
const { McpClient } = await import('../McpClient.js');

describe('McpManager.getAllTools wsOnly filter', () => {
    it('separates external-app (WS) tools from config (stdio/http) tools', () => {
        const m = new McpManager();
        const ws = new McpWsClient('jheditor', 'c1');
        ws.tools = [{ name: 'get_buffer' }, { name: 'list_workspace_files' }];
        const stdio = new McpClient('backlog', 'cmd');
        stdio.tools = [{ name: 'add_issue' }];
        m.clients.set('jheditor', ws);
        m.clients.set('backlog', stdio);

        expect(m.getAllTools().map(t => t.name).sort())
            .toEqual(['add_issue', 'get_buffer', 'list_workspace_files']);
        expect(m.getAllTools({ wsOnly: true }).map(t => t.name).sort())
            .toEqual(['get_buffer', 'list_workspace_files']);
        expect(m.getAllTools({ wsOnly: false }).map(t => t.name))
            .toEqual(['add_issue']);
    });
});
