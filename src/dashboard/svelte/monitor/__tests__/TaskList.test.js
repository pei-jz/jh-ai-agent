// @vitest-environment jsdom
//
// TaskList — region 4 of the Svelte migration.
//
// The markup and the interactions. The grouping/filtering rules are pure functions
// with their own suite (views/monitor/__tests__/taskList.test.js).
//
// What these pin that the string version could not be asked about: that a click
// reaches its callback, that the search box reports what was typed, and that a live
// status change reaches the row through a prop instead of through the hand-patching
// `_syncTaskEntry` used to do.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import TaskList from '../TaskList.svelte';
import { t } from '../../../../i18n/index.js';

afterEach(() => cleanup());

const task = (id, over = {}) => ({
    id, prompt: `prompt ${id}`, status: 'completed', progress: 1,
    started_at: '2026-07-01T10:00:00Z', workspace_path: 'C:/work/proj', ...over,
});

/** Fresh collapse memory per mount, so tests do not leak state into each other. */
const mount = (props = {}) => render(TaskList, {
    props: { tasks: [], seenKeys: new Set(), collapsedKeys: new Set(), ...props },
}).container;

const rows = (el) => [...el.querySelectorAll('.mtask-item')].map(r => r.dataset.taskId);
const headers = (el) => [...el.querySelectorAll('.mtask-group-header')];

describe('TaskList — empty states', () => {
    it('says there are no tasks yet', () => {
        expect(mount().textContent).toContain(t('list.empty'));
    });

    it('distinguishes "nothing yet" from "nothing MATCHES"', () => {
        const el = mount({ tasks: [task('a')], search: 'zzzz-no-match' });
        expect(el.textContent).toContain(t('list.noMatch'));
        expect(el.textContent).not.toContain(t('list.empty'));
    });
});

describe('TaskList — rows', () => {
    it('renders a row per task, with its short id, caller and prompt', () => {
        const el = mount({ tasks: [task('abc123def', { caller: 'NewTask' })] });
        const row = el.querySelector('.mtask-item');
        expect(row.textContent).toContain('#abc123');
        expect(row.textContent).toContain('NewTask');
        expect(row.textContent).toContain('prompt abc123def');
    });

    it('marks the selected row', () => {
        const el = mount({ tasks: [task('a'), task('b')], selectedId: 'b' });
        expect(el.querySelector('[data-task-id="b"]').classList.contains('selected')).toBe(true);
        expect(el.querySelector('[data-task-id="a"]').classList.contains('selected')).toBe(false);
    });

    it('carries the status on the row and its dot', () => {
        const el = mount({ tasks: [task('a', { status: 'failed' })] });
        expect(el.querySelector('.mtask-item').classList.contains('mtask-failed')).toBe(true);
        expect(el.querySelector('.mtask-dot').classList.contains('dot-failed')).toBe(true);
    });

    it('shows a WAITING task as running — it is not stalled', () => {
        const el = mount({ tasks: [task('a', { status: 'waiting' })] });
        expect(el.querySelector('.mtask-item').classList.contains('mtask-running')).toBe(true);
    });

    it('shows a progress bar ONLY while running', () => {
        const el = mount({ tasks: [task('a', { status: 'running', progress: 0.42 })] });
        expect(el.querySelector('.mtask-progbar > div').style.width).toBe('42%');
        cleanup();
        expect(mount({ tasks: [task('a')] }).querySelector('.mtask-progbar')).toBe(null);
    });

    it('a live status change reaches the row through a PROP', async () => {
        // This is what _syncTaskEntry used to do by reaching into the row and
        // patching its className, its dot and its progress bar by hand.
        const { container, rerender } = render(TaskList, {
            props: {
                tasks: [task('a', { status: 'running', progress: 0.5 })],
                seenKeys: new Set(), collapsedKeys: new Set(),
            },
        });
        expect(container.querySelector('.mtask-item').classList.contains('mtask-running')).toBe(true);
        await rerender({
            tasks: [task('a', { status: 'completed', progress: 1 })],
            seenKeys: new Set(), collapsedKeys: new Set(),
        });
        expect(container.querySelector('.mtask-item').classList.contains('mtask-completed')).toBe(true);
        expect(container.querySelector('.mtask-progbar')).toBe(null);
    });

    it('selects on click', () => {
        const onSelect = vi.fn();
        mount({ tasks: [task('a')], onSelect }).querySelector('.mtask-item').click();
        expect(onSelect).toHaveBeenCalledWith('a');
    });
});

describe('TaskList — per-row delete', () => {
    it('offers delete on a finished task, and NOT on a running one', () => {
        expect(mount({ tasks: [task('a')] }).querySelector('.mtask-del')).not.toBe(null);
        cleanup();
        expect(mount({ tasks: [task('a', { status: 'running' })] }).querySelector('.mtask-del')).toBe(null);
    });

    it('deletes without ALSO navigating into the task', () => {
        const onDelete = vi.fn();
        const onSelect = vi.fn();
        mount({ tasks: [task('a')], onDelete, onSelect }).querySelector('.mtask-del').click();
        expect(onDelete).toHaveBeenCalledWith('a');
        expect(onSelect).not.toHaveBeenCalled();
    });
});

describe('TaskList — grouping', () => {
    const tasks = [
        task('a1', { started_at: '2026-07-05T10:00:00Z', workspace_path: 'C:/work/alpha' }),
        task('b1', { started_at: '2026-07-03T10:00:00Z', workspace_path: 'C:/work/beta' }),
        task('b2', { started_at: '2026-07-02T10:00:00Z', workspace_path: 'C:/work/beta' }),
    ];

    it('opens the first group and folds the rest', () => {
        const el = mount({ tasks, groupBy: 'workspace' });
        const hs = headers(el);
        expect(hs.length).toBeGreaterThan(1);
        expect(hs[0].classList.contains('collapsed')).toBe(false);
        expect(hs.slice(1).every(h => h.classList.contains('collapsed'))).toBe(true);
    });

    it('shows only the rows of the open group', () => {
        const el = mount({ tasks, groupBy: 'workspace' });
        expect(rows(el)).toEqual(['a1']);
    });

    it('toggles a group open on click', async () => {
        const el = mount({ tasks, groupBy: 'workspace' });
        headers(el)[1].click();
        await tick();          // component-internal state; Svelte batches it
        expect(rows(el)).toEqual(['a1', 'b1', 'b2']);
    });

    it('counts the tasks in each group', () => {
        const el = mount({ tasks, groupBy: 'workspace' });
        expect(headers(el)[1].textContent).toContain('2');
    });

    it('offers "new task here" ONLY in the workspace view, with the full path', () => {
        const el = mount({ tasks, groupBy: 'workspace' });
        expect(el.querySelector('[data-ws-add]').dataset.wsAdd).toBe('C:/work/alpha');
        cleanup();
        expect(mount({ tasks, groupBy: 'date' }).querySelector('[data-ws-add]')).toBe(null);
    });

    it('the "＋" does not also toggle the group', () => {
        const onNewTask = vi.fn();
        const el = mount({ tasks, groupBy: 'workspace', onNewTask });
        el.querySelector('[data-ws-add]').click();
        expect(onNewTask).toHaveBeenCalledWith('C:/work/alpha');
        expect(rows(el)).toEqual(['a1']);      // still just the open group
    });
});

describe('TaskList — the chrome that was removed', () => {
    // The search box and the five status buttons were dropped as unused
    // (2026-08-30). What is asserted now is their ABSENCE: they occupied the top
    // of the column, where the composer and the running task are, and re-adding
    // them would be a regression rather than a feature.
    it('has no search box', () => {
        expect(mount().querySelector('.mtask-search')).toBeNull();
    });

    it('has no status filter buttons', () => {
        expect(mount().querySelectorAll('.mtask-status-btn')).toHaveLength(0);
    });

    // The RULES stay: only the chrome went, so a command palette can drive the
    // same filtering later without this component growing a UI again.
    it('still applies a search term supplied as a prop', () => {
        const el = mount({ tasks: [task('a', { prompt: 'alpha' }), task('b', { prompt: 'beta' })], search: 'alpha' });
        expect([...el.querySelectorAll('.mtask-prompt')].map(e => e.textContent)).toEqual(['alpha']);
    });

    it('still applies a status filter supplied as a prop', () => {
        const el = mount({
            tasks: [task('a', { status: 'running' }), task('b', { status: 'completed' })],
            statusFilter: ['running'],
        });
        expect(el.querySelectorAll('.mtask-item')).toHaveLength(1);
    });
});
