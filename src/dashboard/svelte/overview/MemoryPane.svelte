<!--
  MemoryPane — what the agent has learned about this workspace, and whether it
  is working.

  The knowledge digest is the DEFAULT body, not search results. The panel used to
  show a search box and nothing else, so a workspace with 14 facts and no cards
  rendered the number 14 and none of the facts. Reviewing what the agent believes
  is the reason to open this panel; search is the filter, not the entrance.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { t } from '../../../i18n/index.js';
    import {
        memoryLayers, memoryHealth, searchMemory, knowledgeDigest, HALF_LIFE_DAYS,
    } from '../../views/overview/memoryPanel.js';
    import { baseName } from '../../views/overview/overviewModel.js';
    import MemoryRow from './MemoryRow.svelte';

    let {
        memory = null,
        workspace = '',
        error = '',
        knownWorkspaces = [],
        seenAt = 0,
        onWorkspace = null,
        onToggleCard = null,
    } = $props();

    let query = $state('');

    const layers = $derived(memory ? memoryLayers(memory) : null);
    const health = $derived(memory ? memoryHealth(memory.cards) : null);
    const results = $derived(memory && query ? searchMemory(memory, query) : []);
    const digest = $derived(memory ? knowledgeDigest(memory, { sinceMs: seenAt }) : null);
    const empty = $derived(layers && !layers.totalCards && !layers.totalFacts && !layers.episodes);

    const pctOf = (n) => (health?.shown ? n / health.shown * 100 : 0);
    const newCount = $derived(digest ? digest.recent.filter(r => r.isNew).length : 0);
</script>

{#if !memory}
    <div class="dash-empty"><p>Loading memory…</p></div>
{:else if !workspace}
    <div class="dash-empty">
        <div class="dash-empty-ico">{@html icon('memory', 28)}</div>
        <h3>No workspace yet</h3>
        <p>Memory is stored per workspace, under <code>.agent/</code>. Run a task in one and
           what it learns will show up here.</p>
    </div>
{:else if error}
    <div class="dash-empty">
        <h3>Could not read memory</h3>
        <p>{error}</p>
    </div>
{:else if empty}
    <div class="dash-empty">
        <div class="dash-empty-ico">{@html icon('memory', 28)}</div>
        <h3>Nothing learned yet</h3>
        <p>Cards appear after runs that hit a problem, or that found something worth
           reusing. Facts appear when a run states a rule about this project.</p>
    </div>
{:else}
    <div class="dm">
        <div class="dm-layers">
            <div><span class="k">DURABLE</span><span class="v">{layers.durable}</span><span class="s">facts</span></div>
            <div><span class="k">EPISODIC</span><span class="v">{layers.episodic}</span><span class="s">on probation</span></div>
            <div><span class="k">LESSONS</span><span class="v">{layers.lessons}</span><span class="s">what failed</span></div>
            <div><span class="k">INSIGHTS</span><span class="v">{layers.insights}</span><span class="s">what worked</span></div>
            <div><span class="k">EPISODES</span><span class="v">{layers.episodes}</span><span class="s">sessions kept</span></div>
        </div>

        <!--
          "Is it working?" — deliberately NOT the cards' own `confidence`: that is
          the agent's estimate of itself, and a useless lesson is just as confident
          as a good one. This is measured after the fact.
        -->
        {#if health?.total}
            <div class="dm-box">
                <div class="dm-h">
                    {@html icon('shield', 13)} Is it working?
                    {#if health.shown}
                        <span class="more">{health.shown} of {health.total} used · half-life {HALF_LIFE_DAYS}d</span>
                    {/if}
                </div>
                {#if !health.shown}
                    <p class="dm-note">{health.total} card{health.total === 1 ? '' : 's'} stored,
                       none surfaced to a run yet — so there is nothing to judge yet.
                       This fills in as they get used.</p>
                {:else}
                    <div class="dm-bar">
                        <i style="width:{pctOf(health.held)}%;background:var(--success)"></i>
                        <i style="width:{pctOf(health.partial)}%;background:var(--warning)"></i>
                        <i style="width:{pctOf(health.failing)}%;background:var(--error)"></i>
                    </div>
                    <div class="dm-lg">
                        <span><i class="dm-sw" style="background:var(--success)"></i><b>{health.held}</b> held — failure stopped</span>
                        {#if health.partial}<span><i class="dm-sw" style="background:var(--warning)"></i>{health.partial} partial</span>{/if}
                        {#if health.failing}<span><i class="dm-sw" style="background:var(--error)"></i>{health.failing} still recurring</span>{/if}
                    </div>
                    {#if health.failingCards.length}
                        <div class="dm-fail">
                            <div class="dm-fail-t">Not earning their place</div>
                            {#each health.failingCards as f}
                                <div class="dm-frow">
                                    <span class="drow-dot dot-failed"></span>
                                    <span class="grow" title={f.detail}>{f.headline}</span>
                                    <span class="dm-rate">{f.rate.toFixed(2)}</span>
                                    <label class="dm-toggle" title="Switch this card off">
                                        <input type="checkbox" checked
                                            onchange={(e) => onToggleCard?.(f.card.id, !e.currentTarget.checked)}>
                                        <i></i>
                                    </label>
                                </div>
                            {/each}
                        </div>
                    {/if}
                {/if}
            </div>
        {/if}

        <div class="dm-search">
            {@html icon('search', 13)}
            <input type="text" bind:value={query}
                placeholder={t('dash.mem.searchHint')} aria-label={t('dash.mem.searchHint')}>
            <span class="sc">{layers.totalCards} cards · {layers.totalFacts} facts</span>
        </div>

        <!--
          One-click switches to a workspace the agent already knows. A list of
          paths is reference material, not a form: chips are easier to scan and
          click than a datalist, and the current one is visibly marked.
        -->
        {#if knownWorkspaces.length > 1}
            <div class="dm-wschips">
                {#each knownWorkspaces as ws}
                    <button type="button" class="dm-wschip" class:is-on={ws === workspace}
                        title={ws} onclick={() => onWorkspace?.(ws)}>{baseName(ws)}</button>
                {/each}
            </div>
        {/if}

        {#if query}
            <div class="dm-box dm-results">
                {#if results.length}
                    {#each results as r}<MemoryRow row={r} plain {onToggleCard} />{/each}
                {:else}
                    <p class="dm-note">Nothing matches “{query}”.</p>
                {/if}
            </div>
        {:else if digest}
            {#each [
                { ico: 'shield', title: t('dash.mem.rules'), rows: digest.rules, note: t('dash.mem.rules.note') },
                { ico: 'sparkle', title: t('dash.mem.recent'), rows: digest.recent,
                  note: newCount ? t('dash.mem.recent.note', { count: newCount }) : '' },
                { ico: 'alert', title: t('dash.mem.lessons'), rows: digest.lessons, note: t('dash.mem.lessons.note') },
            ] as sec}
                {#if sec.rows.length}
                    <div class="dm-box">
                        <div class="dm-h">
                            {@html icon(sec.ico, 13)} {sec.title}
                            <span class="badge">{sec.rows.length}</span>
                            {#if sec.note}<span class="dm-note-inline">{sec.note}</span>{/if}
                            <a class="more" href="#config?tab=memory">Settings → Memory →</a>
                        </div>
                        {#each sec.rows as r}<MemoryRow row={r} plain {onToggleCard} />{/each}
                    </div>
                {/if}
            {/each}

            <!-- Counts above but nothing below would read as a broken panel; say why. -->
            {#if !digest.rules.length && !digest.recent.length && !digest.lessons.length}
                <p class="dm-note">{t('dash.mem.nothingToShow')}</p>
            {/if}
        {/if}
    </div>
{/if}
