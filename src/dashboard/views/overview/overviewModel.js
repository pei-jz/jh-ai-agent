// overviewModel — PURE derivation for the dashboard: what the numbers are,
// separate from how they are drawn.
//
// Extracted from OverviewView.js during the Svelte migration. These were private
// methods on a 1,477-line class that also owned seven regions of markup and every
// DOM listener, so "what does the spend table show when one model has no rates?"
// could only be answered by rendering the page and reading HTML back out.
//
// Everything here takes its inputs as arguments — including `now` and the rate
// table — so none of it needs a clock, a config object on `this`, or a DOM.

import { modelRates } from '../../../modules/ai/agent/ModelPhaseRouter.js';
// Cache accounting is provider-dependent and easy to get wrong in both
// directions. There is exactly one implementation of it — the Monitor
// inspector's — and every cost figure in the app goes through it.
import { costOf, per1m } from '../monitor/inspector.js';

/** Failures older than this stop being "attention" and become history. */
export const ATTENTION_WINDOW_H = 48;

/** localStorage keys. Collected here so the set is visible in one place. */
export const KEYS = {
    memSeen: 'jhai_memory_seen_at',
    lastWs: 'jhai_last_ws',
    spendRange: 'jhai_dash_spend_range',
    statsCut: 'jhai_dash_stats_cut',
    statsRange: 'jhai_dash_stats_range',
    statsStatus: 'jhai_dash_stats_status',
    openNewTask: 'jh_open_new_task',
};

/** Read a persisted preference, falling back when storage is unavailable. */
export function readPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}

export function writePref(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { /* private mode */ }
}

// ── Formatters ─────────────────────────────────────────────────────────────

export function clip(s, n) {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

export function fmt(n) { return Number(n || 0).toLocaleString(); }

export function short(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'k';
    return String(v);
}

/** Costs are often fractions of a cent; two decimals would print "$0.00". */
export function money(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0';
    if (v < 0.01) return '<$0.01';
    return '$' + (v < 10 ? v.toFixed(2) : v.toFixed(0));
}

export function baseName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** `inst_17…:deepseek-v4-flash` -> `deepseek-v4-flash`. Used when a model has
 *  no configured rates, so there is no connection name to show instead. */
export function shortModel(m) {
    const s = String(m || '');
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : (s || '(unknown)');
}

/** Relative time — an absolute timestamp needs arithmetic to be useful here. */
export function ago(iso, now = Date.now()) {
    const t = iso ? new Date(iso).getTime() : 0;
    if (!t) return '';
    const s = Math.max(0, (now - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    if (d < 30) return `${d}d`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Wall-clock since a start time, as m:ss / h:mm. */
export function elapsed(iso, now = Date.now()) {
    const t = iso ? new Date(iso).getTime() : 0;
    if (!t) return '—';
    const s = Math.max(0, Math.floor((now - t) / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// ── Rates ──────────────────────────────────────────────────────────────────

/**
 * A `model id -> rate` lookup that tolerates both key shapes.
 *
 * `model_usage` keys are whatever the run sent: an `id:model` composite under
 * tier routing, a bare model name otherwise. Indexing both is what stops a
 * perfectly well-priced model showing up as "estimated".
 */
export function rateLookup(llmInstances) {
    const rates = modelRates(llmInstances);
    const byBare = {};
    for (const [key, r] of Object.entries(rates)) byBare[key.slice(key.indexOf(':') + 1)] = r;
    return (m) => rates[m] || byBare[m] || null;
}

/** The per-model usage slices of a task, falling back to its total. */
function usageEntries(task) {
    return (task.model_usage && Object.keys(task.model_usage).length)
        ? Object.entries(task.model_usage)
        : [['(unattributed)', task.token_usage || {}]];
}

// ── Spend ──────────────────────────────────────────────────────────────────

/**
 * Cost for a set of tasks, attributed per model.
 *
 * Prices each model's tokens at that model's own rates, because the breakdown IS
 * the point: it is the input to the Fast/Deep tier decision. Falls back to a flat
 * rate for anything unpriced rather than pretending it was free.
 *
 * @param {Array} tasks
 * @param {{rateFor: Function, flatRate: number}} opts
 */
export function spendOf(tasks, { rateFor, flatRate = 0 }) {
    const byModel = new Map();
    let total = 0, unpriced = 0;

    for (const t of tasks) {
        for (const [model, u] of usageEntries(t)) {
            const tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
            if (!tokens) continue;
            const r = rateFor(model);
            let cost;
            if (r) {
                cost = costOf(u, per1m(r))?.total || 0;
            } else {
                cost = tokens * flatRate;
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

/** The flat $/token used for anything with no configured rate. */
export function flatRateOf(stats) {
    return stats?.totalTokens > 0 ? (stats.estimatedCost / stats.totalTokens) : 0;
}

// ── The queue ──────────────────────────────────────────────────────────────

/**
 * Everything the left column shows, in one pass.
 *
 * @param {Array} tasks
 * @param {object} opts { spendRange, rateFor, flatRate, now }
 */
export function metricsOf(tasks, { spendRange = '7d', rateFor, flatRate = 0, now = Date.now() } = {}) {
    const at = (s) => (s ? new Date(s).getTime() : 0);
    const endOf = (t) => at(t.completed_at || t.started_at);
    const attentionMs = now - ATTENTION_WINDOW_H * 3600000;
    // The spend window is user-selectable (today / 7 days / 30 days), not a fixed
    // "this week": the dash is for the bill, and the bill varies.
    const rangeDays = { '1d': 1, '7d': 7, '30d': 30 }[spendRange] || 7;
    const rangeMs = now - rangeDays * 86400000;

    const list = Array.isArray(tasks) ? tasks : [];
    const running = list.filter(t => t.status === 'running');
    const paused = list.filter(t => t.status === 'paused');

    // Recent failures only. An old failure is history, and history lives in
    // Monitor — a red row you cannot clear is one you stop seeing.
    const failures = list.filter(t => t.status === 'failed').sort((a, b) => endOf(b) - endOf(a));
    const freshFailures = failures.filter(t => endOf(t) >= attentionMs);

    const inRange = list.filter(t => at(t.started_at) >= rangeMs);
    const done7 = inRange.filter(t => t.status === 'completed').length;
    const fail7 = inRange.filter(t => t.status === 'failed').length;
    const successRate = (done7 + fail7) > 0 ? Math.round(done7 / (done7 + fail7) * 100) : null;

    const shown = new Set([...running, ...paused, ...freshFailures].map(t => t.id));
    const recent = [...list]
        .sort((a, b) => at(b.started_at) - at(a.started_at))
        .filter(t => !shown.has(t.id))
        .slice(0, 6);

    return {
        running, paused, freshFailures,
        staleFailures: failures.length - freshFailures.length,
        recent, successRate, done7, rangeDays,
        spend: rateFor ? spendOf(inRange, { rateFor, flatRate }) : { total: 0, rows: [], unpriced: 0, tokens: 0 },
    };
}

/** The one-line summary above the columns. Empty parts are omitted, not blanked. */
export function statusBits(m) {
    const bits = [];
    if (m.running.length) bits.push(`${m.running.length} running`);
    if (m.paused.length) bits.push(`${m.paused.length} waiting for you`);
    if (m.freshFailures.length) bits.push(`${m.freshFailures.length} failed recently`);
    if (m.spend.total > 0) bits.push(`${money(m.spend.total)} this week`);
    return bits;
}

// ── Workspaces ─────────────────────────────────────────────────────────────

/**
 * Which workspace's memory to show.
 *
 * The one the most recent task ran in, falling back to what the launcher last
 * used and then to the first approved project. Memory is per-workspace, so
 * guessing wrong shows an empty panel for a project that has plenty — following
 * the work is the guess most likely to be right.
 */
export function defaultMemoryWorkspace(tasks, config, lastWs = '') {
    const withWs = (tasks || []).find(t => t.workspace_path);
    if (withWs) return withWs.workspace_path;
    if (lastWs) return lastWs;
    const projects = config?.approved_projects;
    return (Array.isArray(projects) && projects[0]) || '';
}

/**
 * Workspaces the agent has actually run in, newest first, plus the approved
 * projects and the one currently shown. Memory lives per workspace, so picking
 * one it already knows should take a single click, not a typed path.
 */
export function knownWorkspaces(tasks, config, currentWs = '') {
    const seen = [];
    const add = (p) => {
        const v = String(p || '').trim();
        if (v && !seen.includes(v)) seen.push(v);
    };
    [...(tasks || [])]
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
        .forEach(t => add(t.workspace_path));
    (Array.isArray(config?.approved_projects) ? config.approved_projects : []).forEach(add);
    add(currentWs);
    return seen;
}

// ── Stats tab ──────────────────────────────────────────────────────────────

/** Tasks under the Stats tab's own conditions (period + status). */
export function statsTasks(tasks, { range = 'all', status = 'all', now = Date.now() } = {}) {
    const rangeDays = { '7d': 7, '30d': 30 }[range] || 0;
    const cutoff = rangeDays ? now - rangeDays * 86400000 : 0;
    return (tasks || []).filter(t => {
        if (status !== 'all' && t.status !== status) return false;
        if (cutoff) {
            const at = t.started_at ? new Date(t.started_at).getTime() : 0;
            if (!at || at < cutoff) return false;
        }
        return true;
    });
}

/**
 * The status buttons the Stats tab offers: statuses that actually exist in
 * history (so the row never offers an empty filter), plus the currently selected
 * one so a pick stays visible even after history changes.
 */
export function statsStatuses(tasks, selected = 'all') {
    const seen = new Set((tasks || []).map(t => t.status).filter(Boolean));
    return ['completed', 'failed', 'aborted', 'paused', 'running']
        .filter(s => seen.has(s) || selected === s);
}

/** The bucket a task falls in, for a given cut. */
export function bucketOf(task, by, now = Date.now()) {
    const at = (s) => (s ? new Date(s).getTime() : 0);
    const ts = at(task.completed_at || task.started_at);
    const d = ts ? new Date(ts) : new Date(now);
    const p2 = (n) => String(n).padStart(2, '0');
    if (by === 'month') return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
    if (by === 'day') return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    if (by === 'week') {
        // ISO-ish week: the Monday of the week containing the task.
        const day = (d.getDay() + 6) % 7; // 0 = Monday
        const mon = new Date(d);
        mon.setDate(d.getDate() - day);
        return `${mon.getFullYear()}-W${p2(Math.ceil((mon.getDate() + 1 - mon.getDay()) / 7) || 1)}`;
    }
    if (by === 'ws') {
        const p = String(task.workspace_path || '').replace(/\\/g, '/').replace(/\/+$/, '');
        return p.split('/').filter(Boolean).pop() || '(no workspace)';
    }
    return '';
}

/**
 * Aggregate tasks' tokens and cost into a per-bucket table.
 * @param {string} by 'month' | 'week' | 'day' | 'model' | 'ws'
 */
export function aggregate(tasks, by, { rateFor, flatRate = 0, now = Date.now() }) {
    const rows = new Map();
    let totalCost = 0, unpriced = 0;
    for (const t of tasks) {
        for (const [model, u] of usageEntries(t)) {
            const tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
            if (!tokens) continue;
            const r = rateFor(model);
            const cost = r ? (costOf(u, per1m(r))?.total || 0) : (tokens * flatRate);
            if (!r) unpriced += tokens;
            const key = by === 'model' ? (r ? r.label : shortModel(model)) : bucketOf(t, by, now);
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
 * Per-model token breakdown with the Input/Cache/Output split.
 *
 * Same shape as the Monitor inspector's model rows (`in ↑ · cache ⚡ · out ↓`) so
 * a number read in one place reads the same in the other. `anyCache` is what
 * decides whether the cache column is worth showing at all.
 */
export function modelTokenRows(tasks) {
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
export function taskTokens(t) {
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
 * "k3 123k · flash 12k" — the same ↑⚡↓ split as the model table, compressed to
 * one line because a task row must stay scannable.
 */
export function taskModelLine(t) {
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

/** The KPI row of the Stats tab. */
export function statsKpis(tasks, { rateFor, flatRate = 0 }) {
    const done = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const ended = done + failed;
    const tokens = tasks.reduce((s, t) => s + taskTokens(t), 0);
    const totalCost = spendOf(tasks, { rateFor, flatRate }).total;
    return {
        count: tasks.length,
        done, failed,
        successRate: ended ? Math.round(done / ended * 100) : null,
        tokens,
        totalCost,
        avgCost: tasks.length ? totalCost / tasks.length : 0,
        avgTokens: tasks.length ? Math.round(tokens / tasks.length) : 0,
    };
}
