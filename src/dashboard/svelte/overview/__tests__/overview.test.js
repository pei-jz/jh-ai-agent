// @vitest-environment jsdom
//
// The Dashboard, after migration. The selection and pricing RULES are covered in
// views/overview/__tests__/overviewModel.test.js; this is about what reaches the
// screen and what the controls do.
//
// Ported from views/__tests__/overviewView.test.js, which drove the class and
// searched its generated HTML strings.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const OverviewRoot = (await import('../OverviewRoot.svelte')).default;
const MemoryPane = (await import('../MemoryPane.svelte')).default;
const RunPane = (await import('../RunPane.svelte')).default;
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

/** Mount the whole dashboard with every side effect injected. */
function mountRoot({ tasks = [], config = {}, memory = null, sockets = [] } = {}) {
    const api = {
        port: 1, token: 't',
        getStats: vi.fn(async () => ({ totalTokens: 0, estimatedCost: 0 })),
        listTasks: vi.fn(async () => tasks),
        getConfig: vi.fn(async () => config),
    };
    const navigate = vi.fn();
    const notify = vi.fn();
    const saveCards = vi.fn(async () => {});
    const openSocket = vi.fn((id) => {
        const s = { id, close: vi.fn(), onmessage: null, onerror: null };
        sockets.push(s);
        return s;
    });
    const utils = render(OverviewRoot, {
        props: {
            api, navigate, notify, saveCards, openSocket, now: NOW,
            readMemory: async () => (memory ?? { facts: [], episodes: [], cards: [] }),
            pickFolder: vi.fn(async () => 'C:/picked'),
        },
    });
    return { ...utils, api, navigate, notify, saveCards, openSocket, sockets };
}

const settle = () => waitFor(() => {});

describe('the queue reaches the screen', () => {
    it('lists running, waiting and recent groups that are non-empty', async () => {
        const { container } = mountRoot({
            tasks: [task({ status: 'running' }), task({ status: 'paused' }), task()],
        });
        await waitFor(() => expect(container.querySelectorAll('.dqi').length).toBe(3));
        const labels = [...container.querySelectorAll('.dq-lab')].map(e => e.textContent.trim());
        expect(labels).toContain('Running');
        expect(labels).toContain('Waiting for you');
        expect(labels).toContain('Recent');
    });

    it('says so plainly when there is nothing at all', async () => {
        const { container } = mountRoot({ tasks: [] });
        await waitFor(() => expect(container.querySelector('.dq-empty')).toBeTruthy());
        expect(container.querySelector('.dq-empty').textContent).toMatch(/No tasks yet/);
    });

    it('links every row to its task in Monitor', async () => {
        const t = task();
        const { container } = mountRoot({ tasks: [t] });
        await waitFor(() => expect(container.querySelector('.dqi')).toBeTruthy());
        expect(container.querySelector('.dqi').getAttribute('href')).toBe(`#monitor?id=${t.id}`);
    });
});

describe('the right pane picks its own tab', () => {
    it('shows the run when one is running', async () => {
        const { container } = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => {
            const on = container.querySelector('.dt-tab.is-on');
            expect(on?.textContent).toMatch(/Run/);
        });
    });

    it('shows memory when nothing is running — the pane is never blank', async () => {
        const { container } = mountRoot({ tasks: [task()] });
        await waitFor(() => {
            expect(container.querySelector('.dt-tab.is-on')?.textContent).toMatch(/Memory/);
        });
    });

    it('disables the Run tab when there is nothing to show', async () => {
        const { container } = mountRoot({ tasks: [task()] });
        await waitFor(() => expect(container.querySelectorAll('.dt-tab').length).toBe(3));
        expect(container.querySelectorAll('.dt-tab')[0].disabled).toBe(true);
    });

    it('lets an explicit choice win over the automatic one', async () => {
        const { container } = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(container.querySelectorAll('.dt-tab').length).toBe(3));
        await fireEvent.click(container.querySelectorAll('.dt-tab')[1]);   // Memory
        expect(container.querySelector('.dt-tab.is-on').textContent).toMatch(/Memory/);
    });
});

describe('the memory pane', () => {
    const mem = (over = {}) => ({ facts: [], episodes: [], cards: [], ...over });
    const paneOf = (props) => render(MemoryPane, {
        props: { workspace: 'C:/ws', knownWorkspaces: ['C:/ws'], ...props },
    }).container;

    it('says what is stored, by layer', () => {
        const el = paneOf({ memory: mem({ cards: [card(), card({ type: 'insight' })] }) });
        const keys = [...el.querySelectorAll('.dm-layers .k')].map(e => e.textContent);
        expect(keys).toEqual(['DURABLE', 'EPISODIC', 'LESSONS', 'INSIGHTS', 'EPISODES']);
    });

    it('explains an empty store instead of drawing empty boxes', () => {
        const el = paneOf({ memory: mem() });
        expect(el.querySelector('.dash-empty h3').textContent).toMatch(/Nothing learned yet/);
        expect(el.querySelector('.dm-layers')).toBeFalsy();
    });

    it('asks for a workspace when there is none, rather than looking broken', () => {
        const el = paneOf({ memory: mem(), workspace: '' });
        expect(el.querySelector('.dash-empty h3').textContent).toMatch(/No workspace yet/);
    });

    it('reports a read failure instead of pretending the store is empty', () => {
        const el = paneOf({ memory: mem(), error: 'EACCES' });
        expect(el.textContent).toMatch(/Could not read memory/);
        expect(el.textContent).toMatch(/EACCES/);
    });

    it('does not claim a verdict when nothing has been surfaced yet', () => {
        const el = paneOf({ memory: mem({ cards: [card()] }) });
        expect(el.textContent).toMatch(/nothing to judge yet/);
    });

    it('leads with whether the lessons actually held', () => {
        const el = paneOf({ memory: mem({ cards: [card({ shown: 4, recurrences_after_hit: 0 })] }) });
        expect(el.textContent).toMatch(/Is it working\?/);
        expect(el.querySelector('.dm-bar')).toBeTruthy();
    });

    it('names a card that keeps failing, with a switch', () => {
        const el = paneOf({ memory: mem({ cards: [card({ shown: 4, recurrences_after_hit: 4 })] }) });
        expect(el.textContent).toMatch(/Not earning their place/);
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

describe('switching a card off', () => {
    it('flips optimistically and persists', async () => {
        const cards = [card()];
        const h = mountRoot({ tasks: [task({ workspace_path: 'C:/ws' })], memory: { facts: [], episodes: [], cards } });
        await waitFor(() => expect(h.container.querySelector('.dm-row')).toBeTruthy());
        const cb = h.container.querySelector('.dm-row input[type=checkbox]');
        await fireEvent.change(cb, { target: { checked: false } });
        await waitFor(() => expect(h.saveCards).toHaveBeenCalled());
        expect(h.saveCards.mock.calls[0][1][0].disabled).toBe(true);
    });

    it('reverts the row when the write fails, and says why', async () => {
        const cards = [card()];
        const h = mountRoot({ tasks: [task({ workspace_path: 'C:/ws' })], memory: { facts: [], episodes: [], cards } });
        h.saveCards.mockRejectedValueOnce(new Error('disk full'));
        await waitFor(() => expect(h.container.querySelector('.dm-row')).toBeTruthy());
        await fireEvent.change(h.container.querySelector('.dm-row input[type=checkbox]'),
            { target: { checked: false } });
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('disk full')));
        expect(h.container.querySelector('.dm-row').classList.contains('is-off')).toBe(false);
    });
});

describe('watching the running task', () => {
    it('opens one socket for the running task', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.openSocket).toHaveBeenCalledTimes(1));
    });

    it('opens nothing when nothing is running', async () => {
        const h = mountRoot({ tasks: [task()] });
        await settle();
        expect(h.openSocket).not.toHaveBeenCalled();
    });

    it('reduces incoming packets into the run state', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running', prompt: 'build it' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));
        h.sockets[0].onmessage({ data: JSON.stringify({ event: 'status', data: { message: 'Thinking... (step 3)' } }) });
        await waitFor(() => expect(h.container.querySelector('.dm-layers .v').textContent).toBe('3'));
    });

    // The pane used to rebuild on EVERY packet. `stream` arrives once per token,
    // so a generating task re-rendered dozens of times a second — the reported
    // flicker — and every rebuild walked the whole log array, which made a long
    // run quadratic as well.
    it('ignores the per-token traffic entirely', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));
        h.sockets[0].onmessage({ data: JSON.stringify({ event: 'status', data: { message: 'Thinking... (step 5)' } }) });
        await waitFor(() => expect(h.container.querySelector('.dm-layers .v').textContent).toBe('5'));

        for (let i = 0; i < 200; i++) {
            h.sockets[0].onmessage({ data: JSON.stringify({ event: 'stream', data: { chunk: 'x' } }) });
        }
        await settle();
        expect(h.container.querySelector('.dm-layers .v').textContent).toBe('5');
    });

    // A burst — the replay the server sends on connect — must settle into one
    // render rather than one per packet.
    it('coalesces a burst and lands on the final state', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));
        for (let n = 1; n <= 12; n++) {
            h.sockets[0].onmessage({
                data: JSON.stringify({ event: 'status', data: { message: `Thinking... (step ${n})` } }),
            });
        }
        await waitFor(() => expect(h.container.querySelector('.dm-layers .v').textContent).toBe('12'));
    });

    // Reported: choosing Memory or Stats snapped straight back to Run. The server
    // replays the whole task on connect, so a CONTINUED task's replay carries the
    // previous turn's `complete`. That closed the socket, reloaded, and cleared
    // the tab — and since the task was still running the socket reopened and did
    // it again, about once a second.
    it('does not treat a continued task as finished, and keeps the chosen tab', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));

        // The replay of a task that was continued: an old completion, then the
        // new turn.
        for (const p of [
            { event: 'status', data: { status: 'running', message: 'Thinking... (step 1)' } },
            { event: 'complete', data: {} },
            { event: 'status', data: { status: 'running', message: 'Thinking... (step 1)' } },
            { event: 'status', data: { status: 'running', message: 'Thinking... (step 2)' } },
        ]) {
            h.sockets[0].onmessage({ data: JSON.stringify(p) });
        }

        // Reaching step 2 at all is the load-bearing assertion: a run wrongly
        // judged finished closes the socket at the old `complete`, and every
        // packet after it is dropped.
        await waitFor(() => expect(h.container.querySelector('.dm-layers .v').textContent).toBe('2'));
        expect(h.sockets[0].close).not.toHaveBeenCalled();

        const memoryBtn = () => [...h.container.querySelectorAll('.dt-tab')].find(b => /Memory/.test(b.textContent));
        await fireEvent.click(memoryBtn());
        await waitFor(() => expect(memoryBtn().classList.contains('is-on')).toBe(true));

        // …and it stays chosen while the run keeps streaming.
        h.sockets[0].onmessage({
            data: JSON.stringify({ event: 'status', data: { status: 'running', message: 'Thinking... (step 3)' } }),
        });
        await settle();
        expect(memoryBtn().classList.contains('is-on')).toBe(true);
    });

    it('closes the socket on unmount — a view that has navigated away must not hold one', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));
        cleanup();
        expect(h.sockets[0].close).toHaveBeenCalled();
    });

    it('stops following and reloads when the run finishes', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        await waitFor(() => expect(h.sockets).toHaveLength(1));
        h.api.listTasks.mockClear();
        h.sockets[0].onmessage({ data: JSON.stringify({ event: 'complete' }) });
        await waitFor(() => expect(h.sockets[0].close).toHaveBeenCalled());
        await waitFor(() => expect(h.api.listTasks).toHaveBeenCalled());
    });

    it('survives a socket that cannot be opened', async () => {
        const h = mountRoot({ tasks: [task({ status: 'running' })] });
        h.openSocket.mockImplementation(() => { throw new Error('nope'); });
        await settle();
        expect(h.container.querySelector('.dash')).toBeTruthy();
    });
});

describe('the Run pane', () => {
    const run = (over = {}) => ({
        step: 5, tokens: { prompt: 100, completion: 20, cacheRead: 0 },
        steps: [], files: new Set(), recalls: [], switches: [], phases: [],
        escalated: false, finished: false, ...over,
    });
    const paneOf = (props) => render(RunPane, {
        props: { task: task({ status: 'running' }), rates: {}, now: NOW, ...props },
    }).container;

    it('waits visibly before the first step rather than looking broken', () => {
        expect(paneOf({ run: run() }).textContent).toMatch(/Waiting for the first step/);
    });

    it('says nothing about cost when no rates are configured', () => {
        expect(paneOf({ run: run() }).textContent).toMatch(/no \$\/1M rates set/);
    });

    it('names the memories the run pulled in, and when', () => {
        const el = paneOf({
            run: run({ recalls: [{ source: 'brief', type: 'insight', headline: 'read first' }] }),
        });
        expect(el.textContent).toMatch(/Memory in play · 1/);
        expect(el.textContent).toMatch(/brief/);
        expect(el.textContent).toMatch(/read first/);
    });

    it('says nothing is running when there is no task', () => {
        expect(paneOf({ task: null, run: null }).textContent).toMatch(/Nothing is running/);
    });
});

describe('the Stats tab', () => {
    const paneOf = (props) => render(StatsPane, {
        props: { rateFor: rateLookup(RATED), flatRate: 0, now: NOW, ...props },
    }).container;

    it('invites a first run rather than showing zeros', () => {
        expect(paneOf({ tasks: [] }).textContent).toMatch(/No tasks yet/);
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

describe('the launcher hands off to the Monitor modal', () => {
    it('stores the typed prompt and workspace, then navigates to Monitor', async () => {
        const h = mountRoot({ tasks: [], config: { approved_projects: ['C:/proj'] } });
        await waitFor(() => expect(h.container.querySelector('.dl-input')).toBeTruthy());
        await fireEvent.input(h.container.querySelector('.dl-input'), { target: { value: 'ship it' } });
        await fireEvent.submit(h.container.querySelector('form.dl'));

        expect(h.navigate).toHaveBeenCalledWith('#monitor');
        const stored = JSON.parse(localStorage.getItem('jh_open_new_task'));
        expect(stored.prompt).toBe('ship it');
        expect(stored.ws).toBe('C:/proj');
    });

    it('does nothing on an empty prompt', async () => {
        const h = mountRoot({ tasks: [] });
        await waitFor(() => expect(h.container.querySelector('form.dl')).toBeTruthy());
        await fireEvent.submit(h.container.querySelector('form.dl'));
        expect(h.navigate).not.toHaveBeenCalled();
    });

    it('lets the user browse for a launch workspace', async () => {
        const h = mountRoot({ tasks: [] });
        await waitFor(() => expect(h.container.querySelector('.dl-browse')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.dl-browse'));
        await waitFor(() => expect(h.container.querySelector('.dl-ws').value).toBe('C:/picked'));
    });
});

describe('spend', () => {
    it('shows the bill with a per-model table once there is anything to bill', async () => {
        const h = mountRoot({
            tasks: [task({ model_usage: { 'i2:k3': { prompt_tokens: 1_000_000, completion_tokens: 0 } } })],
            config: { llm_instances: RATED },
        });
        await waitFor(() => expect(h.container.querySelector('.ds-tbl')).toBeTruthy());
        expect(h.container.querySelector('.ds-v').textContent).toBe('$3.00');
    });

    it('is absent entirely when nothing has been spent', async () => {
        const h = mountRoot({ tasks: [task({ token_usage: {}, model_usage: {} })] });
        await settle();
        expect(h.container.querySelector('.ds')).toBeFalsy();
    });

    it('persists the window pick', async () => {
        const h = mountRoot({
            tasks: [task({ model_usage: { 'i2:k3': { prompt_tokens: 1_000_000 } } })],
            config: { llm_instances: RATED },
        });
        await waitFor(() => expect(h.container.querySelector('.ds-range-btn')).toBeTruthy());
        await fireEvent.click([...h.container.querySelectorAll('.ds-range-btn')].find(b => b.textContent === '30d'));
        expect(localStorage.getItem('jhai_dash_spend_range')).toBe('30d');
    });
});
