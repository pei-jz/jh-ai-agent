// McpManager.syncServers — registered servers run; the config is the source.
//
// Every registered server starts with the app (autoStart) and follows Settings
// on save. Per-task On/Off is a separate thing — which tools are SENT — and
// lives in ToolExecutor's server filter, so nothing here knows about tasks.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { McpManager } = await import('../McpManager.js');
const { McpWsClient } = await import('../McpWsClient.js');

function fakeClient(name) {
    return { name, tools: [], resources: [], stop: vi.fn(async () => {}) };
}

let m;
beforeEach(() => {
    m = new McpManager();
    // Stand in for the real transports: record the start, keep a stub client.
    m.startClient = vi.fn(async (name) => {
        if (name === 'bad') throw new Error('spawn failed');
        m.clients.set(name, fakeClient(name));
        return true;
    });
});

describe('McpManager.syncServers', () => {
    it('starts every registered server', async () => {
        await m.syncServers({ a: { command: 'x' }, b: { command: 'y' } });
        expect(m.startClient.mock.calls.map(c => c[0]).sort()).toEqual(['a', 'b']);
    });

    it('skips a server marked "disabled": true', async () => {
        await m.syncServers({ a: { command: 'x' }, off: { command: 'y', disabled: true } });
        expect(m.startClient.mock.calls.map(c => c[0])).toEqual(['a']);
    });

    it('does not restart a server whose config did not change', async () => {
        await m.syncServers({ a: { command: 'x' } });
        await m.syncServers({ a: { command: 'x' } });
        expect(m.startClient).toHaveBeenCalledTimes(1);
    });

    it('restarts a server whose config changed', async () => {
        await m.syncServers({ a: { command: 'x' } });
        await m.syncServers({ a: { command: 'x', args: ['--v2'] } });
        expect(m.startClient).toHaveBeenCalledTimes(2);
    });

    it('stops a server that was removed or disabled', async () => {
        await m.syncServers({ a: { command: 'x' }, b: { command: 'y' } });
        const a = m.clients.get('a');
        const b = m.clients.get('b');
        await m.syncServers({ b: { command: 'y', disabled: true } });
        expect(a.stop).toHaveBeenCalled();
        expect(b.stop).toHaveBeenCalled();
        expect(m.clients.size).toBe(0);
    });

    it('never touches an app that dialed in over WebSocket', async () => {
        const ws = new McpWsClient('jheditor', 'c1');
        ws.stop = vi.fn(async () => {});
        m.clients.set('jheditor', ws);
        await m.syncServers({});
        expect(ws.stop).not.toHaveBeenCalled();
        expect(m.clients.get('jheditor')).toBe(ws);
    });

    it('records a failed start instead of throwing, and still starts the rest', async () => {
        await m.syncServers({ bad: { command: 'x' }, good: { command: 'y' } });
        expect(m.clients.has('good')).toBe(true);
        expect(m.getError('bad')?.message).toMatch(/spawn failed/);
    });

    it('accepts the { mcpServers: {...} } wrapper pasted from other hosts', async () => {
        await m.syncServers({ mcpServers: { a: { command: 'x' } } });
        expect(m.startClient.mock.calls.map(c => c[0])).toEqual(['a']);
    });
});
