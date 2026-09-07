<!--
  SetupWizard — one pass that produces both halves of an automation.

  Before this, setting one up meant knowing that a watcher emits an event, that
  a job waits for one, that neither does anything alone, and that the join
  between them is a name you type identically in two places. None of that was
  written down anywhere on the screen. People made a watcher, watched it fire,
  and nothing happened.

  Three steps, always the same three:

     1. 何がきっかけか   — one grouped list of cards: the clock, or something to watch
     2. その設定          — the schedule control, or the recipe's own fields
     3. やること          — the work itself, identical either way

  The list in step 1 is where the "no watcher needed" case lives. A fixed-cycle
  job is not a different flow; it is the first card in the same list, and it
  happens to produce no watcher. Splitting the wizard by whether a watcher
  exists would repeat, a third time, the mistake of organising this feature by
  mechanism instead of by what the person is trying to do.

  LAYOUT: a fixed-width card, centred. The wizard is a form with about eight
  short fields; stretched across a 1900px window it became one field per line
  with two thirds of the screen empty and the Next button below the fold. A form
  does not get easier to fill in by being wider — it gets easier by having its
  fields where the eye already is.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { AGENT_MODES, DEFAULT_MODE_ID, modeName } from '../../../modules/ai/AgentModes.js';
    import { recipeRegistry } from '../../../modules/ai/triggers/RecipeRegistry.js';
    import { watcherManager, fieldSecretId } from '../../../modules/ai/triggers/WatcherManager.js';
    import { jobManager } from '../../../modules/ai/jobs/JobManager.js';
    import { recipeHosts, payloadFields } from '../../../modules/ai/triggers/recipes/recipeFormat.js';
    import ScheduleFields from '../schedule/ScheduleFields.svelte';
    import {
        STEPS, startOptions, findOption, initialState, stepProblems, buildPlan,
        timeTemplates, applyTemplate,
    } from '../../../modules/ai/jobs/wizardPlan.js';

    let {
        registry = recipeRegistry,
        watchers = watcherManager,
        jobs = jobManager,
        onDone = () => {},
        onCancel = () => {},
        notify = (msg) => window.alert(msg),
    } = $props();

    let recipes = $state([]);
    let step = $state('start');
    let state = $state(initialState(null));
    let projects = $state([]);
    let saving = $state(false);
    let templateNote = $state('');

    $effect(() => {
        let alive = true;
        (async () => {
            await registry.refresh();
            if (!alive) return;
            recipes = registry.getAll();
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (!alive) return;
            projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
        })();
        return () => { alive = false; };
    });

    const groups = $derived(startOptions(recipes));
    const option = $derived(findOption(recipes, state.optionId));
    const recipe = $derived(option?.recipe || null);
    const problems = $derived(stepProblems(step, state, option));
    const stepIndex = $derived(STEPS.indexOf(step));
    const templates = $derived(timeTemplates(recipes));

    /** What the recipe will talk to. The fact that decides whether to run it. */
    const hosts = $derived(recipe && !recipe.schedule ? recipeHosts(recipe, state.values) : []);
    /** The fields the events carry, so step 3 can say what {{…}} to write. */
    const fields = $derived(recipe ? payloadFields(recipe) : []);

    /**
     * Choosing IS advancing.
     *
     * A card that only ticks itself, followed by a Next button at the bottom of
     * a long list, is two clicks and a scroll for one decision. Nothing is lost:
     * step 2 is one Back away, and re-choosing re-seeds from scratch.
     */
    function choose(item) {
        state = initialState(item);
        templateNote = '';
        step = 'setup';
    }

    function next() {
        if (problems.length) return;
        step = STEPS[Math.min(STEPS.length - 1, stepIndex + 1)];
    }
    function back() {
        if (stepIndex <= 0) { onCancel(); return; }
        step = STEPS[stepIndex - 1];
    }

    async function browse(set) {
        try {
            const sel = await invoke('select_folder');
            if (sel) set(sel);
        } catch (_) { /* cancelled */ }
    }

    /** A ready-made job. It moves the schedule too, so it says so. */
    function useTemplate(id) {
        const r = templates.find(x => x.id === id);
        if (!r) return;
        state = applyTemplate(state, r);
        templateNote = t('wiz.tpl.applied', { name: r.name });
    }

    const agentModes = Object.values(AGENT_MODES);

    /**
     * Create both records, in the order that keeps them consistent.
     *
     * Credentials, then the watcher, then the approval, then the job. An
     * approval recorded before the values exist covers a configuration that
     * does not, and the first poll refuses itself over a change nobody made.
     */
    async function finish() {
        if (problems.length) return;
        saving = true;
        try {
            const plan = buildPlan(state, option);
            if (plan.watcher) {
                for (const [key, value] of Object.entries(state.secrets || {})) {
                    if (!value) continue;
                    await invoke('set_watcher_secret',
                        { id: fieldSecretId(plan.watcher.id, key), password: value });
                }
                watchers.upsert(plan.watcher);
                await registry.approve(plan.approve.watcherId, plan.approve.recipe, plan.approve.values);
            }
            jobs.upsert(plan.job);
            onDone(plan);
        } catch (e) {
            notify(String(e?.message || e));
        } finally {
            saving = false;
        }
    }
</script>

<div class="wiz-shell">
  <div class="wiz">
    <div class="wiz-steps">
        {#each STEPS as s, i (s)}
            <span class="wiz-step" class:active={s === step} class:done={i < stepIndex}>
                <span class="wiz-num">{i + 1}</span>{t(`wiz.step.${s}`)}
            </span>
        {/each}
    </div>

    <div class="wiz-body">
    {#if step === 'start'}
        <p class="sch-note">{t('wiz.start.hint')}</p>
        {#each groups as g (g.group)}
            <h4 class="wiz-group">{t(`wiz.group.${g.group}`)}</h4>
            <ul class="wiz-options">
                {#each g.items as item (item.id)}
                    <li>
                        <button class="wiz-opt" onclick={() => choose(item)}>
                            <span class="wiz-opt-name">{item.name}</span>
                            <span class="wiz-opt-desc">{item.description}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {/each}

    {:else if step === 'setup'}
        {#if state.driver === 'time'}
            <!-- No watcher. A clock-driven job has no interval to poll, no
                 baseline and no host, so this step is the schedule and nothing
                 else — using the same control the schedule screen uses. -->
            <p class="sch-note">{t('wiz.time.hint')}</p>
            <ScheduleFields bind:value={state.schedule} idPrefix="wiz" />
        {:else}
            <p class="sch-note">{recipe?.description || ''}</p>
            <div class="wiz-grid">
                <div class="sch-field wiz-wide">
                    <label for="wiz-wname">{t('wiz.watcherName')}</label>
                    <input id="wiz-wname" type="text" class="sch-input" bind:value={state.watcherName} />
                </div>
                <!-- The form IS the recipe, INCLUDING its widths: a host or a
                     port sits in one column, a URL spans. Spanning everything
                     turned an eight-field recipe into a screenful of scrolling
                     with an empty right half. -->
                {#each recipe?.fields || [] as f (f.key)}
                    <div class="sch-field" class:wiz-wide={f.wide}>
                        <label for={`wiz-f-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                        {#if f.type === 'secret'}
                            <input id={`wiz-f-${f.key}`} type="password" class="sch-input"
                                bind:value={state.secrets[f.key]} placeholder={f.placeholder} />
                        {:else if f.type === 'boolean'}
                            <label class="trg-check">
                                <input id={`wiz-f-${f.key}`} type="checkbox" bind:checked={state.values[f.key]} />
                                <span>{f.label}</span>
                            </label>
                        {:else if f.type === 'select'}
                            <select id={`wiz-f-${f.key}`} class="sch-select" bind:value={state.values[f.key]}>
                                {#each f.options || [] as [val, text] (val)}
                                    <option value={val}>{text}</option>
                                {/each}
                            </select>
                        {:else if f.type === 'path'}
                            <div class="trg-row">
                                <input id={`wiz-f-${f.key}`} type="text" class="sch-input trg-grow"
                                    bind:value={state.values[f.key]} placeholder={f.placeholder} />
                                <button type="button" class="btn btn-secondary trg-browse"
                                    onclick={() => browse(v => (state.values[f.key] = v))}>{@html icon('folder', 20)}</button>
                            </div>
                        {:else}
                            <input id={`wiz-f-${f.key}`} type={f.type === 'number' ? 'number' : 'text'}
                                class="sch-input" bind:value={state.values[f.key]} placeholder={f.placeholder} />
                        {/if}
                        {#if f.hint}<span class="sch-note">{f.hint}</span>{/if}
                    </div>
                {/each}
                <div class="sch-field">
                    <label for="wiz-every">{t('wiz.every')}</label>
                    <input id="wiz-every" type="number" min="10" class="sch-input" bind:value={state.everySeconds} />
                </div>
                <div class="sch-field">
                    <label for="wiz-event">{t('wiz.eventName')}</label>
                    <input id="wiz-event" type="text" class="sch-input" bind:value={state.eventName} />
                </div>
                <!-- Where this will send what it is given. A recipe is a file
                     someone can hand you, and the host is visible nowhere else. -->
                <div class="sch-field wiz-wide">
                    <span class="sch-label">{t('wch.reach')}</span>
                    {#if hosts.length}
                        <ul class="wch-fields">{#each hosts as h (h)}<li><code>{h}</code></li>{/each}</ul>
                    {:else}
                        <span class="sch-note">{t('wch.reach.none')}</span>
                    {/if}
                </div>
            </div>
        {/if}

    {:else}
        <p class="sch-note">{t('wiz.work.hint')}</p>
        <div class="wiz-grid">
            {#if state.driver === 'time' && templates.length}
                <!-- The clock presets, as what they are: ready-made WORK. They
                     used to sit in step 1, where they read as "choose weekly or
                     monthly" — a question step 2 already asks properly. -->
                <div class="sch-field wiz-wide">
                    <label for="wiz-tpl">{t('wiz.tpl')}</label>
                    <select id="wiz-tpl" class="sch-select" onchange={(e) => useTemplate(e.currentTarget.value)}>
                        <option value="">{t('wiz.tpl.none')}</option>
                        {#each templates as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
                    </select>
                    {#if templateNote}<span class="sch-note">{templateNote}</span>{/if}
                </div>
            {/if}
            <div class="sch-field">
                <label for="wiz-name">{t('jobs.name')}</label>
                <input id="wiz-name" type="text" class="sch-input" bind:value={state.job.name} />
            </div>
            <div class="sch-field">
                <label for="wiz-purpose">{t('jobs.purpose')}</label>
                <input id="wiz-purpose" type="text" class="sch-input"
                    placeholder={t('jobs.purpose.ph')} bind:value={state.job.purpose} />
            </div>
            <div class="sch-field wiz-wide">
                <label for="wiz-prompt">{t('trig.prompt')}</label>
                <textarea id="wiz-prompt" class="sch-textarea" rows="6" bind:value={state.job.prompt}></textarea>
                {#if fields.length}
                    <details class="wiz-vars">
                        <summary>{t('wiz.vars')}</summary>
                        <ul class="wch-fields">
                            {#each fields as [name, desc] (name)}
                                <li><code>{`{{payload.${name}}}`}</code> — {desc}</li>
                            {/each}
                        </ul>
                    </details>
                {/if}
            </div>
            <div class="sch-field wiz-wide">
                <label for="wiz-ws">{t('trig.workspace')}</label>
                <div class="trg-row">
                    <select id="wiz-ws" class="sch-select trg-grow" bind:value={state.job.workspacePath}>
                        <option value="">{t('trig.workspace.none')}</option>
                        {#if state.job.workspacePath && !projects.includes(state.job.workspacePath)}
                            <option value={state.job.workspacePath}>{state.job.workspacePath}</option>
                        {/if}
                        {#each projects as p (p)}<option value={p}>{p}</option>{/each}
                    </select>
                    <button type="button" class="btn btn-secondary trg-browse"
                        onclick={() => browse(v => (state.job.workspacePath = v))}>{@html icon('folder', 20)}</button>
                </div>
            </div>
            <div class="sch-field">
                <label for="wiz-agent">{t('trig.agent')}</label>
                <select id="wiz-agent" class="sch-select" bind:value={state.job.agentModeId}>
                    <option value={null}>{modeName(AGENT_MODES[DEFAULT_MODE_ID])}</option>
                    {#each agentModes as m (m.id)}<option value={m.id}>{modeName(m)}</option>{/each}
                </select>
            </div>
            <div class="sch-field">
                <label for="wiz-cap">{t('wiz.maxPerHour')}</label>
                <input id="wiz-cap" type="number" min="1" class="sch-input" bind:value={state.job.maxPerHour} />
            </div>
            <p class="sch-note wiz-wide">{t('wiz.summary')}</p>
        </div>
    {/if}
    </div>

    {#if problems.length}
        <ul class="rec-problems">{#each problems as p, i (i)}<li>{p}</li>{/each}</ul>
    {/if}

    <div class="wiz-foot">
        <button class="btn btn-secondary" onclick={back}>
            {stepIndex <= 0 ? t('jobs.cancel') : t('wiz.back')}
        </button>
        {#if step === 'work'}
            <button class="btn btn-primary" disabled={saving || problems.length > 0} onclick={finish}>{t('wiz.finish')}</button>
        {:else if step !== 'start'}
            <button class="btn btn-primary" disabled={problems.length > 0} onclick={next}>{t('wiz.next')}</button>
        {/if}
    </div>
  </div>
</div>

<style>
    /* The card sits in the middle of however wide the window is. */
    .wiz-shell { flex: 1; overflow: auto; padding: 8px 0 24px; display: flex; justify-content: center; }
    .wiz {
        width: 100%; max-width: 720px; align-self: flex-start;
        display: flex; flex-direction: column; gap: 14px;
        background: var(--surface-panel); border: 1px solid var(--line);
        border-radius: var(--r-3); padding: 18px 22px 16px;
    }
    .wiz-body { display: flex; flex-direction: column; gap: 12px; }
    /* Two columns of short fields; `wiz-wide` spans both. */
    .wiz-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
    .wiz-wide { grid-column: 1 / -1; }
    @media (max-width: 640px) { .wiz-grid { grid-template-columns: 1fr; } }

    .wiz-steps { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .wiz-step {
        display: inline-flex; align-items: center; gap: 7px;
        color: var(--ink-faint); font-size: var(--fs-sm);
    }
    .wiz-step.active { color: var(--ink); font-weight: 600; }
    .wiz-num {
        display: inline-grid; place-items: center; width: 21px; height: 21px;
        border-radius: 50%; background: var(--surface-sunken); color: var(--ink-soft);
        font-size: 11px;
    }
    .wiz-step.active .wiz-num { background: var(--accent); color: var(--on-accent); }
    .wiz-step.done .wiz-num { background: var(--accent-surface); color: var(--accent); }

    .wiz-group { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--ink-soft); }
    /* Cards, two across: the whole list fits without scrolling. */
    .wiz-options {
        list-style: none; margin: 0; padding: 0;
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    }
    @media (max-width: 640px) { .wiz-options { grid-template-columns: 1fr; } }
    .wiz-opt {
        width: 100%; height: 100%; text-align: left; display: grid; gap: 3px; align-content: start;
        padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-2);
        background: var(--surface-raised); cursor: pointer;
    }
    .wiz-opt:hover { border-color: var(--accent); background: var(--accent-surface); }
    .wiz-opt-name { font-weight: 600; }
    .wiz-opt-desc { color: var(--ink-soft); font-size: var(--fs-sm); line-height: 1.4; }

    .wiz-vars summary { cursor: pointer; font-size: var(--fs-sm); color: var(--ink-soft); }
    .wiz-foot { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
</style>
