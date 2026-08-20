// overviewModel — the Dashboard's selection and pricing rules.
//
// The old dashboard's problem was not that it rendered wrongly; it rendered
// exactly what it was told to, which was "every failure ever" plus a row of
// zeros. So these are about WHAT reaches the page: what is hidden, what ages
// out, what must never appear twice, and how a token becomes a number.
//
// Ported from views/__tests__/overviewView.test.js, which asserted the same
// rules by searching the generated HTML. They assert the values now.

import { describe, it, expect } from 'vitest';
import {
    ATTENTION_WINDOW_H, metricsOf, spendOf, rateLookup, flatRateOf, statusBits,
    statsTasks, statsStatuses, aggregate, modelTokenRows, taskTokens,
    taskModelLine, statsKpis, bucketOf, defaultMemoryWorkspace, knownWorkspaces,
    clip, short, money, shortModel, ago, elapsed,
} from '../overviewModel.js';

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

const RATED = {
    llm_instances: [
        { id: 'i1', name: 'Flash', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
        { id: 'i2', name: 'Kimi', model: 'k3', cost_per_1m_input: 3, cost_per_1m_output: 15 },
    ],
};
const rateFor = rateLookup(RATED.llm_instances);
const m = (tasks, opts = {}) => metricsOf(tasks, { now: NOW, rateFor, ...opts });

describe('the queue shows only what is true', () => {
    it('has no Running group when nothing is running', () => {
        expect(m([task()]).running).toEqual([]);
    });

    it('has no Waiting group when nothing is paused', () => {
        expect(m([task()]).paused).toEqual([]);
    });

    it('shows them the moment they are non-empty', () => {
        const r = m([task({ status: 'running' }), task({ status: 'paused' })]);
        expect(r.running).toHaveLength(1);
        expect(r.paused).toHaveLength(1);
    });

    it('is entirely empty when there is nothing at all', () => {
        const r = m([]);
        expect(r.running.length + r.paused.length + r.freshFailures.length + r.recent.length).toBe(0);
    });
});

describe('attention ages out', () => {
    it('lists a failure from within the window', () => {
        const r = m([task({ status: 'failed', completed_at: hAgo(2) })]);
        expect(r.freshFailures).toHaveLength(1);
        expect(r.staleFailures).toBe(0);
    });

    it('drops an older failure out of the alert entirely', () => {
        const r = m([task({ status: 'failed', completed_at: hAgo(ATTENTION_WINDOW_H + 5) })]);
        expect(r.freshFailures).toEqual([]);
    });

    it('counts what it hid rather than pretending it does not exist', () => {
        const r = m([
            task({ status: 'failed', completed_at: hAgo(ATTENTION_WINDOW_H + 5) }),
            task({ status: 'failed', completed_at: hAgo(ATTENTION_WINDOW_H + 9) }),
        ]);
        expect(r.staleFailures).toBe(2);
    });

    it('never ages out a paused task — it is waiting for a person', () => {
        const r = m([task({ status: 'paused', started_at: hAgo(500), completed_at: null })]);
        expect(r.paused).toHaveLength(1);
    });
});

describe('nothing is listed twice', () => {
    it('keeps a task shown above out of Recent', () => {
        const t = task({ status: 'failed', completed_at: hAgo(2) });
        const r = m([t]);
        expect(r.freshFailures.map(x => x.id)).toContain(t.id);
        expect(r.recent.map(x => x.id)).not.toContain(t.id);
    });

    it('keeps running and paused tasks out of Recent', () => {
        const a = task({ status: 'running' });
        const b = task({ status: 'paused' });
        const r = m([a, b, task()]);
        const recentIds = r.recent.map(x => x.id);
        expect(recentIds).not.toContain(a.id);
        expect(recentIds).not.toContain(b.id);
        expect(r.recent).toHaveLength(1);
    });
});

describe('spend is attributed per model', () => {
    const usage = (p, c, cache = 0) => ({
        prompt_tokens: p, completion_tokens: c, cache_read_input_tokens: cache,
    });
    const spend = (tasks, flat = 0) => spendOf(tasks, { rateFor, flatRate: flat });

    it('prices each model with its own rates, dearest first', () => {
        const s = spend([task({
            model_usage: { 'i1:flash': usage(1_000_000, 0), 'i2:k3': usage(1_000_000, 0) },
        })]);
        // `modelRates` labels a connection "<name> (<model>)" so two connections
        // pointing at the same model stay distinguishable.
        expect(s.rows.map(r => r.label)).toEqual(['Kimi (k3)', 'Flash (flash)']);
        expect(s.rows[0].cost).toBeCloseTo(3);
        expect(s.rows[1].cost).toBeCloseTo(0.3);
        expect(s.total).toBeCloseTo(3.3);
    });

    it('matches a bare model name as well as an id:model composite', () => {
        const s = spend([task({ model_usage: { flash: usage(1_000_000, 0) } })]);
        expect(s.rows[0].label).toBe('Flash (flash)');
        expect(s.rows[0].priced).toBe(true);
    });

    it('falls back to the flat rate and reports how much it estimated', () => {
        const s = spend([task({ model_usage: { 'unknown-model': usage(1000, 0) } })], 0.001);
        expect(s.unpriced).toBe(1000);
        expect(s.rows[0].priced).toBe(false);
        expect(s.rows[0].cost).toBeCloseTo(1);
    });

    it('attributes a task with no per-model record rather than dropping it', () => {
        const s = spend([task({ model_usage: undefined, token_usage: usage(500, 100) })], 0.001);
        expect(s.rows).toHaveLength(1);
        expect(s.rows[0].label).toBe('(unattributed)');
        expect(s.tokens).toBe(600);
    });

    // Cache accounting is provider-dependent in BOTH directions, and getting it
    // wrong once drove the input figure negative.
    it('does not bill a cached token twice for an OpenAI-compatible provider', () => {
        // DeepSeek/Kimi/Gemini: cache_read is a SUBSET of prompt_tokens.
        const s = spend([task({ model_usage: { 'i1:flash': usage(1_000_000, 0, 900_000) } })]);
        expect(s.rows[0].cost).toBeLessThan(0.3);
        expect(s.rows[0].cost).toBeGreaterThan(0);
    });

    it('never produces a negative cost', () => {
        const s = spend([task({ model_usage: { 'i1:flash': usage(1000, 0, 999_000) } })]);
        expect(s.total).toBeGreaterThanOrEqual(0);
    });
});

describe('statusBits', () => {
    it('mentions only what is actually true', () => {
        expect(statusBits(m([]))).toEqual([]);
    });

    it('names running, waiting and recent failures', () => {
        const bits = statusBits(m([
            task({ status: 'running' }), task({ status: 'paused' }),
            task({ status: 'failed', completed_at: hAgo(2) }),
        ])).join(' · ');
        expect(bits).toMatch(/1 running/);
        expect(bits).toMatch(/1 waiting for you/);
        expect(bits).toMatch(/1 failed recently/);
    });
});

describe('memory workspace selection', () => {
    it('follows the work — the newest task with a workspace', () => {
        const tasks = [task({ workspace_path: 'C:/a' }), task({ workspace_path: 'C:/b' })];
        expect(defaultMemoryWorkspace(tasks, {}, '')).toBe('C:/a');
    });

    it('falls back to the launcher\'s last workspace, then to an approved project', () => {
        expect(defaultMemoryWorkspace([], {}, 'C:/last')).toBe('C:/last');
        expect(defaultMemoryWorkspace([], { approved_projects: ['C:/p'] }, '')).toBe('C:/p');
        expect(defaultMemoryWorkspace([], {}, '')).toBe('');
    });

    it('lists known workspaces newest-run-first, de-duplicated', () => {
        const tasks = [
            task({ workspace_path: 'C:/b', started_at: hAgo(1) }),
            task({ workspace_path: 'C:/a', started_at: hAgo(5) }),
            task({ workspace_path: 'C:/b', started_at: hAgo(9) }),
        ];
        expect(knownWorkspaces(tasks, { approved_projects: ['C:/c'] }, 'C:/d'))
            .toEqual(['C:/b', 'C:/a', 'C:/c', 'C:/d']);
    });
});

describe('stats tab conditions', () => {
    const tasks = [
        task({ status: 'completed', started_at: hAgo(2) }),
        task({ status: 'failed', started_at: hAgo(2) }),
        task({ status: 'completed', started_at: hAgo(24 * 20) }),
    ];
    const pick = (o) => statsTasks(tasks, { now: NOW, ...o });

    it('defaults to all tasks', () => {
        expect(pick({})).toHaveLength(3);
    });

    it('filters by status', () => {
        expect(pick({ status: 'failed' })).toHaveLength(1);
    });

    it('filters by period', () => {
        expect(pick({ range: '7d' })).toHaveLength(2);
    });

    it('combines period and status', () => {
        expect(pick({ range: '7d', status: 'completed' })).toHaveLength(1);
    });

    it('offers only statuses that exist in history', () => {
        expect(statsStatuses(tasks)).toEqual(['completed', 'failed']);
    });

    it('keeps the selected status offered even after history changes', () => {
        expect(statsStatuses(tasks, 'aborted')).toContain('aborted');
    });
});

describe('token accounting', () => {
    it('taskTokens reads token_usage', () => {
        expect(taskTokens(task())).toBe(110);
    });

    it('taskTokens sums model_usage when token_usage is absent', () => {
        expect(taskTokens({ model_usage: { a: { total_tokens: 5 }, b: { total_tokens: 7 } } })).toBe(12);
    });

    it('taskTokens falls back to 0', () => {
        expect(taskTokens({})).toBe(0);
    });

    it('modelTokenRows splits tokens per model with the ↑⚡↓ shape', () => {
        const r = modelTokenRows([task({
            model_usage: {
                k3: { prompt_tokens: 100, cache_read_input_tokens: 40, completion_tokens: 10 },
                flash: { prompt_tokens: 10, completion_tokens: 1 },
            },
        })]);
        expect(r.rows[0].model).toBe('k3');
        expect(r.rows[0]).toMatchObject({ in: 100, cache: 40, out: 10, tokens: 150 });
        expect(r.anyCache).toBe(true);
    });

    it('modelTokenRows marks no cache when none is reported', () => {
        expect(modelTokenRows([task()]).anyCache).toBe(false);
    });

    it('modelTokenRows skips empty usage records', () => {
        expect(modelTokenRows([{ model_usage: { x: {} } }]).rows).toEqual([]);
    });

    it('taskModelLine summarises a task\'s models with cache detail', () => {
        const line = taskModelLine(task({
            model_usage: { 'i2:k3': { prompt_tokens: 100_000, cache_read_input_tokens: 20_000, completion_tokens: 3_000 } },
        }));
        expect(line).toContain('k3');
        expect(line).toContain('⚡');
    });

    it('taskModelLine falls back to the flat usage when no model record exists', () => {
        expect(taskModelLine(task({ model_usage: undefined }))).toContain('(all)');
    });

    it('taskModelLine is empty when there is no usage at all', () => {
        expect(taskModelLine({})).toBe('');
    });
});

describe('aggregation', () => {
    const opts = { rateFor, flatRate: 0, now: NOW };

    it('buckets by month, week, day and workspace', () => {
        const t = task({ completed_at: new Date(2026, 7, 12, 9, 0).toISOString(), workspace_path: 'C:/work/proj' });
        expect(bucketOf(t, 'month', NOW)).toBe('2026-08');
        expect(bucketOf(t, 'day', NOW)).toBe('2026-08-12');
        expect(bucketOf(t, 'week', NOW)).toMatch(/^2026-W\d\d$/);
        expect(bucketOf(t, 'ws', NOW)).toBe('proj');
    });

    it('names a task with no workspace rather than bucketing it as empty', () => {
        expect(bucketOf(task(), 'ws', NOW)).toBe('(no workspace)');
    });

    it('sums cost per bucket, dearest first', () => {
        const a = task({ completed_at: new Date(2026, 6, 1).toISOString(), model_usage: { 'i2:k3': { prompt_tokens: 1_000_000 } } });
        const b = task({ completed_at: new Date(2026, 7, 1).toISOString(), model_usage: { 'i1:flash': { prompt_tokens: 1_000_000 } } });
        const agg = aggregate([a, b], 'month', opts);
        expect(agg.rows[0].label).toBe('2026-07');
        expect(agg.rows[0].cost).toBeCloseTo(3);
        expect(agg.total).toBeCloseTo(3.3);
    });

    it('cutting by model uses the connection label', () => {
        const agg = aggregate([task({ model_usage: { 'i1:flash': { prompt_tokens: 1000 } } })], 'model', opts);
        expect(agg.rows[0].label).toBe('Flash (flash)');
    });
});

describe('statsKpis', () => {
    it('reports success rate over ENDED tasks only', () => {
        const k = statsKpis(
            [task({ status: 'completed' }), task({ status: 'failed' }), task({ status: 'running' })],
            { rateFor, flatRate: 0 },
        );
        expect(k.count).toBe(3);
        expect(k.done).toBe(1);
        expect(k.failed).toBe(1);
        expect(k.successRate).toBe(50);
    });

    it('has no success rate when nothing has ended', () => {
        expect(statsKpis([task({ status: 'running' })], { rateFor, flatRate: 0 }).successRate).toBeNull();
    });

    it('is safe on an empty set', () => {
        const k = statsKpis([], { rateFor, flatRate: 0 });
        expect(k).toMatchObject({ count: 0, avgCost: 0, avgTokens: 0, successRate: null });
    });
});

describe('formatters', () => {
    it('clip collapses whitespace and adds an ellipsis', () => {
        expect(clip('a   b', 10)).toBe('a b');
        expect(clip('abcdefghij', 5)).toBe('abcd…');
    });

    it('short uses k and M', () => {
        expect(short(999)).toBe('999');
        expect(short(1500)).toBe('2k');
        expect(short(2_500_000)).toBe('2.5M');
    });

    // Costs are often fractions of a cent; two decimals would print "$0.00".
    it('money never prints a misleading $0.00', () => {
        expect(money(0)).toBe('$0');
        expect(money(0.004)).toBe('<$0.01');
        expect(money(1.234)).toBe('$1.23');
        expect(money(42.7)).toBe('$43');
    });

    it('shortModel drops the connection id', () => {
        expect(shortModel('inst_17:deepseek-v4')).toBe('deepseek-v4');
        expect(shortModel('flash')).toBe('flash');
        expect(shortModel('')).toBe('(unknown)');
    });

    it('ago is relative and empty for nothing', () => {
        expect(ago('', NOW)).toBe('');
        expect(ago(hAgo(0.001), NOW)).toBe('now');
        expect(ago(hAgo(3), NOW)).toBe('3h');
        expect(ago(hAgo(48), NOW)).toBe('2d');
    });

    it('elapsed reads as m:ss then h:mm', () => {
        expect(elapsed('', NOW)).toBe('—');
        expect(elapsed(new Date(NOW - 65_000).toISOString(), NOW)).toBe('1m 05s');
        expect(elapsed(new Date(NOW - 3_900_000).toISOString(), NOW)).toBe('1h 05m');
    });
});

describe('flatRateOf', () => {
    it('is 0 when nothing has been spent', () => {
        expect(flatRateOf({ totalTokens: 0, estimatedCost: 0 })).toBe(0);
        expect(flatRateOf(undefined)).toBe(0);
    });

    it('is cost per token otherwise', () => {
        expect(flatRateOf({ totalTokens: 1000, estimatedCost: 2 })).toBeCloseTo(0.002);
    });
});
