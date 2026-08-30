<!--
  SpendPanel — the bill, split by model.

  The bar answers "what is the split"; the table answers "how much did that model
  actually cost me", which a percentage of an unknown total cannot. Every model
  appears in the table — including ones too small for the bar's top three — since
  a cheap tier that turns out to be running most of the tokens is exactly what
  this panel is for.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { clip, fmt, money } from '../../views/overview/overviewModel.js';

    let { metrics, range = '7d', onRange = null } = $props();

    const SHADES = ['var(--accent)', 'var(--accent-dim)', 'var(--ink-faint)'];
    const RANGES = [['1d', 'Today'], ['7d', '7d'], ['30d', '30d']];

    const s = $derived(metrics.spend);
    const pctOf = (r) => (s.total > 0 ? r.cost / s.total * 100 : 0);
    // A model that rounds to 0% is a rounding artefact, not information — it was
    // making the legend read "…· (unattributed) 0%".
    const top = $derived(s.rows.slice(0, 3).filter(r => Math.round(pctOf(r)) > 0));

    const leadShare = $derived(s.total > 0 && s.rows.length ? Math.round(s.rows[0].cost / s.total * 100) : 0);
    // Only worth saying when there IS somewhere cheaper to move the work to.
    const showTierTip = $derived(s.rows.length > 1 && leadShare >= 60 && s.rows[0]?.priced);

    // Why the breakdown is empty, when it is. The panel used to render NOTHING
    // in that case, which made "no spend in this window" and "the panel is
    // broken" look identical — the user's report was literally "the stats at the
    // bottom left have disappeared", and the layout gave no way to tell which it
    // was. An empty state that names the reason, and keeps the range picker
    // reachable, turns that into one glance.
    const emptyWhy = $derived(
        metrics.rangeTasks === 0
            ? `この ${metrics.rangeDays} 日間に実行されたタスクはありません。期間を広げてください。`
            : `この期間の ${metrics.rangeTasks} 件はトークン使用量を記録していません。`,
    );
</script>

{#if s.rows.length}
    <div class="ds">
        <div class="ds-top">
            <span class="ds-v">{money(s.total)}</span>
            <span class="ds-range" role="group" aria-label={t('stats.spendRange')}>
                {#each RANGES as [key, label]}
                    <button type="button" class="ds-range-btn" class:is-on={range === key}
                        onclick={() => onRange?.(key)}>{label}</button>
                {/each}
            </span>
        </div>

        <div class="ds-k">
            {metrics.rangeDays}d · {metrics.done7} done{metrics.successRate !== null ? ` · ${metrics.successRate}%` : ''}
        </div>

        <div class="ds-bar">
            {#each top as r, i}
                <i style="width:{Math.max(1, pctOf(r))}%;background:{SHADES[i]}"></i>
            {/each}
        </div>
        <div class="ds-lg">
            {#each top as r, i}
                <span><i class="ds-sw" style="background:{SHADES[i]}"></i>{clip(r.label, 18)} {Math.round(pctOf(r))}%</span>
            {/each}
        </div>

        <table class="ds-tbl">
            <thead>
                <tr>
                    <th>{t('dash.spend.model')}</th>
                    <th>{t('dash.spend.tokens')}</th>
                    <th>{t('dash.spend.cost')}</th>
                </tr>
            </thead>
            <tbody>
                {#each s.rows as r}
                    <tr class:is-est={!r.priced}>
                        <td title={r.label}>{clip(r.label, 28)}</td>
                        <td>{fmt(r.tokens)}</td>
                        <td>
                            {money(r.cost)}{#if !r.priced}<span class="ds-est" title={t('dash.spend.estimated')}>≈</span>{/if}
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>

        {#if showTierTip}
            <p class="ds-tip">
                {clip(s.rows[0].label, 24)} is {leadShare}% of it —
                <a class="cfg-link" href="#config">switch models within one task</a>
                moves the implementation phase onto the cheaper tier.
            </p>
        {:else if s.unpriced > 0}
            <p class="ds-tip">
                {fmt(s.unpriced)} tokens were estimated —
                <a class="cfg-link" href="#config">set $/1M rates</a> per connection.
            </p>
        {/if}
    </div>
{:else}
    <div class="ds">
        <div class="ds-top">
            <span class="ds-v">{money(0)}</span>
            <span class="ds-range" role="group" aria-label={t('stats.spendRange')}>
                {#each RANGES as [key, label]}
                    <button type="button" class="ds-range-btn" class:is-on={range === key}
                        onclick={() => onRange?.(key)}>{label}</button>
                {/each}
            </span>
        </div>
        <p class="ds-tip">{emptyWhy}</p>
    </div>
{/if}
