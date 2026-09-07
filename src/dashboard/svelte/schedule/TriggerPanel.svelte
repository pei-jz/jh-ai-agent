<!--
  TriggerPanel — the event half of autonomy, alongside the clock half.

  Schedules and triggers answer the same question ("what makes the agent run
  when I am not asking it to?"), so they share a view rather than getting a
  sixth rail destination. The difference is only what decides to fire.

  All the rules live in TriggerEngine; this is a form over them. The one thing
  it insists on showing is the GUARDS — a trigger you cannot see the limits of
  is a trigger you cannot leave switched on.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { triggerManager } from '../../../modules/ai/triggers/TriggerManager.js';
    import { AGENT_MODES, DEFAULT_MODE_ID, modeName } from '../../../modules/ai/AgentModes.js';
    import { watcherManager } from '../../../modules/ai/triggers/WatcherManager.js';
    import { payloadFieldsFor } from '../../../modules/ai/triggers/WatcherEngine.js';
    import { unresolvedPlaceholders, renderPrompt } from '../../../modules/ai/triggers/TriggerEngine.js';
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';

    let {
        /** Injectable for tests; defaults to the real singleton. */
        manager = triggerManager,
        /** For the "how to send an event" snippet. */
        endpoint = null,
        notify = (msg) => window.alert(msg),
        confirmDelete = (msg) => window.confirm(msg),
    } = $props();

    let triggers = $state(untrack(() => manager.reload()));
    let editingId = $state(null);
    let draft = $state(null);

    // The approved projects, so the workspace is PICKED rather than typed. A
    // free-text path is the one field in this form nobody can verify by eye,
    // and a trigger with a mistyped workspace fires happily and does its work
    // in the wrong place — or nowhere.
    let projects = $state([]);
    $effect(() => {
        let alive = true;
        (async () => {
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (alive) projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
        })();
        return () => { alive = false; };
    });

    // Browse is still offered: a folder that is not an approved project yet is
    // exactly the case a list cannot cover.
    async function browse() {
        try {
            const sel = await invoke('select_folder');
            if (sel && draft) draft.workspacePath = sel;
        } catch (_) { /* cancelled */ }
    }

    const agentModes = Object.values(AGENT_MODES);
    const selected = $derived(
        draft && draft.id === editingId ? draft : (triggers.find(x => x.id === editingId) || null)
    );

    // Shown so the snippet can be copied straight into a CI config. The token is
    // the app's own; it is already in the user's config file and every other
    // call in this window carries it.
    const url = $derived(endpoint ?? `${globalThis.window?.apiClient?.baseUrl || 'http://localhost:PORT/api'}/events`);
    const token = $derived(globalThis.window?.apiClient?.token || 'YOUR_TOKEN');
    const curl = $derived(
        `curl -X POST ${url} \\\n`
        + `  -H "Authorization: Bearer ${token}" \\\n`
        + `  -H "Content-Type: application/json" \\\n`
        + `  -d '{"event":"${selected?.match?.event || 'ci.failed'}","key":"<一意なID>",`
        + `"payload":{"repo":"jh-ai-agent"}}'`
    );

    function refresh() { triggers = [...manager.triggers]; }

    function onNew() {
        // Disabled, like every new trigger: a thing that runs on outside events
        // should not be live the moment it exists.
        draft = {
            id: `trg_${Date.now()}`, name: t('trig.newName', null, '新しいトリガー'),
            enabled: false, match: { source: 'webhook' },
            nameMode: 'exact', nameValue: '',
            prompt: '', agentModeId: DEFAULT_MODE_ID,
            debounceMs: 2000, cooldownMs: 0, maxPerHour: 20, whereRows: [],
        };
        editingId = draft.id;
    }

    // Selecting shows what the trigger IS and what it has done; editing is a
    // separate, deliberate step. Going straight into the form on a click made
    // the run history and the "how to send an event" snippet unreachable — and
    // those are what a person opens this panel to look at.
    function select(tr) {
        editingId = tr.id;
        draft = null;
        testResult = '';      // a previous trigger's answer is not this one's
    }

    function startEdit(tr) {
        editingId = tr.id;
        const m = { ...(tr.match || {}) };
        draft = {
            ...tr,
            match: m,
            // Exact and prefix were two always-visible fields, and `matches()`
            // requires BOTH when both are set — so filling them in was a
            // trigger that could never fire, with nothing to say why. One
            // control, one meaning.
            nameMode: m.event ? 'exact' : (m.eventPrefix ? 'prefix' : 'exact'),
            nameValue: m.event || m.eventPrefix || '',
            whereRows: Object.entries(tr.match?.where || {}).map(([k, v]) => ({ k, v })),
        };
    }

    function onSave() {
        if (!draft) return;
        if (!String(draft.prompt || '').trim()) { notify(t('trig.prompt', null, 'プロンプト')); return; }
        const where = {};
        for (const row of draft.whereRows || []) {
            if (String(row.k || '').trim()) where[row.k.trim()] = row.v;
        }
        const { whereRows, nameMode, nameValue, ...rest } = draft;
        // Exactly one of the two is written, so the stored shape can never hold
        // the pair that matches nothing.
        const name = String(nameValue || '').trim();
        manager.upsert({
            ...rest,
            match: {
                ...draft.match,
                where,
                event: nameMode === 'exact' ? name : undefined,
                eventPrefix: nameMode === 'prefix' ? name : undefined,
            },
        });
        draft = null;
        refresh();
    }

    function onDelete(id) {
        if (!confirmDelete(`"${triggers.find(x => x.id === id)?.name || id}" を削除しますか？`)) return;
        manager.remove(id);
        if (editingId === id) { editingId = null; draft = null; }
        refresh();
    }

    function toggle(tr) {
        manager.setEnabled(tr.id, !tr.enabled);
        refresh();
    }

    /** What the last test event did. Empty until one is sent. */
    let testResult = $state('');

    /**
     * Fire a synthetic event through the real path, guards and all — and SAY
     * what happened to it.
     *
     * The engine returns a decision per matching trigger; this used to discard
     * every one of them. Pressing the button on a trigger that is switched off
     * (which is how every trigger starts), or inside its cooldown, or matching
     * nothing at all, then did nothing and reported nothing — which is
     * indistinguishable from the app having hung.
     */
    /**
     * A payload shaped like the real thing.
     *
     * `{ test: true }` was sent before, so every `{{payload.…}}` in the prompt
     * stayed unresolved — and the test STARTED A REAL TASK with instructions
     * containing `{{payload.value}}`. The agent did the only honest thing with
     * that: spent a hundred seconds establishing it could not invent the
     * number, then asked. Pressing "test" should not cost that.
     *
     * The best sample is the last event the matching watcher actually produced;
     * failing that, the fields that watcher type emits, filled with a value
     * that is obviously a test.
     */
    function testPayload(tr) {
        const name = tr.match?.event || tr.match?.eventPrefix || '';
        const w = (watcherManager.watchers || []).find(x => x.eventName === name);
        if (w?.lastSample) return { ...w.lastSample };
        const fields = payloadFieldsFor(w?.type);
        if (fields.length) {
            return Object.fromEntries(fields.map(([f]) => [f, `(テスト:${f})`]));
        }
        return { test: true };
    }

    function sendTest(tr) {
        const payload = testPayload(tr);
        const event = {
            source: tr.match?.source || 'webhook',
            server: tr.match?.server,
            event: tr.match?.event || tr.match?.eventPrefix || 'test',
            key: `test-${Date.now()}`,
            payload,
        };

        // Checked BEFORE the event goes anywhere: a prompt this event cannot
        // fill will be refused by _fire anyway, and saying so here names the
        // field while the person is looking at the prompt.
        const missing = unresolvedPlaceholders(renderPrompt(tr.prompt, event, 1));
        if (missing.length) {
            testResult = t('trig.test.missing',
                { fields: missing.map(m => `{{${m}}}`).join(', ') },
                `プロンプトの ${missing.map(m => `{{${m}}}`).join(', ')} をこのイベントでは埋められません。`);
            return;
        }

        const decisions = manager.onEvent(event);
        refresh();

        const mine = decisions.filter(d => d.triggerId === tr.id);
        if (!mine.length) {
            // No decision for this trigger means the event did not match it.
            testResult = t('trig.test.nomatch');
            return;
        }
        const d = mine[0];
        if (d.dropped) {
            testResult = t('trig.test.dropped', { why: d.dropped }, `見送られました: ${d.dropped}`);
            return;
        }
        const secs = Math.max(0, Math.round((d.fireAt - Date.now()) / 1000));
        testResult = t('trig.test.queued', { secs }, `${secs}秒後にタスクが起動します。`);
    }

    const secs = (ms) => Math.round((ms || 0) / 1000);
    function setMs(field, seconds) {
        if (draft) draft[field] = Math.max(0, Number(seconds) || 0) * 1000;
    }

    function summary(tr) {
        const m = tr.match || {};
        const bits = [m.source || t('trig.source.any', null, 'すべて')];
        if (m.server) bits.push(m.server);
        if (m.event) bits.push(m.event);
        if (m.eventPrefix) bits.push(`${m.eventPrefix}*`);
        for (const [k, v] of Object.entries(m.where || {})) bits.push(`${k}=${v}`);
        return bits.join(' · ');
    }
</script>

<div class="trg">
    <div class="trg-head">
        <div>
            <h2>{t('trig.title')}</h2>
            <p class="subtitle">{t('trig.subtitle')}</p>
        </div>
        <button class="btn btn-primary" onclick={onNew}>{t('trig.new')}</button>
    </div>

    <div class="trg-body">
        <ul class="trg-list">
            {#if !triggers.length}
                <li class="trg-empty">{t('trig.empty')}</li>
            {/if}
            {#each triggers as tr (tr.id)}
                <li class="trg-item" class:active={editingId === tr.id}>
                    <button class="trg-pick" onclick={() => select(tr)}>
                        <span class="trg-name">{tr.name || tr.id}</span>
                        <span class="trg-match">{summary(tr)}</span>
                        {#if tr.disabledReason}
                            <span class="trg-stopped">{t('trig.stopped')}</span>
                        {/if}
                    </button>
                    <label class="trg-toggle">
                        <input type="checkbox" checked={tr.enabled} onchange={() => toggle(tr)} />
                        <span>{t('trig.enabled')}</span>
                    </label>
                </li>
            {/each}
        </ul>

        <div class="sch-detail-panel">
            {#if !selected}
                <div class="trg-empty">{t('trig.empty')}</div>
            {:else}
            <div class="sch-detail-header">
                <span>{selected.name || '(untitled)'}</span>
                <span class="sch-detail-next">{summary(selected)}</span>
            </div>
            <div class="sch-detail-body">
            {#if draft && draft.id === editingId}
                <!-- Two columns, because this form is FILLED IN, not read: the
                     one-per-row stack pushed Save below the fold and made you
                     scroll to check what you had already typed. Short related
                     fields pair up; the prompt and the condition list, which
                     need the width, span both. -->
                <div class="trg-grid">
                    <div class="sch-field">
                        <label for="trg-name">{t('trig.name')}</label>
                        <input id="trg-name" type="text" class="sch-input" bind:value={draft.name} />
                    </div>

                    <div class="sch-field">
                        <label for="trg-source">{t('trig.source')}</label>
                        <select id="trg-source" class="sch-select" bind:value={draft.match.source}>
                            <option value="webhook">{t('trig.source.webhook')}</option>
                            <option value="mcp">{t('trig.source.mcp')}</option>
                            <option value={undefined}>{t('trig.source.any')}</option>
                        </select>
                    </div>

                    {#if draft.match.source === 'mcp'}
                        <div class="sch-field trg-span">
                            <label for="trg-server">{t('trig.server')}</label>
                            <input id="trg-server" type="text" class="sch-input"
                                bind:value={draft.match.server} placeholder="my-watcher" />
                        </div>
                    {/if}

                    <!-- Exact vs prefix is a MODE, not two fields. As two, both
                         could be filled, and matches() requires both to pass — a
                         trigger that can never fire, with nothing to say why. -->
                    <div class="sch-field trg-span">
                        <label for="trg-event">{t('trig.event')}</label>
                        <div class="trg-row">
                            <select class="sch-select trg-mode" bind:value={draft.nameMode}>
                                <option value="exact">{t('trig.match.exact')}</option>
                                <option value="prefix">{t('trig.match.prefix')}</option>
                            </select>
                            <input id="trg-event" type="text" class="sch-input trg-grow"
                                bind:value={draft.nameValue}
                                placeholder={draft.nameMode === 'prefix' ? 'github.' : 'ci.failed'} />
                        </div>
                    </div>

                    <div class="sch-field trg-span">
                        <span class="sch-label">{t('trig.where')}</span>
                        {#each draft.whereRows as row, i}
                            <div class="trg-row">
                                <input type="text" class="sch-input trg-grow" bind:value={row.k} placeholder="repo" />
                                <span class="trg-eq">=</span>
                                <input type="text" class="sch-input trg-grow" bind:value={row.v} placeholder="jh-ai-agent" />
                                <button type="button" class="btn btn-secondary trg-rowbtn"
                                    onclick={() => draft.whereRows.splice(i, 1)}>×</button>
                            </div>
                        {/each}
                        <div class="trg-row">
                            <button type="button" class="btn btn-secondary trg-rowbtn"
                                onclick={() => draft.whereRows.push({ k: '', v: '' })}>＋</button>
                            <span class="sch-note">{t('trig.where.hint')}</span>
                        </div>
                    </div>

                    <div class="sch-field trg-span">
                        <label for="trg-prompt">{t('trig.prompt')}</label>
                        <textarea id="trg-prompt" class="sch-textarea trg-prompt-box" rows="3"
                            bind:value={draft.prompt}></textarea>
                        <span class="sch-note">{t('trig.prompt.hint')}</span>
                    </div>

                    <div class="sch-field">
                        <label for="trg-ws">{t('trig.workspace')}</label>
                        <div class="trg-row">
                            <select id="trg-ws" class="sch-select trg-grow" bind:value={draft.workspacePath}>
                                <option value="">{t('trig.workspace.none')}</option>
                                {#if draft.workspacePath && !projects.includes(draft.workspacePath)}
                                    <option value={draft.workspacePath}>{draft.workspacePath}</option>
                                {/if}
                                {#each projects as p (p)}<option value={p}>{p}</option>{/each}
                            </select>
                            <button type="button" class="btn btn-secondary trg-browse"
                                title={t('trig.workspace.browse')} onclick={browse}>{@html icon('folder', 20)}</button>
                        </div>
                    </div>

                    <div class="sch-field">
                        <label for="trg-agent">{t('trig.agent')}</label>
                        <select id="trg-agent" class="sch-select" bind:value={draft.agentModeId}>
                            {#each agentModes as m}<option value={m.id}>{modeName(m)}</option>{/each}
                        </select>
                    </div>

                    <!-- One row: three numbers that already have working
                         defaults. They are tuning, not setup, so they take a
                         line rather than a third of the form. -->
                    <div class="sch-field trg-span">
                        <span class="sch-label">{t('trig.guards')}</span>
                        <div class="trg-row trg-guards">
                            <label for="trg-deb">{t('trig.debounce')}</label>
                            <input id="trg-deb" type="number" min="0" class="sch-input"
                                value={secs(draft.debounceMs)}
                                oninput={(e) => setMs('debounceMs', e.currentTarget.value)} />
                            <label for="trg-cool">{t('trig.cooldown')}</label>
                            <input id="trg-cool" type="number" min="0" class="sch-input"
                                value={secs(draft.cooldownMs)}
                                oninput={(e) => setMs('cooldownMs', e.currentTarget.value)} />
                            <label for="trg-cap">{t('trig.maxPerHour')}</label>
                            <input id="trg-cap" type="number" min="0" class="sch-input"
                                bind:value={draft.maxPerHour} />
                        </div>
                        <span class="sch-note">{t('trig.guards.hint')}</span>
                    </div>
                </div>

                <div class="trg-actions">
                    <button type="button" class="btn btn-primary" onclick={onSave}>{t('trig.save')}</button>
                    <button type="button" class="btn btn-secondary" onclick={() => onDelete(draft.id)}>{t('trig.delete')}</button>
                </div>

            {:else}
                <div class="trg-view">
                    <h3>{selected.name || selected.id}</h3>
                    <p class="trg-match">{summary(selected)}</p>
                    {#if selected.disabledReason}
                        <p class="trg-stopped">{t('trig.stopped')}</p>
                    {/if}
                    <pre class="trg-prompt">{selected.prompt}</pre>

                    <h4>{t('trig.runs')}</h4>
                    {#if !selected.runs?.length}
                        <p class="sch-note">{t('trig.norun')}</p>
                    {:else}
                        <ul class="trg-runs">
                            {#each [...selected.runs].reverse().slice(0, 10) as r}
                                <li>
                                    <span>{new Date(r.at).toLocaleString()}</span>
                                    <span>{r.event}{r.count > 1 ? ` ×${r.count}` : ''}</span>
                                    <span class:err={r.status === 'failed'}>{r.error || r.status}</span>
                                </li>
                            {/each}
                        </ul>
                    {/if}

                    <h4>{t('trig.send')}</h4>
                    <p class="sch-note">{t('trig.send.hint')}</p>
                    <pre class="trg-curl">{curl}</pre>

                    <div class="trg-actions">
                        <button class="btn btn-primary" onclick={() => startEdit(selected)}>{t('trig.edit')}</button>
                        <button class="btn" onclick={() => sendTest(selected)}>{t('trig.test')}</button>
                    </div>
                    {#if testResult}
                        <p class="sch-note trg-testresult">{testResult}</p>
                    {/if}
                </div>
            {/if}
            </div>
            {/if}
        </div>
    </div>
</div>

<style>
    /* Layout lives in dashboard.css: WatcherPanel is built on the same
       vocabulary, and a Svelte <style> is scoped to ONE component. */
</style>
