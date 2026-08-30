<!--
  MemoryRoot — everything about what the agent has learned, in one place.

  docs/design/information-architecture.md §7 step 4. Memory was in TWO places
  before this, and neither was a place you could go:

    • the Dashboard's right pane, as one of three tabs in a region that SWAPS to
      the live run whenever something is running — so the moment you have runs
      worth learning from, the panel showing what was learned disappears;
    • Settings → Memory, which is where you go to change how the app behaves and
      then leave again. Reviewing what the agent believes is not a setting.

  So the two halves are joined here: MemoryPane is the reading surface (the
  digest, the health readout, search) and MemoryEditor is where a wrong or stale
  memory gets corrected. Same workspace, one selector, no navigating between two
  sections of the app to answer one question.

  The state and the write handlers are lifted verbatim from ConfigRoot — this is
  a relocation, not a rewrite, so the failure modes it already handles (an
  optimistic mutation reloading from disk when the write fails, a study pass that
  keeps its index when overview generation fails) come along unchanged.
-->
<script>
    import { PANEL_STYLES } from '../../views/panels.styles.js';
    import { invoke } from '@tauri-apps/api/core';
    import { t } from '../../../i18n/index.js';
    import { icon } from '../../utils/icons.js';
    import {
        readWorkspaceMemory, writeFacts, writeEpisodes, writeCards,
        readOverview, writeOverview, allowMemoryDir,
    } from '../../../modules/ai/memory/workspaceMemory.js';
    import { capFactText } from '../../../modules/ai/memory/FactStore.js';

    import MemoryPane from '../overview/MemoryPane.svelte';
    import MemoryEditor from './MemoryEditor.svelte';

    let {
        api = null,
        confirmAction = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
        pickFolder = () => invoke('select_folder'),
        /** 'digest' (what it knows) | 'edit' (fix what is wrong). */
        initialTab = 'digest',
    } = $props();

    const WS_KEY = 'jhai_last_ws';

    let tab = $state(initialTab);
    let workspace = $state('');
    let projects = $state([]);

    let facts = $state(null);
    let episodes = $state(null);
    let cards = $state(null);
    let overview = $state(null);
    let indexStats = $state(null);
    let abStats = $state(null);
    let studying = $state(false);
    let studyStatus = $state('');
    let loadError = $state('');

    /** What MemoryPane wants: the three stores as one object, or empty. */
    const memory = $derived({
        facts: Array.isArray(facts) ? facts : [],
        episodes: Array.isArray(episodes) ? episodes : [],
        cards: Array.isArray(cards) ? cards : [],
    });

    // ── Loading ───────────────────────────────────────────────────────────

    async function loadMemoryData() {
        if (!workspace) return;
        loadError = '';
        try {
            const m = await readWorkspaceMemory(workspace, invoke);
            facts = m.facts;
            episodes = m.episodes;
            cards = m.cards;
            // A separate file readWorkspaceMemory deliberately does not read.
            overview = await readOverview(workspace, invoke);
            if (overview?.generatedAt) overview.head = await headCommit();
        } catch (e) {
            loadError = String(e?.message || e);
            facts = []; episodes = []; cards = [];
        }
    }

    async function headCommit() {
        try {
            const out = await invoke('run_command', { command: 'git rev-parse HEAD', cwd: workspace });
            return String(out || '').trim().slice(0, 12);
        } catch (_) { return ''; }
    }

    async function loadIndexStats() {
        try {
            const { CodeIndexClient, coverage } = await import('../../../modules/ai/memory/CodeIndex.js');
            const idx = new CodeIndexClient({ workspacePath: workspace, invoke });
            const stats = await idx.stats();
            const paths = (await idx.knownHashes()).map(([p]) => p);
            indexStats = { ...stats, coverage: coverage(paths, { root: workspace }) };
        } catch (_) { indexStats = null; }
    }

    async function loadAbStats() {
        try {
            const { compareArms, parseMetrics, runsNeeded } =
                await import('../../../modules/ai/memory/SessionMetrics.js');
            const { INJECTION_VARIANT } = await import('../../../modules/ai/memory/CardStore.js');
            const text = await invoke('read_file', { path: `${workspace}/.agent/trace/metrics.jsonl` });
            const rows = parseMetrics(text);
            // Only the CURRENT wording generation. Rows measured under earlier
            // phrasing describe a different injection, and averaging them in
            // would report the mean of two experiments as the result of one.
            const cmp = compareArms(rows, { variant: INJECTION_VARIANT });
            const live = rows.filter(r => (r.injectionVariant || 'v1') === INJECTION_VARIANT);
            abStats = rows.length
                ? { ...cmp, rows: live.length, needed: runsNeeded(live) || runsNeeded(rows) }
                : null;
        } catch (_) { abStats = null; }   // no runs recorded yet
    }

    async function loadAll() {
        if (!workspace) { notify(t('memory.needWorkspace', null, 'Please enter a workspace path.')); return; }
        try { localStorage.setItem(WS_KEY, workspace); } catch (_) { /* private mode */ }
        await loadMemoryData();
        await loadIndexStats();
        await loadAbStats();
    }

    // ── Writing ───────────────────────────────────────────────────────────

    /** Mutate one store optimistically, reloading from disk if the write fails. */
    async function mutateStore(kind, fn) {
        const target = { facts, cards, episodes }[kind];
        if (!Array.isArray(target)) return;
        const copy = [...target];
        fn(copy);
        if (kind === 'facts') facts = copy;
        else if (kind === 'cards') cards = copy;
        else episodes = copy;
        const writer = { facts: writeFacts, cards: writeCards, episodes: writeEpisodes }[kind];
        const file = { facts: 'facts.json', cards: 'cards.jsonl', episodes: 'memory.json' }[kind];
        try {
            await writer(workspace, copy, invoke);
        } catch (e) {
            notify(`Failed to save ${file}: ` + e);
            await loadMemoryData();
        }
    }

    /** From the digest pane, where cards are toggled by id rather than index. */
    async function toggleCardById(id, disabled) {
        const i = (cards || []).findIndex(c => c?.id === id);
        if (i < 0) return;
        await mutateStore('cards', (l) => { l[i] = { ...l[i], disabled }; });
    }

    async function runStudy() {
        if (studying) return;
        if (!workspace) { notify(t('memory.needWorkspace', null, 'Please enter a workspace path.')); return; }
        studying = true;
        studyStatus = '';
        try {
            const { runStudyPass, dropStudyCards } = await import('../../../modules/ai/memory/StudyPass.js');
            // The index is written inside `.agent/memory`, so the guard has to know
            // about the directory before the pass starts, not after.
            await allowMemoryDir(workspace, invoke);

            const res = await runStudyPass({
                workspacePath: workspace, invoke,
                onProgress: ({ read, total }) => { studyStatus = `${read} / ${total}`; },
            });
            if (res.error) { studyStatus = t('memory.study.failed', { error: res.error }); return; }

            studyStatus = t('memory.study.indexed', { files: res.files, symbols: res.symbols, edges: res.edges })
                + (res.skipped ? t('memory.study.skipped', { count: res.skipped }) : '')
                + (res.pruned ? t('memory.study.dropped', { count: res.pruned }) : '')
                + (res.truncated || res.omitted
                    ? ' ' + t('memory.study.capped', { total: res.total || res.files + (res.omitted || 0), omitted: res.omitted || 0 })
                    : '');

            // One-time migration: the first version of this pass wrote a card per
            // symbol. They live in the index now, so the rows left in cards.jsonl
            // are residue in a panel whose whole purpose is being reviewable.
            const { kept, dropped } = dropStudyCards(cards || []);
            if (dropped) {
                cards = kept;
                await writeCards(workspace, kept, invoke);
                studyStatus += ' · ' + t('memory.study.migrated', { count: dropped });
            }
            await loadIndexStats();
            await writeProjectOverview(res.areas);
        } catch (e) {
            studyStatus = t('memory.study.failed', { error: String(e?.message || e) });
        } finally {
            studying = false;
        }
    }

    /** Best-effort: a failure here leaves the index — the expensive part — intact. */
    async function writeProjectOverview(areas) {
        try {
            const { structureDigest, detectConventionsFull, buildOverviewPrompt, normalizeOverview, isOverviewStale } =
                await import('../../../modules/ai/memory/ProjectOverview.js');
            const llmService = (await import('../../../modules/ai/LLMService.js')).default;

            const digest = structureDigest(areas, { root: workspace });
            if (!digest.length) return;
            const measured = detectConventionsFull(areas, { root: workspace });
            const head = await headCommit();
            const prev = await readOverview(workspace, invoke);

            let text = prev?.text || '';
            if (isOverviewStale(prev, { head })) {
                const prompt = buildOverviewPrompt(digest, measured.rules);
                const res = await llmService.generate([{ role: 'user', content: prompt }]);
                text = normalizeOverview(res?.content || '');
            }
            await writeOverview(workspace, text, invoke, {
                generatedAt: new Date().toISOString(), head, conventions: measured.rules,
            });
            overview = await readOverview(workspace, invoke);
            if (overview) overview.head = head;
        } catch (e) {
            console.warn('Overview generation failed:', e);
        }
    }

    async function saveOverview(text) {
        try {
            await writeOverview(workspace, text, invoke, {
                generatedAt: overview?.generatedAt, head: overview?.head,
                conventions: overview?.conventions,
            });
            overview = await readOverview(workspace, invoke);
        } catch (e) {
            notify('Failed to save overview.md: ' + (e.message || e));
        }
    }

    async function browse() {
        try { const sel = await pickFolder(); if (sel) { workspace = sel; await loadAll(); } }
        catch (_) { /* dialog cancelled */ }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────
    //
    // The workspace defaults to the one the last run used, so opening Memory
    // right after a task shows THAT project rather than an empty picker. It is
    // the same key the composer writes.
    $effect(() => {
        let cancelled = false;
        (async () => {
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (cancelled) return;
            projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
            let last = '';
            try { last = localStorage.getItem(WS_KEY) || ''; } catch (_) { /* private mode */ }
            workspace = last || projects[0] || '';
            if (workspace) await loadAll();
        })();
        return () => { cancelled = true; };
    });
</script>

<!--
  The panel class names (.dm-box, .ds-tbl, .drow-dot) are shared BETWEEN
  these components, and Svelte's per-component scoping would stop each one
  applying outside the file that declared it. Content is a constant from our
  own module, not data.
-->
{@html `<style>${PANEL_STYLES}</style>`}

<div class="view-container">
    <div class="mem-head">
        <h1 class="mem-title">{t('mem.title')}</h1>

        <div class="mem-tabs" role="tablist">
            <button type="button" class="mem-tab" class:is-on={tab === 'digest'}
                role="tab" aria-selected={tab === 'digest'}
                onclick={() => (tab = 'digest')}>{@html icon('memory', 13)} 知っていること</button>
            <button type="button" class="mem-tab" class:is-on={tab === 'edit'}
                role="tab" aria-selected={tab === 'edit'}
                onclick={() => (tab = 'edit')}>{@html icon('template', 13)} 編集</button>
        </div>

        <span class="mem-ws">
            <!-- A real list, not an autocomplete — see NewTaskModal.svelte. The
                 browse button beside it covers a folder that is not approved yet. -->
            <select class="mem-ws-input" bind:value={workspace} aria-label={t('common.workspace')}
                onchange={loadAll}>
                <option value="">(ワークスペースを選択)</option>
                {#if workspace && !projects.includes(workspace)}
                    <option value={workspace}>{workspace}</option>
                {/if}
                {#each projects as p (p)}<option value={p}>{p}</option>{/each}
            </select>
            <button type="button" class="mem-ws-browse" onclick={browse}
                title={t('common.browseWorkspace')} aria-label={t('common.browseWorkspace')}>
                {@html icon('folder', 12)}
            </button>
        </span>
    </div>

    <div class="mem-body">
        {#if tab === 'digest'}
            <MemoryPane {memory} {workspace} error={loadError}
                knownWorkspaces={projects} seenAt={0}
                onWorkspace={(ws) => { workspace = ws; loadAll(); }}
                onToggleCard={toggleCardById} />
        {:else}
            <MemoryEditor
                {workspace} {projects} {facts} {episodes} {cards}
                {indexStats} {abStats} {overview} {studying} {studyStatus}
                onWorkspaceChange={(v) => (workspace = v.trim())}
                onBrowse={browse}
                onLoad={loadAll}
                onSaveOverview={saveOverview}
                onStudy={runStudy}
                onEditFact={(i, text) => mutateStore('facts', (l) => { l[i] = { ...l[i], fact: capFactText(text) }; })}
                onDeleteFact={(i) => { if (confirmAction('Delete this fact?')) mutateStore('facts', (l) => l.splice(i, 1)); }}
                onClearFacts={() => { if (confirmAction('Delete ALL durable facts?')) mutateStore('facts', (l) => (l.length = 0)); }}
                onDeleteEpisode={(i) => { if (confirmAction('Delete this episode?')) mutateStore('episodes', (l) => l.splice(i, 1)); }}
                onClearEpisodes={() => { if (confirmAction('Delete ALL session history?')) mutateStore('episodes', (l) => (l.length = 0)); }}
                onToggleCard={(i, disabled) => mutateStore('cards', (l) => { l[i] = { ...l[i], disabled }; })}
                onDeleteCard={(i) => { if (confirmAction('Delete this learned card?')) mutateStore('cards', (l) => l.splice(i, 1)); }}
                onClearCards={() => { if (confirmAction('Delete ALL learned cards?')) mutateStore('cards', (l) => (l.length = 0)); }}
            />
        {/if}
    </div>
</div>

<style>
    .mem-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) 0 var(--space-3);
        border-bottom: 1px solid var(--line);
        margin-bottom: var(--space-4);
        flex-wrap: wrap;
    }
    .mem-title {
        font-size: var(--fs-xl);
        font-weight: 700;
        margin: 0;
        color: var(--ink);
    }
    .mem-tabs { display: flex; gap: 2px; }
    .mem-tab {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: var(--fs-sm);
        color: var(--ink-soft);
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-2);
        padding: 5px 12px;
        cursor: pointer;
    }
    .mem-tab:hover { color: var(--ink); }
    .mem-tab.is-on {
        color: var(--on-accent);
        background: var(--accent);
        border-color: var(--accent);
    }
    .mem-ws { display: flex; align-items: center; gap: 4px; margin-left: auto; }
    .mem-ws-input {
        width: 260px;
        max-width: 40vw;
        height: 26px;
        font-family: var(--font-mono);
        font-size: var(--fs-2xs);
        color: var(--ink-soft);
        background: var(--surface-input);
        border: 1px solid var(--line);
        border-radius: var(--r-2);
        padding: 0 7px;
        outline: none;
    }
    .mem-ws-input:focus { border-color: var(--accent); color: var(--ink); }
    .mem-ws-browse {
        height: 26px;
        display: flex;
        align-items: center;
        color: var(--ink-soft);
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-2);
        padding: 0 8px;
        cursor: pointer;
    }
    .mem-ws-browse:hover { color: var(--ink); border-color: var(--accent); }
</style>
