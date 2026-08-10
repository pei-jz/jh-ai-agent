// The executions list's RULES. These were interleaved with string building inside
// MonitorView, so "does a running task float to the top?" and "does a manually
// collapsed group stay collapsed when a new one appears?" could only be answered by
// reading a template literal.

import { describe, it, expect } from 'vitest';
import {
    taskGroupKey, filterTasks, sortTasks, groupTasks, applyDefaultCollapse,
    shortTaskId, rowStatus,
} from '../taskList.js';

const task = (id, over = {}) => ({
    id, prompt: `prompt ${id}`, status: 'completed',
    started_at: '2026-07-01T00:00:00Z', workspace_path: 'C:/work/proj', ...over,
});

describe('taskGroupKey', () => {
    it('groups by DATE by default', () => {
        expect(taskGroupKey(task('a', { started_at: '2026-07-05T10:00:00Z' }))).toBe('2026-07-05');
    });

    it('groups by the workspace BASENAME when asked', () => {
        expect(taskGroupKey(task('a', { workspace_path: 'C:/work/alpha' }), 'workspace')).toBe('alpha');
        expect(taskGroupKey(task('a', { workspace_path: 'C:\\work\\beta\\' }), 'workspace')).toBe('beta');
    });

    it('names the missing cases rather than producing an empty header', () => {
        expect(taskGroupKey(task('a', { workspace_path: '' }), 'workspace')).toBe('(no workspace)');
        expect(taskGroupKey(task('a', { started_at: null }))).toBe('(unknown date)');
    });
});

describe('filterTasks', () => {
    const tasks = [
        task('abc123', { prompt: 'evaluate the agent', caller: 'NewTask' }),
        task('def456', { prompt: 'fix the header', caller: 'JHEditor', status: 'running' }),
    ];

    it('searches id, prompt and caller together', () => {
        // A user remembers ONE of the three and should not have to say which.
        expect(filterTasks(tasks, { search: 'abc' }).map(t => t.id)).toEqual(['abc123']);
        expect(filterTasks(tasks, { search: 'header' }).map(t => t.id)).toEqual(['def456']);
        expect(filterTasks(tasks, { search: 'jheditor' }).map(t => t.id)).toEqual(['def456']);
    });

    it('is case-insensitive and ignores surrounding space', () => {
        expect(filterTasks(tasks, { search: '  EVALUATE ' })).toHaveLength(1);
    });

    it('filters by status', () => {
        expect(filterTasks(tasks, { status: 'running' }).map(t => t.id)).toEqual(['def456']);
        expect(filterTasks(tasks, { status: 'all' })).toHaveLength(2);
    });

    it('combines the two', () => {
        expect(filterTasks(tasks, { search: 'abc', status: 'running' })).toHaveLength(0);
    });

    it('returns everything with no criteria', () => {
        expect(filterTasks(tasks)).toHaveLength(2);
        expect(filterTasks(null)).toEqual([]);
    });
});

describe('sortTasks', () => {
    it('floats a RUNNING task above completed ones, however old it is', () => {
        const out = sortTasks([
            task('done', { started_at: '2026-07-09T00:00:00Z' }),
            task('live', { started_at: '2026-01-01T00:00:00Z', status: 'running' }),
        ]);
        expect(out.map(t => t.id)).toEqual(['live', 'done']);
    });

    it('otherwise puts the newest first', () => {
        const out = sortTasks([
            task('old', { started_at: '2026-07-01T00:00:00Z' }),
            task('new', { started_at: '2026-07-09T00:00:00Z' }),
        ]);
        expect(out.map(t => t.id)).toEqual(['new', 'old']);
    });

    it('does NOT reorder the array it was given', () => {
        // The previous version sorted in place, which also reordered this.tasks
        // because filter and sort shared the backing objects.
        const input = [task('a', { started_at: '2026-07-01T00:00:00Z' }),
                       task('b', { started_at: '2026-07-09T00:00:00Z' })];
        sortTasks(input);
        expect(input.map(t => t.id)).toEqual(['a', 'b']);
    });
});

describe('groupTasks', () => {
    const tasks = [
        task('a1', { started_at: '2026-07-05T10:00:00Z', workspace_path: 'C:/work/alpha' }),
        task('b1', { started_at: '2026-07-03T10:00:00Z', workspace_path: 'C:/work/beta' }),
        task('b2', { started_at: '2026-07-02T10:00:00Z', workspace_path: 'C:/work/beta' }),
    ];

    it('buckets by key, newest group first', () => {
        const g = groupTasks(tasks, 'workspace');
        expect(g.map(x => x.key)).toEqual(['alpha', 'beta']);
        expect(g[1].tasks.map(t => t.id)).toEqual(['b1', 'b2']);
    });

    it('keeps the real full path of the group, not just the key', () => {
        // The "＋ new task here" button needs the path; the key is a basename.
        expect(groupTasks(tasks, 'workspace')[0].workspace).toBe('C:/work/alpha');
    });

    it('groups by date in the default mode', () => {
        expect(groupTasks(tasks).map(x => x.key)).toEqual(['2026-07-05', '2026-07-03', '2026-07-02']);
    });

    it('puts the group holding a RUNNING task first', () => {
        const g = groupTasks([...tasks, task('live', {
            started_at: '2026-01-01T00:00:00Z', workspace_path: 'C:/work/zeta', status: 'running',
        })], 'workspace');
        expect(g[0].key).toBe('zeta');
    });

    it('is empty for no tasks', () => {
        expect(groupTasks([])).toEqual([]);
        expect(groupTasks(null)).toEqual([]);
    });
});

describe('applyDefaultCollapse', () => {
    const groups = (...keys) => keys.map(key => ({ key }));

    it('opens the first group and folds the rest, on first sight', () => {
        const seen = new Set(); const collapsed = new Set();
        applyDefaultCollapse(groups('a', 'b', 'c'), seen, collapsed);
        expect(collapsed.has('a')).toBe(false);
        expect(collapsed.has('b')).toBe(true);
        expect(collapsed.has('c')).toBe(true);
    });

    it('never re-folds a group the user has already opened', () => {
        // This is the whole reason for the `seen` set: the list re-renders on every
        // status event, and re-deriving the default each time would undo the click.
        const seen = new Set(); const collapsed = new Set();
        applyDefaultCollapse(groups('a', 'b'), seen, collapsed);
        collapsed.delete('b');                       // user opened it
        applyDefaultCollapse(groups('a', 'b'), seen, collapsed);
        expect(collapsed.has('b')).toBe(false);
    });

    it('folds a NEWLY appeared non-first group without touching the others', () => {
        const seen = new Set(); const collapsed = new Set();
        applyDefaultCollapse(groups('a', 'b'), seen, collapsed);
        collapsed.delete('b');
        applyDefaultCollapse(groups('a', 'b', 'c'), seen, collapsed);
        expect(collapsed.has('c')).toBe(true);
        expect(collapsed.has('b')).toBe(false);
    });

    it('leaves a single group open', () => {
        const collapsed = new Set();
        applyDefaultCollapse(groups('only'), new Set(), collapsed);
        expect(collapsed.size).toBe(0);
    });
});

describe('shortTaskId', () => {
    it('keeps enough characters to tell rows apart', () => {
        expect(shortTaskId('a78b33ad9c4e')).toBe('#a78b33');
        expect(shortTaskId('')).toBe('#');
    });
});

describe('rowStatus', () => {
    it('shows a WAITING task as running in the list', () => {
        // 'waiting' is a run-level state (paused on ask_user). In the list it read
        // as stalled, when the task is still very much live.
        expect(rowStatus('waiting')).toBe('running');
    });

    it('passes every other status through', () => {
        for (const s of ['running', 'completed', 'failed', 'aborted', 'paused']) {
            expect(rowStatus(s)).toBe(s);
        }
    });
});
