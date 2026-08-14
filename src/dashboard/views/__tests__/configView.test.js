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
const studyMock = vi.hoisted(() => ({
    runStudyPass: vi.fn(),
    dropStudyCards: vi.fn(() => ({ kept: [], dropped: 0 })),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
// _runStudy dynamic-imports StudyPass; the module namespace is immutable, so the
// mock is declared here and the stub's resolved value is set per test.
vi.mock('../../../modules/ai/memory/StudyPass.js', () => ({
    runStudyPass: studyMock.runStudyPass,
    dropStudyCards: studyMock.dropStudyCards,
}));
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

// The Memory tab's Save button used to call `this._saveOverview(...)` — a method
// that DID NOT EXIST (only `_writeOverview`, the study-pass generator, did). The
// click threw and the edit was silently dropped: the reported "概観ノート保存
// ボタンが動作しない". The method is the manual-edit counterpart of the study
// pass: same write path, user-supplied text, fresh timestamp, immediate refresh.
describe('overview note load (regression: it vanished after Load)', () => {
    beforeEach(() => {
        v.memoryWorkspace = 'C:/ws';
        invoke.mockClear();
    });

    it('reads the overview file back so the note survives a Load', async () => {
        // readWorkspaceMemory (facts/episodes/cards) first, then read_file for
        // .agent/memory/overview.md. Missing file must not throw.
        invoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'read_file' && args?.path === 'C:/ws/.agent/memory/overview.md') {
                return '<!-- generated: 2026-08-13T00:00:00.000Z -->\n- the project is a dashboard\n';
            }
            return null;
        });
        await v.loadMemoryData();
        expect(v.memoryOverview?.text).toContain('the project is a dashboard');
        expect(v.memoryOverview?.generatedAt).toBe('2026-08-13T00:00:00.000Z');
    });

    it('yields an empty note (not an error) when the file is missing', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'read_file') throw new Error('no such file');
            return null;
        });
        await v.loadMemoryData();
        expect(v.memoryOverview).toEqual({ text: '', generatedAt: '', head: '', conventions: null });
    });
});

describe('overview note manual save', () => {
    beforeEach(() => {
        v.memoryWorkspace = 'C:/ws';
        invoke.mockClear();
    });

    it('persists the edited text to .agent/memory/overview.md with a fresh stamp', async () => {
        await v._saveOverview('- corrected orientation');
        const wf = callsTo('write_file');
        expect(wf).toHaveLength(1);
        expect(wf[0][1].path).toBe('C:/ws/.agent/memory/overview.md');
        expect(wf[0][1].content).toContain('<!-- generated: ');
        expect(wf[0][1].content).toContain('- corrected orientation');
    });

    it('registers .agent with the path guard before writing (same as other memory)', async () => {
        await v._saveOverview('text');
        expect(callsTo('set_allowed_roots')[0][1]).toEqual({ roots: ['C:/ws/.agent'] });
        expect(order().indexOf('set_allowed_roots')).toBeLessThan(order().indexOf('write_file'));
    });

    it('updates the panel state so the saved text shows immediately', async () => {
        await v._saveOverview('fresh text');
        expect(v.memoryOverview?.text).toBe('fresh text');
        expect(v.memoryOverview?.generatedAt).toBeTruthy();
    });

    it('is a no-op without a workspace (no crash, no write)', async () => {
        v.memoryWorkspace = '';
        await v._saveOverview('x');
        expect(callsTo('write_file')).toHaveLength(0);
    });

    it('surfaces a write failure instead of silently dropping the edit', async () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'write_file') throw new Error('disk full');
            return null;
        });
        await v._saveOverview('will fail');
        expect(alertSpy).toHaveBeenCalled();
        alertSpy.mockRestore();
    });
});

// When the study pass hits the file cap it says so, instead of silently
// indexing a prefix of the tree and looking complete.
describe('study pass capped warning', () => {
    beforeEach(() => {
        v.memoryWorkspace = 'C:/ws';
        invoke.mockClear();
        studyMock.runStudyPass.mockReset();
        // The overview step uses a model and is not what we are testing.
        v._writeOverview = vi.fn(async () => {});
    });

    it('warns when the pass was truncated or omitted files', async () => {
        studyMock.runStudyPass.mockResolvedValue({
            files: 800, symbols: 1200, edges: 300, sheets: 0,
            pruned: 0, total: 5000, omitted: 200, truncated: true,
            paths: [], areas: [],
        });
        await v._runStudy();
        // The ja catalog renders the cap notice with the totals; a prefix-only
        // pass must never look complete.
        expect(v._studyStatus).toContain('上限');
        expect(v._studyStatus).toContain('5000');
        expect(v._studyStatus).toContain('200');
    });

    it('does not warn when the whole tree was indexed', async () => {
        studyMock.runStudyPass.mockResolvedValue({
            files: 300, symbols: 900, edges: 200, sheets: 0,
            pruned: 0, total: 300, omitted: 0, truncated: false,
            paths: [], areas: [],
        });
        await v._runStudy();
        expect(v._studyStatus).not.toContain('上限');
    });
});
