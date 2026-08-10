<!--
  TaskList — the executions list (the left panel).

  Region 4 of the Svelte migration. What it replaces:
    • _renderTaskListHtml / _taskItemHtml — string builders;
    • _bindTaskListEvents — four querySelectorAll loops re-attaching listeners to
      freshly-written innerHTML after every render;
    • _syncTaskEntry's DOM half — it reached into the selected row and patched its
      className, its status dot and its progress bar by hand, because a live
      status change had no other way to reach the list.

  The grouping/filtering RULES live in views/monitor/taskList.js as pure functions.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import {
        filterTasks, groupTasks, applyDefaultCollapse, shortTaskId, rowStatus,
    } from '../../views/monitor/taskList.js';

    let {
        tasks = [],
        selectedId = null,
        search = '',
        statusFilter = 'all',
        groupBy = 'date',
        /** Persistent across renders, owned by the view — see applyDefaultCollapse. */
        seenKeys = new Set(),
        collapsedKeys = new Set(),
        onSelect = null,
        onDelete = null,
        onNewTask = null,
        onSearch = null,
        onStatusFilter = null,
        onGroupBy = null,
    } = $props();

    const STATUSES = ['all', 'running', 'paused', 'completed', 'failed', 'aborted'];

    const filtered = $derived(filterTasks(tasks, { search, status: statusFilter }));

    // `collapsedKeys` (the caller's Set) stays the single source of truth — that is
    // what lets a manual toggle survive both a re-render and a re-route. A plain
    // Set is invisible to Svelte, so `toggles` is the reactivity trigger: bumping
    // it re-runs the derivation, which re-reads the Set.
    let toggles = $state(0);

    const groups = $derived.by(() => {
        toggles;                                   // dependency, deliberately
        const g = groupTasks(filtered, groupBy);
        // Must run BEFORE the collapsed flags are read: it is what folds a
        // newly-seen non-first group.
        applyDefaultCollapse(g, seenKeys, collapsedKeys);
        return g.map(x => ({ ...x, collapsed: collapsedKeys.has(x.key) }));
    });

    const toggleGroup = (key) => {
        if (collapsedKeys.has(key)) collapsedKeys.delete(key);
        else collapsedKeys.add(key);
        toggles += 1;
    };

    const pct = (t) => Math.round((t.progress || 0) * 100);
    const clock = (iso) => {
        if (!iso) return '';
        try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
        catch { return ''; }
    };
</script>

<div class="mtask-filter">
    <input
        type="text" class="mtask-search"
        placeholder="🔍 Search prompt, ID, caller…"
        value={search}
        oninput={(e) => onSearch?.(e.currentTarget.value)}
    >
    <select class="mtask-status" value={statusFilter}
        onchange={(e) => onStatusFilter?.(e.currentTarget.value)}>
        {#each STATUSES as s (s)}
            <option value={s}>{s === 'all' ? 'All statuses' : s}</option>
        {/each}
    </select>
</div>

<div class="mgroup-toggle">
    <button class="mgroup-btn" class:active={groupBy === 'date'}
        onclick={() => onGroupBy?.('date')}>{@html icon('calendar', 13)} Date</button>
    <button class="mgroup-btn" class:active={groupBy === 'workspace'}
        onclick={() => onGroupBy?.('workspace')}>{@html icon('folder', 13)} WS</button>
</div>

<div class="mpanel-left-list">
    {#if !tasks.length}
        <div class="mtask-empty">No tasks yet</div>
    {:else if !filtered.length}
        <div class="mtask-empty">No tasks match the filter</div>
    {:else}
        {#each groups as g (g.key)}
            {@const isCollapsed = g.collapsed}
            <div class="mtask-group-header" class:collapsed={isCollapsed}
                data-group-key={g.key}
                role="button" tabindex="0"
                onclick={() => toggleGroup(g.key)}
                onkeydown={(e) => { if (e.key === 'Enter') toggleGroup(g.key); }}>
                <span class="mgroup-chevron">{isCollapsed ? '▶' : '▼'}</span>
                <span class="mgroup-name">{g.key}</span>
                <span class="mgroup-count">{g.tasks.length}</span>
                <!-- On the WS view, "＋" opens the new-task modal pre-set to THIS
                     workspace — the group's real full path, not the basename key. -->
                {#if groupBy === 'workspace'}
                    <button class="mgroup-add" data-ws-add={g.workspace}
                        title="New task in this workspace"
                        onclick={(e) => { e.stopPropagation(); onNewTask?.(g.workspace || null); }}
                    >{@html icon('plus', 12)}</button>
                {/if}
            </div>
            {#if !isCollapsed}
                <div class="mtask-group-items" data-group-items={g.key}>
                    {#each g.tasks as t (t.id)}
                        {@const st = rowStatus(t.status)}
                        <div class="mtask-item mtask-{st}"
                            class:selected={t.id === selectedId}
                            data-task-id={t.id}
                            role="button" tabindex="0"
                            onclick={() => onSelect?.(t.id)}
                            onkeydown={(e) => { if (e.key === 'Enter') onSelect?.(t.id); }}>
                            <div class="mtask-top">
                                <span class="mtask-dot dot-{st}"></span>
                                <span class="mtask-id">{shortTaskId(t.id)}</span>
                                {#if t.caller}<span class="mtask-caller">{t.caller}</span>{/if}
                                <span class="mtask-time">{clock(t.started_at)}</span>
                                <!-- Delete straight from the list, without opening
                                     the task first. stopPropagation so it does not
                                     also navigate into it. -->
                                {#if st !== 'running'}
                                    <button class="mtask-del" data-del-id={t.id}
                                        title="Delete this task from history"
                                        onclick={(e) => { e.stopPropagation(); onDelete?.(t.id); }}
                                    >{@html icon('trash', 13)}</button>
                                {/if}
                            </div>
                            <div class="mtask-prompt">{t.prompt}</div>
                            {#if st === 'running'}
                                <div class="mtask-progbar"><div style={`width:${pct(t)}%`}></div></div>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        {/each}
    {/if}
</div>
