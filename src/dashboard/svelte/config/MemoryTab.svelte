<!--
  MemoryTab — view, edit and delete the agent's long-term memory.

  `facts.json` (durable facts injected into the system prompt) and `memory.json`
  (episodic session summaries) live under `<workspace>/.agent/`. This tab exists so a
  wrong or stale memory can be corrected — the agent otherwise keeps asserting it.

  Region 5. Editing a fact used to go through `window.prompt()`, because the row was a
  string in an innerHTML blob with nowhere to put an input. It edits in place here.
-->
<script>
    import { icon } from '../../utils/icons.js';

    let {
        workspace = '',
        /** Approved projects, offered as suggestions. */
        projects = [],
        /** null until a workspace has been loaded — distinct from "loaded, empty". */
        facts = null,
        episodes = null,
        onWorkspaceChange = null,
        onBrowse = null,
        onLoad = null,
        onEditFact = null,
        onDeleteFact = null,
        onClearFacts = null,
        onDeleteEpisode = null,
        onClearEpisodes = null,
    } = $props();

    const loaded = $derived(Array.isArray(facts) || Array.isArray(episodes));
    const factList = $derived(Array.isArray(facts) ? facts : []);
    const episodeList = $derived(Array.isArray(episodes) ? episodes : []);

    const OUTCOME = { success: '✅', error: '❌' };
    const outcomeIcon = (o) => OUTCOME[o] || '⚠️';

    /** Which row is being edited, and its draft. In-place, not a window.prompt(). */
    let editingIdx = $state(-1);
    let draft = $state('');

    const startEdit = (i, fact) => { editingIdx = i; draft = String(fact || ''); };
    const commitEdit = () => {
        const t = draft.trim();
        if (t) onEditFact?.(editingIdx, t);
        editingIdx = -1;
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head-plain">
        <h3>{@html icon('memory')} Agent Memory</h3>
        <p class="subtitle">View, edit, and delete the agent's long-term memory
            (durable facts &amp; session history)</p>
    </div>
    <div class="provider-card-fields">
        <div class="input-group">
            <label class="input-label" for="memory-ws-input">Workspace (memory is stored per
                workspace: <code>&lt;workspace&gt;/.agent/</code>)</label>
            <div class="cfg-row-inline">
                <input id="memory-ws-input" class="input cfg-grow" type="text" value={workspace}
                    list="memory-ws-list" placeholder={'C:\\path\\to\\workspace'}
                    oninput={(e) => onWorkspaceChange?.(e.currentTarget.value)}>
                <datalist id="memory-ws-list">
                    {#each projects as p (p)}<option value={p}></option>{/each}
                </datalist>
                <button class="btn btn-secondary" id="btn-memory-ws-browse" type="button"
                    onclick={() => onBrowse?.()}>📁</button>
                <button class="btn btn-primary" id="btn-memory-load" type="button"
                    onclick={() => onLoad?.()}>Load</button>
            </div>
        </div>

        {#if !loaded}
            <div class="cfg-mem-hint">Select a workspace and press "Load" to show the stored memory.</div>
        {:else}
            <div class="cfg-mem-box">
                <div class="cfg-mem-head">
                    <div class="cfg-mem-title">
                        📌 Durable Facts (injected into the system prompt — {factList.length})
                    </div>
                    <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger"
                        id="btn-memory-facts-clear" onclick={() => onClearFacts?.()}>
                        {@html icon('trash', 12)} Clear All</button>
                </div>
                {#if !factList.length}
                    <div class="cfg-mem-empty">No facts stored yet.</div>
                {:else}
                    <div class="cfg-mem-scroll" id="memory-facts-list">
                        <table class="rv-table cfg-mem-table">
                            <thead><tr>
                                <th class="cfg-mem-th">Fact</th>
                                <th>Date</th><th>Hits</th><th></th>
                            </tr></thead>
                            <tbody>
                                {#each factList as f, i (i)}
                                    <tr>
                                        <td class="cfg-mem-fact">
                                            {#if editingIdx === i}
                                                <!-- In place. This was a window.prompt(). -->
                                                <input class="input cfg-mem-edit" type="text"
                                                    bind:value={draft}
                                                    onkeydown={(e) => {
                                                        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                                                        if (e.key === 'Escape') editingIdx = -1;
                                                    }}>
                                            {:else}{f.fact || ''}{/if}
                                        </td>
                                        <td class="cfg-mem-meta">{f.date || ''}</td>
                                        <td class="cfg-mem-hits">{f.hits || 1}</td>
                                        <td class="cfg-mem-acts">
                                            {#if editingIdx === i}
                                                <button class="btn btn-secondary cfg-btn-tiny"
                                                    onclick={commitEdit}>Save</button>
                                                <button class="btn btn-secondary cfg-btn-tiny"
                                                    onclick={() => (editingIdx = -1)}>Cancel</button>
                                            {:else}
                                                <button class="btn btn-secondary cfg-btn-tiny memory-fact-edit"
                                                    data-idx={i} onclick={() => startEdit(i, f.fact)}
                                                >{@html icon('edit', 12)}</button>
                                                <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger memory-fact-del"
                                                    data-idx={i} onclick={() => onDeleteFact?.(i)}
                                                >{@html icon('trash', 12)}</button>
                                            {/if}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </div>

            <div class="cfg-mem-box">
                <div class="cfg-mem-head">
                    <div class="cfg-mem-title">
                        📚 Episodes (summaries of past sessions — latest {episodeList.length})
                    </div>
                    <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger"
                        id="btn-memory-episodes-clear" onclick={() => onClearEpisodes?.()}>
                        {@html icon('trash', 12)} Clear All</button>
                </div>
                {#if !episodeList.length}
                    <div class="cfg-mem-empty">No session history yet.</div>
                {:else}
                    <div class="cfg-mem-scroll" id="memory-episodes-list">
                        <table class="rv-table cfg-mem-table">
                            <tbody>
                                {#each episodeList as e, i (i)}
                                    <tr>
                                        <td class="cfg-mem-meta">{e.date || ''}</td>
                                        <td class="cfg-mem-fact">
                                            {outcomeIcon(e.outcome)} <strong>{e.topic || ''}</strong>
                                            <div class="cfg-mem-summary">{e.summary || ''}</div>
                                        </td>
                                        <td class="cfg-mem-acts">
                                            <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger memory-episode-del"
                                                data-idx={i} onclick={() => onDeleteEpisode?.(i)}
                                            >{@html icon('trash', 12)}</button>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>
