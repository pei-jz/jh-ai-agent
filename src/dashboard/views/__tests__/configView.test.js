// @vitest-environment jsdom
//
// ConfigView.renderHtml — the tab shell, not the tab content (each tab's body is a
// Svelte component with its own tests).
//
// The regression that prompted this file: CONFIG_SECTION_STYLES was emitted INSIDE
// the General tab's branch, so every .cfg-* rule — which the Memory / RAG /
// Templates / Skills tabs are built entirely out of — only existed while General
// happened to be the active tab. Opening Settings straight on Memory rendered it
// with no CSS at all.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../../../modules/ai/PromptTemplateManager.js', () => ({
    promptTemplateManager: { list: () => [], listTemplates: async () => [], toConfigValue: () => ({}) },
}));
vi.mock('../../../modules/ai/SkillManager.js', () => ({
    skillManager: { list: () => [], listSkills: async () => [] },
}));
vi.mock('../../license.js', () => ({
    licenseState: { subscribe: () => () => {} },
    hasStoredKey: () => false,
    activateLicense: vi.fn(),
    clearLicense: vi.fn(),
    licensingConfigured: () => false,
    refreshLicense: vi.fn(),
}));

const { ConfigView } = await import('../ConfigView.js');

const TABS = ['llm', 'mcp', 'general', 'templates', 'skills', 'rag', 'memory'];

let v;
beforeEach(() => {
    document.body.innerHTML = '';
    invoke.mockClear();
    invoke.mockImplementation(async () => null);
    v = new ConfigView();
});

const callsTo = (cmd) => invoke.mock.calls.filter(c => c[0] === cmd);
const order = () => invoke.mock.calls.map(c => c[0]);

describe('tab styles', () => {
    it.each(TABS)('emits the .cfg-* section styles on the %s tab', (tab) => {
        v.activeTab = tab;
        const html = v.renderHtml();
        // A rule from each of the two blocks — the Memory tab's box and the
        // connection table's column, so neither can silently go tab-local again.
        expect(html).toContain('.cfg-mem-box');
        expect(html).toContain('.cfg-col-default');
    });

    it('mounts the memory panel host when the memory tab is active', () => {
        v.activeTab = 'memory';
        expect(v.renderHtml()).toContain('id="cfg-memory-panel"');
    });
});

// The UI's "(not set)" option for a routing tier sends an EMPTY STRING, because
// the backend's field-wise merge reads `null` as "the caller didn't mention this
// field" and restores the previous value. persistConfig used `||` here, which
// collapsed "" back to null and re-saved the model the user had just cleared —
// the reported symptom: "(not set)" cannot be chosen.
describe('routing tiers on the wire', () => {
    beforeEach(() => {
        window.apiClient = { updateConfig: vi.fn(async () => {}), token: '', port: '1' };
        v.config = { ...v.config, llm_instances: [], mcp_text: '' };
    });

    const sent = () => window.apiClient.updateConfig.mock.calls[0][0];

    it('forwards the "" clear sentinel instead of collapsing it to null', async () => {
        v.config.fast_model_id = '';
        v.config.deep_model_id = '';
        await v.persistConfig();
        expect(sent().fast_model_id).toBe('');
        expect(sent().deep_model_id).toBe('');
    });

    it('still sends null when a tier was never set', async () => {
        await v.persistConfig();
        expect(sent().fast_model_id).toBeNull();
        expect(sent().deep_model_id).toBeNull();
    });

    it('passes a real selection through untouched', async () => {
        v.config.fast_model_id = 'i1:deepseek-v4-flash';
        v.config.deep_model_id = 'i2:kimi-k3';
        await v.persistConfig();
        expect(sent().fast_model_id).toBe('i1:deepseek-v4-flash');
        expect(sent().deep_model_id).toBe('i2:kimi-k3');
    });

    it('clears one tier without disturbing the other', async () => {
        v.config.fast_model_id = '';
        v.config.deep_model_id = 'i2:kimi-k3';
        await v.persistConfig();
        expect(sent().fast_model_id).toBe('');
        expect(sent().deep_model_id).toBe('i2:kimi-k3');
    });
});

// Editing memory writes into <workspace>/.agent, which the path guard only
// knows about for workspaces an AGENT SESSION has opened. Without registering
// it first, correcting a fact for a project the agent has not run in this app
// session failed outright: "outside all allowed roots".
describe('memory writes', () => {
    beforeEach(() => {
        v.memoryWorkspace = 'C:/ws';
        v.memoryFacts = [{ fact: 'a durable fact' }];
        v.memoryEpisodes = [{ topic: 't' }];
        v.memoryCards = [{ id: 'L-1', type: 'lesson' }];
    });

    it('registers .agent as a path-guard root BEFORE writing facts', async () => {
        await v.saveMemoryFacts();
        expect(callsTo('set_allowed_roots')[0][1]).toEqual({ roots: ['C:/ws/.agent'] });
        expect(order().indexOf('set_allowed_roots')).toBeLessThan(order().indexOf('write_file'));
        expect(callsTo('write_file')[0][1].path).toBe('C:/ws/.agent/long_term/facts.json');
    });

    it('does the same for episodes and cards', async () => {
        await v.saveMemoryEpisodes();
        expect(callsTo('set_allowed_roots')).toHaveLength(1);
        expect(callsTo('write_file')[0][1].path).toBe('C:/ws/.agent/memory.json');

        invoke.mockClear();
        await v.saveMemoryCards();
        expect(callsTo('set_allowed_roots')).toHaveLength(1);
        expect(callsTo('write_file')[0][1].path).toBe('C:/ws/.agent/memory/cards.jsonl');
    });

    it('grants only .agent, not the whole workspace', async () => {
        await v.saveMemoryFacts();
        expect(callsTo('set_allowed_roots')[0][1].roots).not.toContain('C:/ws');
    });

    it('still attempts the write when the backend has no such command', async () => {
        // An older backend would otherwise turn a recoverable save into a failure.
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'set_allowed_roots') throw new Error('no such command');
            return null;
        });
        await expect(v.saveMemoryFacts()).resolves.toBeUndefined();
        expect(callsTo('write_file')).toHaveLength(1);
    });

    it('strips a trailing separator from the workspace path', async () => {
        v.memoryWorkspace = 'C:/ws/';
        await v.saveMemoryFacts();
        expect(callsTo('set_allowed_roots')[0][1]).toEqual({ roots: ['C:/ws/.agent'] });
    });
});
