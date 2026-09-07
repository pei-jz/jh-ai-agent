// @vitest-environment jsdom
//
// TriggerPanel — the form over the trigger rules.
//
// The rules themselves are TriggerEngine's and are tested there. What this
// pins is the two things a form can get wrong for a feature that runs code
// when nobody is watching: that a new trigger is not live the moment it is
// created, and that a trigger stopped by its own rate cap SAYS so on screen
// rather than just looking quiet.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

vi.mock('../../../../modules/ai/triggers/WatcherManager.js', () => ({
    watcherManager: { watchers: [] },
    secretIdFor: (id) => `watcher:${id}`,
}));

vi.mock('../../../../modules/ai/AgentModes.js', () => ({
    DEFAULT_MODE_ID: 'standard',
    // The emoji is in the real labels; modeName is what strips it for a
    // <select>, which cannot draw an icon in its place.
    AGENT_MODES: { standard: { id: 'standard', label: '🧰 Standard' } },
    modeName: (m) => String(m?.label || '').replace(/^\S+\s+/, ''),
    buildBehavior: () => ({}),
}));

const { default: TriggerPanel } = await import('../TriggerPanel.svelte');

afterEach(cleanup);

/** A stand-in for TriggerManager: same surface, no storage and no fetch. */
function fakeManager(triggers = []) {
    const m = {
        triggers: [...triggers],
        reload: () => m.triggers,
        upsert: vi.fn((t) => {
            const i = m.triggers.findIndex(x => x.id === t.id);
            if (i >= 0) m.triggers[i] = { ...m.triggers[i], ...t };
            else m.triggers.push(t);
            return t;
        }),
        remove: vi.fn((id) => { m.triggers = m.triggers.filter(t => t.id !== id); }),
        setEnabled: vi.fn((id, on) => {
            const t = m.triggers.find(x => x.id === id);
            if (t) t.enabled = on;
            return t;
        }),
        onEvent: vi.fn(() => []),
    };
    return m;
}

const CI = {
    id: 'trg_ci', name: 'CI failed', enabled: true,
    match: { source: 'webhook', event: 'ci.failed', where: { repo: 'jh' } },
    prompt: 'fix {{payload.repo}}',
    runs: [{ at: '2026-09-04T10:00:00.000Z', event: 'ci.failed', count: 2, status: 'started', taskId: 'x' }],
};

const mount = (manager) => render(TriggerPanel, {
    props: { manager, endpoint: 'http://localhost:1425/api/events', notify: () => {}, confirmDelete: () => true },
});

describe('the list says what each trigger listens for', () => {
    it('summarises the source, event and conditions', () => {
        mount(fakeManager([CI]));
        expect(screen.getByText(/webhook · ci\.failed · repo=jh/)).toBeTruthy();
    });

    it('says so when nothing is configured', () => {
        mount(fakeManager([]));
        expect(screen.getAllByText(/まだトリガーがありません/).length).toBeGreaterThan(0);
    });
});

describe('a new trigger is not live the moment it exists', () => {
    it('starts disabled and is not written until Save', async () => {
        const m = fakeManager([]);
        mount(m);
        await fireEvent.click(screen.getByText(/新しいトリガー/));
        // Nothing registered yet: the draft is on screen, not in the store.
        expect(m.upsert).not.toHaveBeenCalled();

        const prompt = document.querySelector('textarea');
        await fireEvent.input(prompt, { target: { value: 'do the thing' } });
        await fireEvent.click(screen.getByText('保存'));

        expect(m.upsert).toHaveBeenCalledTimes(1);
        expect(m.upsert.mock.calls[0][0].enabled).toBe(false);
    });

    it('refuses to save a trigger with no prompt', async () => {
        const m = fakeManager([]);
        const notify = vi.fn();
        render(TriggerPanel, { props: { manager: m, notify, confirmDelete: () => true } });
        await fireEvent.click(screen.getByText(/新しいトリガー/));
        await fireEvent.click(screen.getByText('保存'));
        expect(m.upsert).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalled();
    });
});

describe('a trigger stopped by its own cap says so', () => {
    // Silence and "stopped because it ran away" look identical otherwise, and
    // only one of them needs a person.
    it('shows the warning in the list and the detail', async () => {
        const stopped = { ...CI, enabled: false, disabledReason: 'rate', disabledAt: 1 };
        mount(fakeManager([stopped]));
        expect(screen.getAllByText(/上限に達したため停止/).length).toBeGreaterThan(0);
    });
});

describe('the detail is enough to actually use it', () => {
    it('shows the runs it has already done', async () => {
        mount(fakeManager([CI]));
        await fireEvent.click(screen.getByText('CI failed'));
        expect(screen.getByText(/ci\.failed ×2/)).toBeTruthy();
    });

    // Without this nobody can wire a webhook up: the endpoint and the token are
    // not guessable, and the feature is unusable while they are hidden.
    it('shows how to send an event, with the endpoint and the event name', async () => {
        mount(fakeManager([CI]));
        await fireEvent.click(screen.getByText('CI failed'));
        const curl = document.querySelector('.trg-curl').textContent;
        expect(curl).toContain('http://localhost:1425/api/events');
        expect(curl).toContain('"event":"ci.failed"');
        expect(curl).toContain('Authorization: Bearer');
    });

    it('a test event goes through the real path, guards and all', async () => {
        const m = fakeManager([{ ...CI, prompt: 'look at the build' }]);
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('テスト送信'));
        expect(m.onEvent).toHaveBeenCalledTimes(1);
        expect(m.onEvent.mock.calls[0][0]).toMatchObject({ source: 'webhook', event: 'ci.failed' });
    });

    // The reported failure: the test sent `{test:true}`, every
    // `{{payload.…}}` stayed unresolved, and a REAL task started with
    // `{{payload.value}}` in its instructions. It cost 100 seconds and ended
    // with the agent asking for the number it had been told to write.
    it('refuses to start anything the event cannot fill, and names the field', async () => {
        const m = fakeManager([CI]);          // prompt: 'fix {{payload.repo}}'
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('テスト送信'));
        expect(m.onEvent, 'nothing was sent').not.toHaveBeenCalled();
        const said = document.querySelector('.trg-testresult').textContent;
        expect(said).toContain('{{payload.repo}}');
    });
});

describe('the toggle', () => {
    it('switches a trigger on and off through the manager', async () => {
        const m = fakeManager([CI]);
        mount(m);
        await fireEvent.change(document.querySelector('.trg-toggle input'));
        expect(m.setEnabled).toHaveBeenCalledWith('trg_ci', false);
    });
});

describe('the agent list reads as a list of names', () => {
    // A native <select> cannot render an SVG, so the emoji baked into each
    // mode's label showed up raw — the same list looking like two different
    // products depending on the screen. ModeDropdown had already stripped it;
    // every other surface had not.
    it('shows the mode name without its leading emoji', async () => {
        mount(fakeManager([CI]));
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('編集'));
        const opts = [...document.querySelectorAll('#trg-agent option')].map(o => o.textContent.trim());
        expect(opts).toContain('Standard');
        expect(opts.join(' ')).not.toContain('🧰');
    });
});

describe('the workspace is picked, not typed', () => {
    // The one field nobody can verify by eye. A mistyped path fires happily
    // and does the work somewhere else, or nowhere.
    it('offers a select with a clear option, plus Browse', async () => {
        mount(fakeManager([CI]));
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('編集'));
        const sel = document.querySelector('#trg-ws');
        expect(sel?.tagName).toBe('SELECT');
        expect([...sel.options].map(o => o.value)).toContain('');
        expect(document.querySelector('.trg-browse')).toBeTruthy();
    });
});

describe('the form is filled in without scrolling for it', () => {
    const openEditor = async (m) => {
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('編集'));
    };

    // Exact and prefix were two always-visible fields. matches() requires BOTH
    // when both are set, so filling them in produced a trigger that could never
    // fire and said nothing about why. One control cannot express that.
    it('offers one control for the event name, not two competing fields', async () => {
        await openEditor(fakeManager([CI]));
        expect(document.querySelector('#trg-event')).toBeTruthy();
        expect(document.querySelector('#trg-prefix'), 'the second field is gone').toBeNull();
        const modes = [...document.querySelectorAll('.trg-mode option')].map(o => o.value);
        expect(modes).toEqual(['exact', 'prefix']);
    });

    it('writes only the half the chosen mode means', async () => {
        const m = fakeManager([CI]);
        await openEditor(m);
        const sel = document.querySelector('.trg-mode');
        sel.value = 'prefix';
        await fireEvent.change(sel);
        await fireEvent.input(document.querySelector('#trg-event'), { target: { value: 'github.' } });
        await fireEvent.click(screen.getByText('保存'));

        const saved = m.upsert.mock.calls[0][0].match;
        expect(saved.eventPrefix).toBe('github.');
        expect(saved.event, 'the pair that matches nothing is unwritable').toBeUndefined();
    });

    it('loads an existing exact match back into the exact mode', async () => {
        await openEditor(fakeManager([CI]));
        expect(document.querySelector('.trg-mode').value).toBe('exact');
        expect(document.querySelector('#trg-event').value).toBe('ci.failed');
    });

    // The list summary skipped eventPrefix whenever event was set, so a legacy
    // trigger carrying both looked correct and never ran.
    it('shows BOTH halves of a legacy trigger that has them', () => {
        const legacy = { ...CI, match: { source: 'webhook', event: 'ci.failed', eventPrefix: 'github.' } };
        mount(fakeManager([legacy]));
        const line = screen.getByText(/ci\.failed/).textContent;
        expect(line).toContain('github.*');
    });

    it('lays the short fields out in two columns, with the long ones spanning', async () => {
        await openEditor(fakeManager([CI]));
        expect(document.querySelector('.trg-grid'), 'the grid').toBeTruthy();
        // The prompt and the condition list need the width; the name does not.
        const promptField = document.querySelector('#trg-prompt').closest('.sch-field');
        expect(promptField.classList.contains('trg-span')).toBe(true);
        const nameField = document.querySelector('#trg-name').closest('.sch-field');
        expect(nameField.classList.contains('trg-span')).toBe(false);
    });

    it('keeps the three guards on one line', async () => {
        await openEditor(fakeManager([CI]));
        const row = document.querySelector('.trg-guards');
        expect(row.querySelectorAll('input[type=number]')).toHaveLength(3);
    });
});

describe('the test button says what happened', () => {
    // A trigger is created disabled, so a switched-off trigger is the FIRST
    // thing anyone presses this on. Doing nothing and saying nothing is
    // indistinguishable from the app having hung — which is exactly how it was
    // reported.
    // A prompt with no placeholders: these tests are about what the button
    // REPORTS, not about the guard that stops an unfillable prompt.
    const PLAIN = { ...CI, prompt: 'look at the build' };
    const withDecision = (decision) => {
        const m = fakeManager([PLAIN]);
        m.onEvent = vi.fn(() => decision);
        return m;
    };

    it('says why a dropped event was dropped', async () => {
        const m = withDecision([{ triggerId: 'trg_ci', dropped: 'トリガーが無効' }]);
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('テスト送信'));
        expect(screen.getByText(/見送られました.*トリガーが無効/)).toBeTruthy();
    });

    it('says when an accepted event will start a task', async () => {
        const m = withDecision([{ triggerId: 'trg_ci', accepted: true, fireAt: Date.now() + 2000 }]);
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('テスト送信'));
        expect(screen.getByText(/受け付けました/)).toBeTruthy();
    });

    // The most useful message of the three: the event did not match at all.
    it('says so when nothing matched', async () => {
        const m = withDecision([]);
        mount(m);
        await fireEvent.click(screen.getByText('CI failed'));
        await fireEvent.click(screen.getByText('テスト送信'));
        expect(screen.getByText(/どのトリガーにも一致しませんでした/)).toBeTruthy();
    });
});
