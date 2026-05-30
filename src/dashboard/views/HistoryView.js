import { ApiLogStore } from '../../modules/storage/ApiLogStore.js';

export class HistoryView {
    constructor() {
        this.tasks = [];
        this.filteredTasks = [];
        this.apiLogs = [];
        this.filteredApiLogs = [];
        this.activeTab = 'tasks';

        // Task filters
        this.taskQuery = '';
        this.taskStatus = 'all';
        this.taskDateFrom = '';
        this.taskDateTo = '';

        // API log filters
        this.logQuery = '';
        this.logProvider = 'all';
        this.logDateFrom = '';
        this.logDateTo = '';
    }

    async loadTasks() {
        try {
            if (window.apiClient) {
                const all = await window.apiClient.listTasks();
                this.tasks = all.filter(t => t.status !== 'running');
                this.tasks.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
                this.filteredTasks = [...this.tasks];
            }
        } catch (e) {
            console.error('Failed to load tasks:', e);
        }
    }

    loadApiLogs() {
        this.apiLogs = ApiLogStore.getAll();
        this.filteredApiLogs = [...this.apiLogs];
    }

    applyTaskFilter() {
        const q = this.taskQuery.toLowerCase();
        const from = this.taskDateFrom ? new Date(this.taskDateFrom) : null;
        const to = this.taskDateTo ? new Date(this.taskDateTo + 'T23:59:59') : null;

        this.filteredTasks = this.tasks.filter(task => {
            const matchQ = !q || task.id.toLowerCase().includes(q) || task.prompt.toLowerCase().includes(q) || (task.caller || '').toLowerCase().includes(q);
            const matchStatus = this.taskStatus === 'all' || task.status === this.taskStatus;
            const taskDate = new Date(task.started_at);
            const matchFrom = !from || taskDate >= from;
            const matchTo = !to || taskDate <= to;
            return matchQ && matchStatus && matchFrom && matchTo;
        });
    }

    applyLogFilter() {
        const q = this.logQuery.toLowerCase();
        const from = this.logDateFrom ? new Date(this.logDateFrom) : null;
        const to = this.logDateTo ? new Date(this.logDateTo + 'T23:59:59') : null;

        this.filteredApiLogs = this.apiLogs.filter(log => {
            const matchQ = !q || log.model.toLowerCase().includes(q) || (log.prompt_preview || '').toLowerCase().includes(q) || (log.response_preview || '').toLowerCase().includes(q);
            const matchProv = this.logProvider === 'all' || log.provider === this.logProvider;
            const logDate = new Date(log.timestamp);
            const matchFrom = !from || logDate >= from;
            const matchTo = !to || logDate <= to;
            return matchQ && matchProv && matchFrom && matchTo;
        });
    }

    renderTaskRows() {
        if (this.filteredTasks.length === 0) {
            return `<tr><td colspan="8" class="hist-empty-cell">No execution history found.</td></tr>`;
        }
        return this.filteredTasks.map(task => {
            const duration = getDuration(task.started_at, task.completed_at);
            const callerBadge = task.caller ? `<span class="hist-caller-badge">${escapeHtml(task.caller)}</span>` : '<span class="hist-caller-none">—</span>';
            return `
                <tr class="hist-row" data-task-id="${task.id}">
                    <td><span class="task-badge badge-${task.status}">${task.status}</span></td>
                    <td class="hist-mono">#${task.id.slice(0, 8)}</td>
                    <td class="hist-prompt-cell" title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</td>
                    <td>${callerBadge}</td>
                    <td class="hist-num">${task.token_usage.total_tokens.toLocaleString()}</td>
                    <td class="hist-num">${duration}</td>
                    <td class="hist-date">${formatDate(task.started_at)}</td>
                    <td class="hist-actions-cell">
                        <button class="hist-btn-delete" data-delete-task-id="${task.id}" title="Delete this task and its API logs">🗑</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderLogRows() {
        if (this.filteredApiLogs.length === 0) {
            return `<tr><td colspan="7" class="hist-empty-cell">No API logs found.</td></tr>`;
        }
        return this.filteredApiLogs.map(log => {
            const statusCls = log.error ? 'badge-failed' : 'badge-completed';
            const statusLabel = log.error ? 'error' : 'ok';
            const latency = log.latency_ms ? `${(log.latency_ms / 1000).toFixed(2)}s` : '—';
            return `
                <tr class="hist-row hist-log-row" data-log-id="${escapeHtml(log.id)}">
                    <td><span class="task-badge ${statusCls}">${statusLabel}</span></td>
                    <td class="hist-mono" title="${escapeHtml(log.model)}">${escapeHtml(log.model.split(':').pop())}<br><span class="hist-provider-label">${escapeHtml(log.provider)}</span></td>
                    <td class="hist-prompt-cell" title="${escapeHtml(log.prompt_preview)}">${escapeHtml(log.prompt_preview || '—')}</td>
                    <td class="hist-prompt-cell" title="${escapeHtml(log.response_preview)}">${log.error ? `<span style="color:var(--error)">${escapeHtml(log.error.substring(0, 80))}</span>` : escapeHtml(log.response_preview || '—')}</td>
                    <td class="hist-num">${(log.total_tokens || 0).toLocaleString()}</td>
                    <td class="hist-num">${latency}</td>
                    <td class="hist-date">${formatDate(log.timestamp)}</td>
                </tr>
            `;
        }).join('');
    }

    async render() {
        await this.loadTasks();
        this.loadApiLogs();

        // Collect unique providers for filter dropdown
        const providers = [...new Set(this.apiLogs.map(l => l.provider))].filter(Boolean);
        const providerOptions = providers.map(p => `<option value="${p}">${p}</option>`).join('');

        return `
            <style>
                .hist-tabs {
                    display: flex;
                    gap: 4px;
                    background: var(--bg-tertiary);
                    padding: 4px;
                    border-radius: var(--radius-md);
                    width: fit-content;
                    margin-bottom: 20px;
                }
                .hist-tab-btn {
                    padding: 8px 20px;
                    border: none;
                    background: transparent;
                    color: var(--text-secondary);
                    font-size: 13px;
                    font-weight: 500;
                    border-radius: var(--radius-sm);
                    cursor: pointer;
                    transition: background var(--transition-fast), color var(--transition-fast);
                    white-space: nowrap;
                }
                .hist-tab-btn.active {
                    background: var(--bg-primary);
                    color: var(--accent);
                    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
                }
                .hist-tab-btn:hover:not(.active) {
                    background: var(--bg-hover);
                    color: var(--text-primary);
                }
                .hist-tab-panel { display: none; }
                .hist-tab-panel.active { display: block; }

                .hist-search-bar {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                    flex-wrap: wrap;
                    padding: 14px 16px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-md);
                    margin-bottom: 16px;
                }
                .hist-search-input-wrap {
                    position: relative;
                    flex: 1;
                    min-width: 200px;
                }
                .hist-search-icon {
                    position: absolute;
                    left: 10px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--text-tertiary);
                    font-size: 14px;
                    pointer-events: none;
                }
                .hist-search-input {
                    width: 100%;
                    padding: 8px 12px 8px 32px;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 13px;
                    outline: none;
                    box-sizing: border-box;
                }
                .hist-search-input:focus {
                    border-color: var(--accent);
                    box-shadow: 0 0 0 2px var(--accent-glow);
                }
                .hist-search-input::placeholder { color: var(--text-tertiary); }
                .hist-filter-select {
                    padding: 8px 28px 8px 10px;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 12.5px;
                    outline: none;
                    appearance: none;
                    -webkit-appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 8px center;
                    cursor: pointer;
                }
                .hist-filter-select:focus { border-color: var(--accent); }
                .hist-date-input {
                    padding: 8px 10px;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-primary);
                    font-size: 12.5px;
                    outline: none;
                }
                .hist-date-input:focus { border-color: var(--accent); }
                .hist-date-sep {
                    color: var(--text-tertiary);
                    font-size: 12px;
                }
                .hist-btn-refresh {
                    padding: 8px 14px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    color: var(--text-secondary);
                    font-size: 12px;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background var(--transition-fast);
                }
                .hist-btn-refresh:hover { background: var(--bg-hover); color: var(--text-primary); }

                .hist-summary {
                    font-size: 12px;
                    color: var(--text-tertiary);
                    margin-bottom: 10px;
                    padding-left: 2px;
                }

                .hist-table-card {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-md);
                    overflow: hidden;
                }
                .hist-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 12.5px;
                }
                .hist-table thead th {
                    background: var(--bg-tertiary);
                    padding: 10px 14px;
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--text-secondary);
                    border-bottom: 1px solid var(--border);
                    text-align: left;
                    white-space: nowrap;
                }
                .hist-table tbody tr {
                    border-bottom: 1px solid var(--border-light);
                    transition: background var(--transition-fast);
                }
                .hist-table tbody tr:last-child { border-bottom: none; }
                .hist-row { cursor: pointer; }
                .hist-row:hover { background: var(--bg-hover); }
                .hist-table td {
                    padding: 10px 14px;
                    vertical-align: middle;
                    color: var(--text-primary);
                }
                .hist-empty-cell {
                    text-align: center;
                    padding: 40px !important;
                    color: var(--text-tertiary);
                    font-size: 13px;
                }
                .hist-prompt-cell {
                    max-width: 260px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: var(--text-secondary);
                }
                .hist-mono {
                    font-family: var(--font-mono);
                    font-size: 11.5px;
                    color: var(--text-tertiary);
                }
                .hist-num {
                    text-align: right;
                    font-variant-numeric: tabular-nums;
                    color: var(--text-secondary);
                }
                .hist-date {
                    white-space: nowrap;
                    color: var(--text-tertiary);
                    font-size: 11.5px;
                }
                .hist-caller-badge {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: 4px;
                    padding: 2px 7px;
                    font-size: 11px;
                    color: var(--text-secondary);
                }
                .hist-caller-none { color: var(--text-tertiary); }
                .hist-provider-label {
                    font-size: 10px;
                    color: var(--text-tertiary);
                }
                .hist-actions-cell {
                    text-align: center;
                    padding: 6px !important;
                }
                .hist-btn-delete {
                    background: transparent;
                    border: 1px solid transparent;
                    color: var(--text-tertiary);
                    font-size: 14px;
                    padding: 4px 8px;
                    border-radius: var(--radius-sm);
                    cursor: pointer;
                    transition: background var(--transition-fast),
                                color var(--transition-fast),
                                border-color var(--transition-fast);
                }
                .hist-btn-delete:hover {
                    background: var(--error-bg);
                    border-color: var(--error);
                    color: var(--error);
                }
                .hist-btn-delete:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
            </style>

            <div class="view-container">
                <div class="view-header">
                    <div>
                        <h1>History</h1>
                        <p class="subtitle">Agent execution history and LLM API call logs</p>
                    </div>
                </div>

                <!-- Tabs -->
                <div class="hist-tabs">
                    <button class="hist-tab-btn ${this.activeTab === 'tasks' ? 'active' : ''}" data-tab="tasks">Task History</button>
                    <button class="hist-tab-btn ${this.activeTab === 'api-logs' ? 'active' : ''}" data-tab="api-logs">API Logs <span style="font-size:11px;opacity:0.7">(${this.apiLogs.length})</span></button>
                </div>

                <!-- Task History Tab -->
                <div class="hist-tab-panel ${this.activeTab === 'tasks' ? 'active' : ''}" id="hist-panel-tasks">
                    <div class="hist-search-bar">
                        <div class="hist-search-input-wrap">
                            <span class="hist-search-icon">🔍</span>
                            <input type="text" id="task-search" class="hist-search-input" placeholder="Search by prompt, ID or caller..." value="${escapeHtml(this.taskQuery)}">
                        </div>
                        <select id="task-status-filter" class="hist-filter-select">
                            <option value="all" ${this.taskStatus === 'all' ? 'selected' : ''}>All Statuses</option>
                            <option value="completed" ${this.taskStatus === 'completed' ? 'selected' : ''}>Completed</option>
                            <option value="failed" ${this.taskStatus === 'failed' ? 'selected' : ''}>Failed</option>
                            <option value="aborted" ${this.taskStatus === 'aborted' ? 'selected' : ''}>Aborted</option>
                        </select>
                        <input type="date" id="task-date-from" class="hist-date-input" value="${this.taskDateFrom}" title="From date">
                        <span class="hist-date-sep">~</span>
                        <input type="date" id="task-date-to" class="hist-date-input" value="${this.taskDateTo}" title="To date">
                        <button id="task-btn-refresh" class="hist-btn-refresh">↻ Refresh</button>
                    </div>
                    <div class="hist-summary">Showing ${this.filteredTasks.length} of ${this.tasks.length} tasks</div>
                    <div class="hist-table-card">
                        <table class="hist-table">
                            <thead>
                                <tr>
                                    <th style="width:110px">Status</th>
                                    <th style="width:100px">Task ID</th>
                                    <th>Prompt</th>
                                    <th style="width:110px">Caller</th>
                                    <th style="width:90px;text-align:right">Tokens</th>
                                    <th style="width:80px;text-align:right">Duration</th>
                                    <th style="width:170px">Started At</th>
                                    <th style="width:56px;text-align:center">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="task-table-body">
                                ${this.renderTaskRows()}
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- API Logs Tab -->
                <div class="hist-tab-panel ${this.activeTab === 'api-logs' ? 'active' : ''}" id="hist-panel-api-logs">
                    <div class="hist-search-bar">
                        <div class="hist-search-input-wrap">
                            <span class="hist-search-icon">🔍</span>
                            <input type="text" id="log-search" class="hist-search-input" placeholder="Search by model, prompt or response..." value="${escapeHtml(this.logQuery)}">
                        </div>
                        <select id="log-provider-filter" class="hist-filter-select">
                            <option value="all">All Providers</option>
                            ${providerOptions}
                        </select>
                        <input type="date" id="log-date-from" class="hist-date-input" value="${this.logDateFrom}" title="From date">
                        <span class="hist-date-sep">~</span>
                        <input type="date" id="log-date-to" class="hist-date-input" value="${this.logDateTo}" title="To date">
                        <button id="log-btn-clear" class="hist-btn-refresh" style="color:var(--error);border-color:var(--error)">🗑 Clear Logs</button>
                    </div>
                    <div class="hist-summary">Showing ${this.filteredApiLogs.length} of ${this.apiLogs.length} log entries</div>
                    <div class="hist-table-card">
                        <table class="hist-table">
                            <thead>
                                <tr>
                                    <th style="width:70px">Status</th>
                                    <th style="width:130px">Model</th>
                                    <th>Prompt</th>
                                    <th>Response</th>
                                    <th style="width:80px;text-align:right">Tokens</th>
                                    <th style="width:80px;text-align:right">Latency</th>
                                    <th style="width:170px">Timestamp</th>
                                </tr>
                            </thead>
                            <tbody id="log-table-body">
                                ${this.renderLogRows()}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    _updateTaskTable() {
        const body = document.getElementById('task-table-body');
        if (body) body.innerHTML = this.renderTaskRows();
        const summary = body?.closest('.hist-tab-panel')?.querySelector('.hist-summary');
        if (summary) summary.textContent = `Showing ${this.filteredTasks.length} of ${this.tasks.length} tasks`;
        this._bindTaskRows();
    }

    _updateLogTable() {
        const body = document.getElementById('log-table-body');
        if (body) body.innerHTML = this.renderLogRows();
        const panel = document.getElementById('hist-panel-api-logs');
        const summary = panel?.querySelector('.hist-summary');
        if (summary) summary.textContent = `Showing ${this.filteredApiLogs.length} of ${this.apiLogs.length} log entries`;
    }

    _bindTaskRows() {
        document.querySelectorAll('.hist-row[data-task-id]').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-task-id');
                if (id) window.location.hash = `#monitor?id=${id}`;
            });
        });

        // Delete buttons — stop propagation so the row click doesn't fire
        document.querySelectorAll('.hist-btn-delete[data-delete-task-id]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-delete-task-id');
                if (!id) return;
                await this._deleteTask(id, btn);
            });
        });
    }

    async _deleteTask(id, btn) {
        const task = this.tasks.find(t => t.id === id);
        const short = id.slice(0, 8);
        const promptPreview = (task?.prompt || '').slice(0, 60);

        const ok = confirm(
            `Delete task #${short}?\n\n` +
            `"${promptPreview}${(task?.prompt || '').length > 60 ? '…' : ''}"\n\n` +
            `Linked API logs from this task's lifespan will also be removed.\n` +
            `This cannot be undone.`
        );
        if (!ok) return;

        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '…';

        try {
            // 1. Delete from backend (memory + disk)
            const result = await window.apiClient.deleteTaskHistory(id);

            // 2. Delete associated API logs from local storage by timestamp window
            const removedLogs = ApiLogStore.removeInRange(
                result?.started_at || task?.started_at,
                result?.completed_at || task?.completed_at || new Date().toISOString()
            );

            // 3. Refresh in-memory state
            this.tasks = this.tasks.filter(t => t.id !== id);
            this.applyTaskFilter();
            this._updateTaskTable();

            // Refresh API logs view too
            this.loadApiLogs();
            this.applyLogFilter();
            this._updateLogTable();
            this._bindLogRows();

            // Update tab counter
            const apiLogTabBtn = document.querySelector('.hist-tab-btn[data-tab="api-logs"]');
            if (apiLogTabBtn) {
                apiLogTabBtn.innerHTML = `API Logs <span style="font-size:11px;opacity:0.7">(${this.apiLogs.length})</span>`;
            }

            console.log(`Deleted task ${id} and ${removedLogs} API log(s) in its time window.`);
        } catch (err) {
            console.error('Failed to delete task:', err);
            alert(`Failed to delete task: ${err.message || err}`);
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    _bindLogRows() {
        document.querySelectorAll('.hist-log-row').forEach(row => {
            row.addEventListener('click', () => {
                const logId = row.getAttribute('data-log-id');
                const log = this.apiLogs.find(l => l.id === logId);
                if (log) this._showLogDetail(log);
            });
        });
    }

    _showLogDetail(log) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;width:640px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
        box.innerHTML = `
            <div style="padding:14px 18px;background:var(--bg-tertiary);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                <span style="font-weight:600;font-size:14px;color:var(--text-primary)">API Log Detail</span>
                <button id="log-detail-close" style="background:none;border:none;color:var(--text-secondary);font-size:18px;cursor:pointer;">✖</button>
            </div>
            <div style="padding:18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px;font-size:13px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Model</label><span style="font-family:var(--font-mono)">${escapeHtml(log.model)}</span></div>
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Provider</label><span>${escapeHtml(log.provider)}</span></div>
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Timestamp</label><span>${formatDate(log.timestamp)}</span></div>
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Latency</label><span>${log.latency_ms ? (log.latency_ms/1000).toFixed(2)+'s' : '—'}</span></div>
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Tokens</label><span>${(log.total_tokens||0).toLocaleString()} (prompt: ${log.prompt_tokens||0}, completion: ${log.completion_tokens||0})</span></div>
                    <div><label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:3px">Messages</label><span>${log.messages_count||0}</span></div>
                </div>
                ${log.prompt_preview ? `
                <div>
                    <label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:5px">Prompt (preview)</label>
                    <div style="background:var(--bg-tertiary);border:1px solid var(--border-light);border-radius:6px;padding:10px;font-size:12px;line-height:1.5;color:var(--text-secondary);white-space:pre-wrap;max-height:120px;overflow-y:auto;">${escapeHtml(log.prompt_preview)}</div>
                </div>` : ''}
                ${log.response_preview ? `
                <div>
                    <label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:5px">Response (preview)</label>
                    <div style="background:var(--bg-tertiary);border:1px solid var(--border-light);border-radius:6px;padding:10px;font-size:12px;line-height:1.5;color:var(--text-secondary);white-space:pre-wrap;max-height:120px;overflow-y:auto;">${escapeHtml(log.response_preview)}</div>
                </div>` : ''}
                ${log.error ? `
                <div>
                    <label style="font-size:11px;color:var(--error);display:block;margin-bottom:5px">Error</label>
                    <div style="background:var(--error-bg);border:1px solid var(--error);border-radius:6px;padding:10px;font-size:12px;color:var(--error);white-space:pre-wrap;">${escapeHtml(log.error)}</div>
                </div>` : ''}
            </div>
        `;
        box.querySelector('#log-detail-close').onclick = () => document.body.removeChild(overlay);
        overlay.onclick = e => { if (e.target === overlay) document.body.removeChild(overlay); };
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    init() {
        // Tab switching
        document.querySelectorAll('.hist-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                this.activeTab = tab;
                document.querySelectorAll('.hist-tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
                document.querySelectorAll('.hist-tab-panel').forEach(p => p.classList.toggle('active', p.id === `hist-panel-${tab}`));
            });
        });

        // Task filters
        const taskSearch = document.getElementById('task-search');
        const taskStatus = document.getElementById('task-status-filter');
        const taskFrom = document.getElementById('task-date-from');
        const taskTo = document.getElementById('task-date-to');
        const taskRefresh = document.getElementById('task-btn-refresh');

        const filterTasks = () => {
            this.taskQuery = taskSearch?.value || '';
            this.taskStatus = taskStatus?.value || 'all';
            this.taskDateFrom = taskFrom?.value || '';
            this.taskDateTo = taskTo?.value || '';
            this.applyTaskFilter();
            this._updateTaskTable();
        };

        taskSearch?.addEventListener('input', filterTasks);
        taskStatus?.addEventListener('change', filterTasks);
        taskFrom?.addEventListener('change', filterTasks);
        taskTo?.addEventListener('change', filterTasks);
        taskRefresh?.addEventListener('click', async () => {
            taskRefresh.textContent = '...';
            await this.loadTasks();
            this.applyTaskFilter();
            this._updateTaskTable();
            taskRefresh.textContent = '↻ Refresh';
        });

        // API log filters
        const logSearch = document.getElementById('log-search');
        const logProvider = document.getElementById('log-provider-filter');
        const logFrom = document.getElementById('log-date-from');
        const logTo = document.getElementById('log-date-to');
        const logClear = document.getElementById('log-btn-clear');

        const filterLogs = () => {
            this.logQuery = logSearch?.value || '';
            this.logProvider = logProvider?.value || 'all';
            this.logDateFrom = logFrom?.value || '';
            this.logDateTo = logTo?.value || '';
            this.applyLogFilter();
            this._updateLogTable();
            this._bindLogRows();
        };

        logSearch?.addEventListener('input', filterLogs);
        logProvider?.addEventListener('change', filterLogs);
        logFrom?.addEventListener('change', filterLogs);
        logTo?.addEventListener('change', filterLogs);
        logClear?.addEventListener('click', () => {
            if (confirm('Clear all API logs?')) {
                ApiLogStore.clear();
                this.loadApiLogs();
                this._updateLogTable();
            }
        });

        this._bindTaskRows();
        this._bindLogRows();
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function getDuration(startStr, endStr) {
    if (!startStr || !endStr) return '—';
    try {
        const diff = Math.round((new Date(endStr) - new Date(startStr)) / 1000);
        if (diff < 60) return `${diff}s`;
        return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    } catch { return '—'; }
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    try { return new Date(isoStr).toLocaleString(); } catch { return ''; }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
