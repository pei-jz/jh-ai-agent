import { icon } from '../utils/icons.js';
import { AnalyticsView } from './AnalyticsView.js';

// Action-centric dashboard: surfaces what needs attention (approvals, failures),
// what's running, and recent activity — plus a one-click "new task" and the
// usage analytics. Fits the viewport with NO page scroll (panels scroll
// internally). Lifetime vanity metrics (Total Tasks / Total Tokens) were dropped
// in favor of time-scoped, actionable numbers.

export class OverviewView {
    constructor() {
        this.stats = { totalTokens: 0, estimatedCost: 0.0 };
        this.tasks = [];
        this.analytics = new AnalyticsView({ embed: true });
    }

    async loadData() {
        try {
            if (!window.apiClient) return;
            const [stats, tasks] = await Promise.all([
                window.apiClient.getStats(),
                window.apiClient.listTasks(),
            ]);
            this.stats = stats || this.stats;
            this.tasks = Array.isArray(tasks) ? tasks : [];
        } catch (e) {
            console.error('Failed to load overview data:', e);
        }
    }

    // ── Derived metrics ──────────────────────────────────────────────────
    _metrics() {
        const tasks = this.tasks;
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const dayMs = startOfDay.getTime();
        const weekMs = Date.now() - 7 * 86400000;
        const at = (s) => s ? new Date(s).getTime() : 0;

        const running = tasks.filter(t => t.status === 'running');
        const paused  = tasks.filter(t => t.status === 'paused');
        const completedToday = tasks.filter(t => t.status === 'completed' && at(t.completed_at) >= dayMs);
        const recent7 = tasks.filter(t => at(t.started_at) >= weekMs);
        const done7 = recent7.filter(t => t.status === 'completed').length;
        const fail7 = recent7.filter(t => t.status === 'failed').length;
        const successRate = (done7 + fail7) > 0 ? Math.round(done7 / (done7 + fail7) * 100) : null;

        const rate = this.stats.totalTokens > 0 ? (this.stats.estimatedCost / this.stats.totalTokens) : 0;
        const weekTokens = recent7.reduce((s, t) => s + ((t.token_usage && t.token_usage.total_tokens) || 0), 0);
        const weekCost = weekTokens * rate;

        const failures = tasks.filter(t => t.status === 'failed')
            .sort((a, b) => at(b.completed_at || b.started_at) - at(a.completed_at || a.started_at));
        const recent = [...tasks].sort((a, b) => at(b.started_at) - at(a.started_at));

        return { running, paused, completedToday, successRate, weekCost, failures, recent };
    }

    render() {
        // Skeleton — data is fetched and patched in init() (instant paint).
        return `
            <style>
                .dash { display:flex; flex-direction:column; gap:14px;
                    height: calc(100vh - var(--titlebar-height) - 64px); }
                .dash-head { display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
                .dash-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; flex-shrink:0; }
                .dstat { background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg);
                    padding:12px 16px; display:flex; flex-direction:column; gap:2px; }
                .dstat.alert { border-color:var(--accent); background:hsla(185,100%,55%,0.06); }
                .dstat-label { font-size:11px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.04em; font-weight:600; }
                .dstat-val { font-size:26px; font-weight:700; color:var(--text-primary); font-variant-numeric:tabular-nums; line-height:1.1; }
                .dstat-sub { font-size:11px; color:var(--text-secondary); }
                .dash-main { display:flex; flex-direction:column; gap:14px; flex:1; min-height:0; }
                .dash-lists { display:flex; gap:14px; flex:1.25 1 0; min-height:0; }
                .dash-lists > .dash-panel { flex:1; min-width:0; }
                .dash-analytics { flex:1 1 0; min-height:0; overflow-y:auto;
                    background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:12px 14px; }
                .dash-panel { background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg);
                    display:flex; flex-direction:column; min-height:0; overflow:hidden; }
                .dash-panel-h { padding:9px 14px; border-bottom:1px solid var(--border); font-size:12px; font-weight:700;
                    color:var(--text-secondary); display:flex; align-items:center; gap:7px; flex-shrink:0; background:var(--bg-tertiary); }
                .dash-panel-h .cnt { margin-left:auto; opacity:0.6; font-weight:500; }
                .dash-panel-b { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
                .drow { display:block; text-decoration:none; color:inherit; padding:8px 10px; border-radius:8px;
                    border:1px solid var(--border); background:var(--bg-tertiary); cursor:pointer; transition:border-color .12s,background .12s; }
                .drow:hover { border-color:var(--accent); background:var(--bg-hover); }
                .drow-top { display:flex; align-items:center; gap:7px; margin-bottom:3px; }
                .drow-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
                .dot-running{background:var(--accent);box-shadow:0 0 5px var(--accent);animation:dpulse 1s infinite}
                .dot-paused{background:hsl(40,90%,55%)} .dot-failed{background:var(--error)}
                .dot-completed{background:var(--success)} .dot-aborted{background:var(--text-tertiary)}
                @keyframes dpulse{0%,100%{opacity:1}50%{opacity:.4}}
                .drow-id { font-family:var(--font-mono); font-size:10.5px; color:var(--text-tertiary); }
                .drow-caller { font-size:9px; font-weight:700; color:var(--accent); background:var(--accent-glow); padding:1px 5px; border-radius:3px; }
                .drow-time { margin-left:auto; font-size:10.5px; color:var(--text-tertiary); }
                .drow-prompt { font-size:12.5px; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
                .dprog { height:4px; background:var(--bg-primary); border-radius:3px; overflow:hidden; margin-top:6px; }
                .dprog > div { height:100%; background:linear-gradient(90deg,var(--accent-dim),var(--accent)); }
                .dash-empty { color:var(--text-tertiary); font-size:12px; text-align:center; padding:18px; }
            </style>
            <div class="view-container">
                <div class="dash">
                    <div class="dash-head">
                        <div>
                            <h1 style="margin:0;">Dashboard</h1>
                            <p class="subtitle" style="margin:2px 0 0;">What needs attention, what's running, and recent tasks</p>
                        </div>
                        <button id="dash-new-task" class="btn btn-primary" style="display:flex;align-items:center;gap:6px;">
                            <span style="display:inline-flex">${icon('bolt')}</span> New Task
                        </button>
                    </div>

                    <div class="dash-stats" id="dash-stats"></div>

                    <div class="dash-main">
                        <div class="dash-lists">
                            <div class="dash-panel">
                                <div class="dash-panel-h">🔴 Needs Attention <span class="cnt" id="cnt-attention"></span></div>
                                <div class="dash-panel-b" id="dash-attention"><div class="dash-empty">Loading…</div></div>
                            </div>
                            <div class="dash-panel">
                                <div class="dash-panel-h">🟢 Running <span class="cnt" id="cnt-running"></span></div>
                                <div class="dash-panel-b" id="dash-running"><div class="dash-empty">Loading…</div></div>
                            </div>
                            <div class="dash-panel">
                                <div class="dash-panel-h">🕒 Recent Tasks <span class="cnt" id="cnt-recent"></span></div>
                                <div class="dash-panel-b" id="dash-recent"><div class="dash-empty">Loading…</div></div>
                            </div>
                        </div>
                        <div class="dash-analytics" id="dash-analytics">
                            <div class="dash-empty">Loading analytics…</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    _statsHtml(m) {
        const card = (label, val, sub, alert) => `
            <div class="dstat ${alert ? 'alert' : ''}">
                <span class="dstat-label">${label}</span>
                <span class="dstat-val">${val}</span>
                <span class="dstat-sub">${sub || '&nbsp;'}</span>
            </div>`;
        return [
            card('Running', m.running.length, m.running.length ? 'In progress' : 'None'),
            card('Awaiting Approval', m.paused.length, m.paused.length ? '👈 Action needed' : 'None', m.paused.length > 0),
            card('Completed Today', m.completedToday.length, m.successRate !== null ? `${m.successRate}% success (7d)` : ''),
            card('Cost This Week', '$' + m.weekCost.toFixed(4), 'Estimated (7d)'),
        ].join('');
    }

    _rowHtml(t, opts = {}) {
        const status = t.status || 'pending';
        const date = t.started_at ? new Date(t.started_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const pct = Math.round((t.progress || 0) * 100);
        return `
            <a class="drow" href="#monitor?id=${t.id}">
                <div class="drow-top">
                    <span class="drow-dot dot-${status}"></span>
                    <span class="drow-id">#${(t.id || '').slice(0, 6)}</span>
                    ${t.caller ? `<span class="drow-caller">${esc(t.caller)}</span>` : ''}
                    <span class="drow-time">${date}</span>
                </div>
                <div class="drow-prompt">${esc(t.prompt || '(no prompt)')}</div>
                ${opts.progress && status === 'running' ? `<div class="dprog"><div style="width:${pct}%"></div></div>` : ''}
                ${opts.error && t.error ? `<div style="font-size:11px;color:var(--error);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.error)}</div>` : ''}
            </a>`;
    }

    async init() {
        // New-task button → open the Monitor creation modal (flag consumed there).
        const newBtn = document.getElementById('dash-new-task');
        if (newBtn) newBtn.addEventListener('click', () => {
            try { localStorage.setItem('jh_open_new_task', '1'); } catch (_) {}
            window.location.hash = '#monitor';
        });

        await this.loadData();
        const m = this._metrics();

        const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

        set('dash-stats', this._statsHtml(m));

        // Needs attention = paused/awaiting-approval (first) + recent failures (5).
        const attention = [
            ...m.paused.map(t => this._rowHtml(t)),
            ...m.failures.slice(0, 5).map(t => this._rowHtml(t, { error: true })),
        ];
        set('dash-attention', attention.length ? attention.join('') : `<div class="dash-empty">Nothing needs attention 🎉</div>`);
        setText('cnt-attention', String(m.paused.length + Math.min(m.failures.length, 5)));

        set('dash-running', m.running.length
            ? m.running.map(t => this._rowHtml(t, { progress: true })).join('')
            : `<div class="dash-empty">No running tasks</div>`);
        setText('cnt-running', String(m.running.length));

        const recent = m.recent.slice(0, 12);
        set('dash-recent', recent.length
            ? recent.map(t => this._rowHtml(t, { progress: true })).join('')
            : `<div class="dash-empty">No tasks yet</div>`);
        setText('cnt-recent', String(m.recent.length));

        // Usage analytics — reuse the SAME task list (no extra fetch).
        const anEl = document.getElementById('dash-analytics');
        if (anEl) {
            try {
                this.analytics.setTasks(this.tasks);
                anEl.innerHTML = await this.analytics.render();
                this.analytics.init();
            } catch (e) { console.error('Analytics render failed:', e); }
        }
    }
}

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
