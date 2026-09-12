// JobModel — a unit of WORK, and what starts it.
//
// The registry used to be split three ways — schedules, triggers, watchers —
// which is a split by MECHANISM. Nobody thinks "I have a schedule and a
// trigger"; they think "I want the download report kept up to date". That one
// intention was two records in two tabs, joined only by a hand-typed event
// name, with its history in two places and no way to ask "what ran last night".
//
// A Job is the thing you create, name, budget and audit. What starts it is an
// attribute of it, not a separate object:
//
//     Job ──┬── trigger { kind: 'time'  … }
//           ├── trigger { kind: 'event' … }
//           └── trigger { kind: 'watch' … }
//
// This file is PURE — shape, defaults, migration, and "is this time trigger due
// right now". The engines that already own the hard parts (TriggerEngine's
// dedupe/debounce/cooldown/cap, WatcherEngine's baseline/diff) are not replaced
// by any of this; the Job layer composes them.
//
// See the design report and docs/design/autonomy-triggers.md §11.

// PURE still: `t()` is a synchronous lookup in a static catalog, with no I/O and
// no state of its own. It is here because the one thing this file returns FOR A
// PERSON — the line the list shows under a job's name — was written in Japanese
// in the source, and stayed Japanese in an English UI.
import { t } from '../../../i18n/index.js';

/** A job with nothing filled in. */
export const JOB_DEFAULTS = {
    enabled: false,        // as with triggers: never live the moment it exists
    purpose: '',
    prompt: '',
    workspacePath: '',
    agentModeId: null,
    mcpServers: [],
    // Skills PINNED to this job, by name. Every run still sees the whole
    // catalogue and may load any skill it judges relevant; a pinned one is
    // loaded whether or not the model would have picked it. That difference
    // matters only when nobody is watching — which is exactly when a job runs.
    skills: [],
    triggers: [],
    // Guards live on the JOB, not per trigger: "do not run this more than N
    // times an hour" is a property of the work, not of one way of starting it.
    debounceMs: 2000,
    cooldownMs: 0,
    dedupeWindowMs: 60000,
    maxPerHour: 20,
    concurrency: 'skip',
    // Spend. `budgetTokens: 0` means unlimited — the ACCUMULATION is what
    // matters now, so that turning a limit on later is a form field and not a
    // data migration.
    budgetTokens: 0,
    spent: { tokens: 0, cost: 0, runs: 0 },
    runs: [],
};

/**
 * The prompt a run is actually sent: pinned skills first, then the work.
 *
 * The same shape `/skill` produces in the chat composer
 * (SlashCommands.buildPrompt), so a procedure reads identically whether a
 * person attached it or a job did.
 *
 * Bodies are read at RUN time and passed in here, never stored on the job. A
 * skill is edited in the Skills tab; a copy baked into the job the day it was
 * created would keep running the old procedure for ever, with nothing on
 * either screen to say the two had drifted.
 *
 * @param {string} prompt
 * @param {Array<{name: string, title?: string, body: string}>} loaded
 */
export function withSkills(prompt, loaded = []) {
    const bodies = (loaded || [])
        .filter(s => s && s.body)
        .map(s => `# Skill: ${s.title || s.name} (/${s.name})\n${s.body}`);
    if (!bodies.length) return prompt || '';
    return `${bodies.join('\n\n')}\n\n---\n\n${prompt || ''}`;
}

/** Runs kept per job. Enough to answer "why did this run?", not a log. */
export const RUN_HISTORY = 100;

/** The three ways a job can start. Used for badges and for grouping. */
export const TRIGGER_KINDS = ['time', 'event', 'watch'];

/**
 * Which day of `now`'s month a monthly trigger falls on.
 *
 * CLAMPED to the month's length, so "the 31st" runs on the 28th of February
 * instead of skipping the month — a monthly job that quietly does not run is
 * worse than one that runs a few days early. (Moved from ScheduleManager
 * unchanged; the behaviour is relied on and tested there.)
 */
export function monthDay(dayOfMonth, now) {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (dayOfMonth === 'last') return lastDay;
    const n = parseInt(dayOfMonth, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, lastDay);
}

/**
 * Is this TIME trigger due at `now`?
 *
 * Extracted from ScheduleManager so a job can hold one of these beside an event
 * trigger without the two living in different subsystems.
 */
export function timeTriggerDue(trigger, now) {
    const tr = trigger || {};
    const type = tr.scheduleType || 'fixed';
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (type === 'once') {
        if (!tr.onceAt) return false;
        const target = new Date(tr.onceAt);
        return target.getFullYear() === now.getFullYear()
            && target.getMonth() === now.getMonth()
            && target.getDate() === now.getDate()
            && target.getHours() === now.getHours()
            && target.getMinutes() === now.getMinutes();
    }

    if (type === 'monthly') {
        // A day of the MONTH, so the weekday list does not apply — combining
        // them would produce a schedule that skips most months.
        return now.getDate() === monthDay(tr.dayOfMonth ?? 1, now) && tr.time === hhmm;
    }

    const days = tr.days || [1, 2, 3, 4, 5];
    if (!days.includes(now.getDay())) return false;

    if (type === 'interval') {
        const intervalMin = Math.max(1, parseInt(tr.intervalMinutes, 10) || 60);
        return now.getMinutes() % intervalMin === 0;
    }
    return tr.time === hhmm;      // fixed
}

/** Did this job already run inside the same minute as `now`? */
export function ranThisMinute(job, now) {
    const last = (job.runs || []).slice(-1)[0];
    if (!last) return false;
    const at = new Date(last.at);
    return at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth()
        && at.getDate() === now.getDate()
        && at.getHours() === now.getHours()
        && at.getMinutes() === now.getMinutes();
}

/**
 * "Not set", in the app's language.
 *
 * A getter rather than a constant: the catalog is read when the summary is
 * built, so switching language re-labels the list instead of keeping whatever
 * was current when this module was first imported.
 */
export const unsetLabel = () => t('jobs.sum.unset');

/**
 * A short, readable line for what starts a job.
 *
 * Never empty. This is the only thing the list shows about a trigger, and a
 * half-configured one returning '' produced a blank row — indistinguishable
 * from a rendering bug, and giving no hint that the fix is to finish filling it
 * in.
 */
export function triggerSummary(trigger) {
    const tr = trigger || {};
    const unset = unsetLabel();
    if (tr.kind === 'time') {
        const type = tr.scheduleType || 'fixed';
        if (type === 'interval') return t('jobs.sum.interval', { n: tr.intervalMinutes || 60 });
        if (type === 'monthly') {
            return t('jobs.sum.monthly', { day: tr.dayOfMonth ?? 1, time: tr.time || unset });
        }
        if (type === 'once') {
            return tr.onceAt ? t('jobs.sum.once', { at: tr.onceAt }) : t('jobs.sum.onceUnset');
        }
        return tr.time || unset;
    }
    if (tr.kind === 'event') {
        const m = tr.match || {};
        return m.event || (m.eventPrefix ? `${m.eventPrefix}*` : t('jobs.sum.anyEvent'));
    }
    if (tr.kind === 'watch') {
        return tr.sourceName || tr.sourceId || tr.source?.type || unset;
    }
    return tr.kind || unset;
}

/**
 * Is the job over its token budget?
 *
 * `budgetTokens: 0` is unlimited, so the check is inert until someone sets a
 * number. That is deliberate: the ACCUMULATION has to start now, because spend
 * that was never recorded cannot be recovered later, while a limit can be added
 * to a form in an afternoon.
 */
export function overBudget(job) {
    const limit = Number(job?.budgetTokens) || 0;
    if (limit <= 0) return false;
    return (job?.spent?.tokens || 0) >= limit;
}

/** Fold one run's usage into the job's running total. */
export function addSpend(job, { tokens = 0, cost = 0 } = {}) {
    const spent = job.spent || { tokens: 0, cost: 0, runs: 0 };
    return {
        tokens: spent.tokens + (Number(tokens) || 0),
        cost: +(spent.cost + (Number(cost) || 0)).toFixed(6),
        runs: spent.runs + 1,
    };
}

/**
 * Event names that more than one source emits.
 *
 * A job attached to a SOURCE is safe either way (it matches on the watcher's
 * id), but a job matching an external event by NAME cannot tell them apart —
 * and neither can a person reading the list. Reported rather than forbidden:
 * two sources feeding one name is a legitimate thing to want, and the cost of
 * being wrong about it is a job that fires on the wrong input, silently.
 */
export function duplicateEventNames(sources) {
    const seen = new Map();
    for (const s of sources || []) {
        const name = String(s?.eventName || '').trim();
        if (!name) continue;
        seen.set(name, (seen.get(name) || 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

// ── Migration ────────────────────────────────────────────────────────────
//
// The three old stores become jobs. Nothing is deleted: the old keys stay where
// they are, so a bad conversion costs nothing and the previous build still
// reads its own data.

/** One schedule → one job with a single time trigger. */
export function jobFromSchedule(s) {
    return {
        ...JOB_DEFAULTS,
        id: `job_${s.id || Date.now()}`,
        name: s.name || (s.prompt || '').slice(0, 40) || t('jobs.untitled2'),
        purpose: '',
        enabled: !!s.enabled,
        prompt: s.prompt || '',
        workspacePath: '',
        agentModeId: s.agentModeId || null,
        mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers : [],
        triggers: [{
            kind: 'time',
            scheduleType: s.scheduleType || 'fixed',
            time: s.time, days: s.days, dayOfMonth: s.dayOfMonth,
            intervalMinutes: s.intervalMinutes, onceAt: s.onceAt,
        }],
        runs: Array.isArray(s.runs) ? s.runs.slice(-RUN_HISTORY) : [],
        migratedFrom: 'schedule',
    };
}

/** One trigger → one job with a single event trigger. */
export function jobFromTrigger(tr) {
    return {
        ...JOB_DEFAULTS,
        id: `job_${tr.id || Date.now()}`,
        name: tr.name || tr.id || t('jobs.untitled2'),
        enabled: !!tr.enabled,
        prompt: tr.prompt || '',
        workspacePath: tr.workspacePath || '',
        agentModeId: tr.agentModeId || null,
        mcpServers: Array.isArray(tr.mcpServers) ? tr.mcpServers : [],
        triggers: [{ kind: 'event', match: { ...(tr.match || {}) } }],
        debounceMs: tr.debounceMs ?? JOB_DEFAULTS.debounceMs,
        cooldownMs: tr.cooldownMs ?? JOB_DEFAULTS.cooldownMs,
        dedupeWindowMs: tr.dedupeWindowMs ?? JOB_DEFAULTS.dedupeWindowMs,
        maxPerHour: tr.maxPerHour ?? JOB_DEFAULTS.maxPerHour,
        concurrency: tr.concurrency || JOB_DEFAULTS.concurrency,
        disabledReason: tr.disabledReason,
        runs: Array.isArray(tr.runs) ? tr.runs.slice(-RUN_HISTORY) : [],
        migratedFrom: 'trigger',
    };
}

/**
 * Watchers become SHARED SOURCES, not jobs.
 *
 * A watcher is not work — it produces events. Turning each into a job would
 * create a job that does nothing, and the event trigger that consumes it would
 * still be somewhere else. Kept as sources, which is also the shape the "one
 * mail watcher, two jobs" case needs.
 */
export function sourceFromWatcher(w) {
    return { ...w, id: w.id, sharedFrom: 'watcher' };
}

/**
 * Attach a migrated watcher to the job that consumes it.
 *
 * The link that never existed: the two were joined by an event-name string, and
 * this is the one moment it can be resolved automatically — after which the job
 * carries the reference and the name is no longer load-bearing.
 */
export function linkWatchers(jobs, sources) {
    for (const job of jobs) {
        job.triggers = job.triggers.map((tr) => {
            if (tr.kind !== 'event') return tr;
            const name = tr.match?.event;
            if (!name) return tr;
            const src = sources.find(s => s.eventName === name);
            // REPLACED, not paired. Adding a watch trigger beside the event
            // trigger produced the thing this fixes: two rows to fill in for
            // one intention, the second of which only repeats the name the
            // first already knows.
            return src ? { kind: 'watch', sourceId: src.id } : tr;
        });
    }
    return jobs;
}

/**
 * Build the job list from the three old stores.
 *
 * @param {{schedules?: any[], triggers?: any[], watchers?: any[]}} old
 * @returns {{jobs: object[], sources: object[]}}
 */
export function migrate(old = {}) {
    const jobs = [
        ...(Array.isArray(old.schedules) ? old.schedules : []).map(jobFromSchedule),
        ...(Array.isArray(old.triggers) ? old.triggers : []).map(jobFromTrigger),
    ];
    const sources = (Array.isArray(old.watchers) ? old.watchers : []).map(sourceFromWatcher);
    return { jobs: linkWatchers(jobs, sources), sources };
}
