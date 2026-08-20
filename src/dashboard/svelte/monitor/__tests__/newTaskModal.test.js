// @vitest-environment jsdom
//
// The New Task dialog, after migration. The payload's rules are pinned in
// views/monitor/__tests__/newTaskRequest.test.js; this covers the wiring — what
// the user checks and types actually reaching that payload.
//
// Ported from views/__tests__/monitorView.test.js, which drove the imperative
// overlay by assigning to `.value` / `.checked` on markup the view had just
// built by hand.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const invoke = vi.fn(async () => null);
const startClient = vi.fn(async () => {});
const clients = new Map();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock('../../../../modules/ai/McpManager.js', () => ({
    mcpManager: { clients, startClient: (...a) => startClient(...a) },
}));
vi.mock('../../../../modules/ai/PromptTemplateManager.js', () => ({
    promptTemplateManager: { loadFromConfig: vi.fn(), search: vi.fn(() => []) },
}));
vi.mock('../../../../modules/ai/SkillManager.js', () => ({
    skillManager: { refresh: vi.fn(async () => {}), search: vi.fn(() => []), readContent: vi.fn(async () => '') },
}));

const NewTaskModal = (await import('../NewTaskModal.svelte')).default;

const CONFIG = {
    approved_projects: ['C:/work/proj'],
    mcp_servers: { backlog: { command: 'npx' }, er_app: { command: 'npx' } },
};

afterEach(() => cleanup());
beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? CONFIG : null));
    startClient.mockClear();
    clients.clear();
});

function mountModal(props = {}) {
    const api = { request: vi.fn(async () => ({ task_id: 'T-NEW' })) };
    const notify = vi.fn();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const utils = render(NewTaskModal, { props: { api, notify, onCreated, onClose, ...props } });
    return { ...utils, api, notify, onCreated, onClose };
}

const sendBtn = (c) => c.querySelector('.nt-send');
const type = (el, value) => fireEvent.input(el, { target: { value } });

/** Fill in the two required fields and press Create. */
async function fillAndSend(h, { prompt = 'run the analysis', ws = 'C:/work/proj' } = {}) {
    await waitFor(() => expect(h.container.querySelector('#nt-ws')).toBeTruthy());
    await type(h.container.querySelector('#nt-ws'), ws);
    await type(h.container.querySelector('#nt-prompt'), prompt);
    await fireEvent.click(sendBtn(h.container));
}

const bodyOf = (api) => JSON.parse(api.request.mock.calls[0][1].body);

describe('the form', () => {
    it('offers the configured workspaces and every agent mode', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('#nt-ws').value).toBe('C:/work/proj'));
        expect(h.container.querySelectorAll('.nt-mode-btn').length).toBeGreaterThan(0);
        expect(h.container.querySelector('.nt-mode-btn.sel')).toBeTruthy();
    });

    it('shows the selected mode description, and swaps it on click', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-mode-desc').textContent.trim()).not.toBe(''));
        const first = h.container.querySelector('.nt-mode-desc').textContent;
        const other = [...h.container.querySelectorAll('.nt-mode-btn')].find(b => !b.classList.contains('sel'));
        if (!other) return;
        await fireEvent.click(other);
        await waitFor(() => expect(h.container.querySelector('.nt-mode-desc').textContent).not.toBe(first));
        expect(other.classList.contains('sel')).toBe(true);
    });

    // An explicit workspace — the "＋" on a workspace group header — has to beat
    // both the remembered choice and the first configured project.
    it('lets an explicit workspace win over the remembered one', async () => {
        const h = mountModal({ presetWs: 'D:/other', lastWs: 'C:/remembered' });
        await waitFor(() => expect(h.container.querySelector('#nt-ws').value).toBe('D:/other'));
    });

    it('falls back to the remembered workspace, then to the first project', async () => {
        const a = mountModal({ lastWs: 'C:/remembered' });
        await waitFor(() => expect(a.container.querySelector('#nt-ws').value).toBe('C:/remembered'));
        cleanup();
        const b = mountModal();
        await waitFor(() => expect(b.container.querySelector('#nt-ws').value).toBe('C:/work/proj'));
    });

    it('arrives pre-filled from the Dashboard launcher', async () => {
        const h = mountModal({ presetPrompt: 'do the thing' });
        await waitFor(() => expect(h.container.querySelector('#nt-prompt').value).toBe('do the thing'));
    });

    it('says so when no MCP servers are configured', async () => {
        invoke.mockImplementation(async () => ({ approved_projects: [], mcp_servers: {} }));
        const h = mountModal();
        await waitFor(() => expect(h.container.textContent).toMatch(/No MCP servers configured/));
    });
});

describe('creating a task', () => {
    it('sends the prompt, workspace and caller', async () => {
        const h = mountModal();
        await fillAndSend(h);
        await waitFor(() => expect(h.api.request).toHaveBeenCalledTimes(1));
        expect(bodyOf(h.api)).toMatchObject({
            prompt: 'run the analysis', workspace_path: 'C:/work/proj', caller: 'NewTask',
        });
    });

    it('passes the checked servers as behavior.mcp_servers', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]'));
        await fillAndSend(h);
        await waitFor(() => expect(h.api.request).toHaveBeenCalled());
        expect(bodyOf(h.api).behavior.mcp_servers).toEqual(['backlog']);
    });

    // Omitting the list entirely means "all servers" on the agent side, so a
    // server connecting mid-task — Chat starts its own asynchronously — would
    // leak its tools into later turns. Unchecked must mean an explicit [].
    it('sends an EXPLICIT empty mcp_servers when nothing is checked', async () => {
        const h = mountModal();
        await fillAndSend(h);
        await waitFor(() => expect(h.api.request).toHaveBeenCalled());
        const body = bodyOf(h.api);
        expect(body.behavior.mcp_servers).toEqual([]);
        // …and the built-in toolset is intact, so the run stays interactive.
        expect(body.behavior.mode).toBe('iterative_agent');
    });

    it('starts a checked server that is not running yet', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]'));
        await fillAndSend(h);
        await waitFor(() => expect(startClient).toHaveBeenCalledWith('backlog', { command: 'npx' }));
    });

    // A server that refuses to start must not block the task from being created.
    it('creates the task even when a server fails to start', async () => {
        startClient.mockRejectedValueOnce(new Error('spawn failed'));
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.nt-mcp-cb[data-name="backlog"]'));
        await fillAndSend(h);
        await waitFor(() => expect(h.api.request).toHaveBeenCalled());
    });

    it('hands the new task id back so the view can navigate to it', async () => {
        const h = mountModal();
        await fillAndSend(h);
        await waitFor(() => expect(h.onCreated).toHaveBeenCalledWith('T-NEW', {
            workspace: 'C:/work/proj', modeId: expect.any(String),
        }));
    });

    it('does not swallow an API failure — it reports it', async () => {
        const h = mountModal();
        h.api.request.mockRejectedValueOnce(new Error('boom'));
        await fillAndSend(h);
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('boom')));
        expect(h.onCreated).not.toHaveBeenCalled();
    });

    // A failed create has to leave the button usable, or the dialog is a dead end.
    it('re-enables Create after a failure', async () => {
        const h = mountModal();
        h.api.request.mockRejectedValueOnce(new Error('boom'));
        await fillAndSend(h);
        await waitFor(() => expect(h.notify).toHaveBeenCalled());
        await waitFor(() => expect(sendBtn(h.container).disabled).toBe(false));
    });
});

describe('validation', () => {
    // An agent task with nowhere to work is accepted by the server and then
    // fails on its first tool.
    it('refuses to send without a workspace, and says why', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('#nt-ws')).toBeTruthy());
        await type(h.container.querySelector('#nt-ws'), '');
        await type(h.container.querySelector('#nt-prompt'), 'something');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/workspace/i)));
        expect(h.api.request).not.toHaveBeenCalled();
    });

    it('refuses to send an empty task without nagging about the workspace', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('#nt-prompt')).toBeTruthy());
        await fireEvent.click(sendBtn(h.container));
        expect(h.api.request).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
    });
});

describe('dismissal', () => {
    it('closes from Cancel, from ✖ and from the backdrop', async () => {
        for (const sel of ['.nt-cancel', '.nt-close']) {
            const h = mountModal();
            await waitFor(() => expect(h.container.querySelector(sel)).toBeTruthy());
            await fireEvent.click(h.container.querySelector(sel));
            expect(h.onClose).toHaveBeenCalled();
            cleanup();
        }
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-overlay')).toBeTruthy());
        await fireEvent.mouseDown(h.container.querySelector('.nt-overlay'));
        expect(h.onClose).toHaveBeenCalled();
    });

    it('does not close when the dialog itself is clicked', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('.nt-modal-box')).toBeTruthy());
        await fireEvent.mouseDown(h.container.querySelector('.nt-modal-box'));
        expect(h.onClose).not.toHaveBeenCalled();
    });

    it('creates on Ctrl+Enter and closes on Escape', async () => {
        const h = mountModal();
        await waitFor(() => expect(h.container.querySelector('#nt-prompt')).toBeTruthy());
        await type(h.container.querySelector('#nt-ws'), 'C:/work/proj');
        await type(h.container.querySelector('#nt-prompt'), 'go');
        await fireEvent.keyDown(h.container.querySelector('#nt-prompt'), { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(h.api.request).toHaveBeenCalled());

        await fireEvent.keyDown(h.container.querySelector('#nt-prompt'), { key: 'Escape' });
        expect(h.onClose).toHaveBeenCalled();
    });
});
