// JobManager — one registry, three ways in, one history.
//
// What is genuinely new here (and so what these tests are about): the single
// store, the cross-job timeline that records what did NOT fire, and spend
// accumulated per job. The guards themselves are TriggerEngine's and are tested
// there; this checks that jobs are wired onto them correctly.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../AgentModes.js', () => ({
    DEFAULT_MODE_ID: 'general',
    buildBehavior: () => ({}),
}));

const { JobManager } = await import('../jobs/JobManager.js');

/** A localStorage stand-in, so nothing here touches a real one. */
function fakeStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        _map: map,
    };
}

const EVENT_JOB = {
    id: 'job_a', name: 'DL記録', purpose: 'ダウンロード数を追う', enabled: true,
    prompt: '{{payload.value}} を記録', workspacePath: 'C:/w',
    triggers: [{ kind: 'event', match: { event: 'release.downloaded' } }],
    debounceMs: 0, dedupeWindowMs: 0,
};
const EVENT = { source: 'watcher', event: 'release.downloaded', key: 'k1', payload: { value: 5 } };

let mgr, client, calls;
beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    client = {
        request: vi.fn(async (path, opts) => {
            calls.push({ path, body: JSON.parse(opts.body) });
            return { task_id: 'task-1' };
        }),
        getTask: vi.fn(async () => ({ status: 'completed', token_usage: { total_tokens: 1500, cost: 0.04 } })),
    };
    mgr = new JobManager({
        storage: fakeStorage({ jh_jobs: JSON.stringify([EVENT_JOB]) }),
        client,
    });
    mgr.load();
});

describe('one store, one record per intention', () => {
    it('converts the three old stores on first load, and leaves them in place', () => {
        const storage = fakeStorage({
            jh_schedules: JSON.stringify([{ id: 's1', name: '週次', enabled: true, prompt: 'p', time: '09:00' }]),
            jh_triggers: JSON.stringify([{ id: 't1', name: 'DL', enabled: true, prompt: 'q', match: { event: 'e' } }]),
            jh_watchers: JSON.stringify([{ id: 'w1', name: 'gh', type: 'http', eventName: 'e' }]),
        });
        const m = new JobManager({ storage, client });
        m.load();

        expect(m.jobs).toHaveLength(2);
        expect(m.sources).toHaveLength(1);
        // A conversion that deletes its input has to be right first time.
        expect(storage.getItem('jh_schedules')).toBeTruthy();
        expect(storage.getItem('jh_watchers')).toBeTruthy();
    });

    it('does not re-convert once jobs exist', () => {
        const storage = fakeStorage({
            jh_jobs: JSON.stringify([EVENT_JOB]),
            jh_schedules: JSON.stringify([{ id: 's1', prompt: 'p' }]),
        });
        const m = new JobManager({ storage, client });
        m.load();
        expect(m.jobs).toHaveLength(1);
        expect(m.jobs[0].id).toBe('job_a');
    });

    it('can be emptied', () => {
        mgr.reset();
        expect(mgr.jobs).toEqual([]);
        expect(mgr.timeline).toEqual([]);
    });
});

describe('an event starts the job it belongs to', () => {
    it('runs it, and says in the task why it exists', async () => {
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());

        expect(client.request).toHaveBeenCalledTimes(1);
        expect(calls[0].body.prompt).toBe('5 を記録');
        expect(calls[0].body.caller).toBe('Job');
        expect(calls[0].body.behavior.mcp_context.job)
            .toMatchObject({ id: 'job_a', name: 'DL記録', purpose: 'ダウンロード数を追う' });
    });

    it('records the run against the job', async () => {
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());
        expect(mgr.jobs[0].runs.at(-1)).toMatchObject({ status: 'started', taskId: 'task-1', kind: 'event' });
    });
});

describe('a time trigger starts it on the minute', () => {
    const timeJob = {
        id: 'job_t', name: '週次', enabled: true, prompt: 'まとめて',
        triggers: [{ kind: 'time', scheduleType: 'fixed', time: '09:00', days: [1] }],
    };

    it('fires at its time, once', async () => {
        mgr.jobs = [{ ...timeJob, runs: [] }];
        const monday9 = new Date(2026, 8, 7, 9, 0);      // 2026-09-07 is a Monday
        await mgr.tickClock(monday9);
        expect(client.request).toHaveBeenCalledTimes(1);

        // Same minute again: must not start a second run.
        await mgr.tickClock(monday9);
        expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('switches a one-off off after it has happened', async () => {
        const when = new Date(2026, 8, 7, 9, 0);
        mgr.jobs = [{
            ...timeJob, runs: [],
            triggers: [{ kind: 'time', scheduleType: 'once', onceAt: when.toISOString() }],
        }];
        await mgr.tickClock(when);
        expect(mgr.jobs[0].enabled).toBe(false);
    });
});

describe('the timeline answers "why did nothing happen"', () => {
    // The old engine journal held this and lived in memory, so the evidence was
    // gone by morning — which is exactly when it is wanted.
    it('records a drop with its reason, and survives a reload', () => {
        mgr.setEnabled('job_a', false);
        mgr.onEvent(EVENT);

        const last = mgr.timeline.at(-1);
        expect(last).toMatchObject({ jobId: 'job_a', outcome: 'dropped' });
        expect(last.why).toContain('無効');

        const reloaded = new JobManager({ storage: mgr.storage, client });
        reloaded.load();
        expect(reloaded.timeline.at(-1).outcome).toBe('dropped');
    });

    it('records an event that matched no job at all', () => {
        mgr.onEvent({ source: 'webhook', event: 'nobody.wants.this', payload: {} });
        expect(mgr.timeline.at(-1)).toMatchObject({ outcome: 'unmatched', event: 'nobody.wants.this' });
    });

    it('records what DID run, with the task it started', async () => {
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());
        expect(mgr.timeline.at(-1)).toMatchObject({ jobId: 'job_a', outcome: 'started', taskId: 'task-1' });
    });

    it('stays bounded', () => {
        for (let i = 0; i < 500; i++) mgr.onEvent({ source: 'x', event: `e${i}`, payload: {} });
        expect(mgr.timeline.length).toBeLessThanOrEqual(400);
    });
});

describe('spend', () => {
    it('is accumulated when a task finishes', async () => {
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());
        // The cost is priced by the CALLER (from the task's per-model
        // breakdown) and handed in — the server's token report has no cost
        // field, so reading one off `usage` was always 0.
        mgr.noteUsage('job_a', 'task-1', { total_tokens: 1500 }, 0.04);

        expect(mgr.jobs[0].spent).toEqual({ tokens: 1500, cost: 0.04, runs: 1 });
        expect(mgr.jobs[0].runs.at(-1)).toMatchObject({ tokens: 1500, status: 'completed' });
    });

    it('counts a run once, however many times the report arrives', async () => {
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());
        mgr.noteUsage('job_a', 'task-1', { total_tokens: 1500 }, 0.04);
        mgr.noteUsage('job_a', 'task-1', { total_tokens: 1500 }, 0.04);
        expect(mgr.jobs[0].spent.runs).toBe(1);
    });

    // Closing the app between a run starting and finishing must not lose that
    // run's cost: a total that quietly under-reports is worse than no total.
    it('fills in runs that finished while the app was closed', async () => {
        mgr.jobs[0].runs = [{ at: 'x', taskId: 'task-9', status: 'started' }];
        const filled = await mgr.reconcile();
        expect(filled).toBe(1);
        expect(mgr.jobs[0].spent.tokens).toBe(1500);
    });

    it('leaves a still-running task for next time', async () => {
        client.getTask = vi.fn(async () => ({ status: 'running' }));
        mgr.jobs[0].runs = [{ at: 'x', taskId: 'task-9', status: 'started' }];
        expect(await mgr.reconcile()).toBe(0);
        expect(mgr.jobs[0].spent.tokens).toBe(0);
    });

    // The limit is inert until set, so the accumulation can start now and the
    // enforcement becomes a form field later.
    it('does nothing until a budget is set', async () => {
        mgr.jobs[0].spent = { tokens: 999999, cost: 9, runs: 20 };
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());
        expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('refuses to start once the budget is reached, and says so', async () => {
        mgr.jobs[0].budgetTokens = 1000;
        mgr.jobs[0].spent = { tokens: 1200, cost: 0.5, runs: 3 };
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());

        expect(client.request).not.toHaveBeenCalled();
        const run = mgr.jobs[0].runs.at(-1);
        expect(run.status).toBe('skipped');
        expect(run.error).toContain('予算');
        expect(mgr.timeline.at(-1).outcome).toBe('over-budget');
    });
});

describe('a prompt the event could not fill never becomes a task', () => {
    it('is refused with the field named', async () => {
        mgr.jobs[0].prompt = '{{payload.missing}} を記録';
        mgr._syncEngine();
        mgr.onEvent(EVENT);
        await mgr.tickEvents(Date.now());

        expect(client.request).not.toHaveBeenCalled();
        expect(mgr.jobs[0].runs.at(-1).error).toContain('{{payload.missing}}');
    });
});

describe('everything off, at once', () => {
    it('disables every job and records that it happened', () => {
        mgr.pauseAll();
        expect(mgr.jobs.every(j => !j.enabled)).toBe(true);
        expect(mgr.timeline.at(-1).outcome).toBe('paused-all');
    });
});

describe('a watch trigger does not make you type the event name twice', () => {
    const SOURCE = { id: 'w1', name: 'github', type: 'http', eventName: 'release.downloaded' };
    const WATCH_JOB = {
        id: 'job_w', name: 'DL記録', enabled: true, prompt: '記録する',
        triggers: [{ kind: 'watch', sourceId: 'w1' }],
        debounceMs: 0, dedupeWindowMs: 0,
    };

    beforeEach(() => {
        mgr.jobs = [WATCH_JOB];
        mgr.sources = [SOURCE];
        mgr._syncEngine();
    });

    it('derives the match from the source it points at', async () => {
        mgr.onEvent({ source: 'watcher', watcherId: 'w1', event: 'release.downloaded', key: 'k', payload: {} });
        await mgr.tickEvents(Date.now());
        expect(client.request).toHaveBeenCalledTimes(1);
    });

    // Two watchers may share an event name; a job attached to one must not fire
    // on the other's events.
    it('ignores the same event name from a different watcher', async () => {
        mgr.onEvent({ source: 'watcher', watcherId: 'w2', event: 'release.downloaded', key: 'k', payload: {} });
        await mgr.tickEvents(Date.now());
        expect(client.request).not.toHaveBeenCalled();
    });

    // A source that was deleted leaves the job pointing at nothing. Matching
    // everything would be far worse than matching nothing.
    it('matches nothing when the source is gone', async () => {
        mgr.sources = [];
        mgr._syncEngine();
        mgr.onEvent({ source: 'watcher', watcherId: 'w1', event: 'release.downloaded', key: 'k', payload: {} });
        await mgr.tickEvents(Date.now());
        expect(client.request).not.toHaveBeenCalled();
    });

    // An external push has no watcher, so it is matched by name — that is what
    // the separate event kind is for, and why it is not merely part of watch.
    it('still matches an external event by name alone', async () => {
        mgr.jobs = [{ ...WATCH_JOB, triggers: [{ kind: 'event', match: { event: 'ci.failed' } }] }];
        mgr._syncEngine();
        mgr.onEvent({ source: 'webhook', event: 'ci.failed', key: 'k', payload: {} });
        await mgr.tickEvents(Date.now());
        expect(client.request).toHaveBeenCalledTimes(1);
    });
});

describe('the watchers have one owner', () => {
    // They were copied into a second key with two writers: editing a watcher in
    // the panel updated one store while the job's matcher kept reading the
    // other, so the job stopped firing with nothing anywhere to say why.
    const SOURCE = { id: 'w1', name: 'github', eventName: 'release.downloaded' };

    it('reads them from the store WatcherManager writes', () => {
        const storage = fakeStorage({
            jh_jobs: JSON.stringify([{ id: 'j', name: 'x', enabled: true, prompt: 'p',
                                       triggers: [{ kind: 'watch', sourceId: 'w1' }] }]),
            jh_watchers: JSON.stringify([SOURCE]),
        });
        const m = new JobManager({ storage, client });
        m.load();
        expect(m.sources).toHaveLength(1);
        expect(m.engine.triggers[0].match).toEqual({ watcherId: 'w1', event: 'release.downloaded' });
    });

    it('does not write them back when a job is saved', () => {
        const storage = fakeStorage({ jh_watchers: JSON.stringify([SOURCE]) });
        const m = new JobManager({ storage, client });
        m.load();
        m.upsert({ id: 'j2', name: 'y', prompt: 'p', triggers: [] });
        expect(JSON.parse(storage.getItem('jh_watchers'))).toEqual([SOURCE]);
    });

    // A rename in the panel has to reach the jobs, or the job silently stops
    // matching the source it points at.
    it('re-derives its matchers when the watchers change underneath it', () => {
        const storage = fakeStorage({
            jh_jobs: JSON.stringify([{ id: 'j', name: 'x', enabled: true, prompt: 'p',
                                       triggers: [{ kind: 'watch', sourceId: 'w1' }] }]),
            jh_watchers: JSON.stringify([SOURCE]),
        });
        const m = new JobManager({ storage, client });
        m.load();
        storage.setItem('jh_watchers', JSON.stringify([{ ...SOURCE, eventName: 'renamed' }]));
        m.refreshSources();
        expect(m.engine.triggers[0].match.event).toBe('renamed');
    });
});

describe('the cost is measured, not assumed', () => {
    // `$0.0000` on every job: the panel printed a currency amount that was only
    // the absence of a measurement, because the server's token report carries
    // no cost field at all.
    it('prices a task from its per-model breakdown and the configured rates', async () => {
        const m = new JobManager({
            storage: fakeStorage({}), client,
            invoker: async () => ({
                llm_instances: [{
                    id: 'i1', name: 'X', model: 'm1',
                    cost_per_1m_input: 1, cost_per_1m_output: 2,
                }],
            }),
        });
        const cost = await m._priceTask({
            model_usage: { 'i1:m1': { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } },
        });
        expect(cost).toBeCloseTo(3, 5);
    });

    // No rates configured is "not priced" — which is why the panel says so
    // rather than printing a zero.
    it('returns zero when nothing prices it, instead of guessing', async () => {
        const m = new JobManager({
            storage: fakeStorage({}), client,
            invoker: async () => ({ llm_instances: [] }),
        });
        expect(await m._priceTask({ model_usage: { 'x': { prompt_tokens: 100 } } })).toBe(0);
        expect(await m._priceTask(null)).toBe(0);
    });
});
