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
    import {
        KEYS, readPref, writePref, metricsOf, rateLookup,
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

    // These four lines were each handed the wrong thing, and every one of them
    // produced the same symptom — a bill of exactly $0 — so fixing any one of
    // them looked like it had not worked:
    //
    //   rateLookup  takes the INSTANCE ARRAY (it calls modelRates itself);
    //               given a rates map it iterates nothing and prices nothing.
    //   flatRateOf  takes the server's aggregate STATS, which this tab does not
    //               fetch. There is no honest flat rate without them, and 0 is
    //               the right answer: an unpriced model is then REPORTED as
    //               unpriced instead of being quietly guessed at.
    //   metricsOf   takes an options object (see below).
    const instances = $derived(Array.isArray(config?.llm_instances) ? config.llm_instances : []);
    const rateFor = $derived(rateLookup(instances));
    const flatRate = 0;
    // metricsOf takes an OPTIONS OBJECT. It used to be handed `clock` — a
    // number — so every option fell back to its default: no rateFor, which
    // makes spend exactly $0 however many tokens ran, and a fixed 7d window
    // that the range buttons could not move. The panel then reported "these
    // tasks recorded no token usage" while the table beside it listed 405k.
    const metrics = $derived(metricsOf(tasks, {
        spendRange, rateFor, flatRate, now: clock,
    }));

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
