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
// The copy in these tabs comes from the i18n catalogs now, and the default
// locale is ja. Pin en so the assertions below read as the sentences they
// are checking for rather than as opaque strings.
import { __setLocaleForTest } from '../../../../i18n/index.js';

__setLocaleForTest('en');

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
    commands: true, logging: true, connection: true, updates: true, license: true,
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

    it('reports the memory-recall arm, and defaults to RECALLING', () => {
        // The A/B control group is only reachable if this select saves — the
        // switch existed in the agent before it existed in the UI, which made it
        // unusable outside tests.
        //
        // The default is 'on', not 'auto'. 'auto' withholds memory from half of
        // all runs to build a control group; enrolling every user in that by
        // default means someone is told their workspace learned something and
        // then, on a coin flip, does not get it, with no way to tell why.
        const onChange = vi.fn();
        const el = general({ onChange });
        expect(el.querySelector('#cfg-memory-recall').value).toBe('on');
        pick(el.querySelector('#cfg-memory-recall'), 'auto');
        expect(onChange).toHaveBeenCalledWith({ memory_recall: 'auto' });
    });

    it('offers all three memory-recall arms, default first', () => {
        const opts = [...general().querySelector('#cfg-memory-recall').options].map(o => o.value);
        expect(opts).toEqual(['on', 'auto', 'off']);
    });

    it('exposes past-session injection, defaulting off', () => {
        // ConversationMemory had setEpisodeInjectionConfig with no caller outside
        // tests, so the heaviest memory layer could not be turned off by anyone.
        const onChange = vi.fn();
        const el = general({ onChange });
        const sel = el.querySelector('#cfg-episode-injection');
        expect(sel).toBeTruthy();
        expect(sel.value).toBe('off');
        expect([...sel.options].map(o => o.value)).toEqual(['off', 'on']);
        pick(sel, 'on');
        expect(onChange).toHaveBeenCalledWith({ episode_injection: 'on' });
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

    // A select that shows "(not set)" while a tier IS stored looks exactly like
    // a save that did not take, which is the complaint the "" sentinel exists to
    // answer. Assert the displayed value, not just the option list.
    it('shows the tier that is actually stored', () => {
        const el = general({ config: cfg({ fast_model_id: 'inst_1:gpt-4o' }) });
        expect(el.querySelector('#cfg-fast-model').value).toBe('inst_1:gpt-4o');
        expect(el.querySelector('#cfg-deep-model').value).toBe('');
    });
});

// Phase routing — see modules/ai/agent/ModelPhaseRouter.js. The control is a
// promise about cost, so the UI has to be honest about when it can keep it.
describe('SettingsGeneral — phase routing', () => {
    const TWO_TIERS = {
        fast_model_id: 'i1:flash', deep_model_id: 'i2:kimi',
        llm_instances: [
            { id: 'i1', name: 'Flash', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
            { id: 'i2', name: 'Kimi', model: 'kimi', cost_per_1m_input: 3, cost_per_1m_output: 15 },
        ],
    };

    it('is disabled until BOTH tiers are set — one tier makes every phase identical', () => {
        const el = general({ config: cfg({ fast_model_id: 'inst_1:gpt-4o', deep_model_id: '' }) });
        expect(el.querySelector('#cfg-phase-routing').disabled).toBe(true);
        expect(el.textContent).toContain('Set BOTH a Fast and a Deep tier');
    });

    it('enables and names the two tiers once both are set', () => {
        const el = general({ config: cfg(TWO_TIERS) });
        expect(el.querySelector('#cfg-phase-routing').disabled).toBe(false);
        expect(el.textContent).toContain('Plan & review');
        expect(el.textContent).toContain('Kimi (kimi)');
        expect(el.textContent).toContain('Flash (flash)');
    });

    it('estimates the saving from the rates on the connections', () => {
        const el = general({ config: cfg(TWO_TIERS) });
        expect(el.textContent).toMatch(/Estimated\s+\d+% cheaper/);
    });

    // Better to say "I cannot price this" than to print a number with nothing
    // behind it — a missing rate would otherwise read as a free model.
    it('asks for rates instead of guessing when a connection has none', () => {
        const el = general({ config: cfg({
            ...TWO_TIERS,
            llm_instances: TWO_TIERS.llm_instances.map(i => ({ ...i, cost_per_1m_input: undefined, cost_per_1m_output: undefined })),
        }) });
        expect(el.textContent).not.toMatch(/cheaper/);
        expect(el.textContent).toContain('Enter the $/1M rates');
    });

    it('reports the choice as a patch', () => {
        const onChange = vi.fn();
        const el = general({ config: cfg(TWO_TIERS), onChange, openSections: ALL_OPEN });
        pick(el.querySelector('#cfg-phase-routing'), 'on');
        expect(onChange).toHaveBeenCalledWith({ phase_routing: 'on' });
    });

    it('defaults to off', () => {
        expect(general({ config: cfg(TWO_TIERS) }).querySelector('#cfg-phase-routing').value).toBe('off');
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


describe('SettingsGeneral — unconfigured build shows only what it can do', () => {
    // The product is pre-release: no signing key, no licence-issuing key, and
    // ENFORCEMENT_ENABLED is false so nothing is gated. Settings must not advertise
    // machinery that does not exist yet — and must never show developer paths.

    it('shows the version even with no update channel', () => {
        // Always useful: every support conversation starts with "which build?".
        const el = general({ appVersion: '0.1.0', updatesConfigured: false });
        expect(el.textContent).toContain('0.1.0');
    });

    it('offers no update check on a build that cannot verify one', () => {
        const el = general({ appVersion: '0.1.0', updatesConfigured: false });
        expect(el.textContent).not.toContain('Check for updates');
        // …and does not explain WHY, which the user can do nothing about.
        expect(el.textContent).not.toContain('signing key');
    });

    it('offers the check once a signing key is compiled in', () => {
        // Nothing has to be remembered later: generating a key reveals the section.
        const el = general({ appVersion: '0.2.0', updatesConfigured: true });
        expect(el.textContent).toContain('Check for updates');
    });

    it('hides the licence section entirely when there is no issuing key', () => {
        const el = general({ licensingConfigured: false });
        expect(el.querySelector('[data-sec="license"]')).toBeNull();
        expect(el.querySelector('#cfg-license-key')).toBeNull();
    });

    it('never names an edition on a build that gates nothing', () => {
        // "Community エディション" advertises a paywall that does not exist and makes
        // a free pre-release look deliberately limited.
        const el = general({ licensingConfigured: false });
        expect(el.textContent).not.toContain('Community');
        expect(el.textContent).not.toContain('エディション');
    });

    it('shows the licence section once an issuing key exists', () => {
        const el = general({ licensingConfigured: true });
        expect(el.querySelector('[data-sec="license"]')).toBeTruthy();
        expect(el.querySelector('#cfg-license-key')).toBeTruthy();
    });

    it('never leaks a repository path into the UI', () => {
        // docs/ does not ship with the app, so these are meaningless to a user.
        for (const props of [
            { updatesConfigured: false, licensingConfigured: false },
            { updatesConfigured: true, licensingConfigured: true },
        ]) {
            cleanup();
            const el = general(props);
            expect(el.textContent).not.toContain('docs/');
            expect(el.textContent).not.toContain('.md');
        }
    });
});
