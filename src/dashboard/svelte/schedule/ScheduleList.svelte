<!--
  ScheduleList — the left panel.

  Replaces `_renderList` (a string builder) plus `_bindListItems`, which
  re-attached a click listener to every row after each innerHTML rewrite.
-->
<script>
    import {
        DAY_LABELS, nextRunText, scheduleTypeBadge,
    } from '../../views/schedule/scheduleModel.js';

    let {
        schedules = [],
        /** The unsaved draft, if any. Rendered first and marked. */
        draft = null,
        selectedId = null,
        onSelect = null,
        onNew = null,
        /** Injectable clock so "Next: …" is testable. */
        now = null,
    } = $props();

    const visible = $derived(draft ? [draft, ...schedules] : schedules);
    const at = () => now || new Date();
</script>

<div class="sch-list-panel">
    <div class="sch-list-header">
        <span>Schedules ({schedules.length})</span>
        <button type="button" class="btn btn-primary sch-new" onclick={() => onNew?.()}>+ New</button>
    </div>
    <div class="sch-list-body">
        {#if visible.length === 0}
            <div class="sch-empty">No schedules<br>Add one with "+ New"</div>
        {:else}
            {#each visible as s (s.id)}
                {@const isDraft = !!draft && draft.id === s.id}
                {@const days = s.days || [1, 2, 3, 4, 5]}
                <div
                    class="sch-item"
                    class:selected={selectedId === s.id}
                    role="button"
                    tabindex="0"
                    onclick={() => onSelect?.(s.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(s.id); } }}
                >
                    <div class="sch-item-top">
                        <span class="sch-dot" class:on={s.enabled} class:off={!s.enabled}></span>
                        <span class="sch-time-badge">{scheduleTypeBadge(s)}</span>
                        <span class="sch-state" class:is-draft={isDraft}>
                            {isDraft ? 'Unsaved' : (s.enabled ? 'On' : 'Off')}
                        </span>
                    </div>
                    <div class="sch-days-row">
                        {#if (s.scheduleType || 'fixed') === 'once'}
                            <span class="sch-once-at">{s.onceAt ? new Date(s.onceAt).toLocaleString() : 'not set'}</span>
                        {:else}
                            {#each DAY_LABELS as d, i}
                                <span class="sch-day-chip" class:active={days.includes(i)} class:inactive={!days.includes(i)}>{d}</span>
                            {/each}
                        {/if}
                    </div>
                    <div class="sch-prompt-preview">{s.name || s.prompt || '(untitled)'}</div>
                    <div class="sch-next">
                        {isDraft ? 'Not registered until you save' : `Next: ${nextRunText(s, at())}`}
                    </div>
                </div>
            {/each}
        {/if}
    </div>
</div>

<style>
    .sch-list-panel {
        width: 280px;
        min-width: 220px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .sch-list-header {
        padding: 10px 14px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .sch-new { height: 24px; padding: 0 10px; font-size: 11px; }
    .sch-list-body {
        flex: 1;
        overflow-y: auto;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .sch-item {
        padding: 9px 11px;
        border-radius: 7px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.12s;
    }
    .sch-item:hover { background: var(--bg-hover); }
    .sch-item.selected { background: var(--accent-glow-lg); border-color: var(--accent); }
    .sch-item-top { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .sch-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .sch-dot.on { background: var(--success); }
    .sch-dot.off { background: var(--text-tertiary); }
    .sch-time-badge { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--accent); }
    .sch-state { font-size: 10px; color: var(--text-tertiary); margin-left: auto; }
    .sch-state.is-draft { color: var(--warning); }
    .sch-days-row { display: flex; gap: 2px; margin-bottom: 3px; }
    .sch-day-chip { font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 600; }
    .sch-day-chip.active { background: var(--accent-glow); color: var(--accent); }
    .sch-day-chip.inactive { background: var(--bg-tertiary); color: var(--text-tertiary); }
    .sch-once-at { font-size: 10px; color: var(--accent); }
    .sch-prompt-preview {
        font-size: 11.5px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .sch-next { font-size: 10px; color: var(--text-tertiary); margin-top: 2px; }
    .sch-empty { padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 12px; }
</style>
