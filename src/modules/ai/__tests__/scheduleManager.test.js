// Schedule firing rules. These decide whether an unattended agent run happens,
// so the edges (a 31st in February, a monthly schedule meeting a weekday filter)
// are the whole point of the file.

import { describe, it, expect, beforeEach } from 'vitest';
import { scheduleManager, monthDay } from '../ScheduleManager.js';

/** A Date at a wall-clock moment, in local time — the clock a schedule reads. */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('monthDay', () => {
    it('is the day you asked for when the month is long enough', () => {
        expect(monthDay(15, at(2026, 8, 1, 0, 0))).toBe(15);
        expect(monthDay('15', at(2026, 8, 1, 0, 0))).toBe(15);
    });

    it('CLAMPS to the end of a short month rather than skipping it', () => {
        // "Run on the 31st" must still run in February. Silently missing a month
        // is worse than running a few days early.
        expect(monthDay(31, at(2026, 2, 1, 0, 0))).toBe(28);
        expect(monthDay(31, at(2024, 2, 1, 0, 0))).toBe(29);   // leap year
        expect(monthDay(31, at(2026, 4, 1, 0, 0))).toBe(30);
    });

    it('resolves "last" per month', () => {
        expect(monthDay('last', at(2026, 2, 1, 0, 0))).toBe(28);
        expect(monthDay('last', at(2026, 8, 1, 0, 0))).toBe(31);
    });

    it('falls back to the 1st for nonsense rather than never firing', () => {
        expect(monthDay(0, at(2026, 8, 1, 0, 0))).toBe(1);
        expect(monthDay('x', at(2026, 8, 1, 0, 0))).toBe(1);
        expect(monthDay(undefined, at(2026, 8, 1, 0, 0))).toBe(1);
    });
});

describe('_shouldFire — monthly', () => {
    const monthly = (over = {}) => ({
        enabled: true, prompt: 'do the report', scheduleType: 'monthly',
        time: '09:00', dayOfMonth: 15, ...over,
    });

    it('fires on its day at its time', () => {
        expect(scheduleManager._shouldFire(monthly(), at(2026, 8, 15, 9, 0))).toBe(true);
    });

    it('does not fire on another day, or another minute', () => {
        expect(scheduleManager._shouldFire(monthly(), at(2026, 8, 14, 9, 0))).toBe(false);
        expect(scheduleManager._shouldFire(monthly(), at(2026, 8, 15, 9, 1))).toBe(false);
    });

    it('IGNORES the weekday list — a day of the month is not a day of the week', () => {
        // Combining them would produce a schedule that skips most months.
        const s = monthly({ days: [] });
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 0))).toBe(true);
    });

    it('runs on the last day of a short month when asked for the 31st', () => {
        const s = monthly({ dayOfMonth: 31 });
        expect(scheduleManager._shouldFire(s, at(2026, 2, 28, 9, 0))).toBe(true);
        expect(scheduleManager._shouldFire(s, at(2026, 3, 31, 9, 0))).toBe(true);
    });

    it('understands "last"', () => {
        const s = monthly({ dayOfMonth: 'last' });
        expect(scheduleManager._shouldFire(s, at(2026, 4, 30, 9, 0))).toBe(true);
        expect(scheduleManager._shouldFire(s, at(2026, 4, 29, 9, 0))).toBe(false);
    });

    it('never fires while stopped, or with nothing to run', () => {
        expect(scheduleManager._shouldFire(monthly({ enabled: false }), at(2026, 8, 15, 9, 0))).toBe(false);
        expect(scheduleManager._shouldFire(monthly({ prompt: '' }), at(2026, 8, 15, 9, 0))).toBe(false);
    });
});

describe('_shouldFire — the existing types still behave', () => {
    it('fixed fires at its time on a listed weekday only', () => {
        const s = { enabled: true, prompt: 'p', scheduleType: 'fixed', time: '09:00', days: [6] };
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 0))).toBe(true);    // a Saturday
        expect(scheduleManager._shouldFire(s, at(2026, 8, 14, 9, 0))).toBe(false);   // Friday
    });

    it('interval fires on the minute boundary', () => {
        const s = { enabled: true, prompt: 'p', scheduleType: 'interval', intervalMinutes: 30, days: [0, 1, 2, 3, 4, 5, 6] };
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 30))).toBe(true);
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 31))).toBe(false);
    });

    it('once fires only in its own minute', () => {
        const s = { enabled: true, prompt: 'p', scheduleType: 'once', onceAt: at(2026, 8, 15, 9, 0).toISOString() };
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 0))).toBe(true);
        expect(scheduleManager._shouldFire(s, at(2026, 8, 15, 9, 1))).toBe(false);
    });
});
