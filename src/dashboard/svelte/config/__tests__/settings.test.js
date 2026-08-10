// @vitest-environment jsdom
//
// SettingsGeneral / SettingsMcp — the General and MCP tabs.
//
// The thing being verified is that a field CHANGE reaches the config as a
// normalized patch. That is exactly what `readFormValues()` could not guarantee: it
// read fields back by id, so a field renamed in the markup and not in the reader
// silently stopped saving, with nothing to fail.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import SettingsGeneral from '../SettingsGeneral.svelte';
import SettingsMcp from '../SettingsMcp.svelte';
import { MASKED } from '../../../views/config/configForm.js';

afterEach(() => cleanup());

const cfg = (over = {}) => ({
    output_language: 'Japanese', proxy_url: '', tavily_api_key: '',
    plan_mode: 'auto', subagent_review: 'off',
    fast_model_id: '', deep_model_id: '',
    llm_instances: [{ id: 'inst_1', name: 'Prod', model: 'gpt-4o' }],
    max_steps: 0, token_budget: 0, wall_clock_minutes: 0,
    no_progress_window: 15, identical_call_threshold: 5, cycle_detection_min_repeats: 3,
    history_compress_ratio: 0.5, write_allowed_paths: [], logging_enabled: false, log_dir: '',
    ...over,
});

/** Every section open, so fields are reachable without clicking through. */
const ALL_OPEN = {
    basic: true, behavior: true, safety: true, paths: true,
    commands: true, logging: true, connection: true,
};

const general = (props = {}) => render(SettingsGeneral, {
    props: { config: cfg(), openSections: ALL_OPEN, ...props },
}).container;

const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const pick = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('SettingsGeneral — the fields report normalized patches', () => {
    it('reports the output language', () => {
        const onChange = vi.fn();
        pick(general({ onChange }).querySelector('#cfg-output-language'), 'English');
        expect(onChange).toHaveBeenCalledWith({ output_language: 'English' });
    });

    it('reports a trimmed proxy URL, and null when cleared', () => {
        const onChange = vi.fn();
        const el = general({ onChange });
        type(el.querySelector('#cfg-proxy-url'), '  http://127.0.0.1:7890 ');
        expect(onChange).toHaveBeenCalledWith({ proxy_url: 'http://127.0.0.1:7890' });
        type(el.querySelector('#cfg-proxy-url'), '');
        expect(onChange).toHaveBeenCalledWith({ proxy_url: null });
    });

    it('does NOT report a masked secret back', () => {
        // Saving the mask would overwrite the real key with asterisks.
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-tavily-key'), MASKED);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('reports a real secret', () => {
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-tavily-key'), 'tvly-abc');
        expect(onChange).toHaveBeenCalledWith({ tavily_api_key: 'tvly-abc' });
    });

    it('reports plan mode and sub-agent review', () => {
        const onChange = vi.fn();
        const el = general({ onChange });
        pick(el.querySelector('#cfg-plan-mode'), 'always');
        expect(onChange).toHaveBeenCalledWith({ plan_mode: 'always' });
        pick(el.querySelector('#cfg-subagent-review'), 'on');
        expect(onChange).toHaveBeenCalledWith({ subagent_review: 'on' });
    });

    it('lists the connections in both routing selects', () => {
        const el = general();
        for (const id of ['#cfg-fast-model', '#cfg-deep-model']) {
            const opts = [...el.querySelector(id).options].map(o => o.value);
            expect(opts).toEqual(['', 'inst_1:gpt-4o']);
        }
    });

    it('clears a routing tier with an EMPTY STRING, not null', () => {
        // null reads to the backend as "not mentioned", restoring the old value.
        const onChange = vi.fn();
        const el = general({ config: cfg({ fast_model_id: 'inst_1:gpt-4o' }), onChange, openSections: ALL_OPEN });
        pick(el.querySelector('#cfg-fast-model'), '');
        expect(onChange).toHaveBeenCalledWith({ fast_model_id: '' });
    });

    it('renders all six safety limits from the shared field table', () => {
        const el = general();
        for (const key of ['max_steps', 'token_budget', 'wall_clock_minutes',
            'no_progress_window', 'identical_call_threshold', 'cycle_detection_min_repeats']) {
            expect(el.querySelector(`#cfg-${key}`), key).not.toBe(null);
        }
    });

    it('reports 0 when a limit is CLEARED — that is how you disable it', () => {
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-no_progress_window'), '');
        expect(onChange).toHaveBeenCalledWith({ no_progress_window: 0 });
    });

    it('falls back to the field default on a NEGATIVE value, not to 0', () => {
        // A number input refuses non-numeric text outright (the browser blanks it),
        // so a negative is the junk that can actually reach the handler. Becoming 0
        // here would silently disable the detector.
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-identical_call_threshold'), '-5');
        expect(onChange).toHaveBeenCalledWith({ identical_call_threshold: 5 });
    });

    it('keeps the compress ratio a FLOAT', () => {
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-compress-ratio'), '0.35');
        expect(onChange).toHaveBeenCalledWith({ history_compress_ratio: 0.35 });
    });

    it('splits the write-allowed paths per line', () => {
        const onChange = vi.fn();
        type(general({ onChange }).querySelector('#cfg-write-allowed'), 'C:/a\n\nC:/b');
        expect(onChange).toHaveBeenCalledWith({ write_allowed_paths: ['C:/a', 'C:/b'] });
    });

    it('toggles logging as a BOOLEAN, not a CSS class', () => {
        // It used to be read back with classList.contains('active').
        const onChange = vi.fn();
        general({ onChange }).querySelector('#cfg-logging-enabled-wrap').click();
        expect(onChange).toHaveBeenCalledWith({ logging_enabled: true });
    });

    it('shows the toggle as on when the config says so', () => {
        const el = general({ config: cfg({ logging_enabled: true }), openSections: ALL_OPEN });
        expect(el.querySelector('#cfg-logging-enabled-toggle').classList.contains('active')).toBe(true);
    });
});

describe('SettingsGeneral — sections', () => {
    it('opens Basic by default and leaves the rest closed', () => {
        const el = render(SettingsGeneral, { props: { config: cfg(), openSections: {} } }).container;
        const open = [...el.querySelectorAll('.cfg-sec')].filter(d => d.open).map(d => d.dataset.sec);
        expect(open).toEqual(['basic']);
    });

    it('honours a persisted open set', () => {
        const el = render(SettingsGeneral, {
            props: { config: cfg(), openSections: { basic: false, safety: true } },
        }).container;
        const open = [...el.querySelectorAll('.cfg-sec')].filter(d => d.open).map(d => d.dataset.sec);
        expect(open).toEqual(['safety']);
    });

    it('reports a toggle so the choice can be persisted', () => {
        const onToggleSection = vi.fn();
        const el = general({ onToggleSection });
        const sec = el.querySelector('.cfg-sec[data-sec="safety"]');
        sec.open = false;
        sec.dispatchEvent(new Event('toggle'));
        expect(onToggleSection).toHaveBeenCalledWith('safety', false);
    });
});

describe('SettingsGeneral — the allowlists', () => {
    it('says "(none)" for an empty list', () => {
        expect(general().querySelector('#cfg-approved-cmds').textContent).toContain('(none)');
    });

    it('renders each entry with a remove control', () => {
        const el = general({ approvedCommands: ['git status *', 'npm run build *'] });
        const rows = [...el.querySelectorAll('#cfg-approved-cmds .cfg-cmd-row code')].map(c => c.textContent);
        expect(rows).toEqual(['git status *', 'npm run build *']);
    });

    it('adds a pattern and clears the input', async () => {
        const onAddApprovedCommand = vi.fn();
        const el = general({ onAddApprovedCommand });
        const input = el.querySelector('#cfg-approved-cmd-new');
        input.value = 'ls *';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        el.querySelector('#btn-approved-cmd-add').click();
        await tick();
        expect(onAddApprovedCommand).toHaveBeenCalledWith('ls *');
        expect(el.querySelector('#cfg-approved-cmd-new').value).toBe('');
    });

    it('ignores an empty add', () => {
        const onAddApprovedCommand = vi.fn();
        general({ onAddApprovedCommand }).querySelector('#btn-approved-cmd-add').click();
        expect(onAddApprovedCommand).not.toHaveBeenCalled();
    });

    it('removes a pattern', () => {
        const onRemoveApprovedCommand = vi.fn();
        const el = general({ approvedCommands: ['git status *'], onRemoveApprovedCommand });
        el.querySelector('#cfg-approved-cmds .cfg-cmd-del').click();
        expect(onRemoveApprovedCommand).toHaveBeenCalledWith('git status *');
    });

    it('manages the auto-approve workspaces the same way', () => {
        const onRemoveAutoWorkspace = vi.fn();
        const el = general({ autoApproveWorkspaces: ['C:/proj'], onRemoveAutoWorkspace });
        expect(el.querySelector('#cfg-autows').textContent).toContain('C:/proj');
        el.querySelector('#cfg-autows .cfg-cmd-del').click();
        expect(onRemoveAutoWorkspace).toHaveBeenCalledWith('C:/proj');
    });
});

describe('SettingsGeneral — actions', () => {
    it.each([
        ['btn-select-log-dir', 'onSelectLogDir'],
        ['btn-copy-connection-token', 'onCopyToken'],
        ['btn-export-connection', 'onExportConnection'],
        ['btn-storage-refresh', 'onRefreshStorage'],
        ['btn-purge-apilogs', 'onPurgeApiLogs'],
        ['btn-clear-commlog', 'onClearCommLog'],
    ])('%s calls %s', (id, cbName) => {
        const cb = vi.fn();
        general({ [cbName]: cb }).querySelector(`#${id}`).click();
        expect(cb).toHaveBeenCalled();
    });

    it('shows the connection token read-only, with the port', () => {
        const el = general({ connection: { token: 'tok-123', port: '14300' } });
        const input = el.querySelector('#cfg-connection-token');
        expect(input.value).toBe('tok-123');
        expect(input.readOnly).toBe(true);
        expect(el.textContent).toContain('14300');
    });

    it('prompts for a storage refresh until one has run', () => {
        expect(general().querySelector('#cfg-storage-usage').textContent).toContain('Refresh');
        cleanup();
        expect(general({ storageUsage: '<b>42 MB</b>' }).querySelector('#cfg-storage-usage').textContent)
            .toContain('42 MB');
    });

    it('shows the export status when there is one', () => {
        expect(general({ exportStatus: 'Wrote: x.json' }).querySelector('#export-connection-status').textContent)
            .toContain('Wrote: x.json');
    });
});

describe('SettingsMcp', () => {
    it('shows the current JSON', () => {
        const el = render(SettingsMcp, { props: { text: '{"a":1}' } }).container;
        expect(el.querySelector('#cfg-mcp-servers').value).toBe('{"a":1}');
    });

    it('reports edits — no read-back needed', () => {
        const onChange = vi.fn();
        const el = render(SettingsMcp, { props: { text: '{}', onChange } }).container;
        type(el.querySelector('#cfg-mcp-servers'), '{"sqlite":{}}');
        expect(onChange).toHaveBeenCalledWith('{"sqlite":{}}');
    });
});
