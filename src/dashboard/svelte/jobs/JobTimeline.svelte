<!--
  JobTimeline — what happened, across every job, in time order.

  The question people actually ask is "what ran last night?", and that is a
  time-ordered question. Per-job histories cannot answer it: you would have to
  open every job and merge them by eye.

  It records what did NOT happen too. An event that matched nothing, a job that
  was switched off, one inside its cooldown — the old engine journal held these
  and lived in memory, so the evidence was gone by morning, which is exactly
  when it is wanted.
-->
<script>
    import { t } from '../../../i18n/index.js';

    let {
        entries = [],
        /** Injected so the jump is testable without a real address bar. */
        navigate = (hash) => { window.location.hash = hash; },
    } = $props();

    /**
     * Open the run this row is about.
     *
     * `taskId` has been on every started entry since the timeline existed; the
     * row just had nowhere to click. Without it, "why did this run at 3am" ends
     * at the timestamp — the transcript that answers it is one screen away and
     * had to be found by hand.
     */
    function open(taskId) {
        if (taskId) navigate(`#monitor?id=${taskId}`);
    }

    let filter = $state('all');          // all | started | skipped

    /** started / not-started, because that is how the list is read. */
    const RAN = new Set(['started', 'completed']);

    const rows = $derived(
        [...(entries || [])]
            .reverse()
            .filter((e) => filter === 'all'
                || (filter === 'started' ? RAN.has(e.outcome) : !RAN.has(e.outcome)))
    );

    function label(outcome) {
        return t(`jobs.outcome.${outcome}`, null, outcome);
    }
    const isBad = (o) => o === 'failed' || o === 'over-budget';
</script>

<div class="jtl">
    <div class="jtl-head">
        <div class="sch-tabs" role="tablist">
            <button role="tab" aria-selected={filter === 'all'}
                class:active={filter === 'all'} onclick={() => (filter = 'all')}>{t('jobs.tl.all')}</button>
            <button role="tab" aria-selected={filter === 'started'}
                class:active={filter === 'started'} onclick={() => (filter = 'started')}>{t('jobs.tl.started')}</button>
            <button role="tab" aria-selected={filter === 'skipped'}
                class:active={filter === 'skipped'} onclick={() => (filter = 'skipped')}>{t('jobs.tl.skipped')}</button>
        </div>
        <span class="sch-note">{t('jobs.tl.hint')}</span>
    </div>

    {#if !rows.length}
        <p class="trg-empty">{t('jobs.tl.empty')}</p>
    {:else}
        <ul class="jtl-list">
            {#each rows as e, i (i)}
                <li class="jtl-row" class:bad={isBad(e.outcome)}>
                    <span class="jtl-at">{new Date(e.at).toLocaleString()}</span>
                    <span class="jtl-job">{e.job || (e.kind === 'system' ? '—' : t('jobs.tl.nojob'))}</span>
                    {#if e.kind && e.kind !== 'system'}
                        <span class="badge k-{e.kind}">{t(`jobs.kind.${e.kind}`, null, e.kind)}</span>
                    {/if}
                    <span class="jtl-outcome" class:ran={RAN.has(e.outcome)}>{label(e.outcome)}</span>
                    <span class="jtl-why">{e.why || e.event || ''}</span>
                    {#if e.taskId}
                        <button class="btn btn-secondary jtl-open"
                            onclick={() => open(e.taskId)}>{t('jobs.tl.open')}</button>
                    {:else}
                        <span></span>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .jtl { flex: 1; display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 0 4px; }
    .jtl-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .jtl-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
    .jtl-row {
        display: grid;
        grid-template-columns: 12rem 12rem auto 6rem 1fr auto;
        gap: 10px; align-items: baseline;
        padding: 5px 6px; border-bottom: 1px solid var(--line);
        font-size: var(--fs-sm);
    }
    @media (max-width: 900px) {
        .jtl-row { grid-template-columns: 1fr; gap: 2px; padding-bottom: 10px; }
    }
    .jtl-row.bad { background: var(--warning-surface); }
    .jtl-at { color: var(--ink-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .jtl-job { font-weight: 600; }
    .jtl-outcome { color: var(--ink-faint); }
    .jtl-outcome.ran { color: var(--accent); font-weight: 600; }
    .jtl-why { color: var(--ink-soft); }
    .jtl-open { padding: 2px 10px; font-size: var(--fs-sm); white-space: nowrap; }
    .badge.k-time  { background: var(--accent-surface); color: var(--accent); }
    .badge.k-event { background: var(--warning-surface); color: var(--warning); }
    .badge.k-watch { background: var(--surface-sunken); color: var(--ink-soft); }
</style>
