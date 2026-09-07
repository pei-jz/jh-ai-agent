// JobManager — one registry, three ways to start a job, one history.
//
// A COMPOSITION layer, deliberately. The hard parts already exist and are
// tested: TriggerEngine owns match/dedupe/debounce/cooldown/the runaway cap,
// WatcherEngine owns polling and the first-run baseline. Rewriting either to
// get a nicer list would have thrown away the guards that make autonomy safe to
// leave switched on. So this file maps jobs onto them and owns only what is
// genuinely new:
//
//   • one store instead of three, so one intention is one record;
//   • a timeline ACROSS jobs, persisted — including what did NOT fire and why,
//     which is the evidence the old in-memory journal lost on every restart;
//   • spend accumulated per job.
//
// See the design report and docs/design/autonomy-triggers.md.

import { invoke } from '@tauri-apps/api/core';
import { buildBehavior, DEFAULT_MODE_ID } from '../AgentModes.js';
import { spendOf, rateLookup } from '../../../dashboard/views/overview/overviewModel.js';
import { TriggerEngine, unresolvedPlaceholders, renderPrompt } from '../triggers/TriggerEngine.js';
import {
    JOB_DEFAULTS, RUN_HISTORY, migrate, timeTriggerDue, ranThisMinute,
    overBudget, addSpend,
} from './JobModel.js';

const JOBS_KEY = 'jh_jobs';
// The watchers are OWNED by WatcherManager (`jh_watchers`) — the thing that
// actually polls them. Jobs only reference them.
//
// They were copied into `jh_sources` as well, which is a second copy of live
// data with two writers: editing a watcher in the panel updated one store, the
// job's matcher kept reading the other, and the job stopped firing with nothing
// anywhere to say why. Kept only as the migration's landing spot for the first
// load; read-through after that.
const SOURCES_KEY = 'jh_watchers';
const TIMELINE_KEY = 'jh_job_timeline';
const MIGRATED_KEY = 'jh_jobs_migrated';

/** Entries kept in the cross-job timeline. */
const TIMELINE_MAX = 400;

/** How often the time triggers are checked. Same cadence as the old scheduler. */
const CLOCK_MS = 60 * 1000;

export class JobManager {
    constructor({ storage = null, client = null, engine = new TriggerEngine(), invoker = null } = {}) {
        this._storage = storage;
        this._client = client;
        this._invoke = invoker;
        this.engine = engine;
        this.jobs = [];
        this.sources = [];
        this.timeline = [];
        this._clock = null;
    }

    get storage() { return this._storage ?? globalThis.localStorage; }
    get client() { return this._client ?? globalThis.window?.apiClient; }
    get invoke() { return this._invoke ?? invoke; }

    init() {
        this.load();
        // Two clocks, because they answer different questions. The minute hand
        // is for time triggers; the debounce window of an event is seconds, and
        // waiting a minute to notice it closed would collapse a burst and then
        // sit on it.
        this._clock = setInterval(() => this.tickClock(), CLOCK_MS);
        return this;
    }

    destroy() {
        clearInterval(this._clock);
        clearTimeout(this._eventTimer);
        this._clock = null;
        this._eventTimer = null;
    }

    /**
     * Wake once, when the soonest debounce window closes.
     *
     * No polling: the only thing that can make a window close is an event
     * having opened one, so the timer is set at that moment and nothing runs
     * while the app sits idle.
     */
    _scheduleEvents() {
        clearTimeout(this._eventTimer);
        this._eventTimer = null;
        const wait = this.engine.nextWakeIn(Date.now());
        if (!Number.isFinite(wait)) return;
        this._eventTimer = setTimeout(() => {
            this._eventTimer = null;
            this.tickEvents();
        }, Math.max(50, wait));
    }

    // ── storage ──────────────────────────────────────────────────────────
    _read(key, fallback) {
        try {
            const raw = this.storage?.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) { return fallback; }
    }

    load() {
        const stored = this._read(JOBS_KEY, null);
        // Order matters: `_migrateOnce` populates `this.sources`, and reading
        // the (empty) sources key afterwards threw that away — the watchers
        // converted correctly and then vanished.
        if (stored) {
            this.jobs = stored;
        } else {
            this.jobs = this._migrateOnce();
        }
        this.sources = this._read(SOURCES_KEY, []) || [];
        this.timeline = this._read(TIMELINE_KEY, []) || [];
        this.jobs = this.jobs.map(j => ({ ...JOB_DEFAULTS, ...j }));
        this._syncEngine();
        return this.jobs;
    }

    /**
     * Convert the three old stores, once.
     *
     * The old keys are LEFT IN PLACE. A conversion that deletes its input has
     * to be right first time; one that does not can be re-run, compared, and
     * abandoned.
     */
    _migrateOnce() {
        const { jobs, sources } = migrate({
            schedules: this._read('jh_schedules', []),
            triggers: this._read('jh_triggers', []),
            watchers: this._read('jh_watchers', []),
        });
        // The watchers are already in `jh_watchers` — migration only needs to
        // READ them to link jobs, never to write them back.
        this.sources = sources;
        try {
            this.storage?.setItem(MIGRATED_KEY, new Date().toISOString());
        } catch (_) { /* best effort */ }
        return jobs;
    }

    save() {
        try {
            this.storage?.setItem(JOBS_KEY, JSON.stringify(this.jobs));
            // NOT the sources: WatcherManager owns them, and writing them from
            // here is how the two copies came to disagree.
            this.storage?.setItem(TIMELINE_KEY, JSON.stringify(this.timeline.slice(-TIMELINE_MAX)));
        } catch (_) { /* best effort */ }
        globalThis.window?.dispatchEvent?.(new CustomEvent('jh-jobs-updated'));
    }

    /**
     * Start over.
     *
     * Offered because the alternative — hand-editing localStorage — is what
     * people actually do when a registry gets into a state they cannot explain,
     * and doing it blind is how the rest of the settings get damaged.
     */
    reset() {
        this.jobs = [];
        this.sources = [];
        this.timeline = [];
        this._syncEngine();
        this.save();
    }

    // ── the timeline ─────────────────────────────────────────────────────
    /**
     * One line in the cross-job history.
     *
     * Records what did NOT happen as well as what did. "Why didn't it fire?" is
     * the question a person actually asks, and the old engine journal — the
     * only place that answered it — lived in memory and was gone by morning.
     */
    _note(entry) {
        this.timeline.push({ at: Date.now(), ...entry });
        if (this.timeline.length > TIMELINE_MAX) {
            this.timeline.splice(0, this.timeline.length - TIMELINE_MAX);
        }
        return entry;
    }

    // ── engine wiring ────────────────────────────────────────────────────
    /**
     * Publish each job's EVENT triggers to the engine.
     *
     * The engine keys everything on a trigger id, so a job with two event
     * triggers becomes two engine entries sharing the job's guards. The id
     * carries the job id so a decision can be traced back.
     */
    /**
     * The matcher for one trigger.
     *
     * A WATCH trigger derives its own: the source already declares the event
     * name, so making the user type it again was two fields for one fact — and
     * the two could disagree, at which point the job simply never ran. Matching
     * on the watcher's id as well means two sources may share an event name
     * without a job attached to one firing on the other's events.
     */
    _matchFor(trigger) {
        if (trigger.kind === 'event') return trigger.match || {};
        if (trigger.kind !== 'watch') return null;
        const src = (this.sources || []).find(s => s.id === trigger.sourceId);
        if (!src) return null;                     // unresolved source: matches nothing
        return { watcherId: src.id, event: src.eventName };
    }

    _syncEngine() {
        const flat = [];
        for (const job of this.jobs) {
            (job.triggers || []).forEach((t, i) => {
                const match = this._matchFor(t);
                if (!match) return;                // time triggers, and dangling sources
                flat.push({
                    id: `${job.id}#${i}`,
                    name: job.name,
                    enabled: !!job.enabled,
                    match,
                    prompt: job.prompt,
                    debounceMs: job.debounceMs,
                    cooldownMs: job.cooldownMs,
                    dedupeWindowMs: job.dedupeWindowMs,
                    maxPerHour: job.maxPerHour,
                    concurrency: job.concurrency,
                });
            });
        }
        this.engine.setTriggers(flat);
    }

    /**
     * Re-read the watchers and re-derive every matcher.
     *
     * Called when the watcher panel has changed something. Without it the jobs
     * keep matching against the shape a source had when the app started, and a
     * renamed event silently stops reaching the job that wanted it.
     */
    refreshSources() {
        this.sources = this._read(SOURCES_KEY, []) || [];
        this._syncEngine();
        return this.sources;
    }

    /** The job an engine trigger id belongs to. */
    jobOf(triggerId) {
        const jobId = String(triggerId || '').split('#')[0];
        return this.jobs.find(j => j.id === jobId) || null;
    }

    // ── the three ways in ────────────────────────────────────────────────
    /** An event arrived (webhook, MCP notification, or a watcher). */
    onEvent(event) {
        if (!event || !event.event) return [];
        const decisions = this.engine.accept(event, Date.now());
        for (const d of decisions) {
            const job = this.jobOf(d.triggerId);
            if (d.dropped) {
                this._note({ jobId: job?.id, job: job?.name, kind: 'event',
                             event: event.event, outcome: 'dropped', why: d.dropped });
            }
        }
        if (!decisions.length) {
            this._note({ kind: 'event', event: event.event, outcome: 'unmatched' });
        }
        if (decisions.some(d => d.accepted)) this._scheduleEvents();
        this.save();
        return decisions;
    }

    /** Debounce windows that closed. Called by the host's timer. */
    async tickEvents(now = Date.now()) {
        const due = this.engine.due(now);
        const started = [];
        for (const item of due) {
            const job = this.jobOf(item.trigger.id);
            if (!job) continue;
            const run = await this.run(job, {
                kind: 'event', event: item.event, count: item.count, prompt: item.prompt,
            }, new Date(now));
            started.push(run);
        }
        if (due.length) this.save();
        // A burst can leave a second window open behind the one that just
        // closed; re-arm rather than waiting for the next event to do it.
        this._scheduleEvents();
        return started;
    }

    /** The minute hand. Checks every job's TIME triggers. */
    async tickClock(now = new Date()) {
        const started = [];
        for (const job of this.jobs) {
            if (!job.enabled || !job.prompt) continue;
            const due = (job.triggers || []).some(t => t.kind === 'time' && timeTriggerDue(t, now));
            if (!due || ranThisMinute(job, now)) continue;
            started.push(await this.run(job, { kind: 'time', prompt: job.prompt }, now));
            // A one-off has now happened.
            for (const t of job.triggers) {
                if (t.kind === 'time' && (t.scheduleType === 'once')) job.enabled = false;
            }
        }
        if (started.length) this.save();
        return started;
    }

    // ── running ──────────────────────────────────────────────────────────
    /**
     * Start the job's work.
     *
     * @param {object} job
     * @param {{kind: string, event?: object, count?: number, prompt: string}} why
     */
    async run(job, why, now = new Date()) {
        // Stamped with the clock the CALLER is using. Reading Date.now() here
        // instead meant `ranThisMinute` compared a run against a different
        // clock from the one that decided it was due — harmless while both are
        // the wall clock, and silently wrong the moment either is injected.
        const at = new Date(now).toISOString();
        const record = { at, kind: why.kind, event: why.event?.event, count: why.count || 1 };

        // Budget first: refusing costs nothing, and the whole point of the
        // accumulation is that it can eventually say no.
        if (overBudget(job)) {
            record.status = 'skipped';
            record.error = `予算 ${job.budgetTokens} トークンに達しています（累計 ${job.spent?.tokens || 0}）。`;
            this._finishRecord(job, record, 'over-budget');
            return record;
        }

        // A prompt the event could not fill cannot be carried out, and no model
        // call changes that. Refused here rather than spending a run on it.
        const missing = unresolvedPlaceholders(why.prompt);
        if (missing.length) {
            record.status = 'failed';
            record.error = `プロンプトの ${missing.map(m => `{{${m}}}`).join(', ')} を埋められませんでした。`;
            this._finishRecord(job, record, 'unfilled');
            this.engine.noteFinished(`${job.id}#0`);
            return record;
        }

        try {
            const client = this.client;
            if (!client) throw new Error('API client not ready');
            const behavior = {
                mode: 'iterative_agent',
                ...buildBehavior(job.agentModeId || DEFAULT_MODE_ID),
                mcp_servers: job.mcpServers?.length ? job.mcpServers : [],
                // Carried into the run so the task itself can say why it exists,
                // and so its usage can be attributed back on completion.
                mcp_context: {
                    job: { id: job.id, name: job.name, purpose: job.purpose },
                    trigger: { id: job.id, name: job.name, count: why.count || 1 },
                    event: why.event || null,
                },
            };
            const task = await client.request('/tasks', {
                method: 'POST',
                body: JSON.stringify({
                    prompt: why.prompt,
                    workspace_path: job.workspacePath || null,
                    caller: 'Job',
                    behavior,
                }),
            });
            record.taskId = task.task_id || task.id;
            record.status = 'started';
            this.engine.noteFired(`${job.id}#0`, Date.now());
        } catch (e) {
            record.status = 'failed';
            record.error = e?.message || String(e);
            this.engine.noteFinished(`${job.id}#0`);
        }
        this._finishRecord(job, record, record.status);
        return record;
    }

    _finishRecord(job, record, outcome) {
        job.runs = [...(job.runs || []), record].slice(-RUN_HISTORY);
        job.lastRunAt = new Date(record.at).getTime();
        this._note({
            jobId: job.id, job: job.name, kind: record.kind,
            event: record.event, outcome, why: record.error, taskId: record.taskId,
        });
        this.save();
    }

    /**
     * A task started by a job has ended — record what it cost.
     *
     * Spend that was never recorded cannot be recovered, so this runs whether
     * or not a limit is set. `reconcile` exists because the app can be closed
     * between a run starting and finishing.
     */
    /**
     * What a run cost, priced the way the Usage view prices everything else.
     *
     * The server's token report carries NO cost field, so reading `usage.cost`
     * produced 0 for every job and the panel showed `$0.0000` — a dollar figure
     * that is only the absence of a measurement. The rates are configured per
     * connection and the task carries its per-model breakdown; both already
     * exist, and `spendOf` is the function that turns one into the other.
     */
    async _priceTask(task) {
        if (!task) return 0;
        try {
            const cfg = await this.invoke('get_ai_config');
            const rateFor = rateLookup(cfg?.llm_instances || []);
            return spendOf([task], { rateFor, flatRate: 0 })?.total || 0;
        } catch (_) {
            // No rates configured, or the config is unreadable. Zero here means
            // "not priced", which is why the panel says so instead of printing
            // a currency amount.
            return 0;
        }
    }

    noteUsage(jobId, taskId, usage, cost = 0) {
        const job = this.jobs.find(j => j.id === jobId);
        if (!job) return null;
        const run = (job.runs || []).find(r => r.taskId === taskId);
        if (run?.tokens != null) return run;          // already counted
        const tokens = Number(usage?.total_tokens) || 0;
        if (run) { run.tokens = tokens; run.cost = cost; run.status = 'completed'; }
        job.spent = addSpend(job, { tokens, cost });
        this.engine.noteFinished(`${jobId}#0`);
        this.save();
        return run;
    }

    /**
     * Fill in the cost of runs that finished while the app was closed.
     *
     * Without this, closing the app mid-run loses that run's spend for ever and
     * the total quietly under-reports — which is worse than not counting at
     * all, because it looks like a number.
     */
    async reconcile() {
        const client = this.client;
        if (!client?.getTask) return 0;
        let filled = 0;
        for (const job of this.jobs) {
            for (const run of job.runs || []) {
                if (!run.taskId || run.tokens != null) continue;
                try {
                    const task = await client.getTask(run.taskId);
                    if (!task || task.status === 'running') continue;
                    run.tokens = Number(task.token_usage?.total_tokens) || 0;
                    run.cost = await this._priceTask(task);
                    run.status = task.status === 'completed' ? 'completed' : (run.status || task.status);
                    job.spent = addSpend(job, { tokens: run.tokens, cost: run.cost });
                    filled++;
                } catch (_) { /* the task may have been deleted from history */ }
            }
        }
        if (filled) this.save();
        return filled;
    }

    // ── CRUD ─────────────────────────────────────────────────────────────
    upsert(job) {
        const j = { ...JOB_DEFAULTS, id: `job_${Date.now()}`, ...job };
        const i = this.jobs.findIndex(x => x.id === j.id);
        if (i >= 0) this.jobs[i] = { ...this.jobs[i], ...j };
        else this.jobs.push(j);
        this._syncEngine();
        this.save();
        return j;
    }

    remove(id) {
        this.jobs = this.jobs.filter(j => j.id !== id);
        this._syncEngine();
        this.save();
    }

    setEnabled(id, enabled) {
        const j = this.jobs.find(x => x.id === id);
        if (!j) return null;
        j.enabled = !!enabled;
        if (enabled) { delete j.disabledReason; delete j.disabledAt; }
        this._syncEngine();
        this.save();
        return j;
    }

    /** Everything off, at once. */
    pauseAll() {
        for (const j of this.jobs) j.enabled = false;
        this._syncEngine();
        this._note({ kind: 'system', outcome: 'paused-all' });
        this.save();
    }

    /** Rendered prompt for a job, given an event. Used by the test button. */
    preview(job, event) {
        return renderPrompt(job.prompt, event || { payload: {} }, 1);
    }
}

export const jobManager = new JobManager();
