<!--
  StatsPane — token spend and cost under the current conditions.

  The conditions (period + status) are picked at the top and EVERY figure below
  obeys them: the KPI row, the breakdown bars and the task sample all describe
  the same set. That is what makes "how many tokens did the failures burn?" a
  filter change rather than arithmetic.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import {
        statsTasks, statsStatuses, aggregate, modelTokenRows, taskTokens,
        taskModelLine, statsKpis, spendOf, clip, short, money, shortModel, ago,
    } from '../../views/overview/overviewModel.js';

    let {
        tasks = [],
        rateFor,
        flatRate = 0,
        cut = 'month',
        range = 'all',
        status = 'all',
        now = Date.now(),
        onCut = null,
        onRange = null,
        onStatus = null,
    } = $props();

    const CUTS = [
        ['month', 'dash.stats.month'], ['week', 'dash.stats.week'], ['day', 'dash.stats.day'],
        ['model', 'dash.stats.model'], ['ws', 'dash.stats.ws'],
    ];
    const RANGES = [['all', 'dash.stats.all'], ['7d', 'dash.stats.last7d'], ['30d', 'dash.stats.last30d']];

    const shown = $derived(statsTasks(tasks, { range, status, now }));
    const statuses = $derived(statsStatuses(tasks, status));
    const agg = $derived(shown.length ? aggregate(shown, cut, { rateFor, flatRate, now }) : { rows: [] });
    const kpi = $derived(shown.length ? statsKpis(shown, { rateFor, flatRate }) : null);
    const modelTok = $derived(shown.length ? modelTokenRows(shown) : { rows: [], anyCache: false });
    const maxCost = $derived(Math.max(1, ...agg.rows.map(r => r.cost)));
    const sample = $derived([...shown]
        .sort((a, b) => (b.completed_at || b.started_at || '').localeCompare(a.completed_at || a.started_at || ''))
        .slice(0, 8));
    const cutLabel = $derived(t(CUTS.find(c => c[0] === cut)?.[1] || cut));
</script>

{#if !tasks.length}
    <div class="dash-empty"><p>No tasks yet — run something and the usage breakdown will appear here.</p></div>
{:else if !shown.length}
    <div class="dash-empty">
        <p>{status !== 'all' && range !== 'all'
            ? `No ${status} tasks in this period — change the conditions above.`
            : 'No tasks match these conditions — change them above.'}</p>
    </div>
{:else}
    <div class="dm">
        <div class="dm-layers dm-layers-4">
            <div><span class="k">TASKS</span><span class="v">{kpi.count}</span>
                <span class="s">{status === 'all' ? 'all statuses' : status}</span></div>
            <div><span class="k">SUCCESS</span><span class="v">{kpi.successRate === null ? '—' : kpi.successRate + '%'}</span>
                <span class="s">{kpi.done} done / {kpi.failed} failed</span></div>
            <div><span class="k">COST</span><span class="v">{money(kpi.totalCost)}</span>
                <span class="s">≈ {money(kpi.avgCost)} / task</span></div>
            <div><span class="k">TOKENS</span><span class="v">{short(kpi.tokens)}</span>
                <span class="s">≈ {short(kpi.avgTokens)} / task</span></div>
        </div>

        <div class="ds-st-toolbar">
            {#each RANGES as [key, label]}
                <button type="button" class="ds-st-cut" class:is-on={range === key}
                    onclick={() => onRange?.(key)}>{t(label)}</button>
            {/each}
            <span class="ds-st-sep"></span>
            {#each statuses as s}
                <button type="button" class="ds-st-cut" class:is-on={status === s}
                    onclick={() => onStatus?.(s)}>{s}</button>
            {/each}
        </div>

        <div class="dm-box">
            <div class="dm-h">
                {t('dash.stats.by', { cut: cutLabel })}
                <span class="ds-st-cuts">
                    {#each CUTS as [key, label]}
                        <button type="button" class="ds-st-cut" class:is-on={cut === key}
                            onclick={() => onCut?.(key)}>{t(label)}</button>
                    {/each}
                </span>
            </div>
            {#if agg.rows.length}
                <div class="ds-st-list">
                    {#each agg.rows as r}
                        <div class="ds-st-row">
                            <span class="ds-st-label" title={r.label}>{clip(r.label, 26)}</span>
                            <span class="ds-st-bar"><i style="width:{Math.max(1, Math.round(r.cost / maxCost * 100))}%"></i></span>
                            <span class="ds-st-tok">{short(r.tokens)} tok</span>
                            <span class="ds-st-cost">{money(r.cost)}{#if !r.priced}<span class="ds-est">≈</span>{/if}</span>
                        </div>
                    {/each}
                </div>
            {:else}
                <p class="dm-note">{t('dash.stats.empty')}</p>
            {/if}
        </div>

        <!--
          Model × (fresh input / cache / output) — the same split the Monitor
          inspector draws, so the two agree about what "in" means. A cheap tier
          that runs most of the TOKENS while costing little is exactly the
          insight this row exists for, which is why it shows tokens, not cost.
        -->
        {#if modelTok.rows.length}
            <div class="dm-box">
                <div class="dm-h">
                    {t('dash.stats.modelSplit')}
                    {#if !modelTok.anyCache}<span class="more">{t('dash.stats.noCache')}</span>{/if}
                </div>
                <div class="ds-st-list ds-st-mlist">
                    {#each modelTok.rows as r}
                        <div class="ds-st-mrow">
                            <span class="ds-st-label" title={r.model}>{clip(shortModel(r.model), 26)}</span>
                            <span class="ds-st-mtok">{short(r.in)}↑ · {short(r.cache)}⚡ · {short(r.out)}↓</span>
                            <span class="ds-st-tok">{short(r.tokens)} tok</span>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}

        {#if sample.length}
            <div class="dm-box">
                <div class="dm-h">{t('dash.stats.sample')}</div>
                <div class="ds-st-tasks">
                    {#each sample as task (task.id)}
                        {@const line = taskModelLine(task)}
                        <a class="ds-st-task" href="#monitor?id={encodeURIComponent(task.id)}">
                            <span class="drow-dot dot-{task.status}"></span>
                            <span class="grow">{clip(task.prompt || '(no prompt)', 60)}</span>
                            <span class="ds-st-task-tok" title={line}>
                                {short(taskTokens(task))} tok{#if line}<span class="ds-st-task-models"> · {line}</span>{/if}
                            </span>
                            <span class="ds-st-task-cost">{money(spendOf([task], { rateFor, flatRate }).total)}</span>
                            <span class="ds-st-task-when">{ago(task.completed_at || task.started_at, now)}</span>
                        </a>
                    {/each}
                </div>
            </div>
        {/if}
    </div>
{/if}

<style>
    .dm-layers-4 { grid-template-columns: repeat(4, 1fr); }
    /*
      The month/week/day/model/ws buttons are NEW here, and that is a deliberate
      behaviour change made during the migration — see the note in OverviewRoot.
      The old view had the state (`statsCut`), its persistence, an aggregation
      that supports all five cuts, and a click handler for `.ds-st-cut[data-cut]`
      — but never rendered a single button carrying `data-cut`. So the handler
      was unreachable, the persisted key was never written, and the breakdown was
      permanently "by month".
    */
    .ds-st-cuts { margin-left: auto; display: flex; gap: 4px; }
</style>
