<!--
  Sparkline — token spend per LLM call, as split bars.

  A single total says how much a run cost; the shape says WHERE it went, and a
  late spike is usually a context that stopped fitting. The input bar is split at
  the CACHE line rather than beside it: what a reader wants is how much of the
  context MISSED the cache, because that is the part billed at full price.
-->
<script>
    import { cacheInsideInput, freshInput, fmtTokens } from '../../views/monitor/inspector.js';

    let {
        /** Array of per-call totals, or {in, cache, out} objects. */
        perStep = [],
        /** The run's totals, for the legend. */
        usage = {},
        /** Whether `in` already contains `cache`; inferred from usage when absent. */
        inclusive = undefined,
    } = $props();

    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const incl = $derived(inclusive === undefined ? cacheInsideInput(usage) : !!inclusive);

    const bars = $derived(
        (Array.isArray(perStep) ? perStep : [])
            .map(p => (p && typeof p === 'object')
                ? { in: num(p.in), cache: num(p.cache), out: num(p.out) }
                : (Number.isFinite(p) && p >= 0 ? { in: p, cache: 0, out: 0 } : null))
            .filter(Boolean)
            .map(b => ({ fresh: freshInput(b.in, b.cache, incl), cache: b.cache, out: b.out }))
    );

    // Only the last N fit legibly, and the recent shape is what matters.
    const shown = $derived(bars.slice(-24));
    const totals = $derived(shown.map(b => b.fresh + b.cache + b.out));
    const max = $derived(Math.max(...totals, 1));
    const legendFresh = $derived(
        freshInput(usage.prompt_tokens, usage.cache_read_input_tokens, incl)
    );

    const height = (i) => Math.max(6, Math.round((totals[i] / max) * 100));
    const barTitle = (b, i) =>
        `step ${bars.length - shown.length + i + 1}: ${fmtTokens(totals[i])} tokens `
        + `(↑${fmtTokens(b.fresh)} fresh ⚡${fmtTokens(b.cache)} cached ↓${fmtTokens(b.out)} out)`;
</script>

<!-- One bar is not a trend. -->
{#if shown.length >= 2}
    <div class="insp-spark">
        {#each shown as b, i}
            <div
                class="insp-bar"
                class:is-last={i === shown.length - 1}
                style={`height:${height(i)}%`}
                title={barTitle(b, i)}
            >
                {#if b.out > 0}<span class="insp-seg is-out" style={`flex:${b.out}`}></span>{/if}
                {#if b.fresh > 0}<span class="insp-seg is-in" style={`flex:${b.fresh}`}></span>{/if}
                {#if b.cache > 0}<span class="insp-seg is-cache" style={`flex:${b.cache}`}></span>{/if}
            </div>
        {/each}
    </div>
    <div class="insp-spark-legend">
        <span class="insp-lg is-cache">⚡{fmtTokens(usage.cache_read_input_tokens || 0)} cached</span>
        <span class="insp-lg is-in">↑{fmtTokens(legendFresh)} fresh</span>
        <span class="insp-lg is-out">↓{fmtTokens(usage.completion_tokens || 0)} out</span>
    </div>
{/if}
