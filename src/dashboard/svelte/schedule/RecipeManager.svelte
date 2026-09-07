<!--
  RecipeManager — the recipes, as files you can read and change.

  They were already editable: drop a JSON file in `<app_config_dir>/watchers/`
  and it shadows the built-in of the same id. Nothing said so, and nothing
  showed you what a valid one looks like, so the feature existed and could not
  be found.

  Two rules make this safe enough to expose:

    • a recipe IN USE is read-only. A watcher runs it unattended on a timer, and
      the approval system records the hash it was switched on with — so editing
      underneath a running watcher does not change what it does, it stops it,
      with a message about content that no longer matches. Better to say the
      recipe is in use than to let someone break their own automation.

    • nothing is saved unvalidated. It goes through the same normalize/validate
      path the loader uses, so the editor cannot accept a file the loader will
      reject — which would read as the recipe having vanished after a save that
      said it worked.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { recipeRegistry } from '../../../modules/ai/triggers/RecipeRegistry.js';
    import { watcherManager } from '../../../modules/ai/triggers/WatcherManager.js';

    let {
        registry = recipeRegistry,
        watchers = null,
        notify = (msg) => window.alert(msg),
        confirmDelete = (msg) => window.confirm(msg),
    } = $props();

    let recipes = $state([]);
    let selectedId = $state(null);
    let draftJson = $state('');
    let problems = $state([]);
    let dirty = $state(false);
    let saving = $state(false);
    let folderPath = $state('');

    $effect(() => {
        let alive = true;
        (async () => {
            await registry.refresh();
            if (!alive) return;
            recipes = registry.getAll();
            folderPath = await registry.folder();
        })();
        return () => { alive = false; };
    });

    const inUse = $derived.by(() => {
        const list = watchers ?? watcherManager.watchers ?? [];
        const used = new Map();
        for (const w of list) {
            if (!w.recipeId) continue;
            used.set(w.recipeId, [...(used.get(w.recipeId) || []), w.name || w.id]);
        }
        return used;
    });

    const selected = $derived(recipes.find(r => r.id === selectedId) || null);
    /** Built-ins are files we ship; a recipe in use is running right now. */
    const readOnly = $derived(!!selected && (selected.builtin || inUse.has(selected.id)));
    const lockReason = $derived(
        !selected ? ''
            : inUse.has(selected.id)
                ? t('rec.inUse', { names: (inUse.get(selected.id) || []).join(', ') })
                : selected.builtin ? t('rec.builtin') : ''
    );

    function select(r) {
        if (dirty && !confirmDelete(t('rec.discard'))) return;
        selectedId = r.id;
        draftJson = JSON.stringify(stripRuntime(r), null, 2);
        problems = [];
        dirty = false;
    }

    /** The fields the registry adds on load are not part of the file. */
    function stripRuntime(r) {
        const { builtin: _b, basic: _s, ...rest } = r;
        return rest;
    }

    /**
     * Two skeletons, because there are two kinds of recipe.
     *
     * A `watch` recipe configures an engine. A `time` recipe has no engine at
     * all — there is nothing to poll — and exists so that "every Friday at
     * five, write the weekly summary" is something you can save, name and hand
     * to someone else, exactly like a watcher preset. Only one button would
     * have hidden the second kind behind knowing to delete `engine` and add
     * `schedule`.
     */
    function onNew(kind = 'watch') {
        selectedId = null;
        draftJson = JSON.stringify(kind === 'time' ? {
            id: 'my-schedule',
            name: '新しい定期作業',
            description: '',
            schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
            defaults: { eventName: 'schedule.mine' },
            job: { name: '', purpose: '', prompt: 'ここに作業内容を書きます。' },
        } : {
            id: 'my-recipe',
            name: '新しいレシピ',
            description: '',
            engine: 'http',
            fields: [{ key: 'url', label: 'URL', type: 'text', required: true }],
            config: { url: '{{url}}' },
            defaults: { everySeconds: 300, eventName: 'my.event' },
            job: { name: '', purpose: '', prompt: '{{payload.value}} を使って作業を書きます。' },
        }, null, 2);
        problems = [];
        dirty = true;
    }

    function onCopy() {
        if (!selected) return;
        const copy = stripRuntime(selected);
        copy.id = `${copy.id}-copy`;
        copy.name = `${copy.name} (コピー)`;
        selectedId = null;
        draftJson = JSON.stringify(copy, null, 2);
        problems = [];
        dirty = true;
    }

    function onCheck() {
        const id = idFrom(draftJson);
        problems = registry.check(draftJson, id).problems;
        if (!problems.length) notify(t('rec.ok'));
    }

    /** The id comes from the file, because the FILE decides it on load too. */
    function idFrom(json) {
        try { return String(JSON.parse(json)?.id || '').trim(); } catch (_) { return ''; }
    }

    async function onSave() {
        const id = idFrom(draftJson);
        if (!id) { problems = [t('rec.noId')]; return; }
        if (inUse.has(id)) { problems = [t('rec.inUse', { names: (inUse.get(id) || []).join(', ') })]; return; }
        saving = true;
        try {
            const r = await registry.save(id, draftJson);
            problems = r.problems;
            if (!r.ok) return;
            recipes = registry.getAll();
            selectedId = id;
            dirty = false;
            notify(t('rec.saved'));
        } finally { saving = false; }
    }

    async function onDelete() {
        if (!selected || selected.builtin) return;
        if (inUse.has(selected.id)) { notify(lockReason); return; }
        if (!confirmDelete(t('rec.delete.confirm', { name: selected.name }))) return;
        const r = await registry.remove(selected.id);
        if (!r.ok) { problems = r.problems; return; }
        recipes = registry.getAll();
        selectedId = null;
        draftJson = '';
    }
</script>

<div class="trg">
    <div class="trg-head">
        <div>
            <h2>{t('rec.title')}</h2>
            <p class="subtitle">{t('rec.subtitle')}</p>
        </div>
        <div class="trg-row">
            <button class="btn btn-secondary" onclick={() => onNew('time')}>{t('rec.new.time')}</button>
            <button class="btn btn-primary" onclick={() => onNew('watch')}>{t('rec.new')}</button>
        </div>
    </div>

    <div class="trg-body">
        <ul class="trg-list">
            {#each recipes as r (r.id)}
                <li class="trg-item" class:active={selectedId === r.id}>
                    <button class="trg-pick" onclick={() => select(r)}>
                        <span class="trg-name">{r.name}</span>
                        <span class="trg-match">
                            <code>{r.id}</code> · {r.engine || t('rec.kind.time')}
                            {#if r.builtin}<span class="badge">{t('rec.badge.builtin')}</span>{/if}
                            {#if inUse.has(r.id)}<span class="badge k-event">{t('rec.badge.inUse')}</span>{/if}
                        </span>
                    </button>
                </li>
            {/each}
        </ul>

        <div class="sch-detail-panel">
            {#if !draftJson}
                <div class="trg-empty">{t('rec.pick')}</div>
            {:else}
                <div class="sch-detail-header">
                    <span>{selected?.name || t('rec.newTitle')}</span>
                    <span class="sch-detail-next">{folderPath}</span>
                </div>
                <div class="sch-detail-body">
                    {#if lockReason}
                        <p class="rec-lock">{lockReason}</p>
                    {/if}

                    <textarea class="sch-textarea rec-json" rows="22"
                        readonly={readOnly}
                        bind:value={draftJson}
                        oninput={() => { dirty = true; problems = []; }}></textarea>

                    {#if problems.length}
                        <ul class="rec-problems">
                            {#each problems as p, i (i)}<li>{p}</li>{/each}
                        </ul>
                    {/if}

                    <div class="trg-actions">
                        {#if readOnly}
                            <button class="btn btn-primary" onclick={onCopy}>{t('rec.copy')}</button>
                        {:else}
                            <button class="btn btn-primary" disabled={saving} onclick={onSave}>{t('trig.save')}</button>
                            <button class="btn btn-secondary" onclick={onCheck}>{t('rec.check')}</button>
                            {#if selected && !selected.builtin}
                                <button class="btn btn-secondary" onclick={onDelete}>{t('trig.delete')}</button>
                            {/if}
                        {/if}
                    </div>
                    <p class="sch-note">{t('rec.hint')}</p>
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .rec-json { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--fs-sm); min-height: 22rem; }
    .rec-json[readonly] { opacity: .85; }
    .rec-lock {
        margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-2);
        background: var(--warning-surface); color: var(--warning); font-size: var(--fs-sm);
    }
    .badge.k-event { background: var(--warning-surface); color: var(--warning); }
</style>
