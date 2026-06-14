// History view — agent task execution history.
//
// The old global "API Logs" tab (backed by the localStorage ApiLogStore) was
// retired: per-call LLM payloads now live per-task in the Monitor view. This
// view shows the task list with search/filter and supports single + bulk delete.

export class HistoryView {
    constructor() {
        this.tasks = [];
        this.filteredTasks = [];

        // Task filters
        this.taskQuery = '';
        this.taskStatus = 'all';
        this.taskDateFrom = '';
        this.taskDateTo = '';

        // Bulk selection (task ids)
        this.selectedIds = new Set();
    }

    async loadTasks() {
        try {
            if (window.apiClient) {
                const all = await window.apiClient.listTasks();
                this.tasks = all.filter(t => t.status !== 'running');
                this.tasks.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
                this.filteredTasks = [...this.tasks];
                // Drop selections for tasks that no longer exist.
                const live = new Set(this.tasks.map(t => t.id));
                this.selectedIds = new Set([...this.selectedIds].filter(id => live.has(id)));
            }
        } catch (e) {
            console.error('Failed to load tasks:', e);
        }
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

    renderTaskRows() {
        if (this.filteredTasks.length === 0) {
            return `<tr><td colspan="9" class="hist-empty-cell">No execution history found.</td></tr>`;
        }
        return this.filteredTasks.map(task => {
            const duration = getDuration(task.started_at, task.completed_at);
            const callerBadge = task.caller ? `<span class="hist-caller-badge">${escapeHtml(task.caller)}</span>` : '<span class="hist-caller-none">—</span>';
            const checked = this.selectedIds.has(task.id) ? 'checked' : '';
            return `
                <tr class="hist-row ${this.selectedIds.has(task.id) ? 'hist-row-selected' : ''}" data-task-id="${task.id}">
                    <td class="hist-check-cell"><input type="checkbox" class="hist-row-check" data-id="${task.id}" ${checked}></td>
                    <td><span class="task-badge badge-${task.status}">${task.status}</span></td>
                    <td class="hist-mono">#${task.id.slice(0, 8)}</td>
                    <td class="hist-prompt-cell" title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</td>
                    <td>${callerBadge}</td>
                    <td class="hist-num">${task.token_usage.total_tokens.toLocaleString()}</td>
                    <td class="hist-num">${duration}</td>
                    <td class="hist-date">${formatDate(task.started_at)}</td>
                    <td class="hist-actions-cell">
                        <button class="hist-btn-delete" data-delete-task-id="${task.id}" title="Delete this task">🗑</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    _renderBulkBar() {
        const n = this.selectedIds.size;
        if (n === 0) return '';
        return `
            <div class="hist-bulk-bar">
                <span class="hist-bulk-count">${n} selected</span>
                <button id="hist-bulk-delete" class="hist-bulk-btn-danger">🗑 Delete selected</button>
                <button id="hist-bulk-clear" class="hist-bulk-btn">Clear selection</button>
            </div>
        `;
    }

    async render() {
        await this.loadTasks();
        this.applyTaskFilter();

        return `
            <style>
                .hist-search-bar {
                    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
                    padding: 14px 16px; background: var(--bg-secondary);
                    border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 16px;
                }
                .hist-search-input-wrap { position: relative; flex: 1; min-width: 200px; }
                .hist-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary); font-size: 14px; pointer-events: none; }
                .hist-search-input {
                    width: 100%; padding: 8px 12px 8px 32px; background: var(--bg-input);
                    border: 1px solid var(--border); border-radius: var(--radius-sm);
                    color: var(--text-primary); font-size: 13px; outline: none; box-sizing: border-box;
                }
                .hist-search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
                .hist-search-input::placeholder { color: var(--text-tertiary); }
                .hist-filter-select {
                    padding: 8px 28px 8px 10px; background: var(--bg-input); border: 1px solid var(--border);
                    border-radius: var(--radius-sm); color: var(--text-primary); font-size: 12.5px; outline: none;
                    appearance: none; -webkit-appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
                    background-repeat: no-repeat; background-position: right 8px center; cursor: pointer;
                }
                .hist-filter-select:focus { border-color: var(--accent); }
                .hist-date-input { padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 12.5px; outline: none; }
                .hist-date-input:focus { border-color: var(--accent); }
                .hist-date-sep { color: var(--text-tertiary); font-size: 12px; }
                .hist-btn-refresh { padding: 8px 14px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 12px; cursor: pointer; white-space: nowrap; transition: background var(--transition-fast); }
                .hist-btn-refresh:hover { background: var(--bg-hover); color: var(--text-primary); }

                .hist-summary { font-size: 12px; color: var(--text-tertiary); margin-bottom: 10px; padding-left: 2px; }

                .hist-bulk-bar {
                    display: flex; align-items: center; gap: 12px;
                    padding: 10px 14px; margin-bottom: 12px;
                    background: var(--accent-glow, rgba(0,200,255,0.08));
                    border: 1px solid var(--accent); border-radius: var(--radius-md);
                }
                .hist-bulk-count { font-size: 13px; font-weight: 600; color: var(--accent); }
                .hist-bulk-btn-danger {
                    padding: 6px 14px; background: transparent; border: 1px solid var(--error);
                    color: var(--error); border-radius: var(--radius-sm); font-size: 12.5px; cursor: pointer; font-weight: 500;
                }
                .hist-bulk-btn-danger:hover { background: var(--error-bg); }
                .hist-bulk-btn { padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-secondary); border-radius: var(--radius-sm); font-size: 12.5px; cursor: pointer; }
                .hist-bulk-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

                .hist-table-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
                .hist-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
                .hist-table thead th { background: var(--bg-tertiary); padding: 10px 14px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
                .hist-table tbody tr { border-bottom: 1px solid var(--border-light); transition: background var(--transition-fast); }
                .hist-table tbody tr:last-child { border-bottom: none; }
                .hist-row { cursor: pointer; }
                .hist-row:hover { background: var(--bg-hover); }
                .hist-row-selected { background: var(--accent-glow, rgba(0,200,255,0.06)); }
                .hist-table td { padding: 10px 14px; vertical-align: middle; color: var(--text-primary); }
                .hist-check-cell { text-align: center; width: 40px; padding: 6px !important; }
                .hist-row-check, #task-select-all { width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }
                .hist-empty-cell { text-align: center; padding: 40px !important; color: var(--text-tertiary); font-size: 13px; }
                .hist-prompt-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
                .hist-mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }
                .hist-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
                .hist-date { white-space: nowrap; color: var(--text-tertiary); font-size: 11.5px; }
                .hist-caller-badge { background: var(--bg-tertiary); border: 1px solid var(--border-light); border-radius: 4px; padding: 2px 7px; font-size: 11px; color: var(--text-secondary); }
                .hist-caller-none { color: var(--text-tertiary); }
                .hist-actions-cell { text-align: center; padding: 6px !important; }
                .hist-btn-delete { background: transparent; border: 1px solid transparent; color: var(--text-tertiary); font-size: 14px; padding: 4px 8px; border-radius: var(--radius-sm); cursor: pointer; transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast); }
                .hist-btn-delete:hover { background: var(--error-bg); border-color: var(--error); color: var(--error); }
                .hist-btn-delete:disabled { opacity: 0.5; cursor: not-allowed; }
            </style>

            <div class="view-container">
                <div class="view-header">
                    <div>
                        <h1>History</h1>
                        <p class="subtitle">Agent execution history (per-call LLM payloads are in the Monitor view)</p>
                    </div>
                </div>

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
                <div id="hist-bulk-bar-wrap">${this._renderBulkBar()}</div>

                <div class="hist-table-card">
                    <table class="hist-table">
                        <thead>
                            <tr>
                                <th class="hist-check-cell"><input type="checkbox" id="task-select-all" title="Select all (filtered)"></th>
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
        `;
    }

    _updateTaskTable() {
        const body = document.getElementById('task-table-body');
        if (body) body.innerHTML = this.renderTaskRows();
        const summary = document.querySelector('.hist-summary');
        if (summary) summary.textContent = `Showing ${this.filteredTasks.length} of ${this.tasks.length} tasks`;
        const bulkWrap = document.getElementById('hist-bulk-bar-wrap');
        if (bulkWrap) bulkWrap.innerHTML = this._renderBulkBar();
        this._syncSelectAll();
        this._bindTaskRows();
        this._bindBulkBar();
    }

    _syncSelectAll() {
        const selAll = document.getElementById('task-select-all');
        if (!selAll) return;
        const visible = this.filteredTasks.map(t => t.id);
        const allSelected = visible.length > 0 && visible.every(id => this.selectedIds.has(id));
        selAll.checked = allSelected;
        selAll.indeterminate = !allSelected && visible.some(id => this.selectedIds.has(id));
    }

    _bindTaskRows() {
        // Row click → open in Monitor (ignore clicks on the checkbox / delete button).
        document.querySelectorAll('.hist-row[data-task-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.hist-row-check') || e.target.closest('.hist-btn-delete')) return;
                const id = row.getAttribute('data-task-id');
                if (id) window.location.hash = `#monitor?id=${id}`;
            });
        });

        // Per-row checkbox
        document.querySelectorAll('.hist-row-check').forEach(cb => {
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-id');
                if (cb.checked) this.selectedIds.add(id); else this.selectedIds.delete(id);
                const row = cb.closest('.hist-row');
                if (row) row.classList.toggle('hist-row-selected', cb.checked);
                const bulkWrap = document.getElementById('hist-bulk-bar-wrap');
                if (bulkWrap) bulkWrap.innerHTML = this._renderBulkBar();
                this._syncSelectAll();
                this._bindBulkBar();
            });
        });

        // Per-row delete
        document.querySelectorAll('.hist-btn-delete[data-delete-task-id]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-delete-task-id');
                if (id) await this._deleteTask(id, btn);
            });
        });
    }

    _bindBulkBar() {
        const del = document.getElementById('hist-bulk-delete');
        if (del) del.addEventListener('click', () => this._deleteSelected());
        const clr = document.getElementById('hist-bulk-clear');
        if (clr) clr.addEventListener('click', () => {
            this.selectedIds.clear();
            this._updateTaskTable();
        });
    }

    async _deleteTask(id, btn) {
        const task = this.tasks.find(t => t.id === id);
        const short = id.slice(0, 8);
        const promptPreview = (task?.prompt || '').slice(0, 60);
        const ok = confirm(`Delete task #${short}?\n\n"${promptPreview}${(task?.prompt || '').length > 60 ? '…' : ''}"\n\nThis cannot be undone.`);
        if (!ok) return;

        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
            await window.apiClient.deleteTaskHistory(id);
            this.tasks = this.tasks.filter(t => t.id !== id);
            this.selectedIds.delete(id);
            this.applyTaskFilter();
            this._updateTaskTable();
        } catch (err) {
            console.error('Failed to delete task:', err);
            alert(`Failed to delete task: ${err.message || err}`);
            if (btn) { btn.disabled = false; btn.textContent = '🗑'; }
        }
    }

    async _deleteSelected() {
        const ids = [...this.selectedIds];
        if (ids.length === 0) return;
        if (!confirm(`Delete the ${ids.length} selected task(s)?\nThis cannot be undone.`)) return;

        const delBtn = document.getElementById('hist-bulk-delete');
        if (delBtn) { delBtn.disabled = true; delBtn.textContent = 'Deleting…'; }

        let failed = 0;
        for (const id of ids) {
            try {
                await window.apiClient.deleteTaskHistory(id);
                this.tasks = this.tasks.filter(t => t.id !== id);
                this.selectedIds.delete(id);
            } catch (err) {
                console.error('Bulk delete failed for', id, err);
                failed++;
            }
        }
        this.applyTaskFilter();
        this._updateTaskTable();
        if (failed > 0) alert(`Failed to delete ${failed} item(s).`);
    }

    init() {
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

        // Select-all (operates on the currently filtered rows)
        const selAll = document.getElementById('task-select-all');
        selAll?.addEventListener('change', () => {
            const visible = this.filteredTasks.map(t => t.id);
            if (selAll.checked) visible.forEach(id => this.selectedIds.add(id));
            else visible.forEach(id => this.selectedIds.delete(id));
            this._updateTaskTable();
        });

        this._bindTaskRows();
        this._bindBulkBar();
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
