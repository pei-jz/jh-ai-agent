<!--
  OverviewRoot — the dashboard.

  A cockpit whose second half is the agent's memory. The left column never
  changes: start something, see the queue, see the bill. The RIGHT pane is
  stateful — it shows the run when there is one and what the agent has learned
  when there is not, so neither half is ever blank in its own state.

  Svelte migration step 2 (docs/design/svelte-migration.md). What it replaces:
    • `_paint()`, which rewrote three innerHTML regions and re-attached every
      listener on any change — including on every socket packet;
    • the caret-restoring dance in the memory search box, which existed only
      because `_paint` destroyed the input the user was typing into;
    • `_tabsHtml` reading the live DOM (`getElementById('dash-mem-ws').value`)
      to avoid clobbering an in-progress edit during its own repaint.

  ── One behaviour change, made deliberately ─────────────────────────────────
  The Stats tab's cut buttons (month / week / day / model / workspace) are NEW.
  The old view had `statsCut`, its localStorage persistence, an `_aggregate` that
  supports all five, and a click handler bound to `.ds-st-cut[data-cut]` — but no
  button carrying `data-cut` was ever rendered. The handler could not fire, the
  key was never written, and the breakdown was permanently "by month". Carrying
  that forward would have meant porting dead state, a dead handler and dead
  persistence into a new component, so the buttons are drawn now.
-->
<script>
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { OVERVIEW_STYLES } from '../../views/OverviewView.styles.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { readWorkspaceMemory, writeCards } from '../../../modules/ai/memory/workspaceMemory.js';
    import { toggleCardDisabled, recentlyLearned } from '../../views/overview/memoryPanel.js';
    import { rankRecipes, readUseCounts, recordUse } from '../../views/overview/recipes.js';
    import { reduceRun, affectsRun } from '../../views/overview/runFeed.js';
    import { modelRates } from '../../../modules/ai/agent/ModelPhaseRouter.js';
    import {
        KEYS, readPref, writePref, metricsOf, statusBits, rateLookup, flatRateOf,
        defaultMemoryWorkspace, knownWorkspaces, money,
    } from '../../views/overview/overviewModel.js';

    import LaunchPanel from './LaunchPanel.svelte';
    import TaskQueue from './TaskQueue.svelte';
    import SpendPanel from './SpendPanel.svelte';
    import RunPane from './RunPane.svelte';
    import MemoryPane from './MemoryPane.svelte';
    import StatsPane from './StatsPane.svelte';

    let {
        /** Injectable for tests — defaults to the real API client / Tauri bridge. */
        api = null,
        readMemory = readWorkspaceMemory,
        saveCards = writeCards,
        pickFolder = () => invoke('select_folder'),
        openSocket = null,
        navigate = (hash) => { window.location.hash = hash; },
        notify = (msg) => window.alert(msg),
        now = null,
    } = $props();

    const client = () => api ?? window.apiClient;

    let stats = $state({ totalTokens: 0, estimatedCost: 0.0 });
    let tasks = $state([]);
    let config = $state({});
    let memory = $state(null);
    let memoryWs = $state('');
    let memoryError = $state('');
    let memSeenAt = $state(Number(readPref(KEYS.memSeen, 0)) || 0);
    /** null = follow the run; a string is the user's explicit pick. */
    let tab = $state(null);
    let spendRange = $state(readPref(KEYS.spendRange, '7d'));
    let statsCut = $state(readPref(KEYS.statsCut, 'month'));
    let statsRange = $state(readPref(KEYS.statsRange, 'all'));
    let statsStatus = $state(readPref(KEYS.statsStatus, 'all'));
    let run = $state(null);
    /** Bumped on a timer so relative times ("3m ago", elapsed) re-derive. */
    let tick = $state(0);

    const clock = $derived.by(() => { tick; return now ?? Date.now(); });
    const rateFor = $derived(rateLookup(config.llm_instances));
    const flatRate = $derived(flatRateOf(stats));
    const rates = $derived(modelRates(config.llm_instances));

    const metrics = $derived(metricsOf(tasks, { spendRange, rateFor, flatRate, now: clock }));
    const activeTab = $derived(tab ?? (metrics.running.length ? 'run' : 'memory'));
    const newCards = $derived(recentlyLearned(memory?.cards, memSeenAt).length);
    const wsList = $derived(knownWorkspaces(tasks, config, memoryWs));
    const projects = $derived(Array.isArray(config.approved_projects) ? config.approved_projects : []);
    const recipes = $derived.by(() => {
        try { return rankRecipes(promptTemplateManager.getAll() || [], readUseCounts()); }
        catch (_) { return []; }
    });
    const bits = $derived(statusBits(metrics));

    // ── Data ──────────────────────────────────────────────────────────────

    async function loadData() {
        const c = client();
        if (!c) return;
        try {
            const [s, tk, cfg] = await Promise.all([
                c.getStats().catch(() => null),
                c.listTasks().catch(() => null),
                c.getConfig().catch(() => null),
            ]);
            stats = s || stats;
            tasks = Array.isArray(tk) ? tk : [];
            config = cfg || {};
        } catch (e) {
            console.error('Failed to load overview data:', e);
        }
        try { promptTemplateManager.loadFromConfig(config); } catch (_) {}
    }

    async function loadMemoryFor(ws) {
        memoryWs = ws;
        memoryError = '';
        if (!ws) { memory = { facts: [], episodes: [], cards: [] }; return; }
        try {
            memory = await readMemory(ws, invoke);
        } catch (e) {
            memory = { facts: [], episodes: [], cards: [] };
            memoryError = String(e?.message || e);
        }
    }

    async function setWorkspace(ws) {
        const next = String(ws || '').trim();
        if (next === memoryWs) return;
        await loadMemoryFor(next);
    }

    /**
     * Switch a card off (or back on) and persist it.
     *
     * Optimistic: the row flips at once and reverts if the write fails, because a
     * toggle that waits on three file operations feels broken.
     */
    async function toggleCard(id, disabled) {
        if (!id || !memory) return;
        const before = memory.cards;
        memory = { ...memory, cards: toggleCardDisabled(before, id, disabled) };
        try {
            await saveCards(memoryWs, memory.cards, invoke);
        } catch (e) {
            memory = { ...memory, cards: before };
            notify('Could not save the change to cards.jsonl: ' + (e?.message || e));
        }
    }

    function launch({ prompt, ws }) {
        // Hand off to Monitor's modal — it owns workspace validation, the mode
        // picker, MCP selection, "/" expansion and attachments.
        writePref(KEYS.lastWs, ws);
        try { localStorage.setItem(KEYS.openNewTask, JSON.stringify({ prompt, ws })); } catch (_) {}
        navigate('#monitor');
    }

    function applyRecipe(r) {
        recordUse(r.key);
        return r.prompt;
    }

    const setTab = (next) => { tab = next; };
    const pick = (key, setter) => (value) => { setter(value); writePref(key, value); };

    // ── Live run ──────────────────────────────────────────────────────────
    //
    // READ-ONLY, deliberately. Monitor's socket handler steers, approves,
    // continues and manages replay cutoffs across its whole DOM; this one only
    // accumulates logs. Sharing that handler would couple this view to Monitor's
    // markup; forking it would mean two sockets fighting over one task's control
    // messages.
    $effect(() => {
        const target = metrics.running[0];
        if (!target) { run = null; return; }

        const c = client();
        if (!c) return;
        let socket;
        try {
            socket = openSocket
                ? openSocket(target.id)
                : new WebSocket(`ws://localhost:${c.port}/ws/tasks/${target.id}?token=${c.token}`);
        } catch (e) {
            console.warn('Dashboard: could not open the task socket:', e);
            return;
        }

        let logs = [];
        let closed = false;
        let pending = 0;

        /**
         * Rebuild once per frame, not once per packet.
         *
         * The server replays the whole task on connect and then streams. Both
         * are just logs here — there is no live/replay split to get wrong,
         * because this view holds no DOM state between renders. What it DID get
         * wrong was cost: `reduceRun` walks the entire array, and calling it per
         * packet made the pane rebuild dozens of times a second while a task
         * generated. Coalescing collapses the replay burst into one render and a
         * streaming second into one too.
         */
        const rebuild = () => {
            if (pending) return;
            pending = requestAnimationFrame(() => {
                pending = 0;
                if (closed) return;
                const next = reduceRun(logs);
                run = next;
                if (next.finished) {
                    closed = true;
                    try { socket.close(); } catch (_) {}
                    // Reload so the queue and spend catch up; clearing `tab` lets
                    // the pane fall back to Memory.
                    loadData().then(() => { tab = null; });
                }
            });
        };

        socket.onmessage = (ev) => {
            if (closed) return;
            let packet;
            try { packet = JSON.parse(ev.data); } catch (_) { return; }
            // Only what the reducer can use. `stream` arrives once per TOKEN and
            // `command_chunk` once per line of stdout; neither changes anything
            // this pane draws, and keeping them made the log array — which every
            // rebuild walks — grow by thousands of entries a run.
            if (!affectsRun(packet)) return;
            logs.push(packet);
            rebuild();
        };
        socket.onerror = () => { /* onclose follows; nothing useful to add */ };

        return () => {
            closed = true;
            if (pending) cancelAnimationFrame(pending);
            try { socket.close(); } catch (_) {}
        };
    });

    // Opening the Memory tab is what clears the "new" badge: it means "you have
    // seen these", so it is marked when they are actually shown, not on load.
    $effect(() => {
        if (activeTab === 'memory' && memory) {
            const at = Date.now();
            writePref(KEYS.memSeen, at);
        }
    });

    // Relative times ("3m", elapsed) go stale on a page nobody reloads.
    $effect(() => {
        const timer = setInterval(() => { tick += 1; }, 30_000);
        return () => clearInterval(timer);
    });

    // Initial load. Memory is three file reads and the page is usable without
    // it, so it does not block the first paint.
    $effect(() => {
        let cancelled = false;
        loadData().then(() => {
            if (cancelled) return;
            const lastWs = readPref(KEYS.lastWs, '');
            return loadMemoryFor(defaultMemoryWorkspace(tasks, config, lastWs));
        });
        return () => { cancelled = true; };
    });
</script>

<!--
  The dashboard stylesheet stays a single global block rather than being split
  across seven components: its class names are shared BETWEEN them (.dm-box,
  .ds-tbl, .dm-layers, .drow-dot), and Svelte's per-component scoping would stop
  each one applying outside the file that declared it. The content is a constant
  from our own module, not data. Splitting it belongs with the components that
  end up owning each class, once the migration settles.
-->
{@html `<style>${OVERVIEW_STYLES}</style>`}

<div class="view-container">
    <div class="dash">
        <div class="dash-head">
            <h1 class="dash-title">Now</h1>
            <span class="dash-status">
                {#if bits.length}
                    {#each bits as b, i}{i ? ' · ' : ''}<b>{b}</b>{/each}
                {:else}
                    Nothing needs you right now
                {/if}
            </span>
            <a class="dash-head-link" href="#monitor">{@html icon('monitor', 12)} All tasks</a>
        </div>

        <div class="dash-cols">
            <div class="dash-left">
                <LaunchPanel
                    {recipes}
                    {projects}
                    workspace={readPref(KEYS.lastWs, '') || projects[0] || ''}
                    busy={metrics.running.length > 0}
                    onLaunch={launch}
                    onBrowse={pickFolder}
                    onRecipe={applyRecipe}
                />
                <TaskQueue {metrics} now={clock} />
                <SpendPanel {metrics} range={spendRange}
                    onRange={pick(KEYS.spendRange, (v) => (spendRange = v))} />
            </div>

            <div class="dash-right">
                <div class="dt-bar">
                    <button type="button" class="dt-tab" class:is-on={activeTab === 'run'}
                        disabled={!metrics.running.length} onclick={() => setTab('run')}>
                        {#if metrics.running.length}<span class="drow-dot dot-running"></span>{/if} Run
                    </button>
                    <button type="button" class="dt-tab" class:is-on={activeTab === 'memory'}
                        onclick={() => setTab('memory')}>
                        {@html icon('memory', 13)} Memory
                        {#if newCards}<span class="dt-cnt">{newCards} new</span>{/if}
                    </button>
                    <button type="button" class="dt-tab" class:is-on={activeTab === 'stats'}
                        onclick={() => setTab('stats')}>
                        {@html icon('report', 13)} Stats
                    </button>
                    <span class="dt-ws">
                        <!--
                          `value` + `onchange`, not `bind:value`: this reflects the
                          loaded workspace but must only COMMIT on change/Enter, so
                          that typing a path does not fire a file read per keystroke.
                        -->
                        <input class="dt-ws-input" type="text" list="dash-mem-ws-list"
                            value={memoryWs} placeholder="(no workspace)" aria-label="Memory workspace"
                            onchange={(e) => setWorkspace(e.currentTarget.value)}
                            onkeydown={(e) => {
                                if (e.key === 'Enter' && !e.isComposing) {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                }
                            }}>
                        <datalist id="dash-mem-ws-list">
                            {#each [...new Set([...projects, ...wsList])] as p}<option value={p}></option>{/each}
                        </datalist>
                        <button type="button" class="dt-ws-browse"
                            title="Browse for a memory workspace folder"
                            aria-label="Browse for a memory workspace folder"
                            onclick={async () => { const sel = await pickFolder(); if (sel) setWorkspace(sel); }}>
                            {@html icon('folder', 11)}
                        </button>
                    </span>
                </div>

                <div class="dt-pane">
                    {#if activeTab === 'run'}
                        <RunPane task={metrics.running[0]} {run} {rates} now={clock}
                            onGoMemory={() => setTab('memory')} />
                    {:else if activeTab === 'stats'}
                        <StatsPane {tasks} {rateFor} {flatRate} now={clock}
                            cut={statsCut} range={statsRange} status={statsStatus}
                            onCut={pick(KEYS.statsCut, (v) => (statsCut = v))}
                            onRange={pick(KEYS.statsRange, (v) => (statsRange = v))}
                            onStatus={pick(KEYS.statsStatus, (v) => (statsStatus = v))} />
                    {:else}
                        <MemoryPane {memory} workspace={memoryWs} error={memoryError}
                            knownWorkspaces={wsList} seenAt={memSeenAt}
                            onWorkspace={setWorkspace} onToggleCard={toggleCard} />
                    {/if}
                </div>
            </div>
        </div>
    </div>
</div>
