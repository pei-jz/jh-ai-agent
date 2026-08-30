<!--
  ApiCallModal — what was actually sent to the provider, and what came back.

  Replaces MonitorView._setupChatModal + _showChatModal: a 145-line <style> block
  injected into document.head, an overlay appended to document.body and shown by
  toggling a class, and a 195-line render that built every entry as one innerHTML
  string and then re-queried its own output to bind a listener per sub-tab and per
  copy button. The active sub-tab was `style.display` written across those
  handlers, so which tab was open lived only in the DOM.

  What the tabs contain is monitor/apiCallView.js.
-->
<script>
    import { apiCallTabs, callHeadline, callsTitle, slimEntries } from '../../views/monitor/apiCallView.js';

    let {
        entries = [],
        taskId = null,
        api = null,
        onClose = null,
    } = $props();

    const client = () => api ?? window.apiClient;

    /** The entries actually rendered — replaced once the full payloads land. */
    let rows = $state([]);
    let loading = $state(false);
    /** Which sub-tab is open, per entry. Index into that entry's own tab list. */
    let openTab = $state([]);
    let copied = $state(-1);

    // The title totals the RAW entries — `rows` are their built form, whose
    // usage/duration live one level down on `.entry`.
    const title = $derived(callsTitle(rows.map(r => r.entry)));

    function build(list) {
        // Both assignments come from the same LOCAL. Deriving openTab from `rows`
        // after assigning it would make this a read of the state the effect below
        // just wrote — a self-retriggering loop.
        const next = list.map((e) => ({ entry: e, head: callHeadline(e), ...apiCallTabs(e) }));
        rows = next;
        openTab = next.map(r => r.defaultIndex);
    }

    $effect(() => {
        const list = Array.isArray(entries) ? entries : [];
        build(list);

        const slim = slimEntries(list);
        if (!slim.length || !taskId) return;
        let alive = true;
        loading = true;
        (async () => {
            // Listing and replay strip history / system_prompt / sent_request /
            // tools from every entry, because keeping them makes the payload
            // O(steps²). They are fetched here, for the calls actually opened.
            // A failure degrades to the slim view rather than an empty dialog.
            try {
                await Promise.all(slim.map(async (en) => {
                    const full = await client()?.getTaskLogEntry?.(taskId, en._idx);
                    if (full?.data?.request) {
                        en.request = full.data.request;
                        if (full.data.response !== undefined) en.response = full.data.response;
                    }
                }));
            } catch (_) { /* keep what we have */ }
            if (!alive) return;
            build(list);
            loading = false;
        })();
        return () => { alive = false; };
    });

    async function copy(i) {
        const row = rows[i];
        const text = row?.tabs[openTab[i]]?.content ?? '';
        try {
            await navigator.clipboard.writeText(text);
            copied = i;
            setTimeout(() => { if (copied === i) copied = -1; }, 1500);
        } catch (_) { /* clipboard blocked */ }
    }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }} />

<div
    id="mchat-modal-overlay"
    class="mchat-overlay"
    role="button"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }}
>
    <div class="mchat-box" role="dialog" aria-label="API Call Details">
        <div class="mchat-header">
            <span class="mchat-title">{title}{loading ? ' · loading…' : ''}</span>
            <button class="mchat-close" type="button" title="Close (Esc)" onclick={() => onClose?.()}>✕</button>
        </div>

        <div class="mchat-body">
            {#if !rows.length}
                <div class="mchat-empty">No API calls recorded for this step.</div>
            {/if}
            {#each rows as row, i (i)}
                <div class="mchat-entry">
                    <div class="mchat-entry-meta">
                        <span class="mlog-tele-method">{row.head.method}</span>
                        <span class={row.head.isError ? 'mlog-tele-status-err' : 'mlog-tele-status-ok'}>
                            {row.head.status}
                        </span>
                        {#if row.head.stepLabel}<span class="mchat-steplabel">{row.head.stepLabel}</span>{/if}
                        {#if row.head.duration}<span class="mlog-tele-dur">{row.head.duration}ms</span>{/if}
                        {#if row.head.usage}<span class="mchat-usage">{row.head.usage}</span>{/if}
                    </div>

                    <div class="mchat-subtabs">
                        {#each row.tabs as t, ti (t.key)}
                            <button class="mchat-subtab" class:active={ti === openTab[i]}
                                type="button" data-key={t.key}
                                onclick={() => (openTab[i] = ti)}>{t.label}</button>
                        {/each}
                        <button class="mchat-copy" type="button" title="Copy the visible tab"
                            onclick={() => copy(i)}>{copied === i ? '✓ Copied' : '📋 Copy'}</button>
                    </div>

                    <pre class="mchat-pre">{row.tabs[openTab[i]]?.content ?? ''}</pre>
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .mchat-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.72);
        display: flex; align-items: center; justify-content: center;
    }
    .mchat-box {
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-3);
        width: min(92vw, 880px);
        max-height: 82vh;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    }
    .mchat-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 16px; flex-shrink: 0;
        background: var(--surface-sunken);
        border-bottom: 1px solid var(--line);
    }
    .mchat-title {
        font-size: 12.5px; font-weight: 600;
        color: var(--ink); font-family: var(--font-mono);
    }
    .mchat-close {
        background: none; border: none; color: var(--ink-faint);
        cursor: pointer; font-size: 16px; padding: 2px 6px;
        border-radius: var(--r-2); line-height: 1;
        transition: background 0.12s, color 0.12s;
    }
    .mchat-close:hover { background: var(--surface-hover); color: var(--ink); }

    .mchat-body { flex: 1; overflow-y: auto; padding: 0; }
    .mchat-empty { padding: 24px 18px; font-size: 12px; color: var(--ink-faint); }

    .mchat-entry { padding: 14px 18px; }
    .mchat-entry + .mchat-entry { border-top: 1px solid var(--line-soft); }
    .mchat-entry-meta {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 12px; padding-bottom: 10px;
        border-bottom: 1px solid var(--line-soft);
        font-family: var(--font-mono);
    }
    .mchat-usage { margin-left: auto; font-size: 11px; color: var(--ink-soft); }
    .mchat-steplabel { font-size: 10.5px; color: var(--accent); font-weight: 600; }

    .mchat-subtabs {
        display: flex; gap: 4px; flex-wrap: wrap;
        margin: 4px 0 8px; padding-bottom: 6px;
        border-bottom: 1px solid var(--line-soft);
    }
    .mchat-subtab {
        padding: 4px 10px;
        border: 1px solid var(--line);
        background: var(--surface-sunken);
        color: var(--ink-soft);
        font-size: 11px; border-radius: var(--r-2);
        cursor: pointer; white-space: nowrap;
    }
    .mchat-subtab:hover { background: var(--surface-hover); color: var(--ink); }
    .mchat-subtab.active { background: var(--surface-app); color: var(--accent); border-color: var(--accent); }
    .mchat-copy {
        margin-left: auto;
        background: var(--surface-sunken); border: 1px solid var(--line);
        color: var(--ink-soft); font-size: 11px;
        padding: 2px 8px; border-radius: var(--r-2); cursor: pointer;
    }

    .mchat-pre {
        margin: 0; padding: 10px 12px;
        background: var(--surface-app);
        border: 1px solid var(--line-soft);
        border-radius: var(--r-2);
        font-size: 10.5px; font-family: var(--font-mono);
        color: var(--ink-soft);
        white-space: pre-wrap; word-break: break-word;
        max-height: 300px; overflow-y: auto; line-height: 1.5;
    }
</style>
