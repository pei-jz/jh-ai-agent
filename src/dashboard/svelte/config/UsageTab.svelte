<!--
  UsageTab — what the runs cost, and how that splits.

  docs/design/information-architecture.md §7 step 4. This was the Dashboard's
  SpendPanel + StatsPane, on the screen you look at while nothing is happening.
  It moved here because of when the numbers are actually useful: you read a cost
  breakdown when you are deciding whether to change something about cost, and
  that decision is made in Settings, next to the phase-routing controls that act
  on it. On a "what needs me right now" screen it was decoration, and the owner
  of this app reported never reading it.

  The panels themselves are unchanged — this is a relocation. What is new is the
  fetch: the Dashboard already had the task list for other reasons, and this tab
  has to ask for it.
-->
<script>
    import { PANEL_STYLES } from '../../views/panels.styles.js';
    import { invoke } from '@tauri-apps/api/core';
    import { modelRates } from '../../../modules/ai/agent/ModelPhaseRouter.js';
    import {
        KEYS, readPref, writePref, metricsOf, rateLookup, flatRateOf,
    } from '../../views/overview/overviewModel.js';

    import SpendPanel from '../overview/SpendPanel.svelte';
    import StatsPane from '../overview/StatsPane.svelte';

    let {
        api = null,
    } = $props();

    const client = () => api ?? window.apiClient;

    let tasks = $state([]);
    let config = $state({});
    let error = $state('');
    let clock = $state(Date.now());

    let spendRange = $state(readPref(KEYS.spendRange, '7d'));
    let statsCut = $state(readPref(KEYS.statsCut, 'month'));
    let statsRange = $state(readPref(KEYS.statsRange, 'all'));
    let statsStatus = $state(readPref(KEYS.statsStatus, 'all'));

    const metrics = $derived(metricsOf(tasks, clock));
    const rates = $derived(modelRates(config));
    const rateFor = $derived(rateLookup(rates));
    const flatRate = $derived(flatRateOf(rates));

    const pick = (key, setter) => (value) => { setter(value); writePref(key, value); };

    $effect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await client().request('/tasks');
                if (cancelled) return;
                tasks = Array.isArray(res?.tasks) ? res.tasks : (Array.isArray(res) ? res : []);
            } catch (e) {
                if (!cancelled) error = String(e?.message || e);
            }
            try {
                const c = (await invoke('get_ai_config')) || {};
                if (!cancelled) config = c;
            } catch (_) { /* not under Tauri */ }
        })();
        return () => { cancelled = true; };
    });

    // Only for the "running for N minutes" figures. One tick a second is enough
    // and, unlike the Dashboard, this tab is not also driving a socket.
    $effect(() => {
        const id = setInterval(() => { clock = Date.now(); }, 1000);
        return () => clearInterval(id);
    });
</script>

<!--
  The panel class names (.dm-box, .ds-tbl, .drow-dot) are shared BETWEEN
  these components, and Svelte's per-component scoping would stop each one
  applying outside the file that declared it. Content is a constant from our
  own module, not data.
-->
{@html `<style>${PANEL_STYLES}</style>`}

<div class="cfg-usage">
    {#if error}
        <p class="cfg-err">使用状況を読み込めませんでした: {error}</p>
    {/if}

    <SpendPanel {metrics} range={spendRange}
        onRange={pick(KEYS.spendRange, (v) => (spendRange = v))} />

    <StatsPane {tasks} {rateFor} {flatRate} now={clock}
        cut={statsCut} range={statsRange} status={statsStatus}
        onCut={pick(KEYS.statsCut, (v) => (statsCut = v))}
        onRange={pick(KEYS.statsRange, (v) => (statsRange = v))}
        onStatus={pick(KEYS.statsStatus, (v) => (statsStatus = v))} />
</div>

<style>
    .cfg-usage {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
    }
</style>
