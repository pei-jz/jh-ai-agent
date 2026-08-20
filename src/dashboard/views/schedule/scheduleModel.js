// scheduleModel — PURE schedule data + the "when does this next run?" maths.
//
// Extracted from ScheduleView.js during the Svelte migration. These were inline
// functions in a 836-line view that also owned the markup and the DOM listeners,
// so the only way to check that a monthly schedule set to day 31 does something
// sensible in February was to render the view and read a string out of it.
//
// Storage lives here too (localStorage + the manager reload) because it is the
// same concern: what a schedule IS, rather than how it looks.

import { scheduleManager, monthDay } from '../../../modules/ai/ScheduleManager.js';

const SCHEDULE_KEY = 'jh_schedules';

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const INTERVAL_OPTIONS = [
    { value: 15,  label: 'Every 15 min' },
    { value: 30,  label: 'Every 30 min' },
    { value: 60,  label: 'Every 1 hour' },
    { value: 120, label: 'Every 2 hours' },
    { value: 360, label: 'Every 6 hours' },
    { value: 720, label: 'Every 12 hours' },
];

/** Day-of-month choices: every day plus "last", which no fixed number can mean. */
export const DOM_OPTIONS = [...Array.from({ length: 31 }, (_, i) => String(i + 1)), 'last'];

export const domLabel = (v) => (v === 'last' ? 'Last day' : `Day ${v}`);

export const SCHEDULE_TYPES = [
    { id: 'fixed',    label: 'Fixed time' },
    { id: 'interval', label: 'Interval' },
    { id: 'monthly',  label: 'Monthly' },
    { id: 'once',     label: 'Once' },
];

export function loadSchedules() {
    try { return JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '[]'); } catch { return []; }
}

export function saveSchedules(list) {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(list));
    scheduleManager.reloadSchedules();
}

export function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * A brand-new schedule.
 *
 * A DRAFT: "+ New" used to write straight to storage and hand it to the manager,
 * so an unnamed, promptless entry appeared as a registered recurring task before
 * the user had typed anything. Saving is what registers it.
 */
export function newSchedule(defaultModeId) {
    return {
        id: makeId(),
        name: '',
        prompt: '',
        agentModeId: defaultModeId,
        mcpServers: [],
        scheduleType: 'fixed',
        time: '09:00',
        days: [1, 2, 3, 4, 5],
        intervalMinutes: 60,
        onceAt: null,
        dayOfMonth: 1,
        enabled: true,
        runs: [],
    };
}

/** "in 2h 15m" / "in 12d" — one wording for every schedule type. */
export function untilText(diffMs) {
    const diffH = Math.floor(diffMs / 3600000);
    const diffM = Math.floor((diffMs % 3600000) / 60000);
    if (diffH < 24) return `in ${diffH}h ${diffM}m`;
    return `in ${Math.floor(diffH / 24)}d`;
}

/**
 * When does this schedule next fire, in words?
 *
 * @param {object} schedule
 * @param {Date} [now] injectable — the whole point of extracting this is being
 *   able to ask "what does a day-31 monthly say on 1 February?" without waiting.
 */
export function nextRunText(schedule, now = new Date()) {
    if (!schedule.enabled) return 'Stopped';
    const type = schedule.scheduleType || 'fixed';

    if (type === 'once') {
        if (!schedule.onceAt) return '—';
        const t = new Date(schedule.onceAt);
        if (t <= now) return 'Ran / expired';
        return untilText(t - now);
    }

    if (type === 'interval') {
        const intervalMin = Math.max(1, parseInt(schedule.intervalMinutes) || 60);
        const curMin = now.getMinutes();
        const nextMin = (Math.floor(curMin / intervalMin) + 1) * intervalMin;
        const waitMin = nextMin - curMin;
        if (waitMin <= intervalMin) return `~${waitMin}m`;
        return `~${Math.round(waitMin / 60)}h`;
    }

    const [h, m] = (schedule.time || '09:00').split(':').map(Number);

    if (type === 'monthly') {
        // Look at this month and the next few: the clamped day can land in the
        // past this month, and February can move it.
        for (let i = 0; i < 4; i++) {
            const probe = new Date(now.getFullYear(), now.getMonth() + i, 1);
            const d = new Date(probe.getFullYear(), probe.getMonth(),
                monthDay(schedule.dayOfMonth ?? 1, probe), h, m, 0, 0);
            if (d > now) return untilText(d - now);
        }
        return '—';
    }

    // fixed
    const days = schedule.days || [1, 2, 3, 4, 5];
    for (let i = 0; i < 8; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        d.setHours(h, m, 0, 0);
        if (d > now && days.includes(d.getDay())) return untilText(d - now);
    }
    return '—';
}

/** The short "when" badge shown on a list row. */
export function scheduleTypeBadge(s) {
    const type = s.scheduleType || 'fixed';
    if (type === 'interval') {
        const min = s.intervalMinutes || 60;
        return min < 60 ? `every ${min}m` : `every ${min / 60}h`;
    }
    if (type === 'once') return 'Once';
    if (type === 'monthly') return `${domLabel(s.dayOfMonth ?? 1)} ${s.time || '09:00'}`;
    return s.time || '09:00';
}

/**
 * A Date → the `YYYY-MM-DDTHH:MM` a `datetime-local` input wants.
 *
 * NOT `toISOString().slice(0,16)`: that converts to UTC, so a schedule set for
 * 09:00 in JST reopened as 00:00. The input is local-time by definition.
 */
export function toDatetimeLocal(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (_) { return ''; }
}

/** Weekdays are meaningless for a one-off and for a calendar-day monthly. */
export function usesWeekdays(type) {
    return type !== 'once' && type !== 'monthly';
}

/**
 * Can this schedule be registered?
 *
 * A schedule with no instruction has nothing to run, so it stays a draft rather
 * than becoming a silently dead entry in the list.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateForSave(s) {
    if (!s || !String(s.prompt || '').trim()) {
        return { ok: false, reason: 'Enter a prompt before saving — a schedule with no instruction has nothing to run.' };
    }
    return { ok: true };
}
