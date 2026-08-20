// @vitest-environment jsdom
//
// The Schedule view, after migration. Two classes of bug the old shape allowed
// are structurally impossible now, and these pin that:
//
//   • the four schedule types shared ONE `time` input plus a second hidden one
//     for monthly, so Save had to know which of the two to read — reading the
//     wrong one silently saved 09:00;
//   • "+ New" wrote straight to storage, so an unnamed, promptless entry became
//     a registered recurring task before the user typed anything.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

vi.mock('../../../../modules/ai/ScheduleManager.js', () => ({
    scheduleManager: { reloadSchedules: vi.fn() },
    monthDay: (dom, probe) => {
        const last = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
        return dom === 'last' ? last : Math.min(parseInt(dom, 10) || 1, last);
    },
}));
vi.mock('../../../../modules/ai/McpManager.js', () => ({
    mcpManager: { serversConfig: { mcpServers: {} } },
}));

const ScheduleRoot = (await import('../ScheduleRoot.svelte')).default;
const ScheduleList = (await import('../ScheduleList.svelte')).default;

afterEach(() => cleanup());

const NOW = new Date(2026, 7, 12, 8, 0);   // Wed 2026-08-12 08:00

const sched = (over = {}) => ({
    id: 's1', name: 'Nightly', prompt: 'run the tests', agentModeId: 'general',
    mcpServers: [], scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5],
    intervalMinutes: 60, onceAt: null, dayOfMonth: 1, enabled: true, runs: [],
    ...over,
});

/** Mount the root with storage and side effects injected. */
function mountRoot(initial = [], over = {}) {
    let stored = [...initial];
    const save = vi.fn((list) => { stored = list; });
    const notify = vi.fn();
    const confirmDelete = vi.fn(() => true);
    const utils = render(ScheduleRoot, {
        props: {
            load: () => stored,
            save,
            notify,
            confirmDelete,
            navigate: vi.fn(),
            now: NOW,
            mcpServerNames: [],
            ...over,
        },
    });
    return { ...utils, save, notify, confirmDelete, saved: () => stored };
}

describe('list', () => {
    it('renders one row per schedule with its badge and next-run text', () => {
        const { container } = mountRoot([sched()]);
        expect(container.querySelector('.sch-time-badge').textContent).toBe('09:00');
        expect(container.querySelector('.sch-prompt-preview').textContent).toBe('Nightly');
        expect(container.querySelector('.sch-next').textContent).toContain('in 1h 0m');
    });

    it('shows the empty state when there is nothing', () => {
        const { container } = mountRoot([]);
        expect(container.querySelector('.sch-empty')).toBeTruthy();
    });

    it('counts only SAVED schedules in the header, not the draft', () => {
        const { container } = mountRoot([sched()]);
        fireEvent.click(container.querySelector('.sch-new'));
        expect(container.querySelector('.sch-list-header').textContent).toContain('Schedules (1)');
        expect(container.querySelectorAll('.sch-item')).toHaveLength(2);
    });

    it('marks a one-off with its date instead of weekday chips', () => {
        const { container } = render(ScheduleList, {
            props: {
                schedules: [sched({ scheduleType: 'once', onceAt: new Date(2026, 7, 20, 9, 0).toISOString() })],
                now: NOW,
            },
        });
        expect(container.querySelector('.sch-once-at')).toBeTruthy();
        expect(container.querySelector('.sch-day-chip')).toBeFalsy();
    });
});

describe('draft lifecycle', () => {
    it('"+ New" does NOT register anything', () => {
        const { container, save, saved } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        expect(save).not.toHaveBeenCalled();
        expect(saved()).toEqual([]);
    });

    it('marks the draft as Unsaved and says it is not registered', () => {
        const { container } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        expect(container.querySelector('.sch-state').textContent.trim()).toBe('Unsaved');
        expect(container.querySelector('.sch-next').textContent).toContain('Not registered');
    });

    it('refuses to save a draft with no prompt, and still does not register it', async () => {
        const { container, save, notify } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        await Promise.resolve();
        fireEvent.click(container.querySelector('.btn-primary:not(.sch-new)'));
        expect(save).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.stringMatching(/nothing to run/));
    });

    it('registers the draft once it has a prompt', async () => {
        const { container, save, saved } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        await Promise.resolve();
        await fireEvent.input(container.querySelector('#sch-prompt'), { target: { value: 'do the thing' } });
        await fireEvent.click(container.querySelector('.sch-actions .btn-primary'));
        expect(save).toHaveBeenCalled();
        expect(saved()).toHaveLength(1);
        expect(saved()[0].prompt).toBe('do the thing');
    });

    it('discarding a draft needs no confirmation and writes nothing', async () => {
        const { container, save, confirmDelete } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        await Promise.resolve();
        await fireEvent.click(container.querySelector('.sch-delete'));
        expect(confirmDelete).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it('"Run now" is unavailable for an unsaved draft', async () => {
        const { container } = mountRoot([]);
        fireEvent.click(container.querySelector('.sch-new'));
        await Promise.resolve();
        expect(container.querySelector('.btn-secondary').disabled).toBe(true);
    });
});

describe('editing an existing schedule', () => {
    async function open(over = {}) {
        const h = mountRoot([sched(over)]);
        await fireEvent.click(h.container.querySelector('.sch-item'));
        return h;
    }

    it('seeds the form from the selected schedule', async () => {
        const { container } = await open();
        expect(container.querySelector('#sch-name').value).toBe('Nightly');
        expect(container.querySelector('#sch-prompt').value).toBe('run the tests');
    });

    // The bug the old shape made possible.
    it('saves the MONTHLY time, not a stale fixed-time input', async () => {
        const { container, saved } = await open();
        await fireEvent.click([...container.querySelectorAll('.sch-type-btn')].find(b => b.textContent.trim() === 'Monthly'));
        const time = container.querySelector('.sch-time-input');
        await fireEvent.input(time, { target: { value: '23:45' } });
        await fireEvent.click(container.querySelector('.sch-actions .btn-primary'));
        expect(saved()[0].scheduleType).toBe('monthly');
        expect(saved()[0].time).toBe('23:45');
    });

    it('shows exactly one type section at a time', async () => {
        const { container } = await open();
        const byLabel = (t) => [...container.querySelectorAll('.sch-type-btn')].find(b => b.textContent.trim() === t);

        await fireEvent.click(byLabel('Interval'));
        expect(container.querySelector('#sch-interval')).toBeTruthy();
        expect(container.querySelector('#sch-time')).toBeFalsy();
        expect(container.querySelector('#sch-once')).toBeFalsy();

        await fireEvent.click(byLabel('Once'));
        expect(container.querySelector('#sch-once')).toBeTruthy();
        expect(container.querySelector('#sch-interval')).toBeFalsy();
    });

    it('hides the weekday picker where a weekday means nothing', async () => {
        const { container } = await open();
        const byLabel = (t) => [...container.querySelectorAll('.sch-type-btn')].find(b => b.textContent.trim() === t);
        expect(container.querySelector('.sch-days-picker')).toBeTruthy();
        await fireEvent.click(byLabel('Once'));
        expect(container.querySelector('.sch-days-picker')).toBeFalsy();
        await fireEvent.click(byLabel('Monthly'));
        expect(container.querySelector('.sch-days-picker')).toBeFalsy();
    });

    it('toggling a weekday updates what gets saved', async () => {
        const { container, saved } = await open();
        const monday = container.querySelectorAll('.sch-day-btn')[1];
        await fireEvent.click(monday);                     // Mon was on → now off
        await fireEvent.click(container.querySelector('.sch-actions .btn-primary'));
        expect(saved()[0].days).toEqual([2, 3, 4, 5]);
    });

    it('deleting asks first, then removes it', async () => {
        const { container, confirmDelete, saved } = await open();
        await fireEvent.click(container.querySelector('.sch-delete'));
        expect(confirmDelete).toHaveBeenCalled();
        expect(saved()).toEqual([]);
    });

    it('keeps the edit when the user declines the delete', async () => {
        const h = mountRoot([sched()], { confirmDelete: () => false });
        await fireEvent.click(h.container.querySelector('.sch-item'));
        await fireEvent.click(h.container.querySelector('.sch-delete'));
        expect(h.saved()).toHaveLength(1);
    });
});

describe('run now', () => {
    it('posts the task and navigates to the monitor', async () => {
        const navigate = vi.fn();
        const api = { request: vi.fn(async () => ({ task_id: 'T1' })) };
        const h = mountRoot([sched()], { api, navigate });
        await fireEvent.click(h.container.querySelector('.sch-item'));
        await fireEvent.click(h.container.querySelector('.btn-secondary'));
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('#monitor?id=T1'));

        const body = JSON.parse(api.request.mock.calls[0][1].body);
        expect(body.caller).toBe('Schedule');
        expect(body.prompt).toBe('run the tests');
        // Explicit [] means "no MCP tools"; omitting it would mean "all servers".
        expect(body.behavior.mcp_servers).toEqual([]);
    });

    it('records a failure without navigating away', async () => {
        const navigate = vi.fn();
        const api = { request: vi.fn(async () => { throw new Error('boom'); }) };
        const h = mountRoot([sched()], { api, navigate });
        await fireEvent.click(h.container.querySelector('.sch-item'));
        await fireEvent.click(h.container.querySelector('.btn-secondary'));
        await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('boom')));
        expect(navigate).not.toHaveBeenCalled();
        expect(h.saved()[0].runs.at(-1).status).toBe('failed');
    });
});
