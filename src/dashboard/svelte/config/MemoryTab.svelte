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
    import { t } from '../../../i18n/index.js';

    import { cardSummary } from '../../../modules/ai/memory/CardStore.js';

    let {
        workspace = '',
        /** Approved projects, offered as suggestions. */
        projects = [],
        /** null until a workspace has been loaded — distinct from "loaded, empty". */
        facts = null,
        episodes = null,
        /** Experience cards: lessons (what failed) and insights (what worked). */
        cards = null,
        onWorkspaceChange = null,
        onBrowse = null,
        onLoad = null,
        /** Kick off a structural study of the workspace. */
        onStudy = null,
        studying = false,
        studyStatus = '',
        /** { files, symbols, edges, coverage[] } from the structural index. */
        indexStats = null,
        /** compareArms() output + `rows` — the recall-on vs recall-off comparison. */
        abStats = null,
        /** { text, generatedAt } — the generated orientation note. */
        overview = null,
        onSaveOverview = null,
        onEditFact = null,
        onDeleteFact = null,
        onClearFacts = null,
        onDeleteEpisode = null,
        onClearEpisodes = null,
        onToggleCard = null,
        onDeleteCard = null,
        onClearCards = null,
    } = $props();

    const loaded = $derived(Array.isArray(facts) || Array.isArray(episodes) || Array.isArray(cards));
    const factList = $derived(Array.isArray(facts) ? facts : []);
    const episodeList = $derived(Array.isArray(episodes) ? episodes : []);
    const cardList = $derived(Array.isArray(cards) ? cards : []);

    /** A fact with no `type` predates the layer split — it reads as semantic. */
    const factType = (f) => f.type || 'semantic';

    // ── A/B readout ──────────────────────────────────────────────────────
    // Deliberately shows how far the measurement is from being readable, not
    // just its current numbers. The first thing anyone wants from a comparison
    // is a verdict, and the honest state for most of its life is "not yet" —
    // hiding that is how a delta from six runs gets treated as a result.
    const num1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—');
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
    const signed = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—');
    /** Runs collected against runs required, clamped for the bar's width. */
    const abProgress = $derived(() => {
        const need = abStats?.needed?.perArm;
        if (!need) return null;
        const have = Math.min(abStats.on?.runs || 0, abStats.off?.runs || 0);
        return { have, need, pctDone: Math.min(100, Math.round(have / need * 100)) };
    });

    const OUTCOME = { success: '✅', error: '❌' };
    const outcomeIcon = (o) => OUTCOME[o] || '⚠️';

    /** The orientation note, editable because it is the one memory that is a GUESS. */
    let editingOverview = $state(false);
    let overviewDraft = $state('');
    const startOverviewEdit = () => {
        overviewDraft = String(overview?.text || '');
        editingOverview = true;
    };
    const commitOverview = () => {
        onSaveOverview?.(overviewDraft);
        editingOverview = false;
    };

    /** Which row is being edited, and its draft. In-place, not a window.prompt(). */
    let editingIdx = $state(-1);
    let draft = $state('');

    /**
     * Collapsible sections. Open by default, so the change is a refinement
     * rather than a regression: a closed card hides its table, an empty card
     * hides its "nothing here" line.
     */
    let openSections = $state({ facts: true, cards: true, episodes: true });
    const toggleSection = (key) => { openSections[key] = !openSections[key]; };

    const startEdit = (i, fact) => { editingIdx = i; draft = String(fact || ''); };
    const commitEdit = () => {
        const t = draft.trim();
        if (t) onEditFact?.(editingIdx, t);
        editingIdx = -1;
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head-plain">
        <h3>{@html icon('memory')} {t('memory.title')}</h3>
        <p class="subtitle">{t('memory.subtitle')}</p>
    </div>
    <div class="provider-card-fields">
        <div class="input-group">
            <label class="input-label" for="memory-ws-input"
                >{t('memory.workspace', { path: '<workspace>/.agent/' })}</label>
            <div class="cfg-row-inline">
                <input id="memory-ws-input" class="input cfg-grow" type="text" value={workspace}
                    list="memory-ws-list" placeholder={'C:\\path\\to\\workspace'}
                    oninput={(e) => onWorkspaceChange?.(e.currentTarget.value)}>
                <datalist id="memory-ws-list">
                    {#each projects as p (p)}<option value={p}></option>{/each}
                </datalist>
                <button class="btn btn-secondary" id="btn-memory-ws-browse" type="button"
                    title={t('memory.browse')}
                    onclick={() => onBrowse?.()}>{@html icon('folder', 13)}</button>
                <button class="btn btn-primary" id="btn-memory-load" type="button"
                    onclick={() => onLoad?.()}>{t('memory.load')}</button>
            </div>
            <!-- Study is how the agent learns a project it has not worked in yet.
                 Experience only records where it happened to walk, so a workspace
                 it has never run in has a memory of nothing at all. -->
            <div class="cfg-mem-study">
                <button class="btn btn-secondary cfg-btn-sm" id="btn-memory-study" type="button"
                    disabled={studying} onclick={() => onStudy?.()}>
                    {@html icon('brain', 13)} {studying ? t('memory.study.running') : t('memory.study')}
                </button>
                <span class="cfg-hint">{studyStatus || t('memory.study.hint')}</span>
            </div>
            <!-- What the index HAS, and by omission what it has not. An area with
                 no rows is one where every answer the agent gives is a guess, and
                 that is worth seeing before trusting one. -->
            {#if indexStats?.files}
                <div class="cfg-mem-cov">
                    <div class="cfg-mem-cov-h">
                        {t('memory.index.summary', {
                            files: indexStats.files, symbols: indexStats.symbols, edges: indexStats.edges,
                        })}
                    </div>
                    {#each indexStats.coverage || [] as c (c.dir)}
                        <div class="cfg-mem-cov-row">
                            <span class="d">{c.dir}</span>
                            <span class="b"><i style={`width:${Math.max(3, Math.round(c.files / indexStats.coverage[0].files * 100))}%`}></i></span>
                            <span class="n">{c.files}</span>
                        </div>
                    {/each}
                    <!-- What the index does NOT have: an area with no rows is one
                         where the agent answers by guessing. Say that out loud so
                         the panel reads as a trust meter, not a metric. -->
                    <div class="cfg-hint cfg-mem-guess">{t('memory.index.guessHint')}</div>
                </div>
            {/if}

            <!-- Is the memory helping? The rows come from every run; this is the
                 only place they are read. Progress toward a readable answer is
                 shown alongside the numbers because for most of the collection
                 period the numbers should NOT be acted on. -->
            {#if abStats?.rows}
                <div class="cfg-mem-ab">
                    <div class="cfg-mem-cov-h">
                        {t('memory.ab.arms', {
                            rows: abStats.rows, on: abStats.on?.runs || 0, off: abStats.off?.runs || 0,
                        })}
                    </div>
                    {#if abProgress()}
                        <div class="cfg-mem-cov-row">
                            <span class="d">{t('memory.ab.progress')}</span>
                            <span class="b"><i style={`width:${Math.max(2, abProgress().pctDone)}%`}></i></span>
                            <span class="n">{abProgress().have}/{abProgress().need}</span>
                        </div>
                        <div class="cfg-mem-summary">
                            {t('memory.ab.need', {
                                mean: num1(abStats.needed.mean), sd: num1(abStats.needed.sd),
                                perArm: abStats.needed.perArm,
                            })}
                        </div>
                    {/if}
                    {#if abStats.comparable}
                        <div class="cfg-mem-ab-grid">
                            <span>{t('memory.ab.exploration')}</span>
                            <span>{num1(abStats.on?.explorationCost)} / {num1(abStats.off?.explorationCost)}</span>
                            <span class:good={abStats.delta?.explorationCost < 0}>{signed(abStats.delta?.explorationCost)}</span>
                            <span>{t('memory.ab.iterations')}</span>
                            <span>{num1(abStats.on?.iterations)} / {num1(abStats.off?.iterations)}</span>
                            <span class:good={abStats.delta?.iterations < 0}>{signed(abStats.delta?.iterations)}</span>
                            <span>{t('memory.ab.follow')}</span>
                            <span>{pct(abStats.followThrough?.on?.rate)} / {pct(abStats.followThrough?.baseline?.rate)}</span>
                            <span class:good={abStats.followThrough?.lift > 0}>
                                {abStats.followThrough?.lift === null || abStats.followThrough?.lift === undefined
                                    ? '—' : pct(abStats.followThrough.lift)}
                            </span>
                        </div>
                        <div class="cfg-mem-summary">{t('memory.ab.legend')}</div>
                    {:else}
                        <div class="cfg-mem-summary">{t('memory.ab.oneArm')}</div>
                    {/if}
                </div>
            {/if}

            <!-- The orientation note. Shown and editable because it is the ONLY
                 memory here that is inferred rather than observed: it rides in
                 every prompt, so a wrong sentence in it is repeated on every
                 step until someone corrects it. -->
            {#if overview?.text || editingOverview}
                <div class="cfg-mem-box cfg-mem-ov">
                    <div class="cfg-mem-head">
                        <div class="cfg-mem-title">
                            {@html icon('brain', 13)} {t('memory.overview')}
                        </div>
                        {#if editingOverview}
                            <button class="btn btn-primary cfg-btn-tiny" id="btn-memory-ov-save"
                                onclick={commitOverview}>{t('memory.overview.save')}</button>
                        {:else}
                            <button class="btn btn-secondary cfg-btn-tiny" id="btn-memory-ov-edit"
                                onclick={startOverviewEdit}>{@html icon('edit', 12)} {t('memory.edit')}</button>
                        {/if}
                    </div>
                    {#if editingOverview}
                        <!-- Shown only while editing. The generator can count
                             naming rules off the file listing, but the things
                             worth adding by hand — terminology, boundaries that
                             are policy rather than structure — are invisible to
                             it, and nothing here said so. -->
                        <div class="cfg-mem-summary">{@html t('memory.overview.editHint')}</div>
                        <textarea class="input cfg-mem-ov-edit" rows="10" bind:value={overviewDraft}></textarea>
                    {:else}
                        <pre class="cfg-mem-ov-text">{overview.text}</pre>
                        {#if overview.generatedAt}
                            <div class="cfg-mem-summary">
                                {t('memory.overview.generated', { at: String(overview.generatedAt).slice(0, 10) })}
                            </div>
                        {/if}
                    {/if}
                </div>
            {/if}
        </div>

        {#if !loaded}
            <div class="cfg-mem-hint">{t('memory.selectHint')}</div>
        {:else}
            <div class="cfg-mem-box">
                <div class="cfg-mem-head cfg-mem-collapsible" role="button" tabindex="0"
                    onclick={() => toggleSection('facts')}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('facts'); } }}>
                    <div class="cfg-mem-title">
                        <span class="cfg-mem-chevron">{openSections.facts ? '▾' : '▸'}</span>
                        {@html icon('memory', 13)} {t('memory.facts', { count: factList.length })}
                    </div>
                    <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger"
                        id="btn-memory-facts-clear" onclick={(e) => { e.stopPropagation(); onClearFacts?.(); }}>
                        {@html icon('trash', 12)} {t('memory.clearAll')}</button>
                </div>
                {#if openSections.facts}
                {#if !factList.length}
                    <div class="cfg-mem-empty">{t('memory.facts.empty')}</div>
                {:else}
                    <div class="cfg-mem-scroll" id="memory-facts-list">
                        <table class="rv-table cfg-mem-table">
                            <thead><tr>
                                <th class="cfg-mem-th">{t('memory.facts.col')}</th>
                                <th>{t('memory.col.date')}</th><th>{t('memory.col.hits')}</th><th></th>
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
                                            {:else}
                                                <!-- Which layer this fact reached: an episodic one is
                                                     still on probation and is pruned first. -->
                                                <span class="cfg-mem-badge is-{factType(f)}">{factType(f)}</span>
                                                {f.fact || ''}
                                            {/if}
                                        </td>
                                        <td class="cfg-mem-meta">{f.date || ''}</td>
                                        <td class="cfg-mem-hits">{f.hits || 1}</td>
                                        <td class="cfg-mem-acts">
                                            {#if editingIdx === i}
                                                <button class="btn btn-secondary cfg-btn-tiny"
                                                    onclick={commitEdit}>{t('common.save')}</button>
                                                <button class="btn btn-secondary cfg-btn-tiny"
                                                    onclick={() => (editingIdx = -1)}>{t('common.cancel')}</button>
                                            {:else}
                                                <button class="btn btn-secondary cfg-btn-tiny memory-fact-edit"
                                                    data-idx={i} title={t('memory.edit')}
                                                    onclick={() => startEdit(i, f.fact)}
                                                >{@html icon('edit', 12)}</button>
                                                <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger memory-fact-del"
                                                    data-idx={i} title={t('common.delete')}
                                                    onclick={() => onDeleteFact?.(i)}
                                                >{@html icon('trash', 12)}</button>
                                            {/if}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
                {/if}
            </div>

            <!-- Experience cards. The switch is the point: a wrong lesson that the
                 user cannot turn off is exactly how a memory poisons an agent. -->
            <div class="cfg-mem-box">
                <div class="cfg-mem-head cfg-mem-collapsible" role="button" tabindex="0"
                    onclick={() => toggleSection('cards')}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('cards'); } }}>
                    <div class="cfg-mem-title">
                        <span class="cfg-mem-chevron">{openSections.cards ? '▾' : '▸'}</span>
                        {@html icon('brain', 13)} {t('memory.cards', { count: cardList.length })}
                    </div>
                    <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger"
                        id="btn-memory-cards-clear" onclick={(e) => { e.stopPropagation(); onClearCards?.(); }}>
                        {@html icon('trash', 12)} {t('memory.clearAll')}</button>
                </div>
                {#if openSections.cards}
                {#if !cardList.length}
                    <div class="cfg-mem-empty">{t('memory.cards.empty')}</div>
                {:else}
                    <div class="cfg-mem-scroll" id="memory-cards-list">
                        <table class="rv-table cfg-mem-table">
                            <thead><tr>
                                <th class="cfg-mem-th">{t('memory.cards.col')}</th>
                                <th>{t('memory.col.cost')}</th><th>{t('memory.col.hits')}</th>
                                <th>{t('memory.col.use')}</th><th></th>
                            </tr></thead>
                            <tbody>
                                {#each cardList as c, i (c.id || i)}
                                    {@const s = cardSummary(c)}
                                    <tr class:is-off={c.disabled}>
                                        <td class="cfg-mem-fact">
                                            <span class="cfg-mem-badge is-{s.badge}">{s.badge}</span>
                                            {s.headline}
                                            <div class="cfg-mem-summary">{s.detail}</div>
                                        </td>
                                        <td class="cfg-mem-hits">{c.costSteps ?? '—'}</td>
                                        <td class="cfg-mem-hits">{c.hits || 1}</td>
                                        <td class="cfg-mem-acts">
                                            <label class="cfg-mem-toggle">
                                                <input type="checkbox" class="memory-card-toggle"
                                                    checked={!c.disabled} data-idx={i}
                                                    onchange={(e) => onToggleCard?.(i, !e.currentTarget.checked)}>
                                            </label>
                                        </td>
                                        <td class="cfg-mem-acts">
                                            <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger memory-card-del"
                                                data-idx={i} title={t('common.delete')}
                                                onclick={() => onDeleteCard?.(i)}
                                            >{@html icon('trash', 12)}</button>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
                {/if}
            </div>

            <div class="cfg-mem-box">
                <div class="cfg-mem-head cfg-mem-collapsible" role="button" tabindex="0"
                    onclick={() => toggleSection('episodes')}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('episodes'); } }}>
                    <div class="cfg-mem-title">
                        <span class="cfg-mem-chevron">{openSections.episodes ? '▾' : '▸'}</span>
                        {@html icon('history', 13)} {t('memory.episodes', { count: episodeList.length })}
                    </div>
                    <button class="btn btn-secondary cfg-btn-tiny cfg-btn-danger"
                        id="btn-memory-episodes-clear" onclick={(e) => { e.stopPropagation(); onClearEpisodes?.(); }}>
                        {@html icon('trash', 12)} {t('memory.clearAll')}</button>
                </div>
                {#if openSections.episodes}
                {#if !episodeList.length}
                    <div class="cfg-mem-empty">{t('memory.episodes.empty')}</div>
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
                                                data-idx={i} title={t('common.delete')}
                                                onclick={() => onDeleteEpisode?.(i)}
                                            >{@html icon('trash', 12)}</button>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
                {/if}
            </div>
        {/if}
    </div>
</div>
