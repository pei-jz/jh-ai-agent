<!--
  HistoryModal — pick, delete or wipe past conversations.

  Replaces `showHistoryModal()`, which built the whole dialog with
  `document.createElement` and eleven `style.cssText` strings, attached `onclick`
  properties directly to the nodes, and — to refresh after deleting one row —
  removed the overlay from `document.body` and called itself again.
-->
<script>
    let {
        sessions = [],
        activeId = null,
        onPick = null,
        onDelete = null,
        onClearAll = null,
        onClose = null,
    } = $props();

    const sorted = $derived([...sessions].sort((a, b) => b.timestamp - a.timestamp));
</script>

<div
    class="ch-overlay"
    role="button"
    tabindex="0"
    onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }}
>
    <div class="ch-modal" role="dialog" aria-label="Chat History">
        <div class="ch-head">
            <span>Chat History</span>
            <div class="ch-head-actions">
                <button type="button" class="ch-clear-all" title="Delete all history"
                    onclick={() => onClearAll?.()}>🗑 Clear All</button>
                <button type="button" class="ch-close" aria-label="Close"
                    onclick={() => onClose?.()}>✖</button>
            </div>
        </div>

        <div class="ch-body">
            {#if sorted.length === 0}
                <div class="ch-empty">No history found.</div>
            {:else}
                {#each sorted as s (s.id)}
                    <div class="ch-item" class:is-active={s.id === activeId}
                        role="button" tabindex="0"
                        onclick={() => onPick?.(s.id)}
                        onkeydown={(e) => { if (e.key === 'Enter') onPick?.(s.id); }}>
                        <div class="ch-title">{s.title}</div>
                        <div class="ch-when">{new Date(s.timestamp).toLocaleDateString()}</div>
                        <button type="button" class="ch-del" title="Delete this chat"
                            onclick={(e) => { e.stopPropagation(); onDelete?.(s.id, s.title); }}>🗑</button>
                    </div>
                {/each}
            {/if}
        </div>
    </div>
</div>

<style>
    .ch-overlay {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 3000;
        display: flex; justify-content: center; align-items: center;
    }
    .ch-modal {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        width: 400px; max-height: 80vh;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        color: var(--text-primary);
    }
    .ch-head {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
        display: flex; justify-content: space-between; align-items: center;
        background: var(--bg-tertiary);
        font-weight: bold;
    }
    .ch-head-actions { display: flex; align-items: center; gap: 10px; }
    .ch-clear-all {
        background: none;
        border: 1px solid var(--error, #c0392b);
        color: var(--error, #c0392b);
        cursor: pointer; font-size: 11px;
        border-radius: 4px; padding: 3px 8px; font-weight: 600;
    }
    .ch-close { background: none; border: none; color: var(--text-primary); cursor: pointer; font-size: 16px; }
    .ch-body {
        padding: 10px; overflow-y: auto; flex: 1;
        display: flex; flex-direction: column; gap: 8px;
    }
    .ch-empty { color: var(--text-secondary); text-align: center; padding: 20px; }
    .ch-item {
        padding: 10px; border-radius: 6px; cursor: pointer;
        background: var(--bg-tertiary); color: var(--text-primary);
        display: flex; justify-content: space-between; align-items: center;
        border: 1px solid var(--border);
    }
    .ch-item.is-active { background: var(--accent); color: var(--text-inverse); }
    .ch-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 13px; }
    .ch-when { font-size: 11px; opacity: 0.7; margin-left: 10px; }
    .ch-del { background: none; border: none; cursor: pointer; font-size: 13px; margin-left: 8px; opacity: 0.6; color: inherit; }
    .ch-del:hover { opacity: 1; }
</style>
