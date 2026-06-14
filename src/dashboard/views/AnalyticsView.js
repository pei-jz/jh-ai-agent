// Analytics view — token/usage aggregates computed from the SERVER task list
// (the single source of truth). Previously this read the localStorage ApiLogStore,
// which has been retired; per-call model/latency detail now lives per-task in the
// Monitor view. Task records carry token_usage, status, caller and timestamps.

function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtNum(n) { return (n || 0).toLocaleString(); }
function fmtDate(isoStr) {
    if (!isoStr) return '';
    try { return new Date(isoStr).toLocaleString(); } catch { return ''; }
}
function ymd(isoStr) {
    if (!isoStr) return '';
    return isoStr.slice(0, 10);
}
function durationStr(startStr, endStr) {
    if (!startStr || !endStr) return '—';
    try {
        const diff = Math.round((new Date(endStr) - new Date(startStr)) / 1000);
        if (diff < 60) return `${diff}s`;
        return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    } catch { return '—'; }
}

const BAR_COLORS = [
    'hsl(185,100%,55%)', 'hsl(280,70%,65%)', 'hsl(45,100%,60%)',
    'hsl(145,60%,50%)', 'hsl(10,80%,60%)', 'hsl(200,80%,60%)',
];

export class AnalyticsView {
    constructor(opts = {}) {
        this.tasks = [];
        this.range = '7d';      // '7d' | '30d' | 'all'
        this.groupBy = 'caller'; // 'caller' | 'date' | 'status'
        // When embedded in the Overview dashboard, skip the page header and the
        // recent-tasks table (the task list lives in the History view).
        this.embed = !!opts.embed;
        // True once tasks are populated (own fetch OR injected by the parent),
        // so render() doesn't re-fetch listTasks. The Overview dashboard fetches
        // the list ONCE and hands it here via setTasks() to avoid a duplicate
        // round-trip (the old double-fetch was a big part of the dashboard lag).
        this._dataLoaded = false;
    }

    /** Inject a pre-fetched task list so render() skips its own listTasks call. */
    setTasks(tasks) {
        this.tasks = Array.isArray(tasks) ? tasks : [];
        this._dataLoaded = true;
    }

    async loadData() {
        try {
            if (window.apiClient) this.tasks = await window.apiClient.listTasks();
        } catch { this.tasks = []; }
        this._dataLoaded = true;
    }

    _tok(t) { return (t.token_usage && t.token_usage.total_tokens) || 0; }
    _prompt(t) { return (t.token_usage && t.token_usage.prompt_tokens) || 0; }
    _completion(t) { return (t.token_usage && t.token_usage.completion_tokens) || 0; }

    _filteredTasks() {
        if (this.range === 'all') return this.tasks;
        const days = this.range === '7d' ? 7 : 30;
        const cutoff = Date.now() - days * 86400000;
        return this.tasks.filter(t => t.started_at && new Date(t.started_at).getTime() >= cutoff);
    }

    _groupData(tasks) {
        const map = {};
        for (const t of tasks) {
            let key;
            if (this.groupBy === 'date') key = ymd(t.started_at) || 'unknown';
            else if (this.groupBy === 'status') key = t.status || 'unknown';
            else key = t.caller || 'direct';
            if (!map[key]) map[key] = { prompt: 0, completion: 0, total: 0, count: 0 };
            map[key].prompt     += this._prompt(t);
            map[key].completion += this._completion(t);
            map[key].total      += this._tok(t);
            map[key].count++;
        }
        return Object.entries(map)
            .map(([k, v]) => ({ key: k, ...v }))
            .sort((a, b) => b.total - a.total);
    }

    _barChart(groups) {
        if (!groups.length) return '<div style="color:var(--text-tertiary);font-size:12px;padding:20px;text-align:center">No data</div>';
        const max = Math.max(...groups.map(g => g.total), 1);
        return groups.map((g, i) => {
            const pct = Math.round((g.total / max) * 100);
            const color = BAR_COLORS[i % BAR_COLORS.length];
            return `
                <div class="an-bar-row">
                    <div class="an-bar-label" title="${escapeHtml(g.key)}">${escapeHtml(g.key)}</div>
                    <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${color}"></div></div>
                    <div class="an-bar-vals">
                        <span class="an-bar-total">${fmtNum(g.total)}t</span>
                        <span class="an-bar-sub">${g.count} tasks</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    _timelineChart(tasks) {
        if (!tasks.length) return '<div style="color:var(--text-tertiary);font-size:12px;padding:20px;text-align:center">No data</div>';
        const days = this.range === '7d' ? 7 : 30;
        const dayMap = {};
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            dayMap[ymd(d.toISOString())] = { total: 0, count: 0 };
        }
        for (const t of tasks) {
            const d = ymd(t.started_at);
            if (dayMap[d]) { dayMap[d].total += this._tok(t); dayMap[d].count++; }
        }
        const entries = Object.entries(dayMap);
        const max = Math.max(...entries.map(([, v]) => v.total), 1);
        return `
            <div class="an-timeline">
                ${entries.map(([date, v]) => {
                    const pct = Math.round((v.total / max) * 100);
                    return `
                        <div class="an-tl-col" title="${date}: ${fmtNum(v.total)} tokens, ${v.count} tasks">
                            <div class="an-tl-bar-wrap"><div class="an-tl-bar" style="height:${pct}%"></div></div>
                            <div class="an-tl-label">${date.slice(5)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    async render() {
        if (!this._dataLoaded) await this.loadData();
        const tasks = this._filteredTasks();
        const groups = this._groupData(tasks);
        const totalTokens = tasks.reduce((s, t) => s + this._tok(t), 0);
        const totalPrompt  = tasks.reduce((s, t) => s + this._prompt(t), 0);
        const totalCompl   = tasks.reduce((s, t) => s + this._completion(t), 0);
        const totalTasks   = tasks.length;
        const failCount    = tasks.filter(t => t.status === 'failed').length;
        const completedCount = tasks.filter(t => t.status === 'completed').length;

        const barChart = this._barChart(groups);
        const timeline = this._timelineChart(tasks);

        const recent = [...tasks].sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, 50);
        const recentRows = recent.length
            ? recent.map(t => {
                return `
                    <tr>
                        <td>${fmtDate(t.started_at)}</td>
                        <td class="an-prompt" title="${escapeHtml(t.prompt)}">${escapeHtml((t.prompt||'').slice(0,60))}</td>
                        <td class="an-mono" style="font-size:10px;color:var(--accent)">${escapeHtml(t.caller||'direct')}</td>
                        <td class="an-num">${fmtNum(this._tok(t))}</td>
                        <td class="an-num" style="font-size:11px;color:var(--text-tertiary)">${durationStr(t.started_at, t.completed_at)}</td>
                        <td><span class="task-badge badge-${t.status}">${t.status}</span></td>
                    </tr>
                `;
            }).join('')
            : `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-tertiary)">No data</td></tr>`;

        return `
            <style>
                .an-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
                .an-seg { display: flex; background: var(--bg-tertiary); border-radius: var(--radius-sm); padding: 3px; gap: 2px; }
                .an-seg-btn { padding: 5px 14px; border: none; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 500; border-radius: 4px; cursor: pointer; transition: background 0.12s, color 0.12s; }
                .an-seg-btn.active { background: var(--bg-primary); color: var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
                .an-controls-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); }
                .an-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
                @media (max-width: 900px) { .an-kpi-grid { grid-template-columns: repeat(2,1fr); } }
                .an-kpi { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px 16px; }
                .an-kpi-label { font-size: 11px; color: var(--text-tertiary); margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
                .an-kpi-value { font-size: 22px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
                .an-kpi-sub { font-size: 11px; color: var(--text-tertiary); margin-top: 3px; }
                .an-panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
                @media (max-width: 1000px) { .an-panels { grid-template-columns: 1fr; } }
                .an-panel { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
                .an-panel-header { padding: 10px 14px; background: var(--bg-tertiary); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 700; color: var(--text-secondary); display: flex; align-items: center; justify-content: space-between; }
                .an-panel-body { padding: 12px 14px; }
                .an-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
                .an-bar-label { width: 110px; font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; font-family: var(--font-mono); }
                .an-bar-track { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; }
                .an-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
                .an-bar-vals { flex-shrink: 0; text-align: right; }
                .an-bar-total { font-size: 11.5px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; display: block; }
                .an-bar-sub { font-size: 10px; color: var(--text-tertiary); display: block; }
                .an-timeline { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-bottom: 20px; position: relative; }
                .an-tl-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; cursor: default; }
                .an-tl-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; }
                .an-tl-bar { width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.3s; opacity: 0.8; }
                .an-tl-col:hover .an-tl-bar { opacity: 1; }
                .an-tl-label { font-size: 9px; color: var(--text-tertiary); margin-top: 4px; white-space: nowrap; font-family: var(--font-mono); }
                .an-log-table-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
                .an-log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
                .an-log-table thead th { background: var(--bg-tertiary); padding: 9px 12px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
                .an-log-table tbody tr { border-bottom: 1px solid var(--border-light); transition: background 0.1s; }
                .an-log-table tbody tr:last-child { border-bottom: none; }
                .an-log-table tbody tr:hover { background: var(--bg-hover); }
                .an-log-table td { padding: 7px 12px; vertical-align: middle; color: var(--text-secondary); }
                .an-mono { font-family: var(--font-mono); font-size: 11px; }
                .an-prompt { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .an-num { text-align: right; font-variant-numeric: tabular-nums; }
            </style>

            <div class="${this.embed ? 'an-embed' : 'view-container'}">
                ${this.embed ? '' : `
                <div class="view-header">
                    <div>
                        <h1>Analytics</h1>
                        <p class="subtitle">Per-task token usage & run stats (model/latency details are in Monitor)</p>
                    </div>
                </div>`}

                <div class="an-controls">
                    <span class="an-controls-label">Range</span>
                    <div class="an-seg" id="range-seg">
                        <button class="an-seg-btn ${this.range==='7d'?'active':''}" data-range="7d">7 days</button>
                        <button class="an-seg-btn ${this.range==='30d'?'active':''}" data-range="30d">30 days</button>
                        <button class="an-seg-btn ${this.range==='all'?'active':''}" data-range="all">All time</button>
                    </div>
                    <span class="an-controls-label" style="margin-left:16px">Group by</span>
                    <div class="an-seg" id="group-seg">
                        <button class="an-seg-btn ${this.groupBy==='caller'?'active':''}" data-group="caller">Caller</button>
                        <button class="an-seg-btn ${this.groupBy==='date'?'active':''}" data-group="date">Date</button>
                        <button class="an-seg-btn ${this.groupBy==='status'?'active':''}" data-group="status">Status</button>
                    </div>
                </div>

                <div class="an-kpi-grid">
                    <div class="an-kpi">
                        <div class="an-kpi-label">Total Tokens</div>
                        <div class="an-kpi-value">${fmtNum(totalTokens)}</div>
                        <div class="an-kpi-sub">↑${fmtNum(totalPrompt)} prompt / ↓${fmtNum(totalCompl)} completion</div>
                    </div>
                    <div class="an-kpi">
                        <div class="an-kpi-label">Tasks</div>
                        <div class="an-kpi-value">${fmtNum(totalTasks)}</div>
                        <div class="an-kpi-sub">Completed: ${completedCount} / Failed: ${failCount}</div>
                    </div>
                    <div class="an-kpi">
                        <div class="an-kpi-label">Avg Tokens/Task</div>
                        <div class="an-kpi-value">${totalTasks ? fmtNum(Math.round(totalTokens / totalTasks)) : '—'}</div>
                        <div class="an-kpi-sub">Range: ${this.range === 'all' ? 'All time' : this.range}</div>
                    </div>
                    <div class="an-kpi">
                        <div class="an-kpi-label">Success Rate</div>
                        <div class="an-kpi-value">${totalTasks ? Math.round((completedCount / totalTasks) * 100) + '%' : '—'}</div>
                        <div class="an-kpi-sub">Callers: ${new Set(tasks.map(t => t.caller || 'direct')).size}</div>
                    </div>
                </div>

                <div class="an-panels">
                    <div class="an-panel">
                        <div class="an-panel-header">
                            <span id="bar-chart-title">${this.groupBy === 'caller' ? 'Token usage by caller' : this.groupBy === 'date' ? 'Token usage by date' : 'Token usage by status'}</span>
                            <span style="font-size:10.5px;font-weight:400;color:var(--text-tertiary)">${groups.length} groups</span>
                        </div>
                        <div class="an-panel-body" id="bar-chart-body">${barChart}</div>
                    </div>
                    <div class="an-panel">
                        <div class="an-panel-header"><span>Daily token trend (${this.range === 'all' ? 'last 30 days' : this.range})</span></div>
                        <div class="an-panel-body">${timeline}</div>
                    </div>
                </div>

                ${this.embed ? '' : `
                <div class="an-log-table-card">
                    <div class="an-panel-header" style="padding:10px 14px;background:var(--bg-tertiary);border-bottom:1px solid var(--border)">
                        <span>Tasks (latest ${Math.min(recent.length, 50)} — newest first)</span>
                    </div>
                    <div style="overflow-x:auto;">
                        <table class="an-log-table">
                            <thead>
                                <tr>
                                    <th style="min-width:160px">Time</th>
                                    <th style="min-width:200px">Prompt</th>
                                    <th style="min-width:80px">Caller</th>
                                    <th style="min-width:80px;text-align:right">Tokens</th>
                                    <th style="min-width:70px;text-align:right">Duration</th>
                                    <th style="min-width:80px">Status</th>
                                </tr>
                            </thead>
                            <tbody id="an-log-tbody">${recentRows}</tbody>
                        </table>
                    </div>
                </div>`}
            </div>
        `;
    }

    init() {
        document.querySelectorAll('#range-seg .an-seg-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                this.range = btn.getAttribute('data-range');
                document.querySelectorAll('#range-seg .an-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                this._refreshCharts();
            });
        });
        document.querySelectorAll('#group-seg .an-seg-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                this.groupBy = btn.getAttribute('data-group');
                document.querySelectorAll('#group-seg .an-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                this._refreshCharts();
            });
        });
    }

    _refreshCharts() {
        const tasks = this._filteredTasks();
        const groups = this._groupData(tasks);
        const barBody = document.getElementById('bar-chart-body');
        if (barBody) barBody.innerHTML = this._barChart(groups);
        const barTitle = document.getElementById('bar-chart-title');
        if (barTitle) {
            barTitle.textContent = this.groupBy === 'caller' ? 'Token usage by caller'
                                  : this.groupBy === 'date' ? 'Token usage by date'
                                  : 'Token usage by status';
        }
        const recent = [...tasks].sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, 50);
        const tbody = document.getElementById('an-log-tbody');
        if (tbody) {
            tbody.innerHTML = recent.length
                ? recent.map(t => `
                    <tr>
                        <td>${fmtDate(t.started_at)}</td>
                        <td class="an-prompt" title="${escapeHtml(t.prompt)}">${escapeHtml((t.prompt||'').slice(0,60))}</td>
                        <td class="an-mono" style="font-size:10px;color:var(--accent)">${escapeHtml(t.caller||'direct')}</td>
                        <td class="an-num">${fmtNum(this._tok(t))}</td>
                        <td class="an-num" style="font-size:11px;color:var(--text-tertiary)">${durationStr(t.started_at, t.completed_at)}</td>
                        <td><span class="task-badge badge-${t.status}">${t.status}</span></td>
                    </tr>
                `).join('')
                : `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-tertiary)">No data</td></tr>`;
        }
    }
}
