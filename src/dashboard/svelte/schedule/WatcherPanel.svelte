<!--
  WatcherPanel — the sources that produce events, above the rules that act on
  them.

  Kept separate from TriggerPanel because they answer different questions: a
  watcher is "what am I looking at", a trigger is "what do I do about it". One
  watcher can feed several triggers, and an event that matches no trigger is
  still worth seeing — that is the only way to answer "why didn't it fire?".
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { watcherManager, secretIdFor, authSecretIdFor, fieldSecretId, WatcherManager }
        from '../../../modules/ai/triggers/WatcherManager.js';
    import { payloadFieldsFor } from '../../../modules/ai/triggers/WatcherEngine.js';
    import { recipeRegistry } from '../../../modules/ai/triggers/RecipeRegistry.js';
    import { defaultValues, missingRequired, recipeHosts, resolveConfig }
        from '../../../modules/ai/triggers/recipes/recipeFormat.js';
    import { scriptRefusal } from '../../../modules/ai/triggers/recipes/scriptContract.js';

    let {
        manager = watcherManager,
        registry = recipeRegistry,
        confirmDelete = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
    } = $props();

    let watchers = $state(untrack(() => manager.reload()));
    let editingId = $state(null);
    let draft = $state(null);
    let busy = $state(false);

    // The recipes on offer. A recipe is a named configuration of an engine that
    // already exists — see docs/design/watcher-recipes.md — so this list is what
    // used to be the hard-coded type dropdown, plus whatever the user has put in
    // the watchers folder.
    let recipes = $state([]);
    // One value per recipe field, minus the secrets: those go straight to the
    // OS credential store and this object never holds them.
    let values = $state({});
    // Which secret fields already have something stored, so the form can say
    // "stored" instead of showing an empty box that looks unsaved.
    let storedSecrets = $state(new Set());
    // Typed secrets, in flight between the keyboard and the credential store.
    let secretDrafts = $state({});
    // The user has read what this recipe talks to and what it runs.
    let reviewed = $state(false);

    // Read once, on mount: the registry is a prop that does not change, and the
    // recipes on disk are re-read by `refresh()` rather than by re-rendering.
    untrack(() => registry).refresh()
        .then((list) => { recipes = list; })
        .catch(() => { recipes = untrack(() => registry).getAll(); });

    const recipe = $derived(draft?.recipeId ? recipes.find(r => r.id === draft.recipeId) : null);

    /** Everything this watcher will talk to, once the form is filled in. */
    const hosts = $derived(recipe ? recipeHosts(recipe, values) : []);

    /** The command a script recipe will run, with the fields substituted. */
    const scriptCommand = $derived(
        recipe?.engine === 'script' || recipe?.engine === 'command'
            ? String(resolveConfig(recipe, values).command || '')
            : '');

    /**
     * A recipe the user has to sign off on before it can be saved.
     *
     * Not every recipe: the four that ship with the app are our code, reviewed
     * like the rest of it. A file someone sent you, and anything that executes,
     * is a different question — and asking it on every save would train people
     * to click past it.
     */
    const needsReview = $derived(!!recipe && (!recipe.builtin || recipe.engine === 'script'));

    async function loadRecipeSecrets(watcherId, r) {
        const found = new Set();
        for (const f of r?.fields || []) {
            if (f.type !== 'secret') continue;
            try {
                if (await invoke('has_watcher_secret', { id: fieldSecretId(watcherId, f.key) })) {
                    found.add(f.key);
                }
            } catch (_) { /* nothing stored */ }
        }
        storedSecrets = found;
    }

    // The mailbox password is typed here and goes STRAIGHT to the OS credential
    // store — never into `draft`, never into the watcher JSON. The form only
    // ever learns whether one exists.
    let password = $state('');
    let hasSecret = $state(false);
    // Same rule for the HTTP auth header's value: it is a credential, so it
    // goes to the OS store and the form only learns whether one exists.
    let authValue = $state('');
    let hasAuth = $state(false);

    async function loadSecretState(id) {
        try { hasSecret = await invoke('has_watcher_secret', { id: secretIdFor(id) }); }
        catch (_) { hasSecret = false; }
        try { hasAuth = await invoke('has_watcher_secret', { id: authSecretIdFor(id) }); }
        catch (_) { hasAuth = false; }
    }

    const selected = $derived(
        draft && draft.id === editingId ? draft : (watchers.find(w => w.id === editingId) || null)
    );

    function refresh() {
        watchers = [...manager.watchers];
        // The jobs match against these; a rename here has to reach them.
        import('../../../modules/ai/jobs/JobManager.js')
            .then(({ jobManager }) => jobManager.refreshSources())
            .catch(() => { /* jobs layer absent in tests */ });
    }

    /** Start a watcher from a recipe — the normal way to make one now. */
    function onNewRecipe() {
        const first = recipes[0];
        draft = {
            id: `wch_${Date.now()}`, name: '', enabled: false,
            recipeId: first?.id || '', values: {}, type: first?.engine || '',
            everySeconds: first?.defaults.everySeconds || 300,
            eventName: first?.defaults.eventName || '',
        };
        values = defaultValues(first);
        secretDrafts = {};
        storedSecrets = new Set();
        reviewed = false;
        editingId = draft.id;
    }

    /**
     * Slack is not a recipe, and pretending otherwise would be a lie about how
     * it works: it holds a socket open rather than being polled, so it has no
     * interval, no baseline and no engine to configure. It stays in the picker
     * because from the user's side it is one more thing being watched — the
     * distinction is transport, and splitting the UI by transport is the
     * mistake the job redesign already undid.
     */
    const SLACK_OPTION = '__slack';

    /**
     * The picker is ONE control with two groups.
     *
     * It used to be two controls that swapped places: choosing Slack left
     * `recipeId` empty, so re-opening the watcher showed the "type" select
     * instead of the "recipe" select — a different list of different things
     * under a different label, for the same watcher. And within the one list,
     * "URL の監視" sat beside "GitHub Actions が落ちた": a tool and one of its
     * uses, offered as if they were the same kind of choice.
     *
     * Grouping says which is which instead of leaving it to be inferred.
     */
    const basicRecipes = $derived(recipes.filter(r => r.basic));
    const presetRecipes = $derived(recipes.filter(r => !r.basic));

    /** What the single picker is currently showing. */
    const pickerValue = $derived(
        draft?.type === 'slack' && !draft?.recipeId ? SLACK_OPTION : (draft?.recipeId || '')
    );

    function onPick(e) {
        if (!draft) return;
        draft.recipeId = e.currentTarget.value;
        onRecipeChange();
    }

    /** Switching recipe replaces the form, so the old values must not linger. */
    function onRecipeChange() {
        if (draft?.recipeId === SLACK_OPTION) {
            const { id, name } = draft;
            onNew();
            draft.id = id;
            draft.name = name;
            draft.type = 'slack';
            draft.recipeId = '';
            draft.eventName = 'slack.message';
            editingId = id;
            return;
        }
        const r = recipes.find(x => x.id === draft?.recipeId);
        if (!r || !draft) return;
        values = defaultValues(r);
        secretDrafts = {};
        storedSecrets = new Set();
        reviewed = false;
        draft.type = r.engine;
        draft.everySeconds = r.defaults.everySeconds;
        draft.eventName = r.defaults.eventName;
    }

    function onNew() {
        draft = {
            id: `wch_${Date.now()}`, name: '', enabled: false, type: 'folder',
            path: '', recursive: true, everySeconds: 300, eventName: 'file.changed',
            command: '', cwd: '',
            host: '', port: 993, user: '', folder: 'INBOX',
            mailFrom: '', mailSubject: '', unseenOnly: true,
            url: '', watchPath: '', equals: '', aggregate: '', filterField: '', filterExclude: '',
            slackChannels: '', slackUsers: '',
            watchRegex: '', headerName: '',
        };
        password = '';
        authValue = '';
        hasSecret = false;
        hasAuth = false;
        editingId = draft.id;
    }

    function select(w) { editingId = w.id; draft = null; }
    function startEdit(w) {
        editingId = w.id;
        draft = { ...w };
        password = '';
        authValue = '';
        secretDrafts = {};
        if (w.recipeId) {
            const r = recipes.find(x => x.id === w.recipeId);
            values = { ...defaultValues(r), ...(w.values || {}) };
            storedSecrets = new Set();
            // Editing re-opens the question. The recipe file may have been
            // replaced since it was approved, and saving is what re-approves it.
            reviewed = false;
            loadRecipeSecrets(w.id, r);
        } else {
            loadSecretState(w.id);
        }
    }

    /**
     * Save a recipe-backed watcher.
     *
     * The order matters: credentials first, then the watcher, then the
     * approval. An approval recorded before the values were stored would cover
     * a configuration that does not exist yet, and the first poll would refuse
     * itself with a message about a change nobody made.
     */
    async function saveRecipeDraft() {
        const missing = missingRequired(recipe, values, storedSecrets);
        for (const f of missing) {
            if (secretDrafts[f.key]) continue;      // typed just now, not yet stored
            notify(t('wch.required', { field: f.label }, `${f.label} を入れてください。`));
            return;
        }
        if (needsReview && !reviewed) { notify(t('wch.review.required')); return; }
        if (scriptCommand) {
            const refusal = scriptRefusal(scriptCommand);
            if (refusal) { notify(refusal); return; }
        }

        for (const [key, value] of Object.entries(secretDrafts)) {
            if (!value) continue;
            try { await invoke('set_watcher_secret', { id: fieldSecretId(draft.id, key), password: value }); }
            catch (e) { notify(String(e?.message || e)); return; }
        }

        const secretKeys = new Set(recipe.fields.filter(f => f.type === 'secret').map(f => f.key));
        const stored = {};
        for (const [k, v] of Object.entries(values)) if (!secretKeys.has(k)) stored[k] = v;

        manager.upsert({
            id: draft.id, name: draft.name, enabled: draft.enabled,
            recipeId: recipe.id, values: stored, type: recipe.engine,
            everySeconds: Number(draft.everySeconds) || recipe.defaults.everySeconds,
            eventName: draft.eventName || recipe.defaults.eventName,
        });
        // What the user just looked at: the recipe's contents and the hosts it
        // will reach. Re-checked before every poll, so a file swapped later
        // stops instead of running.
        await registry.approve(draft.id, recipe, stored);
        secretDrafts = {};
        draft = null;
        refresh();
    }

    async function onSave() {
        if (!draft) return;
        if (draft.recipeId) {
            if (!recipe) { notify(t('wch.recipe.missing')); return; }
            if (!String(draft.eventName || '').trim()) { notify(t('wch.eventName')); return; }
            await saveRecipeDraft();
            return;
        }
        if (draft.type === 'folder' && !String(draft.path || '').trim()) { notify(t('wch.path')); return; }
        if (draft.type === 'command' && !String(draft.command || '').trim()) { notify(t('wch.command')); return; }
        if (draft.type === 'mail' && !String(draft.host || '').trim()) { notify(t('wch.host')); return; }
        if (draft.type === 'slack' && !password && !hasSecret) { notify(t('wch.slack.token')); return; }
        if (draft.type === 'http' && !String(draft.url || '').trim()) { notify(t('wch.url')); return; }
        if (!String(draft.eventName || '').trim()) { notify(t('wch.eventName')); return; }

        // Written before the watcher, and stripped from what is stored. A
        // password that reaches localStorage is a password in a backup.
        if ((draft.type === 'mail' || draft.type === 'slack') && password) {
            try {
                await invoke('set_watcher_secret', { id: secretIdFor(draft.id), password });
                hasSecret = true;
            } catch (e) {
                notify(String(e?.message || e));
                return;
            }
        }
        if (draft.type === 'http' && authValue) {
            try {
                await invoke('set_watcher_secret', { id: authSecretIdFor(draft.id), password: authValue });
                hasAuth = true;
            } catch (e) { notify(String(e?.message || e)); return; }
        }
        // Neither credential is written with the watcher. `headerValue` is
        // stripped as well as `password`: it used to be saved in the clear.
        const { password: _pw, headerValue: _hv, ...safe } = draft;
        manager.upsert(safe);
        password = '';
        authValue = '';
        draft = null;
        refresh();
    }

    function onDelete(id) {
        if (!confirmDelete(`"${watchers.find(w => w.id === id)?.name || id}" を削除しますか？`)) return;
        manager.remove(id);
        // An approval outliving its watcher would be inherited by the next one
        // to be given the same id, which is exactly the check being skipped.
        registry.revoke(id);
        if (editingId === id) { editingId = null; draft = null; }
        refresh();
    }

    function toggle(w) { manager.setEnabled(w.id, !w.enabled); refresh(); }

    /** Folder picker for a recipe field declared as a path. */
    async function browseInto(key) {
        try {
            const sel = await invoke('select_folder');
            if (sel) values = { ...values, [key]: sel };
        } catch (_) { /* cancelled */ }
    }

    async function browse() {
        try {
            const sel = await invoke('select_folder');
            if (sel && draft) draft[draft.type === 'command' ? 'cwd' : 'path'] = sel;
        } catch (_) { /* cancelled */ }
    }

    /**
     * Check now, and say which of the three things happened.
     *
     * "0" covered all of: the first look (which records a baseline and is
     * SUPPOSED to find nothing), a poll that saw no change, and a watcher that
     * was never even reached. Reporting one number for three outcomes is why a
     * watcher that had never run looked the same as one working correctly.
     */
    async function runNow(w) {
        busy = true;
        try {
            const r = await manager.runNow(w.id);
            refresh();
            if (!r.ok) { notify(t('wch.ran.failed', { why: r.error })); return; }
            if (r.note === 'baseline') { notify(t('wch.ran.baseline')); return; }
            notify(r.events.length
                ? t('wch.ran.found', { n: r.events.length })
                : t('wch.ran.none'));
        } catch (e) {
            notify(String(e?.message || e));
        } finally { busy = false; }
    }

    const TYPE_LABEL = () => ({
        folder: t('wch.type.folder'), command: t('wch.type.command'),
        mail: t('wch.type.mail'), http: t('wch.type.http'),
        slack: t('wch.type.slack'),
    });

    function summary(w) {
        if (w.recipeId) {
            const r = recipes.find(x => x.id === w.recipeId);
            // The first filled-in field is what distinguishes two watchers made
            // from the same recipe — "GitHub Actions が落ちた" twice tells you
            // nothing about which repository each is watching.
            const first = Object.values(w.values || {}).find(v => v !== '' && v !== null && v !== undefined);
            return `${r?.name || w.recipeId} · ${first ?? ''}`;
        }
        const kind = TYPE_LABEL()[w.type] || w.type;
        const what = {
            folder: w.path, command: w.command, http: w.url,
            mail: `${w.user}@${w.host}`,
            slack: w.slackChannels || t('wch.slack.channels'),
        }[w.type] || '';
        return `${kind} · ${what}`;
    }

    /**
     * The `{{payload.…}}` fields this watcher's events carry.
     *
     * A recipe declares its own, next to the config that produces them — which
     * is the point of moving the list there: the table that used to live in
     * WatcherEngine could drift from what was actually emitted, and a documented
     * field that is not emitted is worse than none, because the prompt keeps the
     * placeholder instead of the value.
     */
    function emitsOf(w) {
        if (w.recipeId) {
            const r = recipes.find(x => x.id === w.recipeId);
            if (r?.payload?.length) return r.payload;
        }
        return payloadFieldsFor(w.type);
    }

    /**
     * The value this watcher is currently holding, when it has one.
     *
     * Only the scalar sources have something a person can read at a glance; a
     * folder's baseline is a map of every file's mtime, which is data, not an
     * answer.
     */
    function currentValue(w) {
        const v = w?.baseline?.value;
        if (v === undefined || v === null || typeof v === 'object') return null;
        return String(v);
    }

    /** The recipe (or base type) this watcher was built from. */
    function recipeNameOf(w) {
        if (w?.recipeId) return recipes.find(r => r.id === w.recipeId)?.name || w.recipeId;
        return TYPE_LABEL()[w?.type] || w?.type || '';
    }

    /** How often it looks — or that it does not, because it is pushed. */
    function intervalOf(w) {
        // The manager's own list, not a copy: a second answer to "which
        // types are pushed" is the duplication this codebase keeps paying
        // for.
        if (WatcherManager.PUSH_TYPES.has(w?.type)) return t('wch.sec.push');
        return t('wch.sec.secs', { n: w?.everySeconds ?? '?' });
    }

    /**
     * The fields a watcher of this type keeps directly on itself.
     *
     * Recipes came later. Every watcher made before them — and Slack, which is
     * never a recipe — stores its configuration as plain fields, so reading
     * `values` alone showed those watchers nothing but their name and interval:
     * a settings panel with no settings in it.
     */
    const DIRECT_FIELDS = {
        http: [
            ['url', 'wch.url'], ['watchPath', 'wch.watchPath'],
            ['watchRegex', 'wch.watchRegex'], ['aggregate', 'wch.aggregate'],
            ['filterField', 'wch.filterField'], ['filterExclude', 'wch.filterExclude'],
            ['equals', 'wch.equals'], ['headerName', 'wch.auth.name'],
        ],
        folder: [['path', 'wch.path'], ['recursive', 'wch.recursive.short']],
        command: [['command', 'wch.command'], ['cwd', 'wch.cwd']],
        mail: [
            ['host', 'wch.host'], ['port', 'wch.port'], ['user', 'wch.user'],
            ['folder', 'wch.folder.short'], ['mailFrom', 'wch.mailFrom'],
            ['mailSubject', 'wch.mailSubject'], ['unseenOnly', 'wch.unseen.short'],
        ],
        slack: [['slackChannels', 'wch.slack.channels'], ['slackUsers', 'wch.slack.users']],
    };

    /** A value as a person reads it. Booleans are not "true". */
    function shown(v) {
        if (typeof v === 'boolean') return v ? t('wch.yes') : t('wch.no');
        return String(v);
    }

    /**
     * What this watcher is configured to do.
     *
     * A secret is reported as STORED, never shown: the value lives in the OS
     * credential store precisely so that nothing has to read it back to draw a
     * panel.
     */
    function settingRows(w) {
        const r = w?.recipeId ? recipes.find(x => x.id === w.recipeId) : null;
        if (r) {
            const vals = w.values || {};
            return r.fields
                .filter(f => f.type === 'secret' || (vals[f.key] !== undefined && vals[f.key] !== ''))
                .map(f => [f.label, f.type === 'secret' ? t('wch.sec.secret') : shown(vals[f.key])]);
        }
        const rows = (DIRECT_FIELDS[w?.type] || [])
            .filter(([key]) => w[key] !== undefined && w[key] !== '' && w[key] !== null)
            .map(([key, label]) => [t(label), shown(w[key])]);
        // The credentials these types hold, named but not read.
        if (w?.type === 'mail') rows.push([t('wch.password'), t('wch.sec.secret')]);
        if (w?.type === 'slack') rows.push([t('wch.slack.token'), t('wch.sec.secret')]);
        if (w?.type === 'http' && w.headerName) rows.push([t('wch.auth.value'), t('wch.sec.secret')]);
        return rows;
    }

    /** What happened last time — a watcher failing for days must not look quiet. */
    function status(w) {
        if (w.type === 'slack' && w.lastOk !== false) {
            // A pushed source has no "last check"; what matters is whether the
            // socket is up right now.
            return { text: w.connected ? t('wch.connected') : t('wch.disconnected'), bad: !w.connected };
        }
        if (!w.lastRunAt) return { text: t('wch.never'), bad: false };
        const when = new Date(w.lastRunAt).toLocaleString();
        if (w.lastOk === false) return { text: `${when} — ${w.lastError}`, bad: true };
        if (w.lastNote === 'baseline') return { text: `${when} — ${t('wch.baseline')}`, bad: false };
        return { text: `${when} — ${t('wch.found', { n: w.lastCount || 0 }, `${w.lastCount || 0} 件`)}`, bad: false };
    }
</script>

<div class="trg">
    <div class="trg-head">
        <div>
            <h2>{t('wch.title')}</h2>
            <p class="subtitle">{t('wch.subtitle')}</p>
        </div>
        <button class="btn btn-primary" onclick={onNewRecipe}>{t('wch.new')}</button>
    </div>

    <div class="trg-body">
        <ul class="trg-list">
            {#if !watchers.length}
                <li class="trg-empty">{t('wch.empty')}</li>
            {/if}
            {#each watchers as w (w.id)}
                <li class="trg-item" class:active={editingId === w.id}>
                    <button class="trg-pick" onclick={() => select(w)}>
                        <span class="trg-name">{w.name || w.id}</span>
                        <span class="trg-match">{summary(w)}</span>
                        {#if w.lastOk === false}
                            <span class="trg-stopped">{w.lastError}</span>
                        {:else if w.enabled && !w.lastRunAt}
                            <span class="trg-stopped">{t('wch.neverRan')}</span>
                        {/if}
                    </button>
                    <label class="trg-toggle">
                        <input type="checkbox" checked={w.enabled} onchange={() => toggle(w)} />
                        <span>{t('trig.enabled')}</span>
                    </label>
                </li>
            {/each}
        </ul>

        <div class="sch-detail-panel">
            {#if !selected}
                <div class="trg-empty">{t('wch.empty')}</div>
            {:else}
                <div class="sch-detail-header">
                    <span>{selected.name || '(untitled)'}</span>
                    <span class="sch-detail-next">{selected.type}</span>
                </div>
                <div class="sch-detail-body">
                {#if draft && draft.id === editingId}
                    <div class="trg-grid">
                        <div class="sch-field">
                            <label for="wch-name">{t('trig.name')}</label>
                            <input id="wch-name" type="text" class="sch-input" bind:value={draft.name} />
                        </div>
                        <div class="sch-field">
                            <label for="wch-recipe">{t('wch.watching')}</label>
                            <select id="wch-recipe" class="sch-select"
                                value={pickerValue} onchange={onPick}>
                                <optgroup label={t('wch.group.basic')}>
                                    {#each basicRecipes as r (r.id)}
                                        <option value={r.id}>{r.name}{r.builtin ? '' : ' ✎'}</option>
                                    {/each}
                                    <option value={SLACK_OPTION}>{t('wch.type.slack')}</option>
                                </optgroup>
                                {#if presetRecipes.length}
                                    <optgroup label={t('wch.group.recipe')}>
                                        {#each presetRecipes as r (r.id)}
                                            <option value={r.id}>{r.name}{r.builtin ? '' : ' ✎'}</option>
                                        {/each}
                                    </optgroup>
                                {/if}
                            </select>
                            {#if recipe?.description}
                                <span class="sch-note">{recipe.description}</span>
                            {/if}
                        </div>

                        {#if draft.recipeId}
                            <!-- The form IS the recipe. Every field below is
                                 declared in the recipe file, which is what
                                 stopped the preset list from being a growing
                                 chain of {#if type === …} branches in here. -->
                            <div class="sch-field trg-span">
                                <span class="sch-note">{recipe?.description || ''}</span>
                                {#each registry.problemsFor(draft.recipeId) as problem}
                                    <span class="trg-stopped">{problem}</span>
                                {/each}
                            </div>
                            {#each recipe?.fields || [] as f (f.key)}
                                <div class="sch-field" class:trg-span={f.type !== 'number' && f.type !== 'boolean'}>
                                    <label for={`wch-f-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                                    {#if f.type === 'secret'}
                                        <input id={`wch-f-${f.key}`} type="password" class="sch-input"
                                            bind:value={secretDrafts[f.key]}
                                            placeholder={storedSecrets.has(f.key) ? t('wch.password.stored') : f.placeholder} />
                                    {:else if f.type === 'boolean'}
                                        <label class="trg-check">
                                            <input id={`wch-f-${f.key}`} type="checkbox" bind:checked={values[f.key]} />
                                            <span>{f.label}</span>
                                        </label>
                                    {:else if f.type === 'select'}
                                        <select id={`wch-f-${f.key}`} class="sch-select" bind:value={values[f.key]}>
                                            {#each f.options || [] as [val, text] (val)}
                                                <option value={val}>{text}</option>
                                            {/each}
                                        </select>
                                    {:else if f.type === 'path'}
                                        <div class="trg-row">
                                            <input id={`wch-f-${f.key}`} type="text" class="sch-input trg-grow"
                                                bind:value={values[f.key]} placeholder={f.placeholder} />
                                            <button type="button" class="btn btn-secondary trg-browse"
                                                onclick={() => browseInto(f.key)}>{@html icon('folder', 20)}</button>
                                        </div>
                                    {:else}
                                        <input id={`wch-f-${f.key}`}
                                            type={f.type === 'number' ? 'number' : 'text'}
                                            class="sch-input" bind:value={values[f.key]}
                                            placeholder={f.placeholder} />
                                    {/if}
                                    {#if f.hint}<span class="sch-note">{f.hint}</span>{/if}
                                </div>
                            {/each}

                            <!-- Where this watcher will send what it is given.
                                 A recipe is a file someone can hand you; the
                                 host is the fact that decides whether to run
                                 it, and it is visible nowhere else. -->
                            <div class="sch-field trg-span">
                                <h4>{t('wch.reach')}</h4>
                                {#if hosts.length}
                                    <ul class="wch-fields">
                                        {#each hosts as h (h)}<li><code>{h}</code></li>{/each}
                                    </ul>
                                {:else}
                                    <span class="sch-note">{t('wch.reach.none')}</span>
                                {/if}
                                {#if scriptCommand}
                                    <h4>{t('wch.runs')}</h4>
                                    <pre class="trg-curl">{scriptCommand}</pre>
                                {/if}
                                {#if recipe?.script}
                                    <pre class="trg-curl wch-script">{recipe.script}</pre>
                                {/if}
                                {#if needsReview}
                                    <label class="trg-check">
                                        <input type="checkbox" bind:checked={reviewed} />
                                        <span>{t('wch.review')}</span>
                                    </label>
                                    <span class="sch-note">{t('wch.review.hint')}</span>
                                {/if}
                            </div>
                        {:else if draft.type === 'slack'}
                            <div class="sch-field trg-span">
                                <label for="wch-xapp">{t('wch.slack.token')}</label>
                                <input id="wch-xapp" type="password" class="sch-input"
                                    bind:value={password}
                                    placeholder={hasSecret ? t('wch.password.stored') : 'xapp-...'} />
                                <span class="sch-note">{t('wch.slack.token.hint')}</span>
                            </div>
                            <div class="sch-field">
                                <label for="wch-ch">{t('wch.slack.channels')}</label>
                                <input id="wch-ch" type="text" class="sch-input"
                                    bind:value={draft.slackChannels} placeholder="C0123ABCD" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-us">{t('wch.slack.users')}</label>
                                <input id="wch-us" type="text" class="sch-input"
                                    bind:value={draft.slackUsers} placeholder="U0123ABCD" />
                            </div>
                            <div class="sch-field trg-span">
                                <span class="sch-note">{t('wch.slack.filter.hint')}</span>
                                <span class="trg-stopped">{t('wch.slack.warn')}</span>
                            </div>
                        {:else if draft.type === 'mail'}
                            <div class="sch-field">
                                <label for="wch-host">{t('wch.host')}</label>
                                <input id="wch-host" type="text" class="sch-input"
                                    bind:value={draft.host} placeholder="imap.gmail.com" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-user">{t('wch.user')}</label>
                                <input id="wch-user" type="text" class="sch-input"
                                    bind:value={draft.user} placeholder="you@example.com" />
                            </div>
                            <div class="sch-field trg-span">
                                <label for="wch-pw">{t('wch.password')}</label>
                                <input id="wch-pw" type="password" class="sch-input"
                                    bind:value={password}
                                    placeholder={hasSecret ? t('wch.password.stored') : ''} />
                                <span class="sch-note">{t('wch.password.hint')}</span>
                            </div>
                            <div class="sch-field">
                                <label for="wch-from">{t('wch.mailFrom')}</label>
                                <input id="wch-from" type="text" class="sch-input"
                                    bind:value={draft.mailFrom} placeholder="alerts@example.com" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-subject">{t('wch.mailSubject')}</label>
                                <input id="wch-subject" type="text" class="sch-input"
                                    bind:value={draft.mailSubject} />
                            </div>
                            <div class="sch-field trg-span">
                                <label class="trg-check">
                                    <input type="checkbox" bind:checked={draft.unseenOnly} />
                                    <span>{t('wch.unseenOnly')}</span>
                                </label>
                                <span class="sch-note">{t('wch.readonly')}</span>
                            </div>
                        {:else if draft.type === 'http'}
                            <div class="sch-field trg-span">
                                <label for="wch-url">{t('wch.url')}</label>
                                <input id="wch-url" type="text" class="sch-input"
                                    bind:value={draft.url} placeholder="https://api.example.com/status" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-wpath">{t('wch.watchPath')}</label>
                                <input id="wch-wpath" type="text" class="sch-input"
                                    bind:value={draft.watchPath} placeholder="status" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-eq">{t('wch.equals')}</label>
                                <input id="wch-eq" type="text" class="sch-input"
                                    bind:value={draft.equals} placeholder="failure" />
                            </div>
                            <div class="sch-field">
                                <label for="wch-agg">{t('wch.aggregate')}</label>
                                <select id="wch-agg" class="sch-select" bind:value={draft.aggregate}>
                                    <option value="">{t('wch.aggregate.none')}</option>
                                    <option value="sum">{t('wch.aggregate.sum')}</option>
                                    <option value="count">{t('wch.aggregate.count')}</option>
                                    <option value="max">{t('wch.aggregate.max')}</option>
                                </select>
                            </div>
                            <div class="sch-field">
                                <label for="wch-ff">{t('wch.filterField')}</label>
                                <input id="wch-ff" type="text" class="sch-input"
                                    bind:value={draft.filterField} placeholder="name" />
                            </div>
                            <div class="sch-field trg-span">
                                <label for="wch-fx">{t('wch.filterExclude')}</label>
                                <input id="wch-fx" type="text" class="sch-input"
                                    bind:value={draft.filterExclude} placeholder="latest.json,.sig" />
                            </div>
                            <div class="sch-field trg-span">
                                <label for="wch-re">{t('wch.watchRegex')}</label>
                                <input id="wch-re" type="text" class="sch-input"
                                    bind:value={draft.watchRegex}
                                    placeholder="<count>(\d+)</count>" />
                                <span class="sch-note">{t('wch.watchRegex.hint')}</span>
                            </div>
                            <fieldset class="fld-group trg-span">
                                <legend>{t('wch.auth')}</legend>
                                <div class="trg-row">
                                    <input type="text" class="sch-input" bind:value={draft.headerName}
                                        placeholder="Authorization" aria-label={t('wch.auth.name')} />
                                    <input type="password" class="sch-input trg-grow" bind:value={authValue}
                                        placeholder={hasAuth ? t('wch.auth.stored') : 'Bearer …'}
                                        aria-label={t('wch.auth.value')} />
                                </div>
                                <span class="sch-note">{t('wch.auth.hint')}</span>
                            </fieldset>
                            <div class="sch-field trg-span">
                                <span class="sch-note">{t('wch.list.hint')}</span>
                                <span class="sch-note">{t('wch.equals.hint')}</span>
                            </div>
                        {:else if draft.type === 'folder'}
                            <div class="sch-field trg-span">
                                <label for="wch-path">{t('wch.path')}</label>
                                <div class="trg-row">
                                    <input id="wch-path" type="text" class="sch-input trg-grow"
                                        bind:value={draft.path} placeholder="C:/work/inbox" />
                                    <button type="button" class="btn btn-secondary trg-browse"
                                        onclick={browse}>{@html icon('folder', 20)}</button>
                                </div>
                                <label class="trg-check">
                                    <input type="checkbox" bind:checked={draft.recursive} />
                                    <span>{t('wch.recursive')}</span>
                                </label>
                            </div>
                        {:else}
                            <div class="sch-field trg-span">
                                <label for="wch-cmd">{t('wch.command')}</label>
                                <input id="wch-cmd" type="text" class="sch-input"
                                    bind:value={draft.command} placeholder="git ls-remote origin main" />
                            </div>
                            <div class="sch-field trg-span">
                                <label for="wch-cwd">{t('wch.cwd')}</label>
                                <div class="trg-row">
                                    <input id="wch-cwd" type="text" class="sch-input trg-grow" bind:value={draft.cwd} />
                                    <button type="button" class="btn btn-secondary trg-browse"
                                        onclick={browse}>{@html icon('folder', 20)}</button>
                                </div>
                            </div>
                        {/if}

                        {#if draft.type !== 'slack'}
                        <div class="sch-field">
                            <label for="wch-every">{t('wch.every')}</label>
                            <input id="wch-every" type="number" min="5" class="sch-input"
                                bind:value={draft.everySeconds} />
                        </div>
                        {/if}
                        <div class="sch-field">
                            <label for="wch-ev">{t('wch.eventName')}</label>
                            <input id="wch-ev" type="text" class="sch-input" bind:value={draft.eventName} />
                        </div>
                        <div class="sch-field trg-span">
                            <span class="sch-note">{t('wch.eventName.hint')} {t('wch.baseline')}</span>
                        </div>
                    </div>

                    <div class="trg-actions">
                        <button type="button" class="btn btn-primary" onclick={onSave}>{t('trig.save')}</button>
                        <button type="button" class="btn btn-secondary" onclick={() => onDelete(draft.id)}>{t('trig.delete')}</button>
                    </div>
                {:else}
                    <!-- Three sections, folded.
                         The panel had grown to the settings, the variable list,
                         the current value, its breakdown and the last event —
                         all at once, so the thing you opened it for was
                         somewhere in the middle of a page of everything else.
                         Settings opens by default because that is what a
                         watcher IS; the other two are what you come back for. -->
                    <div class="trg-view">
                        <p class="trg-match">{summary(selected)}</p>

                        <details class="wch-sec" open>
                            <summary>{t('wch.sec.config')}</summary>
                            <!-- What this watcher IS. The current value used to
                                 sit here, and it is a RESULT: it changes on
                                 every poll while nothing about the setup has
                                 moved. Reading the settings meant scrolling
                                 past a number that belonged in the section
                                 below. -->
                            <ul class="wch-kv">
                                <li><span>{t('wch.recipe')}</span><span>{recipeNameOf(selected)}</span></li>
                                <li><span>{t('wch.eventName')}</span><span><code>{selected.eventName}</code></span></li>
                                <li><span>{t('wch.sec.interval')}</span><span>{intervalOf(selected)}</span></li>
                                {#each settingRows(selected) as [label, value] (label)}
                                    <li><span>{label}</span><span>{value}</span></li>
                                {/each}
                            </ul>
                        </details>

                        <details class="wch-sec">
                            <summary>{t('wch.sec.vars')}</summary>
                            <p class="sch-note">{t('wch.emits.hint')}</p>
                            <ul class="wch-fields">
                                {#each emitsOf(selected) as [name, desc] (name)}
                                    <li>
                                        <code>{'{{payload.' + name + '}}'}</code>
                                        <span class="sch-note">{desc}</span>
                                    </li>
                                {/each}
                                <li>
                                    <code>{'{{count}}'}</code>
                                    <span class="sch-note">まとめた件数</span>
                                </li>
                            </ul>
                        </details>

                        <details class="wch-sec">
                            <summary>{t('wch.sec.last')}</summary>
                            {#key selected.lastRunAt}
                                <p class="sch-note" class:err={status(selected).bad}>
                                    {t('wch.last')}: {status(selected).text}</p>
                            {/key}
                            {#if currentValue(selected) !== null}
                                <h4>{t('wch.current')}</h4>
                                <p><code>{currentValue(selected)}</code></p>
                                <p class="sch-note">{t('wch.current.hint')}</p>
                                {#if selected.baseline?.parts?.length}
                                    <h4>{t('wch.parts')}</h4>
                                    <ul class="wch-parts">
                                        {#each selected.baseline.parts as [label, value] (label)}
                                            <li><span class="wch-part-k">{label}</span><span class="wch-part-v">{value}</span></li>
                                        {/each}
                                    </ul>
                                    <p class="sch-note">{t('wch.parts.hint')}</p>
                                {/if}
                            {/if}
                            {#if selected.lastSample}
                                {#if selected.lastSample.at}
                                    <p class="sch-note">{t('wch.sample.when',
                                        { when: new Date(selected.lastSample.at).toLocaleString() })}</p>
                                {/if}
                                <pre class="trg-curl">{JSON.stringify(selected.lastSample, null, 2)}</pre>
                            {:else}
                                <p class="sch-note">{t('wch.sample.none')}</p>
                            {/if}
                        </details>

                        <div class="trg-actions">
                            <button type="button" class="btn btn-primary" onclick={() => startEdit(selected)}>{t('trig.edit')}</button>
                            <button type="button" class="btn btn-secondary" disabled={busy}
                                onclick={() => runNow(selected)}>{t('wch.runNow')}</button>
                        </div>
                    </div>
                {/if}
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .err { color: var(--error); }
    .wch-sec { border: 1px solid var(--line); border-radius: var(--r-2); padding: 8px 12px; }
    .wch-sec > summary {
        cursor: pointer; font-weight: 600; list-style: revert;
        padding: 2px 0; color: var(--ink);
    }
    .wch-sec[open] > summary { margin-bottom: 8px; border-bottom: 1px solid var(--line); }
    .wch-sec h4 { margin: 12px 0 4px; }
    .wch-parts { list-style: none; margin: 0; padding: 0; font-size: var(--fs-sm); }
    /* `space-between` pushed the number to the far edge of the pane, so on a
       wide window the label and its value were nowhere near each other — and
       in a screenshot of the left half, the values looked missing entirely. */
    .wch-parts li, .wch-kv li {
        display: grid; grid-template-columns: 1fr auto; gap: 16px;
        max-width: 34rem; padding: 3px 0; border-bottom: 1px solid var(--line);
    }
    .wch-part-k { overflow-wrap: anywhere; }
    .wch-part-v { font-variant-numeric: tabular-nums; font-weight: 600; }
    .wch-kv { list-style: none; margin: 0; padding: 0; font-size: var(--fs-sm); }
    .wch-kv li > span:first-child { color: var(--ink-faint); }
    .wch-kv li > span:last-child { overflow-wrap: anywhere; }
    code { font-size: var(--fs-sm); }
</style>
