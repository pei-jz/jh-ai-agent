import { invoke } from '@tauri-apps/api/core';
import { icon } from '../utils/icons.js';
import { OVERVIEW_STYLES } from './OverviewView.styles.js';
import { modelRates } from '../../modules/ai/agent/ModelPhaseRouter.js';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { readWorkspaceMemory, writeCards } from '../../modules/ai/memory/workspaceMemory.js';
import {
    memoryLayers, memoryHealth, recentlyLearned, searchMemory, knowledgeDigest,
    toggleCardDisabled, HALF_LIFE_DAYS,
} from './overview/memoryPanel.js';
import { rankRecipes, readUseCounts, recordUse } from './overview/recipes.js';
import { reduceRun, phaseRail, runCost, runCostBreakdown } from './overview/runFeed.js';
// Cache accounting is provider-dependent and easy to get wrong in both
// directions. There is exactly one implementation of it — the Monitor
// inspector's — and every cost figure in the app now goes through it.
import { costOf, per1m } from './monitor/inspector.js';
import { t } from '../../i18n/index.js';

// Dashboard — a cockpit whose second half is the agent's memory.
//
// The shape came out of nine competing proposals (docs/design/dashboard-*,
// plus three of my own). The reasoning, in short:
//
//   • The page used to be a fixed grid of panels, most of them empty most days.
//     At ~3 tasks a day that taught you within a week that its contents did not
//     depend on anything, which is why it went unread for months.
//   • A pure cockpit fixes the running case and makes the idle case worse: a
//     large live pane is blank six days in seven.
//   • So the right pane is STATEFUL. It shows the run when there is one and what
//     the agent has learned when there is not. Neither half is ever empty in its
//     own state, and the two are joined — a run names the memories it recalled.
//
// The left column never changes: start something, see the queue, see the bill.
// Task creation is still delegated to Monitor's modal (it owns agent mode, MCP
// selection, "/" templates and attachments); this collects the two fields you
// always fill in and hands them over.

/** Failures older than this stop being "attention" and become history. */
export const ATTENTION_WINDOW_H = 48;
/** localStorage: when the Memory tab was last opened, for the "new" badge. */
const MEM_SEEN_KEY = 'jhai_memory_seen_at';
/** localStorage: the last workspace used, shared with the launcher. */
const LAST_WS_KEY = 'jhai_last_ws';

export class OverviewView {
    constructor() {
        this.stats = { totalTokens: 0, estimatedCost: 0.0 };
        this.tasks = [];
        this.config = {};
        /** { facts, episodes, cards } for the workspace the panel is showing. */
        this.memory = null;
        this.memoryWs = '';
        this.memoryError = '';
        /** 'run' | 'memory'. Resolved per render unless the user has picked. */
        this.tab = null;
        this.memSeenAt = 0;
        this.memQuery = '';
        /** Spend window: '1d' | '7d' | '30d'. Persisted so the pick survives a reload. */
        this.spendRange = '7d';
        try { this.spendRange = localStorage.getItem('jhai_dash_spend_range') || '7d'; } catch (_) {}
        /** Stats cut: 'month' | 'week' | 'day' | 'model' | 'ws'. */
        this.statsCut = 'month';
        try { this.statsCut = localStorage.getItem('jhai_dash_stats_cut') || 'month'; } catch (_) {}
        /** Stats period filter: 'all' | '7d' | '30d'. */
        this.statsRange = 'all';
        try { this.statsRange = localStorage.getItem('jhai_dash_stats_range') || 'all'; } catch (_) {}
        /** Stats status filter: 'all' | 'completed' | 'failed' | 'running' | 'paused' | 'aborted'. */
        this.statsStatus = 'all';
        try { this.statsStatus = localStorage.getItem('jhai_dash_stats_status') || 'all'; } catch (_) {}
        this._destroyed = false;
        /** Live run state: the reduction of the watched task's log stream. */
        this.run = null;
        this._runLogs = [];
        this._watchedId = null;
        this._socket = null;
        /** Coalesces bursty socket traffic into one repaint per frame-ish. */
        this._repaintTimer = null;
    }

    // ── Data ─────────────────────────────────────────────────────────────

    async loadData() {
        try {
            if (!window.apiClient) return;
            const [stats, tasks, config] = await Promise.all([
                window.apiClient.getStats().catch(() => null),
                window.apiClient.listTasks().catch(() => null),
                window.apiClient.getConfig().catch(() => null),
            ]);
            this.stats = stats || this.stats;
            this.tasks = Array.isArray(tasks) ? tasks : [];
            this.config = config || {};
        } catch (e) {
            console.error('Failed to load overview data:', e);
        }
        try { promptTemplateManager.loadFromConfig(this.config); } catch (_) {}
        try { this.memSeenAt = Number(localStorage.getItem(MEM_SEEN_KEY)) || 0; } catch (_) {}
    }

    /**
     * Which workspace's memory to show.
     *
     * The one the most recent task ran in, falling back to what the launcher
     * last used and then to the first approved project. Memory is per-workspace,
     * so guessing wrong shows an empty panel for a project that has plenty —
     * following the work is the guess most likely to be right.
     */
    _memoryWorkspace() {
        const withWs = this.tasks.find(t => t.workspace_path);
        if (withWs) return withWs.workspace_path;
        try {
            const last = localStorage.getItem(LAST_WS_KEY);
            if (last) return last;
        } catch (_) {}
        const projects = this.config.approved_projects;
        return (Array.isArray(projects) && projects[0]) || '';
    }

    async loadMemory() {
        const ws = this._memoryWorkspace();
        this.memoryWs = ws;
        this.memoryError = '';
        if (!ws) { this.memory = { facts: [], episodes: [], cards: [] }; return; }
        try {
            this.memory = await readWorkspaceMemory(ws, invoke);
        } catch (e) {
            this.memory = { facts: [], episodes: [], cards: [] };
            this.memoryError = String(e?.message || e);
        }
    }

    // ── Derived ──────────────────────────────────────────────────────────

    _metrics() {
        const now = Date.now();
        const at = (s) => (s ? new Date(s).getTime() : 0);
        const endOf = (t) => at(t.completed_at || t.started_at);
        const attentionMs = now - ATTENTION_WINDOW_H * 3600000;
        // The spend window is user-selectable (today / 7 days / 30 days), not a
        // fixed "this week": the dash is for the bill, and the bill varies.
        const rangeDays = { '1d': 1, '7d': 7, '30d': 30 }[this.spendRange] || 7;
        const rangeMs = now - rangeDays * 86400000;

        const running = this.tasks.filter(t => t.status === 'running');
        const paused = this.tasks.filter(t => t.status === 'paused');

        // Recent failures only. An old failure is history, and history lives in
        // Monitor — a red row you cannot clear is one you stop seeing.
        const failures = this.tasks.filter(t => t.status === 'failed').sort((a, b) => endOf(b) - endOf(a));
        const freshFailures = failures.filter(t => endOf(t) >= attentionMs);

        const recent7 = this.tasks.filter(t => at(t.started_at) >= rangeMs);
        const done7 = recent7.filter(t => t.status === 'completed').length;
        const fail7 = recent7.filter(t => t.status === 'failed').length;
        const successRate = (done7 + fail7) > 0 ? Math.round(done7 / (done7 + fail7) * 100) : null;

        const shown = new Set([...running, ...paused, ...freshFailures].map(t => t.id));
        const recent = [...this.tasks]
            .sort((a, b) => at(b.started_at) - at(a.started_at))
            .filter(t => !shown.has(t.id))
            .slice(0, 6);

        return {
            running, paused, freshFailures,
            staleFailures: failures.length - freshFailures.length,
            recent, successRate, done7,
            rangeDays,
            spend: this._spend(recent7),
        };
    }

    /**
     * Cost for a set of tasks, attributed per model.
     *
     * Prices each model's tokens at that model's own rates, because the
     * breakdown IS the point here: it is the input to the Fast/Deep tier
     * decision. Falls back to a flat rate for anything unpriced rather than
     * pretending it was free.
     *
     * The arithmetic goes through the Monitor inspector's `costOf`, which is the
     * one place that gets the cache accounting right — see the note on
     * `cacheInsideInput`. This used to subtract the cache from the prompt count
     * unconditionally, which is correct for OpenAI-compatible providers (DeepSeek,
     * Kimi, Gemini: cache is a SUBSET of prompt_tokens) and wrong for Anthropic
     * (cache is ADDITIVE), where it could drive the input figure negative.
     */
    _spend(tasks) {
        const rates = modelRates(this.config.llm_instances);
        // model_usage keys are whatever the run sent: an `id:model` composite
        // under tier routing, a bare model name otherwise. Index both.
        const byBare = {};
        for (const [key, r] of Object.entries(rates)) byBare[key.slice(key.indexOf(':') + 1)] = r;
        const rateFor = (m) => rates[m] || byBare[m] || null;

        const flat = this.stats.totalTokens > 0 ? (this.stats.estimatedCost / this.stats.totalTokens) : 0;
        const byModel = new Map();
        let total = 0, unpriced = 0;

        for (const t of tasks) {
            const usage = (t.model_usage && Object.keys(t.model_usage).length)
                ? Object.entries(t.model_usage)
                : [['(unattributed)', t.token_usage || {}]];
            for (const [model, u] of usage) {
                const tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
                if (!tokens) continue;
                const r = rateFor(model);
                let cost;
                if (r) {
                    cost = costOf(u, per1m(r))?.total || 0;
                } else {
                    cost = tokens * flat;
                    unpriced += tokens;
                }
                const label = r ? r.label : shortModel(model);
                const row = byModel.get(label) || { label, tokens: 0, cost: 0, priced: !!r };
                row.tokens += tokens; row.cost += cost;
                byModel.set(label, row);
                total += cost;
            }
        }
        const rows = [...byModel.values()].sort((a, b) => b.cost - a.cost);
        return { total, rows, unpriced, tokens: rows.reduce((s, r) => s + r.tokens, 0) };
    }

    /** Which tab to show: the user's pick, else the run when there is one. */
    _activeTab(m) {
        if (this.tab) return this.tab;
        return m.running.length ? 'run' : 'memory';
    }

    _newCards() {
        return recentlyLearned(this.memory?.cards, this.memSeenAt);
    }

    /**
     * Workspaces the agent has actually run in, newest first, plus the approved
     * projects and the one currently shown. This is what the memory tab offers:
     * memory lives per workspace, so picking one it already knows is the common
     * action and should take a single click, not a typed path.
     */
    _knownWorkspaces() {
        const seen = [];
        const add = (p) => {
            const v = String(p || '').trim();
            if (v && !seen.includes(v)) seen.push(v);
        };
        // Newest-run-first is the order a person expects: the workspace they
        // were just working in is the one they most likely want to look at.
        [...this.tasks]
            .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
            .forEach(t => add(t.workspace_path));
        (Array.isArray(this.config.approved_projects) ? this.config.approved_projects : []).forEach(add);
        add(this.memoryWs);
        return seen;
    }

    // ── Render ───────────────────────────────────────────────────────────

    render() {
        // Skeleton only — data is fetched in init() so the view paints at once
        // instead of waiting on three API calls plus three file reads.
        return `
            <style>${OVERVIEW_STYLES}</style>
            <div class="view-container">
                <div class="dash">
                    <div class="dash-head">
                        <h1 class="dash-title">Now</h1>
                        <span class="dash-status" id="dash-status">&nbsp;</span>
                        <a class="dash-head-link" href="#monitor">${icon('monitor', 12)} All tasks</a>
                    </div>
                    <div class="dash-cols">
                        <div class="dash-left" id="dash-left"></div>
                        <div class="dash-right">
                            <div class="dt-bar" id="dash-tabs"></div>
                            <div class="dt-pane" id="dash-pane"></div>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    _leftHtml(m) {
        const projects = Array.isArray(this.config.approved_projects) ? this.config.approved_projects : [];
        let lastWs = '';
        try { lastWs = localStorage.getItem(LAST_WS_KEY) || ''; } catch (_) {}
        const ws = lastWs || projects[0] || '';

        const recipes = rankRecipes(safeTemplates(), readUseCounts());
        const recipeHtml = recipes.length
            ? recipes.map(r => `
                <button type="button" class="dr-chip" data-recipe="${esc(r.key)}"
                    title="${esc(clip(r.prompt, 120))}">${esc(clip(r.label, 22))}${
                        r.uses ? `<span class="n">×${r.uses}</span>` : ''}</button>`).join('')
              + `<a class="dr-chip is-add" href="#config?tab=templates">${icon('plus', 10)} Add</a>`
            : `<a class="dr-chip is-add" href="#config?tab=templates">${icon('plus', 10)} Add a template to get one-click starts</a>`;

        const group = (label, tasks, opts = {}) => {
            if (!tasks.length) return '';
            return `<span class="a-lab dq-lab">${label}</span>`
                + tasks.map(t => this._queueRow(t, opts)).join('');
        };

        return `
            <form class="dl" id="dash-launch" autocomplete="off">
                <textarea id="dash-prompt" class="dl-input" rows="1"
                    placeholder="${m.running.length ? 'Queue another task…' : 'What should the agent do?'}"></textarea>
                <div class="dl-row">
                    <input id="dash-ws" class="dl-ws" type="text" list="dash-ws-list"
                        value="${esc(ws)}" placeholder="(no workspace)" aria-label="Workspace">
                    <datalist id="dash-ws-list">${projects.map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
                    <button type="button" class="btn btn-secondary dl-browse" id="dash-ws-browse"
                        title="Browse for a workspace folder" aria-label="Browse for a workspace folder">${icon('folder', 12)}</button>
                    <button type="submit" class="btn btn-primary dl-go">${icon('bolt', 12)} Start</button>
                </div>
            </form>

            <div class="dr">
                <span class="a-lab dr-lab">Recipes</span>
                <div class="dr-chips">${recipeHtml}</div>
            </div>

            <div class="dq">
                ${group('Waiting for you', m.paused)}
                ${group('Running', m.running, { sel: true })}
                ${group(`Failed · last ${ATTENTION_WINDOW_H}h`, m.freshFailures.slice(0, 3))}
                ${group('Recent', m.recent)}
                ${(m.paused.length + m.running.length + m.freshFailures.length + m.recent.length) === 0
                    ? '<div class="dq-empty">No tasks yet. Describe one above.</div>' : ''}
                ${m.staleFailures ? `<a class="dq-more" href="#monitor">${m.staleFailures} older failures in Monitor →</a>` : ''}
            </div>

            ${this._spendHtml(m)}`;
    }

    _queueRow(t, opts = {}) {
        const cls = { running: 'dot-running', paused: 'dot-paused', failed: 'dot-failed',
            completed: 'dot-completed' }[t.status] || 'dot-aborted';
        return `
            <a class="dqi ${opts.sel ? 'is-sel' : ''}" href="#monitor?id=${encodeURIComponent(t.id)}">
                <span class="drow-dot ${cls}"></span>
                <span class="grow">${esc(t.prompt || '(no prompt)')}</span>
                <span class="t">${ago(t.completed_at || t.started_at)}</span>
            </a>`;
    }

    _spendHtml(m) {
        const s = m.spend;
        if (!s.rows.length) return '';
        const shades = ['var(--accent)', 'var(--accent-dim)', 'var(--text-tertiary)'];
        const pctOf = (r) => (s.total > 0 ? r.cost / s.total * 100 : 0);
        // A model that rounds to 0% is a rounding artefact, not information —
        // it was making the legend read "…· (unattributed) 0%".
        const top = s.rows.slice(0, 3).filter(r => Math.round(pctOf(r)) > 0);
        const bar = top.map((r, i) =>
            `<i style="width:${Math.max(1, pctOf(r))}%;background:${shades[i]}"></i>`).join('');
        const lg = top.map((r, i) =>
            `<span><i class="ds-sw" style="background:${shades[i]}"></i>${esc(clip(r.label, 18))} ${Math.round(pctOf(r))}%</span>`).join('');

        // Only worth saying when there IS somewhere cheaper to move the work to.
        const share = s.total > 0 ? Math.round(s.rows[0].cost / s.total * 100) : 0;
        const tip = (s.rows.length > 1 && share >= 60 && s.rows[0].priced)
            ? `<p class="ds-tip">${esc(clip(s.rows[0].label, 24))} is ${share}% of it —
                 <a class="cfg-link" href="#config">switch models within one task</a> moves the
                 implementation phase onto the cheaper tier.</p>`
            : (s.unpriced > 0
                ? `<p class="ds-tip">${fmt(s.unpriced)} tokens were estimated —
                     <a class="cfg-link" href="#config">set $/1M rates</a> per connection.</p>`
                : '');

        return `
            <div class="ds">
                <div class="ds-top">
                    <span class="ds-v">${money(s.total)}</span>
                    <span class="ds-range" role="group" aria-label="Spend window">
                        ${['1d', '7d', '30d'].map(r => `
                            <button type="button" class="ds-range-btn ${this.spendRange === r ? 'is-on' : ''}"
                                data-range="${r}">${r === '1d' ? 'Today' : r}</button>`).join('')}
                    </span>
                </div>
                <div class="ds-k">${m.rangeDays}d · ${m.done7} done${m.successRate !== null ? ` · ${m.successRate}%` : ''}</div>
                <div class="ds-bar">${bar}</div>
                <div class="ds-lg">${lg}</div>
                ${this._spendRowsHtml(s)}
                ${tip}
            </div>`;
    }

    /**
     * Tokens AND money, per model.
     *
     * The bar above answers "what is the split"; it cannot answer "how much did
     * that model actually cost me", because a percentage of an unknown total is
     * not a number anyone can act on. Every model appears — including the ones
     * too small for the bar's top-3 — since a cheap tier that turns out to be
     * running most of the tokens is exactly what this view is for.
     */
    _spendRowsHtml(s) {
        if (!s.rows.length) return '';
        return `
            <table class="ds-tbl">
                <thead><tr><th>${esc(t('dash.spend.model'))}</th><th>${esc(t('dash.spend.tokens'))}</th><th>${esc(t('dash.spend.cost'))}</th></tr></thead>
                <tbody>
                    ${s.rows.map(r => `
                        <tr${r.priced ? '' : ' class="is-est"'}>
                            <td title="${esc(r.label)}">${esc(clip(r.label, 28))}</td>
                            <td>${fmt(r.tokens)}</td>
                            <td>${money(r.cost)}${r.priced ? '' : `<span class="ds-est" title="${esc(t('dash.spend.estimated'))}">≈</span>`}</td>
                        </tr>`).join('')}
                </tbody>
            </table>`;
    }

    _tabsHtml(m) {
        const active = this._activeTab(m);
        const running = m.running.length;
        const newCount = this._newCards().length;
        const projects = Array.isArray(this.config.approved_projects) ? this.config.approved_projects : [];
        // Preserve the user's in-progress edit across repaints.
        const memWsInput = document.getElementById('dash-mem-ws');
        const memWsValue = memWsInput ? memWsInput.value : (this.memoryWs || '');
        return `
            <button type="button" class="dt-tab ${active === 'run' ? 'is-on' : ''}"
                data-tab="run" ${running ? '' : 'disabled'}>
                ${running ? '<span class="drow-dot dot-running"></span>' : ''} Run
            </button>
            <button type="button" class="dt-tab ${active === 'memory' ? 'is-on' : ''}" data-tab="memory">
                ${icon('memory', 13)} Memory
                ${newCount ? `<span class="dt-cnt">${newCount} new</span>` : ''}
            </button>
            <button type="button" class="dt-tab ${active === 'stats' ? 'is-on' : ''}" data-tab="stats">
                ${icon('report', 13)} Stats
            </button>
            <span class="dt-ws">
                <input id="dash-mem-ws" class="dt-ws-input" type="text" list="dash-mem-ws-list"
                    value="${esc(memWsValue)}" placeholder="(no workspace)" aria-label="Memory workspace">
                <datalist id="dash-mem-ws-list">
                    ${[...new Set([...projects, ...this._knownWorkspaces()])].map(p => `<option value="${esc(p)}"></option>`).join('')}
                </datalist>
                <button type="button" class="dt-ws-browse" id="dash-mem-ws-browse"
                    title="Browse for a memory workspace folder" aria-label="Browse for a memory workspace folder">${icon('folder', 11)}</button>
            </span>`;
    }

    _paneHtml(m) {
        const active = this._activeTab(m);
        if (active === 'run') return this._runHtml(m);
        if (active === 'stats') return this._statsHtml(m);
        return this._memoryHtml();
    }

    /**
     * The Run tab — what is happening right now.
     *
     * The step lines come from Monitor's own formatters via runFeed.js; only the
     * compact shape is this view's. The full grouped timeline stays in Monitor,
     * one click away, and this never tries to be it.
     */
    _runHtml(m) {
        const t = m.running[0];
        if (!t) return `<div class="dash-empty"><p>Nothing is running.</p></div>`;

        const run = this.run || reduceRun([]);
        const rail = phaseRail(run);
        const cost = runCost(run, modelRates(this.config.llm_instances));
        const breakdown = runCostBreakdown(run, modelRates(this.config.llm_instances));
        const tokens = run.tokens.prompt + run.tokens.completion;
        const pct = Math.round((t.progress || 0) * 100);

        return `
            <div class="dm">
                <div class="dm-h" style="border-radius:var(--radius-sm);border:1px solid var(--border-light)">
                    <span class="drow-dot dot-running"></span>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(clip(t.prompt || '', 96))}</span>
                    <a class="more" href="#monitor?id=${encodeURIComponent(t.id)}">Open in Monitor →</a>
                </div>

                <div class="dm-layers" style="grid-template-columns:repeat(4,1fr)">
                    <div><span class="k">STEP</span><span class="v">${run.step || '—'}</span>
                        <span class="s">${pct}% of plan</span></div>
                    <div><span class="k">ELAPSED</span><span class="v">${elapsed(t.started_at)}</span>
                        <span class="s">since ${ago(t.started_at)}</span></div>
                    <div><span class="k">TOKENS</span><span class="v">${short(tokens)}</span>
                        <span class="s">${short(run.tokens.cacheRead)} cached</span></div>
                    <div><span class="k">COST SO FAR</span><span class="v">${cost === null ? '—' : money(cost)}</span>
                        <span class="s">${cost === null ? 'no $/1M rates set' : 'at your rates'}</span></div>
                </div>

                ${rail.length ? `<div class="dp-rail">${rail.map(p => `
                    <div class="dp-ph is-${p.state}">
                        <span class="n">${p.phase.toUpperCase()}${p.state === 'now' ? ' · now' : ''}</span>
                        <span class="m">${p.model ? esc(shortModel(p.model)) : '—'}${
                            p.tokens ? ` · ${short(p.tokens)}` : ''}</span>
                    </div>`).join('')}</div>
                    ${run.escalated ? `<p class="dm-note" style="padding:0 2px">Execution was promoted to the
                        deep tier — this run was long enough that the cheap model was struggling.</p>` : ''}
                ` : ''}

                ${this._modelBreakdownHtml(run, breakdown)}
                ${this._switchLogHtml(run)}

                ${this._inPlayHtml(run)}

                <div class="dm-box">
                    <div class="dm-h">Live steps</div>
                    <div class="dp-steps">
                        ${run.steps.length
                            ? run.steps.map((s, i) => `
                                <div class="dp-step is-${esc(s.kind)} ${i === run.steps.length - 1 ? 'is-live' : ''}">
                                    <span class="n">${s.n || ''}</span>
                                    <span class="tx">${esc(s.text)}</span>
                                </div>`).join('')
                            : `<p class="dm-note">Waiting for the first step…</p>`}
                    </div>
                </div>

                ${run.files.size ? `<p class="dm-note" style="padding:0 2px">${
                    run.files.size} file${run.files.size === 1 ? '' : 's'} changed so far.</p>` : ''}
            </div>`;
    }

    /**
     * Model-by-model token + cost table for the live run.
     *
     * The four stat cells total the run; this breaks it apart per model, which
     * is what "why did the model switch" and "what is that switch saving me"
     * both need. Rows with no configured rate still show their token count —
     * hiding them would make a cheap tier invisible exactly when it matters.
     */
    _modelBreakdownHtml(run, breakdown) {
        if (!breakdown?.rows?.length) return '';
        return `
            <div class="dm-box">
                <div class="dm-h">Model usage</div>
                <table class="ds-tbl">
                    <thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead>
                    <tbody>
                        ${breakdown.rows.map(r => `
                            <tr${r.priced ? '' : ' class="is-est"'}>
                                <td title="${esc(r.model)}">${esc(clip(r.label, 28))}</td>
                                <td title="${fmt(r.tokens)} total · ${fmt(r.prompt)} in · ${fmt(r.completion)} out">${short(r.tokens)}</td>
                                <td>${r.cost === null ? '—' : money(r.cost)}${r.priced ? '' : '<span class="ds-est">≈</span>'}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    /**
     * Why the run is on the model it is on — every pick and every switch, with
     * its trigger, newest first.
     */
    _switchLogHtml(run) {
        if (!run?.switches?.length) return '';
        return `
            <div class="dm-box">
                <div class="dm-h">Model switches · why</div>
                ${run.switches.slice().reverse().map(s => `
                    <div class="dp-switch">
                        <span class="dp-switch-m">${esc(shortModel(s.model))}</span>
                        ${s.from ? `<span class="dp-switch-from">← ${esc(shortModel(s.from))}</span>` : ''}
                        <span class="dp-switch-r">${esc(s.reason)}</span>
                    </div>`).join('')}
            </div>`;
    }

    /**
     * "Memory in play" — the join between the two halves of this page.
     *
     * Neither half had this alone: the cockpit showed work without memory, the
     * memory hub showed memory without work. Seeing a lesson fire at step 12 and
     * the same failure at step 13 is what makes a useless card visible at the
     * moment it is being useless — which is when you would actually switch it off.
     */
    _inPlayHtml(run) {
        if (!run.recalls.length) return '';
        return `
            <div class="dp-inplay">
                <div class="dp-inplay-h">
                    ${icon('memory', 12)} Memory in play · ${run.recalls.length}
                    <button type="button" class="more dash-go-memory">Manage in Memory →</button>
                </div>
                ${run.recalls.map(c => `
                    <div class="dp-inplay-l">
                        <span class="at">${c.source === 'brief' ? 'brief' : `step ${c.at}`}</span>
                        <span><b>${esc(c.type || 'card')}</b> ${esc(clip(c.recipe || c.headline || '', 90))}</span>
                    </div>`).join('')}
            </div>`;
    }

    _memoryHtml() {
        const mem = this.memory;
        if (!mem) return `<div class="dash-empty"><p>Loading memory…</p></div>`;
        if (!this.memoryWs) {
            return `<div class="dash-empty">
                <div class="dash-empty-ico">${icon('memory', 28)}</div>
                <h3>No workspace yet</h3>
                <p>Memory is stored per workspace, under <code>.agent/</code>. Run a task in one and
                   what it learns will show up here.</p></div>`;
        }
        if (this.memoryError) {
            return `<div class="dash-empty"><h3>Could not read memory</h3>
                <p>${esc(this.memoryError)}</p></div>`;
        }

        const L = memoryLayers(mem);
        const H = memoryHealth(mem.cards);
        const results = this.memQuery ? searchMemory(mem, this.memQuery) : [];
        // One-click switches to a workspace the agent already knows. A list of
        // paths is reference material, not a form: chips are easier to scan and
        // click than a datalist, and the current one is visibly marked.
        const known = this._knownWorkspaces();
        const chips = known.length > 1
            ? `<div class="dm-wschips">${known.map(ws => `
                <button type="button" class="dm-wschip ${ws === this.memoryWs ? 'is-on' : ''}"
                    data-ws="${esc(ws)}" title="${esc(ws)}">${esc(baseName(ws))}</button>`).join('')}
            </div>`
            : '';

        if (!L.totalCards && !L.totalFacts && !L.episodes) {
            return `<div class="dash-empty">
                <div class="dash-empty-ico">${icon('memory', 28)}</div>
                <h3>Nothing learned yet</h3>
                <p>Cards appear after runs that hit a problem, or that found something worth
                   reusing. Facts appear when a run states a rule about this project.</p></div>`;
        }

        return `
            <div class="dm">
                <div class="dm-layers">
                    <div><span class="k">DURABLE</span><span class="v">${L.durable}</span><span class="s">facts</span></div>
                    <div><span class="k">EPISODIC</span><span class="v">${L.episodic}</span><span class="s">on probation</span></div>
                    <div><span class="k">LESSONS</span><span class="v">${L.lessons}</span><span class="s">what failed</span></div>
                    <div><span class="k">INSIGHTS</span><span class="v">${L.insights}</span><span class="s">what worked</span></div>
                    <div><span class="k">EPISODES</span><span class="v">${L.episodes}</span><span class="s">sessions kept</span></div>
                </div>

                ${this._healthHtml(H)}

                <div class="dm-search">
                    ${icon('search', 13)}
                    <input id="dash-mem-q" type="text" value="${esc(this.memQuery)}"
                        placeholder="${esc(t('dash.mem.searchHint'))}"
                        aria-label="${esc(t('dash.mem.searchHint'))}">
                    <span class="sc">${L.totalCards} cards · ${L.totalFacts} facts</span>
                </div>
                ${chips}
                ${this.memQuery ? `<div class="dm-box dm-results">${
                    results.length
                        ? results.map(r => this._memRowHtml(r, { plain: true })).join('')
                        : `<p class="dm-note">Nothing matches “${esc(this.memQuery)}”.</p>`
                }</div>` : this._digestHtml()}
            </div>`;
    }

    /**
     * "Is it working?" — the panel's headline.
     *
     * Deliberately NOT the cards' own `confidence`: that is the agent's estimate
     * of itself and a useless lesson is just as confident as a good one. This is
     * measured after the fact — of the times a card was shown, how often the
     * failure came back anyway — so it is the only figure here that can tell you
     * to switch something off.
     */
    _healthHtml(H) {
        if (!H.total) return '';
        if (!H.shown) {
            return `<div class="dm-box">
                <div class="dm-h">${icon('shield', 13)} Is it working?</div>
                <p class="dm-note">${H.total} card${H.total === 1 ? '' : 's'} stored,
                   none surfaced to a run yet — so there is nothing to judge yet.
                   This fills in as they get used.</p>
            </div>`;
        }
        const pctOf = (n) => (n / H.shown * 100);
        const failing = H.failingCards.map(f => `
            <div class="dm-frow">
                <span class="drow-dot dot-failed"></span>
                <span class="grow" title="${esc(f.detail)}">${esc(f.headline)}</span>
                <span class="dm-rate">${f.rate.toFixed(2)}</span>
                <label class="dm-toggle" title="Switch this card off">
                    <input type="checkbox" class="dash-card-toggle" data-card="${esc(f.card.id)}" checked>
                    <i></i>
                </label>
            </div>`).join('');

        return `
            <div class="dm-box">
                <div class="dm-h">
                    ${icon('shield', 13)} Is it working?
                    <span class="more">${H.shown} of ${H.total} used · half-life ${HALF_LIFE_DAYS}d</span>
                </div>
                <div class="dm-bar">
                    <i style="width:${pctOf(H.held)}%;background:var(--success)"></i>
                    <i style="width:${pctOf(H.partial)}%;background:var(--warning)"></i>
                    <i style="width:${pctOf(H.failing)}%;background:var(--error)"></i>
                </div>
                <div class="dm-lg">
                    <span><i class="dm-sw" style="background:var(--success)"></i><b>${H.held}</b> held — failure stopped</span>
                    ${H.partial ? `<span><i class="dm-sw" style="background:var(--warning)"></i>${H.partial} partial</span>` : ''}
                    ${H.failing ? `<span><i class="dm-sw" style="background:var(--error)"></i>${H.failing} still recurring</span>` : ''}
                </div>
                ${failing ? `<div class="dm-fail">
                    <div class="dm-fail-t">Not earning their place</div>${failing}</div>` : ''}
            </div>`;
    }

    // NOTE: _learnedHtml is gone. It rendered a "Learned since you last looked"
    // box from CARDS only, which is why a workspace with facts and no cards had
    // an empty body. _digestHtml below covers the same ground for both stores,
    // and marks the new rows rather than hiding the older ones.

    /**
     * The panel's DEFAULT body — what it knows, without being asked.
     *
     * Previously the body was a search box and nothing else: results existed only
     * once you typed, and the "learned recently" box covered cards alone. A
     * workspace with 14 facts and no cards rendered the number 14 and none of the
     * facts. Reviewing what the agent believes is the reason to open this panel,
     * so the knowledge is now the default view and search is the filter.
     */
    _digestHtml() {
        const d = knowledgeDigest(this.memory, { sinceMs: this.memSeenAt });
        const section = (ico, title, rows, note) => (rows.length ? `
            <div class="dm-box">
                <div class="dm-h">
                    ${icon(ico, 13)} ${title}
                    <span class="badge">${rows.length}</span>
                    ${note ? `<span class="dm-note-inline">${note}</span>` : ''}
                    <a class="more" href="#config?tab=memory">Settings → Memory →</a>
                </div>
                ${rows.map(r => this._memRowHtml(r, { plain: true })).join('')}
            </div>` : '');

        const newCount = d.recent.filter(r => r.isNew).length;
        const body = section('shield', t('dash.mem.rules'), d.rules, t('dash.mem.rules.note'))
            + section('sparkle', t('dash.mem.recent'), d.recent,
                newCount ? t('dash.mem.recent.note', { count: newCount }) : '')
            + section('alert', t('dash.mem.lessons'), d.lessons, t('dash.mem.lessons.note'));

        // Counts above but nothing below would read as a broken panel; say why.
        return body || `<p class="dm-note">${esc(t('dash.mem.nothingToShow'))}</p>`;
    }

    _memRowHtml(r, { plain = false } = {}) {
        const card = r.card;
        const badge = r.badge || 'note';
        const meta = card
            ? [card.costSteps ? `cost ${card.costSteps} steps` : '',
               card.hits > 1 ? `seen ${card.hits}×` : '',
               card.last_recurrence || card.first_seen || ''].filter(Boolean).join(' · ')
            : (r.detail || '');
        return `
            <div class="dm-row ${card?.disabled ? 'is-off' : ''}">
                <span class="dm-badge is-${esc(badge)}">${esc(badge)}</span>
                ${r.isNew ? `<span class="dm-new" title="${esc(t('dash.mem.new.title'))}">${esc(t('dash.mem.new'))}</span>` : ''}
                <span class="body">
                    <span class="hl">${esc(r.headline || '')}</span>
                    <span class="dt">${esc(r.detail || '')}</span>
                    ${card && !plain ? `<span class="mt">${esc(meta)}</span>` : ''}
                </span>
                ${card ? `<label class="dm-toggle" title="${card.disabled ? 'Switch back on' : 'Switch off'}">
                    <input type="checkbox" class="dash-card-toggle" data-card="${esc(card.id)}"
                        ${card.disabled ? '' : 'checked'}>
                    <i></i>
                </label>` : ''}
            </div>`;
    }

    // ── Stats tab ────────────────────────────────────────────────────────

    /**
     * Aggregate every task's tokens and cost into a per-bucket table.
     *
     * Each task contributes its `model_usage` slices (falling back to
     * `token_usage`), priced per model. Buckets are the date-group label
     * (`month` / `week` / `day`), the model, or the workspace.
     *
     * @param {Array} tasks the tasks to aggregate
     * @param {string} by 'month' | 'week' | 'day' | 'model' | 'ws'
     * @returns {Array<{label:string, tokens:number, cost:number, priced:boolean}>}
     */
    _aggregate(tasks, by) {
        const rates = modelRates(this.config.llm_instances);
        const byBare = {};
        for (const [key, r] of Object.entries(rates)) byBare[key.slice(key.indexOf(':') + 1)] = r;
        const rateFor = (m) => rates[m] || byBare[m] || null;
        const flat = this.stats.totalTokens > 0 ? (this.stats.estimatedCost / this.stats.totalTokens) : 0;

        const bucketOf = (t) => {
            const at = (s) => (s ? new Date(s).getTime() : 0);
            const ts = at(t.completed_at || t.started_at);
            const d = ts ? new Date(ts) : new Date();
            if (by === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (by === 'day') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (by === 'week') {
                // ISO-ish week: the Monday of the week containing the task.
                const day = (d.getDay() + 6) % 7; // 0 = Monday
                const mon = new Date(d);
                mon.setDate(d.getDate() - day);
                return `${mon.getFullYear()}-W${String(Math.ceil((mon.getDate() + 1 - mon.getDay()) / 7) || 1).padStart(2, '0')}`;
            }
            if (by === 'ws') {
                const p = String(t.workspace_path || '').replace(/\\/g, '/').replace(/\/+$/, '');
                return p.split('/').filter(Boolean).pop() || '(no workspace)';
            }
            return '';
        };

        const rows = new Map();
        let totalCost = 0, unpriced = 0;
        for (const t of tasks) {
            const usage = (t.model_usage && Object.keys(t.model_usage).length)
                ? Object.entries(t.model_usage)
                : [['(unattributed)', t.token_usage || {}]];
            for (const [model, u] of usage) {
                const tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
                if (!tokens) continue;
                const r = rateFor(model);
                const cost = r ? (costOf(u, per1m(r))?.total || 0) : (tokens * flat);
                if (!r) unpriced += tokens;
                const key = by === 'model'
                    ? (r ? r.label : shortModel(model))
                    : bucketOf(t);
                const row = rows.get(key) || { label: key, tokens: 0, cost: 0, priced: !!r };
                row.tokens += tokens; row.cost += cost;
                if (r) row.priced = true;
                rows.set(key, row);
                totalCost += cost;
            }
        }
        return {
            rows: [...rows.values()].sort((a, b) => b.cost - a.cost),
            total: totalCost, unpriced,
        };
    }

    /**
     * Tasks filtered by the Stats tab's own conditions (period + status).
     *
     * Both pickers feed every figure below — KPIs, the per-bucket breakdown,
     * and the task sample — so "how much did failed tasks cost this week?" is
     * one click, not a mental step.
     */
    _statsTasks() {
        const rangeDays = { '7d': 7, '30d': 30 }[this.statsRange] || 0;
        const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : 0;
        return (this.tasks || []).filter(t => {
            if (this.statsStatus !== 'all' && t.status !== this.statsStatus) return false;
            if (cutoff) {
                const at = t.started_at ? new Date(t.started_at).getTime() : 0;
                if (!at || at < cutoff) return false;
            }
            return true;
        });
    }

    /**
     * The status buttons offered in the Stats tab: statuses that actually exist
     * in history (so the row never offers an empty filter), plus the currently
     * selected one so a pick stays visible even after history changes.
     */
    _statsStatuses() {
        const seen = new Set((this.tasks || []).map(t => t.status).filter(Boolean));
        return ['completed', 'failed', 'aborted', 'paused', 'running']
            .filter(s => seen.has(s) || this.statsStatus === s);
    }

    /**
     * Per-model token breakdown with the Input/Cache/Output split.
     *
     * Same shape as the Monitor inspector's model rows (`in ↑ · cache ⚡ · out ↓`)
     * so a number read in one place reads the same in the other. The cache column
     * is only shown when some model actually reported cached tokens.
     *
     * @returns {Array<{model:string, tokens:number, in:number, cache:number, out:number}>}
     */
    _modelTokenRows(tasks) {
        const rows = new Map();
        let anyCache = false;
        for (const t of tasks) {
            const usage = (t.model_usage && Object.keys(t.model_usage).length)
                ? t.model_usage
                : { '(unattributed)': t.token_usage || {} };
            for (const [model, u] of Object.entries(usage)) {
                const inn = Number(u.prompt_tokens) || 0;
                const cache = Number(u.cache_read_input_tokens) || 0;
                const out = Number(u.completion_tokens) || 0;
                if (!(inn + cache + out)) continue;
                const row = rows.get(model) || { model, tokens: 0, in: 0, cache: 0, out: 0 };
                row.in += inn; row.cache += cache; row.out += out;
                row.tokens += inn + cache + out;
                if (cache) anyCache = true;
                rows.set(model, row);
            }
        }
        const list = [...rows.values()]
            .sort((a, b) => b.tokens - a.tokens)
            .map(r => ({ ...r, tokens: r.in + r.cache + r.out }));
        return { rows: list, anyCache };
    }

    /** Total tokens for a task, whichever record carries them. */
    _taskTokens(t) {
        if (t.token_usage && t.token_usage.total_tokens) return t.token_usage.total_tokens;
        if (t.model_usage) {
            let n = 0;
            for (const u of Object.values(t.model_usage)) n += (u.total_tokens || 0);
            return n;
        }
        return 0;
    }

    /**
     * One-line per-model token summary for a task row.
     *
     * "k3 123k · flash 12k" — the same ↑⚡↓ split as the model table above, but
     * compressed to a single line because a task row must stay scannable. Empty
     * when the task carries no per-model record.
     */
    _taskModelLine(t) {
        const usage = (t.model_usage && Object.keys(t.model_usage).length)
            ? t.model_usage
            : (t.token_usage ? { '(all)': t.token_usage } : null);
        if (!usage) return '';
        const parts = [];
        for (const [model, u] of Object.entries(usage)) {
            const inn = Number(u.prompt_tokens) || 0;
            const cache = Number(u.cache_read_input_tokens) || 0;
            const out = Number(u.completion_tokens) || 0;
            if (!(inn + cache + out)) continue;
            const tok = short(inn + cache + out);
            parts.push(cache
                ? `${shortModel(model)} ${tok} (${short(inn)}↑ · ${short(cache)}⚡ · ${short(out)}↓)`
                : `${shortModel(model)} ${tok}`);
        }
        return parts.slice(0, 3).join(' · ');
    }

    /**
     * The Stats tab body: token spend and cost under the current conditions,
     * cut by date (month/week/day), by model, and by workspace.
     *
     * The conditions — period and status — are picked at the top and every
     * figure below obeys them: KPI row, breakdown bars and the task sample all
     * describe the SAME set, so cross-reading them (e.g. how many tokens the
     * failures burned) is a filter change, not arithmetic.
     */
    _statsHtml(m) {
        const tasks = this._statsTasks();
        if (!this.tasks.length) {
            return `<div class="dash-empty"><p>No tasks yet — run something and the usage breakdown will appear here.</p></div>`;
        }
        if (!tasks.length) {
            const noMatch = this.statsStatus !== 'all' && this.statsRange !== 'all'
                ? `No ${this.statsStatus} tasks in this period — change the conditions above.`
                : `No tasks match these conditions — change them above.`;
            return `<div class="dash-empty"><p>${noMatch}</p></div>`;
        }

        const cuts = [
            ['month', t('dash.stats.month')],
            ['week', t('dash.stats.week')],
            ['day', t('dash.stats.day')],
            ['model', t('dash.stats.model')],
            ['ws', t('dash.stats.ws')],
        ];
        const ranges = [
            ['all', t('dash.stats.all')],
            ['7d', t('dash.stats.last7d')],
            ['30d', t('dash.stats.last30d')],
        ];
        const statuses = this._statsStatuses();
        const cut = this.statsCut || 'month';
        const agg = this._aggregate(tasks, cut);

        const done = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const ended = done + failed;
        const successRate = ended ? Math.round(done / ended * 100) : null;
        const tokens = tasks.reduce((s, t) => s + this._taskTokens(t), 0);
        const totalCost = this._spend(tasks).total;
        const avgCost = tasks.length ? totalCost / tasks.length : 0;
        const avgTok = tasks.length ? Math.round(tokens / tasks.length) : 0;

        const maxCost = Math.max(1, ...agg.rows.map(r => r.cost));
        const barRows = agg.rows.map(r => {
            const pct = Math.round(r.cost / maxCost * 100);
            const bar = `<i style="width:${Math.max(1, pct)}%"></i>`;
            return `
                <div class="ds-st-row">
                    <span class="ds-st-label" title="${esc(r.label)}">${esc(clip(r.label, 26))}</span>
                    <span class="ds-st-bar">${bar}</span>
                    <span class="ds-st-tok">${short(r.tokens)} tok</span>
                    <span class="ds-st-cost">${money(r.cost)}${r.priced ? '' : '<span class="ds-est">≈</span>'}</span>
                </div>`;
        }).join('');

        // Model × (fresh input / cache / output) — the same split the Monitor
        // inspector draws, so the two agree about what "in" means. A cheap tier
        // that runs most of the TOKENS while costing little is exactly the
        // insight this row exists for, which is why it shows tokens, not cost.
        const modelTok = this._modelTokenRows(tasks);
        const modelRows = modelTok.rows.map(r => `
            <div class="ds-st-mrow">
                <span class="ds-st-label" title="${esc(r.model)}">${esc(clip(shortModel(r.model), 26))}</span>
                <span class="ds-st-mtok">${short(r.in)}↑ · ${short(r.cache)}⚡ · ${short(r.out)}↓</span>
                <span class="ds-st-tok">${short(r.tokens)} tok</span>
            </div>`).join('');

        const sample = [...tasks]
            .sort((a, b) => (b.completed_at || b.started_at || '').localeCompare(a.completed_at || a.started_at || ''))
            .slice(0, 8);
        const sampleRows = sample.map(t => {
            // Per-task model breakdown — a one-line summary, the detail in a
            // tooltip so a row that used several models can still be scanned.
            const modelLine = this._taskModelLine(t);
            return `
            <a class="ds-st-task" href="#monitor?id=${encodeURIComponent(t.id)}">
                <span class="drow-dot dot-${t.status}"></span>
                <span class="grow">${esc(clip(t.prompt || '(no prompt)', 60))}</span>
                <span class="ds-st-task-tok" title="${esc(modelLine)}">${short(this._taskTokens(t))} tok${modelLine ? ` <span class="ds-st-task-models">· ${modelLine}</span>` : ''}</span>
                <span class="ds-st-task-cost">${money(this._spend([t]).total)}</span>
                <span class="ds-st-task-when">${ago(t.completed_at || t.started_at)}</span>
            </a>`;
        }).join('');

        return `
            <div class="dm">
                <div class="dm-layers">
                    <div><span class="k">TASKS</span><span class="v">${tasks.length}</span><span class="s">${this.statsStatus === 'all' ? 'all statuses' : this.statsStatus}</span></div>
                    <div><span class="k">SUCCESS</span><span class="v">${successRate === null ? '—' : successRate + '%'}</span><span class="s">${done} done / ${failed} failed</span></div>
                    <div><span class="k">COST</span><span class="v">${money(totalCost)}</span><span class="s">≈ ${money(avgCost)} / task</span></div>
                    <div><span class="k">TOKENS</span><span class="v">${short(tokens)}</span><span class="s">≈ ${short(avgTok)} / task</span></div>
                </div>

                <div class="ds-st-toolbar">
                    ${ranges.map(([key, label]) => `
                        <button type="button" class="ds-st-cut ${this.statsRange === key ? 'is-on' : ''}" data-range="${key}">${esc(label)}</button>
                    `).join('')}
                    <span class="ds-st-sep"></span>
                    ${statuses.map(s => `
                        <button type="button" class="ds-st-cut ${this.statsStatus === s ? 'is-on' : ''}" data-status="${s}">${esc(s)}</button>
                    `).join('')}
                </div>

                <div class="dm-box">
                    <div class="dm-h">${esc(t('dash.stats.by', { cut: cuts.find(c => c[0] === cut)?.[1] || cut }))}
                        <span class="more">${esc(t('dash.stats.sortHint'))}</span>
                    </div>
                    ${agg.rows.length
                        ? `<div class="ds-st-list">${barRows}</div>`
                        : `<p class="dm-note">${esc(t('dash.stats.empty'))}</p>`}
                </div>

                ${modelTok.rows.length ? `
                <div class="dm-box">
                    <div class="dm-h">${esc(t('dash.stats.modelSplit'))}
                        ${modelTok.anyCache ? '' : `<span class="more">${esc(t('dash.stats.noCache'))}</span>`}
                    </div>
                    <div class="ds-st-list ds-st-mlist">${modelRows}</div>
                </div>` : ''}

                ${sample.length ? `
                <div class="dm-box">
                    <div class="dm-h">${esc(t('dash.stats.sample'))}</div>
                    <div class="ds-st-tasks">${sampleRows}</div>
                </div>` : ''}
            </div>`;
    }

    // ── Wiring ───────────────────────────────────────────────────────────

    async init() {
        await this.loadData();
        if (this._destroyed) return;
        this._paint();
        // Memory is three file reads; the page is already usable without it.
        this.loadMemory().then(() => { if (!this._destroyed) this._paint(); });
        this._watchRunning();
    }

    // ── Live run ─────────────────────────────────────────────────────────

    /**
     * Follow the running task, if there is one.
     *
     * READ-ONLY, deliberately. Monitor's socket handler steers, approves,
     * continues and manages replay cutoffs across its whole DOM; this one only
     * accumulates logs and repaints. Sharing that handler would mean coupling
     * this view to Monitor's markup, and forking it would mean two sockets
     * fighting over one task's control messages.
     */
    _watchRunning() {
        const t = this.tasks.find(x => x.status === 'running');
        if (!t) { this._closeSocket(); return; }
        if (this._watchedId === t.id && this._socket) return;

        this._closeSocket();
        this._watchedId = t.id;
        this._runLogs = [];
        this.run = null;

        if (!window.apiClient) return;
        let socket;
        try {
            socket = new WebSocket(
                `ws://localhost:${window.apiClient.port}/ws/tasks/${t.id}?token=${window.apiClient.token}`);
        } catch (e) {
            console.warn('Dashboard: could not open the task socket:', e);
            return;
        }
        this._socket = socket;

        socket.onmessage = (ev) => {
            // A socket that outlives a navigation must not touch the DOM.
            if (this._destroyed || this._socket !== socket) return;
            let packet;
            try { packet = JSON.parse(ev.data); } catch (_) { return; }
            // The server replays the whole task on connect and then streams.
            // Both are just logs here — there is no live/replay split to get
            // wrong because this view holds no DOM state between repaints.
            this._runLogs.push(packet);
            this.run = reduceRun(this._runLogs);
            if (this.run.finished) {
                // The run ended: reload so the queue and spend catch up, which
                // also flips the pane back to Memory.
                this._closeSocket();
                this.loadData().then(() => { if (!this._destroyed) { this.tab = null; this._paint(); } });
                return;
            }
            this._schedulePaint();
        };
        socket.onerror = () => { /* onclose follows; nothing useful to add */ };
        socket.onclose = () => { if (this._socket === socket) this._socket = null; };
    }

    /**
     * Coalesce repaints. A busy run emits several events per second and each
     * repaint rebuilds three innerHTML regions; without this the page would
     * spend its time in layout instead of showing the run.
     */
    _schedulePaint() {
        if (this._repaintTimer) return;
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null;
            if (!this._destroyed) this._paint();
        }, 250);
    }

    _closeSocket() {
        if (this._socket) {
            try { this._socket.close(); } catch (_) {}
            this._socket = null;
        }
        this._watchedId = null;
    }

    /** Re-render the three dynamic regions and rebind. Cheap; called on any change. */
    _paint() {
        const m = this._metrics();
        const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

        const bits = [];
        if (m.running.length) bits.push(`<b>${m.running.length}</b> running`);
        if (m.paused.length) bits.push(`<b>${m.paused.length}</b> waiting for you`);
        if (m.freshFailures.length) bits.push(`<b>${m.freshFailures.length}</b> failed recently`);
        if (m.spend.total > 0) bits.push(`<b>${money(m.spend.total)}</b> this week`);
        set('dash-status', bits.length ? bits.join(' · ') : 'Nothing needs you right now');

        set('dash-left', this._leftHtml(m));
        set('dash-tabs', this._tabsHtml(m));
        set('dash-pane', this._paneHtml(m));

        // Opening the Memory tab is what clears the "new" badge: it means "you
        // have seen these", so it must be marked when they are actually shown,
        // not when the page loads.
        if (this._activeTab(m) === 'memory' && this.memory) {
            try { localStorage.setItem(MEM_SEEN_KEY, String(Date.now())); } catch (_) {}
        }

        this._bind(m);
    }

    /**
     * Switch the memory pane to another workspace and reload its stores.
     *
     * Memory is per-workspace (under `<ws>/.agent/`), so this is what makes the
     * right pane useful for more than the workspace the agent happens to work in
     * — the guess in `_memoryWorkspace()` stays the default, but the user's pick
     * wins from then on.
     */
    async _setMemoryWorkspace(ws) {
        const next = String(ws || '').trim();
        this.memoryWs = next;
        this.memoryError = '';
        this.memQuery = '';
        // Update the input directly so _paint doesn't restore the old value.
        const input = document.getElementById('dash-mem-ws');
        if (input) input.value = next;
        this._paint();
        if (!next) { this.memory = { facts: [], episodes: [], cards: [] }; return; }
        try {
            this.memory = await readWorkspaceMemory(next, invoke);
        } catch (e) {
            this.memory = { facts: [], episodes: [], cards: [] };
            this.memoryError = String(e?.message || e);
        }
        if (!this._destroyed) this._paint();
    }

    _bind(m) {
        this._bindLauncher(m);

        const wsBrowse = document.getElementById('dash-ws-browse');
        if (wsBrowse) {
            wsBrowse.addEventListener('click', async () => {
                try {
                    const sel = await invoke('select_folder');
                    if (sel) {
                        const input = document.getElementById('dash-ws');
                        if (input) { input.value = sel; input.focus(); }
                    }
                } catch (_) { /* dialog cancelled */ }
            });
        }

        const memWs = document.getElementById('dash-mem-ws');
        if (memWs) {
            memWs.addEventListener('change', () => {
                if (memWs.value.trim() !== this.memoryWs) this._setMemoryWorkspace(memWs.value);
            });
            memWs.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    memWs.blur();
                    if (memWs.value.trim() !== this.memoryWs) this._setMemoryWorkspace(memWs.value);
                }
            });
        }
        const memBrowse = document.getElementById('dash-mem-ws-browse');
        if (memBrowse) {
            memBrowse.addEventListener('click', async () => {
                try {
                    const sel = await invoke('select_folder');
                    if (sel) this._setMemoryWorkspace(sel);
                } catch (_) { /* dialog cancelled */ }
            });
        }

        document.querySelectorAll('.dr-chip[data-recipe]').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-recipe');
                const tpl = safeTemplates().find(t => t.key === key);
                if (!tpl) return;
                recordUse(key);
                const ta = document.getElementById('dash-prompt');
                if (ta) { ta.value = tpl.prompt; ta.focus(); autoGrow(ta); }
            });
        });

        document.querySelectorAll('.dt-tab[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.tab = btn.getAttribute('data-tab');
                this._paint();
            });
        });

        // Spend window: the pick is persisted so the next visit starts where
        // this one ended.
        document.querySelectorAll('.ds-range-btn[data-range]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.spendRange = btn.getAttribute('data-range');
                try { localStorage.setItem('jhai_dash_spend_range', this.spendRange); } catch (_) {}
                this._paint();
            });
        });

        // Stats cut: same persistence pattern.
        document.querySelectorAll('.ds-st-cut[data-cut]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.statsCut = btn.getAttribute('data-cut');
                try { localStorage.setItem('jhai_dash_stats_cut', this.statsCut); } catch (_) {}
                this._paint();
            });
        });

        // Stats period filter: conditions and breakdown share one repaint.
        document.querySelectorAll('.ds-st-cut[data-range]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.statsRange = btn.getAttribute('data-range');
                try { localStorage.setItem('jhai_dash_stats_range', this.statsRange); } catch (_) {}
                this._paint();
            });
        });

        // Stats status filter: same persistence pattern.
        document.querySelectorAll('.ds-st-cut[data-status]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.statsStatus = btn.getAttribute('data-status');
                try { localStorage.setItem('jhai_dash_stats_status', this.statsStatus); } catch (_) {}
                this._paint();
            });
        });

        document.querySelectorAll('.dash-card-toggle').forEach(cb => {
            cb.addEventListener('change', () => this._toggleCard(cb.getAttribute('data-card'), !cb.checked));
        });

        // Crossing from a card firing in a run to the switch that turns it off
        // is the point of having both halves on one page. Make it one click.
        document.querySelectorAll('.dash-go-memory').forEach(btn => {
            btn.addEventListener('click', () => { this.tab = 'memory'; this._paint(); });
        });

        // One-click workspace switch in the memory pane — the chip carries the
        // full path, so clicking it is the same as typing it and pressing Enter.
        document.querySelectorAll('.dm-wschip[data-ws]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ws = btn.getAttribute('data-ws');
                if (ws && ws !== this.memoryWs) this._setMemoryWorkspace(ws);
            });
        });

        const q = document.getElementById('dash-mem-q');
        if (q) {
            q.addEventListener('input', debounce(() => {
                this.memQuery = q.value;
                this._paint();
                // Re-focus and restore the caret: _paint replaces the input.
                const next = document.getElementById('dash-mem-q');
                if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
            }, 180));
        }
    }

    /**
     * Switch a card off (or back on) and persist it.
     *
     * Optimistic: the row flips at once and reverts if the write fails, because
     * a toggle that waits on three file operations feels broken. Writes the
     * whole store back — cards.jsonl is a few hundred lines and a partial
     * rewrite would have to reproduce the agent's own append format.
     */
    async _toggleCard(id, disabled) {
        if (!id || !this.memory) return;
        const before = this.memory.cards;
        this.memory = { ...this.memory, cards: toggleCardDisabled(before, id, disabled) };
        this._paint();
        try {
            await writeCards(this.memoryWs, this.memory.cards, invoke);
        } catch (e) {
            this.memory = { ...this.memory, cards: before };
            this.memoryError = '';
            this._paint();
            alert('Could not save the change to cards.jsonl: ' + (e?.message || e));
        }
    }

    /**
     * The launcher hands off to Monitor's new-task modal rather than creating
     * the task itself. That modal owns workspace validation, the agent-mode
     * picker, MCP selection, "/" template expansion and attachments — a second
     * creation path here would be the weaker of the two and would drift.
     */
    _bindLauncher() {
        const form = document.getElementById('dash-launch');
        const ta = document.getElementById('dash-prompt');
        if (!form || !ta) return;

        autoGrow(ta);
        ta.addEventListener('input', () => autoGrow(ta));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                form.requestSubmit();
            }
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const prompt = ta.value.trim();
            const ws = (document.getElementById('dash-ws')?.value || '').trim();
            if (!prompt) { ta.focus(); return; }
            try {
                localStorage.setItem(LAST_WS_KEY, ws);
                localStorage.setItem('jh_open_new_task', JSON.stringify({ prompt, ws }));
            } catch (_) {}
            window.location.hash = '#monitor';
        });
    }

    destroy() {
        this._destroyed = true;
        this._closeSocket();
        clearTimeout(this._repaintTimer);
        this._repaintTimer = null;
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function safeTemplates() {
    try { return promptTemplateManager.getAll() || []; } catch (_) { return []; }
}

function esc(str) {
    if (str === 0) return '0';
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s, n) {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

function fmt(n) { return Number(n || 0).toLocaleString(); }

function short(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'k';
    return String(v);
}

/** Costs are often fractions of a cent; two decimals would print "$0.00". */
function money(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0';
    if (v < 0.01) return '<$0.01';
    return '$' + (v < 10 ? v.toFixed(2) : v.toFixed(0));
}

function baseName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** `inst_17…:deepseek-v4-flash` -> `deepseek-v4-flash`. Used when a model has
 *  no configured rates, so there is no connection name to show instead. */
function shortModel(m) {
    const s = String(m || '');
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : (s || '(unknown)');
}

/** Relative time — an absolute timestamp needs arithmetic to be useful here. */
function ago(iso) {
    const t = iso ? new Date(iso).getTime() : 0;
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    if (d < 30) return `${d}d`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Wall-clock since a start time, as m:ss / h:mm. */
function elapsed(iso) {
    const t = iso ? new Date(iso).getTime() : 0;
    if (!t) return '—';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(150, Math.max(40, ta.scrollHeight)) + 'px';
}

function debounce(fn, ms) {
    let h = null;
    return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
