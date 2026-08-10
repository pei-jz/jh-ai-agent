// @vitest-environment jsdom
//
// The first-run wizard.
//
// The behaviours worth pinning are the ones that decide whether a new user gets in at
// all: that skip always works, that step 1 refuses to advance without a connection,
// and that it never asks for something it already has.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Onboarding from '../Onboarding.svelte';

afterEach(() => cleanup());

const setup = (over = {}) => ({ hasConnection: false, hasWorkspace: false, skipped: false, ...over });
const mount = (props = {}) => render(Onboarding, { props: { setup: setup(), ...props } }).container;
const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const pick = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };

describe('Onboarding — the frame', () => {
    it('shows all three steps and marks the current one', () => {
        const el = mount({ step: 1 });
        const items = [...el.querySelectorAll('.ob-rail-item')];
        expect(items).toHaveLength(3);
        expect(items[1].classList.contains('is-current')).toBe(true);
        expect(items[0].classList.contains('is-done')).toBe(true);
    });

    it('counts the steps', () => {
        expect(mount({ step: 0 }).querySelector('.ob-count').textContent).toBe('1 / 3');
    });

    it('ALWAYS offers a way out', () => {
        // A setup wizard that traps you is worse than no wizard.
        const onSkip = vi.fn();
        mount({ onSkip }).querySelector('.ob-skip').click();
        expect(onSkip).toHaveBeenCalled();
    });

    it('cannot go back from the first step', () => {
        const buttons = [...mount({ step: 0 }).querySelectorAll('.ob-foot button')];
        expect(buttons[0].disabled).toBe(true);
    });
});

describe('Onboarding — step 1, the connection', () => {
    it('offers every provider', () => {
        const opts = [...mount().querySelector('#ob-provider').options].map(o => o.value);
        expect(opts).toEqual(['openai', 'anthropic', 'gemini', 'azure', 'ollama', 'generic']);
    });

    it('REFUSES to advance without a connection', () => {
        // Advancing would only postpone the same dead end.
        const next = [...mount({ step: 0, setup: setup() }).querySelectorAll('.ob-foot button')][1];
        expect(next.disabled).toBe(true);
    });

    it('allows advancing once one exists', () => {
        const next = [...mount({ step: 0, setup: setup({ hasConnection: true }) }).querySelectorAll('.ob-foot button')][1];
        expect(next.disabled).toBe(false);
    });

    it('says so when the connection is already set, instead of asking again', () => {
        expect(mount({ step: 0, setup: setup({ hasConnection: true }) }).querySelector('.ob-ok')).not.toBe(null);
    });

    it('disables the key field and explains for a keyless provider', async () => {
        const el = mount();
        pick(el.querySelector('#ob-provider'), 'ollama');
        await tick();
        expect(el.querySelector('#ob-key').disabled).toBe(true);
        expect(el.textContent).toContain('APIキーは不要');
    });

    it('suggests the model and URL when a provider is picked', async () => {
        const el = mount();
        pick(el.querySelector('#ob-provider'), 'anthropic');
        await tick();
        expect(el.querySelector('#ob-url').value).toBe('https://api.anthropic.com/v1');
        expect(el.querySelector('#ob-model').placeholder).toBe('claude-3-5-sonnet-20241022');
    });

    it('refuses to save an incomplete connection, and says what is missing', async () => {
        const onSaveConnection = vi.fn();
        const el = mount({ onSaveConnection });
        el.querySelector('.ob-actions .btn-primary').click();
        await tick();
        expect(onSaveConnection).not.toHaveBeenCalled();
        expect(el.querySelector('.cfg-modal-errors').textContent).toMatch(/Model|API key/);
    });

    it('saves a complete connection, defaulting the name', async () => {
        const onSaveConnection = vi.fn();
        const el = mount({ onSaveConnection });
        type(el.querySelector('#ob-model'), 'gpt-4o');
        type(el.querySelector('#ob-key'), 'sk-x');
        await tick();
        el.querySelector('.ob-actions .btn-primary').click();
        expect(onSaveConnection).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'openai', model: 'gpt-4o', api_key: 'sk-x', name: 'OPENAI Connection',
        }));
    });

    it('runs a connection test on request, and shows the outcome', () => {
        const onTestConnection = vi.fn();
        const el = mount({ onTestConnection });
        el.querySelector('.ob-actions .btn-secondary').click();
        expect(onTestConnection).toHaveBeenCalled();
        cleanup();
        const ok = mount({ testStatus: { state: 'ok', message: '✅ 接続できました。' } });
        expect(ok.querySelector('.cfg-test-status').classList.contains('is-ok')).toBe(true);
    });

    it('disables the test button while a probe is in flight', () => {
        const el = mount({ testStatus: { state: 'testing', message: '…' } });
        expect(el.querySelector('.ob-actions .btn-secondary').disabled).toBe(true);
    });
});

describe('Onboarding — step 2, the workspace', () => {
    it('says a workspace is optional when none is set', () => {
        const el = mount({ step: 1, workspaces: [] });
        expect(el.textContent).toContain('このままでも動きます');
    });

    it('lists the folders already registered', () => {
        const el = mount({ step: 1, workspaces: ['C:/a', 'C:/b'] });
        expect([...el.querySelectorAll('.ob-ws-row code')].map(c => c.textContent)).toEqual(['C:/a', 'C:/b']);
    });

    it('picks and removes a folder', () => {
        const onPickWorkspace = vi.fn();
        const onRemoveWorkspace = vi.fn();
        const el = mount({ step: 1, workspaces: ['C:/a'], onPickWorkspace, onRemoveWorkspace });
        el.querySelector('.ob-actions .btn-secondary').click();
        expect(onPickWorkspace).toHaveBeenCalled();
        el.querySelector('.ob-ws-del').click();
        expect(onRemoveWorkspace).toHaveBeenCalledWith('C:/a');
    });

    it('lets the user move on without one', () => {
        const next = [...mount({ step: 1, setup: setup({ hasConnection: true }) }).querySelectorAll('.ob-foot button')][1];
        expect(next.disabled).toBe(false);
    });
});

describe('Onboarding — step 3, ready', () => {
    it('names what the agent can actually do, not just "done"', () => {
        const el = mount({ step: 2 });
        expect(el.textContent).toContain('資料を読ませる');
        expect(el.textContent).toContain('成果物を作らせる');
        expect(el.textContent).toContain('調べさせる');
        expect(el.textContent).toContain('定期実行');
    });

    it('points at Develop mode for code work', () => {
        // The default is now general, so a developer needs to be told where to switch.
        expect(mount({ step: 2 }).textContent).toContain('Develop');
    });

    it('finishes', () => {
        const onFinish = vi.fn();
        mount({ step: 2, onFinish }).querySelector('.ob-actions .btn-primary').click();
        expect(onFinish).toHaveBeenCalled();
    });

    it('offers no "next" on the last step', () => {
        const el = mount({ step: 2 });
        const nav = [...el.querySelectorAll('.ob-foot button')];
        expect(nav).toHaveLength(1);   // back only
    });
});

describe('Onboarding — navigation', () => {
    it('reports a step change rather than owning the step', () => {
        const onStep = vi.fn();
        const el = mount({ step: 1, setup: setup({ hasConnection: true }), onStep });
        const [back, next] = [...el.querySelectorAll('.ob-foot button')];
        next.click();
        expect(onStep).toHaveBeenCalledWith(2);
        back.click();
        expect(onStep).toHaveBeenCalledWith(0);
    });

    it('clamps to the real range', () => {
        const onStep = vi.fn();
        const el = mount({ step: 2, setup: setup({ hasConnection: true }), onStep });
        el.querySelector('.ob-foot button').click();   // back from the last step
        expect(onStep).toHaveBeenCalledWith(1);
    });
});
