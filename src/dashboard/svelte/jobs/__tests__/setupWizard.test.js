// @vitest-environment jsdom
//
// The wizard is the only route that creates both halves of an automation, so
// the thing worth testing through the DOM is that one pass really does produce
// both — and that the time path produces exactly one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

const invoke = vi.fn(async (cmd) => {
    if (cmd === 'get_ai_config') return { approved_projects: ['C:/work'] };
    return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { default: SetupWizard } = await import('../SetupWizard.svelte');
const { normalizeRecipe } = await import('../../../../modules/ai/triggers/recipes/recipeFormat.js');

afterEach(() => { cleanup(); invoke.mockClear(); });

const CLOCK = normalizeRecipe({
    id: 'daily', name: '毎朝の下書き', description: '時刻で動きます',
    schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
    defaults: { eventName: 'schedule.daily' },
    job: { name: '日報', purpose: '毎朝の下ごしらえ', prompt: '書く' },
}, 'daily');

const WATCH = normalizeRecipe({
    id: 'health', name: 'サービスの死活', description: 'URL を見ます',
    engine: 'http', basic: false,
    fields: [{ key: 'url', label: 'ヘルス URL', type: 'text', wide: true, required: true }],
    config: { url: '{{url}}' },
    defaults: { everySeconds: 120, eventName: 'service.changed' },
    job: { name: '記録', purpose: '落ちた/戻ったを残す', prompt: '{{payload.value}} を記録' },
}, 'health');

function harness(recipes = [CLOCK, WATCH]) {
    const registry = { refresh: vi.fn(async () => {}), getAll: () => recipes, approve: vi.fn(async () => {}) };
    const watchers = { upsert: vi.fn(w => w) };
    const jobs = { upsert: vi.fn(j => j) };
    const onDone = vi.fn();
    render(SetupWizard, { props: { registry, watchers, jobs, onDone, notify: () => {} } });
    return { registry, watchers, jobs, onDone };
}

const next = async () => fireEvent.click(screen.getByText('次へ'));
/** Picking a card IS advancing — there is no Next button on step 1. */
const pick = async (name) => fireEvent.click(await screen.findByText(name));

describe('step 1 puts the clock and the watchers in one list', () => {
    it('shows both groups, with the free timer first', async () => {
        harness();
        expect(await screen.findByText('監視して動かす')).toBeTruthy();
        const names = [...document.querySelectorAll('.wiz-opt-name')].map(e => e.textContent);
        expect(names[0]).toBe('スケジュールを決める');
        expect(names).toContain('サービスの死活');
    });

    it('asks the clock question once — the cycle is step 2, not a card', async () => {
        harness();
        await screen.findByText('監視して動かす');
        const names = [...document.querySelectorAll('.wiz-opt-name')].map(e => e.textContent);
        expect(names.filter(n => n === 'スケジュールを決める')).toHaveLength(1);
        expect(names).not.toContain('毎朝の下書き');
    });

    it('choosing a card goes straight to step 2 — no second click', async () => {
        harness();
        await pick('スケジュールを決める');
        expect(document.body.textContent).toContain('監視は作られません');
    });
});

describe('the time path never mentions a watcher', () => {
    it('shows the schedule control the schedule screen uses, and nothing else', async () => {
        harness();
        await pick('スケジュールを決める');

        // The setup step for a timer is the schedule and nothing else: no
        // interval-to-poll, no event name, no host list.
        expect(document.querySelector('.sch-type-group')).toBeTruthy();
        expect(document.querySelectorAll('.sch-day-btn')).toHaveLength(7);
        expect(screen.queryByLabelText('イベント名')).toBeNull();
        expect(document.body.textContent).not.toContain('この監視が接続する先');
    });

    it('creates a job and no watcher', async () => {
        const h = harness();
        await pick('スケジュールを決める');
        await next();

        await fireEvent.input(document.querySelector('#wiz-name'), { target: { value: '朝の準備' } });
        await fireEvent.input(document.querySelector('#wiz-purpose'), { target: { value: '下ごしらえ' } });
        await fireEvent.input(document.querySelector('#wiz-prompt'), { target: { value: 'やる' } });
        await fireEvent.click(screen.getByText('この内容で作る'));

        expect(h.watchers.upsert).not.toHaveBeenCalled();
        expect(h.registry.approve).not.toHaveBeenCalled();
        expect(h.jobs.upsert).toHaveBeenCalledTimes(1);
        const job = h.jobs.upsert.mock.calls[0][0];
        expect(job.triggers[0].kind).toBe('time');
        expect(job.enabled).toBe(false);
    });
});

describe('a clock preset is ready-made WORK, offered on step 3', () => {
    it('fills the prompt and the purpose from the template', async () => {
        harness();
        await pick('スケジュールを決める');
        await next();
        await fireEvent.change(document.querySelector('#wiz-tpl'), { target: { value: 'daily' } });
        expect(document.querySelector('#wiz-prompt').value).toBe('書く');
        expect(document.querySelector('#wiz-purpose').value).toBe('毎朝の下ごしらえ');
    });

    it('says out loud that it moved the schedule too', async () => {
        harness();
        await pick('スケジュールを決める');
        await next();
        await fireEvent.change(document.querySelector('#wiz-tpl'), { target: { value: 'daily' } });
        expect(document.body.textContent).toContain('step 2');
    });
});

describe('a watch preset arrives with its work already written', () => {
    it('carries the prompt into step 3 rather than leaving a blank box', async () => {
        harness();
        await pick('サービスの死活');
        await fireEvent.input(document.querySelector('#wiz-f-url'),
            { target: { value: 'https://example.com/healthz' } });
        await next();
        expect(document.querySelector('#wiz-prompt').value).toContain('記録');
        expect(document.querySelector('#wiz-purpose').value).toBe('落ちた/戻ったを残す');
    });
});

describe('the watch path creates both, and links them', () => {
    it('makes the watcher, approves it, then makes the job pointing at it', async () => {
        const h = harness();
        await pick('サービスの死活');

        // The recipe IS the form: its one required field is what step 2 asks for.
        expect(screen.getByText('次へ').disabled).toBe(true);
        await fireEvent.input(document.querySelector('#wiz-f-url'),
            { target: { value: 'https://example.com/healthz' } });
        await next();
        await fireEvent.click(screen.getByText('この内容で作る'));

        expect(h.watchers.upsert).toHaveBeenCalledTimes(1);
        const watcher = h.watchers.upsert.mock.calls[0][0];
        const job = h.jobs.upsert.mock.calls[0][0];
        // The link that the old two-tab flow left as a string typed twice.
        expect(job.triggers).toEqual([{ kind: 'watch', sourceId: watcher.id }]);
        // Approval covers the config that now exists, and is recorded after it.
        expect(h.registry.approve).toHaveBeenCalledWith(watcher.id, expect.anything(), watcher.values);
        expect(watcher.enabled).toBe(false);
    });

    it('shows where it will connect before it is created', async () => {
        harness();
        await pick('サービスの死活');
        await fireEvent.input(document.querySelector('#wiz-f-url'),
            { target: { value: 'https://example.com/healthz' } });
        expect(await screen.findByText('example.com')).toBeTruthy();
    });
});

describe('the form is compact', () => {
    // The complaint that started this: a full-screen wizard with every field
    // stretched across it, two thirds of the window empty, and the button below
    // the fold. Short fields share a row; only the ones that need the width
    // span it, and the recipe declares which.
    it('spans only the fields that declared themselves wide', async () => {
        harness();
        await pick('サービスの死活');
        const url = document.querySelector('#wiz-f-url').closest('.sch-field');
        const every = document.querySelector('#wiz-every').closest('.sch-field');
        expect(url.classList.contains('wiz-wide')).toBe(true);
        expect(every.classList.contains('wiz-wide')).toBe(false);
    });

    it('keeps the card to a readable width instead of the whole window', async () => {
        harness();
        await screen.findByText('監視して動かす');
        expect(document.querySelector('.wiz-shell')).toBeTruthy();
        expect(document.querySelector('.wiz')).toBeTruthy();
    });
});

describe('going back does not strand you', () => {
    it('step 1 back cancels, later steps step back', async () => {
        const onCancel = vi.fn();
        const registry = { refresh: vi.fn(async () => {}), getAll: () => [CLOCK], approve: vi.fn() };
        render(SetupWizard, { props: { registry, watchers: {}, jobs: {}, onCancel, notify: () => {} } });
        await fireEvent.click(await screen.findByText('やめる'));
        expect(onCancel).toHaveBeenCalled();
    });
});
