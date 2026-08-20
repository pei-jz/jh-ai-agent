// scheduleModel — the "when does this next run?" maths, out of the view.
//
// These were inline functions in an 836-line class that also owned the markup
// and the DOM listeners, so asking "what does a day-31 monthly say on 1 Feb?"
// meant rendering the view and reading a string back out of it. `now` is
// injectable here, which is the whole point.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../modules/ai/ScheduleManager.js', () => ({
    scheduleManager: { reloadSchedules: vi.fn() },
    // The real clamp: a day past the end of a short month lands on its last day.
    monthDay: (dom, probe) => {
        const last = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
        if (dom === 'last') return last;
        return Math.min(parseInt(dom, 10) || 1, last);
    },
}));

const {
    nextRunText, untilText, scheduleTypeBadge, toDatetimeLocal, usesWeekdays,
    validateForSave, newSchedule, domLabel, DOM_OPTIONS, DAY_LABELS,
    loadSchedules, saveSchedules,
} = await import('../scheduleModel.js');

const base = (over = {}) => ({ enabled: true, scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5], ...over });

describe('nextRunText', () => {
    it('says Stopped when disabled, whatever the type', () => {
        for (const t of ['fixed', 'interval', 'once', 'monthly']) {
            expect(nextRunText(base({ enabled: false, scheduleType: t }))).toBe('Stopped');
        }
    });

    it('fixed: finds the next matching weekday', () => {
        // Wed 2026-08-12 08:00 → today 09:00 (Wednesday is in the list).
        const now = new Date(2026, 7, 12, 8, 0);
        expect(nextRunText(base(), now)).toBe('in 1h 0m');
    });

    it('fixed: skips the weekend when only weekdays are selected', () => {
        // Sat 2026-08-15 10:00 → Monday 09:00 is 47h, which untilText reports in
        // whole days. Sunday must NOT be offered.
        const now = new Date(2026, 7, 15, 10, 0);
        expect(nextRunText(base(), now)).toBe('in 1d');
    });

    it('fixed: DOES use the weekend when those days are selected', () => {
        // Same instant, Sunday enabled → 23h away, so still in hours.
        const now = new Date(2026, 7, 15, 10, 0);
        expect(nextRunText(base({ days: [0, 6] }), now)).toBe('in 23h 0m');
    });

    it('once: reports expiry rather than a negative countdown', () => {
        const now = new Date(2026, 7, 12, 12, 0);
        const past = new Date(2026, 7, 11, 9, 0).toISOString();
        expect(nextRunText(base({ scheduleType: 'once', onceAt: past }), now)).toBe('Ran / expired');
    });

    it('once: counts down to a future time', () => {
        const now = new Date(2026, 7, 12, 12, 0);
        const soon = new Date(2026, 7, 12, 14, 30).toISOString();
        expect(nextRunText(base({ scheduleType: 'once', onceAt: soon }), now)).toBe('in 2h 30m');
    });

    it('once: an unset time is not a countdown', () => {
        expect(nextRunText(base({ scheduleType: 'once', onceAt: null }))).toBe('—');
    });

    it('interval: reports the wait to the next boundary', () => {
        const now = new Date(2026, 7, 12, 10, 10);
        expect(nextRunText(base({ scheduleType: 'interval', intervalMinutes: 30 }), now)).toBe('~20m');
    });

    // The case the extraction was worth doing for.
    it('monthly: day 31 still runs in February, on the 28th', () => {
        const now = new Date(2026, 1, 1, 0, 0);       // 1 Feb 2026
        const out = nextRunText(base({ scheduleType: 'monthly', dayOfMonth: '31' }), now);
        expect(out).toMatch(/^in \d+d$/);
        // 1 Feb → 28 Feb is 27 days.
        expect(out).toBe('in 27d');
    });

    it('monthly: "last" resolves to the real last day', () => {
        const now = new Date(2026, 1, 1, 0, 0);
        expect(nextRunText(base({ scheduleType: 'monthly', dayOfMonth: 'last' }), now)).toBe('in 27d');
    });

    it('monthly: rolls to next month when this month\'s day has passed', () => {
        const now = new Date(2026, 7, 20, 12, 0);     // 20 Aug
        const out = nextRunText(base({ scheduleType: 'monthly', dayOfMonth: '5' }), now);
        expect(out).toMatch(/^in \d+d$/);
    });
});

describe('untilText', () => {
    it('uses hours and minutes under a day', () => {
        expect(untilText(2 * 3600000 + 15 * 60000)).toBe('in 2h 15m');
    });
    it('switches to whole days past 24h', () => {
        expect(untilText(50 * 3600000)).toBe('in 2d');
    });
});

describe('scheduleTypeBadge', () => {
    it('fixed shows the time', () => {
        expect(scheduleTypeBadge(base({ time: '07:30' }))).toBe('07:30');
    });
    it('interval shows minutes under an hour, hours above', () => {
        expect(scheduleTypeBadge(base({ scheduleType: 'interval', intervalMinutes: 30 }))).toBe('every 30m');
        expect(scheduleTypeBadge(base({ scheduleType: 'interval', intervalMinutes: 120 }))).toBe('every 2h');
    });
    it('monthly shows the day and time', () => {
        expect(scheduleTypeBadge(base({ scheduleType: 'monthly', dayOfMonth: 'last', time: '06:00' })))
            .toBe('Last day 06:00');
    });
    it('once is just Once', () => {
        expect(scheduleTypeBadge(base({ scheduleType: 'once' }))).toBe('Once');
    });
});

describe('toDatetimeLocal', () => {
    it('formats in LOCAL time, not UTC', () => {
        // toISOString().slice(0,16) would shift this by the timezone offset, so a
        // 09:00 schedule reopened as something else.
        const d = new Date(2026, 7, 12, 9, 5);
        expect(toDatetimeLocal(d.toISOString())).toBe('2026-08-12T09:05');
    });
    it('is empty for null/invalid', () => {
        expect(toDatetimeLocal(null)).toBe('');
        expect(toDatetimeLocal('')).toBe('');
        expect(toDatetimeLocal('not a date')).toBe('');
    });
});

describe('usesWeekdays', () => {
    it('is true only where a weekday means something', () => {
        expect(usesWeekdays('fixed')).toBe(true);
        expect(usesWeekdays('interval')).toBe(true);
        expect(usesWeekdays('once')).toBe(false);
        expect(usesWeekdays('monthly')).toBe(false);
    });
});

describe('validateForSave', () => {
    it('refuses a schedule with no instruction — it would have nothing to run', () => {
        expect(validateForSave({ prompt: '' }).ok).toBe(false);
        expect(validateForSave({ prompt: '   ' }).ok).toBe(false);
        expect(validateForSave(null).ok).toBe(false);
    });
    it('accepts one with a prompt', () => {
        expect(validateForSave({ prompt: 'run the tests' }).ok).toBe(true);
    });
});

describe('newSchedule', () => {
    it('starts enabled, on weekdays, with the given mode', () => {
        const s = newSchedule('general');
        expect(s.enabled).toBe(true);
        expect(s.days).toEqual([1, 2, 3, 4, 5]);
        expect(s.agentModeId).toBe('general');
        expect(s.prompt).toBe('');
        expect(s.runs).toEqual([]);
    });
    it('gives every schedule a distinct id', () => {
        expect(newSchedule('x').id).not.toBe(newSchedule('x').id);
    });
});

describe('option lists', () => {
    it('offers 31 days plus "last"', () => {
        expect(DOM_OPTIONS).toHaveLength(32);
        expect(DOM_OPTIONS.at(-1)).toBe('last');
        expect(domLabel('last')).toBe('Last day');
        expect(domLabel('7')).toBe('Day 7');
    });
    it('labels the week starting Sunday, matching Date.getDay()', () => {
        expect(DAY_LABELS[0]).toBe('Sun');
        expect(DAY_LABELS[6]).toBe('Sat');
    });
});

describe('storage', () => {
    beforeEach(() => {
        const store = new Map();
        globalThis.localStorage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        };
    });

    it('round-trips', () => {
        saveSchedules([{ id: 'a', prompt: 'x' }]);
        expect(loadSchedules()).toEqual([{ id: 'a', prompt: 'x' }]);
    });

    it('reads corrupt storage as empty rather than throwing', () => {
        localStorage.setItem('jh_schedules', '{not json');
        expect(loadSchedules()).toEqual([]);
    });

    it('is empty when nothing was ever saved', () => {
        expect(loadSchedules()).toEqual([]);
    });
});
