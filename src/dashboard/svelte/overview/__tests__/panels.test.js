// @vitest-environment jsdom
//
// The panels that outlived the Dashboard.
//
// docs/design/information-architecture.md §7 step 4 dissolved the Dashboard, but
// its PANELS were never the problem — MemoryPane moved to the Memory
// destination and SpendPanel / StatsPane to Settings → Usage. These are their
// tests, carried over unchanged: the components did not change, only where they
// are mounted.
//
// The suites that went with OverviewRoot (the queue, the stateful right pane,
// the read-only RunPane fork, the localStorage launcher handoff) are gone with
// it. What replaced them: svelte/monitor/__tests__/composer.test.js and
// views/monitor/__tests__/pendingLaunch.test.js.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { t } from '../../../../i18n/index.js';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const MemoryPane = (await import('../MemoryPane.svelte')).default;
const StatsPane = (await import('../StatsPane.svelte')).default;
const { rateLookup } = await import('../../../views/overview/overviewModel.js');

afterEach(() => cleanup());
beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    invoke.mockImplementation(async () => '');
});

const NOW = new Date(2026, 7, 12, 12, 0).getTime();
const hAgo = (n) => new Date(NOW - n * 3600000).toISOString();

const task = (over = {}) => ({
    id: Math.random().toString(36).slice(2, 8),
    prompt: 'do a thing',
    status: 'completed',
    started_at: hAgo(1),
    completed_at: hAgo(0.5),
    token_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    ...over,
});

const RATED = [
    { id: 'i1', name: 'Flash', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
    { id: 'i2', name: 'Kimi', model: 'k3', cost_per_1m_input: 3, cost_per_1m_output: 15 },
];

const card = (over = {}) => ({
    id: 'L-' + Math.random().toString(36).slice(2, 8),
    type: 'lesson', signature: 'write_file|mismatch',
    trigger: { tool: 'write_file', ext: '.js' },
    symptom: 'old_text did not match', fix: 're-read first',
    hits: 1, costSteps: 4, disabled: false,
    first_seen: '2026-08-01', last_recurrence: '2026-08-10',
    ...over,
});

describe('the memory pane', () => {
    const mem = (over = {}) => ({ facts: [], episodes: [], cards: [], ...over });
    const paneOf = (props) => render(MemoryPane, {
        props: { workspace: 'C:/ws', knownWorkspaces: ['C:/ws'], ...props },
    }).container;

    it('says what is stored, by layer', () => {
        const el = paneOf({ memory: mem({ cards: [card(), card({ type: 'insight' })] }) });
        const keys = [...el.querySelectorAll('.dm-layers .k')].map(e => e.textContent);
        expect(keys).toEqual(['mem.layer.durable','mem.layer.episodic','mem.layer.lessons','mem.layer.insights','mem.layer.episodes'].map(t));
    });

    it('explains an empty store instead of drawing empty boxes', () => {
        const el = paneOf({ memory: mem() });
        expect(el.querySelector('.dash-empty h3').textContent).toMatch(t('mem.empty'));
        expect(el.querySelector('.dm-layers')).toBeFalsy();
    });

    it('asks for a workspace when there is none, rather than looking broken', () => {
        const el = paneOf({ memory: mem(), workspace: '' });
        expect(el.querySelector('.dash-empty h3').textContent).toMatch(t('mem.noWorkspace'));
    });

    it('reports a read failure instead of pretending the store is empty', () => {
        const el = paneOf({ memory: mem(), error: 'EACCES' });
        expect(el.textContent).toMatch(t('mem.readFailed'));
        expect(el.textContent).toMatch(/EACCES/);
    });

    it('does not claim a verdict when nothing has been surfaced yet', () => {
        const el = paneOf({ memory: mem({ cards: [card()] }) });
        expect(el.textContent).toMatch(t('mem.working.none', { total: 1 }));
    });

    it('leads with whether the lessons actually held', () => {
        const el = paneOf({ memory: mem({ cards: [card({ shown: 4, recurrences_after_hit: 0 })] }) });
        expect(el.textContent).toMatch(t('mem.working'));
        expect(el.querySelector('.dm-bar')).toBeTruthy();
    });

    it('names a card that keeps failing, with a switch', () => {
        const el = paneOf({ memory: mem({ cards: [card({ shown: 4, recurrences_after_hit: 4 })] }) });
        expect(el.textContent).toMatch(t('mem.notEarning'));
        expect(el.querySelector('.dm-frow input[type=checkbox]')).toBeTruthy();
    });

    it('lists what it knows WITHOUT being searched', () => {
        const el = paneOf({ memory: mem({ facts: [{ fact: 'always run npm test', type: 'norm' }] }) });
        expect(el.querySelectorAll('.dm-row').length).toBeGreaterThan(0);
        expect(el.textContent).toMatch(/always run npm test/);
    });

    it('shows search results only once something is typed', async () => {
        const el = paneOf({ memory: mem({ facts: [{ fact: 'uses vitest', type: 'norm' }] }) });
        expect(el.querySelector('.dm-results')).toBeFalsy();
        await fireEvent.input(el.querySelector('.dm-search input'), { target: { value: 'vitest' } });
        expect(el.querySelector('.dm-results')).toBeTruthy();
    });

    it('says so when a search matches nothing', async () => {
        const el = paneOf({ memory: mem({ facts: [{ fact: 'uses vitest', type: 'norm' }] }) });
        await fireEvent.input(el.querySelector('.dm-search input'), { target: { value: 'zzzz' } });
        expect(el.querySelector('.dm-results').textContent).toMatch(/Nothing matches/);
    });

    it('offers a one-click switch per known workspace, marking the current one', () => {
        const el = paneOf({
            memory: mem({ cards: [card()] }),
            knownWorkspaces: ['C:/ws', 'C:/other'],
        });
        const chips = [...el.querySelectorAll('.dm-wschip')];
        expect(chips).toHaveLength(2);
        expect(chips.find(c => c.classList.contains('is-on')).textContent.trim()).toBe('ws');
    });
});

describe('the Stats tab', () => {
    const paneOf = (props) => render(StatsPane, {
        props: { rateFor: rateLookup(RATED), flatRate: 0, now: NOW, ...props },
    }).container;

    it('invites a first run rather than showing zeros', () => {
        expect(paneOf({ tasks: [] }).textContent).toContain(t('stats.empty'));
    });

    it('shows a message when no task matches the conditions', () => {
        const el = paneOf({ tasks: [task({ status: 'completed' })], status: 'failed' });
        expect(el.textContent).toMatch(/change the conditions|change them above/);
    });

    it('every figure obeys the conditions', () => {
        const el = paneOf({
            tasks: [task({ status: 'completed' }), task({ status: 'failed' })],
            status: 'failed',
        });
        // KPI row: one task, 0% success.
        const vals = [...el.querySelectorAll('.dm-layers .v')].map(e => e.textContent);
        expect(vals[0]).toBe('1');
        expect(vals[1]).toBe('0%');
    });

    it('renders the per-model token table with the ↑⚡↓ split', () => {
        const el = paneOf({
            tasks: [task({ model_usage: { k3: { prompt_tokens: 100, cache_read_input_tokens: 40, completion_tokens: 10 } } })],
        });
        expect(el.querySelector('.ds-st-mlist')).toBeTruthy();
        expect(el.textContent).toMatch(/↑/);
        expect(el.textContent).toMatch(/⚡/);
    });

    it('carries the per-model line on each sampled task', () => {
        const el = paneOf({
            tasks: [task({ model_usage: { 'i2:k3': { prompt_tokens: 100_000, completion_tokens: 3_000 } } })],
        });
        expect(el.querySelector('.ds-st-task-models')).toBeTruthy();
    });

    // The cut buttons are NEW: the old view had the state, the persistence, the
    // aggregation and the click handler, but never rendered a button carrying
    // `data-cut`, so the breakdown was permanently "by month".
    it('offers every cut, and reports the pick', async () => {
        const onCut = vi.fn();
        const el = paneOf({ tasks: [task()], onCut });
        const cuts = [...el.querySelectorAll('.ds-st-cuts .ds-st-cut')];
        expect(cuts).toHaveLength(5);
        await fireEvent.click(cuts.find(b => /workspace|ws/i.test(b.textContent)));
        expect(onCut).toHaveBeenCalledWith('ws');
    });

    it('marks the active cut', () => {
        const el = paneOf({ tasks: [task()], cut: 'day' });
        const on = el.querySelector('.ds-st-cuts .ds-st-cut.is-on');
        expect(on).toBeTruthy();
    });
});

