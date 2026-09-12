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
    import { untrack } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { SlashCommands } from '../../components/SlashCommands.js';
    import { icon } from '../../utils/icons.js';
    import { AGENT_MODES, DEFAULT_MODE_ID, modeName } from '../../../modules/ai/AgentModes.js';
    import { recipeRegistry } from '../../../modules/ai/triggers/RecipeRegistry.js';
    import { watcherManager, fieldSecretId } from '../../../modules/ai/triggers/WatcherManager.js';
    import { jobManager } from '../../../modules/ai/jobs/JobManager.js';
    import { skillManager } from '../../../modules/ai/SkillManager.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { recipeHosts, payloadFields } from '../../../modules/ai/triggers/recipes/recipeFormat.js';
    import ScheduleFields from '../schedule/ScheduleFields.svelte';
    import JobCatalog from './JobCatalog.svelte';
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
    // 'catalog' is where the wizard OPENS. It is not a fourth step — the
    // indicator still shows three — because it asks a different kind of
    // question: not "which of these three am I on" but "do you know what you
    // want yet". Answering it either picks a template (and lands on step 2 with
    // both halves filled) or hands over to the trigger list unchanged.
    let step = $state('catalog');
    let state = $state(initialState(null));
    let projects = $state([]);
    let configuredMcp = $state([]);
    // The skills that exist, for chip titles. The "/" popup reads the managers
    // directly; this copy is only so a pinned skill shows its title rather than
    // its file name, and so one that no longer exists can say so.
    let skills = $state([]);
    let saving = $state(false);

    // Step 3's prompt box works like the task composer's: "/" expands a prompt
    // template or attaches a skill. Same helper, same behaviour — a second way
    // of picking the same two things (a select and a checkbox list) was one
    // more thing to learn for no difference in what it does.
    let promptEl = $state(null);
    let popupEl = $state(null);
    let chipsEl = $state(null);
    let slash = null;
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
            // Which MCP servers are configured, so a card can say what is
            // missing instead of failing on its first run.
            let mcp = config.mcp_servers;
            try { if (typeof mcp === 'string') mcp = JSON.parse(mcp); } catch (_) { mcp = null; }
            if (mcp && mcp.mcpServers) mcp = mcp.mcpServers;
            configuredMcp = mcp && typeof mcp === 'object' ? Object.keys(mcp) : [];
            try { promptTemplateManager.loadFromConfig(config); } catch (_) { /* none */ }
            let found = [];
            try { found = (await skillManager.refresh()) || []; } catch (_) { found = []; }
            if (!alive) return;
            skills = found;
            // Titles arrived after the chips were drawn from bare names.
            slash?.setSkills(skillChips(state.job.skills));
        })();
        return () => { alive = false; };
    });

    /**
     * The job's pinned skills as chips.
     *
     * A name with no skill behind it keeps its chip, marked, rather than being
     * dropped: a preset can pin a skill this machine does not have, and a job
     * saved still pinning it would refuse every run over a name nothing on
     * screen mentions.
     */
    function skillChips(names = []) {
        return (names || []).map((name) => {
            const s = skills.find(x => x.name === name);
            if (s) return { name, title: s.title || name };
            return { name, title: skills.length ? `${name}（${t('jobs.skills.missing')}）` : name };
        });
    }

    // The popup lives only while step 3 is on screen; going Back unmounts the
    // textarea and this tears it down with it.
    $effect(() => {
        if (!promptEl || !popupEl || !chipsEl) return;
        const sc = new SlashCommands(promptEl, popupEl, chipsEl, {
            // The chips ARE the job's skill list. Only names are kept: the body
            // is read when the job runs, so an edit in the Skills tab reaches
            // the next run instead of a copy taken today.
            onSkillsChange: (list) => { state.job.skills = list.map(s => s.name); },
        });
        slash = sc;
        // Untracked: this effect is about the ELEMENTS. Reading the skill list
        // here would re-create the helper every time a chip is added.
        untrack(() => sc.setSkills(skillChips(state.job.skills)));
        return () => { sc.destroy(); if (slash === sc) slash = null; };
    });

    const groups = $derived(startOptions(recipes));
    const option = $derived(findOption(recipes, state.optionId));
    const recipe = $derived(option?.recipe || null);
    const problems = $derived(stepProblems(step, state, option));
    const stepIndex = $derived(STEPS.indexOf(step));
    /** The entry screen sits before step 1, so the dots read as "not started". */
    const shownIndex = $derived(step === 'catalog' ? -1 : stepIndex);
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

    /**
     * A catalogue card is an option that already knows its work.
     *
     * For a clock template the schedule and the prompt both come from the
     * recipe, so `applyTemplate` runs too and step 2 opens on a filled-in form
     * rather than a default one.
     */
    function pickCard(card) {
        const option = findOption(recipes, card.id);
        if (!option) return;
        state = initialState(option);
        if (card.recipe?.schedule) state = applyTemplate(state, card.recipe);
        templateNote = card.missingMcp?.length
            ? t('wiz.mcp.missing', { names: card.missingMcp.join(', ') })
            : '';
        step = 'setup';
    }

    function next() {
        if (problems.length) return;
        step = STEPS[Math.min(STEPS.length - 1, stepIndex + 1)];
    }
    function back() {
        if (step === 'catalog') { onCancel(); return; }
        // Step 1 goes back to the catalogue, not out of the wizard: someone who
        // opened "自分で作る" by mistake should not have to start over.
        if (stepIndex <= 0) { step = 'catalog'; return; }
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
        // The template replaced the skills along with the prompt; the chips
        // are drawn by the helper, which cannot see `state` change.
        slash?.setSkills(skillChips(state.job.skills));
    }

    /**
     * Every server worth a checkbox: the configured ones, plus any the job
     * already names that are NOT configured.
     *
     * The second half matters. A template that needs "backlog" on a machine
     * without it would otherwise show no box at all — and the job would be
     * saved still asking for a server nothing on screen mentions.
     */
    const mcpChoices = $derived([...new Set([...configuredMcp, ...(state.job.mcpServers || [])])]);

    /** Tick or untick one MCP server, keeping `[]` for "none". */
    function toggleMcp(name, on) {
        const cur = new Set(state.job.mcpServers || []);
        if (on) cur.add(name); else cur.delete(name);
        state.job.mcpServers = [...cur];
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
            <span class="wiz-step" class:active={s === step} class:done={shownIndex >= 0 && i < shownIndex}>
                <span class="wiz-num">{i + 1}</span>{t(`wiz.step.${s}`)}
            </span>
        {/each}
    </div>

    <div class="wiz-body">
    {#if step === 'catalog'}
        <JobCatalog {recipes} {configuredMcp}
            onPick={pickCard} onCustom={() => (step = 'start')} />

    {:else if step === 'start'}
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
            {#if templateNote}<p class="rec-lock">{templateNote}</p>{/if}
            <ScheduleFields bind:value={state.schedule} idPrefix="wiz" />
        {:else}
            <p class="sch-note">{recipe?.description || ''}</p>
            {#if templateNote}<p class="rec-lock">{templateNote}</p>{/if}
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
                <label for="wiz-prompt">{t('trig.prompt')} <span class="wiz-slash-hint">{t('wiz.prompt.slash')}</span></label>
                <!-- Chips are the job's pinned skills; the popup opens above
                     the box when it starts with "/". Both are drawn by the
                     same helper the task composer uses. -->
                <!-- A preset fills this box, and people read a filled box as
                     fixed. It is the one field that decides what the job
                     actually does, so it says outright that it is theirs. -->
                {#if state.job.prompt}
                    <span class="sch-note">{t('wiz.prompt.editable')}</span>
                {/if}
                <div class="sc-chips wiz-chips" bind:this={chipsEl}></div>
                <div class="wiz-prompt-wrap">
                    <div class="slash-popup wiz-slash" bind:this={popupEl}></div>
                    <textarea id="wiz-prompt" class="sch-textarea" rows="6" bind:this={promptEl}
                        bind:value={state.job.prompt}></textarea>
                </div>
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
            <!-- Which OUTSIDE systems the work may touch — none unless ticked.
                 Kept as a list rather than a "/" command: a server is not
                 something you write into the prompt, it is a permission. -->
            <fieldset class="fld-group wiz-wide wiz-tools">
                <legend>{t('wiz.tools')}</legend>

                <span class="sch-label">{t('jobs.mcp')}</span>
                <span class="sch-note">{t('jobs.mcp.hint')}</span>
                {#if !mcpChoices.length}
                    <span class="sch-note">{t('jobs.mcp.none')}</span>
                {:else}
                    <div class="wiz-checks">
                        {#each mcpChoices as name (name)}
                            <label class="trg-check">
                                <input type="checkbox"
                                    checked={(state.job.mcpServers || []).includes(name)}
                                    onchange={(e) => toggleMcp(name, e.currentTarget.checked)} />
                                <span>{name}</span>
                                {#if !configuredMcp.includes(name)}
                                    <span class="rec-lock">{t('wiz.mcp.unset')}</span>
                                {/if}
                            </label>
                        {/each}
                    </div>
                {/if}
            </fieldset>

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
            {step === 'catalog' ? t('jobs.cancel') : t('wiz.back')}
        </button>
        {#if step === 'work'}
            <button class="btn btn-primary" disabled={saving || problems.length > 0} onclick={finish}>{t('wiz.finish')}</button>
        {:else if step !== 'start' && step !== 'catalog'}
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
    /* The popup is positioned against this box (it opens ABOVE the textarea,
       as in the task composer) and starts hidden until "/" is typed. */
    .wiz-prompt-wrap { position: relative; display: flex; flex-direction: column; }
    .wiz-slash { display: none; }
    .wiz-chips { margin: 2px 0 0; }
    .wiz-slash-hint { font-weight: normal; color: var(--ink-faint); font-size: var(--fs-sm); }
    .wiz-tools { display: flex; flex-direction: column; gap: 4px; }
    .wiz-tools .sch-label { margin-top: 6px; }
    /* Checkboxes flow in rows: eight skills one per line pushed the Create
       button a screen away. */
    .wiz-checks { display: flex; flex-wrap: wrap; gap: 4px 16px; }
    .wiz-foot { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
</style>
