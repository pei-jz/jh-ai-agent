// configModel — the settings rules, out of the view.
//
// Ported from views/__tests__/configView.test.js, which asserted the wire shape
// by driving `persistConfig()` on a live ConfigView and reading the mocked
// `updateConfig` call. The payload is a pure function of the config now.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    CONFIG_TABS, APPROVED_COMMANDS_KEY, AUTO_APPROVE_WS_KEY,
    readList, writeList, addToList, removeFromList,
    readOpenSections, writeOpenSection,
    limitValue, resolveActiveInstanceId, buildConfigPayload, applyConfigPatch,
    upsertInstance, removeInstance,
} from '../configModel.js';

const base = (over = {}) => ({ llm_instances: [], mcp_text: '', ...over });

beforeEach(() => {
    const store = new Map();
    globalThis.localStorage = {
        get length() { return store.size; },
        key: (i) => [...store.keys()][i],
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
    };
});

describe('CONFIG_TABS', () => {
    it('lists the seven reachable tabs, in order', () => {
        expect(CONFIG_TABS.map(t => t.id))
            .toEqual(['llm', 'mcp', 'general', 'templates', 'skills', 'rag', 'memory']);
    });

    // API logs moved to Monitor (per-task raw payloads); the tab button was
    // removed then, but renderLogsTabHtml() and its branch stayed behind for
    // months with nothing able to reach them.
    it('has no logs tab — that moved to Monitor', () => {
        expect(CONFIG_TABS.map(t => t.id)).not.toContain('logs');
    });

    it('gives every tab an icon and a label', () => {
        for (const t of CONFIG_TABS) {
            expect(t.icon, t.id).toBeTruthy();
            expect(t.label, t.id).toBeTruthy();
        }
    });
});

// The UI's "(not set)" option for a routing tier sends an EMPTY STRING, because
// the backend's field-wise merge reads `null` as "the caller didn't mention this
// field" and restores the previous value. persistConfig used `||` here, which
// collapsed "" back to null and re-saved the model the user had just cleared.
describe('routing tiers on the wire', () => {
    const sent = (over) => buildConfigPayload(base(over), {});

    it('forwards the "" clear sentinel instead of collapsing it to null', () => {
        const p = sent({ fast_model_id: '', deep_model_id: '' });
        expect(p.fast_model_id).toBe('');
        expect(p.deep_model_id).toBe('');
    });

    it('still sends null when a tier was never set', () => {
        const p = sent({});
        expect(p.fast_model_id).toBeNull();
        expect(p.deep_model_id).toBeNull();
    });

    it('passes a real selection through untouched', () => {
        const p = sent({ fast_model_id: 'i1:deepseek-v4-flash', deep_model_id: 'i2:kimi-k3' });
        expect(p.fast_model_id).toBe('i1:deepseek-v4-flash');
        expect(p.deep_model_id).toBe('i2:kimi-k3');
    });

    it('clears one tier without disturbing the other', () => {
        const p = sent({ fast_model_id: '', deep_model_id: 'i2:kimi-k3' });
        expect(p.fast_model_id).toBe('');
        expect(p.deep_model_id).toBe('i2:kimi-k3');
    });
});

describe('buildConfigPayload', () => {
    it('parses the MCP text into an object', () => {
        const p = buildConfigPayload(base({ mcp_text: '{"a":{"command":"x"}}' }), {});
        expect(p.mcp_servers).toEqual({ a: { command: 'x' } });
    });

    it('throws a NAMED error on invalid MCP JSON rather than saving junk', () => {
        expect(() => buildConfigPayload(base({ mcp_text: '{oops' }), {}))
            .toThrow(/Invalid MCP configuration JSON/);
    });

    it('treats empty MCP text as no servers', () => {
        expect(buildConfigPayload(base({ mcp_text: '' }), {}).mcp_servers).toEqual({});
    });

    it('sends the agent defaults the backend expects', () => {
        const p = buildConfigPayload(base(), {});
        expect(p.plan_mode).toBe('auto');
        expect(p.memory_recall).toBe('on');
        expect(p.phase_routing).toBe('off');
        expect(p.episode_injection).toBe('off');
        expect(p.output_language).toBe('Japanese');
    });

    it('carries the prompt templates it was handed', () => {
        expect(buildConfigPayload(base(), { greet: {} }).prompt_templates).toEqual({ greet: {} });
    });

    it('turns an empty secret into null so the backend keeps the stored one', () => {
        expect(buildConfigPayload(base({ openai_key: '' }), {}).openai_key).toBeNull();
    });
});

describe('limitValue', () => {
    // 0 is sent EXPLICITLY (not null) when the user chose "disabled/unlimited",
    // so the backend stores the intent rather than restoring the old number.
    it('keeps an explicit 0', () => {
        expect(limitValue(0)).toBe(0);
        expect(limitValue('0')).toBe(0);
    });

    it('is null for missing values', () => {
        expect(limitValue(null)).toBeNull();
        expect(limitValue(undefined)).toBeNull();
    });

    it('is null for junk and negatives rather than guessing', () => {
        expect(limitValue('abc')).toBeNull();
        expect(limitValue(-5)).toBeNull();
    });

    it('parses a real number', () => {
        expect(limitValue('300')).toBe(300);
    });
});

describe('resolveActiveInstanceId', () => {
    const a = { id: 'i1' }, b = { id: 'i2' };

    it('promotes the first instance when none is set', () => {
        expect(resolveActiveInstanceId([a, b], null)).toBe('i1');
    });

    it('keeps a valid selection', () => {
        expect(resolveActiveInstanceId([a, b], 'i2')).toBe('i2');
    });

    // Otherwise deleting the active connection leaves the agent pointing at
    // something that no longer exists.
    it('re-promotes when the stored id no longer matches anything', () => {
        expect(resolveActiveInstanceId([a, b], 'gone')).toBe('i1');
    });

    it('is null when there are no instances', () => {
        expect(resolveActiveInstanceId([], 'x')).toBeNull();
        expect(resolveActiveInstanceId(undefined, null)).toBeNull();
    });
});

describe('instance list edits', () => {
    it('adds a new connection and names it after the provider when unnamed', () => {
        const r = upsertInstance([], { provider: 'openai', model: 'gpt' }, null);
        expect(r.instances).toHaveLength(1);
        expect(r.instances[0].name).toBe('openai Connection');
        expect(r.instances[0].id).toMatch(/^inst_/);
    });

    it('makes the FIRST connection the default', () => {
        const r = upsertInstance([], { provider: 'openai', model: 'gpt' }, null);
        expect(r.activeId).toBe(r.instances[0].id);
    });

    it('does not steal the default from an existing choice', () => {
        const r = upsertInstance([{ id: 'i1' }], { provider: 'x', model: 'm' }, 'i1');
        expect(r.activeId).toBe('i1');
    });

    it('updates in place when the id already exists', () => {
        const r = upsertInstance([{ id: 'i1', model: 'old', name: 'Mine' }], { id: 'i1', model: 'new' }, 'i1');
        expect(r.instances).toHaveLength(1);
        expect(r.instances[0].model).toBe('new');
        expect(r.instances[0].name).toBe('Mine');
    });

    it('does not mutate the list it was given', () => {
        const list = [{ id: 'i1' }];
        upsertInstance(list, { provider: 'x', model: 'm' }, 'i1');
        expect(list).toHaveLength(1);
    });

    it('removing clears the active id only when it was the one removed', () => {
        expect(removeInstance([{ id: 'i1' }, { id: 'i2' }], 'i1', 'i1').activeId).toBeNull();
        expect(removeInstance([{ id: 'i1' }, { id: 'i2' }], 'i1', 'i2').activeId).toBe('i2');
    });
});

describe('applyConfigPatch', () => {
    it('folds values in', () => {
        expect(applyConfigPatch({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    });

    // The secret normalizer uses `undefined` to mean "leave the stored value
    // alone" — folding it in would overwrite a real key with nothing.
    it('SKIPS undefined so a masked secret is not clobbered', () => {
        expect(applyConfigPatch({ openai_key: 'sk-real' }, { openai_key: undefined }))
            .toEqual({ openai_key: 'sk-real' });
    });

    it('does keep an explicit null (an intentional clear)', () => {
        expect(applyConfigPatch({ log_dir: 'C:/x' }, { log_dir: null }).log_dir).toBeNull();
    });

    it('returns a NEW object', () => {
        const c = { a: 1 };
        expect(applyConfigPatch(c, { a: 2 })).not.toBe(c);
        expect(c.a).toBe(1);
    });
});

describe('localStorage-backed allowlists', () => {
    const classify = vi.fn(() => 'normal');

    it('round-trips a list', () => {
        writeList(APPROVED_COMMANDS_KEY, ['git status *']);
        expect(readList(APPROVED_COMMANDS_KEY)).toEqual(['git status *']);
    });

    it('reads corrupt storage as empty rather than throwing', () => {
        localStorage.setItem(AUTO_APPROVE_WS_KEY, '{not json');
        expect(readList(AUTO_APPROVE_WS_KEY)).toEqual([]);
    });

    it('adds without duplicating', () => {
        addToList(AUTO_APPROVE_WS_KEY, 'C:/ws', classify);
        const r = addToList(AUTO_APPROVE_WS_KEY, 'C:/ws', classify);
        expect(r.list).toEqual(['C:/ws']);
    });

    it('removes', () => {
        writeList(AUTO_APPROVE_WS_KEY, ['a', 'b']);
        expect(removeFromList(AUTO_APPROVE_WS_KEY, 'a')).toEqual(['b']);
    });

    // A safety boundary: the rule must hold wherever a pattern is added from.
    it('REFUSES a dangerous command pattern, and stores nothing', () => {
        const dangerous = vi.fn(() => 'dangerous');
        const r = addToList(APPROVED_COMMANDS_KEY, 'rm -rf *', dangerous);
        expect(r.ok).toBe(false);
        expect(r.reason).toBeTruthy();
        expect(readList(APPROVED_COMMANDS_KEY)).toEqual([]);
    });

    it('applies the refusal ONLY to the command list', () => {
        const dangerous = vi.fn(() => 'dangerous');
        expect(addToList(AUTO_APPROVE_WS_KEY, 'C:/anything', dangerous).ok).toBe(true);
    });
});

describe('open sections', () => {
    it('starts empty and remembers a toggle', () => {
        expect(readOpenSections()).toEqual({});
        writeOpenSection('safety', true);
        expect(readOpenSections()).toEqual({ safety: true });
    });

    it('keeps other sections when one changes', () => {
        writeOpenSection('safety', true);
        writeOpenSection('paths', false);
        expect(readOpenSections()).toEqual({ safety: true, paths: false });
    });

    it('reads corrupt storage as empty', () => {
        localStorage.setItem('jhai_settings_sections', 'nope');
        expect(readOpenSections()).toEqual({});
    });
});
