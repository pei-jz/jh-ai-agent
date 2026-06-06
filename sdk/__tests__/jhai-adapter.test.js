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

describe('jhai-adapter — runIntent / result handling', () => {
    beforeEach(() => MockWS.reset());

    it('creates a task with app-scoped behavior + inline intent + context, and renders the result', async () => {
        let postedBody = null;
        const fetchImpl = async (url, opts) => {
            postedBody = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ task_id: 't1' }) };
        };
        const ai = makeAdapter(fetchImpl);
        ai.registerIntent({
            id: 'summarize_logs', title: 'ログ集計',
            systemPrompt: 'SP', tools: ['get_buffer'], resultKind: 'markdown',
        });
        ai.setContextProvider(() => ({ app: 'jheditor', documentId: 'doc-1' }));

        let rendered = null;
        ai.onResult('markdown', (payload, actions) => { rendered = { payload, actions }; });

        await ai.start();
        const promise = ai.runIntent('summarize_logs', { prompt: 'go' });
        await tick();   // let fetch + task WS open

        // Verify the POST body.
        expect(postedBody.caller).toBe('jheditor');
        expect(postedBody.behavior.mcp_servers).toEqual(['jheditor']);
        expect(postedBody.behavior.intent).toEqual({ systemPrompt: 'SP', tools: ['get_buffer'], resultKind: 'markdown' });
        expect(postedBody.behavior.mcp_context).toEqual({ app: 'jheditor', documentId: 'doc-1' });

        // Drive the task WS: result envelope then complete.
        const taskWs = MockWS.byUrl('/ws/tasks/t1');
        expect(taskWs).toBeTruthy();
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

    it('throws for an unknown intent', async () => {
        const ai = makeAdapter(async () => ({ ok: true, json: async () => ({ task_id: 't' }) }));
        await ai.start();
        await expect(ai.runIntent('nope', {})).rejects.toThrow(/Unknown intent/);
    });

    it('chat() posts freeform behavior (no intent) scoped to the app', async () => {
        let body = null;
        const ai = makeAdapter(async (url, opts) => {
            body = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ task_id: 'tc' }) };
        });
        await ai.start();
        const p = ai.chat('hello');
        await tick();
        expect(body.behavior.mcp_servers).toEqual(['jheditor']);
        expect(body.behavior.intent).toBeUndefined();
        expect(body.behavior.mcp_context).toBeUndefined(); // no context provider set
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
