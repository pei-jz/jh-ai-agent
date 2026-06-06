import { renderResultSummary, attachFileOpenHandlers, ensureResultViewStyles } from '../utils/resultView.js';

export class MonitorView {
    constructor() {
        this.tasks = [];
        this.selectedTaskId = null;
        this.socket = null;
        this.logs = [];
        this.currentProgress = 0;
        this.currentStatus = 'idle';
        this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        // Structured result summaries for the "Result" tab — an ARRAY so multiple
        // runs of the same task (continue-after-complete) accumulate, newest last.
        // Each item: { summary, files:[{path,action,description}] }.
        this.resultSummaries = [];
        // True once the user manually picks a tab during a run — suppresses the
        // auto-switch-to-Result on completion (so it won't yank you off the logs
        // you're reading). Reset when a new run starts (open / continue).
        this._userPickedTab = false;
        this._chatDataMap = {};          // uid → chat entry[]
        this._activeStepChatEntries = []; // real-time accumulator
        this._activeStepChatUid = null;   // uid for current step's button
    }

    async loadTasks() {
        try {
            if (window.apiClient) this.tasks = await window.apiClient.listTasks();
        } catch (e) { console.error('Failed to load tasks:', e); }
    }

    async render() {
        await this.loadTasks();

        const urlParams = getHashParams();
        if (urlParams.id && this.tasks.some(t => t.id === urlParams.id)) {
            this.selectedTaskId = urlParams.id;
        } else if (this.tasks.length > 0 && !this.selectedTaskId) {
            this.selectedTaskId = this.tasks[0].id;
        }

        const sortedTasks = [...this.tasks].sort((a, b) => {
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (a.status !== 'running' && b.status === 'running') return 1;
            return new Date(b.started_at) - new Date(a.started_at);
        });

        const taskListHtml = sortedTasks.length > 0
            ? sortedTasks.map(task => {
                const isSelected = this.selectedTaskId === task.id;
                const pct = Math.round((task.progress || 0) * 100);
                return `
                    <div class="mtask-item ${isSelected ? 'selected' : ''} mtask-${task.status}" data-task-id="${task.id}">
                        <div class="mtask-top">
                            <span class="mtask-dot dot-${task.status}"></span>
                            <span class="mtask-id">#${task.id.slice(0, 6)}</span>
                            ${task.caller ? `<span class="mtask-caller">${escapeHtml(task.caller)}</span>` : ''}
                            <span class="mtask-time">${formatTime(task.started_at)}</span>
                        </div>
                        <div class="mtask-prompt">${escapeHtml(task.prompt)}</div>
                        ${task.status === 'running' ? `<div class="mtask-progbar"><div style="width:${pct}%"></div></div>` : ''}
                    </div>
                `;
            }).join('')
            : `<div class="mtask-empty">No tasks yet</div>`;

        let rightHtml = '';
        if (this.selectedTaskId) {
            const task = this.tasks.find(t => t.id === this.selectedTaskId);
            rightHtml = this._renderDetail(task);
        } else {
            rightHtml = `<div class="mdetail-empty"><span class="mdetail-empty-icon">📊</span><h3>Select a task</h3><p>Choose an agent task from the left panel.</p></div>`;
        }

        return `
            <style>
                /* ── Layout ────────────────────────────────────── */
                .monitor-layout {
                    display: flex;
                    height: calc(100vh - var(--titlebar-height) - 80px);
                    gap: 12px;
                    padding: 12px 0 0 0;
                }

                /* ── Left Panel ────────────────────────────────── */
                .mpanel-left {
                    width: 240px;
                    min-width: 200px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .mpanel-left-header {
                    padding: 8px 12px;
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
                .mpanel-left-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .mtask-item {
                    padding: 7px 9px;
                    border-radius: 6px;
                    border: 1px solid transparent;
                    cursor: pointer;
                    transition: background 0.15s;
                }
                .mtask-item:hover { background: var(--bg-hover); }
                .mtask-item.selected {
                    background: hsla(185, 100%, 55%, 0.08);
                    border-color: var(--accent);
                }
                .mtask-top {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    margin-bottom: 3px;
                }
                .mtask-dot {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .dot-running { background: var(--accent); box-shadow: 0 0 4px var(--accent); animation: dotPulse 1s infinite; }
                .dot-completed { background: var(--success); }
                .dot-failed { background: var(--error); }
                .dot-aborted { background: var(--text-tertiary); }
                @keyframes dotPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
                .mtask-id {
                    font-family: var(--font-mono);
                    font-size: 10.5px;
                    color: var(--text-tertiary);
                }
                .mtask-caller {
                    font-size: 9px;
                    font-weight: 700;
                    color: var(--accent);
                    background: var(--accent-glow);
                    padding: 1px 5px;
                    border-radius: 3px;
                }
                .mtask-time {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    margin-left: auto;
                }
                .mtask-prompt {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .mtask-progbar {
                    margin-top: 4px;
                    height: 2px;
                    background: var(--bg-tertiary);
                    border-radius: 1px;
                    overflow: hidden;
                }
                .mtask-progbar > div {
                    height: 100%;
                    background: var(--accent);
                    transition: width 0.3s;
                }
                .mtask-empty {
                    padding: 20px;
                    text-align: center;
                    color: var(--text-tertiary);
                    font-size: 12px;
                }

                /* ── Right Panel ───────────────────────────────── */
                .mpanel-right {
                    flex: 1;
                    min-width: 0;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .mdetail-empty {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-tertiary);
                }
                .mdetail-empty-icon { font-size: 40px; margin-bottom: 12px; }
                .mdetail-empty h3 { margin: 0 0 6px; font-size: 15px; }
                .mdetail-empty p { font-size: 12px; margin: 0; }

                /* ── Detail Header ─────────────────────────────── */
                .mdetail-header {
                    padding: 8px 14px;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border);
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    flex-shrink: 0;
                    min-width: 0;
                }
                .mdetail-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-primary);
                    font-family: var(--font-mono);
                    flex-shrink: 0;
                }
                .mdetail-prompt-text {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                .mdetail-tokens {
                    font-size: 11px;
                    color: var(--text-tertiary);
                    white-space: nowrap;
                    flex-shrink: 0;
                }
                .mdetail-tokens strong { color: var(--accent); }

                /* ── Progress Row ──────────────────────────────── */
                .mdetail-progress {
                    padding: 6px 14px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-light);
                    flex-shrink: 0;
                }
                .mdetail-progbar-track {
                    height: 3px;
                    background: var(--bg-tertiary);
                    border-radius: 2px;
                    overflow: hidden;
                }
                .mdetail-progbar-fill {
                    height: 100%;
                    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
                    transition: width 0.3s;
                }
                .mdetail-progress-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 10.5px;
                    color: var(--text-tertiary);
                    margin-top: 3px;
                }

                /* ── Filter Bar ────────────────────────────────── */
                .mfilter-bar {
                    display: flex;
                    gap: 2px;
                    padding: 5px 10px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-light);
                    flex-shrink: 0;
                    align-items: center;
                }
                .mfilter-btn {
                    padding: 3px 10px;
                    border: none;
                    background: transparent;
                    color: var(--text-tertiary);
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: background 0.12s, color 0.12s;
                }
                .mfilter-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
                .mfilter-btn.active { background: var(--bg-tertiary); color: var(--accent); }

                /* ── Console / Log Area ────────────────────────── */
                .mconsole {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px 10px;
                    background: var(--bg-primary);
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    min-height: 0;
                }
                .mconsole-placeholder {
                    font-size: 12px;
                    color: var(--text-tertiary);
                    padding: 20px;
                    text-align: center;
                }

                /* ── Step Container ────────────────────────────── */
                .mstep {
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    overflow: hidden;
                    margin-bottom: 3px;
                    flex-shrink: 0;
                }
                .mstep-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 5px 10px;
                    background: var(--bg-secondary);
                    cursor: pointer;
                    user-select: none;
                    min-height: 30px;
                    transition: background 0.12s;
                    min-width: 0;
                    overflow: hidden;
                }
                .mstep-header:hover { background: var(--bg-hover); }
                .mstep-header.expanded { background: var(--bg-tertiary); }
                .mstep-toggle {
                    font-size: 9px;
                    color: var(--text-tertiary);
                    width: 12px;
                    flex-shrink: 0;
                }
                .mstep-header.expanded .mstep-toggle { color: var(--accent); }
                .mstep-num {
                    font-size: 10.5px;
                    font-weight: 700;
                    color: var(--accent);
                    font-family: var(--font-mono);
                    flex-shrink: 0;
                    white-space: nowrap;
                }
                .mstep-pulse {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    background: var(--accent);
                    animation: dotPulse 1s infinite;
                    flex-shrink: 0;
                }
                .mstep-summary {
                    font-size: 11px;
                    color: var(--text-secondary);
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                /* Live (in-flight) status — italic + dimmer to distinguish from
                   a finalized thought/tool summary */
                .mstep-summary.live-status {
                    font-style: italic;
                    color: var(--text-tertiary);
                }
                .mstep-summary.tool-status {
                    color: var(--accent);
                    font-family: var(--font-mono);
                    font-size: 10.5px;
                }
                .mstep-summary.error-status {
                    color: var(--warning);
                }
                .mstep-summary.confirm-status {
                    color: var(--info);
                    font-weight: 500;
                }
                .mstep-time {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    flex-shrink: 0;
                    white-space: nowrap;
                }

                /* ── CHAT button in step header ────────────────── */
                .mstep-chat-btn {
                    flex-shrink: 0;
                    padding: 2px 8px;
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    background: var(--bg-primary);
                    color: var(--accent);
                    font-size: 10px;
                    font-family: var(--font-mono);
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.12s, border-color 0.12s;
                    line-height: 1.5;
                }
                .mstep-chat-btn:hover {
                    background: var(--bg-hover);
                    border-color: var(--accent);
                }
                .mstep-chat-btn.err {
                    color: var(--error);
                    border-color: rgba(255,80,80,0.4);
                }

                /* ── Step Body ─────────────────────────────────── */
                .mstep-body {
                    display: none;
                    flex-direction: column;
                    gap: 2px;
                    padding: 5px 6px;
                    background: var(--bg-primary);
                    border-top: 1px solid var(--border-light);
                }
                .mstep-body.open { display: flex; }

                /* ── Log Line Types ────────────────────────────── */
                .mlog {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    padding: 3px 6px;
                    border-radius: 4px;
                    font-size: 11.5px;
                    line-height: 1.45;
                    min-width: 0;
                }
                .mlog:hover { background: var(--bg-secondary); }
                .mlog-icon {
                    flex-shrink: 0;
                    font-size: 11px;
                    margin-top: 1px;
                    width: 14px;
                    text-align: center;
                }
                .mlog-body { flex: 1; min-width: 0; overflow: hidden; }

                /* Thought */
                .mlog-thought .mlog-body { color: var(--text-secondary); }
                .mlog-thought-summary {
                    color: var(--text-secondary);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    min-width: 0;
                }
                .mlog-thought-summary span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    flex: 1;
                    min-width: 0;
                }
                .mlog-thought-summary:hover { color: var(--text-primary); }
                .mlog-expand-btn {
                    font-size: 9px;
                    color: var(--text-tertiary);
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0 2px;
                    flex-shrink: 0;
                }
                .mlog-thought-detail {
                    display: none;
                    margin-top: 6px;
                    padding: 10px 12px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    font-size: 12px;
                    color: var(--text-secondary);
                    max-height: 360px;
                    overflow-y: auto;
                }
                .mlog-thought-detail.open { display: block; }

                /* ── Friendly multi-field thought detail layout ── */
                .thought-detail-formatted {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .thought-field {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .thought-field-label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 10.5px;
                    font-weight: 700;
                    color: var(--accent);
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                }
                .thought-field-icon {
                    font-size: 13px;
                    line-height: 1;
                }
                .thought-field-content {
                    font-size: 12.5px;
                    line-height: 1.55;
                    white-space: pre-wrap;
                    word-break: break-word;
                    color: var(--text-primary);
                    padding: 6px 10px;
                    background: var(--bg-secondary);
                    border-left: 2px solid var(--accent-dim);
                    border-radius: 0 4px 4px 0;
                }
                .thought-field-content .thought-list {
                    margin: 0;
                    padding-left: 18px;
                }
                .thought-field-content .thought-list li {
                    margin-bottom: 4px;
                }
                .thought-field-content .thought-list li:last-child {
                    margin-bottom: 0;
                }
                .thought-nested {
                    margin: 4px 0 0 0;
                    padding: 6px 8px;
                    background: var(--bg-primary);
                    border-radius: 4px;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                }
                .thought-empty {
                    color: var(--text-tertiary);
                    font-style: italic;
                    font-size: 11px;
                }
                .thought-raw {
                    margin: 0;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                /* Tool call */
                .mlog-tool .mlog-body { font-family: var(--font-mono); min-width: 0; }
                .mlog-tool-name { color: var(--accent); font-weight: 600; font-size: 11px; }
                .mlog-tool-args { color: var(--text-tertiary); font-size: 10.5px; }
                .mlog-tool-result {
                    display: none;
                    margin-top: 6px;
                    padding: 6px 10px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-left: 3px solid var(--accent);
                    border-radius: 4px;
                    font-size: 10.5px;
                    color: var(--text-secondary);
                    max-height: 300px;
                    overflow: auto;
                }
                .mlog-tool-result.open { display: block; }
                .mlog-tool-row {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    cursor: pointer;
                    min-width: 0;
                    overflow: hidden;
                }
                .mlog-tool-row:hover .mlog-tool-name { text-decoration: underline; }
                .mlog-tool-result-preview {
                    flex: 1;
                    min-width: 0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-size: 10.5px;
                    color: var(--success);
                }

                /* File / Status rows */
                .mlog-file .mlog-body code,
                .mlog-cmd .mlog-body code {
                    font-size: 10.5px;
                    background: var(--bg-tertiary);
                    padding: 1px 5px;
                    border-radius: 3px;
                    color: var(--text-secondary);
                    word-break: break-all;
                }
                .mlog-read .mlog-icon { color: #339af0; }
                .mlog-write .mlog-icon { color: hsl(340,100%,65%); }
                .mlog-cmd .mlog-icon { color: var(--success); }
                .mlog-success { color: var(--success); }
                .mlog-error { color: var(--error); }
                .mlog-status { color: var(--text-tertiary); }

                /* Inline TOOL telemetry */
                .mlog-telemetry {
                    border: 1px solid var(--border-light);
                    border-radius: 5px;
                    overflow: hidden;
                }
                .mlog-tele-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    background: var(--bg-secondary);
                    cursor: pointer;
                    font-size: 11px;
                    font-family: var(--font-mono);
                }
                .mlog-tele-header:hover { background: var(--bg-hover); }
                .mlog-tele-method { font-weight: 700; color: var(--accent); font-size: 10.5px; }
                .mlog-tele-status-ok { color: var(--success); font-weight: 700; font-size: 10.5px; }
                .mlog-tele-status-err { color: var(--error); font-weight: 700; font-size: 10.5px; }
                .mlog-tele-dur { color: var(--text-tertiary); font-size: 10px; }
                .mlog-tele-usage { margin-left: auto; font-size: 10.5px; color: var(--text-secondary); }
                .mlog-tele-body {
                    display: none;
                    background: var(--bg-primary);
                    border-top: 1px solid var(--border-light);
                }
                .mlog-tele-body.open { display: block; }
                .mlog-tele-tabs {
                    display: flex;
                    gap: 1px;
                    padding: 4px 8px 0;
                    background: var(--bg-secondary);
                }
                .mlog-tele-tab {
                    padding: 2px 10px;
                    font-size: 10.5px;
                    border: none;
                    background: transparent;
                    color: var(--text-tertiary);
                    cursor: pointer;
                    border-radius: 3px 3px 0 0;
                    font-weight: 600;
                }
                .mlog-tele-tab.active { background: var(--bg-primary); color: var(--accent); }
                .mlog-tele-content pre {
                    margin: 0;
                    padding: 8px;
                    font-size: 10.5px;
                    font-family: var(--font-mono);
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                    max-height: 200px;
                    overflow-y: auto;
                    background: var(--bg-primary);
                }

                /* Confirm boxes */
                .mconfirm-box {
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    padding: 10px 12px;
                    background: var(--bg-secondary);
                    font-size: 12px;
                    margin: 2px 0;
                }
                .mconfirm-box h4 { margin: 0 0 6px; font-size: 12px; color: var(--text-primary); }
                .mconfirm-box pre { margin: 4px 0; font-size: 11px; background: var(--bg-tertiary); padding: 6px; border-radius: 4px; max-height: 120px; overflow-y: auto; }
                .mconfirm-actions { display: flex; gap: 8px; margin-top: 8px; }

                /* Steering input */
                .msteering {
                    display: flex;
                    gap: 8px;
                    padding: 8px 10px;
                    background: var(--bg-secondary);
                    border-top: 1px solid var(--border-light);
                    flex-shrink: 0;
                    align-items: flex-end;
                }
                .msteering textarea {
                    flex: 1;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    color: var(--text-primary);
                    font-family: var(--font-sans);
                    font-size: 12px;
                    padding: 7px 10px;
                    resize: none;
                    min-height: 36px;
                    max-height: 80px;
                    outline: none;
                    transition: border-color 0.15s;
                }
                .msteering textarea:focus { border-color: var(--accent); }
                .msteering textarea::placeholder { color: var(--text-tertiary); }
                .msteering .btn-sm {
                    height: 36px;
                    padding: 0 16px;
                    font-size: 12px;
                    flex-shrink: 0;
                    align-self: flex-end;
                }
            </style>

            <div class="monitor-layout">
                <!-- Left panel -->
                <div class="mpanel-left">
                    <div class="mpanel-left-header">
                        <span>Executions</span>
                        <span style="font-weight:400;opacity:0.6">${this.tasks.length}</span>
                    </div>
                    <div class="mpanel-left-list" id="mtask-list">
                        ${taskListHtml}
                    </div>
                </div>

                <!-- Right panel -->
                <div class="mpanel-right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _renderDetail(task) {
        if (!task) return '<div class="mdetail-empty"><span class="mdetail-empty-icon">📊</span><h3>Task not found</h3></div>';
        const tokens = this.tokenUsage.total_tokens || task.token_usage.total_tokens;
        const prog = this.currentProgress || task.progress || 0;
        const status = this.currentStatus !== 'idle' ? this.currentStatus : task.status;

        return `
            <div class="mdetail-header">
                <span class="mdetail-title">#${task.id.slice(0,8)}</span>
                ${task.caller ? `<span class="mtask-caller">${escapeHtml(task.caller)}</span>` : ''}
                <span class="task-badge badge-${task.status}">${task.status}</span>
                <span class="mdetail-prompt-text" title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</span>
                <span class="mdetail-tokens">Tokens: <strong id="val-total-tokens">${tokens.toLocaleString()}</strong></span>
                ${task.status === 'running' ? `<button class="btn btn-error" id="btn-abort-task" style="height:28px;padding:0 12px;font-size:11px;flex-shrink:0">⏹ Abort</button>` : ''}
            </div>
            <div class="mdetail-progress">
                <div class="mdetail-progbar-track">
                    <div class="mdetail-progbar-fill" id="detail-progress-bar" style="width:${prog * 100}%"></div>
                </div>
                <div class="mdetail-progress-info">
                    <span>Status: <strong id="val-status">${status}</strong></span>
                    <span>Progress: <strong id="val-progress">${Math.round(prog * 100)}%</strong></span>
                </div>
            </div>
            <div class="mfilter-bar">
                <button class="mfilter-btn active" data-filter="all">All Logs</button>
                <button class="mfilter-btn" data-filter="thought">🧠 Thoughts</button>
                <button class="mfilter-btn" data-filter="tool">🛠 Tools</button>
                <button class="mfilter-btn" data-filter="telemetry">🔌 API</button>
                <button class="mfilter-btn" data-filter="result">📋 Result</button>
            </div>
            <div class="mconsole" id="console-logs" data-current-filter="all">
                ${this.renderAllLogs()}
            </div>
            <div class="mconsole mresult" id="result-panel" style="display:none">
                ${this._renderResultsHtml()}
            </div>
            <div class="msteering">
                <textarea id="input-steering" placeholder="Steer the agent... (Ctrl+Enter to send)" disabled rows="1"></textarea>
                <button class="btn btn-primary btn-sm" id="btn-send-steering" disabled>Send</button>
            </div>
        `;
    }

    // ─── Log Rendering ──────────────────────────────────────────────────────

    renderAllLogs() {
        if (this.logs.length === 0) return '<div class="mconsole-placeholder">Waiting for execution logs...</div>';

        // Reset chat data map for this render
        this._chatDataMap = {};

        // Events to skip entirely from inline rendering
        const SKIP_EVENTS = new Set(['token_usage', 'stream', 'task_plan_sync', 'confirm_resolved']);

        let html = '';
        let stepId = null;
        let stepBody = '';
        let stepCount = 0;
        let stepSummary = '';      // thought-based summary
        let stepFirstTool = null; // fallback if no thought
        let stepChatEntries = []; // CHAT API calls for this step
        let stepTime = '';

        const totalSteps = this.logs.filter(l =>
            l.event === 'status' && l.data.message?.startsWith('Thinking... (step ')
        ).length;

        const flushStep = () => {
            if (stepId === null) return;

            // Determine best summary for a historical (replayed) step.
            // Priority: explicit thought summary > first tool name > generic fallback.
            // ("Executing…" is reserved for *live* steps where activity is still happening;
            //  for a finished step it would be misleading.)
            const finalSummary = stepSummary ||
                (stepFirstTool ? `Used ${stepFirstTool}` : 'Reasoning step (no output)');

            // Build CHAT button if we have entries
            let chatBtnHtml = '';
            if (stepChatEntries.length > 0) {
                const chatUid = 'chat-' + Math.random().toString(36).slice(2, 8);
                this._chatDataMap[chatUid] = [...stepChatEntries];
                const totalPrompt     = stepChatEntries.reduce((s, c) => s + (c.usage?.prompt_tokens     || 0), 0);
                const totalCompletion = stepChatEntries.reduce((s, c) => s + (c.usage?.completion_tokens || 0), 0);
                const totalDur        = stepChatEntries.reduce((s, c) => s + (c.duration || 0), 0);
                const lastEntry = stepChatEntries[stepChatEntries.length - 1];
                const statusCode = lastEntry.status || 200;
                const isErr = statusCode >= 400 || lastEntry.error;
                chatBtnHtml = `<button class="mstep-chat-btn${isErr ? ' err' : ''}" data-chat-uid="${chatUid}">CHAT ${statusCode} · ↑${totalPrompt}t ↓${totalCompletion}t · ${totalDur}ms</button>`;
            }

            const isLatest = stepCount === totalSteps;
            html += `
                <div class="mstep" id="mstep-${stepId}">
                    <div class="mstep-header ${isLatest ? 'expanded' : ''}" data-step-id="${stepId}">
                        <span class="mstep-toggle">${isLatest ? '▼' : '▶'}</span>
                        ${isLatest ? '<span class="mstep-pulse"></span>' : ''}
                        <span class="mstep-num">Step ${stepId}</span>
                        <span class="mstep-summary">${escapeHtml(finalSummary)}</span>
                        ${chatBtnHtml}
                        <span class="mstep-time">${stepTime}</span>
                    </div>
                    <div class="mstep-body ${isLatest ? 'open' : ''}">${stepBody}</div>
                </div>
            `;
            stepBody = '';
            stepSummary = '';
            stepFirstTool = null;
            stepChatEntries = [];
        };

        let initHtml = '';

        for (const log of this.logs) {
            // Skip noise events
            if (SKIP_EVENTS.has(log.event)) continue;

            // Step boundary marker
            if (log.event === 'status' && log.data.message?.startsWith('Thinking... (step ')) {
                flushStep();
                const m = log.data.message.match(/\(step (\d+)\)/);
                stepId = m ? parseInt(m[1]) : stepCount + 1;
                stepCount++;
                stepTime = log.timestamp ? formatTime(log.timestamp) : '';
                continue;
            }

            // CHAT API call → collect for button (not inline)
            if (log.event === 'log' && log.data && log.data.method !== 'TOOL') {
                if (stepId !== null) {
                    stepChatEntries.push(log.data);
                    continue; // skip inline rendering
                }
                continue;
            }

            // Thought → extract summary
            if (log.event === 'thought' && stepId !== null) {
                const raw = typeof log.data.text === 'string' ? log.data.text : JSON.stringify(log.data.text);
                stepSummary = this._extractThoughtSummary(raw);
            }

            // First tool call → fallback summary
            if (log.event === 'tool_call' && stepId !== null && !stepFirstTool) {
                stepFirstTool = log.data.name || null;
            }

            const lineHtml = this.formatLogLine(log);
            if (!lineHtml) continue;
            if (stepId === null) initHtml += lineHtml;
            else stepBody += lineHtml;
        }

        flushStep();

        if (initHtml) {
            html = `
                <div class="mstep" id="mstep-init">
                    <div class="mstep-header" data-step-id="init">
                        <span class="mstep-toggle">▶</span>
                        <span class="mstep-num">Init</span>
                        <span class="mstep-summary">Initialization</span>
                    </div>
                    <div class="mstep-body">${initHtml}</div>
                </div>
            ` + html;
        }

        return html;
    }

    /** Extract a readable 1-line summary from raw thought text (plain or JSON). */
    _extractThoughtSummary(rawText) {
        const txt = (rawText || '').trim();
        if (txt.startsWith('{') || txt.startsWith('[')) {
            try {
                const obj = JSON.parse(txt);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    // Try preferred field names first
                    for (const field of ['thinking', 'thought', 'observation', 'plan', 'reflection', 'summary', 'analysis', 'reasoning', 'action']) {
                        if (typeof obj[field] === 'string' && obj[field].trim()) {
                            const v = obj[field].trim();
                            return v.substring(0, 120) + (v.length > 120 ? '…' : '');
                        }
                    }
                    // Fall back to first string value
                    for (const v of Object.values(obj)) {
                        if (typeof v === 'string' && v.trim()) {
                            return v.substring(0, 120) + (v.length > 120 ? '…' : '');
                        }
                    }
                }
            } catch {}
        }
        return txt.substring(0, 120) + (txt.length > 120 ? '…' : '');
    }

    formatLogLine(log) {
        if (log) {
            log = { ...log, data: log.data || {} };
        } else {
            return '';
        }
        switch (log.event) {
            case 'stream':          return '';
            case 'task_plan_sync':  return '';
            case 'token_usage':     return '';
            case 'thought':         return this._fmtThought(log);
            case 'tool_call':       return this._fmtTool(log);
            case 'file_modified':   return this._fmtFile(log);
            case 'status':          return this._fmtStatus(log);
            case 'complete':        return `<div class="mlog mlog-success log-success"><span class="mlog-icon">✅</span><span class="mlog-body"><strong>Complete:</strong> ${escapeHtml(log.data.message || '')}</span></div>`;
            case 'finish_task':     return `<div class="mlog mlog-success log-success"><span class="mlog-icon">🏁</span><span class="mlog-body"><strong>Finished:</strong> ${escapeHtml(log.data.summary || '')}</span></div>`;
            case 'error':           return `<div class="mlog mlog-error log-error"><span class="mlog-icon">❌</span><span class="mlog-body"><strong>Error:</strong> ${escapeHtml(log.data.error || '')}</span></div>`;
            case 'log':
                // TOOL telemetry stays inline; CHAT is handled as step header button
                if (log.data?.method === 'TOOL') return this._fmtTelemetry(log.data);
                return ''; // CHAT handled by renderAllLogs / connectWebSocket
            case 'confirm_request': return this._fmtConfirm(log.data);
            default:                return `<div class="mlog mlog-status log-status"><span class="mlog-icon" style="opacity:0.5">·</span><span class="mlog-body">${escapeHtml(JSON.stringify(log.data).slice(0,120))}</span></div>`;
        }
    }

    _fmtThought(log) {
        let rawText = '';
        let parsedObj = null;
        try {
            if (typeof log.data.text === 'object' && log.data.text !== null) {
                parsedObj = log.data.text;
                rawText = JSON.stringify(log.data.text, null, 2);
            } else {
                rawText = String(log.data.text || '');
                // Try to parse if it looks like JSON
                const trimmed = rawText.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { parsedObj = JSON.parse(trimmed); } catch (_) { /* not JSON */ }
                }
            }
        } catch {
            rawText = String(log.data.text || '');
        }

        const uid = Math.random().toString(36).slice(2, 7);
        const summary = this._extractThoughtSummary(rawText);
        const detailHtml = this._formatThoughtDetail(parsedObj, rawText);

        return `
            <div class="mlog mlog-thought log-thought">
                <span class="mlog-icon">🧠</span>
                <div class="mlog-body">
                    <div class="mlog-thought-summary" data-uid="${uid}">
                        <span>${escapeHtml(summary)}</span>
                        <button class="mlog-expand-btn" data-uid="${uid}" data-target="thought-detail-${uid}">▶</button>
                    </div>
                    <div class="mlog-thought-detail" id="thought-detail-${uid}">${detailHtml}</div>
                </div>
            </div>
        `;
    }

    /**
     * Render the expanded thought detail as labeled, readable sections.
     * If the thought is a JSON object, each known field becomes a labeled
     * block with an icon (Observation / Thinking / Plan / etc.). Unknown
     * fields are kept too, just with a generic label. Strings without JSON
     * structure fall through to a preformatted text block.
     */
    _formatThoughtDetail(parsedObj, rawText) {
        // Non-JSON or array? Just show as preformatted text.
        if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
            return `<pre class="thought-raw">${escapeHtml(rawText)}</pre>`;
        }

        // Known field → human-friendly label + icon
        const LABELS = {
            goal:        { icon: '🎯', label: 'Goal' },
            observation: { icon: '👁',  label: 'Observation' },
            thinking:    { icon: '🧠', label: 'Thinking' },
            thought:     { icon: '🧠', label: 'Thought' },
            reasoning:   { icon: '🧠', label: 'Reasoning' },
            analysis:    { icon: '🔍', label: 'Analysis' },
            plan:        { icon: '📋', label: 'Plan' },
            next_steps:  { icon: '➡',  label: 'Next Steps' },
            reflection:  { icon: '💭', label: 'Reflection' },
            summary:     { icon: '📝', label: 'Summary' },
            action:      { icon: '⚡', label: 'Action' },
            tool_calls:  { icon: '⚙', label: 'Tool Calls' },
        };

        // Preferred display order — fields not in this list come last in original order
        const PREFERRED_ORDER = [
            'goal', 'observation', 'thinking', 'thought', 'reasoning',
            'analysis', 'plan', 'next_steps', 'reflection',
            'summary', 'action', 'tool_calls'
        ];

        const keys = Object.keys(parsedObj);
        const ordered = [
            ...PREFERRED_ORDER.filter(k => keys.includes(k)),
            ...keys.filter(k => !PREFERRED_ORDER.includes(k))
        ];

        const renderValue = (v) => {
            if (v == null) return '<span class="thought-empty">(empty)</span>';
            if (typeof v === 'string') {
                return escapeHtml(v);
            }
            if (Array.isArray(v)) {
                // Render as bullet list; nested objects get JSON-stringified
                const items = v.map(item => {
                    if (typeof item === 'string') return `<li>${escapeHtml(item)}</li>`;
                    return `<li><pre class="thought-nested">${escapeHtml(JSON.stringify(item, null, 2))}</pre></li>`;
                }).join('');
                return `<ul class="thought-list">${items}</ul>`;
            }
            // Nested object → pretty JSON
            return `<pre class="thought-nested">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
        };

        const sections = ordered
            .filter(key => {
                const v = parsedObj[key];
                if (v == null) return false;
                if (typeof v === 'string' && v.trim() === '') return false;
                if (Array.isArray(v) && v.length === 0) return false;
                return true;
            })
            .map(key => {
                const meta = LABELS[key] || {
                    icon: '·',
                    // Convert snake_case → Title Case for unknown keys
                    label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                };
                return `
                    <div class="thought-field">
                        <div class="thought-field-label"><span class="thought-field-icon">${meta.icon}</span>${escapeHtml(meta.label)}</div>
                        <div class="thought-field-content">${renderValue(parsedObj[key])}</div>
                    </div>
                `;
            })
            .join('');

        // If nothing useful was extracted, fall back to raw
        if (!sections) {
            return `<pre class="thought-raw">${escapeHtml(rawText)}</pre>`;
        }
        return `<div class="thought-detail-formatted">${sections}</div>`;
    }

    _fmtTool(log) {
        const name = log.data.name || 'unknown';
        const args = log.data.args || {};
        const result = log.data.result;

        const uid = Math.random().toString(36).slice(2, 7);
        const resultStr = result ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : '';
        const resultSnippet = resultStr ? resultStr.substring(0, 60) + (resultStr.length > 60 ? '…' : '') : '';

        let toolIcon = '🛠';
        let toolTitle = name;
        let toolClass = 'log-tool';
        let customContentHtml = '';

        if (name === 'read_file' || name === 'view_file') {
            toolIcon = '📖';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Read File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-read log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'write_file' || name === 'write_to_file') {
            toolIcon = '✍';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Wrote File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-write log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'multi_replace_file_content') {
            toolIcon = '📝';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Edited File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-write log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'grep_search') {
            toolIcon = '🔍';
            const term = args.term || args.query || '';
            toolTitle = `Searched for: <code>"${escapeHtml(term)}"</code>`;
            toolClass = 'mlog-read log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'run_command') {
            toolIcon = '💻';
            const cmd = args.command || '';
            toolTitle = `Ran Command: <code>${escapeHtml(cmd)}</code>`;
            toolClass = 'mlog-cmd log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;background:#0c0f12;border-color:#1e252b;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'list_files' || name === 'list_dir') {
            toolIcon = '📁';
            const path = args.path || args.directory || '';
            toolTitle = `Listed Directory: <code>${escapeHtml(path)}</code>`;
            toolClass = 'log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'propose_plan') {
            toolIcon = '📋';
            const title = args.title || '';
            toolTitle = `Proposed Plan: <strong>${escapeHtml(title)}</strong>`;
            toolClass = 'log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'create_artifact' || name === 'update_artifact') {
            toolIcon = '📄';
            const artName = args.name || '';
            toolTitle = `Saved Artifact: <code>${escapeHtml(artName)}</code>`;
            toolClass = 'log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'finish_task') {
            toolIcon = '🏁';
            const summary = args.summary || '';
            toolTitle = `Finished Task: <strong style="color:var(--success);">${escapeHtml(summary)}</strong>`;
            toolClass = 'mlog-success log-tool';
        } else {
            const argPairs = Object.entries(args).slice(0, 3).map(([k, v]) => {
                const val = typeof v === 'string' ? `"${v.substring(0, 30)}"` : JSON.stringify(v).substring(0, 30);
                return `${k}=${val}`;
            }).join(', ') + (Object.keys(args).length > 3 ? ', …' : '');
            toolTitle = `<span class="mlog-tool-name">${escapeHtml(name)}</span> <span class="mlog-tool-args">(${escapeHtml(argPairs)})</span>`;
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        }

        let isErrResult = false;
        if (resultStr) {
            const lower = resultStr.toLowerCase();
            if (lower.startsWith('error') || lower.includes('"error"')) {
                isErrResult = true;
            }
        }
        if (isErrResult) {
            toolClass = 'mlog-error log-tool';
        }

        const innerContent = customContentHtml || (resultStr ? `<div style="font-family:monospace;white-space:pre-wrap;word-break:break-word;">${escapeHtml(resultStr)}</div>` : '');

        return `
            <div class="mlog ${toolClass}">
                <span class="mlog-icon">${toolIcon}</span>
                <div class="mlog-body">
                    <div class="mlog-tool-row" data-uid="${uid}" style="display:flex;align-items:center;width:100%;">
                        <span class="mlog-tool-name" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;">${toolTitle}</span>
                        ${resultStr ? `
                            <span class="mlog-tool-result-preview" style="max-width:250px;margin-left:8px;font-size:10px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${escapeHtml(resultSnippet)}</span>
                            <button class="mlog-expand-btn" data-uid="${uid}" data-target="tool-result-${uid}" style="margin-left:6px;flex-shrink:0;">▶</button>
                        ` : ''}
                    </div>
                    ${resultStr ? `
                        <div class="mlog-tool-result" id="tool-result-${uid}" style="margin-top:6px;">
                            ${innerContent}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    _fmtFile(log) {
        return `
            <div class="mlog mlog-file log-file">
                <span class="mlog-icon">📝</span>
                <span class="mlog-body"><code>${escapeHtml(log.data.path || '')}</code></span>
            </div>
        `;
    }

    _fmtStatus(log) {
        const txt = String(log.data.message || log.data.status || '');

        // Suppress meaningless noise
        if (!txt || txt === 'Waiting for user input...' || txt.trim().startsWith('{')) return '';

        // Suppress redundant status logs (formatted as tool calls instead)
        if (txt.startsWith('Reading file:') ||
            txt.startsWith('Writing file:') ||
            txt.startsWith('Editing file:') ||
            txt.startsWith('Running command:') ||
            txt.startsWith('Searching for') ||
            txt.startsWith('Exploring directory:') ||
            txt.startsWith('Deep scanning directory:') ||
            txt.startsWith('Creating artifact:') ||
            txt.startsWith('Updating artifact:') ||
            txt.startsWith('Proposed plan:') ||
            txt.startsWith('Calling MCP tool:')) {
            return '';
        }

        // JSON parse retry / error recovery → show as inline warning within step
        if (txt.includes('JSON parse failed') || txt.includes('⚠️')) {
            return `<div class="mlog log-status" style="color:var(--warning,#f59e0b)"><span class="mlog-icon">⚠️</span><span class="mlog-body">${escapeHtml(txt)}</span></div>`;
        }
        // Generic error/abort messages
        if (txt.includes('failed') || txt.includes('Error') || txt.includes('error')) {
            return `<div class="mlog mlog-error log-status"><span class="mlog-icon">⚡</span><span class="mlog-body" style="color:var(--error)">${escapeHtml(txt)}</span></div>`;
        }
        return `<div class="mlog mlog-status log-status"><span class="mlog-icon" style="opacity:0.5">·</span><span class="mlog-body" style="color:var(--text-tertiary)">${escapeHtml(txt)}</span></div>`;
    }

    _fmtTelemetry(d) {
        if (!d) return '';
        const isErr = d.status >= 400 || d.error;
        const method = d.method === 'TOOL' ? `TOOL:${d.name || ''}` : (d.method || 'POST');
        const dur = d.duration ? `${d.duration}ms` : '';
        const uid = Math.random().toString(36).slice(2, 7);

        let usageTxt = '';
        if (d.usage) {
            if (d.method === 'TOOL') {
                const fmt = b => typeof b === 'number' ? (b < 1024 ? b + 'B' : (b/1024).toFixed(1) + 'K') : '0B';
                usageTxt = `↑${fmt(d.usage.request_size)} ↓${fmt(d.usage.response_size)}`;
            } else {
                usageTxt = `↑${d.usage.prompt_tokens||0}t ↓${d.usage.completion_tokens||0}t`;
            }
        }

        const fmtPayload = (data) => {
            if (!data) return '';
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
            if (typeof data !== 'object') return String(data);
            let out = '';
            for (const [k, v] of Object.entries(data)) {
                // Skip empty string values (e.g. "thought":"" from native tool calling)
                if (typeof v === 'string' && v.trim() === '') continue;
                out += `=== ${k} ===\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\n`;
            }
            return out.trim();
        };

        const req = escapeHtml(fmtPayload(d.request));
        const res = escapeHtml(fmtPayload(d.response || d.error || ''));
        const hdrs = d.headers ? escapeHtml(JSON.stringify(d.headers, null, 2)) : '';

        return `
            <div class="mlog-telemetry telemetry-log" id="tele-${uid}">
                <div class="mlog-tele-header">
                    <span class="mlog-tele-method">${escapeHtml(method)}</span>
                    <span class="${isErr ? 'mlog-tele-status-err' : 'mlog-tele-status-ok'}">${d.status || (isErr ? 'ERR' : 'OK')}</span>
                    <span class="mlog-tele-dur">${dur}</span>
                    ${usageTxt ? `<span class="mlog-tele-usage">${escapeHtml(usageTxt)}</span>` : ''}
                    <span style="margin-left:auto;font-size:9px;color:var(--text-tertiary)">▶</span>
                </div>
                <div class="mlog-tele-body" id="tele-body-${uid}">
                    <div class="mlog-tele-tabs">
                        <button class="mlog-tele-tab active" data-tab="req" data-uid="${uid}">Request</button>
                        <button class="mlog-tele-tab" data-tab="res" data-uid="${uid}">Response</button>
                        ${hdrs ? `<button class="mlog-tele-tab" data-tab="hdrs" data-uid="${uid}">Headers</button>` : ''}
                    </div>
                    <div class="mlog-tele-content" id="tele-content-${uid}">
                        <pre class="tele-pane tele-req-${uid}">${req}</pre>
                        <pre class="tele-pane tele-res-${uid}" style="display:none">${res}</pre>
                        ${hdrs ? `<pre class="tele-pane tele-hdrs-${uid}" style="display:none">${hdrs}</pre>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    _fmtConfirm(data) {
        const cid = data.confirmId;
        let inner = '';
        if (data.type === 'command_confirm') {
            inner = `<h4>🛡 Command Approval</h4><p>${escapeHtml(data.message || '')}</p><pre><code>${escapeHtml(data.command || '')}</code></pre>`;
        } else if (data.type === 'plan_review') {
            // Editable plan — the user can revise it before approving; the edited
            // text is sent back as modifiedContent and becomes the plan the agent follows.
            inner = `<h4>📋 Plan Approval</h4><p><strong>${escapeHtml(data.title || '')}</strong></p>` +
                `<p class="mconfirm-hint" style="font-size:11px;color:var(--text-tertiary);margin:0 0 6px">承認前に編集できます。承認すると編集後の計画に従います。</p>` +
                `<textarea class="mconfirm-plan-edit" id="plan-edit-${cid}" rows="12" ` +
                `style="width:100%;box-sizing:border-box;font-family:var(--font-mono);font-size:12px;` +
                `background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);` +
                `border-radius:6px;padding:10px;resize:vertical;">${escapeHtml(data.message || '')}</textarea>`;
        } else if (data.type === 'diff_review') {
            inner = `<h4>📝 File Modification</h4><p><code>${escapeHtml(data.path || '')}</code></p><p>${escapeHtml(data.message || '')}</p>${this.renderSimpleDiff(data.oldContent || '', data.newContent || '')}`;
        }
        return `
            <div class="mconfirm-box log-confirm-request" id="confirm-${cid}">
                ${inner}
                <div class="mconfirm-actions">
                    <button class="btn btn-success btn-approve" data-confirm-id="${cid}">Approve</button>
                    <button class="btn btn-error btn-reject" data-confirm-id="${cid}">Reject</button>
                </div>
            </div>
        `;
    }

    // ─── WebSocket ──────────────────────────────────────────────────────────

    connectWebSocket(taskId) {
        if (this.socket) this.socket.close();
        this.logs = [];
        this.currentProgress = 0;
        this.currentStatus = 'running';
        this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        this.resultSummaries = [];
        this._taskFinished = false;
        this._userPickedTab = false;
        this._activeStepChatEntries = [];
        this._activeStepChatUid = null;
        if (!window.apiClient) return;

        const wsUrl = `ws://localhost:${window.apiClient.port}/ws/tasks/${taskId}?token=${window.apiClient.token}`;
        this.socket = new WebSocket(wsUrl);

        const disableSteering = () => {
            const si = document.getElementById('input-steering');
            const sb = document.getElementById('btn-send-steering');
            if (si) si.disabled = true;
            if (sb) sb.disabled = true;
        };

        this.socket.onopen = () => {
            const consoleEl = document.getElementById('console-logs');
            if (consoleEl) consoleEl.innerHTML = '';
            const si = document.getElementById('input-steering');
            const sb = document.getElementById('btn-send-steering');
            if (si) si.disabled = false;
            if (sb) sb.disabled = false;
        };

        this.socket.onmessage = (ev) => {
            try {
                const packet = JSON.parse(ev.data);
                if (!packet) return;
                packet.data = packet.data || {};

                // Any non-terminal event means a run is actively streaming → the
                // steer box is in "steer" (not "continue") mode. This also correctly
                // flips back after a reconnect replays an older `complete` event.
                if (packet.event && packet.event !== 'complete' && packet.event !== 'error') {
                    this._taskFinished = false;
                }

                // ── Approval was resolved (possibly by another connected client) ──
                // Handle BEFORE pushing to this.logs so it isn't replayed on view reload.
                if (packet.event === 'confirm_resolved') {
                    const { confirmId, approved } = packet.data || {};
                    if (confirmId) this._markConfirmResolved(confirmId, approved, /*byOther*/ true);
                    return;
                }

                this.logs.push(packet);
                const consoleEl = document.getElementById('console-logs');
                if (!consoleEl) return;

                const placeholder = consoleEl.querySelector('.mconsole-placeholder');
                if (placeholder) placeholder.remove();

                // ── New step boundary ──────────────────────────────
                if (packet.event === 'status' && packet.data.message?.startsWith('Thinking... (step ')) {
                    // Reset CHAT tracking for new step
                    this._activeStepChatEntries = [];
                    this._activeStepChatUid = null;

                    const m = packet.data.message.match(/\(step (\d+)\)/);
                    const stepNum = m ? m[1] : (consoleEl.querySelectorAll('.mstep').length + 1);

                    // Collapse previous step. Also finalize any leftover "live" status
                    // so collapsed cards show something more informative than "Thinking…".
                    // We find the previous step robustly (it might no longer have the
                    // `expanded` class if the user collapsed it manually).
                    const prevSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                    const prevStep = prevSteps[prevSteps.length - 1];
                    const prevHeader = prevStep ? prevStep.querySelector('.mstep-header') : null;
                    if (prevHeader) {
                        this._finalizePreviousStep(prevHeader);
                        if (prevHeader.classList.contains('expanded')) {
                            prevHeader.classList.remove('expanded');
                            const tog = prevHeader.querySelector('.mstep-toggle');
                            if (tog) tog.textContent = '▶';
                            const body = prevStep.querySelector('.mstep-body');
                            if (body) body.classList.remove('open');
                        }
                    }

                    const time = packet.timestamp ? formatTime(packet.timestamp) : '';
                    consoleEl.insertAdjacentHTML('beforeend', `
                        <div class="mstep" id="mstep-${stepNum}">
                            <div class="mstep-header expanded" data-step-id="${stepNum}" id="mstep-hdr-${stepNum}">
                                <span class="mstep-toggle">▼</span>
                                <span class="mstep-pulse"></span>
                                <span class="mstep-num">Step ${stepNum}</span>
                                <span class="mstep-summary live-status" data-status-priority="0">🧠 Calling LLM…</span>
                                <span class="mstep-time">${time}</span>
                            </div>
                            <div class="mstep-body open"></div>
                        </div>
                    `);

                // ── CHAT API call → step header button ─────────────
                } else if (packet.event === 'log' && packet.data && packet.data.method !== 'TOOL') {
                    this._activeStepChatEntries.push(packet.data);

                    // Get or create uid
                    if (!this._activeStepChatUid) {
                        this._activeStepChatUid = 'chat-' + Math.random().toString(36).slice(2, 8);
                        this._chatDataMap[this._activeStepChatUid] = this._activeStepChatEntries;
                    }

                    // Compute aggregated values
                    const totalPrompt     = this._activeStepChatEntries.reduce((s, c) => s + (c.usage?.prompt_tokens     || 0), 0);
                    const totalCompletion = this._activeStepChatEntries.reduce((s, c) => s + (c.usage?.completion_tokens || 0), 0);
                    const totalDur        = this._activeStepChatEntries.reduce((s, c) => s + (c.duration || 0), 0);
                    const lastEntry = this._activeStepChatEntries[this._activeStepChatEntries.length - 1];
                    const statusCode = lastEntry.status || 200;
                    const isErr = statusCode >= 400 || lastEntry.error;
                    const btnText = `CHAT ${statusCode} · ↑${totalPrompt}t ↓${totalCompletion}t · ${totalDur}ms`;

                    // ⚠ Route the CHAT button to the AGENT's currently-running step
                    // (the last real step in DOM order), NOT to whichever step the user
                    // has expanded for viewing. Using `.expanded` here was a bug — it
                    // caused new content to leak into a step the user was inspecting,
                    // leaving the actual current step empty.
                    const realStepsForChat = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                    const activeStepForChat = realStepsForChat[realStepsForChat.length - 1];
                    const activeHeader = activeStepForChat?.querySelector('.mstep-header');
                    if (activeHeader) {
                        let btn = activeHeader.querySelector('.mstep-chat-btn');
                        if (!btn) {
                            btn = document.createElement('button');
                            btn.className = 'mstep-chat-btn';
                            btn.setAttribute('data-chat-uid', this._activeStepChatUid);
                            const timeEl = activeHeader.querySelector('.mstep-time');
                            if (timeEl) activeHeader.insertBefore(btn, timeEl);
                            else activeHeader.appendChild(btn);
                        }
                        btn.textContent = btnText;
                        btn.classList.toggle('err', isErr);
                    }

                // ── Regular log entry ──────────────────────────────
                } else {
                    // ⚠ Same fix as the CHAT branch above. The previous selector
                    // (`.mstep-header.expanded + .mstep-body.open`) tied content
                    // routing to the user's VISUAL expand state. So when the user
                    // clicked an older step to inspect it, every subsequent log
                    // event was appended to that step's body instead of the
                    // agent's truly-active (latest) step — making new steps
                    // appear empty and bloating an old one with foreign content.
                    //
                    // Correct behavior: ALWAYS append to the last real step's body
                    // regardless of expand state. User expansion is purely visual
                    // and must not affect data routing.
                    const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                    const activeStep = realSteps[realSteps.length - 1];
                    let activeBody = activeStep?.querySelector('.mstep-body');

                    if (!activeBody) {
                        // No real step yet — these are pre-step events (project scan,
                        // workspace setup, etc.). Route to the synthetic "Init" step.
                        let initStep = consoleEl.querySelector('#mstep-init');
                        if (!initStep) {
                            consoleEl.insertAdjacentHTML('afterbegin', `
                                <div class="mstep" id="mstep-init">
                                    <div class="mstep-header" data-step-id="init">
                                        <span class="mstep-toggle">▶</span>
                                        <span class="mstep-num">Init</span>
                                        <span class="mstep-summary">Initialization</span>
                                    </div>
                                    <div class="mstep-body"></div>
                                </div>
                            `);
                            initStep = consoleEl.querySelector('#mstep-init');
                        }
                        activeBody = initStep.querySelector('.mstep-body');
                    }

                    if (activeBody) {
                        const lineHtml = this.formatLogLine(packet);
                        if (lineHtml) {
                            activeBody.insertAdjacentHTML('beforeend', lineHtml);

                            // ── Live-status updates: keep the step header informative ──
                            // Each event type pushes a description with a priority so the
                            // header always shows the most actionable current state.
                            if (packet.event === 'thought') {
                                const raw = typeof packet.data.text === 'string'
                                    ? packet.data.text
                                    : JSON.stringify(packet.data.text);
                                const summaryText = this._extractThoughtSummary(raw);
                                // Stash the thought summary on the step element so that
                                // when a tool subsequently completes, we can switch the
                                // header back to the thought (which describes what the
                                // step achieved) instead of leaving a stale "✓ tool done".
                                const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                                const activeStep = realSteps[realSteps.length - 1];
                                if (activeStep) activeStep.dataset.thoughtSummary = summaryText;
                                this._updateActiveStepStatus(summaryText, 'thought');
                            } else if (packet.event === 'tool_call') {
                                // `tool_call` is fired ONCE per tool, at start (no result yet) —
                                // tool completion is signaled separately by a `log` event with
                                // method='TOOL' (telemetry). So this branch always means "running".
                                const toolName = packet.data.name || 'tool';
                                // Remember last tool name so _finalizePreviousStep can fall back
                                // to "Used <toolName>" if no thought summary was captured.
                                const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                                const activeStep = realSteps[realSteps.length - 1];
                                if (activeStep) activeStep.dataset.lastTool = toolName;
                                this._updateActiveStepStatus(`⚙ Running: ${toolName}…`, 'tool');
                            } else if (packet.event === 'confirm_request') {
                                this._updateActiveStepStatus('⏸ Awaiting approval…', 'confirm');
                            } else if (packet.event === 'error') {
                                this._updateActiveStepStatus('⚠ Error — recovering', 'error');
                            } else if (packet.event === 'log' && packet.data?.method === 'TOOL') {
                                // Tool finished (this is the telemetry event sent after
                                // each tool returns). The header was showing "⚙ Running: X…"
                                // — now that the tool is done, prefer the thought summary
                                // (the "story" of this step) if we captured one. Otherwise
                                // fall back to a past-tense "✓ X done".
                                const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                                const activeStep = realSteps[realSteps.length - 1];
                                if (activeStep) {
                                    const storedThought = activeStep.dataset.thoughtSummary;
                                    const toolName = packet.data.name || activeStep.dataset.lastTool || 'tool';
                                    if (storedThought) {
                                        // Same 'tool' priority as the in-flight status, so this overwrite is allowed
                                        this._updateActiveStepStatus(storedThought, 'tool');
                                    } else {
                                        this._updateActiveStepStatus(`✓ ${toolName} done`, 'tool');
                                    }
                                }
                            } else if (packet.event === 'status' && packet.data.message) {
                                // Generic status hints — only override 'live' priority
                                const msg = String(packet.data.message);
                                if (/retry|recover/i.test(msg)) {
                                    this._updateActiveStepStatus(`↻ ${msg.slice(0, 60)}`, 'error');
                                }
                            }

                            // Apply current filter
                            const filter = consoleEl.getAttribute('data-current-filter') || 'all';
                            const last = activeBody.lastElementChild;
                            if (last) this.applyElementFilter(last, filter);
                        }
                    }
                }

                // Auto-scroll if near bottom
                const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 120;
                if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;

                // Update progress/status/tokens
                if (packet.event === 'token_usage') {
                    // ACCUMULATE across LLM calls — each token_usage event is one
                    // call's usage, not the running total. (Previously this overwrote,
                    // so the header showed only the last step's tokens, which for a
                    // tool-only final step is often 0 → the "Tokens: 0" bug.)
                    const d = packet.data || {};
                    this.tokenUsage.prompt_tokens     += d.prompt_tokens || 0;
                    this.tokenUsage.completion_tokens += d.completion_tokens || 0;
                    this.tokenUsage.total_tokens      += (d.total_tokens || ((d.prompt_tokens || 0) + (d.completion_tokens || 0)));
                    const vt = document.getElementById('val-total-tokens');
                    if (vt) vt.textContent = this.tokenUsage.total_tokens.toLocaleString();
                    return; // don't render as inline log line
                }
                if (packet.event === 'status') {
                    this.currentProgress = packet.data.progress || this.currentProgress;
                    this.currentStatus = packet.data.status || this.currentStatus;
                    const pb = document.getElementById('detail-progress-bar');
                    if (pb) pb.style.width = `${this.currentProgress * 100}%`;
                    const vp = document.getElementById('val-progress');
                    if (vp) vp.textContent = `${Math.round(this.currentProgress * 100)}%`;
                    const vs = document.getElementById('val-status');
                    if (vs) vs.textContent = this.currentStatus;
                } else if (packet.event === 'complete' || packet.event === 'error') {
                    this.currentStatus = packet.event === 'complete' ? 'completed' : 'failed';
                    this.currentProgress = 1.0;
                    // Accumulate the result summary (one per run) for the Result tab.
                    if (packet.event === 'complete' && packet.data?.resultSummary) {
                        this.resultSummaries.push(packet.data.resultSummary);
                    }
                    // On completion, switch to the Result tab — but ONLY if the user
                    // hasn't manually navigated to another tab during this run (don't
                    // yank them off logs they're inspecting).
                    if (packet.event === 'complete' && !this._userPickedTab) {
                        this._activateResultTab();
                    }
                    const pb = document.getElementById('detail-progress-bar');
                    if (pb) pb.style.width = '100%';
                    const vp = document.getElementById('val-progress');
                    if (vp) vp.textContent = '100%';
                    const vs = document.getElementById('val-status');
                    if (vs) vs.textContent = this.currentStatus;
                    const ab = document.getElementById('btn-abort-task');
                    if (ab) ab.remove();

                    // Finalize the still-running last step so it doesn't sit there
                    // pulsing with a stale "Calling LLM…" or "⚙ Running: X…" label.
                    const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                    const lastStep = realSteps[realSteps.length - 1];
                    const lastHeader = lastStep?.querySelector('.mstep-header');
                    if (lastHeader) this._finalizePreviousStep(lastHeader);

                    if (packet.event === 'complete') {
                        // Keep the steer box usable so the user can CONTINUE the task.
                        this._taskFinished = true;
                        const si = document.getElementById('input-steering');
                        const sb = document.getElementById('btn-send-steering');
                        if (si) { si.disabled = false; si.placeholder = '✓ 完了。追記してタスクを続行 (Ctrl+Enter)'; }
                        if (sb) sb.disabled = false;
                    } else {
                        disableSteering();
                    }
                }
            } catch (e) { console.error('WS parse error:', e); }
        };

        this.socket.onerror = () => disableSteering();
        // Don't disable the steer box on a normal post-completion close — the user
        // can still type to continue the task.
        this.socket.onclose = () => { if (!this._taskFinished) disableSteering(); };
    }

    async loadHistoricalLogs(taskId) {
        if (!window.apiClient) return;
        const consoleEl = document.getElementById('console-logs');
        try {
            const logs = await window.apiClient.getTaskLogs(taskId);
            if (Array.isArray(logs) && logs.length > 0) {
                this.logs = logs.map(l => ({ ...l, data: l.data || {} }));
                // Recover ALL run results from the persisted `complete` events
                // (a continued task has more than one).
                this.resultSummaries = this.logs
                    .filter(l => l.event === 'complete' && l.data?.resultSummary)
                    .map(l => l.data.resultSummary);
                this._renderResultPanel();
                if (consoleEl) {
                    consoleEl.innerHTML = this.renderAllLogs();
                    const filter = consoleEl.getAttribute('data-current-filter') || 'all';
                    this.applyFilter(consoleEl, filter);
                }
                // Completed task with a result → open on the Result tab by default.
                if (this.resultSummaries.length > 0) {
                    this._activateResultTab();
                }
                // Finished task → allow continuing it (re-run) from the steer box.
                this._taskFinished = true;
                const si = document.getElementById('input-steering');
                const sb = document.getElementById('btn-send-steering');
                if (si) { si.disabled = false; si.placeholder = '✓ 完了。追記してタスクを続行 (Ctrl+Enter)'; }
                if (sb) sb.disabled = false;
            }
        } catch (e) {
            console.error('Failed to load task logs:', e);
        }
    }

    /** Build HTML for ALL accumulated run results (newest runs appended below). */
    _renderResultsHtml() {
        const runs = this.resultSummaries || [];
        if (runs.length === 0) return renderResultSummary(null);
        if (runs.length === 1) return renderResultSummary(runs[0]);
        // Multiple runs (continue-after-complete) — label each.
        return runs.map((r, i) =>
            `<div class="mresult-run"><div class="mresult-run-label">実行 #${i + 1}</div>${renderResultSummary(r)}</div>`
        ).join('<hr style="border:none;border-top:1px solid var(--border);margin:18px 0">');
    }

    /** Re-render the Result tab panel and (re)bind file-open links. */
    _renderResultPanel() {
        ensureResultViewStyles();
        const rp = document.getElementById('result-panel');
        if (!rp) return;
        rp.innerHTML = this._renderResultsHtml();
        attachFileOpenHandlers(rp);
    }

    /** Switch the detail view to the Result tab (used on task completion). */
    _activateResultTab() {
        const btns = document.querySelectorAll('.mfilter-btn');
        if (!btns.length) return;
        btns.forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === 'result'));
        const consoleEl = document.getElementById('console-logs');
        const rp = document.getElementById('result-panel');
        if (consoleEl) consoleEl.style.display = 'none';
        if (rp) { rp.style.display = 'block'; this._renderResultPanel(); }
    }

    // ─── Filter ─────────────────────────────────────────────────────────────

    applyFilter(consoleEl, filter) {
        const items = consoleEl.querySelectorAll('.mlog, .mlog-telemetry, .mconfirm-box');
        items.forEach(item => this.applyElementFilter(item, filter));
    }

    applyElementFilter(item, filter) {
        if (filter === 'all') { item.style.display = ''; return; }
        const cls = item.classList;
        const show =
            (filter === 'thought'   && cls.contains('log-thought')) ||
            (filter === 'tool'      && (cls.contains('log-tool') || cls.contains('log-file'))) ||
            (filter === 'telemetry' && cls.contains('telemetry-log'));
        item.style.display = show ? '' : 'none';
    }

    /**
     * Update the currently-running step's header summary so the user always sees
     * *what the agent is actually doing right now*, not a generic "Executing…".
     *
     * Uses a small priority system so a later cheap status (e.g. an incoming
     * stream chunk) doesn't clobber a more meaningful one (e.g. an active tool
     * invocation). When the step ends and a new one starts, the previous step's
     * "live" status is finalized (italic class removed, fallback applied if empty).
     *
     * `type` ranking (higher = more authoritative — overrides equal-or-lower):
     *   live    = 0   "🧠 Thinking…", "💬 Receiving…"
     *   thought = 1   the extracted thought summary
     *   tool    = 2   "⚙ run_command" — currently active tool
     *   confirm = 3   "⏸ Awaiting approval"
     *   error   = 4   "⚠ Recovering from error"
     *   final   = 99  applied at step transition, no further overrides
     *
     * Note: tool can override thought (priority 2 > 1) because what the agent
     * is DOING right now is more useful than what it was THINKING. The thought
     * is already visible in the step body anyway.
     */
    _updateActiveStepStatus(text, type = 'live') {
        const consoleEl = document.getElementById('console-logs');
        if (!consoleEl) return;

        // Active step = the last non-init step in the console
        const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
        const activeStep = realSteps[realSteps.length - 1];
        if (!activeStep) return;

        const summary = activeStep.querySelector('.mstep-summary');
        if (!summary) return;

        const PRIORITY = { live: 0, thought: 1, tool: 2, confirm: 3, error: 4, final: 99 };
        const current = parseInt(summary.getAttribute('data-status-priority') || '-1', 10);
        const incoming = PRIORITY[type] ?? 0;

        // Final state cannot be overwritten. Otherwise: equal or higher priority wins.
        if (current >= PRIORITY.final) return;
        if (incoming < current) return;

        summary.textContent = text;
        summary.setAttribute('data-status-priority', String(incoming));

        // Reset visual class then apply the matching one
        summary.classList.remove('live-status', 'tool-status', 'error-status', 'confirm-status');
        if (type === 'live')    summary.classList.add('live-status');
        if (type === 'tool')    summary.classList.add('tool-status');
        if (type === 'error')   summary.classList.add('error-status');
        if (type === 'confirm') summary.classList.add('confirm-status');
        // type === 'thought' or 'final' → no extra class, plain text
    }

    /**
     * Called when a NEW step begins (or the task completes/errors).
     * Finalizes the previous step's "live" status so the collapsed card
     * shows something meaningful instead of a still-pulsing "Calling LLM…":
     *  - removes the pulse dot
     *  - if the status is still in the volatile `live` state, falls back to
     *    a reasonable description gleaned from the step's last tool name
     *    (which we stash on the step element via _updateActiveStepStatus)
     *    or the step body content
     *  - if the status is "⚙ Running: X…" (tool was still in progress),
     *    converts it to past tense "✓ X done" since the step has now ended
     *  - locks the priority so no further updates can overwrite it
     */
    _finalizePreviousStep(prevHeader) {
        if (!prevHeader) return;
        const summary = prevHeader.querySelector('.mstep-summary');
        const pulse = prevHeader.querySelector('.mstep-pulse');
        if (pulse) pulse.remove();
        if (!summary) return;

        const priority = parseInt(summary.getAttribute('data-status-priority') || '0', 10);
        const isStillLive = summary.classList.contains('live-status') || priority === 0;
        const text = summary.textContent || '';
        const stepEl = prevHeader.parentElement;
        const storedThought = stepEl?.dataset.thoughtSummary;

        // ── Step finalization priority order ──
        //   1. Stored thought summary (the "story" of what this step accomplished)
        //   2. Current text if it's a real tool-done or thought-derived state
        //   3. Last tool name → "Used X" (when only live "Calling LLM…" was seen)
        //   4. Generic fallback
        if (storedThought) {
            // Always prefer the thought summary as the locked title.
            // This is what the user explicitly asked for: at step end, show the
            // reasoning summary instead of a stale tool name.
            summary.textContent = storedThought;
        } else if (isStillLive) {
            const lastTool = stepEl?.dataset.lastTool;
            let fallback = 'Reasoning step (no tool output)';
            if (lastTool) {
                fallback = `Used ${lastTool}`;
            } else if (stepEl) {
                const body = stepEl.querySelector('.mstep-body');
                if (body?.querySelector('.log-tool')) {
                    fallback = 'Tool execution';
                } else if (body?.querySelector('.log-error, .mlog-error')) {
                    fallback = 'Error during execution';
                }
            }
            summary.textContent = fallback;
        } else {
            // Convert in-progress tool wording to past tense
            const runningMatch = text.match(/^⚙ Running:\s*(.+?)…?\s*$/);
            if (runningMatch) {
                summary.textContent = `✓ ${runningMatch[1]} done`;
            }
            // else: leave whatever the last status was
        }

        // Lock the finalized status
        summary.classList.remove('live-status');
        summary.setAttribute('data-status-priority', String(99));
    }

    sendConfirmResponse(confirmId, approved) {
        // For an approved plan_review, send the (possibly edited) plan text back so
        // the agent follows the user's revised plan.
        let modifiedContent = null;
        if (approved) {
            const planEdit = document.getElementById(`plan-edit-${confirmId}`);
            if (planEdit && typeof planEdit.value === 'string') modifiedContent = planEdit.value;
        }
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ event: 'confirm_response', data: { confirmId, approved, modifiedContent } }));
        }
        // Optimistically mark the card as resolved on this client.
        // The server will also fan-out a `confirm_resolved` event that hits any
        // OTHER client connected to the same task (e.g. JHEditor when this one
        // is JHAI). The other client's handler is _markConfirmResolved.
        this._markConfirmResolved(confirmId, approved, /*byOther*/ false);
    }

    /**
     * Disable the Approve/Reject buttons of a pending confirm card and replace them
     * with a resolved-status indicator. Idempotent — safe to call repeatedly
     * (e.g. once locally via sendConfirmResponse and again via the broadcast echo).
     *
     * @param {string}  confirmId  matches data-confirm-id from _fmtConfirm
     * @param {boolean} approved   true ⇒ approved, false ⇒ rejected
     * @param {boolean} byOther    true ⇒ another client resolved it; label accordingly
     */
    _markConfirmResolved(confirmId, approved, byOther = false) {
        const card = document.getElementById(`confirm-${confirmId}`);
        if (!card) return;
        const actions = card.querySelector('.mconfirm-actions');
        if (!actions) return;

        // Idempotency: only overwrite if the buttons are still present
        const stillPending = !!(actions.querySelector('.btn-approve') || actions.querySelector('.btn-reject'));
        if (!stillPending) return;

        const suffix = byOther ? ' <span style="opacity:0.6;font-weight:400;font-size:11px">(by another client)</span>' : '';
        actions.innerHTML = approved
            ? `<span style="color:var(--success);font-weight:600">🟢 Approved${suffix}</span>`
            : `<span style="color:var(--error);font-weight:600">🔴 Rejected${suffix}</span>`;

        // The step header was showing "⏸ Awaiting approval…" at confirm priority (3).
        // Now that the approval has been resolved, demote the header's priority back
        // to thought-level (1) so subsequent tool events can update it. Without this,
        // the header would freeze on "Awaiting approval…" for the rest of the step.
        const consoleEl = document.getElementById('console-logs');
        const realSteps = consoleEl?.querySelectorAll('.mstep:not(#mstep-init)') || [];
        const activeStep = realSteps[realSteps.length - 1];
        const summary = activeStep?.querySelector('.mstep-summary');
        if (summary && summary.classList.contains('confirm-status')) {
            summary.textContent = approved ? '✓ Approved — continuing' : '✗ Rejected';
            summary.classList.remove('confirm-status');
            summary.classList.add(approved ? 'tool-status' : 'error-status');
            // Reset priority so tools/thoughts can still update afterwards
            summary.setAttribute('data-status-priority', '1');
        }
    }

    renderSimpleDiff(oldText, newText) {
        const ol = oldText.split('\n');
        const nl = newText.split('\n');
        let html = '<div style="font-family:monospace;font-size:10.5px;background:#0f1419;padding:8px;border-radius:4px;overflow-x:auto;max-height:200px;border:1px solid var(--border);">';
        let i = 0, j = 0;
        while (i < ol.length || j < nl.length) {
            if (i < ol.length && j < nl.length) {
                if (ol[i] === nl[j]) {
                    html += `<div style="color:#666;padding:1px 4px;white-space:pre">  ${escapeHtml(ol[i])}</div>`; i++; j++;
                } else {
                    html += `<div style="color:#ff5555;background:rgba(255,85,85,0.1);padding:1px 4px;white-space:pre">- ${escapeHtml(ol[i++])}</div>`;
                    html += `<div style="color:#50fa7b;background:rgba(80,250,123,0.1);padding:1px 4px;white-space:pre">+ ${escapeHtml(nl[j++])}</div>`;
                }
            } else if (i < ol.length) {
                html += `<div style="color:#ff5555;background:rgba(255,85,85,0.1);padding:1px 4px;white-space:pre">- ${escapeHtml(ol[i++])}</div>`;
            } else {
                html += `<div style="color:#50fa7b;background:rgba(80,250,123,0.1);padding:1px 4px;white-space:pre">+ ${escapeHtml(nl[j++])}</div>`;
            }
        }
        return html + '</div>';
    }

    // ─── CHAT Modal ─────────────────────────────────────────────────────────

    _setupChatModal() {
        if (document.getElementById('mchat-modal-overlay')) return;

        const style = document.createElement('style');
        style.id = 'mchat-modal-style';
        style.textContent = `
            #mchat-modal-overlay {
                display: none;
                position: fixed;
                inset: 0;
                z-index: 9999;
                background: rgba(0,0,0,0.72);
                align-items: center;
                justify-content: center;
            }
            #mchat-modal-overlay.open { display: flex; }
            #mchat-modal-box {
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: var(--radius-lg);
                width: min(92vw, 880px);
                max-height: 82vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                box-shadow: 0 24px 80px rgba(0,0,0,0.6);
            }
            #mchat-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 16px;
                background: var(--bg-tertiary);
                border-bottom: 1px solid var(--border);
                flex-shrink: 0;
            }
            #mchat-modal-title {
                font-size: 12.5px;
                font-weight: 600;
                color: var(--text-primary);
                font-family: var(--font-mono);
            }
            #mchat-modal-close {
                background: none;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                font-size: 16px;
                padding: 2px 6px;
                border-radius: 4px;
                line-height: 1;
                transition: background 0.12s, color 0.12s;
            }
            #mchat-modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }
            #mchat-modal-body {
                flex: 1;
                overflow-y: auto;
                padding: 0;
            }
            .mchat-entry {
                padding: 14px 18px;
            }
            .mchat-entry + .mchat-entry {
                border-top: 1px solid var(--border-light);
            }
            .mchat-entry-meta {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 12px;
                padding-bottom: 10px;
                border-bottom: 1px solid var(--border-light);
                font-family: var(--font-mono);
            }
            .mchat-usage {
                margin-left: auto;
                font-size: 11px;
                color: var(--text-secondary);
            }
            .mchat-section-label {
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: var(--text-tertiary);
                margin: 10px 0 5px;
            }
            .mchat-section-label:first-of-type { margin-top: 0; }
            .mchat-subtabs {
                display: flex;
                gap: 4px;
                flex-wrap: wrap;
                margin: 4px 0 8px;
                border-bottom: 1px solid var(--border-light);
                padding-bottom: 6px;
            }
            .mchat-subtab {
                padding: 4px 10px;
                border: 1px solid var(--border);
                background: var(--bg-tertiary);
                color: var(--text-secondary);
                font-size: 11px;
                border-radius: var(--radius-sm);
                cursor: pointer;
                white-space: nowrap;
            }
            .mchat-subtab:hover { background: var(--bg-hover); color: var(--text-primary); }
            .mchat-subtab.active { background: var(--bg-primary); color: var(--accent); border-color: var(--accent); }
            .mchat-steplabel { font-size: 10.5px; color: var(--accent); font-weight: 600; }
            .mchat-pre {
                margin: 0;
                padding: 10px 12px;
                background: var(--bg-primary);
                border: 1px solid var(--border-light);
                border-radius: 5px;
                font-size: 10.5px;
                font-family: var(--font-mono);
                color: var(--text-secondary);
                white-space: pre-wrap;
                word-break: break-word;
                max-height: 300px;
                overflow-y: auto;
                line-height: 1.5;
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'mchat-modal-overlay';
        overlay.innerHTML = `
            <div id="mchat-modal-box">
                <div id="mchat-modal-header">
                    <span id="mchat-modal-title">🔌 API Call Details</span>
                    <button id="mchat-modal-close" title="Close (Esc)">✕</button>
                </div>
                <div id="mchat-modal-body"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('mchat-modal-close').addEventListener('click', () => {
            overlay.classList.remove('open');
        });
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.classList.remove('open');
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.classList.contains('open')) {
                overlay.classList.remove('open');
            }
        });
    }

    _showChatModal(entries) {
        const overlay = document.getElementById('mchat-modal-overlay');
        const body    = document.getElementById('mchat-modal-body');
        const title   = document.getElementById('mchat-modal-title');
        if (!overlay || !body) return;

        if (title) {
            const count = entries.length;
            const totalP  = entries.reduce((s, c) => s + (c.usage?.prompt_tokens     || 0), 0);
            const totalC  = entries.reduce((s, c) => s + (c.usage?.completion_tokens || 0), 0);
            const totalMs = entries.reduce((s, c) => s + (c.duration || 0), 0);
            title.textContent = `🔌 API Calls (${count}) · ↑${totalP}t ↓${totalC}t · ${totalMs}ms total`;
        }

        // Turn escaped "\n"/"\t" sequences (common in raw LLM JSON envelopes) into
        // real line breaks so the content is readable in the <pre> panels.
        const unescapeNL = (s) => typeof s === 'string'
            ? s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
            : s;

        const fmtMsgArray = (arr, label) => {
            let out = `=== ${label} (${arr.length} messages) ===\n`;
            arr.forEach((msg, i) => {
                const role = msg.role || 'unknown';
                const raw = typeof msg.content === 'string'
                    ? msg.content.substring(0, 4000) + (msg.content.length > 4000 ? '\n…(truncated)' : '')
                    : JSON.stringify(msg.content, null, 2);
                out += `──── [${i}] ${role} ────\n${unescapeNL(raw)}\n\n`;
            });
            return out;
        };

        const fmtPayload = (data) => {
            if (!data) return '(none)';
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
            if (typeof data !== 'object') return String(data);

            // Reorder: system_prompt always first, then history/messages, then rest
            const orderedKeys = [
                'system_prompt',
                ...Object.keys(data).filter(k => k !== 'system_prompt' && k !== 'history' && k !== 'messages' && k !== 'url' && k !== 'headers'),
                ...(data.history !== undefined ? ['history'] : []),
                ...(data.messages !== undefined ? ['messages'] : []),
                ...(data.url !== undefined ? ['url'] : []),
                ...(data.headers !== undefined ? ['headers'] : []),
            ].filter(k => k in data);

            let out = '';
            for (const k of orderedKeys) {
                const v = data[k];
                if (k === 'history' || k === 'messages') {
                    if (Array.isArray(v)) {
                        out += fmtMsgArray(v, k) + '\n';
                    } else {
                        out += `=== ${k} ===\n${JSON.stringify(v, null, 2)}\n\n`;
                    }
                } else if (k === 'system_prompt') {
                    out += `=== system_prompt ===\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\n`;
                } else if (k === 'url' || k === 'headers') {
                    // url/headers at the end, compact
                    out += `=== ${k} ===\n${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`;
                } else {
                    // Skip empty string values (e.g. "thought":"" from native tool calling)
                    if (typeof v === 'string' && v.trim() === '') continue;
                    out += `=== ${k} ===\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\n`;
                }
            }
            return out.trim() || '(empty)';
        };

        const safeObj = (v) => {
            if (v && typeof v === 'object') return v;
            if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
            return {};
        };

        body.innerHTML = entries.map((d, i) => {
            const method  = d.method === 'TOOL' ? `TOOL:${d.name}` : (d.method || 'CHAT');
            const isErr   = (d.status || 200) >= 400 || d.error;
            const usage   = d.usage
                ? `↑${d.usage.prompt_tokens||0} / ↓${d.usage.completion_tokens||0} / total: ${d.usage.total_tokens||0} tokens`
                : '';

            const r = safeObj(d.request);
            const systemText = typeof r.system_prompt === 'string' ? r.system_prompt : '';
            const historyArr = Array.isArray(r.history) ? r.history : (Array.isArray(r.messages) ? r.messages : null);
            const toolsArr   = Array.isArray(r.tools) ? r.tools : null;
            // Scalar request params (model / tool_calling / temperature / max_tokens / …).
            const paramsObj = {};
            for (const k of Object.keys(r)) {
                if (['system_prompt', 'history', 'messages', 'tools', 'url', 'headers'].includes(k)) continue;
                if (typeof r[k] === 'string' && r[k].trim() === '') continue;
                paramsObj[k] = r[k];
            }
            const responseText = unescapeNL(typeof d.response === 'string'
                ? d.response
                : (d.response ? JSON.stringify(d.response, null, 2) : (d.error || '')));

            // Build the tab set (only include tabs that have content).
            const tabs = [];
            if (Object.keys(paramsObj).length) tabs.push({ key: 'params', label: '⚙ Params', content: JSON.stringify(paramsObj, null, 2) });
            if (systemText) tabs.push({ key: 'system', label: '🧾 System', content: systemText });
            if (historyArr) tabs.push({ key: 'history', label: `💬 History (${historyArr.length})`, content: fmtMsgArray(historyArr, 'history') });
            if (toolsArr) tabs.push({ key: 'tools', label: `🛠 Tools (${toolsArr.length})`, content: JSON.stringify(toolsArr, null, 2) });
            tabs.push({ key: 'response', label: '📤 Response', content: responseText || '(empty)' });
            if (d.headers) tabs.push({ key: 'headers', label: '🔖 Headers', content: JSON.stringify(d.headers, null, 2) });

            // Default to History (the part people inspect most); fall back to first.
            const defaultIdx = Math.max(0, tabs.findIndex(t => t.key === 'history'));
            const grp = `g${i}`;

            const tabBtns = tabs.map((t, ti) =>
                `<button class="mchat-subtab${ti === defaultIdx ? ' active' : ''}" data-grp="${grp}" data-key="${t.key}">${t.label}</button>`
            ).join('');
            const tabPanels = tabs.map((t, ti) =>
                `<pre class="mchat-pre mchat-panel" data-grp="${grp}" data-key="${t.key}" style="display:${ti === defaultIdx ? 'block' : 'none'}">${escapeHtml(t.content)}</pre>`
            ).join('');

            return `
                <div class="mchat-entry">
                    <div class="mchat-entry-meta">
                        <span class="mlog-tele-method">${escapeHtml(method)}</span>
                        <span class="${isErr ? 'mlog-tele-status-err' : 'mlog-tele-status-ok'}">${d.status || (isErr ? 'ERR' : 200)}</span>
                        ${d.stepLabel ? `<span class="mchat-steplabel">${escapeHtml(d.stepLabel)}</span>` : ''}
                        ${d.duration ? `<span class="mlog-tele-dur">${d.duration}ms</span>` : ''}
                        ${usage ? `<span class="mchat-usage">${usage}</span>` : ''}
                    </div>
                    <div class="mchat-subtabs">${tabBtns}</div>
                    ${tabPanels}
                </div>
            `;
        }).join('');

        // Sub-tab switching (delegated within the modal body).
        body.querySelectorAll('.mchat-subtab').forEach(btn => {
            btn.addEventListener('click', () => {
                const grp = btn.getAttribute('data-grp');
                const key = btn.getAttribute('data-key');
                body.querySelectorAll(`.mchat-subtab[data-grp="${grp}"]`).forEach(b => b.classList.toggle('active', b === btn));
                body.querySelectorAll(`.mchat-panel[data-grp="${grp}"]`).forEach(p => {
                    p.style.display = (p.getAttribute('data-key') === key) ? 'block' : 'none';
                });
            });
        });

        overlay.classList.add('open');
    }

    // ─── init() ─────────────────────────────────────────────────────────────

    init() {
        // Setup CHAT modal overlay (once, appended to body)
        this._setupChatModal();

        // Task list clicks
        document.querySelectorAll('.mtask-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.getAttribute('data-task-id');
                if (id) window.location.hash = `#monitor?id=${id}`;
            });
        });

        // Abort button
        const abortBtn = document.getElementById('btn-abort-task');
        if (abortBtn && this.selectedTaskId) {
            abortBtn.addEventListener('click', () => {
                if (confirm('Abort this agent task?')) {
                    if (this.socket?.readyState === WebSocket.OPEN) {
                        this.socket.send(JSON.stringify({ action: 'abort' }));
                    } else if (window.apiClient) {
                        window.apiClient.abortTask(this.selectedTaskId);
                    }
                    abortBtn.disabled = true;
                    abortBtn.textContent = 'Aborting…';
                }
            });
        }

        // Console delegated events
        const consoleEl = document.getElementById('console-logs');
        if (consoleEl) {
            consoleEl.addEventListener('click', e => {
                // ① CHAT button → open modal
                const chatBtn = e.target.closest('.mstep-chat-btn');
                if (chatBtn) {
                    e.stopPropagation();
                    const uid = chatBtn.getAttribute('data-chat-uid');
                    const entries = this._chatDataMap[uid];
                    if (entries && entries.length > 0) this._showChatModal(entries);
                    return;
                }

                // ② Approve / Reject
                const btnApprove = e.target.closest('.btn-approve');
                const btnReject  = e.target.closest('.btn-reject');
                if (btnApprove) { this.sendConfirmResponse(btnApprove.getAttribute('data-confirm-id'), true); return; }
                if (btnReject)  { this.sendConfirmResponse(btnReject.getAttribute('data-confirm-id'), false); return; }

                // ③ Step header toggle (skip if CHAT button was clicked — already handled above)
                const stepHeader = e.target.closest('.mstep-header');
                if (stepHeader) {
                    const body   = stepHeader.parentElement.querySelector('.mstep-body');
                    const toggle = stepHeader.querySelector('.mstep-toggle');
                    const isOpen = stepHeader.classList.contains('expanded');
                    stepHeader.classList.toggle('expanded', !isOpen);
                    if (toggle) toggle.textContent = isOpen ? '▶' : '▼';
                    if (body) body.classList.toggle('open', !isOpen);
                    return;
                }

                // ④ Expand button (thought detail OR tool result)
                const expandBtn = e.target.closest('.mlog-expand-btn');
                if (expandBtn) {
                    const targetId = expandBtn.getAttribute('data-target');
                    const detail = document.getElementById(targetId);
                    if (detail) {
                        const isOpen = detail.classList.toggle('open');
                        expandBtn.textContent = isOpen ? '▼' : '▶';
                    }
                    return;
                }

                // ④b Thought summary text click → same as pressing ▶.
                // Lets the user click anywhere on the truncated summary line
                // (not just the tiny arrow) to expand the formatted detail panel.
                const thoughtSummary = e.target.closest('.mlog-thought-summary');
                if (thoughtSummary) {
                    const btn = thoughtSummary.querySelector('.mlog-expand-btn');
                    if (btn) {
                        const targetId = btn.getAttribute('data-target');
                        const detail = document.getElementById(targetId);
                        if (detail) {
                            const isOpen = detail.classList.toggle('open');
                            btn.textContent = isOpen ? '▼' : '▶';
                        }
                    }
                    return;
                }

                // ⑤ Tool row click (whole row toggles result)
                const toolRow = e.target.closest('.mlog-tool-row');
                if (toolRow && !e.target.closest('.mlog-expand-btn')) {
                    const uid = toolRow.getAttribute('data-uid');
                    const result = document.getElementById(`tool-result-${uid}`);
                    if (result) {
                        const isOpen = result.classList.toggle('open');
                        const btn = toolRow.querySelector('.mlog-expand-btn');
                        if (btn) btn.textContent = isOpen ? '▼' : '▶';
                    }
                    return;
                }

                // ⑥ Telemetry header toggle
                const teleHeader = e.target.closest('.mlog-tele-header');
                if (teleHeader) {
                    const body = teleHeader.nextElementSibling;
                    if (body) body.classList.toggle('open');
                    const arr = teleHeader.querySelector('span:last-child');
                    if (arr) arr.textContent = body?.classList.contains('open') ? '▼' : '▶';
                    return;
                }

                // ⑦ Telemetry tab
                const teleTab = e.target.closest('.mlog-tele-tab');
                if (teleTab) {
                    const uid  = teleTab.getAttribute('data-uid');
                    const tab  = teleTab.getAttribute('data-tab');
                    const tabsParent = teleTab.closest('.mlog-tele-tabs');
                    tabsParent.querySelectorAll('.mlog-tele-tab').forEach(t => t.classList.remove('active'));
                    teleTab.classList.add('active');
                    const content = document.getElementById(`tele-content-${uid}`);
                    if (content) {
                        content.querySelectorAll('.tele-pane').forEach(p => p.style.display = 'none');
                        const target = content.querySelector(`.tele-${tab}-${uid}`);
                        if (target) target.style.display = 'block';
                    }
                    return;
                }
            });
        }

        // Filter buttons
        const filterBtns = document.querySelectorAll('.mfilter-btn');
        const resultPanel = document.getElementById('result-panel');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                // User manually chose a tab → stop auto-jumping to Result on completion.
                this._userPickedTab = true;
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const filter = btn.getAttribute('data-filter');
                if (filter === 'result') {
                    // Show the result panel, hide the log console.
                    if (consoleEl) consoleEl.style.display = 'none';
                    if (resultPanel) {
                        resultPanel.style.display = 'block';
                        this._renderResultPanel();
                    }
                } else {
                    if (resultPanel) resultPanel.style.display = 'none';
                    if (consoleEl) {
                        consoleEl.style.display = '';
                        consoleEl.setAttribute('data-current-filter', filter);
                        this.applyFilter(consoleEl, filter);
                    }
                }
            });
        });

        if (consoleEl) {
            consoleEl.setAttribute('data-current-filter', 'all');
            this.applyFilter(consoleEl, 'all');
        }

        // Steering
        const steerBtn   = document.getElementById('btn-send-steering');
        const steerInput = document.getElementById('input-steering');
        if (steerBtn && steerInput) {
            const sendSteer = async () => {
                const msg = steerInput.value.trim();
                if (!msg) return;
                // If the task already finished, this CONTINUES it (re-runs the agent
                // under the same id). Otherwise it steers the live run.
                if (this._taskFinished) {
                    steerInput.value = '';
                    steerInput.disabled = true; steerBtn.disabled = true;
                    if (consoleEl) {
                        consoleEl.style.display = '';
                        consoleEl.insertAdjacentHTML('beforeend',
                            `<div class="mlog mlog-status"><span class="mlog-icon">↪</span><span class="mlog-body" style="color:var(--accent)"><strong>Continue:</strong> ${escapeHtml(msg)}</span></div>`);
                    }
                    try {
                        await window.apiClient.continueTask(this.selectedTaskId, msg);
                        this._taskFinished = false;
                        // Reconnect to stream the continued run (logs/results replay + accumulate).
                        this.connectWebSocket(this.selectedTaskId);
                    } catch (e) {
                        console.error('continueTask failed:', e);
                        steerInput.disabled = false; steerBtn.disabled = false;
                        alert(`続行に失敗しました: ${e.message || e}`);
                    }
                    return;
                }
                if (this.socket?.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ event: 'steering', data: { message: msg } }));
                    if (consoleEl) {
                        consoleEl.insertAdjacentHTML('beforeend',
                            `<div class="mlog mlog-status"><span class="mlog-icon">👉</span><span class="mlog-body" style="color:var(--accent)"><strong>Steered:</strong> ${escapeHtml(msg)}</span></div>`);
                        consoleEl.scrollTop = consoleEl.scrollHeight;
                    }
                    steerInput.value = '';
                }
            };
            steerBtn.addEventListener('click', sendSteer);
            steerInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendSteer(); }
            });
        }

        // Auto-connect
        if (this.selectedTaskId) {
            const task = this.tasks.find(t => t.id === this.selectedTaskId);
            if (task) {
                if (task.status === 'running') this.connectWebSocket(this.selectedTaskId);
                else this.loadHistoricalLogs(this.selectedTaskId);
            }
        }
    }

    destroy() {
        if (this.socket) { this.socket.close(); this.socket = null; }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function getHashParams() {
    const hash = window.location.hash;
    const params = {};
    if (hash.includes('?')) {
        hash.split('?')[1].split('&').forEach(part => {
            const [k, v] = part.split('=');
            params[k] = decodeURIComponent(v || '');
        });
    }
    return params;
}

function formatTime(isoStr) {
    if (!isoStr) return '';
    try { return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return ''; }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
