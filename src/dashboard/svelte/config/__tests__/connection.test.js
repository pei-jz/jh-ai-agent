// @vitest-environment jsdom
//
// ConnectionTable / ConnectionModal — region 5 of the Svelte migration (the LLM tab).
//
// The modal is the clearest case in the whole migration: 14 fields that were
// written into a template literal and read back out with
// `getElementById('modal-inst-…').value`, plus imperative `style.display` toggling
// and JS relabelling when the provider changed. These tests assert the things that
// arrangement made impossible to check.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ConnectionTable from '../ConnectionTable.svelte';
import ConnectionModal from '../ConnectionModal.svelte';

afterEach(() => cleanup());

const inst = (over = {}) => ({
    id: 'inst_1', provider: 'openai', name: 'Prod', model: 'gpt-4o',
    api_key: 'sk-x', base_url: '', ...over,
});

const table = (props = {}) => render(ConnectionTable, { props: { instances: [], ...props } }).container;
const modal = (props = {}) => render(ConnectionModal, { props }).container;
const field = (el, id) => el.querySelector(`#${id}`);

describe('ConnectionTable', () => {
    it('says what to do when there are no connections', () => {
        expect(table().textContent).toContain('No LLM connections registered');
    });

    it('renders a row per connection with its provider label, model and URL', () => {
        const el = table({ instances: [inst({ base_url: 'https://x/v1' })] });
        expect(el.textContent).toContain('OpenAI GPT');
        expect(el.textContent).toContain('Prod');
        expect(el.textContent).toContain('gpt-4o');
        expect(el.textContent).toContain('https://x/v1');
    });

    it('says "Default" for a connection with no explicit base URL', () => {
        expect(table({ instances: [inst()] }).querySelector('.cfg-base-url').textContent.trim())
            .toBe('Default');
    });

    it('labels a GENERIC provider properly — it used to render the raw id', () => {
        const el = table({ instances: [inst({ provider: 'generic' })] });
        expect(el.textContent).toContain('Generic OpenAI');
        expect(el.textContent).not.toContain('>generic<');
    });

    it('flags an unknown provider id rather than dressing it up', () => {
        const el = table({ instances: [inst({ provider: 'opnai' })] });
        expect(el.querySelector('.cfg-provider').classList.contains('is-unknown')).toBe(true);
    });

    it('marks the FIRST connection active when none is chosen', () => {
        // The agent uses the first one, so the marker has to be there.
        const el = table({ instances: [inst({ id: 'a' }), inst({ id: 'b' })], activeId: null });
        expect(el.querySelector('tr.is-active [data-id]').dataset.id).toBe('a');
        expect(el.textContent).toContain('★ ACTIVE');
    });

    it('honours a stored active id', () => {
        const el = table({ instances: [inst({ id: 'a' }), inst({ id: 'b' })], activeId: 'b' });
        expect(el.querySelector('tr.is-active [data-id]').dataset.id).toBe('b');
    });

    it('reports set-default, edit and delete', () => {
        const onSetActive = vi.fn(); const onEdit = vi.fn(); const onDelete = vi.fn();
        const el = table({
            instances: [inst({ id: 'a' }), inst({ id: 'b' })], activeId: 'a',
            onSetActive, onEdit, onDelete,
        });
        el.querySelectorAll('.active-llm-radio')[1].click();
        expect(onSetActive).toHaveBeenCalledWith('b');
        el.querySelector('.btn-edit-instance').click();
        expect(onEdit).toHaveBeenCalledWith('a');
        el.querySelector('.btn-delete-instance').click();
        expect(onDelete).toHaveBeenCalledWith('a');
    });
});

describe('ConnectionModal — adding', () => {
    it('titles itself Add and leaves the provider editable', () => {
        const el = modal();
        expect(el.textContent).toContain('Add LLM Connection');
        expect(field(el, 'modal-provider-type').disabled).toBe(false);
    });

    it('offers every provider', () => {
        const opts = [...field(modal(), 'modal-provider-type').options].map(o => o.value);
        expect(opts).toEqual(['openai', 'anthropic', 'gemini', 'azure', 'ollama', 'generic']);
    });

    it('carries the provider placeholders into the key and URL fields', () => {
        const el = modal();
        expect(field(el, 'modal-inst-key').placeholder).toBe('sk-proj-...');
        expect(field(el, 'modal-inst-url').placeholder).toBe('https://api.openai.com/v1');
    });

    it('shows the Azure-only API-version field ONLY for Azure', async () => {
        // This used to be `versionGroup.style.display = …` from a change handler.
        const el = modal();
        expect(field(el, 'modal-inst-version')).toBe(null);
        const select = field(el, 'modal-provider-type');
        select.value = 'azure';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(field(el, 'modal-inst-version')).not.toBe(null);
    });

    it('relabels the URL field for Azure — it is an endpoint, not an API base', async () => {
        const el = modal();
        const select = field(el, 'modal-provider-type');
        select.value = 'azure';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(el.querySelector('label[for="modal-inst-url"]').textContent.trim()).toBe('Endpoint URL');
    });

    it('suggests a name, model and URL when the provider is picked', async () => {
        const el = modal();
        const select = field(el, 'modal-provider-type');
        select.value = 'anthropic';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(field(el, 'modal-inst-name').value).toBe('ANTHROPIC Connection');
        expect(field(el, 'modal-inst-model').value).toBe('claude-3-5-sonnet-20241022');
        expect(field(el, 'modal-inst-url').value).toBe('https://api.anthropic.com/v1');
    });

    it('does NOT overwrite a URL the user typed', async () => {
        const el = modal();
        const url = field(el, 'modal-inst-url');
        url.value = 'http://my-gateway/v1';
        url.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        const select = field(el, 'modal-provider-type');
        select.value = 'gemini';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(field(el, 'modal-inst-url').value).toBe('http://my-gateway/v1');
    });

    it('toggles the key between hidden and visible', async () => {
        const el = modal();
        expect(field(el, 'modal-inst-key').type).toBe('password');
        el.querySelector('.btn-toggle-password').click();
        await tick();
        expect(field(el, 'modal-inst-key').type).toBe('text');
    });
});

describe('ConnectionModal — editing', () => {
    it('titles itself Edit and LOCKS the provider', () => {
        // The provider decides the whole shape of the credentials, so changing it is
        // a different connection.
        const el = modal({ instance: inst() });
        expect(el.textContent).toContain('Edit LLM Connection');
        expect(field(el, 'modal-provider-type').disabled).toBe(true);
    });

    it('prefills every field from the instance', () => {
        const el = modal({ instance: inst({
            base_url: 'https://x/v1', context_window: 65536, max_output_tokens: 4096,
            temperature: 0.2, cost_per_1m_input: 2.5, cost_per_1m_output: 10,
        }) });
        expect(field(el, 'modal-inst-name').value).toBe('Prod');
        expect(field(el, 'modal-inst-model').value).toBe('gpt-4o');
        expect(field(el, 'modal-inst-url').value).toBe('https://x/v1');
        expect(field(el, 'modal-inst-context').value).toBe('65536');
        expect(field(el, 'modal-inst-maxout').value).toBe('4096');
        expect(field(el, 'modal-inst-temp').value).toBe('0.2');
        expect(field(el, 'modal-inst-cost-in').value).toBe('2.5');
        expect(field(el, 'modal-inst-cost-out').value).toBe('10');
    });

    it('keeps temperature 0 — a real value, not a blank', () => {
        expect(field(modal({ instance: inst({ temperature: 0 }) }), 'modal-inst-temp').value).toBe('0');
    });
});

describe('ConnectionModal — saving', () => {
    it('hands back the collected instance', () => {
        const onSave = vi.fn();
        modal({ instance: inst(), onSave }).querySelector('#btn-modal-save').click();
        expect(onSave).toHaveBeenCalledTimes(1);
        const sent = onSave.mock.calls[0][0];
        expect(sent.id).toBe('inst_1');
        expect(sent.name).toBe('Prod');
        expect(sent.model).toBe('gpt-4o');
    });

    // Vision cannot be read off a model name: a local llava takes images and has
    // no "gpt" in it, and not every anthropic model takes them at all. The box
    // starts from the guess so nothing changes for existing setups, and the
    // user's answer is what actually gets saved.
    it('seeds the vision box from the name-based guess', () => {
        expect(field(modal({ instance: inst({ provider: 'openai', model: 'gpt-4o' }) }), 'modal-inst-vision').checked).toBe(true);
        cleanup();
        expect(field(modal({ instance: inst({ provider: 'generic', model: 'llava:13b' }) }), 'modal-inst-vision').checked).toBe(false);
    });

    it('keeps what an existing connection was saved with, over the guess', () => {
        const el = modal({ instance: inst({ provider: 'generic', model: 'llava:13b', supports_vision: true }) });
        expect(field(el, 'modal-inst-vision').checked).toBe(true);
    });

    it('saves the vision answer explicitly, so the guess stops deciding', () => {
        // Default instance is openai/gpt-4o, which the guess calls vision-capable.
        // Unticking it has to survive the save, or the override is cosmetic.
        const onSave = vi.fn();
        const el = modal({ instance: inst(), onSave });
        const box = field(el, 'modal-inst-vision');
        expect(box.checked).toBe(true);
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        el.querySelector('#btn-modal-save').click();
        expect(onSave.mock.calls[0][0].supports_vision).toBe(false);
    });

    it('turns a blank number into null — "provider default", not zero', () => {
        const onSave = vi.fn();
        modal({ instance: inst(), onSave }).querySelector('#btn-modal-save').click();
        const sent = onSave.mock.calls[0][0];
        expect(sent.temperature).toBe(null);
        expect(sent.context_window).toBe(null);
        expect(sent.max_output_tokens).toBe(null);
    });

    it('REFUSES to save an invalid connection, and says which fields', async () => {
        const onSave = vi.fn();
        const el = modal({ onSave });      // nothing filled in
        el.querySelector('#btn-modal-save').click();
        await tick();
        expect(onSave).not.toHaveBeenCalled();
        const errs = el.querySelector('.cfg-modal-errors').textContent;
        expect(errs).toContain('name');
        expect(errs).toContain('Model');
        expect(errs).toContain('API key');
    });

    it('cancels', () => {
        const onCancel = vi.fn();
        modal({ onCancel }).querySelector('#btn-modal-cancel').click();
        expect(onCancel).toHaveBeenCalled();
    });

    it('cancels on a click outside the dialog, but not inside it', () => {
        const onCancel = vi.fn();
        const el = modal({ onCancel });
        el.querySelector('.cfg-modal').click();
        expect(onCancel).not.toHaveBeenCalled();
        el.querySelector('.modal-overlay').click();
        expect(onCancel).toHaveBeenCalled();
    });
});

describe('ConnectionModal — test connection', () => {
    it('hands the form values to the tester', () => {
        const onTest = vi.fn();
        modal({ instance: inst({ base_url: 'https://x/v1' }), onTest })
            .querySelector('#btn-modal-test').click();
        expect(onTest).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'openai', model: 'gpt-4o', base_url: 'https://x/v1',
        }));
    });

    it('shows the result, styled by outcome', () => {
        const ok = modal({ instance: inst(), testStatus: { state: 'ok', message: '✅ verified' } });
        expect(ok.querySelector('#modal-test-status').classList.contains('is-ok')).toBe(true);
        cleanup();
        const bad = modal({ instance: inst(), testStatus: { state: 'fail', message: '❌ nope' } });
        expect(bad.querySelector('#modal-test-status').classList.contains('is-fail')).toBe(true);
        expect(bad.textContent).toContain('❌ nope');
    });

    it('disables the button while the probe is in flight', () => {
        const el = modal({ instance: inst(), testStatus: { state: 'testing', message: '🔍 …' } });
        expect(el.querySelector('#btn-modal-test').disabled).toBe(true);
    });

    it('shows nothing before a test has run', () => {
        expect(modal({ instance: inst() }).querySelector('#modal-test-status')).toBe(null);
    });
});
