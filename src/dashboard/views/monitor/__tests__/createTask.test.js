// createTask — the shared creation path.
//
// The rules worth pinning are the ones that are invisible from either call site:
// selected MCP servers must be RUNNING before the POST, a server that refuses to
// start must not lose the user's prompt, and `mcp_servers` must go on the wire
// even when it is empty (an omitted list means "every server" to AgentController).

import { describe, it, expect, vi } from 'vitest';
import { createTask, startSelectedMcp, rememberWorkspace } from '../createTask.js';

const mkMcp = (running = [], failing = []) => ({
    clients: new Set(running),
    startClient: vi.fn(async (name) => {
        if (failing.includes(name)) throw new Error(`${name} refused`);
    }),
});

const mkClient = (taskId = 't-1') => ({
    request: vi.fn(async () => ({ task_id: taskId })),
});

const body = (client) => JSON.parse(client.request.mock.calls[0][1].body);

describe('startSelectedMcp', () => {
    it('starts only what is not already running', async () => {
        const mcp = mkMcp(['alpha']);
        await startSelectedMcp(['alpha', 'beta'], { beta: { cmd: 'x' } }, mcp);
        expect(mcp.startClient).toHaveBeenCalledTimes(1);
        expect(mcp.startClient).toHaveBeenCalledWith('beta', { cmd: 'x' });
    });

    it('reports failures instead of throwing — a refusing server must not block the task', async () => {
        const mcp = mkMcp([], ['beta']);
        const failed = await startSelectedMcp(['beta'], { beta: {} }, mcp);
        expect(failed).toEqual(['beta']);
    });
});

describe('createTask', () => {
    it('starts the selected servers BEFORE posting', async () => {
        const order = [];
        const mcp = {
            clients: new Set(),
            startClient: vi.fn(async () => { order.push('mcp'); }),
        };
        const client = { request: vi.fn(async () => { order.push('post'); return { task_id: 't' }; }) };

        await createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop',
            selectedMcp: ['s1'], mcpServers: { s1: {} }, client, mcp,
        });
        expect(order).toEqual(['mcp', 'post']);
    });

    it('still creates the task when a server failed to start', async () => {
        const client = mkClient('t-9');
        const id = await createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop',
            selectedMcp: ['bad'], mcpServers: { bad: {} },
            client, mcp: mkMcp([], ['bad']),
        });
        expect(id).toBe('t-9');
    });

    it('sends mcp_servers even when empty — an omitted list means "every server"', async () => {
        const client = mkClient();
        await createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop',
            selectedMcp: [], client, mcp: mkMcp(),
        });
        expect(body(client).behavior.mcp_servers).toEqual([]);
    });

    it('trims the workspace and passes the caller through', async () => {
        const client = mkClient();
        await createTask({
            prompt: 'go', workspace: '  C:/p  ', modeId: 'develop',
            caller: 'Composer', client, mcp: mkMcp(),
        });
        expect(body(client).workspace_path).toBe('C:/p');
        expect(body(client).caller).toBe('Composer');
    });

    it('omits images rather than sending an empty list', async () => {
        const client = mkClient();
        await createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop',
            images: [], client, mcp: mkMcp(),
        });
        expect('images' in body(client)).toBe(false);
    });

    it('sends images when there are some', async () => {
        const client = mkClient();
        await createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop',
            images: ['data:image/png;base64,AA'], client, mcp: mkMcp(),
        });
        expect(body(client).images).toHaveLength(1);
    });

    it('lets a POST failure reach the caller, so the prompt is not silently lost', async () => {
        const client = { request: vi.fn(async () => { throw new Error('boom'); }) };
        await expect(createTask({
            prompt: 'go', workspace: 'C:/p', modeId: 'develop', client, mcp: mkMcp(),
        })).rejects.toThrow('boom');
    });
});

// The workspace list only ever grew from the folder picker and the first-run
// wizard, so a workspace used for an actual task — typed in, carried over from a
// template, handed in by another app — never appeared in it. The history filled
// with workspaces the picker did not offer.
describe('remembering where a task ran', () => {
    const client = (projects = []) => ({
        getConfig: vi.fn(async () => ({ approved_projects: projects })),
        updateConfig: vi.fn(async () => ({})),
    });

    it('adds a workspace that was not on the list', async () => {
        const c = client(['C:/a']);
        expect(await rememberWorkspace('C:/b', c)).toBe(true);
        expect(c.updateConfig).toHaveBeenCalledWith({ approved_projects: ['C:/a', 'C:/b'] });
    });

    it('does not add one that is already there', async () => {
        const c = client(['C:/a']);
        expect(await rememberWorkspace('C:/a', c)).toBe(false);
        expect(c.updateConfig).not.toHaveBeenCalled();
    });

    // Windows hands the same folder back spelled several ways.
    it('treats separators, trailing slashes and case as the same path', async () => {
        const c = client(['C:/work/proj']);
        expect(await rememberWorkspace('C:\\Work\\Proj\\', c)).toBe(false);
        expect(c.updateConfig).not.toHaveBeenCalled();
    });

    it('does nothing without a workspace', async () => {
        const c = client([]);
        expect(await rememberWorkspace('   ', c)).toBe(false);
        expect(c.getConfig).not.toHaveBeenCalled();
    });
});

describe('prior conversation reaches the server', () => {
    it('is forwarded, not dropped between createTask and the request', async () => {
        const calls = [];
        const client = {
            request: async (path, opts) => { calls.push(JSON.parse(opts.body)); return { task_id: 't1' }; },
            getConfig: async () => ({}),
            updateConfig: async () => {},
        };
        await createTask({
            prompt: 'q', workspace: 'C:/w', modeId: 'general', client,
            mcp: { clients: new Map() },
            chatContext: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
        });
        expect(calls[0].chat_context).toHaveLength(2);
        expect(calls[0].chat_context[1].content).toBe('a');
    });
});
