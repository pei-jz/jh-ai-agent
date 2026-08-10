import { describe, it, expect, beforeEach } from 'vitest';
import {
    ResourceRegistry, normalizeResource, resolveResource,
    qualifyUri, splitRef, contentsToText,
} from '../ResourceRegistry.js';

describe('normalizeResource', () => {
    it('keeps the declared fields and stamps the owning app + key', () => {
        const r = normalizeResource({
            uri: 'doc://current', name: 'Active buffer',
            description: '編集中のファイル', mimeType: 'text/plain',
        }, 'jheditor');
        expect(r).toEqual({
            uri: 'doc://current', app: 'jheditor', name: 'Active buffer',
            description: '編集中のファイル', mimeType: 'text/plain',
            key: 'jheditor::doc://current',
        });
    });

    it('requires a uri', () => {
        expect(normalizeResource({ name: 'no uri' }, 'a')).toBe(null);
        expect(normalizeResource({ uri: '  ' }, 'a')).toBe(null);
        expect(normalizeResource(null, 'a')).toBe(null);
        expect(normalizeResource('doc://x', 'a')).toBe(null);
    });

    it('drops blank optional fields rather than carrying empty strings', () => {
        const r = normalizeResource({ uri: 'u', name: '  ', mimeType: '' }, 'a');
        expect(r.name).toBeUndefined();
        expect(r.mimeType).toBeUndefined();
    });
});

describe('splitRef', () => {
    it('splits a qualified reference', () => {
        expect(splitRef('jheditor::doc://current')).toEqual({ app: 'jheditor', uri: 'doc://current' });
    });

    it('treats a bare URI as unqualified — a scheme is not an app', () => {
        expect(splitRef('file:///c/a.js')).toEqual({ app: '', uri: 'file:///c/a.js' });
        expect(splitRef('doc://current')).toEqual({ app: '', uri: 'doc://current' });
    });

    it('handles empty input', () => {
        expect(splitRef('')).toEqual({ app: '', uri: '' });
        expect(splitRef(null)).toEqual({ app: '', uri: '' });
    });

    it('round-trips with qualifyUri', () => {
        expect(splitRef(qualifyUri('task', 'board://today'))).toEqual({ app: 'task', uri: 'board://today' });
    });
});

describe('ResourceRegistry', () => {
    let reg;
    beforeEach(() => { reg = new ResourceRegistry(); });

    it('stores and lists what an app published', () => {
        reg.setForApp('jheditor', [{ uri: 'doc://current' }, { uri: 'doc://open' }]);
        expect(reg.size).toBe(2);
        expect(reg.list('jheditor')).toHaveLength(2);
    });

    it('ignores entries it cannot normalize', () => {
        expect(reg.setForApp('a', [{ uri: 'ok' }, { noUri: 1 }, null])).toBe(1);
    });

    it('REPLACES an app\'s set on reconnect — no stale documents after a redeploy', () => {
        reg.setForApp('a', [{ uri: 'gone' }, { uri: 'kept' }]);
        reg.setForApp('a', [{ uri: 'kept' }, { uri: 'new' }]);
        expect(reg.findByUri('gone')).toHaveLength(0);
        expect(reg.size).toBe(2);
    });

    it('keeps two apps\' same-named resources apart', () => {
        reg.setForApp('jheditor', [{ uri: 'doc://current' }]);
        reg.setForApp('task', [{ uri: 'doc://current' }]);
        expect(reg.size).toBe(2);
        reg.clearApp('jheditor');
        expect(reg.findByUri('doc://current').map(r => r.app)).toEqual(['task']);
    });

    it('clearing an unknown app is a no-op', () => {
        expect(reg.clearApp('never')).toBe(0);
    });

    it('rejects a registration with no app name', () => {
        expect(reg.setForApp('', [{ uri: 'x' }])).toBe(0);
        expect(reg.size).toBe(0);
    });

    it('findByUri needs a uri', () => {
        reg.setForApp('a', [{ uri: 'x' }]);
        expect(reg.findByUri('')).toEqual([]);
    });
});

describe('resolveResource', () => {
    let reg;
    beforeEach(() => {
        reg = new ResourceRegistry();
        reg.setForApp('jheditor', [{ uri: 'doc://current', name: 'buffer' }]);
        reg.setForApp('task', [{ uri: 'board://today' }]);
    });

    it('resolves a bare URI when only one app offers it', () => {
        const { resource, error } = resolveResource('doc://current', reg);
        expect(error).toBe('');
        expect(resource.app).toBe('jheditor');
    });

    it('resolves a qualified reference exactly', () => {
        expect(resolveResource('task::board://today', reg).resource.app).toBe('task');
    });

    it('reports AMBIGUITY instead of picking an app when two publish the same URI', () => {
        reg.setForApp('other', [{ uri: 'doc://current' }]);
        const { resource, error, candidates } = resolveResource('doc://current', reg);
        expect(resource).toBe(null);
        expect(error).toBe('ambiguous');
        expect(candidates.map(c => c.app).sort()).toEqual(['jheditor', 'other']);
    });

    it('reports not-found for an unknown URI, and for the wrong app', () => {
        expect(resolveResource('doc://nope', reg).error).toBe('not-found');
        expect(resolveResource('task::doc://current', reg).error).toBe('not-found');
    });

    it('handles empty input and a missing registry', () => {
        expect(resolveResource('', reg).error).toBe('not-found');
        expect(resolveResource('doc://current', null).error).toBe('not-found');
    });
});

describe('contentsToText', () => {
    it('joins the text parts', () => {
        expect(contentsToText({ contents: [{ text: 'a' }, { text: 'b' }] })).toBe('a\n\nb');
    });

    it('names binary content instead of dumping base64 at the model', () => {
        const out = contentsToText({ contents: [{ blob: 'AAAA', mimeType: 'image/png' }] });
        expect(out).toContain('binary content omitted');
        expect(out).toContain('image/png');
        expect(out).not.toContain('AAAA');
    });

    it('truncates oversized documents and says so', () => {
        const out = contentsToText({ contents: [{ text: 'x'.repeat(500) }] }, 100);
        expect(out).toContain('truncated at 100 chars');
        expect(out.startsWith('x'.repeat(100))).toBe(true);
    });

    it('tolerates a malformed or empty result', () => {
        expect(contentsToText(null)).toBe('');
        expect(contentsToText({})).toBe('');
        expect(contentsToText({ contents: [{}, 'nope'] })).toBe('');
    });
});
