// @vitest-environment jsdom
//
// OverviewView — the Dashboard's selection rules.
//
// The old dashboard's problem was not that it rendered wrongly; it rendered
// exactly what it was told to, which was "every failure ever" plus a row of
// zeros. So the tests here are about WHAT reaches the page: what is hidden,
// what ages out, what must never appear twice, and — since the page became a
// cockpit — which half of it is showing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { OverviewView, ATTENTION_WINDOW_H } = await import('../OverviewView.js');
const { t } = await import('../../../i18n/index.js');

const hAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();

const task = (over = {}) => ({
    id: Math.random().toString(36).slice(2, 8),
    prompt: 'do a thing',
    status: 'completed',
    started_at: hAgo(1),
    completed_at: hAgo(0.5),
    token_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    ...over,
});

const RATED = {
    llm_instances: [
        { id: 'i1', name: 'Flash', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
        { id: 'i2', name: 'Kimi', model: 'k3', cost_per_1m_input: 3, cost_per_1m_output: 15 },
    ],
};

const card = (over = {}) => ({
    id: 'L-' + Math.random().toString(36).slice(2, 8),
    type: 'lesson', signature: 'write_file|mismatch',
    trigger: { tool: 'write_file', ext: '.js' },
    symptom: 'old_text did not match', fix: 're-read first',
    hits: 1, costSteps: 4, disabled: false,
    first_seen: '2026-08-01', last_recurrence: '2026-08-10',
    ...over,
});

let v;
// The view coalesces repaints behind a 250ms timer. Without tearing it down the
// timer outlives the test environment and paints into a document that is gone —
// which surfaces as a failure in whichever file happens to run next.
afterEach(() => { try { v?.destroy?.(); } catch (_) {} });

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    invoke.mockClear();
    invoke.mockImplementation(async () => '');
    v = new OverviewView();
});

/** The left column, which is where every task list lives. */
const left = (tasks, config = {}) => {
    v.tasks = tasks; v.config = config;
    return v._leftHtml(v._metrics());
};

/** The right pane, with memory loaded. */
const pane = (memory, tasks = []) => {
    v.tasks = tasks; v.memory = memory; v.memoryWs = 'C:/ws';
    return v._paneHtml(v._metrics());
};

describe('the queue shows only what is true', () => {
    it('omits the Running group when nothing is running', () => {
        expect(left([task()])).not.toContain('Running');
    });

    it('omits the Waiting group when nothing is paused', () => {
        expect(left([task()])).not.toContain('Waiting for you');
    });

    it('shows them the moment they are non-empty', () => {
        const html = left([task({ status: 'running' }), task({ status: 'paused' })]);
        expect(html).toContain('Running');
        expect(html).toContain('Waiting for you');
    });

    it('says so plainly when there is nothing at all', () => {
        expect(left([])).toContain('No tasks yet');
    });
});

describe('attention ages out', () => {
    it('lists a failure from within the window', () => {
        expect(left([task({ status: 'failed', completed_at: hAgo(2) })]))
            .toContain(`Failed · last ${ATTENTION_WINDOW_H}h`);
    });

    // A red row you cannot clear is one you stop seeing — which is what took
    // the whole page down with it.
    it('drops an older failure out of the alert entirely', () => {
        const html = left([task({ status: 'failed', id: 'old111', completed_at: hAgo(ATTENTION_WINDOW_H + 1) })]);
        expect(html).not.toContain('Failed · last');
    });

    it('counts what it hid rather than pretending it does not exist', () => {
        const html = left([
            task({ status: 'failed', completed_at: hAgo(1) }),
            task({ status: 'failed', completed_at: hAgo(500) }),
            task({ status: 'failed', completed_at: hAgo(900) }),
        ]);
        expect(html).toContain('2 older failures in Monitor');
    });

    it('never ages out a paused task', () => {
        expect(left([task({ status: 'paused', started_at: hAgo(2000), completed_at: null })]))
            .toContain('Waiting for you');
    });
});

describe('nothing is listed twice', () => {
    const rows = (html, id) => html.split(`href="#monitor?id=${id}"`).length - 1;

    it('keeps a task shown above out of Recent', () => {
        const failed = task({ id: 'dup123', status: 'failed', completed_at: hAgo(1) });
        const html = left([failed, task({ id: 'other1' })]);
        expect(rows(html, 'dup123')).toBe(1);
        expect(rows(html, 'other1')).toBe(1);
    });

    it('keeps running and paused tasks out of Recent', () => {
        const html = left([task({ id: 'run111', status: 'running' }), task({ id: 'pau111', status: 'paused' })]);
        expect(rows(html, 'run111')).toBe(1);
        expect(rows(html, 'pau111')).toBe(1);
    });
});

describe('spend is attributed per model', () => {
    const mk = (model, prompt, completion) => task({
        started_at: hAgo(2),
        model_usage: { [model]: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } },
    });

    it('prices each model with its own rates, dearest first', () => {
        v.tasks = [mk('i2:k3', 1e6, 0), mk('i1:flash', 1e6, 0)];
        v.config = RATED;
        const s = v._spend(v.tasks);
        expect(s.rows.find(r => r.label.includes('Kimi')).cost).toBeCloseTo(3, 5);
        expect(s.rows.find(r => r.label.includes('Flash')).cost).toBeCloseTo(0.3, 5);
        expect(s.rows[0].label).toContain('Kimi');
    });

    // The run records whichever id it sent: the id:model composite under tier
    // routing, the bare model name otherwise. Missing one form would silently
    // drop half a mixed history into "unpriced".
    it('matches a bare model name as well as an id:model composite', () => {
        v.tasks = [mk('k3', 1e6, 0)];
        v.config = RATED;
        expect(v._spend(v.tasks).unpriced).toBe(0);
    });

    it('falls back to the flat rate and reports how much it estimated', () => {
        v.tasks = [mk('unconfigured', 1e6, 0)];
        v.config = RATED;
        v.stats = { totalTokens: 1e6, estimatedCost: 2 };
        const s = v._spend(v.tasks);
        expect(s.unpriced).toBe(1e6);
        expect(s.total).toBeCloseTo(2, 5);
    });

    it('attributes a task with no per-model record rather than dropping it', () => {
        v.tasks = [task({ started_at: hAgo(2) })];
        v.config = RATED;
        v.stats = { totalTokens: 1000, estimatedCost: 1 };
        expect(v._spend(v.tasks).rows[0].label).toBe('(unattributed)');
    });

    // Cache accounting differs by provider and getting it wrong is expensive in
    // both directions. Kimi/DeepSeek/OpenAI/Gemini report cache INSIDE
    // prompt_tokens; Anthropic reports it beside them.
    it('does not bill a cached token twice for an OpenAI-compatible provider', () => {
        // A real step from Kimi: ↑137,506 of which 135,680 cached, ↓211,
        // total 137,717 — so total = prompt + completion, cache is a subset.
        v.tasks = [task({
            started_at: hAgo(2),
            model_usage: { 'i2:k3': {
                prompt_tokens: 137506, completion_tokens: 211,
                cache_read_input_tokens: 135680, total_tokens: 137717,
            } },
        })];
        v.config = RATED;
        // fresh 1,826 @ $3 + cached 135,680 @ $0.30(=input×0.1) + out 211 @ $15
        const expected = 1826 / 1e6 * 3 + 135680 / 1e6 * 0.3 + 211 / 1e6 * 15;
        expect(v._spend(v.tasks).total).toBeCloseTo(expected, 6);
    });

    // Subtracting unconditionally drove this negative before the fix.
    it('does not subtract a cache that was never inside the prompt count', () => {
        v.tasks = [task({
            started_at: hAgo(2),
            // Anthropic shape: input is small, cache_read is separate and large,
            // and the total reflects both.
            model_usage: { 'i2:k3': {
                prompt_tokens: 1000, completion_tokens: 500,
                cache_read_input_tokens: 50000, total_tokens: 51500,
            } },
        })];
        v.config = RATED;
        const expected = 1000 / 1e6 * 3 + 50000 / 1e6 * 0.3 + 500 / 1e6 * 15;
        const got = v._spend(v.tasks).total;
        expect(got).toBeGreaterThan(0);
        expect(got).toBeCloseTo(expected, 6);
    });

    it('points at the tier setting only when one model dominates', () => {
        v.stats = { totalTokens: 1, estimatedCost: 0 };
        expect(left([mk('i2:k3', 1e7, 0), mk('i1:flash', 1e5, 0)], RATED))
            .toContain('switch models within one task');
        expect(left([mk('i2:k3', 1e6, 0), mk('i1:flash', 1e7, 0)], RATED))
            .not.toContain('switch models within one task');
    });
});

describe('the right pane picks its own tab', () => {
    it('shows the run when one is running', () => {
        v.tasks = [task({ status: 'running' })];
        expect(v._activeTab(v._metrics())).toBe('run');
    });

    it('shows memory when nothing is running — the pane is never blank', () => {
        v.tasks = [task()];
        expect(v._activeTab(v._metrics())).toBe('memory');
    });

    it('lets an explicit choice win over the automatic one', () => {
        v.tasks = [task({ status: 'running' })];
        v.tab = 'memory';
        expect(v._activeTab(v._metrics())).toBe('memory');
    });

    it('disables the Run tab when there is nothing to show', () => {
        v.tasks = [task()];
        expect(v._tabsHtml(v._metrics())).toContain('disabled');
    });
});

describe('the memory pane', () => {
    const mem = (over = {}) => ({ facts: [], episodes: [], cards: [], ...over });

    it('says what is stored, by layer', () => {
        const html = pane(mem({
            facts: [{ fact: 'a', type: 'semantic' }, { fact: 'b', type: 'episodic' }],
            cards: [card(), card({ type: 'insight' })],
            episodes: [{}, {}],
        }));
        expect(html).toContain('DURABLE');
        expect(html).toContain('LESSONS');
    });

    it('explains an empty store instead of drawing empty boxes', () => {
        expect(pane(mem())).toContain('Nothing learned yet');
    });

    it('asks for a workspace when there is none, rather than looking broken', () => {
        v.tasks = []; v.memory = mem(); v.memoryWs = '';
        expect(v._paneHtml(v._metrics())).toContain('No workspace yet');
    });

    // The headline is an OUTCOME, not the card's own confidence: a useless
    // lesson is exactly as confident as a good one.
    it('leads with whether the lessons actually held', () => {
        const html = pane(mem({ cards: [card({ shown: 4, recurrences_after_hit: 0 })] }));
        expect(html).toContain('Is it working?');
        expect(html).toContain('held — failure stopped');
        expect(html).not.toMatch(/confidence/i);
    });

    it('names a card that keeps failing, with a switch', () => {
        const bad = card({ id: 'L-bad', shown: 6, recurrences_after_hit: 5 });
        const html = pane(mem({ cards: [bad] }));
        expect(html).toContain('Not earning their place');
        expect(html).toContain('data-card="L-bad"');
    });

    it('does not claim a verdict when nothing has been surfaced yet', () => {
        const html = pane(mem({ cards: [card()] }));
        expect(html).toContain('none surfaced to a run yet');
        expect(html).not.toContain('held — failure stopped');
    });

    it('lists what it knows WITHOUT being searched', () => {
        // Reported: the panel showed "14 facts" and none of them. The body only
        // rendered once a query was typed, and the one list it had covered cards.
        const html = pane(mem({
            facts: [{ fact: 'Always run npm test', kind: 'norm', type: 'semantic', timestamp: 1 }],
            cards: [],
        }));
        expect(html).toContain('Always run npm test');
        expect(html).toContain(t('dash.mem.rules'));
    });

    it('marks what arrived since the last look, without hiding the rest', () => {
        v.memSeenAt = Date.parse('2026-08-05');
        const html = pane(mem({ cards: [card({ last_recurrence: '2026-08-09' })] }));
        expect(html).toContain(t('dash.mem.recent'));
        expect(html).toContain(t('dash.mem.new'));
    });

    it('shows failures separately, so they cannot be crowded out', () => {
        const html = pane(mem({ cards: [card({ type: 'lesson', symptom: 'anchor mismatch', costSteps: 7 })] }));
        expect(html).toContain(t('dash.mem.lessons'));
        expect(html).toContain('anchor mismatch');
    });

    it('shows search results only once something is typed', () => {
        const store = mem({ cards: [card({ symptom: 'svelte mismatch' })] });
        expect(pane(store)).not.toContain('dm-results');
        v.memQuery = 'svelte';
        expect(v._paneHtml(v._metrics())).toContain('dm-results');
    });

    it('says so when a search matches nothing', () => {
        v.memQuery = 'zzz';
        expect(pane(mem({ cards: [card()] }))).toContain('Nothing matches');
    });
});

describe('switching a card off', () => {
    beforeEach(() => {
        v.memory = { facts: [], episodes: [], cards: [card({ id: 'L-a' })] };
        v.memoryWs = 'C:/ws';
        document.body.innerHTML = v.render();
    });

    it('registers .agent as a path-guard root BEFORE writing', async () => {
        await v._toggleCard('L-a', true);
        const order = invoke.mock.calls.map(c => c[0]);
        expect(order.indexOf('set_allowed_roots')).toBeLessThan(order.indexOf('write_file'));
        expect(invoke.mock.calls.find(c => c[0] === 'set_allowed_roots')[1])
            .toEqual({ roots: ['C:/ws/.agent'] });
    });

    // JSON Lines, not a JSON array — the agent APPENDS to this file per session,
    // so writing it as an array would corrupt the next append.
    it('writes cards.jsonl back as one object per line, newline-terminated', async () => {
        await v._toggleCard('L-a', true);
        const write = invoke.mock.calls.find(c => c[0] === 'write_file')[1];
        expect(write.path).toBe('C:/ws/.agent/memory/cards.jsonl');
        expect(write.content.endsWith('\n')).toBe(true);
        expect(JSON.parse(write.content.trim()).disabled).toBe(true);
    });

    // A toggle that waits on three file operations feels broken, so the row
    // flips at once — but it must not lie if the write fails.
    it('reverts the row when the write fails', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'write_file') throw new Error('read-only volume');
            return '';
        });
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        await v._toggleCard('L-a', true);
        expect(v.memory.cards[0].disabled).toBe(false);
    });

    it('ignores an unknown id', async () => {
        await v._toggleCard('nope', true);
        expect(v.memory.cards[0].disabled).toBe(false);
    });
});

describe('watching the running task', () => {
    // A live view leaks in two ways: a socket that outlives the view, and a
    // socket that keeps painting into a DOM that has been replaced. Both.
    class FakeSocket {
        static made = [];
        constructor(url) { this.url = url; this.closed = false; FakeSocket.made.push(this); }
        close() { this.closed = true; }
        send(p) { this.onmessage?.({ data: JSON.stringify(p) }); }
    }

    beforeEach(() => {
        FakeSocket.made = [];
        globalThis.WebSocket = FakeSocket;
        window.apiClient = { port: '14300', token: 'tok', getStats: async () => null,
            listTasks: async () => [], getConfig: async () => null };
        v.memory = { facts: [], episodes: [], cards: [] };
        document.body.innerHTML = v.render();
    });

    it('opens one socket for the running task', () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v._watchRunning();
        expect(FakeSocket.made).toHaveLength(1);
        expect(FakeSocket.made[0].url).toContain('/ws/tasks/run111');
        expect(FakeSocket.made[0].url).toContain('token=tok');
    });

    it('opens nothing when nothing is running', () => {
        v.tasks = [task()];
        v._watchRunning();
        expect(FakeSocket.made).toHaveLength(0);
    });

    it('does not reopen the socket for the same task', () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v._watchRunning();
        v._watchRunning();
        expect(FakeSocket.made).toHaveLength(1);
    });

    it('closes the old socket when the running task changes', () => {
        v.tasks = [task({ id: 'a', status: 'running' })];
        v._watchRunning();
        v.tasks = [task({ id: 'b', status: 'running' })];
        v._watchRunning();
        expect(FakeSocket.made[0].closed).toBe(true);
        expect(FakeSocket.made).toHaveLength(2);
    });

    it('reduces incoming packets into the run state', () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v._watchRunning();
        FakeSocket.made[0].send({ event: 'status', data: { status: 'running', message: 'Thinking... (step 9)' } });
        FakeSocket.made[0].send({ event: 'log', data: { method: 'TOOL', name: 'read_file', request: { path: 'a.js' } } });
        expect(v.run.step).toBe(9);
        expect(v.run.steps.at(-1).text).toContain('read_file');
    });

    it('closes the socket on destroy — a view that has navigated away must not hold one', () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v._watchRunning();
        v.destroy();
        expect(FakeSocket.made[0].closed).toBe(true);
    });

    it('ignores a packet that arrives after destroy', () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v._watchRunning();
        const s = FakeSocket.made[0];
        v.destroy();
        expect(() => s.send({ event: 'status', data: { message: 'late' } })).not.toThrow();
        expect(v.run).toBeNull();
    });

    it('stops following and reloads when the run finishes', async () => {
        v.tasks = [task({ id: 'run111', status: 'running' })];
        v.tab = 'run';
        v._watchRunning();
        FakeSocket.made[0].send({ event: 'complete', data: {} });
        expect(FakeSocket.made[0].closed).toBe(true);
        // The pane falls back to its automatic choice, which is Memory, once
        // the reload settles.
        await new Promise(r => setTimeout(r, 0));
        expect(v.tab).toBeNull();
    });

    it('survives a socket that cannot be opened', () => {
        globalThis.WebSocket = function () { throw new Error('refused'); };
        v.tasks = [task({ id: 'run111', status: 'running' })];
        expect(() => v._watchRunning()).not.toThrow();
    });
});

describe('the Run pane', () => {
    const runTask = task({ id: 'r1', status: 'running', prompt: 'Refactor auth', started_at: hAgo(0.1) });

    it('shows the phase rail once the run reports a phase', () => {
        v.tasks = [runTask]; v.tab = 'run'; v.config = RATED;
        v.run = { steps: [], step: 3, phase: 'execute', phaseSeen: { plan: { model: 'i2:k3', tokens: 4000 } },
            escalated: false, recalls: [], tokens: { prompt: 0, completion: 0, cacheRead: 0 },
            byModel: {}, files: new Set(), finished: false };
        const html = v._paneHtml(v._metrics());
        expect(html).toContain('PLAN');
        expect(html).toContain('EXECUTE · now');
        expect(html).toContain('REVIEW');
    });

    // The join between the two halves of this page.
    it('names the memories the run pulled in, and when', () => {
        v.tasks = [runTask]; v.tab = 'run';
        v.run = { steps: [], step: 12, phase: null, phaseSeen: {}, escalated: false,
            recalls: [{ id: 'L-2', type: 'lesson', recipe: 'no line numbers', at: 12, source: 'tool' }],
            tokens: { prompt: 0, completion: 0, cacheRead: 0 }, byModel: {}, files: new Set(), finished: false };
        const html = v._paneHtml(v._metrics());
        expect(html).toContain('Memory in play');
        expect(html).toContain('step 12');
        expect(html).toContain('no line numbers');
    });

    it('says nothing about cost when no rates are configured', () => {
        v.tasks = [runTask]; v.tab = 'run'; v.config = {};
        v.run = { steps: [], step: 1, phase: null, phaseSeen: {}, escalated: false, recalls: [],
            tokens: { prompt: 100, completion: 10, cacheRead: 0 },
            byModel: { 'x': { prompt: 100, completion: 10, cacheRead: 0 } },
            files: new Set(), finished: false };
        expect(v._paneHtml(v._metrics())).toContain('no $/1M rates set');
    });

    it('waits visibly before the first step rather than looking broken', () => {
        v.tasks = [runTask]; v.tab = 'run';
        v.run = null;
        expect(v._paneHtml(v._metrics())).toContain('Waiting for the first step');
    });
});

describe('the launcher hands off to the Monitor modal', () => {
    // Reimplementing task creation here would give two creation paths, and the
    // dashboard's would be the one missing mode / MCP / templates / attachments.
    beforeEach(() => {
        v.tasks = []; v.config = {}; v.memory = { facts: [], episodes: [], cards: [] };
        document.body.innerHTML = v.render();
        v._paint();
    });

    it('stores the typed prompt and workspace, then navigates to Monitor', () => {
        document.getElementById('dash-prompt').value = '  refactor the parser  ';
        document.getElementById('dash-ws').value = 'C:\\ws';
        document.getElementById('dash-launch').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }));

        expect(JSON.parse(localStorage.getItem('jh_open_new_task')))
            .toEqual({ prompt: 'refactor the parser', ws: 'C:\\ws' });
        expect(localStorage.getItem('jhai_last_ws')).toBe('C:\\ws');
        expect(window.location.hash).toBe('#monitor');
    });

    it('does nothing on an empty prompt', () => {
        window.location.hash = '';
        localStorage.removeItem('jh_open_new_task');
        document.getElementById('dash-launch').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }));
        expect(localStorage.getItem('jh_open_new_task')).toBeNull();
    });
});

describe('workspace pickers', () => {
    beforeEach(() => {
        v.tasks = []; v.config = {}; v.memory = { facts: [], episodes: [], cards: [] };
        document.body.innerHTML = v.render();
        v._paint();
    });

    it('lets the user browse for a launch workspace', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'select_folder') return 'C:\\picked';
            return '';
        });
        document.getElementById('dash-ws-browse').click();
        await new Promise(r => setTimeout(r, 0));
        expect(document.getElementById('dash-ws').value).toBe('C:\\picked');
    });

    it('lets the user change which workspace the memory pane shows', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'read_file') return '';
            return '';
        });
        const input = document.getElementById('dash-mem-ws');
        input.value = 'D:\\other';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
        expect(v.memoryWs).toBe('D:\\other');
    });

    it('lets the user browse for a memory workspace', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'select_folder') return 'D:\\mem-ws';
            if (cmd === 'read_file') return '';
            return '';
        });
        document.getElementById('dash-mem-ws-browse').click();
        await new Promise(r => setTimeout(r, 0));
        expect(v.memoryWs).toBe('D:\\mem-ws');
        expect(document.getElementById('dash-mem-ws').value).toBe('D:\\mem-ws');
    });

    it('keeps an in-progress memory workspace edit across repaints', () => {
        const input = document.getElementById('dash-mem-ws');
        input.value = 'E:\\typing';
        v._paint();
        expect(document.getElementById('dash-mem-ws').value).toBe('E:\\typing');
    });
});
