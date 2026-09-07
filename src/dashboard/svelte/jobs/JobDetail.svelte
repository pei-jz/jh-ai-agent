<!--
  JobDetail — what a job is, what starts it, what it has cost.

  The view side leads with PURPOSE and SPEND, because those are the two things
  the old registry could not answer: "why does this exist" (a name is never
  enough six months later) and "what is it costing me" (an agent's failure mode
  is expense, not a crash).
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { AGENT_MODES, DEFAULT_MODE_ID, modeName } from '../../../modules/ai/AgentModes.js';
    import { triggerSummary, overBudget } from '../../../modules/ai/jobs/JobModel.js';
    import { mcpManager } from '../../../modules/ai/McpManager.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import ScheduleFields from '../schedule/ScheduleFields.svelte';

    let {
        job = null,
        isDraft = false,
        sources = [],
        onSave = () => {},
        onCancel = () => {},
        onDelete = () => {},
        onEdit = () => {},
        confirmDelete = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
    } = $props();

    let projects = $state([]);
    let mcpNames = $state([]);
    let templates = $state([]);
    $effect(() => {
        let alive = true;
        (async () => {
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (!alive) return;
            projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
            mcpNames = Object.keys(config.mcp_servers || mcpManager.serversConfig?.mcpServers || {});
            try {
                promptTemplateManager.loadFromConfig(config);
                templates = promptTemplateManager.getAll() || [];
            } catch (_) { templates = []; }
        })();
        return () => { alive = false; };
    });

    /**
     * Explicit [] when nothing is picked.
     *
     * An empty list means "no MCP tools"; an OMITTED list means "every server",
     * so a server that connects mid-run would quietly hand this job tools it
     * was never given. The same rule the schedules and triggers already used.
     */
    function toggleMcp(name, on) {
        const cur = new Set(job.mcpServers || []);
        if (on) cur.add(name); else cur.delete(name);
        job.mcpServers = [...cur];
    }

    /** Paste a template's text into the prompt rather than replacing it. */
    function insertTemplate(key) {
        if (!key) return;
        const tpl = promptTemplateManager.get(key);
        const body = tpl?.prompt || tpl?.text || '';
        if (!body) return;
        job.prompt = job.prompt ? `${job.prompt}\n${body}` : body;
    }

    const agentModes = Object.values(AGENT_MODES);

    async function browse() {
        try {
            const sel = await invoke('select_folder');
            if (sel && job) job.workspacePath = sel;
        } catch (_) { /* cancelled */ }
    }

    function save() {
        if (!String(job.name || '').trim()) { notify(t('jobs.name')); return; }
        if (!String(job.prompt || '').trim()) { notify(t('trig.prompt')); return; }
        // Purpose is required on purpose. The name tells you what it is called;
        // only this tells the person who finds it in six months why to keep it.
        if (!String(job.purpose || '').trim()) { notify(t('jobs.purpose')); return; }
        onSave(job);
    }

    function del() {
        if (!confirmDelete(`"${job.name || job.id}" を削除しますか？`)) return;
        onDelete(job.id);
    }

    function addTrigger(kind) {
        // Every field the four types need, present from the start:
        // switching type used to bind a select to `undefined`.
        const base = { time: { kind: 'time', scheduleType: 'fixed', time: '09:00',
                              days: [1, 2, 3, 4, 5], intervalMinutes: 60, dayOfMonth: '1', onceAt: '' },
                       event: { kind: 'event', match: { event: '' } },
                       watch: { kind: 'watch', sourceId: sources[0]?.id || '' } };
        job.triggers = [...(job.triggers || []), base[kind]];
    }
    function removeTrigger(i) { job.triggers = job.triggers.filter((_, n) => n !== i); }

    /** A run's kind, never a raw key. */
    function kindLabel(kind) {
        return kind ? t(`jobs.kind.${kind}`, null, kind) : t('jobs.kind.unknown');
    }

    /** The watcher a trigger points at, by NAME. */
    function withSourceName(tr) {
        if (tr?.kind !== 'watch' || !tr.sourceId) return tr;
        const s = (sources || []).find(x => x.id === tr.sourceId);
        return s ? { ...tr, sourceName: s.name || s.id } : tr;
    }

    const secs = (ms) => Math.round((ms || 0) / 1000);
    const money = (n) => (Number(n) || 0).toFixed(4);
    const num = (n) => (Number(n) || 0).toLocaleString();
</script>

<div class="sch-detail-panel">
{#if !job}
    <div class="trg-empty">{t('jobs.pick')}</div>
{:else}
    <div class="sch-detail-header">
        <span>{job.name || t('jobs.untitled')}</span>
        <span class="sch-detail-next">{(job.triggers || []).map(withSourceName).map(triggerSummary).join(' / ')}</span>
    </div>
    <div class="sch-detail-body">

    {#if isDraft}
        <div class="trg-grid">
            <div class="sch-field">
                <label for="job-name">{t('jobs.name')}</label>
                <input id="job-name" type="text" class="sch-input" bind:value={job.name} />
            </div>
            <div class="sch-field">
                <label for="job-purpose">{t('jobs.purpose')}</label>
                <input id="job-purpose" type="text" class="sch-input" bind:value={job.purpose}
                    placeholder={t('jobs.purpose.ph')} />
            </div>

            <div class="sch-field trg-span">
                <label for="job-prompt">{t('trig.prompt')}</label>
                <textarea id="job-prompt" class="sch-textarea" rows="4" bind:value={job.prompt}></textarea>
                {#if templates.length}
                    <div class="trg-row">
                        <select class="sch-select job-tpl"
                            onchange={(e) => { insertTemplate(e.currentTarget.value); e.currentTarget.value = ''; }}>
                            <option value="">{t('jobs.tpl')}</option>
                            {#each templates as tpl (tpl.key)}
                                <option value={tpl.key}>{tpl.icon || ''} {tpl.label || tpl.key}</option>
                            {/each}
                        </select>
                    </div>
                {/if}
            </div>

            <!-- The tools this job may reach for. Skills are NOT here: the
                 catalogue is offered to every run automatically and the agent
                 loads a body when one applies, so there is nothing to pick. -->
            <div class="sch-field trg-span">
                <span class="sch-label">{t('jobs.mcp')}</span>
                <span class="sch-note">{t('jobs.mcp.hint')}</span>
                {#if !mcpNames.length}
                    <span class="sch-note">{t('jobs.mcp.none')}</span>
                {:else}
                    <div class="job-mcp">
                        {#each mcpNames as name (name)}
                            <label class="trg-check">
                                <input type="checkbox"
                                    checked={(job.mcpServers || []).includes(name)}
                                    onchange={(e) => toggleMcp(name, e.currentTarget.checked)} />
                                <span>{name}</span>
                            </label>
                        {/each}
                    </div>
                {/if}
                <span class="sch-note">{t('jobs.skills.hint')}</span>
            </div>

            <div class="sch-field">
                <label for="job-ws">{t('trig.workspace')}</label>
                <div class="trg-row">
                    <select id="job-ws" class="sch-select trg-grow" bind:value={job.workspacePath}>
                        <option value="">{t('trig.workspace.none')}</option>
                        {#if job.workspacePath && !projects.includes(job.workspacePath)}
                            <option value={job.workspacePath}>{job.workspacePath}</option>
                        {/if}
                        {#each projects as p (p)}<option value={p}>{p}</option>{/each}
                    </select>
                    <button type="button" class="btn btn-secondary trg-browse" onclick={browse}>{@html icon('folder', 20)}</button>
                </div>
            </div>
            <div class="sch-field">
                <label for="job-agent">{t('trig.agent')}</label>
                <select id="job-agent" class="sch-select" bind:value={job.agentModeId}>
                    <option value={null}>{modeName(AGENT_MODES[DEFAULT_MODE_ID])}</option>
                    {#each agentModes as m (m.id)}<option value={m.id}>{modeName(m)}</option>{/each}
                </select>
            </div>

            <!-- Triggers are a LIST on the job. Adding a second way to start the
                 same work is one button, not a second record in another tab. -->
            <div class="sch-field trg-span">
                <span class="sch-label">{t('jobs.triggers')}</span>
                {#each job.triggers as tr, i (i)}
                    <div class="job-trigger">
                        <div class="trg-row">
                            <span class="badge k-{tr.kind}">{t(`jobs.kind.${tr.kind}`)}</span>

                            {#if tr.kind === 'time'}
                                <!-- The same control the schedule screen uses.
                                     It used to be a fourth hand-rolled copy. -->
                                <ScheduleFields bind:value={job.triggers[i]} compact idPrefix={`job-tr${i}`} />

                            {:else if tr.kind === 'event'}
                                <input type="text" class="sch-input trg-grow" bind:value={tr.match.event}
                                    placeholder="ci.failed" />

                            {:else}
                                <select class="sch-select trg-grow" bind:value={tr.sourceId}>
                                    <option value="">{t('jobs.source.none')}</option>
                                    {#each sources as s (s.id)}
                                        <option value={s.id}>{s.name || s.id} — {s.eventName}</option>
                                    {/each}
                                </select>
                            {/if}

                            <button type="button" class="btn btn-secondary trg-rowbtn"
                                onclick={() => removeTrigger(i)}>×</button>
                        </div>
                        {#if tr.kind === 'watch'}
                            <span class="sch-note">{t('jobs.watch.hint')}</span>
                        {:else if tr.kind === 'event'}
                            <span class="sch-note">{t('jobs.event.hint')}</span>
                        {/if}
                    </div>
                {/each}
                <div class="trg-row">
                    <button type="button" class="btn btn-secondary trg-rowbtn" onclick={() => addTrigger('time')}>＋ {t('jobs.kind.time')}</button>
                    <button type="button" class="btn btn-secondary trg-rowbtn" onclick={() => addTrigger('event')}>＋ {t('jobs.kind.event2')}</button>
                    <button type="button" class="btn btn-secondary trg-rowbtn" onclick={() => addTrigger('watch')}>＋ {t('jobs.kind.watch')}</button>
                </div>
            </div>

            <div class="sch-field trg-span">
                <span class="sch-label">{t('trig.guards')}</span>
                <div class="trg-row trg-guards">
                    <label for="job-deb">{t('trig.debounce')}</label>
                    <input id="job-deb" type="number" min="0" class="sch-input" value={secs(job.debounceMs)}
                        oninput={(e) => (job.debounceMs = Math.max(0, Number(e.currentTarget.value) || 0) * 1000)} />
                    <label for="job-cool">{t('trig.cooldown')}</label>
                    <input id="job-cool" type="number" min="0" class="sch-input" value={secs(job.cooldownMs)}
                        oninput={(e) => (job.cooldownMs = Math.max(0, Number(e.currentTarget.value) || 0) * 1000)} />
                    <label for="job-cap">{t('trig.maxPerHour')}</label>
                    <input id="job-cap" type="number" min="0" class="sch-input" bind:value={job.maxPerHour} />
                    <label for="job-budget">{t('jobs.budget')}</label>
                    <input id="job-budget" type="number" min="0" class="sch-input" bind:value={job.budgetTokens} />
                </div>
                <span class="sch-note">{t('jobs.budget.hint')}</span>
            </div>
        </div>

        <div class="trg-actions">
            <button class="btn btn-primary" onclick={save}>{t('trig.save')}</button>
            <button class="btn btn-secondary" onclick={onCancel}>{t('jobs.cancel')}</button>
            <button class="btn btn-secondary" onclick={del}>{t('trig.delete')}</button>
        </div>

    {:else}
        <div class="trg-view">
            {#if job.purpose}
                <p class="job-purpose">{job.purpose}</p>
            {:else}
                <p class="sch-note">{t('jobs.purpose.missing')}</p>
            {/if}

            <h4>{t('jobs.triggers')}</h4>
            <ul class="job-trlist">
                {#each job.triggers || [] as tr, i (i)}
                    <li>
                        <span class="badge k-{tr.kind}">{t(`jobs.kind.${tr.kind}`)}</span>
                        {triggerSummary(withSourceName(tr))}
                    </li>
                {/each}
            </ul>

            <h4>{t('jobs.spend')}</h4>
            <div class="job-spend" class:over={overBudget(job)}>
                <div><span class="job-figure">{num(job.spent?.tokens)}</span><span class="sch-note">tokens</span></div>
                <!-- Shown only when something actually measured it. The
                     server's token report carries no cost field, so this was a
                     dollar figure of $0.0000 on every job — a number that looks
                     like a measurement and is only the absence of one. -->
                {#if job.spent?.cost > 0}
                    <div><span class="job-figure">${money(job.spent.cost)}</span><span class="sch-note">{t('jobs.spend.cost')}</span></div>
                {:else}
                    <div><span class="sch-note">{t('jobs.spend.noCost')}</span></div>
                {/if}
                <div><span class="job-figure">{num(job.spent?.runs)}</span><span class="sch-note">{t('jobs.spend.runs')}</span></div>
                <div class="sch-note">
                    {job.budgetTokens > 0 ? t('jobs.budget.of', { n: num(job.budgetTokens) }) : t('jobs.budget.none')}
                </div>
            </div>

            <pre class="trg-prompt">{job.prompt}</pre>

            <h4>{t('trig.runs')}</h4>
            {#if !job.runs?.length}
                <p class="sch-note">{t('trig.norun')}</p>
            {:else}
                <ul class="trg-runs">
                    {#each [...job.runs].reverse().slice(0, 12) as r, i (i)}
                        <li>
                            <span>{new Date(r.at).toLocaleString()}</span>
                            <!-- Runs recorded before jobs existed carry no
                                 `kind`, and `t('jobs.kind.undefined')` printed
                                 the KEY on screen. A fallback that is itself a
                                 lookup is not a fallback. -->
                            <span class="badge k-{r.kind || 'time'}">{kindLabel(r.kind)}</span>
                            <span>{r.tokens != null ? `${num(r.tokens)}t` : ''}</span>
                            <span class:err={r.status === 'failed'}>{r.error || r.status}</span>
                        </li>
                    {/each}
                </ul>
            {/if}

            <div class="trg-actions">
                <button class="btn btn-primary" onclick={() => onEdit(job)}>{t('trig.edit')}</button>
            </div>
        </div>
    {/if}
    </div>
{/if}
</div>

<style>
    .job-purpose { margin: 0; font-size: 1.02em; }
    .job-trigger {
        border: 1px solid var(--line); border-radius: var(--r-2);
        padding: 8px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .job-trlist { list-style: none; margin: 0; padding: 0; }
    .job-trlist li { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
    .job-num { width: 110px; }
    .job-tpl { max-width: 320px; }
    .job-mcp { display: flex; flex-wrap: wrap; gap: 10px 18px; }
    .job-spend {
        display: flex; gap: 20px; align-items: baseline; flex-wrap: wrap;
        background: var(--surface-sunken); border: 1px solid var(--line);
        border-radius: var(--r-2); padding: 10px 14px;
    }
    .job-spend.over { border-color: var(--warning); }
    .job-spend > div { display: flex; gap: 6px; align-items: baseline; }
    .job-figure { font-size: 1.25em; font-weight: 600; font-variant-numeric: tabular-nums; }
    .badge.k-time  { background: var(--accent-surface); color: var(--accent); }
    .badge.k-event { background: var(--warning-surface); color: var(--warning); }
    .badge.k-watch { background: var(--surface-sunken); color: var(--ink-soft); }
    .err { color: var(--error); }
</style>
