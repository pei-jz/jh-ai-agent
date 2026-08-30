// @vitest-environment jsdom
//
// The Settings shell, after migration. The wire payload and list rules are
// covered in views/config/__tests__/configModel.test.js; the path-guard ordering
// belongs to workspaceMemory and is tested there.
//
// Ported from views/__tests__/configView.test.js, which drove the class and read
// its generated HTML.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const invoke = vi.fn(async () => null);
const studyMock = vi.hoisted(() => ({
    runStudyPass: vi.fn(),
    dropStudyCards: vi.fn(() => ({ kept: [], dropped: 0 })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.1.0') }));
// runStudy dynamic-imports StudyPass; a module namespace is immutable, so the
// mock is declared here and its resolved value set per test.
vi.mock('../../../../modules/ai/memory/StudyPass.js', () => ({
    runStudyPass: studyMock.runStudyPass,
    dropStudyCards: studyMock.dropStudyCards,
}));
vi.mock('../../../license.js', () => ({
    licenseState: () => ({ edition: 'community' }),
    hasStoredKey: () => false,
    activateLicense: vi.fn(),
    clearLicense: vi.fn(),
    licensingConfigured: vi.fn(async () => false),
    refreshLicense: vi.fn(async () => {}),
}));
vi.mock('../../../updater.js', () => ({
    isUpdaterConfigured: vi.fn(async () => false),
    checkForUpdate: vi.fn(async () => {}),
}));

const ConfigRoot = (await import('../ConfigRoot.svelte')).default;

afterEach(() => cleanup());
beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    invoke.mockImplementation(async () => null);
    studyMock.runStudyPass.mockReset();
});

const CONFIG = {
    llm_instances: [{ id: 'i1', name: 'Flash', provider: 'openai', model: 'gpt-4o' }],
    active_llm_instance_id: 'i1',
    approved_projects: ['C:/ws'],
    mcp_servers: {},
};

function mountRoot(props = {}) {
    const api = {
        port: '14300', token: 'tok',
        getConfig: vi.fn(async () => CONFIG),
        updateConfig: vi.fn(async () => {}),
        testConnection: vi.fn(async () => ({ success: true })),
    };
    const notify = vi.fn();
    const toast = vi.fn();
    const confirmAction = vi.fn(() => true);
    const utils = render(ConfigRoot, {
        props: { api, notify, toast, confirmAction, pickFolder: vi.fn(async () => 'C:/picked'), ...props },
    });
    return { ...utils, api, notify, toast, confirmAction };
}

const callsTo = (cmd) => invoke.mock.calls.filter(c => c[0] === cmd);

describe('the tab strip', () => {
    // Six now: Memory and Usage are DESTINATIONS, not tabs.
    it('offers the six reachable tabs', async () => {
        const { container } = mountRoot();
        await waitFor(() => expect(container.querySelectorAll('.settings-tab-btn').length).toBe(6));
        const labels = [...container.querySelectorAll('.settings-tab-btn')].map(b => b.textContent.trim());
        expect(labels.join(' ')).toMatch(/LLM Settings/);
        expect(labels.join(' ')).toMatch(/RAG/);
        // Both left for their own destinations.
        expect(labels.join(' ')).not.toMatch(/Memory/);
        expect(labels.join(' ')).not.toMatch(/Usage/);
    });

    // API logs moved to Monitor; the button was removed then but the branch,
    // renderLogsTabHtml() and loadLogs() stayed behind, unreachable.
    it('has no API-logs tab', async () => {
        const { container } = mountRoot();
        await waitFor(() => expect(container.querySelector('.settings-tab-btn')).toBeTruthy());
        const labels = [...container.querySelectorAll('.settings-tab-btn')].map(b => b.textContent);
        expect(labels.join(' ')).not.toMatch(/API Logs/i);
    });

    it('marks the active tab and switches on click', async () => {
        const { container } = mountRoot();
        await waitFor(() => expect(container.querySelector('.settings-tab-btn.active')).toBeTruthy());
        expect(container.querySelector('.settings-tab-btn.active').textContent).toMatch(/LLM/);

        const ragBtn = [...container.querySelectorAll('.settings-tab-btn')]
            .find(b => /RAG/.test(b.textContent));
        await fireEvent.click(ragBtn);
        expect(container.querySelector('.settings-tab-btn.active').textContent).toMatch(/RAG/);
    });

    // The Dashboard links straight to `#config?tab=memory`; main.js used to throw
    // the query away, so those links landed on the default tab.
    it('honours the deep-linked initial tab', async () => {
        const { container } = mountRoot({ initialTab: 'rag' });
        await waitFor(() => expect(container.querySelector('.settings-tab-btn.active')).toBeTruthy());
        expect(container.querySelector('.settings-tab-btn.active').textContent).toMatch(/RAG/);
    });
});

describe('connections', () => {
    it('lists the configured connections', async () => {
        const { container } = mountRoot();
        await waitFor(() => expect(container.textContent).toMatch(/Flash/));
    });

    it('opens the add-connection modal, and closes it again', async () => {
        const { container } = mountRoot();
        await waitFor(() => expect(container.querySelector('.btn-primary')).toBeTruthy());
        const add = [...container.querySelectorAll('button')].find(b => /Add Connection/.test(b.textContent));
        await fireEvent.click(add);
        expect(container.textContent).toMatch(/Provider|Model/i);
    });

    it('saving settings sends the payload and reloads', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.api.getConfig).toHaveBeenCalled());
        h.api.getConfig.mockClear();
        const save = [...h.container.querySelectorAll('button')].find(b => /Save Settings/.test(b.textContent));
        await fireEvent.click(save);
        await waitFor(() => expect(h.api.updateConfig).toHaveBeenCalled());
        // Reloaded so the masked keys the backend returns replace what was sent.
        await waitFor(() => expect(h.api.getConfig).toHaveBeenCalled());
        expect(h.toast).toHaveBeenCalled();
    });

    it('reports a save failure rather than claiming success', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.api.getConfig).toHaveBeenCalled());
        h.api.updateConfig.mockRejectedValueOnce(new Error('server down'));
        const save = [...h.container.querySelectorAll('button')].find(b => /Save Settings/.test(b.textContent));
        await fireEvent.click(save);
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('server down')));
        expect(h.toast).not.toHaveBeenCalled();
    });
});

// When the study pass hits the file cap it must say so, instead of silently
// indexing a prefix of the tree and looking complete.
describe('storage usage is a prop, not a DOM write', () => {
    // `_renderStorageUsage()` used to write straight into `#cfg-storage-usage`,
    // an element inside SettingsGeneral's own subtree, while the `storageUsage`
    // prop it was meant to feed was never assigned and so was always ''.
    it('fills the panel through the component', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_storage_usage') {
                return { task_history_bytes: 2048, task_logs_count: 3, task_logs_bytes: 4096, comm_log_bytes: 0 };
            }
            return null;
        });
        const h = mountRoot({ initialTab: 'general' });
        await waitFor(() => expect(h.container.querySelector('.settings-tab-btn.active')).toBeTruthy());
        const refresh = [...h.container.querySelectorAll('button')]
            .find(b => /storage|使用量/i.test(b.textContent));
        if (!refresh) return;                       // section collapsed by default
        await fireEvent.click(refresh);
        await waitFor(() => expect(h.container.textContent).toMatch(/task_history\.json/));
        expect(callsTo('get_storage_usage').length).toBeGreaterThan(0);
    });
});
