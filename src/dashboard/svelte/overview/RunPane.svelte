<!--
  RunPane — what is happening right now.

  The step lines come from Monitor's own formatters via runFeed.js; only the
  compact shape is this view's. The full grouped timeline stays in Monitor, one
  click away, and this never tries to be it.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { phaseRail, runCost, runCostBreakdown } from '../../views/overview/runFeed.js';
    import {
        clip, short, money, shortModel, ago, elapsed, fmt,
    } from '../../views/overview/overviewModel.js';

    let {
        task = null,
        run = null,
        rates = {},
        now = Date.now(),
        onGoMemory = null,
    } = $props();

    const rail = $derived(run ? phaseRail(run) : []);
    const cost = $derived(run ? runCost(run, rates) : null);
    const breakdown = $derived(run ? runCostBreakdown(run, rates) : null);
    const tokens = $derived(run ? run.tokens.prompt + run.tokens.completion : 0);
    const pct = $derived(Math.round((task?.progress || 0) * 100));
</script>

{#if !task}
    <div class="dash-empty"><p>Nothing is running.</p></div>
{:else}
    <div class="dm">
        <div class="dm-h dm-h-run">
            <span class="drow-dot dot-running"></span>
            <span class="dm-run-prompt">{clip(task.prompt || '', 96)}</span>
            <a class="more" href="#monitor?id={encodeURIComponent(task.id)}">Open in Monitor →</a>
        </div>

        <div class="dm-layers dm-layers-4">
            <div><span class="k">STEP</span><span class="v">{run?.step || '—'}</span>
                <span class="s">{pct}% of plan</span></div>
            <div><span class="k">ELAPSED</span><span class="v">{elapsed(task.started_at, now)}</span>
                <span class="s">since {ago(task.started_at, now)}</span></div>
            <div><span class="k">TOKENS</span><span class="v">{short(tokens)}</span>
                <span class="s">{short(run?.tokens.cacheRead || 0)} cached</span></div>
            <div><span class="k">COST SO FAR</span><span class="v">{cost === null ? '—' : money(cost)}</span>
                <span class="s">{cost === null ? 'no $/1M rates set' : 'at your rates'}</span></div>
        </div>

        {#if rail.length}
            <div class="dp-rail">
                {#each rail as p}
                    <div class="dp-ph is-{p.state}">
                        <span class="n">{p.phase.toUpperCase()}{p.state === 'now' ? ' · now' : ''}</span>
                        <span class="m">{p.model ? shortModel(p.model) : '—'}{p.tokens ? ` · ${short(p.tokens)}` : ''}</span>
                    </div>
                {/each}
            </div>
            {#if run?.escalated}
                <p class="dm-note dm-note-pad">Execution was promoted to the deep tier — this run was
                    long enough that the cheap model was struggling.</p>
            {/if}
        {/if}

        {#if breakdown?.rows?.length}
            <div class="dm-box">
                <div class="dm-h">Model usage</div>
                <table class="ds-tbl">
                    <thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead>
                    <tbody>
                        {#each breakdown.rows as r}
                            <tr class:is-est={!r.priced}>
                                <td title={r.model}>{clip(r.label, 28)}</td>
                                <td title="{fmt(r.tokens)} total · {fmt(r.prompt)} in · {fmt(r.completion)} out">{short(r.tokens)}</td>
                                <td>{r.cost === null ? '—' : money(r.cost)}{#if !r.priced}<span class="ds-est">≈</span>{/if}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}

        {#if run?.switches?.length}
            <div class="dm-box">
                <div class="dm-h">Model switches · why</div>
                {#each [...run.switches].reverse() as s}
                    <div class="dp-switch">
                        <span class="dp-switch-m">{shortModel(s.model)}</span>
                        {#if s.from}<span class="dp-switch-from">← {shortModel(s.from)}</span>{/if}
                        <span class="dp-switch-r">{s.reason}</span>
                    </div>
                {/each}
            </div>
        {/if}

        <!--
          "Memory in play" — the join between the two halves of this page. Seeing
          a lesson fire at step 12 and the same failure at step 13 is what makes a
          useless card visible at the moment it is being useless, which is when
          you would actually switch it off.
        -->
        {#if run?.recalls?.length}
            <div class="dp-inplay">
                <div class="dp-inplay-h">
                    {@html icon('memory', 12)} Memory in play · {run.recalls.length}
                    <button type="button" class="more" onclick={() => onGoMemory?.()}>Manage in Memory →</button>
                </div>
                {#each run.recalls as c}
                    <div class="dp-inplay-l">
                        <span class="at">{c.source === 'brief' ? 'brief' : `step ${c.at}`}</span>
                        <span><b>{c.type || 'card'}</b> {clip(c.recipe || c.headline || '', 90)}</span>
                    </div>
                {/each}
            </div>
        {/if}

        <div class="dm-box">
            <div class="dm-h">Live steps</div>
            <div class="dp-steps">
                {#if run?.steps?.length}
                    {#each run.steps as s, i}
                        <div class="dp-step is-{s.kind}" class:is-live={i === run.steps.length - 1}>
                            <span class="n">{s.n || ''}</span>
                            <span class="tx">{s.text}</span>
                        </div>
                    {/each}
                {:else}
                    <p class="dm-note">Waiting for the first step…</p>
                {/if}
            </div>
        </div>

        {#if run?.files?.size}
            <p class="dm-note dm-note-pad">{run.files.size} file{run.files.size === 1 ? '' : 's'} changed so far.</p>
        {/if}
    </div>
{/if}

<style>
    /* Moved out of the inline style="" attributes the string builder carried. */
    .dm-h-run { border-radius: var(--radius-sm); border: 1px solid var(--border-light); }
    .dm-run-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-layers-4 { grid-template-columns: repeat(4, 1fr); }
    .dm-note-pad { padding: 0 2px; }
</style>
