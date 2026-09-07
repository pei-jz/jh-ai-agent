// JobModel — the shape a job takes, and the conversion from the three stores
// it replaces.
//
// The point of the change is that one intention becomes one record. These tests
// mostly check that the conversion does not lose anything and does not silently
// invent a second one.
import { describe, it, expect } from 'vitest';
import {
    JOB_DEFAULTS, TRIGGER_KINDS, monthDay, timeTriggerDue, ranThisMinute,
    triggerSummary, overBudget, addSpend,
    jobFromSchedule, jobFromTrigger, sourceFromWatcher, migrate, duplicateEventNames,
} from '../jobs/JobModel.js';

const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);

describe('a job is not live the moment it exists', () => {
    it('defaults to disabled, like the triggers it replaces', () => {
        expect(JOB_DEFAULTS.enabled).toBe(false);
    });

    it('starts with no spend recorded and no limit', () => {
        expect(JOB_DEFAULTS.spent).toEqual({ tokens: 0, cost: 0, runs: 0 });
        expect(JOB_DEFAULTS.budgetTokens).toBe(0);
    });
});

describe('time triggers', () => {
    // 2026-09-07 is a Monday.
    const monday0900 = at(2026, 9, 7, 9, 0);

    it('fires at the fixed time on a selected weekday', () => {
        const t = { kind: 'time', scheduleType: 'fixed', time: '09:00', days: [1] };
        expect(timeTriggerDue(t, monday0900)).toBe(true);
        expect(timeTriggerDue(t, at(2026, 9, 7, 9, 1))).toBe(false);
        expect(timeTriggerDue({ ...t, days: [2] }, monday0900)).toBe(false);
    });

    it('fires on the interval', () => {
        const t = { kind: 'time', scheduleType: 'interval', intervalMinutes: 30, days: [1] };
        expect(timeTriggerDue(t, at(2026, 9, 7, 9, 30))).toBe(true);
        expect(timeTriggerDue(t, at(2026, 9, 7, 9, 31))).toBe(false);
    });

    // A monthly job that quietly skips February is worse than one that runs a
    // few days early.
    it('clamps a monthly day to the length of the month', () => {
        expect(monthDay(31, at(2026, 2, 1, 0, 0))).toBe(28);
        expect(monthDay('last', at(2026, 2, 1, 0, 0))).toBe(28);
        const t = { kind: 'time', scheduleType: 'monthly', dayOfMonth: 31, time: '09:00' };
        expect(timeTriggerDue(t, at(2026, 2, 28, 9, 0))).toBe(true);
    });

    it('fires a one-off within its minute, and never again', () => {
        const t = { kind: 'time', scheduleType: 'once', onceAt: monday0900.toISOString() };
        expect(timeTriggerDue(t, monday0900)).toBe(true);
        expect(timeTriggerDue(t, at(2026, 9, 7, 9, 1))).toBe(false);
        expect(timeTriggerDue({ kind: 'time', scheduleType: 'once' }, monday0900)).toBe(false);
    });

    it('will not run twice inside the same minute', () => {
        const job = { runs: [{ at: monday0900.toISOString() }] };
        expect(ranThisMinute(job, monday0900)).toBe(true);
        expect(ranThisMinute(job, at(2026, 9, 7, 9, 1))).toBe(false);
        expect(ranThisMinute({ runs: [] }, monday0900)).toBe(false);
    });
});

describe('spend', () => {
    // The accumulation is the part that must exist NOW: spend that was never
    // recorded cannot be recovered, while a limit is a form field.
    it('accumulates tokens, cost and a run count', () => {
        let job = { spent: { tokens: 0, cost: 0, runs: 0 } };
        job = { ...job, spent: addSpend(job, { tokens: 1200, cost: 0.031 }) };
        job = { ...job, spent: addSpend(job, { tokens: 800, cost: 0.019 }) };
        expect(job.spent).toEqual({ tokens: 2000, cost: 0.05, runs: 2 });
    });

    it('treats a missing usage report as zero rather than NaN', () => {
        const spent = addSpend({ spent: { tokens: 5, cost: 1, runs: 1 } }, {});
        expect(spent).toEqual({ tokens: 5, cost: 1, runs: 2 });
    });

    it('is unlimited until a number is set', () => {
        expect(overBudget({ budgetTokens: 0, spent: { tokens: 999999 } })).toBe(false);
        expect(overBudget({ budgetTokens: 1000, spent: { tokens: 999 } })).toBe(false);
        expect(overBudget({ budgetTokens: 1000, spent: { tokens: 1000 } })).toBe(true);
    });
});

describe('migration from the three old stores', () => {
    const SCHEDULE = {
        id: 's1', name: '週次まとめ', enabled: true, prompt: 'まとめて',
        scheduleType: 'fixed', time: '09:00', days: [1], agentModeId: 'general',
        runs: [{ at: '2026-09-01T00:00:00.000Z', status: 'completed', taskId: 'x' }],
    };
    const TRIGGER = {
        id: 't1', name: 'DL記録', enabled: true, prompt: '{{payload.value}} を記録',
        match: { source: 'watcher', event: 'release.downloaded' },
        workspacePath: 'C:/w', maxPerHour: 5,
        runs: [{ at: '2026-09-02T00:00:00.000Z', status: 'started' }],
    };
    const WATCHER = {
        id: 'w1', name: 'github', type: 'http', enabled: true,
        url: 'https://api.github.com/x', eventName: 'release.downloaded',
    };

    it('turns a schedule into one job with one time trigger', () => {
        const j = jobFromSchedule(SCHEDULE);
        expect(j.triggers).toHaveLength(1);
        expect(j.triggers[0].kind).toBe('time');
        expect(j.triggers[0].time).toBe('09:00');
        expect(j.prompt).toBe('まとめて');
        expect(j.enabled).toBe(true);
        expect(j.runs, 'history is carried over').toHaveLength(1);
    });

    it('turns a trigger into one job, keeping its guards', () => {
        const j = jobFromTrigger(TRIGGER);
        expect(j.triggers[0].kind).toBe('event');
        expect(j.triggers[0].match.event).toBe('release.downloaded');
        expect(j.maxPerHour, 'a tuned guard is not reset to the default').toBe(5);
        expect(j.workspacePath).toBe('C:/w');
    });

    // A watcher is not work — it produces events. Making it a job would create
    // a job that does nothing.
    it('keeps a watcher as a shared source, not a job', () => {
        const { jobs, sources } = migrate({ watchers: [WATCHER] });
        expect(jobs).toEqual([]);
        expect(sources).toHaveLength(1);
        expect(sources[0].id).toBe('w1');
        expect(sourceFromWatcher(WATCHER).sharedFrom).toBe('watcher');
    });

    // The link that never existed: watcher and trigger were joined only by a
    // hand-typed event name. Migration is the one moment it can be resolved.
    //
    // REPLACED, not paired: a watch trigger already knows the event name from
    // its source, so keeping the event trigger beside it left two fields for
    // one fact — which is exactly the redundancy this fixes.
    it('turns the event trigger INTO a watch trigger on the source', () => {
        const { jobs, sources } = migrate({ triggers: [TRIGGER], watchers: [WATCHER] });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].triggers.map(t => t.kind)).toEqual(['watch']);
        expect(jobs[0].triggers[0].sourceId).toBe(sources[0].id);
    });

    it('leaves a job alone when no watcher produces its event', () => {
        const { jobs } = migrate({ triggers: [TRIGGER], watchers: [] });
        expect(jobs[0].triggers.map(t => t.kind)).toEqual(['event']);
    });

    it('converts all three stores together', () => {
        const { jobs, sources } = migrate({
            schedules: [SCHEDULE], triggers: [TRIGGER], watchers: [WATCHER],
        });
        expect(jobs).toHaveLength(2);
        expect(sources).toHaveLength(1);
    });

    it('survives empty and missing input', () => {
        expect(migrate({})).toEqual({ jobs: [], sources: [] });
        expect(migrate()).toEqual({ jobs: [], sources: [] });
    });
});

describe('what starts a job reads as one line', () => {
    it.each([
        [{ kind: 'time', scheduleType: 'fixed', time: '09:00' }, '09:00'],
        [{ kind: 'time', scheduleType: 'interval', intervalMinutes: 30 }, '30分ごと'],
        [{ kind: 'event', match: { event: 'mail.received' } }, 'mail.received'],
        [{ kind: 'event', match: { eventPrefix: 'github.' } }, 'github.*'],
        [{ kind: 'watch', sourceId: 'w1' }, 'w1'],
        [{ kind: 'watch', sourceId: 'w1', sourceName: 'github' }, 'github'],
    ])('%o', (trigger, expected) => {
        expect(triggerSummary(trigger)).toBe(expected);
    });

    it('covers every kind a job can hold', () => {
        for (const kind of TRIGGER_KINDS) {
            expect(triggerSummary({ kind }), kind).toBeTruthy();
        }
    });
});

describe('two sources emitting the same event name', () => {
    // A job attached to a SOURCE is safe (it matches the watcher id), but a job
    // matching by NAME cannot tell them apart — and neither can a person
    // reading the list.
    it('is reported, not forbidden', () => {
        expect(duplicateEventNames([
            { id: 'a', eventName: 'mail.received' },
            { id: 'b', eventName: 'mail.received' },
            { id: 'c', eventName: 'file.changed' },
        ])).toEqual(['mail.received']);
    });

    it('says nothing when every name is distinct', () => {
        expect(duplicateEventNames([
            { id: 'a', eventName: 'x' }, { id: 'b', eventName: 'y' },
        ])).toEqual([]);
        expect(duplicateEventNames([])).toEqual([]);
        expect(duplicateEventNames()).toEqual([]);
    });

    it('ignores sources that emit nothing yet', () => {
        expect(duplicateEventNames([{ id: 'a' }, { id: 'b', eventName: '  ' }])).toEqual([]);
    });
});
