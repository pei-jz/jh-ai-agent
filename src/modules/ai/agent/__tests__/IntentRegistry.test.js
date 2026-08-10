import { describe, it, expect, beforeEach } from 'vitest';
import { IntentRegistry, normalizeIntent, resolveIntent } from '../IntentRegistry.js';

describe('normalizeIntent', () => {
    it('keeps the declared fields and records the owning app', () => {
        const i = normalizeIntent({
            id: 'impact_analysis', title: '影響調査',
            systemPrompt: 'あなたは影響範囲を洗い出す', tools: ['grep_search', 'read_file'],
            resultKind: 'file-list', tier: 'DEEP',
        }, 'jheditor');
        expect(i).toMatchObject({
            id: 'impact_analysis', app: 'jheditor', title: '影響調査',
            tools: ['grep_search', 'read_file'], resultKind: 'file-list', tier: 'deep',
        });
    });

    it('requires an id', () => {
        expect(normalizeIntent({ title: 'no id' }, 'app')).toBe(null);
        expect(normalizeIntent({ id: '   ' }, 'app')).toBe(null);
        expect(normalizeIntent(null, 'app')).toBe(null);
        expect(normalizeIntent('a string', 'app')).toBe(null);
    });

    it('drops empty/garbage optional fields rather than carrying them', () => {
        const i = normalizeIntent({ id: 'x', title: '  ', tools: [1, '', 'ok'], resultKind: '' }, 'app');
        expect(i.title).toBeUndefined();
        expect(i.resultKind).toBeUndefined();
        expect(i.tools).toEqual(['ok']);
    });

    it('omits tools entirely when none survive', () => {
        expect(normalizeIntent({ id: 'x', tools: [1, 2] }, 'app').tools).toBeUndefined();
    });
});

describe('IntentRegistry', () => {
    let reg;
    beforeEach(() => { reg = new IntentRegistry(); });

    it('stores and looks up by id', () => {
        reg.setForApp('jheditor', [{ id: 'a', title: 'A' }, { id: 'b' }]);
        expect(reg.size).toBe(2);
        expect(reg.get('a').title).toBe('A');
        expect(reg.get('nope')).toBe(null);
    });

    it('ignores entries it cannot normalize', () => {
        expect(reg.setForApp('app', [{ id: 'ok' }, { noId: true }, null])).toBe(1);
    });

    it('REPLACES an app\'s set on reconnect — no stale entries after a redeploy', () => {
        reg.setForApp('app', [{ id: 'old' }, { id: 'kept' }]);
        reg.setForApp('app', [{ id: 'kept' }, { id: 'new' }]);
        expect(reg.get('old')).toBe(null);
        expect(reg.get('kept')).toBeTruthy();
        expect(reg.get('new')).toBeTruthy();
        expect(reg.size).toBe(2);
    });

    it('clearing one app leaves the others alone', () => {
        reg.setForApp('a', [{ id: 'a1' }]);
        reg.setForApp('b', [{ id: 'b1' }]);
        reg.clearApp('a');
        expect(reg.get('a1')).toBe(null);
        expect(reg.get('b1')).toBeTruthy();
    });

    it('clearing an unknown app is a no-op', () => {
        expect(reg.clearApp('never-registered')).toBe(0);
    });

    it('does not remove an id another app has since taken over', () => {
        reg.setForApp('a', [{ id: 'shared' }]);
        reg.setForApp('b', [{ id: 'shared' }]);   // b now owns it
        reg.clearApp('a');
        expect(reg.get('shared')?.app).toBe('b');
    });

    it('lists all intents, or just one app\'s', () => {
        reg.setForApp('a', [{ id: 'a1' }, { id: 'a2' }]);
        reg.setForApp('b', [{ id: 'b1' }]);
        expect(reg.list()).toHaveLength(3);
        expect(reg.list('a').map(i => i.id).sort()).toEqual(['a1', 'a2']);
    });

    it('rejects a registration with no app name', () => {
        expect(reg.setForApp('', [{ id: 'x' }])).toBe(0);
        expect(reg.size).toBe(0);
    });
});

describe('resolveIntent', () => {
    let reg;
    beforeEach(() => {
        reg = new IntentRegistry();
        reg.setForApp('jheditor', [{ id: 'impact', systemPrompt: 'find impact', resultKind: 'file-list' }]);
    });

    it('passes an inline object straight through (existing behaviour)', () => {
        const inline = { systemPrompt: 'ad hoc' };
        expect(resolveIntent(inline, reg)).toEqual({ intent: inline, source: 'inline' });
    });

    it('resolves a registered id — the case that used to be silently ignored', () => {
        const { intent, source } = resolveIntent('impact', reg);
        expect(source).toBe('registry');
        expect(intent.resultKind).toBe('file-list');
    });

    it('reports an unknown id instead of pretending it worked', () => {
        expect(resolveIntent('never-declared', reg)).toEqual({ intent: null, source: 'unknown' });
    });

    it('handles a missing registry', () => {
        expect(resolveIntent('impact', null).source).toBe('unknown');
    });

    it('treats absent/blank input as "no intent"', () => {
        expect(resolveIntent(null, reg).source).toBe('none');
        expect(resolveIntent(undefined, reg).source).toBe('none');
        expect(resolveIntent(123, reg).source).toBe('none');
    });
});
