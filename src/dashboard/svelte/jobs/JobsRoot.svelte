<!--
  JobsRoot — one list of work, whatever starts it.

  Replaces the 時刻 / イベント / 監視 tabs, which split the registry by
  MECHANISM: one intention ("keep the download report up to date") was two
  records in two tabs, joined by a hand-typed event name, with its history in
  two places. Here a job is one row, and what starts it is a badge on that row.

  Shared sources stay reachable but are not the first thing you meet — they are
  for the case where two jobs watch the same mailbox, which is real and rare.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { jobManager } from '../../../modules/ai/jobs/JobManager.js';
    import { triggerSummary, overBudget, duplicateEventNames } from '../../../modules/ai/jobs/JobModel.js';
    import JobDetail from './JobDetail.svelte';
    import JobTimeline from './JobTimeline.svelte';
    import SetupWizard from './SetupWizard.svelte';
    import WatcherPanel from '../schedule/WatcherPanel.svelte';
    import RecipeManager from '../schedule/RecipeManager.svelte';

    let {
        manager = jobManager,
        confirmReset = (msg) => window.confirm(msg),
    } = $props();

    let jobs = $state(untrack(() => manager.load()));
    let selectedId = $state(null);
    let pane = $state('jobs');           // jobs | timeline | sources
    let draft = $state(null);
    let wizard = $state(false);

    const selected = $derived(
        draft && draft.id === selectedId ? draft : (jobs.find(j => j.id === selectedId) || null)
    );

    function refresh() { jobs = [...manager.jobs]; }

    /**
     * The guided route.
     *
     * Offered beside "add" rather than instead of it: someone who already knows
     * the shape wants the form, and someone meeting this for the first time
     * cannot be expected to know that a watcher and a job are two records that
     * do nothing apart. The wizard is also the ONLY route that creates both.
     */
    function onWizard() {
        wizard = true;
        draft = null;
        selectedId = null;
        pane = 'jobs';
    }

    function wizardDone(plan) {
        wizard = false;
        manager.refreshSources?.();
        refresh();
        selectedId = plan?.job?.id || null;
    }

    function onNew() {
        wizard = false;
        draft = {
            id: `job_${Date.now()}`, name: '', purpose: '', enabled: false,
            prompt: '', workspacePath: '', agentModeId: null,
            triggers: [{ kind: 'time', scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] }],
            debounceMs: 2000, cooldownMs: 0, maxPerHour: 20, budgetTokens: 0,
        };
        selectedId = draft.id;
        pane = 'jobs';
    }

    function select(job) { selectedId = job.id; draft = null; wizard = false; }
    function startEdit(job) { selectedId = job.id; draft = JSON.parse(JSON.stringify(job)); }

    function onSave(next) {
        manager.upsert(next);
        draft = null;
        refresh();
    }
    function onCancel() { draft = null; }

    function onDelete(id) {
        manager.remove(id);
        if (selectedId === id) { selectedId = null; draft = null; }
        refresh();
    }

    function toggle(job) { manager.setEnabled(job.id, !job.enabled); refresh(); }

    function pauseAll() { manager.pauseAll(); refresh(); }

    function reset() {
        if (!confirmReset(t('jobs.reset.confirm'))) return;
        manager.reset();
        selectedId = null;
        draft = null;
        refresh();
    }

    /** A watch trigger shows the source's NAME, not the id it stores. */
    function withSourceName(tr) {
        if (tr.kind !== 'watch' || !tr.sourceId) return tr;
        const s = (manager.sources || []).find(x => x.id === tr.sourceId);
        return s ? { ...tr, sourceName: s.name || s.id } : tr;
    }

    /** Kinds this job can be started by — the badges on its row. */
    function kinds(job) {
        return [...new Set((job.triggers || []).map(x => x.kind))];
    }

    /**
     * A job nobody has heard from.
     *
     * The failure this whole redesign is about: a registry nobody can read is
     * one where a broken job and a finished job look identical. Fourteen days
     * is a guess, but "has not fired in a fortnight" is a question worth
     * putting in front of someone either way.
     */
    const STALE_DAYS = 14;
    function isStale(job) {
        if (!job.enabled) return false;
        const last = job.lastRunAt || 0;
        if (!last) return true;              // enabled, never run
        return Date.now() - last > STALE_DAYS * 86400000;
    }

    const anyEnabled = $derived(jobs.some(j => j.enabled));
    // Two sources under one name: a job attached to a SOURCE is safe, but one
    // matching by name cannot tell them apart. Reported, not forbidden.
    const dupNames = $derived(duplicateEventNames(manager.sources));
</script>

<div class="view-container">
    <div class="view-header">
        <div>
            <h1>{t('jobs.title')}</h1>
            <p class="subtitle">{t('jobs.subtitle')}</p>
        </div>
        <div class="jobs-actions">
            <div class="sch-tabs" role="tablist">
                <button role="tab" aria-selected={pane === 'jobs'}
                    class:active={pane === 'jobs'} onclick={() => (pane = 'jobs')}>{t('jobs.tab.jobs')}</button>
                <button role="tab" aria-selected={pane === 'timeline'}
                    class:active={pane === 'timeline'} onclick={() => (pane = 'timeline')}>{t('jobs.tab.timeline')}</button>
                <button role="tab" aria-selected={pane === 'sources'}
                    class:active={pane === 'sources'} onclick={() => (pane = 'sources')}>{t('jobs.tab.sources')}</button>
                <button role="tab" aria-selected={pane === 'recipes'}
                    class:active={pane === 'recipes'} onclick={() => (pane = 'recipes')}>{t('jobs.tab.recipes')}</button>
            </div>
            <button class="btn btn-secondary" disabled={!anyEnabled} onclick={pauseAll}>{t('jobs.pauseAll')}</button>
            <button class="btn btn-secondary" onclick={onWizard}>{t('jobs.wizard')}</button>
            <button class="btn btn-primary" onclick={onNew}>{t('jobs.new')}</button>
        </div>
    </div>

    {#if dupNames.length}
        <p class="jobs-warn">{t('jobs.dupEvent', { names: dupNames.join(', ') })}</p>
    {/if}

    {#if wizard && pane === 'jobs'}
        <div class="sch-layout">
            <SetupWizard onDone={wizardDone} onCancel={() => (wizard = false)} />
        </div>
    {:else if pane === 'timeline'}
        <div class="sch-layout"><JobTimeline entries={manager.timeline} /></div>
    {:else if pane === 'recipes'}
        <div class="sch-layout"><RecipeManager /></div>
    {:else if pane === 'sources'}
        <div class="sch-layout">
            <div class="jobs-sources">
                <p class="sch-note">{t('jobs.sources.hint')}</p>
                <WatcherPanel />
            </div>
        </div>
    {:else}
        <div class="sch-layout">
            <ul class="trg-list jobs-list">
                {#if !jobs.length}
                    <li class="trg-empty">
                        {t('jobs.empty')}
                        <button class="btn btn-primary" onclick={onWizard}>{t('jobs.wizard')}</button>
                    </li>
                {/if}
                {#each jobs as job (job.id)}
                    <li class="trg-item" class:active={selectedId === job.id}>
                        <button class="trg-pick" onclick={() => select(job)}>
                            <span class="trg-name">{job.name || job.id}</span>
                            <span class="jobs-kinds">
                                {#each kinds(job) as k (k)}
                                    <span class="badge k-{k}">{t(`jobs.kind.${k}`)}</span>
                                {/each}
                                <span class="trg-match">{(job.triggers || []).map(withSourceName).map(triggerSummary).join(' / ')}</span>
                            </span>
                            {#if overBudget(job)}
                                <span class="trg-stopped">{t('jobs.overBudget')}</span>
                            {:else if isStale(job)}
                                <span class="jobs-stale">{t('jobs.stale')}</span>
                            {/if}
                        </button>
                        <label class="trg-toggle">
                            <input type="checkbox" checked={job.enabled} onchange={() => toggle(job)} />
                            <span>{t('trig.enabled')}</span>
                        </label>
                    </li>
                {/each}
                <li class="jobs-reset">
                    <button class="btn btn-secondary" onclick={reset}>{t('jobs.reset')}</button>
                </li>
            </ul>

            <JobDetail
                job={selected}
                isDraft={!!draft && draft.id === selectedId}
                sources={manager.sources}
                {onSave} {onCancel} {onDelete}
                onEdit={startEdit}
            />
        </div>
    {/if}
</div>

<style>
    .jobs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .jobs-list { padding-bottom: 8px; }
    .jobs-kinds { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    /* One colour per kind, so the list can be scanned without reading it. */
    .badge.k-time  { background: var(--accent-surface); color: var(--accent); }
    .badge.k-event { background: var(--warning-surface); color: var(--warning); }
    .badge.k-watch { background: var(--surface-sunken); color: var(--ink-soft); }
    .jobs-stale { color: var(--warning); font-size: var(--fs-sm); }
    .jobs-warn {
        margin: 0 0 10px; padding: 8px 12px; font-size: var(--fs-sm);
        background: var(--warning-surface); color: var(--warning);
        border-radius: var(--r-2);
    }
    .jobs-reset { padding: 12px 8px; border-top: 1px solid var(--line); }
    .jobs-sources { flex: 1; display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 0 4px; }
</style>
