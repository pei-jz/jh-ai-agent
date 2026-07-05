import { scheduleManager } from '../../modules/ai/ScheduleManager.js';
import { AGENT_MODES, DEFAULT_MODE_ID, buildBehavior } from '../../modules/ai/AgentModes.js';
import { mcpManager } from '../../modules/ai/McpManager.js';

const SCHEDULE_KEY = 'jh_schedules';

function loadSchedules() {
    try { return JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '[]'); } catch { return []; }
}

function saveSchedules(list) {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(list));
    scheduleManager.reloadSchedules();
}

function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const INTERVAL_OPTIONS = [
    { value: 15,   label: 'Every 15 min' },
    { value: 30,   label: 'Every 30 min' },
    { value: 60,   label: 'Every 1 hour' },
    { value: 120,  label: 'Every 2 hours' },
    { value: 360,  label: 'Every 6 hours' },
    { value: 720,  label: 'Every 12 hours' },
];

function nextRunText(schedule) {
    if (!schedule.enabled) return 'Stopped';
    const now = new Date();
    const type = schedule.scheduleType || 'fixed';

    if (type === 'once') {
        if (!schedule.onceAt) return '—';
        const t = new Date(schedule.onceAt);
        if (t <= now) return 'Ran / expired';
        const diff = t - now;
        const diffH = Math.floor(diff / 3600000);
        const diffM = Math.floor((diff % 3600000) / 60000);
        if (diffH < 24) return `in ${diffH}h ${diffM}m`;
        return `in ${Math.floor(diffH / 24)}d`;
    }

    if (type === 'interval') {
        const intervalMin = Math.max(1, parseInt(schedule.intervalMinutes) || 60);
        const curMin = now.getMinutes();
        const nextMin = (Math.floor(curMin / intervalMin) + 1) * intervalMin;
        const waitMin = nextMin - curMin;
        if (waitMin <= intervalMin) return `~${waitMin}m`;
        return `~${Math.round(waitMin / 60)}h`;
    }

    // fixed
    const [h, m] = (schedule.time || '09:00').split(':').map(Number);
    const days = schedule.days || [1, 2, 3, 4, 5];
    for (let i = 0; i < 8; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        d.setHours(h, m, 0, 0);
        if (d > now && days.includes(d.getDay())) {
            const diff = d - now;
            const diffH = Math.floor(diff / 3600000);
            const diffM = Math.floor((diff % 3600000) / 60000);
            if (diffH < 24) return `in ${diffH}h ${diffM}m`;
            return `in ${Math.floor(diffH / 24)}d`;
        }
    }
    return '—';
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export class ScheduleView {
    constructor() {
        this.schedules = loadSchedules();
        this._editingId = null;
    }

    render() {
        return `
            <style>
                .sch-layout { display: flex; gap: 16px; height: calc(100vh - var(--titlebar-height) - 70px); }
                .sch-list-panel {
                    width: 280px;
                    min-width: 220px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .sch-list-header {
                    padding: 10px 14px;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border);
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-secondary);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .sch-list-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .sch-item {
                    padding: 9px 11px;
                    border-radius: 7px;
                    border: 1px solid transparent;
                    cursor: pointer;
                    transition: background 0.12s;
                }
                .sch-item:hover { background: var(--bg-hover); }
                .sch-item.selected { background: var(--accent-glow-lg); border-color: var(--accent); }
                .sch-item-top {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 3px;
                }
                .sch-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
                .sch-dot.on { background: var(--success); }
                .sch-dot.off { background: var(--text-tertiary); }
                .sch-time-badge {
                    font-family: var(--font-mono);
                    font-size: 11px;
                    font-weight: 700;
                    color: var(--accent);
                }
                .sch-days-row {
                    display: flex;
                    gap: 2px;
                    margin-bottom: 3px;
                }
                .sch-day-chip {
                    font-size: 10px;
                    padding: 1px 5px;
                    border-radius: 3px;
                    font-weight: 600;
                }
                .sch-day-chip.active { background: var(--accent-glow); color: var(--accent); }
                .sch-day-chip.inactive { background: var(--bg-tertiary); color: var(--text-tertiary); }
                .sch-prompt-preview {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .sch-next {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    margin-top: 2px;
                }
                .sch-empty {
                    padding: 24px;
                    text-align: center;
                    color: var(--text-tertiary);
                    font-size: 12px;
                }

                /* Right panel */
                .sch-detail-panel {
                    flex: 1;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .sch-detail-header {
                    padding: 10px 16px;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border);
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--text-primary);
                }
                .sch-detail-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 20px 24px;
                    display: flex;
                    flex-direction: column;
                    gap: 18px;
                }
                .sch-field { display: flex; flex-direction: column; gap: 6px; }
                .sch-field label {
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-secondary);
                }
                .sch-input, .sch-textarea, .sch-select {
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 13px;
                    padding: 9px 12px;
                    outline: none;
                    font-family: var(--font-sans);
                    transition: border-color 0.15s;
                }
                .sch-input:focus, .sch-textarea:focus, .sch-select:focus { border-color: var(--accent); }
                .sch-textarea { resize: vertical; min-height: 80px; }
                .sch-select { cursor: pointer; }

                /* Schedule type radio pills */
                .sch-type-group { display: flex; gap: 6px; }
                .sch-type-btn {
                    flex: 1;
                    padding: 7px 10px;
                    border-radius: 6px;
                    border: 1.5px solid var(--border);
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    text-align: center;
                    transition: background 0.12s, border-color 0.12s, color 0.12s;
                }
                .sch-type-btn.selected {
                    background: var(--accent);
                    border-color: var(--accent);
                    color: var(--text-inverse);
                }

                .sch-time-row { display: flex; align-items: center; gap: 12px; }
                .sch-time-input {
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 16px;
                    font-family: var(--font-mono);
                    font-weight: 700;
                    padding: 8px 14px;
                    outline: none;
                    width: 120px;
                }
                .sch-time-input:focus { border-color: var(--accent); }
                .sch-datetime-input {
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 14px;
                    font-family: var(--font-mono);
                    padding: 8px 12px;
                    outline: none;
                    width: 100%;
                    box-sizing: border-box;
                }
                .sch-datetime-input:focus { border-color: var(--accent); }

                .sch-days-picker { display: flex; gap: 6px; }
                .sch-day-btn {
                    width: 34px; height: 34px;
                    border-radius: 50%;
                    border: 1.5px solid var(--border);
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    font-size: 12px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: background 0.12s, border-color 0.12s, color 0.12s;
                    display: flex; align-items: center; justify-content: center;
                }
                .sch-day-btn.selected {
                    background: var(--accent);
                    border-color: var(--accent);
                    color: var(--text-inverse);
                }
                .sch-toggle-row { display: flex; align-items: center; gap: 10px; }
                .sch-toggle {
                    position: relative;
                    width: 42px; height: 24px;
                    flex-shrink: 0;
                }
                .sch-toggle input { opacity: 0; width: 0; height: 0; }
                .sch-toggle-track {
                    position: absolute;
                    inset: 0;
                    background: var(--bg-tertiary);
                    border-radius: 12px;
                    border: 1px solid var(--border);
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .sch-toggle input:checked ~ .sch-toggle-track { background: var(--accent); border-color: var(--accent); }
                .sch-toggle-thumb {
                    position: absolute;
                    top: 3px; left: 3px;
                    width: 16px; height: 16px;
                    background: white;
                    border-radius: 50%;
                    transition: transform 0.2s;
                    pointer-events: none;
                }
                .sch-toggle input:checked ~ .sch-toggle-track .sch-toggle-thumb { transform: translateX(18px); }
                .sch-actions { display: flex; gap: 10px; padding: 16px 24px; border-top: 1px solid var(--border-light); flex-shrink: 0; }
                .sch-detail-empty {
                    flex: 1; display: flex; flex-direction: column;
                    align-items: center; justify-content: center;
                    color: var(--text-tertiary);
                }
                .sch-detail-empty svg { width: 40px; height: 40px; margin-bottom: 12px; opacity: 0.4; }

                .sch-run-history {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-sm);
                    overflow: hidden;
                }
                .sch-run-row {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 7px 12px;
                    border-bottom: 1px solid var(--border-light);
                    font-size: 12px;
                    color: var(--text-secondary);
                }
                .sch-run-row:last-child { border-bottom: none; }
                .sch-run-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

                .sch-section-hidden { display: none; }
            </style>

            <div class="view-container">
                <div class="view-header">
                    <div>
                        <h1>Schedule</h1>
                        <p class="subtitle">Recurring tasks — run automatically on chosen days/times</p>
                    </div>
                </div>
                <div class="sch-layout">
                    <!-- Left: list -->
                    <div class="sch-list-panel">
                        <div class="sch-list-header">
                            <span>Schedules (${this.schedules.length})</span>
                            <button class="btn btn-primary" id="btn-new-schedule" style="height:24px;padding:0 10px;font-size:11px">+ New</button>
                        </div>
                        <div class="sch-list-body" id="sch-list">
                            ${this._renderList()}
                        </div>
                    </div>

                    <!-- Right: detail/editor -->
                    <div class="sch-detail-panel" id="sch-detail-panel">
                        ${this._renderDetail()}
                    </div>
                </div>
            </div>
        `;
    }

    _renderMcpField(s) {
        const servers = Object.keys(mcpManager.serversConfig?.mcpServers || {});
        if (servers.length === 0) {
            return `
                <div class="sch-field">
                    <label>MCP Servers</label>
                    <div style="font-size:12px;color:var(--text-tertiary);padding:8px 0">
                        No MCP servers configured. You can add them in Settings.
                    </div>
                </div>`;
        }
        const selected = s.mcpServers || [];
        const checkboxes = servers.map(name => `
            <label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;font-size:13px;color:var(--text-primary)">
                <input type="checkbox" class="sch-mcp-checkbox" value="${escapeHtml(name)}"
                    ${selected.includes(name) ? 'checked' : ''}
                    style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer">
                <span>${escapeHtml(name)}</span>
            </label>
        `).join('');
        return `
            <div class="sch-field">
                <label>MCP Servers <span style="font-weight:400;text-transform:none;font-size:10px;color:var(--text-tertiary)">(none selected = use all)</span></label>
                <div id="sch-mcp-servers" style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 12px">
                    ${checkboxes}
                </div>
            </div>`;
    }

    _scheduleTypeBadge(s) {
        const type = s.scheduleType || 'fixed';
        if (type === 'interval') {
            const min = s.intervalMinutes || 60;
            return min < 60 ? `every ${min}m` : `every ${min / 60}h`;
        }
        if (type === 'once') return 'Once';
        return s.time || '09:00';
    }

    _renderList() {
        if (this.schedules.length === 0) {
            return `<div class="sch-empty">No schedules<br>Add one with "+ New"</div>`;
        }
        return this.schedules.map(s => {
            const isSelected = this._editingId === s.id;
            const type = s.scheduleType || 'fixed';
            const days = s.days || [1, 2, 3, 4, 5];
            const daysHtml = type === 'once'
                ? `<span style="font-size:10px;color:var(--accent)">${s.onceAt ? new Date(s.onceAt).toLocaleString() : 'not set'}</span>`
                : DAY_LABELS.map((d, i) =>
                    `<span class="sch-day-chip ${days.includes(i) ? 'active' : 'inactive'}">${d}</span>`
                ).join('');
            return `
                <div class="sch-item ${isSelected ? 'selected' : ''}" data-sch-id="${s.id}">
                    <div class="sch-item-top">
                        <span class="sch-dot ${s.enabled ? 'on' : 'off'}"></span>
                        <span class="sch-time-badge">${escapeHtml(this._scheduleTypeBadge(s))}</span>
                        <span style="font-size:10px;color:var(--text-tertiary);margin-left:auto">${s.enabled ? 'On' : 'Off'}</span>
                    </div>
                    <div class="sch-days-row">${daysHtml}</div>
                    <div class="sch-prompt-preview">${escapeHtml(s.name || s.prompt || '(untitled)')}</div>
                    <div class="sch-next">Next: ${nextRunText(s)}</div>
                </div>
            `;
        }).join('');
    }

    _renderDetail() {
        const s = this._editingId
            ? this.schedules.find(x => x.id === this._editingId)
            : null;

        if (!s) {
            return `
                <div class="sch-detail-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="3" y="4" width="18" height="18" rx="2"/>
                        <line x1="8" y1="2" x2="8" y2="6"/>
                        <line x1="16" y1="2" x2="16" y2="6"/>
                        <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                    <h3 style="margin:0 0 6px;font-size:15px">Select a schedule</h3>
                    <p style="font-size:12px;margin:0">Pick one from the list, or create one with "+ New"</p>
                </div>
            `;
        }

        const type = s.scheduleType || 'fixed';
        const days = s.days || [1, 2, 3, 4, 5];
        const daysPickerHtml = DAY_LABELS.map((d, i) =>
            `<button class="sch-day-btn ${days.includes(i) ? 'selected' : ''}" data-day="${i}">${d}</button>`
        ).join('');

        const intervalOptionsHtml = INTERVAL_OPTIONS.map(opt =>
            `<option value="${opt.value}" ${(s.intervalMinutes || 60) === opt.value ? 'selected' : ''}>${opt.label}</option>`
        ).join('');

        // Prepare datetime-local value (strip seconds for input)
        let onceAtValue = '';
        if (s.onceAt) {
            try {
                const d = new Date(s.onceAt);
                // Format: YYYY-MM-DDTHH:MM
                onceAtValue = d.getFullYear() + '-' +
                    String(d.getMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getDate()).padStart(2, '0') + 'T' +
                    String(d.getHours()).padStart(2, '0') + ':' +
                    String(d.getMinutes()).padStart(2, '0');
            } catch (_) {}
        }

        const runs = (s.runs || []).slice(-5).reverse();
        const runsHtml = runs.length > 0
            ? runs.map(r => `
                <div class="sch-run-row">
                    <span class="sch-run-dot" style="background:${r.status === 'completed' ? 'var(--success)' : 'var(--error)'}"></span>
                    <span>${new Date(r.at).toLocaleString()}</span>
                    <span style="margin-left:auto;font-size:11px;color:${r.status === 'completed' ? 'var(--success)' : 'var(--error)'}">${r.status}</span>
                </div>
            `).join('')
            : `<div class="sch-run-row" style="color:var(--text-tertiary)">No run history</div>`;

        return `
            <div class="sch-detail-header">
                <span>${s.name ? escapeHtml(s.name) : '(untitled)'}</span>
                <span style="margin-left:auto;font-size:11px;font-weight:400;color:var(--text-tertiary)">Next: ${nextRunText(s)}</span>
            </div>
            <div class="sch-detail-body">
                <div class="sch-field">
                    <label>Name</label>
                    <input type="text" class="sch-input" id="sch-name" value="${escapeHtml(s.name || '')}" placeholder="Schedule name (optional)">
                </div>
                <div class="sch-field">
                    <label>Prompt / task instruction</label>
                    <textarea class="sch-textarea" id="sch-prompt" rows="4">${escapeHtml(s.prompt || '')}</textarea>
                </div>

                <div class="sch-field">
                    <label>Agent mode</label>
                    <select class="sch-select" id="sch-agent-mode">
                        ${Object.values(AGENT_MODES).map(m =>
                            `<option value="${m.id}" ${(s.agentModeId || DEFAULT_MODE_ID) === m.id ? 'selected' : ''}>${m.label} — ${m.description}</option>`
                        ).join('')}
                    </select>
                </div>

                ${this._renderMcpField(s)}

                <div class="sch-field">
                    <label>Schedule type</label>
                    <div class="sch-type-group">
                        <button class="sch-type-btn ${type === 'fixed'    ? 'selected' : ''}" data-type="fixed">Fixed time</button>
                        <button class="sch-type-btn ${type === 'interval' ? 'selected' : ''}" data-type="interval">Interval</button>
                        <button class="sch-type-btn ${type === 'once'     ? 'selected' : ''}" data-type="once">Once</button>
                    </div>
                </div>

                <!-- Fixed time section -->
                <div class="sch-field" id="sch-section-fixed" ${type !== 'fixed' ? 'style="display:none"' : ''}>
                    <label>Run time</label>
                    <div class="sch-time-row">
                        <input type="time" class="sch-time-input" id="sch-time" value="${escapeHtml(s.time || '09:00')}">
                        <span style="font-size:12px;color:var(--text-secondary)">at this time on the selected weekdays</span>
                    </div>
                </div>

                <!-- Interval section -->
                <div class="sch-field" id="sch-section-interval" ${type !== 'interval' ? 'style="display:none"' : ''}>
                    <label>Interval</label>
                    <select class="sch-select" id="sch-interval">${intervalOptionsHtml}</select>
                </div>

                <!-- Once section -->
                <div class="sch-field" id="sch-section-once" ${type !== 'once' ? 'style="display:none"' : ''}>
                    <label>Run at (once)</label>
                    <input type="datetime-local" class="sch-datetime-input" id="sch-once-at" value="${escapeHtml(onceAtValue)}">
                </div>

                <!-- Days picker (hidden for "once") -->
                <div class="sch-field" id="sch-section-days" ${type === 'once' ? 'style="display:none"' : ''}>
                    <label>Run on days</label>
                    <div class="sch-days-picker" id="sch-days-picker">${daysPickerHtml}</div>
                </div>

                <div class="sch-field">
                    <label>Enabled / stopped</label>
                    <div class="sch-toggle-row">
                        <label class="sch-toggle">
                            <input type="checkbox" id="sch-enabled" ${s.enabled ? 'checked' : ''}>
                            <div class="sch-toggle-track"><div class="sch-toggle-thumb"></div></div>
                        </label>
                        <span style="font-size:13px;color:var(--text-secondary)" id="sch-enabled-label">${s.enabled ? 'Enabled — runs automatically at the set time' : 'Stopped'}</span>
                    </div>
                </div>
                <div class="sch-field">
                    <label>Recent runs</label>
                    <div class="sch-run-history">${runsHtml}</div>
                </div>
            </div>
            <div class="sch-actions">
                <button class="btn btn-primary" id="btn-save-schedule">Save</button>
                <button class="btn btn-secondary" id="btn-run-now">Run now</button>
                <button class="btn btn-error" id="btn-delete-schedule" style="margin-left:auto">Delete</button>
            </div>
        `;
    }

    _refreshList() {
        const el = document.getElementById('sch-list');
        if (el) el.innerHTML = this._renderList();
        this._bindListItems();
    }

    _refreshDetail() {
        const el = document.getElementById('sch-detail-panel');
        if (el) {
            el.innerHTML = this._renderDetail();
            this._bindDetail();
        }
    }

    _bindListItems() {
        document.querySelectorAll('.sch-item[data-sch-id]').forEach(item => {
            item.addEventListener('click', () => {
                this._editingId = item.getAttribute('data-sch-id');
                this._refreshList();
                this._refreshDetail();
            });
        });
    }

    _bindDetail() {
        document.getElementById('sch-enabled')?.addEventListener('change', (e) => {
            const lbl = document.getElementById('sch-enabled-label');
            if (lbl) lbl.textContent = e.target.checked ? 'Enabled — runs automatically at the set time' : 'Stopped';
        });

        document.querySelectorAll('.sch-day-btn').forEach(btn => {
            btn.addEventListener('click', () => btn.classList.toggle('selected'));
        });

        // Schedule type switching
        document.querySelectorAll('.sch-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.sch-type-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                const t = btn.getAttribute('data-type');
                document.getElementById('sch-section-fixed').style.display    = t === 'fixed'    ? '' : 'none';
                document.getElementById('sch-section-interval').style.display = t === 'interval' ? '' : 'none';
                document.getElementById('sch-section-once').style.display     = t === 'once'     ? '' : 'none';
                document.getElementById('sch-section-days').style.display     = t === 'once'     ? 'none' : '';
            });
        });

        document.getElementById('btn-save-schedule')?.addEventListener('click', () => {
            const s = this.schedules.find(x => x.id === this._editingId);
            if (!s) return;
            const selectedDays = [...document.querySelectorAll('.sch-day-btn.selected')].map(b => parseInt(b.getAttribute('data-day')));
            const type = document.querySelector('.sch-type-btn.selected')?.getAttribute('data-type') || 'fixed';
            s.name = document.getElementById('sch-name')?.value.trim() || '';
            s.prompt = document.getElementById('sch-prompt')?.value.trim() || '';
            s.agentModeId = document.getElementById('sch-agent-mode')?.value || DEFAULT_MODE_ID;
            s.mcpServers = [...document.querySelectorAll('.sch-mcp-checkbox:checked')].map(cb => cb.value);
            s.scheduleType = type;
            s.time = document.getElementById('sch-time')?.value || '09:00';
            s.days = selectedDays;
            s.intervalMinutes = parseInt(document.getElementById('sch-interval')?.value) || 60;
            const onceAtRaw = document.getElementById('sch-once-at')?.value || '';
            s.onceAt = onceAtRaw ? new Date(onceAtRaw).toISOString() : null;
            s.enabled = document.getElementById('sch-enabled')?.checked ?? true;
            saveSchedules(this.schedules);
            this._refreshList();
            this._refreshDetail();
        });

        document.getElementById('btn-run-now')?.addEventListener('click', async () => {
            const s = this.schedules.find(x => x.id === this._editingId);
            if (!s || !s.prompt) { alert('Please enter a prompt'); return; }
            if (!window.apiClient) { alert('Not connected to the backend'); return; }
            const btn = document.getElementById('btn-run-now');
            btn.disabled = true;
            btn.textContent = 'Running…';
            try {
                const mcpServers = s.mcpServers && s.mcpServers.length > 0 ? s.mcpServers : null;
                const behavior = {
                    mode: 'iterative_agent',
                    ...buildBehavior(s.agentModeId || DEFAULT_MODE_ID),
                    ...(mcpServers ? { mcp_servers: mcpServers } : {})
                };
                const task = await window.apiClient.request('/tasks', {
                    method: 'POST',
                    body: JSON.stringify({ prompt: s.prompt, workspace_path: null, caller: 'Schedule', behavior })
                });
                const taskId = task.task_id || task.id;
                s.runs = s.runs || [];
                s.runs.push({ at: new Date().toISOString(), status: 'completed', taskId });
                saveSchedules(this.schedules);
                window.location.hash = `#monitor?id=${taskId}`;
            } catch (err) {
                s.runs = s.runs || [];
                s.runs.push({ at: new Date().toISOString(), status: 'failed', error: err.message });
                saveSchedules(this.schedules);
                alert(`Run failed: ${err.message}`);
                btn.disabled = false;
                btn.textContent = 'Run now';
            }
        });

        document.getElementById('btn-delete-schedule')?.addEventListener('click', () => {
            if (!confirm('Delete this schedule?')) return;
            this.schedules = this.schedules.filter(x => x.id !== this._editingId);
            this._editingId = null;
            saveSchedules(this.schedules);
            this._refreshList();
            this._refreshDetail();
        });
    }

    init() {
        document.getElementById('btn-new-schedule')?.addEventListener('click', () => {
            const newSch = {
                id: makeId(),
                name: '',
                prompt: '',
                agentModeId: DEFAULT_MODE_ID,
                mcpServers: [],
                scheduleType: 'fixed',
                time: '09:00',
                days: [1, 2, 3, 4, 5],
                intervalMinutes: 60,
                onceAt: null,
                enabled: true,
                runs: [],
            };
            this.schedules.unshift(newSch);
            saveSchedules(this.schedules);
            this._editingId = newSch.id;
            this._refreshList();
            this._refreshDetail();
        });

        this._bindListItems();
        this._bindDetail();

        // Poll every 30 seconds to update UI relative time text
        this._pollTimer = setInterval(() => {
            this.schedules = loadSchedules();
            this._refreshList();
            const nextEl = document.querySelector('.sch-detail-header span:last-child');
            if (nextEl) {
                const s = this.schedules.find(x => x.id === this._editingId);
                if (s) nextEl.textContent = `Next: ${nextRunText(s)}`;
            }
        }, 30 * 1000);

        this._onSchedulesUpdated = () => {
            this.schedules = loadSchedules();
            this._refreshList();
            this._refreshDetail();
        };
        window.addEventListener('jh-schedules-updated', this._onSchedulesUpdated);
    }

    destroy() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._onSchedulesUpdated) {
            window.removeEventListener('jh-schedules-updated', this._onSchedulesUpdated);
        }
    }
}
