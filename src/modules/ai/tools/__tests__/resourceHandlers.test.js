// The agent-facing half of MCP resources: what the model sees when it lists or
// reads a document a connected app is publishing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listResources = vi.fn();
const readResource = vi.fn();

vi.mock('../../McpManager.js', () => ({
    mcpManager: {
        listResources: (...a) => listResources(...a),
        readResource: (...a) => readResource(...a),
    },
}));

const { handleListResources, handleReadResource } = await import('../handlers/resourceHandlers.js');

const ctx = () => ({ onToolEvent: vi.fn() });

beforeEach(() => { listResources.mockReset(); readResource.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('list_resources', () => {
    it('says plainly that there is nothing, rather than returning an empty list', async () => {
        listResources.mockReturnValue([]);
        const out = await handleListResources(ctx(), {});
        expect(out).toContain('No app resources are available');
    });

    it('shows the QUALIFIED key so the model can read an unambiguous reference', async () => {
        listResources.mockReturnValue([
            { key: 'jheditor::doc://current', app: 'jheditor', uri: 'doc://current', name: 'Active buffer', mimeType: 'text/plain', description: '編集中のファイル' },
            { key: 'task::board://today', app: 'task', uri: 'board://today' },
        ]);
        const out = await handleListResources(ctx(), {});
        expect(out).toContain('- jheditor::doc://current — Active buffer [text/plain]');
        expect(out).toContain('編集中のファイル');
        expect(out).toContain('- task::board://today');
        expect(out).toContain('read_resource');
    });

    it('filters to one app, case-insensitively', async () => {
        listResources.mockReturnValue([
            { key: 'jheditor::a', app: 'jheditor', uri: 'a' },
            { key: 'task::b', app: 'task', uri: 'b' },
        ]);
        const out = await handleListResources(ctx(), { app: 'JHEditor' });
        expect(out).toContain('jheditor::a');
        expect(out).not.toContain('task::b');
    });

    it('reports an app filter that matched nothing', async () => {
        listResources.mockReturnValue([{ key: 'a::b', app: 'a', uri: 'b' }]);
        expect(await handleListResources(ctx(), { app: 'ghost' })).toContain('No resources published by app "ghost"');
    });
});

describe('read_resource', () => {
    it('requires a uri', async () => {
        expect(await handleReadResource(ctx(), {})).toContain("requires a 'uri'");
        expect(readResource).not.toHaveBeenCalled();
    });

    it('returns the content with a header naming the app and type', async () => {
        readResource.mockResolvedValue({ app: 'jheditor', uri: 'doc://current', mimeType: 'text/plain', text: 'FILE BODY' });
        const c = ctx();
        const out = await handleReadResource(c, { uri: 'doc://current' });
        expect(out).toBe('# jheditor::doc://current [text/plain]\nFILE BODY');
        expect(c.onToolEvent).toHaveBeenCalledWith('read_resource', { uri: 'doc://current', app: 'jheditor' });
    });

    it('distinguishes an empty document from a failure', async () => {
        readResource.mockResolvedValue({ app: 'a', uri: 'u', mimeType: '', text: '' });
        expect(await handleReadResource(ctx(), { uri: 'u' })).toContain('no readable content');
    });

    it('surfaces the ambiguity message so the model can retry with a qualified ref', async () => {
        readResource.mockRejectedValue(new Error('Resource "doc://current" is published by several apps. Use one of: a::doc://current, b::doc://current'));
        const out = await handleReadResource(ctx(), { uri: 'doc://current' });
        expect(out).toContain('Error: read_resource failed');
        expect(out).toContain('a::doc://current');
    });

    it('surfaces a disconnected app instead of throwing into the loop', async () => {
        readResource.mockRejectedValue(new Error('App "jheditor" is no longer connected'));
        expect(await handleReadResource(ctx(), { uri: 'jheditor::doc://current' })).toContain('no longer connected');
    });
});
