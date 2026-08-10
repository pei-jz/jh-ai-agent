// McpManager's resource routing: turning a reference the agent typed into a
// resources/read on the one client that owns it — and refusing to guess.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../McpClient.js', () => ({ McpClient: class {} }));
vi.mock('../McpWsClient.js', () => ({ McpWsClient: class {} }));
vi.mock('../McpHttpClient.js', () => ({ McpHttpClient: class {} }));

const { McpManager } = await import('../McpManager.js');
const { resourceRegistry } = await import('../agent/ResourceRegistry.js');

/** A stand-in client that records the resources/read calls it received. */
function fakeClient(name, contents) {
    return {
        name,
        calls: [],
        async request(method, params) {
            this.calls.push({ method, params });
            if (method !== 'resources/read') throw new Error(`unexpected ${method}`);
            return contents(params.uri);
        },
        async stop() {},
    };
}

let mgr;
beforeEach(() => {
    resourceRegistry.clearApp('jheditor');
    resourceRegistry.clearApp('task');
    mgr = new McpManager();
});

describe('McpManager.readResource', () => {
    beforeEach(() => {
        mgr.clients.set('jheditor', fakeClient('jheditor', () => ({
            contents: [{ uri: 'doc://current', mimeType: 'text/x-javascript', text: 'const a = 1;' }],
        })));
        resourceRegistry.setForApp('jheditor', [{ uri: 'doc://current', name: 'buffer' }]);
    });

    it('routes to the owning client and flattens the contents', async () => {
        const doc = await mgr.readResource('doc://current');
        expect(doc).toEqual({
            uri: 'doc://current', app: 'jheditor',
            mimeType: 'text/x-javascript', text: 'const a = 1;',
        });
        expect(mgr.clients.get('jheditor').calls).toEqual([
            { method: 'resources/read', params: { uri: 'doc://current' } },
        ]);
    });

    it('accepts a qualified reference', async () => {
        expect((await mgr.readResource('jheditor::doc://current')).app).toBe('jheditor');
    });

    it('REFUSES to guess when two apps publish the same uri, and names the options', async () => {
        mgr.clients.set('task', fakeClient('task', () => ({ contents: [{ text: 'board' }] })));
        resourceRegistry.setForApp('task', [{ uri: 'doc://current' }]);

        await expect(mgr.readResource('doc://current')).rejects.toThrow(/several apps/);
        // Neither client was contacted — no side effect from an ambiguous read.
        expect(mgr.clients.get('jheditor').calls).toHaveLength(0);
        expect(mgr.clients.get('task').calls).toHaveLength(0);

        expect((await mgr.readResource('task::doc://current')).text).toBe('board');
    });

    it('reports an unknown reference', async () => {
        await expect(mgr.readResource('doc://nope')).rejects.toThrow(/not found/);
    });

    it('reports an app that published but has since disconnected', async () => {
        mgr.clients.delete('jheditor');
        await expect(mgr.readResource('doc://current')).rejects.toThrow(/no longer connected/);
    });

    it('falls back to the declared mimeType when the read result omits it', async () => {
        resourceRegistry.setForApp('task', [{ uri: 'board://today', mimeType: 'text/markdown' }]);
        mgr.clients.set('task', fakeClient('task', () => ({ contents: [{ text: '# board' }] })));
        expect((await mgr.readResource('board://today')).mimeType).toBe('text/markdown');
    });
});

describe('McpManager resource lifecycle', () => {
    it('stopAll withdraws the resources — no phantom documents after shutdown', async () => {
        mgr.clients.set('jheditor', fakeClient('jheditor', () => ({ contents: [] })));
        resourceRegistry.setForApp('jheditor', [{ uri: 'doc://current' }]);
        expect(mgr.listResources()).toHaveLength(1);

        await mgr.stopAll();
        expect(mgr.listResources()).toHaveLength(0);
    });

    it('removeServer withdraws them too', async () => {
        mgr.clients.set('task', fakeClient('task', () => ({ contents: [] })));
        resourceRegistry.setForApp('task', [{ uri: 'board://today' }]);
        await mgr.removeServer('task');
        expect(mgr.listResources()).toHaveLength(0);
    });
});

describe('connection-change watchers', () => {
    it('notifies on connect and on removal, so a live strip can follow', () => {
        const seen = [];
        mgr.onChange(() => seen.push('changed'));

        mgr.clients.set('task', fakeClient('task', () => ({ contents: [] })));
        resourceRegistry.setForApp('task', [{ uri: 'board://today' }]);
        mgr._notify();
        expect(seen).toHaveLength(1);

        return mgr.removeServer('task').then(() => {
            expect(seen.length).toBeGreaterThan(1);
        });
    });

    it('unsubscribes cleanly', () => {
        const fn = vi.fn();
        const off = mgr.onChange(fn);
        off();
        mgr._notify();
        expect(fn).not.toHaveBeenCalled();
    });

    it('ignores a non-function watcher', () => {
        expect(() => mgr.onChange(null)()).not.toThrow();
    });

    it('a throwing watcher cannot break a connection', () => {
        const good = vi.fn();
        mgr.onChange(() => { throw new Error('boom'); });
        mgr.onChange(good);
        expect(() => mgr._notify()).not.toThrow();
        expect(good).toHaveBeenCalled();
    });

    it('stopAll notifies once everything is down', async () => {
        const fn = vi.fn();
        mgr.clients.set('a', fakeClient('a', () => ({ contents: [] })));
        mgr.onChange(fn);
        await mgr.stopAll();
        expect(fn).toHaveBeenCalled();
    });
});
