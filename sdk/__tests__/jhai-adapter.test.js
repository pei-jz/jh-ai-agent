import { describe, it, expect, beforeEach } from 'vitest';
import { createJhaiAdapter } from '../jhai-adapter.js';

const tick = () => new Promise(r => setTimeout(r, 0));

// Minimal mock WebSocket. Instances are recorded so tests can grab one by URL
// and drive inbound frames / lifecycle.
class MockWS {
    constructor(url) {
        this.url = url;
        this.readyState = 1;          // OPEN (synchronous, simplifies tests)
        this.sent = [];
        MockWS.instances.push(this);
        // fire onopen on next tick
        setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    recv(obj) {
        const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
        if (this.onmessage) this.onmessage({ data });
    }
    static reset() { MockWS.instances = []; }
    static byUrl(sub) { return MockWS.instances.find(w => w.url.includes(sub)); }
    static lastSent(ws) { return JSON.parse(ws.sent[ws.sent.length - 1]); }
}

function makeAdapter(fetchImpl) {
    return createJhaiAdapter({
        app: 'jheditor',
        jhaiBaseUrl: 'http://127.0.0.1:9999',
        authToken: 'tok123',
        WebSocketImpl: MockWS,
        fetchImpl,
    });
}

describe('jhai-adapter — MCP server role over WS', () => {
    beforeEach(() => MockWS.reset());

    it('dials the /mcp/ws endpoint with app + token', async () => {
        const ai = makeAdapter();
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        expect(ws).toBeTruthy();
        expect(ws.url).toBe('ws://127.0.0.1:9999/mcp/ws?app=jheditor&token=tok123');
    });

    it('answers initialize with serverInfo + tools capability', async () => {
        const ai = makeAdapter();
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        await tick();
        const resp = MockWS.lastSent(ws);
        expect(resp.id).toBe(1);
        expect(resp.result.serverInfo.name).toBe('jheditor');
        expect(resp.result.capabilities.tools).toBeDefined();
    });

    it('lists registered tools', async () => {
        const ai = makeAdapter();
        ai.registerTool({ name: 'get_buffer', description: 'buf', handler: async () => 'x' });
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        await tick();
        const resp = MockWS.lastSent(ws);
        expect(resp.result.tools).toHaveLength(1);
        expect(resp.result.tools[0].name).toBe('get_buffer');
        expect(resp.result.tools[0].inputSchema).toBeDefined();
    });

    it('dispatches tools/call to the handler with ctx from _meta.jhai', async () => {
        const ai = makeAdapter();
        let seenCtx = null;
        ai.registerTool({
            name: 'get_buffer',
            handler: async (args, ctx) => { seenCtx = ctx; return 'BUFFER'; },
        });
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'get_buffer', arguments: {}, _meta: { jhai: { documentId: 'doc-9' } } },
        });
        await tick();
        expect(seenCtx).toEqual({ documentId: 'doc-9' });
        const resp = MockWS.lastSent(ws);
        expect(resp.result.content[0].text).toBe('BUFFER');
    });

    it('returns a JSON-RPC error for an unknown tool', async () => {
        const ai = makeAdapter();
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
        await tick();
        const resp = MockWS.lastSent(ws);
        expect(resp.error).toBeTruthy();
        expect(resp.error.message).toContain('Unknown tool');
    });

    it('ignores notifications (no id)', async () => {
        const ai = makeAdapter();
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        const before = ws.sent.length;
        ws.recv({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        await tick();
        expect(ws.sent.length).toBe(before);
    });
});

describe('jhai-adapter — chat / result handling', () => {
    beforeEach(() => MockWS.reset());

    it('creates an ask × app task scoped to the app, with context and instructions, and renders the result', async () => {
        let postedBody = null;
        const fetchImpl = async (url, opts) => {
            postedBody = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ task_id: 't1' }) };
        };
        const ai = makeAdapter(fetchImpl);
        ai.setContextProvider(() => ({ app: 'jheditor', documentId: 'doc-1' }));

        let rendered = null;
        ai.onResult('markdown', (payload, actions) => { rendered = { payload, actions }; });

        await ai.start();
        const promise = ai.chat('go', { instructions: 'Summarize the log as a table.' });
        await tick();

        expect(postedBody.caller).toBe('jheditor');
        expect(postedBody.behavior).toMatchObject({ shape: 'ask', reach: 'app', mcp_servers: ['jheditor'] });
        expect(postedBody.behavior.extra_instructions).toBe('Summarize the log as a table.');
        // Instructions are appended, never a replacement prompt.
        expect(postedBody.behavior.system_prompt).toBeUndefined();
        expect(postedBody.behavior.intent).toBeUndefined();
        expect(postedBody.behavior.mcp_context).toEqual({ app: 'jheditor', documentId: 'doc-1' });
        expect(postedBody.context).toEqual({ app: 'jheditor', documentId: 'doc-1' });

        const taskWs = MockWS.byUrl('/ws/tasks/t1');
        taskWs.recv({ event: 'result', data: { envelope: { kind: 'markdown', payload: { md: '# Sum' }, actions: [{ label: 'Insert', apply: { type: 'insertMarkdown', text: '# Sum' } }], summary: 's' } } });
        taskWs.recv({ event: 'complete', data: {} });

        const envelope = await promise;
        expect(envelope.kind).toBe('markdown');
        expect(rendered.payload).toEqual({ md: '# Sum' });
        expect(rendered.actions[0].label).toBe('Insert');
    });

    it('applyAction routes to the registered action handler', async () => {
        const ai = makeAdapter();
        let inserted = null;
        ai.registerActionHandler('insertMarkdown', (apply) => { inserted = apply.text; });
        ai.applyAction({ label: 'Insert', apply: { type: 'insertMarkdown', text: 'hello' } });
        expect(inserted).toBe('hello');
    });

    it('no longer offers named intents', () => {
        const ai = makeAdapter();
        expect(ai.registerIntent).toBeUndefined();
        expect(ai.runIntent).toBeUndefined();
        expect(ai.runIntentTask).toBeUndefined();
    });

    it('chat() without context sends no context', async () => {
        let body = null;
        const ai = makeAdapter(async (url, opts) => {
            body = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ task_id: 'tc' }) };
        });
        await ai.start();
        const p = ai.chat('hello');
        await tick();
        expect(body.behavior.mcp_servers).toEqual(['jheditor']);
        expect(body.behavior.mcp_context).toBeUndefined();
        expect(body.context).toBeUndefined();
        const taskWs = MockWS.byUrl('/ws/tasks/tc');
        taskWs.recv({ event: 'complete', data: {} });
        await p;
    });

    it('rejects when task create returns non-ok', async () => {
        const ai = makeAdapter(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        await ai.start();
        await expect(ai.chat('x')).rejects.toThrow(/HTTP 500/);
    });
});

describe('jhai-adapter — misc behaviors', () => {
    beforeEach(() => MockWS.reset());

    it('passes through a handler result that is already {content:[...]}', async () => {
        const ai = makeAdapter();
        ai.registerTool({ name: 't', handler: async () => ({ content: [{ type: 'text', text: 'pre' }] }) });
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } });
        await tick();
        expect(MockWS.lastSent(ws).result.content[0].text).toBe('pre');
    });

    it('applyAction with no registered handler is a no-op (no throw)', () => {
        const ai = makeAdapter();
        expect(() => ai.applyAction({ apply: { type: 'unknownType' } })).not.toThrow();
    });

    it('dispatching a result with no renderer does not throw', async () => {
        const ai = makeAdapter(async () => ({ ok: true, status: 200, json: async () => ({ task_id: 'tn' }) }));
        await ai.start();
        const p = ai.chat('x');
        await tick();
        const taskWs = MockWS.byUrl('/ws/tasks/tn');
        taskWs.recv({ event: 'result', data: { envelope: { kind: 'file-list', payload: { files: [] }, actions: [] } } });
        taskWs.recv({ event: 'complete', data: {} });
        const env = await p;
        expect(env.kind).toBe('file-list');
    });

    it('converts https base URLs to wss for the WS endpoint', async () => {
        const ai = createJhaiAdapter({
            app: 'jher', jhaiBaseUrl: 'https://hub.example:443', authToken: 't',
            WebSocketImpl: MockWS,
        });
        await ai.start();
        expect(MockWS.byUrl('/mcp/ws').url.startsWith('wss://hub.example:443/mcp/ws')).toBe(true);
    });

    it('requires app and jhaiBaseUrl', () => {
        expect(() => createJhaiAdapter({ jhaiBaseUrl: 'http://x' })).toThrow(/app/);
        expect(() => createJhaiAdapter({ app: 'a' })).toThrow(/jhaiBaseUrl/);
    });
});

// ── Task API (streaming task handle over HTTP create + WS subscribe) ────────
describe('jhai-adapter — task API', () => {
    beforeEach(() => MockWS.reset());

    // fetch mock: POST /api/tasks → {task_id}; DELETE → ok. Records calls.
    function fetchMock(taskId = 'T1') {
        const calls = [];
        const impl = async (url, opts = {}) => {
            calls.push({ url, method: opts.method || 'GET', body: opts.body });
            if ((opts.method || 'GET') === 'POST') return { ok: true, json: async () => ({ task_id: taskId }) };
            return { ok: true, json: async () => ({}) };
        };
        impl.calls = calls;
        return impl;
    }

    it('chatTask: creates a task, streams events, resolves the result envelope', async () => {
        const fetchImpl = fetchMock('T1');
        const ai = makeAdapter(fetchImpl);
        const seen = [];
        const handle = ai.chatTask('hello', { onEvent: (e) => seen.push(e) });
        const tid = await handle.taskId;
        expect(tid).toBe('T1');
        const post = JSON.parse(fetchImpl.calls[0].body);
        expect(post.prompt).toBe('hello');
        expect(post.caller).toBe('jheditor');
        expect(post.behavior.mcp_servers).toEqual(['jheditor']);
        await tick();
        const ws = MockWS.byUrl('/ws/tasks/T1');
        expect(ws.url).toContain('token=tok123');
        ws.recv({ event: 'thought', data: { text: 'thinking' } });
        ws.recv({ event: 'result', data: { envelope: { kind: 'markdown', payload: { md: 'hi' } } } });
        ws.recv({ event: 'complete', data: { summary: 'done' } });
        const env = await handle.completed;
        expect(env.kind).toBe('markdown');
        expect(env.payload.md).toBe('hi');
        expect(seen).toContain('thought');
    });

    it('chat(): convenience resolves the completed envelope', async () => {
        const ai = makeAdapter(fetchMock('T2'));
        const p = ai.chat('yo');
        await tick(); await tick();
        MockWS.byUrl('/ws/tasks/T2').recv({ event: 'complete', data: { summary: 'ok' } });
        const env = await p;
        expect(env.summary === 'ok' || env.payload.md === 'ok').toBe(true);
    });

    it('an error event rejects completed', async () => {
        const ai = makeAdapter(fetchMock('T4'));
        const handle = ai.chatTask('x');
        await handle.taskId; await tick();
        MockWS.byUrl('/ws/tasks/T4').recv({ event: 'error', data: { error: 'boom' } });
        await expect(handle.completed).rejects.toThrow(/boom/);
    });

    it('_createTask rejects on a non-OK HTTP status', async () => {
        const ai = makeAdapter(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        await expect(ai.chatTask('x').completed).rejects.toThrow(/HTTP 500/);
    });

    it('abort() cancels via DELETE and settles completed', async () => {
        const fetchImpl = fetchMock('T5');
        const ai = makeAdapter(fetchImpl);
        const handle = ai.chatTask('x');
        await handle.taskId; await tick();
        handle.abort();
        await handle.completed;
        await tick();
        const del = fetchImpl.calls.find(c => c.method === 'DELETE');
        expect(del.url).toContain('/api/tasks/T5');
    });

    it('stop() closes the MCP websocket', async () => {
        const ai = makeAdapter(fetchMock());
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ai.stop();
        expect(ws.readyState).toBe(3);
    });
});

describe('jhai-adapter — intents are gone', () => {
    beforeEach(() => MockWS.reset());

    // An agent that still asks gets "method not found", the same answer any
    // plain MCP server gives — not an empty list that looks like a real reply.
    it('answers jhai/intents/list with method-not-found', async () => {
        const ai = makeAdapter();
        await ai.start();
        const ws = MockWS.byUrl('/mcp/ws');
        ws.recv({ jsonrpc: '2.0', id: 10, method: 'jhai/intents/list', params: {} });
        await tick();
        expect(MockWS.lastSent(ws).error).toBeTruthy();
    });
});

describe('jhai-adapter — resource publication', () => {
    beforeEach(() => MockWS.reset());

    async function connected(setup) {
        const ai = makeAdapter();
        setup?.(ai);
        await ai.start();
        return { ai, ws: MockWS.byUrl('/mcp/ws') };
    }

    it('declares the resources capability only when something is published', async () => {
        const bare = await connected();
        bare.ws.recv({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        await tick();
        expect(MockWS.lastSent(bare.ws).result.capabilities.resources).toBeUndefined();

        MockWS.reset();
        const pub = await connected(ai => ai.registerResource({ uri: 'doc://current', read: () => 'x' }));
        pub.ws.recv({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
        await tick();
        expect(MockWS.lastSent(pub.ws).result.capabilities.resources).toEqual({});
    });

    it('lists the published resources with their metadata', async () => {
        const { ws } = await connected(ai => ai.registerResource({
            uri: 'doc://current', name: 'Active buffer',
            description: '編集中', mimeType: 'text/plain', read: () => 'body',
        }));
        ws.recv({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} });
        await tick();
        expect(MockWS.lastSent(ws).result.resources).toEqual([{
            uri: 'doc://current', name: 'Active buffer',
            description: '編集中', mimeType: 'text/plain',
        }]);
    });

    it('reads LIVE content — the callback runs at read time, not at registration', async () => {
        let text = 'first';
        const { ws } = await connected(ai => ai.registerResource({ uri: 'doc://current', read: () => text }));

        ws.recv({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'doc://current' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0].text).toBe('first');

        text = 'edited since';
        ws.recv({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'doc://current' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0].text).toBe('edited since');
    });

    it('accepts { text, mimeType } from read() and falls back to the declared type', async () => {
        const { ws } = await connected(ai => {
            ai.registerResource({ uri: 'a', mimeType: 'text/plain', read: () => 'plain' });
            ai.registerResource({ uri: 'b', read: () => ({ text: '# md', mimeType: 'text/markdown' }) });
        });
        ws.recv({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'a' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0].mimeType).toBe('text/plain');

        ws.recv({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'b' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '# md' });
    });

    it('errors on an unknown uri instead of returning empty content', async () => {
        const { ws } = await connected(ai => ai.registerResource({ uri: 'known', read: () => 'x' }));
        ws.recv({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'nope' } });
        await tick();
        expect(MockWS.lastSent(ws).error.message).toContain('Unknown resource');
    });

    it('rejects a registration without a read callback', async () => {
        const ai = makeAdapter();
        expect(() => ai.registerResource({ uri: 'x' })).toThrow(/requires/);
        expect(() => ai.registerResource({ read: () => '' })).toThrow(/requires/);
    });

    it('an async read() and a null return are both handled', async () => {
        const { ws } = await connected(ai => {
            ai.registerResource({ uri: 'slow', read: async () => 'later' });
            ai.registerResource({ uri: 'empty', read: () => null });
        });
        ws.recv({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'slow' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0].text).toBe('later');

        ws.recv({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'empty' } });
        await tick();
        expect(MockWS.lastSent(ws).result.contents[0].text).toBe('');
    });
});
