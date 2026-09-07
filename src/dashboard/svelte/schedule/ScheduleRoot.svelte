<!--
  ScheduleRoot — the whole Schedule view.

  The first view migrated end-to-end (Svelte migration step 1, see
  docs/design/svelte-migration.md). It sets the pattern the others follow:

    • pure data + maths in views/schedule/scheduleModel.js
    • one root component owning the state
    • a ~30-line class in views/ that only mounts this and tears it down

  The state that used to live on the view class (`schedules`, `_editingId`,
  `_draft`) lives here as `$state`, so the two `_refreshList()` / `_refreshDetail()`
  calls that had to follow EVERY mutation are gone — that pairing was the bug
  surface: forget one and the list and the editor disagreed about what was selected.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import ScheduleList from './ScheduleList.svelte';
    import ScheduleDetail from './ScheduleDetail.svelte';
    import TriggerPanel from './TriggerPanel.svelte';
    import WatcherPanel from './WatcherPanel.svelte';
    import {
        loadSchedules, saveSchedules, newSchedule, validateForSave,
    } from '../../views/schedule/scheduleModel.js';
    import { AGENT_MODES, DEFAULT_MODE_ID, buildBehavior } from '../../../modules/ai/AgentModes.js';
    import { mcpManager } from '../../../modules/ai/McpManager.js';

    let {
        /** Injectable for tests; defaults to the real localStorage-backed pair. */
        load = loadSchedules,
        save = saveSchedules,
        /** Injectable so tests do not need window.apiClient / window.location. */
        api = null,
        navigate = (hash) => { window.location.hash = hash; },
        confirmDelete = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
        /** Injectable clock for the "Next: …" text. */
        now = null,
        mcpServerNames = null,
    } = $props();

    // Seeded ONCE, deliberately — see ConnectionModal.svelte for the full note.
    // `untrack` says so to the compiler; reading the prop directly does the same
    // thing but warns that only the initial value is captured, and those warnings
    // drown out the ones that mean something.
    let schedules = $state(untrack(() => load()));
    let draft = $state(null);
    let editingId = $state(null);
    let running = $state(false);
    /** Bumped every 30s so the relative "Next: …" text re-derives. */
    let tick = $state(0);

    // Schedules and triggers answer the same question — "what makes the agent
    // run when I am not asking it to?" — so they share this view instead of
    // taking a sixth rail destination. What differs is only the thing that
    // decides to fire: a clock, or something happening outside.
    let pane = $state('time');

    const agentModes = Object.values(AGENT_MODES);
    const servers = $derived(
        mcpServerNames ?? Object.keys(mcpManager.serversConfig?.mcpServers || {})
    );

    const clock = $derived.by(() => { tick; return now || new Date(); });

    const selected = $derived(
        draft && draft.id === editingId
            ? draft
            : (schedules.find(s => s.id === editingId) || null)
    );
    const editingDraft = $derived(!!draft && draft.id === editingId);

    function reload() {
        schedules = load();
    }

    function onNew() {
        // A DRAFT: not persisted and not handed to the manager until Save.
        draft = newSchedule(DEFAULT_MODE_ID);
        editingId = draft.id;
    }

    function onSave(edited) {
        if (editingDraft) {
            const check = validateForSave(edited);
            if (!check.ok) { notify(check.reason); return; }
            schedules = [{ ...edited }, ...schedules];
            draft = null;
        } else {
            schedules = schedules.map(s => (s.id === edited.id ? { ...s, ...edited } : s));
        }
        editingId = edited.id;
        save(schedules);
    }

    function onDelete() {
        // Discarding a draft needs no confirmation and no write: nothing was
        // ever registered.
        if (editingDraft) {
            draft = null;
            editingId = null;
            return;
        }
        if (!confirmDelete('Delete this schedule?')) return;
        schedules = schedules.filter(s => s.id !== editingId);
        editingId = null;
        save(schedules);
    }

    async function onRunNow(edited) {
        if (!edited?.prompt) { notify('Please enter a prompt'); return; }
        if (editingDraft) { notify('Save the schedule first, then run it.'); return; }
        const client = api ?? window.apiClient;
        if (!client) { notify('Not connected to the backend'); return; }

        running = true;
        // Explicit [] when nothing is picked: an empty list means "NO MCP tools"
        // while an OMITTED list would mean "all servers" — a server connecting
        // mid-task would then leak its tools in.
        const mcp_servers = (edited.mcpServers && edited.mcpServers.length > 0) ? edited.mcpServers : [];
        const behavior = {
            mode: 'iterative_agent',
            ...buildBehavior(edited.agentModeId || DEFAULT_MODE_ID),
            mcp_servers,
        };
        const record = (status, extra) => {
            schedules = schedules.map(s => (s.id === edited.id
                ? { ...s, runs: [...(s.runs || []), { at: new Date().toISOString(), status, ...extra }] }
                : s));
            save(schedules);
        };
        try {
            const task = await client.request('/tasks', {
                method: 'POST',
                body: JSON.stringify({ prompt: edited.prompt, workspace_path: null, caller: 'Schedule', behavior }),
            });
            const taskId = task.task_id || task.id;
            record('completed', { taskId });
            navigate(`#monitor?id=${taskId}`);
        } catch (err) {
            record('failed', { error: err.message });
            notify(`Run failed: ${err.message}`);
        } finally {
            running = false;
        }
    }

    // Relative times go stale, and another window can register a schedule. Both
    // were `setInterval` + a `window` listener on the view class; `$effect`
    // returns the teardown, so neither can be left running after navigation.
    $effect(() => {
        const timer = setInterval(() => { reload(); tick += 1; }, 30_000);
        const onUpdated = () => reload();
        window.addEventListener('jh-schedules-updated', onUpdated);
        return () => {
            clearInterval(timer);
            window.removeEventListener('jh-schedules-updated', onUpdated);
        };
    });
</script>

<div class="view-container">
    <div class="view-header">
        <div>
            <h1>{t('sched.title')}</h1>
            <p class="subtitle">{t('sched.subtitle')}</p>
        </div>
        <div class="sch-tabs" role="tablist">
            <button role="tab" aria-selected={pane === 'time'}
                class:active={pane === 'time'} onclick={() => (pane = 'time')}>{t('trig.tab.time')}</button>
            <button role="tab" aria-selected={pane === 'event'}
                class:active={pane === 'event'} onclick={() => (pane = 'event')}>{t('trig.tab.event')}</button>
            <button role="tab" aria-selected={pane === 'watch'}
                class:active={pane === 'watch'} onclick={() => (pane = 'watch')}>{t('wch.title')}</button>
        </div>
    </div>
    {#if pane === 'watch'}
        <div class="sch-layout"><WatcherPanel /></div>
    {:else if pane === 'event'}
        <div class="sch-layout"><TriggerPanel /></div>
    {:else}
    <div class="sch-layout">
        <ScheduleList
            {schedules}
            {draft}
            selectedId={editingId}
            now={clock}
            onSelect={(id) => (editingId = id)}
            {onNew}
        />
        <ScheduleDetail
            schedule={selected}
            isDraft={editingDraft}
            {agentModes}
            defaultModeId={DEFAULT_MODE_ID}
            mcpServers={servers}
            {running}
            now={clock}
            {onSave}
            {onRunNow}
            {onDelete}
        />
    </div>
    {/if}
</div>

<style>
    /* .sch-tabs / .sch-layout moved to dashboard.css: JobsRoot and
       JobTimeline are built on them too, and a Svelte <style> is scoped to one
       component. */
</style>
