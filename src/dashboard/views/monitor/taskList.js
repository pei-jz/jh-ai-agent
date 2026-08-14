// taskList — filtering, sorting and grouping for the executions list.
//
// Pure: every export takes tasks (and the current filter/grouping choices) and
// returns data. The rendering is svelte/monitor/TaskList.svelte.
//
// This is where the list's actual RULES live, and they were previously interleaved
// with string building inside MonitorView — so "does a running task float to the
// top of its group?" and "does a manually-collapsed group stay collapsed when a
// new one appears?" could only be answered by reading a template literal.

/** Which group a task belongs to, under the current grouping mode. */
export function taskGroupKey(task, groupBy = 'date') {
    if (groupBy === 'workspace') {
        const ws = (task.workspace_path || '').replace(/[\\/]+$/, '');
        if (!ws) return '(no workspace)';
        return ws.split(/[\\/]/).pop() || ws;
    }
    return (task.started_at || '').slice(0, 10) || '(unknown date)';
}

/**
 * Search text + status filter.
 *
 * The search covers id, prompt and caller together: a user looking for a task
 * remembers one of the three and should not have to say which.
 *
 * `status` accepts 'all' (no filter), a single status string, or an ARRAY of
 * statuses — an array matches ANY of the listed statuses (the button-bar
 * multi-select in TaskList).
 */
export function filterTasks(tasks, { search = '', status = 'all' } = {}) {
    const q = String(search || '').toLowerCase().trim();
    const wanted = Array.isArray(status)
        ? status.filter(Boolean)
        : (status && status !== 'all' ? [status] : []);
    return (tasks || []).filter(t => {
        if (wanted.length > 0 && !wanted.includes(t.status)) return false;
        if (!q) return true;
        return (t.id || '').toLowerCase().includes(q)
            || (t.prompt || '').toLowerCase().includes(q)
            || (t.caller || '').toLowerCase().includes(q);
    });
}

/**
 * Running first, then newest first.
 *
 * Returns a NEW array — the previous version sorted `filtered` in place, which
 * also reordered `this.tasks` because filter+sort shared the backing objects.
 */
export function sortTasks(tasks) {
    return [...(tasks || [])].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return new Date(b.started_at) - new Date(a.started_at);
    });
}

/**
 * Bucket sorted tasks by group key, preserving the sort order within and across
 * groups (so the group holding the newest task comes first).
 *
 * @returns {Array<{key:string, workspace:string, tasks:Array}>}
 *          `workspace` is the group's real full path — the key is only a basename,
 *          and the "＋ new task here" button needs the path.
 */
export function groupTasks(tasks, groupBy = 'date') {
    const groups = new Map();
    for (const t of sortTasks(tasks)) {
        const key = taskGroupKey(t, groupBy);
        if (!groups.has(key)) {
            groups.set(key, { key, workspace: t.workspace_path || '', tasks: [] });
        }
        groups.get(key).tasks.push(t);
    }
    return [...groups.values()];
}

/**
 * Decide which groups start collapsed.
 *
 * The newest (or running) group opens and the rest are folded — but only on a
 * key's FIRST sighting, so a manual toggle is never undone by a later render.
 * `seen` and `collapsed` are mutated: they are the caller's persistent memory
 * across renders, which is exactly what makes the manual toggle stick.
 *
 * @param {Array<{key:string}>} groups in display order
 * @param {Set<string>} seen keys encountered in previous renders
 * @param {Set<string>} collapsed keys currently folded
 * @returns {Set<string>} the same `collapsed` set, for chaining
 */
export function applyDefaultCollapse(groups, seen, collapsed) {
    groups.forEach((g, i) => {
        if (i > 0 && !seen.has(g.key)) collapsed.add(g.key);
        seen.add(g.key);
    });
    return collapsed;
}

/** Short id for a list row — six characters is enough to tell rows apart. */
export function shortTaskId(id) {
    return `#${String(id || '').slice(0, 6)}`;
}

/**
 * The status a LIST ROW should show.
 *
 * 'waiting' is a run-level state (the agent paused on ask_user); in the list the
 * task is still effectively running, and showing "waiting" there read as stalled.
 */
export function rowStatus(status) {
    return status === 'waiting' ? 'running' : status;
}
