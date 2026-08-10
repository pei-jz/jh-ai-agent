import { openPathInDefaultApp, ensureResultViewStyles, renderMarkdown, normalizeLeakedEscapes } from '../utils/resultView.js';
import { extractNarration } from '../utils/narration.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { AGENT_MODES, DEFAULT_MODE_ID, buildBehavior } from '../../modules/ai/AgentModes.js';
import { mcpManager } from '../../modules/ai/McpManager.js';
import { ModeDropdown } from '../components/ModeDropdown.js';
import { SlashCommands } from '../components/SlashCommands.js';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';
import { icon } from '../utils/icons.js';
import llmService from '../../modules/ai/LLMService.js';
import { TaskTimeline, buildTimeline, envelopeText, splitForPanes, chapters, withExchangeFolds, exchangeCount, collapsedIds } from './monitor/taskTimeline.js';
// timelineRender.js is retired: Timeline.svelte's keyed {#each} does the keyed
// DOM reuse it hand-rolled, and timelineItems.js now exports only pure vocabulary.
import { hubApps } from './monitor/hubStrip.js';
// MIGRATED regions: Svelte components mounted into this view's markup through
// the seam in dashboard/svelte/mount.svelte.js. Their pure calculations stay in
// monitor/inspector.js and monitor/headerStats.js.
import Inspector from '../svelte/monitor/Inspector.svelte';
import TaskHeader from '../svelte/monitor/TaskHeader.svelte';
import Timeline from '../svelte/monitor/Timeline.svelte';
import TaskList from '../svelte/monitor/TaskList.svelte';
import HubStrip from '../svelte/monitor/HubStrip.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
import { contextReading } from './monitor/headerStats.js';
import { rowStatus } from './monitor/taskList.js';
import { toolTarget, toolLineText } from './monitor/toolLine.js';
import { MONITOR_STYLES } from './MonitorView.styles.js';
import { extractThoughtSummary, fmtThought, formatThoughtDetail, fmtTool, fmtFile, fmtStatus, isChatLog, fmtEfficiency, fmtReview, fmtTelemetry } from './monitorLogFormat.js';

// Short-TTL cache of the task list, shared across MonitorView instances so that
// switching the selected task (which re-routes and rebuilds the view) doesn't
// re-fetch the whole list every time. Invalidated on task creation.
let _tasksCache = null;
let _tasksCacheAt = 0;

// Per-task snapshot of the EPHEMERAL live view (request bubble + activity feed).
// A new MonitorView is built on every hash change, so navigating away from a
// RUNNING task and back would otherwise show an empty feed (and no request)
// until the next live event arrives. We snapshot #result-pending + #result-live
// on teardown and restore them on re-open. Cleared when the task finishes —
// finished tasks render their permanent result bubbles, so the in-progress
// stream is no longer needed (the in-progress detail is not needed once a run completes).
const _liveSnapshots = new Map();
const TASKS_CACHE_MS = 2500;
function invalidateTasksCache() { _tasksCache = null; _tasksCacheAt = 0; }
// Remembered task-list grouping preference ('date' | 'workspace').
let _taskGroupByPref = 'date';
// Remembered task-list filters (search text + status), folded in from History.
let _taskSearchPref = '';
let _taskStatusPref = 'all';
// Collapsed group keys (persisted across re-routes). Keys are group labels.
let _collapsedGroups = new Set();
// Group keys seen at least once — so non-first groups can be default-COLLAPSED
// on their first appearance without overriding the user's later manual toggles.
let _seenGroupKeys = new Set();

/** How many log entries the Task view fetches on open (newest first). */
const LOG_PAGE_SIZE = 400;

export class MonitorView {
    constructor() {
        this.tasks = [];
        this.selectedTaskId = null;
        this.socket = null;
        this.logs = [];
        this.currentProgress = 0;
        this.currentStatus = 'idle';
        this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        // Structured result summaries for the "Result" tab — an ARRAY so multiple
        // runs of the same task (continue-after-complete) accumulate, newest last.
        // Each item: { summary, files:[{path,action,description}] }.
        this.resultSummaries = [];
        // The Task view's single ordered model. Everything the panel shows is an
        // item in here; the DOM is a keyed projection of it.
        this._timeline = new TaskTimeline();
        // Oldest log index currently held, for the "load earlier" control.
        this._logStart = 0;
        // The inspector starts CLOSED — a permanent third column crushes the
        // reading surface on a narrow window. The choice is remembered.
        this._inspectorOpen = (() => {
            try { return localStorage.getItem('jhai_inspector_open') === '1'; } catch (_) { return false; }
        })();
        this._activeChapter = '';
        // Folding is per EXCHANGE, not per story — and the working and the result
        // fold SEPARATELY, because reading an answer while skimming its steps (or
        // the reverse) is the normal case. Empty + untouched means "derive it":
        // everything but the newest exchange folded (_collapsedExchanges).
        this._collapsedEx = new Set();     // the agent's working
        this._collapsedOut = new Set();    // what the exchange produced
        this._foldTouched = false;
        this._listCollapsed = (() => {
            try { return localStorage.getItem('jhai_list_collapsed') === '1'; } catch (_) { return false; }
        })();
        // True once the user manually picks a tab during a run — suppresses the
        // auto-switch-to-Result on completion (so it won't yank you off the logs
        // you're reading). Reset when a new run starts (open / continue).
        this._userPickedTab = false;
        this._chatDataMap = {};          // uid → chat entry[]
        this._activeStepChatEntries = []; // real-time accumulator
        this._activeStepChatUid = null;   // uid for current step's button
        // Last context-window reading ({used, limit}), or null before the first
        // LLM call. Held here rather than read back off the bar, so a tool-only
        // step keeps the previous value instead of drawing a zero.
        this._contextReading = null;
        // True once live activity has streamed for the current run. Gates the
        // "…" thinking placeholder so tab switches (which re-render #result-runs)
        // don't resurrect it mid-run.
        this._liveActivitySeen = false;
        // Task-list grouping: 'date' (default) or 'workspace'. Persisted across
        // instances via a module var so it survives re-routes.
        this._taskGroupBy = _taskGroupByPref;
        // Task-list filters (History view was folded into Monitor). Persisted in
        // module vars so they survive the re-route on task selection.
        this._taskSearch = _taskSearchPref;
        this._taskStatusFilter = _taskStatusPref;
    }

    async loadTasks() {
        try {
            if (!window.apiClient) return;
            // Short-TTL cache: every task click re-routes → new MonitorView →
            // render() → loadTasks(). Re-fetching the whole list each time was
            // the main "Monitor feels heavy" cause. Reuse a recent list (running
            // status updates still flow via the per-task WebSocket, and the cache
            // is invalidated when a task is created), so switching tasks is snappy.
            const now = Date.now();
            if (_tasksCache && (now - _tasksCacheAt) < TASKS_CACHE_MS) {
                this.tasks = _tasksCache;
                return;
            }
            this.tasks = await window.apiClient.listTasks();
            _tasksCache = this.tasks;
            _tasksCacheAt = now;
        } catch (e) { console.error('Failed to load tasks:', e); }
    }

    /** Id of the most recently started task (list order from the server is unsorted). */
    _newestTaskId() {
        let best = null;
        let bestTs = -Infinity;
        for (const t of (this.tasks || [])) {
            const ts = t.started_at ? new Date(t.started_at).getTime() : 0;
            if (ts >= bestTs) { bestTs = ts; best = t; }
        }
        return (best && best.id) || (this.tasks[0] && this.tasks[0].id) || null;
    }

    // ── Live-view persistence (request bubble + activity feed) ──────────────
    /** Save the in-progress DOM for the current RUNNING task so re-open restores it. */
    _snapshotLiveState() {
        const id = this.selectedTaskId;
        if (!id || this._taskFinished) return;
        if (!this._timeline.items.length) { _liveSnapshots.delete(id); return; }
        _liveSnapshots.set(id, this._timeline.snapshot());
    }

    /** Restore a previously-snapshotted in-progress view. Returns true if applied. */
    _restoreLiveState(taskId) {
        const snap = _liveSnapshots.get(taskId);
        if (!snap) return false;
        // DATA, not HTML. The old version restored innerHTML while code still held
        // a node reference into the replaced markup, so every later activity line
        // stopped nesting under its reasoning step.
        this._timeline.restore(snap);
        this._renderResultPanel();
        return true;
    }

    /**
     * In-place task switch (perf): tear down the previous task's live state, swap
     * ONLY the right detail panel's DOM, rebind its handlers, and connect.
     *
     * The URL hash is updated via replaceState so deep links stay correct WITHOUT
     * firing hashchange — which would rebuild the whole view (sidebar + layout +
     * the ~1,300-line <style> + the task list) on every task click.
     */
    _switchTask(taskId) {
        if (!taskId) return;
        if (taskId === this.selectedTaskId) return;
        const task = (this.tasks || []).find(t => t.id === taskId);
        const right = document.querySelector('.mpanel-right');
        if (!task || !right) {
            // List entry / panel missing (stale DOM?) — fall back to a full route.
            window.location.hash = `#monitor?id=${taskId}`;
            return;
        }

        // ── Tear down the previous task's live plumbing ──
        if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
        if (this._replayFlushTimer) { clearTimeout(this._replayFlushTimer); this._replayFlushTimer = null; }
        this._replaying = false;
        // Migrated regions belong to the OUTGOING task; a fresh mount follows.
        destroyComponent(document.getElementById('task-inspector'));
        destroyComponent(document.getElementById('task-header'));
        destroyComponent(document.getElementById('task-timeline'));

        // ── Reset ALL per-task state (mirrors a fresh view's constructor) ──
        this.selectedTaskId = taskId;
        this.logs = [];
        this.resultSummaries = [];
        this.currentProgress = 0;
        this.currentStatus = 'idle';
        this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        this._chatDataMap = {};
        this._activeStepChatEntries = [];
        this._activeStepChatUid = null;
        this._taskFinished = false;
        this._awaitingUser = false;
        this._userPickedTab = false;
        this._contextReading = null;
        this._liveActivitySeen = false;
        this._replayCutoffTs = 0;
        this._timeline.reset();
        this._foldTouched = false;
        // The Raw Log panel is rebuilt on first open, so mark it dirty rather than
        // clean.
        this._allLogsDirty = true;

        // ── Left list: move the selection highlight (a prop now) ──
        this._syncTaskList();

        // ── URL without re-route ──
        try { history.replaceState(null, '', `#monitor?id=${taskId}`); } catch (_) {}

        // ── Swap the detail panel + rebind + connect ──
        right.innerHTML = this._renderDetail(task);
        this._bindDetailEvents();
        this._autoConnect();
    }

    /**
     * Push the executions list to TaskList.svelte.
     *
     * ONE function for what used to be `_renderTaskListHtml` + `_taskItemHtml`
     * (string builders), `_bindTaskListEvents` (four querySelectorAll loops
     * re-attaching listeners after every render), and the DOM half of
     * `_syncTaskEntry`, which patched the selected row's className, status dot and
     * progress bar by hand because a live status change had no other way in.
     *
     * The filter/grouping RULES are pure functions in monitor/taskList.js.
     */
    _syncTaskList() {
        const el = document.getElementById('mtask-list');
        if (!el) return;
        this._taskListCmp = mountComponent(TaskList, el, {
            tasks: this.tasks || [],
            selectedId: this.selectedTaskId,
            search: this._taskSearch || '',
            statusFilter: this._taskStatusFilter || 'all',
            groupBy: this._taskGroupBy || 'date',
            // Module-level sets: the collapse memory has to outlive this view
            // instance, or every task click would re-fold the groups.
            seenKeys: _seenGroupKeys,
            collapsedKeys: _collapsedGroups,
            onSelect: (id) => this._switchTask(id),
            onDelete: (id) => this._deleteTaskFromList(id),
            onNewTask: (ws) => this._openNewTaskModal(ws || null),
            onSearch: (q) => { this._taskSearch = q; _taskSearchPref = q; this._syncTaskList(); },
            onStatusFilter: (s) => { this._taskStatusFilter = s; _taskStatusPref = s; this._syncTaskList(); },
            onGroupBy: (g) => { this._taskGroupBy = g; _taskGroupByPref = g; this._syncTaskList(); },
        });
    }

    /** Delete a task straight from the list, without opening it first. */
    async _deleteTaskFromList(id) {
        if (!id) return;
        if (!confirm('Delete this task from history? This cannot be undone.')) return;
        try {
            await window.apiClient.deleteTaskHistory(id);
            invalidateTasksCache();
            if (this.selectedTaskId === id) this.selectedTaskId = null;
            this.tasks = (this.tasks || []).filter(t => t.id !== id);
            this._syncTaskList();
            // If the open task was the one deleted, clear the detail pane.
            if (!this.selectedTaskId) window.location.hash = '#monitor';
        } catch (err) {
            alert('Failed to delete: ' + (err.message || err));
        }
    }

    async render() {
        await this.loadTasks();

        const urlParams = getHashParams();
        if (urlParams.id && this.tasks.some(t => t.id === urlParams.id)) {
            this.selectedTaskId = urlParams.id;
        } else if (this.tasks.length > 0 && !this.selectedTaskId) {
            // Default to the MOST RECENT task. list_tasks returns HashMap order
            // (unsorted), so tasks[0] is arbitrary — pick the newest by start time.
            this.selectedTaskId = this._newestTaskId();
        }

        let rightHtml = '';
        if (this.selectedTaskId) {
            const task = this.tasks.find(t => t.id === this.selectedTaskId);
            rightHtml = this._renderDetail(task);
        } else {
            rightHtml = `<div class="mdetail-empty"><span class="mdetail-empty-icon">📊</span><h3>Select a task</h3><p>Choose an agent task from the left panel.</p></div>`;
        }

        return `
            <style>${MONITOR_STYLES}</style>

            <div class="monitor-layout">
                <!-- Left panel. MIGRATED: the filters, grouping toggle and the list
                     itself are TaskList.svelte, mounted by _syncTaskList(). Only the
                     header row (with the New button) is still markup here — it moves
                     with the shell. -->
                <div class="mpanel-left">
                    <div class="mpanel-left-header">
                        <span>Executions <span style="font-weight:400;opacity:0.6">${this.tasks.length}</span></span>
                        <button id="btn-new-task" class="btn btn-primary" style="height:24px;padding:0 8px;font-size:11px;font-weight:600;" title="Create a new task">${icon('plus', 12)} New</button>
                    </div>
                    <div id="mtask-list"></div>
                </div>

                <!-- Right panel — the task's story. -->
                <div class="mpanel-right">
                    ${rightHtml}
                </div>

                <!-- Inspector: its OWN column, a sibling of the story rather than
                     a child of it. Nested inside the scrolling panel it moved with
                     the content, which defeats the point of a reference column. -->
                <aside id="task-inspector" class="mtl-insp" style="display:none"></aside>
            </div>
        `;
    }

    _renderDetail(task) {
        if (!task) return '<div class="mdetail-empty"><span class="mdetail-empty-icon">📊</span><h3>Task not found</h3></div>';

        return `
            <!-- MIGRATED: the header and its context gauge are TaskHeader.svelte,
                 mounted here by _syncHeader(). They used to be a template string
                 whose every live field was then written by id from four different
                 places in this file — the pattern that produced today's
                 dead-element bugs. (#val-status went with it: a hidden span that
                 nothing ever read.) -->
            <div id="task-header"></div>
            <div class="mfilter-bar">
                <!-- "Story" is the narrative timeline; "Raw Log" is the unedited
                     telemetry. The old names (Task / All Logs) said where the
                     data came from, not what you get. -->
                <button class="mfilter-btn active" data-filter="result">${icon('report', 13)} Story</button>
                <button class="mfilter-btn" data-filter="all">${icon('code', 13)} Raw Log</button>
                <!-- One control for every exchange at once. Per-exchange folding
                     is the marker beside each request; this is the "show me the
                     shape of the whole task" shortcut. -->
                <button class="mfold-all" id="btn-fold-all" style="display:none">⊟ Collapse all</button>
                <button class="mpanel-toggle mfilter-spacer" id="btn-toggle-list" title="Show or hide the task list">◧</button>
                <button class="mpanel-toggle" id="btn-inspector" title="Task details, token flow and chapter jumps">◨</button>
            </div>
            <!-- EMPTY on purpose. Raw Log is built the first time it is opened
                 (see the filter-tab handler): rendering every log line into HTML
                 for a hidden panel was pure cost on a long task, and the lazy
                 path already existed everywhere except here. -->
            <div class="mconsole" id="console-logs" data-current-filter="all" style="display:none"></div>
            <!-- Task view = ONE chat-like scroll: completed run bubbles (#result-runs)
                 followed by the live activity feed (#result-live). Both scroll
                 together so the live progress flows naturally under the content
                 instead of being a fixed strip pinned at the top. -->
            <!-- ONE ordered stream (monitor/taskTimeline.js) instead of the eight
                 separate slots this used to be. Requests, reasoning groups, the
                 deliverable, narration, the ask_user question WITH its choices and
                 completed exchanges are all items in the same list, rendered by a
                 keyed diff so a new line touches one node instead of rebuilding
                 the panel. -->
            <div class="mconsole mresult" id="result-panel">
                <!-- The changed-file list used to be pinned here as well as in the
                     inspector. Two copies of the same thing, and this one ate the
                     top of the reading surface on every task that touched a file —
                     so the inspector's tree is now the only one. -->
                <!-- B: the connected apps and what they offer. This is the surface a
                     terminal-scoped agent cannot have, and it used to be invisible. -->
                <div id="hub-strip" class="hub-strip" style="display:none"></div>
                <!-- Paging control: only the newest slice of a long task's logs is
                     fetched on open (see loadHistoricalLogs). -->
                <div id="result-earlier" class="mresult-earlier" style="display:none">
                    <button class="btn btn-sm" id="btn-load-earlier">↑ Load earlier</button>
                    <div id="result-earlier-note" class="mresult-earlier-note"></div>
                </div>
                <!-- Reading surface + inspector.
                     The TIMELINE keeps its full width — splitting the content
                     itself was tried and reverted (with one run the conversation
                     column stood empty; with two it set two reports side by
                     side). The inspector holds only what you look UP: ids, token
                     flow, changed files, chapter jumps. It starts CLOSED, because
                     a permanent third column crushes the reading surface on a
                     narrow window. -->
                <div id="task-pending-ask" style="display:none"></div>
                <div id="task-timeline" class="mtl"></div>
                ${status !== 'running'
                    ? `<div id="result-loading" class="mload"><span class="mload-spin"></span>Loading results…</div>`
                    : ''}
                <div id="result-live-label" class="mresult-live-label" style="display:none" title="Toggle the activity log">
                    <span class="mll-dot"></span>
                    <span class="mll-text"> ⏳ Working…</span>
                    <span class="mll-chev">▼</span>
                </div>
            </div>
            <!-- C: floating "jump to newest" pill — shown whenever the reader has
                 scrolled up, not only when new activity arrives. -->
            <button id="result-jump" class="mresult-jump" style="display:none">↓ Jump to latest</button>
            <div class="msteering-wrapper">
                <div class="msteering-top">
                    <div id="steer-input-skills" class="msteering-skills chat-input-skills" style="display: none;"></div>
                    <div id="steer-input-previews" class="msteering-previews" style="display: none;"></div>
                </div>
                <div class="msteering-input-row">
                    <button type="button" class="steer-btn-icon steer-attach-btn" id="steer-btn-attach" title="Attach file or image" disabled>📎</button>
                    <input type="file" id="steer-file-input" multiple style="display: none;">
                    <textarea id="input-steering" placeholder="Steer the agent... (Ctrl+Enter to send, / for skills)" disabled rows="1"></textarea>
                    <button class="btn btn-primary btn-sm" id="btn-send-steering" disabled>Send</button>
                    <!-- A: stop the running task from the bottom, where the work is. -->
                    <button class="btn btn-error btn-sm" id="btn-stop-steering" style="display:none" title="Stop the running task">⏹ Stop</button>
                </div>
                <div id="steer-slash-popup" class="slash-popup" style="bottom: 100%; top: auto; max-height: 200px; z-index: 1000; margin-bottom: 4px; left: 10px; right: 10px;">
                    <div class="slash-popup-list" id="steer-slash-list"></div>
                </div>
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
                const totalCached     = stepChatEntries.reduce((s, c) => s + (c.usage?.cache_read_input_tokens || 0), 0);
                const totalDur        = stepChatEntries.reduce((s, c) => s + (c.duration || 0), 0);
                const lastEntry = stepChatEntries[stepChatEntries.length - 1];
                const statusCode = lastEntry.status || 200;
                const isErr = statusCode >= 400 || lastEntry.error;
                const cachedTxt = totalCached > 0 ? ` ⚡${totalCached}t` : '';
                chatBtnHtml = `<button class="mstep-chat-btn${isErr ? ' err' : ''}" data-chat-uid="${chatUid}">CHAT ${statusCode} · ↑${totalPrompt}t${cachedTxt} ↓${totalCompletion}t · ${totalDur}ms</button>`;
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
        // Request/turn boundaries: each run's step counter restarts at 1, so a
        // step number that is <= the previous one marks a NEW request. We drop a
        // labelled divider there (and before the very first request) so a
        // multi-turn task doesn't read as one undifferentiated wall of steps.
        let lastStepNum = null;
        let requestNum = 0;
        const requestDivider = () => {
            requestNum++;
            const req = this.resultSummaries?.[requestNum - 1]?.request;
            const preview = req ? ' — ' + escapeHtml(String(req).replace(/\s+/g, ' ').slice(0, 60)) : '';
            return `<div class="mturn-divider mturn-request"><span>▼ Request ${requestNum}${preview}</span></div>`;
        };

        for (const log of this.logs) {
            // Skip noise events
            if (SKIP_EVENTS.has(log.event)) continue;

            // Step boundary marker
            if (log.event === 'status' && log.data.message?.startsWith('Thinking... (step ')) {
                flushStep();
                const m = log.data.message.match(/\(step (\d+)\)/);
                stepId = m ? parseInt(m[1]) : stepCount + 1;
                // New request when the step counter restarts (num <= previous) or
                // this is the first step overall.
                if (lastStepNum === null || stepId <= lastStepNum) {
                    html += requestDivider();
                }
                lastStepNum = stepId;
                stepCount++;
                stepTime = log.timestamp ? formatTime(log.timestamp) : '';
                continue;
            }

            // CHAT API call → collect for button (not inline). METRICS/REVIEW are
            // NOT chat — they render inline as their own cards (below).
            if (log.event === 'log' && isChatLog(log.data)) {
                if (stepId !== null) {
                    stepChatEntries.push(log.data);
                    continue; // skip inline rendering
                }
                continue;
            }

            // Thought → extract summary
            if (log.event === 'thought' && stepId !== null) {
                const raw = typeof log.data.text === 'string' ? log.data.text : JSON.stringify(log.data.text);
                stepSummary = extractThoughtSummary(raw);
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
            // Live stdout/stderr stream — the backend emits ONE event per output
            // line, so a broad command (e.g. Get-ChildItem -Recurse) fires
            // thousands. Don't render them individually (that floods All Logs and
            // bloats the DOM). The command + its full output is already shown once
            // via the tool telemetry (`log`/TOOL → "Ran Command" + result pre),
            // and `command_run` duplicates that, so skip both here.
            case 'command_chunk':   return '';
            case 'command_run':     return '';
            // UI-SIGNAL events (onToolEvent): these exist to drive the app/UI —
            // the editor opening a file, the Task view's live cards, etc. They are
            // NOT log entries: every one of them duplicates a tool_call line that
            // already renders above plus the TOOL telemetry below. Without these
            // cases they fell through to `default:` and dumped raw JSON like
            // {"_idx":609,"matchCount":10,"pattern":"…"} into All Logs.
            case 'grep_search':
            case 'task_progress':
            case 'open_file':
            case 'artifact_modified':
            case 'ask_user':
            case 'result':          return '';
            case 'thought':         return fmtThought(log);
            case 'tool_call':       return fmtTool(log);
            case 'file_modified':   return fmtFile(log);
            case 'status':          return fmtStatus(log);
            case 'complete':        return `<div class="mlog mlog-success log-success"><span class="mlog-icon">✅</span><span class="mlog-body"><strong>Complete:</strong> ${escapeHtml(normalizeLeakedEscapes(log.data.message || ''))}</span></div>`;
            case 'finish_task':     return `<div class="mlog mlog-success log-success"><span class="mlog-icon">🏁</span><span class="mlog-body"><strong>Finished:</strong> ${escapeHtml(normalizeLeakedEscapes(log.data.summary || ''))}</span></div>`;
            case 'error':           return `<div class="mlog mlog-error log-error"><span class="mlog-icon">❌</span><span class="mlog-body"><strong>Error:</strong> ${escapeHtml(log.data.error || '')}</span></div>`;
            case 'log':
                // TOOL telemetry stays inline; CHAT is handled as step header button
                if (log.data?.method === 'TOOL') return fmtTelemetry(log.data);
                if (log.data?.method === 'METRICS') return fmtEfficiency(log.data);
                if (log.data?.method === 'REVIEW') return fmtReview(log.data);
                return ''; // CHAT handled by renderAllLogs / connectWebSocket
            case 'confirm_request': return this._fmtConfirm(log.data);
            default:                return `<div class="mlog mlog-status log-status"><span class="mlog-icon" style="opacity:0.5">·</span><span class="mlog-body">${escapeHtml(JSON.stringify(log.data).slice(0,120))}</span></div>`;
        }
    }

    _fmtConfirm(data, idPrefix = 'confirm') {
        const cid = data.confirmId;
        let inner = '';
        let alwaysBtn = '';
        let autoWs = '';
        if (data.type === 'command_confirm') {
            const dangerous = data.risk === 'dangerous';
            const riskBadge = dangerous
                ? `<span class="mconfirm-risk">⚠️ Dangerous command</span>`
                : '';
            inner = `<h4>🛡 Command Approval ${riskBadge}</h4><p>${escapeHtml(data.message || '')}</p><pre><code>${escapeHtml(data.command || '')}</code></pre>`;
            // "Always allow" recurs for normal commands; dangerous can never be
            // whitelisted (allowAlways is false for them from the handler).
            if (data.allowAlways) {
                alwaysBtn = `<button class="btn btn-secondary btn-approve-always" data-confirm-id="${cid}" title="Approve now and auto-allow this command pattern in future">✓ Always allow</button>`;
            }
            // D: per-workspace auto-approve toggle (normal commands only; dangerous
            // always confirm). Reads/writes localStorage; the executor honors it
            // live for the next command.
            const ws = this.tasks?.find(t => t.id === this.selectedTaskId)?.workspace_path || '';
            if (!dangerous && ws) {
                const on = this._isWsAutoApprove(ws);
                autoWs = `<label class="mconfirm-autows"><input type="checkbox" class="cb-autows" data-ws="${escapeHtml(ws)}" ${on ? 'checked' : ''}> Auto-approve commands in this workspace from now on (dangerous ones are always confirmed)</label>`;
            }
            autoWs += `<div class="mconfirm-manage"><a class="acm-open" title="Manage approved commands">🛡 Manage allowlist</a></div>`;
        } else if (data.type === 'diff_review') {
            inner = `<h4>📝 File Modification</h4><p><code>${escapeHtml(data.path || '')}</code></p><p>${escapeHtml(data.message || '')}</p>${this.renderSimpleDiff(data.oldContent || '', data.newContent || '')}`;
        }
        return `
            <div class="mconfirm-box log-confirm-request" id="${idPrefix}-${cid}" data-confirm-card="${cid}">
                ${inner}
                ${autoWs}
                <div class="mconfirm-actions">
                    <button class="btn btn-success btn-approve" data-confirm-id="${cid}">Approve</button>
                    ${alwaysBtn}
                    <button class="btn btn-error btn-reject" data-confirm-id="${cid}">Reject</button>
                </div>
            </div>
        `;
    }

    /** localStorage-backed per-workspace "auto-approve commands" set (shared with
     *  ToolExecutor._isAutoApproveWorkspace, which reads it live). */
    _isWsAutoApprove(ws) {
        const norm = String(ws).replace(/\\/g, '/').replace(/\/+$/, '');
        try {
            const arr = JSON.parse(localStorage.getItem('jhai_autoapprove_workspaces') || '[]');
            return Array.isArray(arr) && arr.some(p => String(p).replace(/\\/g, '/').replace(/\/+$/, '') === norm);
        } catch (_) { return false; }
    }

    _setWsAutoApprove(ws, on) {
        const norm = String(ws).replace(/\\/g, '/').replace(/\/+$/, '');
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem('jhai_autoapprove_workspaces') || '[]'); } catch (_) {}
        if (!Array.isArray(arr)) arr = [];
        arr = arr.filter(p => String(p).replace(/\\/g, '/').replace(/\/+$/, '') !== norm);
        if (on) arr.push(ws);
        try { localStorage.setItem('jhai_autoapprove_workspaces', JSON.stringify(arr)); } catch (_) {}
    }

    /** Manage the command-approval whitelist: view + remove "always allow"
     *  patterns and auto-approve workspaces. */
    _showApprovedCommandsModal() {
        const read = (k) => { try { const a = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4200;display:flex;align-items:center;justify-content:center;padding:24px;';
        const render = () => {
            const pats = read('jhai_approved_commands');
            const wss = read('jhai_autoapprove_workspaces');
            const rowP = pats.length ? pats.map(p => `<div class="acm-row"><code>${escapeHtml(p)}</code><button class="acm-del" data-k="jhai_approved_commands" data-val="${escapeHtml(p)}" title="Remove">✕</button></div>`).join('') : '<div class="acm-empty">(none)</div>';
            const rowW = wss.length ? wss.map(w => `<div class="acm-row"><code>${escapeHtml(w)}</code><button class="acm-del" data-k="jhai_autoapprove_workspaces" data-val="${escapeHtml(w)}" title="Remove">✕</button></div>`).join('') : '<div class="acm-empty">(none)</div>';
            overlay.innerHTML = `
                <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;width:560px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.5);">
                    <div style="padding:14px 18px;border-bottom:1px solid var(--border);background:var(--bg-tertiary);display:flex;justify-content:space-between;align-items:center;">
                        <strong style="font-size:14px;">🛡 Command approval allowlist</strong>
                        <button class="acm-close" style="background:none;border:none;color:var(--text-primary);cursor:pointer;font-size:18px;">✖</button>
                    </div>
                    <div style="padding:16px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:16px;">
                        <div>
                            <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">Always-allow patterns (<code>*</code> = prefix match)</div>
                            <div style="display:flex;flex-direction:column;gap:4px;">${rowP}</div>
                        </div>
                        <div>
                            <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">Auto-approved workspaces (dangerous commands are always confirmed)</div>
                            <div style="display:flex;flex-direction:column;gap:4px;">${rowW}</div>
                        </div>
                        <div style="font-size:11px;color:var(--text-tertiary);">Dangerous commands (rm / Remove-Item / git reset --hard / push --force …) are always confirmed, whatever is on these lists.</div>
                    </div>
                </div>`;
        };
        render();
        const close = () => { try { document.body.removeChild(overlay); } catch (_) {} };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.acm-close')) { close(); return; }
            const del = e.target.closest('.acm-del');
            if (del) {
                const k = del.getAttribute('data-k'); const val = del.getAttribute('data-val');
                let arr = read(k).filter(x => x !== val);
                try { localStorage.setItem(k, JSON.stringify(arr)); } catch (_) {}
                render();
            }
        });
        document.body.appendChild(overlay);
    }

    /** Show the pending approval in the Task view too (mirrors the All Logs card),
     *  so the user can approve without switching to All Logs. */
    _showTaskConfirm(data) {
        if (!data?.confirmId) return;
        this._confirmId = String(data.confirmId);
        this._timeline.pushConfirm(this._fmtConfirm(data, 'confirm-task'), { confirmId: this._confirmId });
        this._renderResultPanel();
    }

    _clearTaskConfirm() {
        this._confirmId = null;
        if (this._timeline.resolveConfirm()) this._renderResultPanel();
    }

    /**
     * ask_user interactive answer card — clickable choices instead of a plain
     * "type your answer" box. Single-select → one click sends that option.
     * Multi-select → checkboxes + a submit button. Free-text via the steer box
     * still works as a fallback.
     */
    _showAskCard(data) {
        // The question and its choices are ONE timeline item, so they can never
        // be shown in two places (or, for a free-text question, nowhere at all —
        // which is what happened when the card required options and the feed
        // carrying the question had just been collapsed).
        this._timeline.pushAsk({
            text: data?.message,
            options: data?.options,
            multi: !!data?.multiSelect,
        });
        this._renderResultPanel();
    }

    _clearAskCard() {
        if (this._timeline.resolveAsk(this._lastAnswerText || '')) this._renderResultPanel();
    }

    // ─── WebSocket ──────────────────────────────────────────────────────────

    /**
     * One-shot render of the buffered replay backlog (perf: replaces per-event
     * DOM insertion + forced layout, which was O(n²) on long tasks). Rebuilds
     * everything the per-event path used to maintain incrementally:
     * token totals + context gauge, result bubbles, All Logs DOM (lazily unless
     * that tab is showing), status badge, and trailing interactive state
     * (pending ask_user question / approval card).
     */
    _flushReplay() {
        if (!this._replaying) return;
        this._replaying = false;
        if (this._replayFlushTimer) { clearTimeout(this._replayFlushTimer); this._replayFlushTimer = null; }
        if (this._destroyed) return;

        // ── Token totals + context gauge from the replayed usage events ──
        this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        let lastUsage = null;
        for (const l of this.logs) {
            if (l.event !== 'token_usage') continue;
            const d = l.data || {};
            const cr = d.cache_read_input_tokens || 0;
            const cc = d.cache_creation_input_tokens || 0;
            this.tokenUsage.prompt_tokens     += d.prompt_tokens || 0;
            this.tokenUsage.completion_tokens += d.completion_tokens || 0;
            this.tokenUsage.total_tokens      += (d.total_tokens || ((d.prompt_tokens || 0) + (d.completion_tokens || 0) + cr + cc));
            this.tokenUsage.cache_read_input_tokens     += cr;
            this.tokenUsage.cache_creation_input_tokens += cc;
            lastUsage = d;
        }
        this._syncHeader();
        if (lastUsage) this._updateContextGauge(lastUsage);

        // ── Result bubbles from the replayed complete events ──
        this._rebuildResultSummaries();
        this._renderResultPanel();
        requestAnimationFrame(() => {
            if (this._destroyed) return;
            const rp = document.getElementById('result-panel');
            if (rp) rp.scrollTop = rp.scrollHeight;
        });

        // ── All Logs DOM: build ONCE now only if that tab is visible ──
        const consoleEl = document.getElementById('console-logs');
        if (consoleEl) {
            const allLogsActive = !!document.querySelector('.mfilter-btn[data-filter="all"].active');
            if (allLogsActive) {
                consoleEl.innerHTML = this.renderAllLogs();
                this._allLogsDirty = false;
                consoleEl.scrollTop = consoleEl.scrollHeight;
            } else {
                this._allLogsDirty = true;   // built lazily on first tab switch
            }
        }

        // ── Status + trailing interactive state ──
        let status = 'running';
        for (const l of this.logs) {
            if (l.event === 'status' && l.data?.status) status = l.data.status;
            else if (l.event === 'complete') status = 'completed';
            else if (l.event === 'error' && l.data?.terminal) status = 'failed';
        }
        this.currentStatus = status;
        this._syncStatusBadge();
        this._syncTaskEntry(status);

        // (The first-run request is already shown by _renderResultsHtml's
        // "0 runs → show the request" bubble in #result-runs; adding it to
        // #result-pending too duplicated it — the reported double-bubble.)

        // Task finished DURING the replay (raced between getTask and connect):
        // keep the steer box usable for a continue instead of letting the
        // imminent socket close disable it.
        if (status === 'completed' || status === 'failed' || status === 'aborted') {
            this._taskFinished = true;
            _liveSnapshots.delete(this.selectedTaskId);   // finished → drop in-progress snapshot
            // Finished during replay: the completed run bubbles in #result-runs
            // now represent the exchange, so drop any restored in-flight request
            // bubble (else it duplicates the run's request).
            if (this.resultSummaries.length > 0) this._clearPendingUser();
            const si = document.getElementById('input-steering');
            const sb = document.getElementById('btn-send-steering');
            if (si) {
                si.disabled = false;
                si.placeholder = status === 'completed'
                    ? '✓ Done. Add a message to continue the task (Ctrl+Enter, / for skills)'
                    : '⚠ Stopped. Add a message to continue / retry (Ctrl+Enter, / for skills)';
            }
            if (sb) sb.disabled = false;
        }

        if (status === 'waiting') {
            // Run is paused on an ask_user question — re-surface it.
            const q = [...this.logs].reverse().find(l => l.event === 'status' && l.data?.status === 'waiting');
            if (q) {
                this._awaitingUser = true;
                this._setResultLive(q.data.message || 'The agent is asking for your input — reply below to continue.', 'question');
                this._showAskCard(q.data);
                const si = document.getElementById('input-steering');
                if (si) {
                    si.disabled = false;
                    si.placeholder = '❓ Answer the agent\'s question to continue (Ctrl+Enter)…';
                }
                const sb = document.getElementById('btn-send-steering');
                if (sb) sb.disabled = false;
            }
        } else if (status === 'running') {
            // A confirm_request with NO later activity is genuinely pending —
            // re-surface the approval card. (One followed by further tool/log
            // events was already answered; don't show a stale card.)
            let lastConfirm = -1;
            this.logs.forEach((l, i) => { if (l.event === 'confirm_request') lastConfirm = i; });
            if (lastConfirm >= 0) {
                const after = this.logs.slice(lastConfirm + 1);
                const answered = after.some(l => l.event === 'tool_call' || l.event === 'log' || l.event === 'complete');
                if (!answered) this._showTaskConfirm(this.logs[lastConfirm].data);
            }
        }
    }

    connectWebSocket(taskId, preserveResults = false) {
        if (this.socket) this.socket.close();
        // The server REPLAYS all stored logs on connect, then live events. On a
        // CONTINUE we already have that history rendered, so DISCARD replayed
        // events by TIMESTAMP: the continue path stamps `_replayCutoffTs` just
        // before kicking off the new run, so every old (already-rendered) event
        // is < cutoff and the new run's events are >= cutoff. Time-based, so it's
        // robust regardless of event types/counts and needs no server marker —
        // it stops the replayed previous-run `complete` from wiping the just-sent
        // message / switching tabs, WITHOUT dropping the new run's live events
        // (the "in-progress request missing from All Logs" bug).
        if (!preserveResults) this._replayCutoffTs = 0;

        // On a CONTINUE, the reconnect re-plays the whole prior task (which we
        // already have rendered). DISCARD that backlog until the server's
        // `replay_done` marker, then process the new run LIVE. This is
        // deterministic — unlike the timestamp cutoff it can't be defeated by
        // client/server clock differences or by `to_rfc3339()`'s nanosecond
        // precision confusing `new Date()`, which could drop the new run's early
        // events (the "approved but nothing happens" bug). A 4s safety timer clears it in case
        // an old backend never sends the marker.
        this._discardUntilReplayDone = !!preserveResults;
        clearTimeout(this._discardReplayTimer);
        if (preserveResults) {
            this._discardReplayTimer = setTimeout(() => { this._discardUntilReplayDone = false; }, 4000);
        }
        // A new run is streaming → re-expand the activity feed (it auto-folds when
        // the previous run paused on ask_user).
        this._setFeedCollapsed(false);
        this._feedGroupBody = null;   // start a fresh reasoning-group chain

        // Re-opening a RUNNING task: restore the request bubble + activity feed we
        // snapshotted on teardown, so it isn't blank until the next live event.
        // (Only on a FRESH connect — a continue keeps the existing DOM already.)
        if (!preserveResults) this._restoreLiveState(taskId);

        this.currentProgress = 0;
        this.currentStatus = 'running';
        // Token totals are the TASK's whole-life cumulative (the server also
        // accumulates task.token_usage across continues). On a CONTINUE
        // (preserveResults) we must NOT zero them — the replay of old events is
        // discarded by the timestamp cutoff, so zeroing here made the header
        // "restart" the count at every continue. If this view never saw the
        // earlier runs live (task was opened as historical), seed from the
        // server's cumulative totals instead.
        if (!preserveResults) {
            this.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        } else if (!this.tokenUsage.total_tokens) {
            const t = (this.tasks || []).find(t => t.id === taskId);
            if (t?.token_usage) {
                this.tokenUsage = {
                    prompt_tokens: t.token_usage.prompt_tokens || 0,
                    completion_tokens: t.token_usage.completion_tokens || 0,
                    total_tokens: t.token_usage.total_tokens || 0,
                    cache_read_input_tokens: t.token_usage.cache_read_input_tokens || 0,
                    cache_creation_input_tokens: t.token_usage.cache_creation_input_tokens || 0,
                };
            }
        }
        // On a CONTINUE (reconnect after finishing), keep the accumulated run
        // bubbles AND logs so the conversation + All Logs stay intact. A fresh
        // task selection rebuilds from the replay.
        if (!preserveResults) { this.logs = []; this.resultSummaries = []; this._seenCompleteKeys = new Set(); }
        this._taskFinished = false;
        // New run (fresh view or continue): no live activity seen yet — the
        // thinking placeholder may show until the first feed line arrives.
        this._liveActivitySeen = false;
        // ── Replay batching (perf) ─────────────────────────────────────
        // On a FRESH connect the server replays every stored event first.
        // Processing them one-by-one did per-event DOM insertion + forced
        // layout (O(n²)) — the "selecting a running task is slow" cost. So
        // buffer the burst into this.logs only, then render ONCE on the
        // server's replay_done marker (debounce fallback for old backends).
        // A CONTINUE keeps the existing DOM (cutoff discards the replay), so
        // no batching there.
        this._replaying = !preserveResults;
        if (this._replayFlushTimer) { clearTimeout(this._replayFlushTimer); this._replayFlushTimer = null; }
        // Fresh run streaming → show the ⏹ stop button, hide any stale "new
        // activity" pill (we'll auto-follow again from here).
        this._syncStopButton();
        const jumpEl = document.getElementById('result-jump');
        if (jumpEl) jumpEl.style.display = 'none';
        this._awaitingUser = false;
        this._userPickedTab = false;
        this._activeStepChatEntries = [];
        this._activeStepChatUid = null;
        if (!window.apiClient) return;

        const wsUrl = `ws://localhost:${window.apiClient.port}/ws/tasks/${taskId}?token=${window.apiClient.token}`;
        this.socket = new WebSocket(wsUrl);

        const disableSteering = () => {
            const si = document.getElementById('input-steering');
            const sb = document.getElementById('btn-send-steering');
            const sba = document.getElementById('steer-btn-attach');
            const sbs = document.getElementById('steer-btn-skills');
            if (si) si.disabled = true;
            if (sb) sb.disabled = true;
            if (sba) sba.disabled = true;
            if (sbs) sbs.disabled = true;
        };

        this.socket.onopen = () => {
            // Stale socket opening after navigation OR an in-place task switch
            // (same instance, different selectedTaskId) must not touch the DOM.
            if (this._destroyed || this.selectedTaskId !== taskId) return;
            // Fresh connect rebuilds All Logs from the server replay → start clean.
            // On a CONTINUE the replay is discarded (timestamp cutoff) and the
            // existing step DOM must be KEPT — wiping it here erased all previous
            // steps from All Logs until a manual re-render.
            if (!preserveResults) {
                const consoleEl = document.getElementById('console-logs');
                if (consoleEl) consoleEl.innerHTML = '';
            }
            const si = document.getElementById('input-steering');
            const sb = document.getElementById('btn-send-steering');
            const sba = document.getElementById('steer-btn-attach');
            const sbs = document.getElementById('steer-btn-skills');
            if (si) si.disabled = false;
            if (sb) sb.disabled = false;
            if (sba) sba.disabled = false;
            if (sbs) sbs.disabled = false;
        };

        this.socket.onmessage = (ev) => {
            try {
                // A destroyed (navigated-away) instance must never touch the DOM —
                // the ids now belong to a NEWER MonitorView showing another task.
                // Same for a stale socket after an in-place task switch: close()
                // was called, but already-received messages can still fire here.
                if (this._destroyed || this.selectedTaskId !== taskId) return;
                const packet = JSON.parse(ev.data);
                if (!packet) return;
                packet.data = packet.data || {};

                // Replay-boundary marker → flush the buffered backlog (fresh
                // connect) / end the continue's discard window.
                if (packet.event === 'replay_done') {
                    if (this._replaying) this._flushReplay();
                    if (this._discardUntilReplayDone) {
                        this._discardUntilReplayDone = false;
                        clearTimeout(this._discardReplayTimer);
                    }
                    return;
                }
                // On a CONTINUE: drop the replayed backlog (already rendered) until
                // the marker above; everything after is the NEW run, processed live.
                if (this._discardUntilReplayDone) return;
                // Fallback for a backend without the marker: timestamp cutoff.
                if (this._replayCutoffTs && packet.timestamp &&
                    new Date(packet.timestamp).getTime() < this._replayCutoffTs) {
                    return;
                }

                // ── Live token stream → narration ───────────────────────────
                // Handled here and RETURNED: 'stream' fires per token, so it must
                // never reach this.logs (the server doesn't persist it either) or
                // the All Logs renderer. Skipped during replay (a replayed backlog
                // has no stream events, but be explicit).
                if (packet.event === 'stream') {
                    if (!this._replaying) this._appendNarration(packet.data?.chunk || '');
                    return;
                }

                // ── Replay buffering (fresh connect) ────────────────────────
                // Accumulate into this.logs only; ALL rendering is deferred to
                // _flushReplay (triggered by replay_done, or the debounce for
                // backends without the marker). Live events arriving during the
                // burst are flushed with it — ordering is preserved.
                if (this._replaying) {
                    if (packet.event !== 'command_chunk' && packet.event !== 'confirm_resolved') {
                        this.logs.push(packet);
                    }
                    clearTimeout(this._replayFlushTimer);
                    this._replayFlushTimer = setTimeout(() => {
                        if (!this._destroyed) this._flushReplay();
                    }, 250);
                    return;
                }

                // Any non-terminal event means a run is actively streaming → the
                // steer box is in "steer" (not "continue") mode.
                if (packet.event && packet.event !== 'complete' && packet.event !== 'error') {
                    this._taskFinished = false;
                }
                // Clear the ask_user "waiting" state ONLY when a NEW run is actually
                // progressing (a thought / tool_call / running-status). Do NOT clear
                // it on token_usage/log events — those fire while the result summary
                // is built AFTER ask_user, and clearing here made the trailing
                // `complete` wipe the question (the "the question is invisible" bug). The
                // 'waiting' status handler re-sets it below in this same handler.
                if (packet.event === 'thought' || packet.event === 'tool_call'
                    || (packet.event === 'status' && packet.data?.status === 'running')) {
                    this._awaitingUser = false;
                }

                // ── Approval was resolved (possibly by another connected client) ──
                // Handle BEFORE pushing to this.logs so it isn't replayed on view reload.
                if (packet.event === 'confirm_resolved') {
                    const { confirmId, approved } = packet.data || {};
                    if (confirmId) this._markConfirmResolved(confirmId, approved, /*byOther*/ true);
                    return;
                }

                // High-volume live stdout chunks are not rendered and not needed for
                // replay — drop them so a broad command doesn't bloat this.logs with
                // thousands of entries (slowing renderAllLogs and memory).
                if (packet.event === 'command_chunk') return;

                this.logs.push(packet);

                // Task-view approval card — handled at TOP level, independent of
                // the All Logs DOM (the `if (!consoleEl) return` below used to
                // silently drop it, so the card sometimes never appeared until a
                // re-visit replayed the event).
                if (packet.event === 'confirm_request') {
                    this._showTaskConfirm(packet.data);
                }
                // Live deliverable (present_result) — render it NOW so a plan is
                // visible together with a following ask_user question. Only fires
                // LIVE (replay is buffered above, so this never runs during flush).
                if (packet.event === 'result' && packet.data?.envelope) {
                    this._showLiveDeliverable(packet.data.envelope);
                }
                // New LLM step → the next stream chunks belong to a NEW narration
                // bubble. Done at top level (not inside the All Logs branch below)
                // so it still fires when the console DOM isn't present.
                if (packet.event === 'status' && packet.data.message?.startsWith('Thinking... (step ')) {
                    this._startNarrationStep();
                }

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
                } else if (packet.event === 'log' && isChatLog(packet.data)) {
                    this._activeStepChatEntries.push(packet.data);

                    // Get or create uid
                    if (!this._activeStepChatUid) {
                        this._activeStepChatUid = 'chat-' + Math.random().toString(36).slice(2, 8);
                        this._chatDataMap[this._activeStepChatUid] = this._activeStepChatEntries;
                    }

                    // Compute aggregated values
                    const totalPrompt     = this._activeStepChatEntries.reduce((s, c) => s + (c.usage?.prompt_tokens     || 0), 0);
                    const totalCompletion = this._activeStepChatEntries.reduce((s, c) => s + (c.usage?.completion_tokens || 0), 0);
                    const totalCached     = this._activeStepChatEntries.reduce((s, c) => s + (c.usage?.cache_read_input_tokens || 0), 0);
                    const totalDur        = this._activeStepChatEntries.reduce((s, c) => s + (c.duration || 0), 0);
                    const lastEntry = this._activeStepChatEntries[this._activeStepChatEntries.length - 1];
                    const statusCode = lastEntry.status || 200;
                    const isErr = statusCode >= 400 || lastEntry.error;
                    const btnText = `CHAT ${statusCode} · ↑${totalPrompt}t${totalCached > 0 ? ` ⚡${totalCached}t` : ''} ↓${totalCompletion}t · ${totalDur}ms`;

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
                                const summaryText = extractThoughtSummary(raw);
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
                                // Show what the tool is acting on (command / file), not just its name.
                                const runHint = this._toolActionLabel({ name: toolName, request: packet.data.args })
                                    .replace(/^✓\s*/, '');
                                this._updateActiveStepStatus(`⚙ Running: ${runHint}…`, 'tool', undefined,
                                    toolTarget(toolName, packet.data.args));
                            } else if (packet.event === 'confirm_request') {
                                this._updateActiveStepStatus('⏸ Awaiting approval…', 'confirm');
                                // (Task-view card + OS notification are handled at the
                                // top of onmessage / in main.js respectively.)
                            } else if (packet.event === 'error') {
                                this._updateActiveStepStatus('⚠ Error — recovering', 'error');
                            } else if (packet.event === 'log' && packet.data?.method === 'TOOL') {
                                // Tool finished (telemetry event sent after each tool returns).
                                const label = String(packet.data.stepLabel || '');
                                const isSub = label.includes('🤖') || label.includes('sub:');
                                if (isSub) {
                                    // SUB-AGENT tool finished. The forwarded
                                    // "🤖 [sub:…] ⚙ tool: arg" status line already
                                    // shows what the child is doing. Re-showing the
                                    // PARENT step's stored thought here made the SAME
                                    // line ("the Rust build succeeded…") repeat after
                                    // every child tool, flooding the feed. So show the
                                    // child tool's own action instead.
                                    this._updateActiveStepStatus(this._toolActionLabel(packet.data), 'tool', undefined,
                                        toolTarget(packet.data?.name, packet.data?.request));
                                } else {
                                    // Parent tool finished. The header was showing
                                    // "⚙ Running: X…" — prefer this step's thought
                                    // summary (the "story") if captured, else past-tense.
                                    const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                                    const activeStep = realSteps[realSteps.length - 1];
                                    if (activeStep) {
                                        const storedThought = activeStep.dataset.thoughtSummary;
                                        const toolName = packet.data.name || activeStep.dataset.lastTool || 'tool';
                                        // Header → the step's thought (its "story").
                                        // Feed → this tool's OWN action; echoing the
                                        // thought here duplicated it right under its
                                        // own "⚙ Running: X…" line.
                                        this._updateActiveStepStatus(
                                            storedThought || `✓ ${toolName} done`, 'tool',
                                            this._toolActionLabel(packet.data));
                                    }
                                }
                            } else if (packet.event === 'status' && packet.data.message) {
                                // Generic status hints — only override 'live' priority
                                const msg = String(packet.data.message);
                                if (/retry|recover/i.test(msg)) {
                                    this._updateActiveStepStatus(`↻ ${msg.slice(0, 60)}`, 'error');
                                } else if (msg.startsWith('🤖') || msg.startsWith('🔎')) {
                                    // Sub-agent activity / review-gate progress. Without
                                    // this, the Task feed goes SILENT while children work
                                    // (the parent emits no thought/tool events) and the
                                    // "…" thinking placeholder lingers.
                                    this._updateActiveStepStatus(msg, 'tool');
                                }
                            }

                            // CSS [data-current-filter] automatically hides elements that don't match.
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
                    const cr = d.cache_read_input_tokens || 0;
                    const cc = d.cache_creation_input_tokens || 0;
                    this.tokenUsage.prompt_tokens     += d.prompt_tokens || 0;
                    this.tokenUsage.completion_tokens += d.completion_tokens || 0;
                    this.tokenUsage.total_tokens      += (d.total_tokens || ((d.prompt_tokens || 0) + (d.completion_tokens || 0) + cr + cc));
                    this.tokenUsage.cache_read_input_tokens     += cr;
                    this.tokenUsage.cache_creation_input_tokens += cc;
                    // Totals + the breakdown (input full-priced · cached ~10% ·
                    // output) are props now, so one push covers all four fields.
                    // The context gauge says how full the window is RIGHT NOW —
                    // it replaced a step-count progress % that predicted nothing.
                    this._updateContextGauge(d);
                    this._syncHeader();
                    return; // don't render as inline log line
                }
                if (packet.event === 'status') {
                    this.currentProgress = packet.data.progress || this.currentProgress;
                    this.currentStatus = packet.data.status || this.currentStatus;
                    this._syncStatusBadge();
                    this._syncTaskEntry(this.currentStatus, this.currentProgress);

                    // ── ask_user: the agent PAUSED and asked a question ──────────
                    // Make it a clear "answer me" affordance: enable + focus the reply
                    // box with a question placeholder, and surface the question in the
                    // feed. The reply is sent as the continuation (the agent resumes
                    // with the answer). This is the inline-question flow, not a modal.
                    if (this.currentStatus === 'waiting') {
                        this._awaitingUser = true;
                        // OS notification handled globally in main.js.
                        this._setResultLive(packet.data.message || 'The agent is asking for your input — reply below to continue.', 'question');
                        // #2: the run PAUSED for input → fold the tall activity list so
                        // the plan (present_result) above + the question are what's
                        // visible, not the scroll of finished tool calls.
                        this._setFeedCollapsed(true);
                        // Interactive choices (Yes/No / multi-select) when offered.
                        this._showAskCard(packet.data);
                        const si = document.getElementById('input-steering');
                        const sb = document.getElementById('btn-send-steering');
                        const sba = document.getElementById('steer-btn-attach');
                        if (si) {
                            si.disabled = false;
                            si.placeholder = '❓ Answer the agent\'s question to continue (Ctrl+Enter)…';
                            try { si.focus(); } catch (_) {}
                        }
                        if (sb) sb.disabled = false;
                        if (sba) sba.disabled = false;
                    }
                } else if (packet.event === 'complete' || (packet.event === 'error' && packet.data.terminal)) {
                    // NOTE: 'error' WITHOUT data.terminal is a RECOVERABLE mid-run
                    // failure (generation retry etc.) — the run continues, so it
                    // must NOT flip the UI to failed/finished. It's already shown
                    // inline in the feed ("⚠ Error — recovering").
                    this.currentStatus = packet.event === 'complete' ? 'completed' : 'failed';
                    this.currentProgress = 1.0;
                    // (OS completion notification handled globally in main.js.)
                    // Accumulate the result summary (one per run) for the Task tab.
                    if (packet.event === 'complete' && packet.data?.resultSummary) {
                        // The packet is already in this.logs (pushed above), so rebuild
                        // the whole set from the canonical log store — idempotent and
                        // deduped, immune to the replay/continue double-fire AND to the
                        // "a run goes missing" push race. Then re-render the Task panel
                        // so a continuation's new result appears even when the user is
                        // already on that tab.
                        this._rebuildResultSummaries();
                        this._renderResultPanel();
                        // The permanent run bubble now carries the deliverable — drop
                        // the live one (even when ask_user keeps the run "waiting", so
                        // the plan isn't shown twice).
                        this._clearLiveDeliverable();
                    }
                    // Switch to the Task tab on completion — but only if the user
                    // hasn't manually navigated elsewhere during this run. (Replayed
                    // completes are skip-counted out, so this only sees live ones.)
                    if (packet.event === 'complete' && !this._userPickedTab) {
                        this._activateResultTab();
                    }
                    // Swaps the header's ⏹ Abort for Delete on its own: the button
                    // is derived from `status`, so nothing has to be removed by
                    // hand any more.
                    this._syncStatusBadge();
                    // Run ended → reflect it in the left list immediately, and drop
                    // the short-TTL list cache so the next view re-fetches real statuses.
                    this._syncTaskEntry(this.currentStatus, 1.0);
                    invalidateTasksCache();

                    // Finalize the still-running last step so it doesn't sit there
                    // pulsing with a stale "Calling LLM…" or "⚙ Running: X…" label.
                    const realSteps = consoleEl.querySelectorAll('.mstep:not(#mstep-init)');
                    const lastStep = realSteps[realSteps.length - 1];
                    const lastHeader = lastStep?.querySelector('.mstep-header');
                    if (lastHeader) this._finalizePreviousStep(lastHeader);

                    // Clear the live activity feed — the run's request/answer bubbles
                    // (rendered in #result-runs above) now represent this turn. The
                    // feed was the ephemeral "in progress" stream.
                    // ...but when ask_user paused the run, KEEP the highlighted question
                    // card visible — the "task" isn't over, it's waiting for the reply.
                    if ((packet.event === 'complete' || packet.event === 'error') && !this._awaitingUser) {
                        const feed = document.getElementById('result-live');
                        if (feed) { feed.innerHTML = ''; feed.style.display = 'none'; feed.dataset.lastText = ''; }
                        this._feedGroupBody = null;   // groups are gone with the feed
                        // Run finished → its permanent result bubbles now stand in for
                        // the in-progress stream, so drop the saved snapshot.
                        _liveSnapshots.delete(this.selectedTaskId);
                        // Only DROP the pending user bubble when a fresh run bubble
                        // actually replaced it — i.e. a resultSummary was pushed +
                        // rendered into #result-runs this completion. Otherwise (a
                        // mid-run STEER that folded into the current run, or a
                        // completion carrying no summary) clearing it would make the
                        // just-sent request+answer VANISH from the Task view (the
                        // reported "the follow-up request never shows / the result briefly disappears"
                        // symptom). In that case, freeze it into a persistent bubble.
                        if (packet.event === 'complete' && packet.data?.resultSummary) {
                            this._clearPendingUser();
                        } else {
                            this._finalizePendingUser(packet.data?.message);
                        }
                        // Any leftover approval / ask slot is moot once the run ends.
                        this._clearTaskConfirm();
                        this._clearAskCard();
                        // The run is over — drop the "working" boundary + activity pill.
                        this._setWorkingLabel(false);
                        const jump = document.getElementById('result-jump');
                        if (jump) jump.style.display = 'none';
                    }

                    if (packet.event === 'complete' || packet.event === 'error') {
                        // Keep the steer box usable so the user can CONTINUE the task —
                        // for BOTH a clean finish AND a stop/error/stall. A stalled or
                        // failed run is exactly when "just keep going" is most useful.
                        this._taskFinished = true;
                        this._syncStopButton();   // A: hide the ⏹ stop button (run over)
                        this._clearLiveDeliverable();   // run over → drop any live plan bubble
                        this._clearNarration();         // …and the live narration (result bubble takes over)
                        // ask_user pauses the run and returns via 'complete' — but the
                        // task is NOT actually done, it's waiting for the user's answer.
                        // Keep the question-answer framing so the reply box reads as
                        // "answer this", not "task finished".
                        const awaiting = this._awaitingUser;
                        const done = packet.event === 'complete' && !awaiting;
                        const si = document.getElementById('input-steering');
                        const sb = document.getElementById('btn-send-steering');
                        const sba = document.getElementById('steer-btn-attach');
                        const sbs = document.getElementById('steer-btn-skills');
                        if (si) {
                            si.disabled = false;
                            si.placeholder = awaiting
                                ? '❓ Answer the agent\'s question to continue (Ctrl+Enter)…'
                                : (done
                                    ? '✓ Done. Add a message to continue the task (Ctrl+Enter, / for skills)'
                                    : '⚠ Stopped. Add a message to continue / retry (Ctrl+Enter, / for skills)');
                            if (awaiting) { try { si.focus(); } catch (_) {} }
                        }
                        if (sb) sb.disabled = false;
                        if (sba) sba.disabled = false;
                        if (sbs) sbs.disabled = false;
                    } else {
                        disableSteering();
                    }
                }
            } catch (e) { console.error('WS parse error:', e); }
        };

        // Guard with _destroyed: destroy() closes this socket, and the resulting
        // onclose used to disable the steer box of the NEW view that had already
        // re-rendered over the same DOM ids.
        this.socket.onerror = () => { if (!this._destroyed && this.selectedTaskId === taskId) disableSteering(); };
        // Don't disable the steer box on a normal post-completion close — the user
        // can still type to continue the task.
        this.socket.onclose = () => { if (!this._destroyed && this.selectedTaskId === taskId && !this._taskFinished) disableSteering(); };
    }

    /** Show/hide the "load earlier" control based on whether anything precedes. */
    _syncEarlierButton() {
        const el = document.getElementById('result-earlier');
        if (!el) return;
        // Keep the row visible while a note is showing, so the outcome of the last
        // click doesn't disappear along with the button.
        const note = document.getElementById('result-earlier-note');
        const hasNote = !!note?.textContent?.trim();
        el.style.display = (this._logStart > 0 || hasNote) ? 'block' : 'none';
        const btn = document.getElementById('btn-load-earlier');
        if (btn) btn.style.display = this._logStart > 0 ? '' : 'none';
    }

    /** One-line outcome for the last "load earlier" click. */
    _setEarlierNote(text) {
        const note = document.getElementById('result-earlier-note');
        if (note) note.textContent = String(text || '');
    }

    /** Prepend the previous page of logs and re-derive the timeline from them. */
    async loadEarlierLogs() {
        if (!window.apiClient || !this.selectedTaskId || this._logStart <= 0) return;
        const btn = document.getElementById('btn-load-earlier');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        const taskId = this.selectedTaskId;
        try {
            const older = await window.apiClient.getTaskLogs(taskId, {
                limit: LOG_PAGE_SIZE, before: this._logStart,
            });
            if (this._destroyed || this.selectedTaskId !== taskId) return;
            if (Array.isArray(older) && older.length) {
                const runsBefore = this._timeline.items.filter(i => i.kind === 'run').length;
                // ANCHOR the reader to what they were looking at. Content is being
                // inserted ABOVE them, so holding scrollTop would slide the page
                // out from under them — and the render below then treats "not at
                // the bottom" as a reason to keep the jump pill up, which is how
                // one click turned into scrolling down and clicking again.
                const rp = document.getElementById('result-panel');
                const anchor = rp ? rp.scrollHeight - rp.scrollTop : null;
                this.logs = [...older.map(l => ({ ...l, data: l.data || {} })), ...this.logs];
                const nextStart = Number(older[0]?.data?._idx);
                // Guard against a backend that omits `_idx`: without a moving
                // anchor the button would refetch the same page forever.
                this._logStart = Number.isFinite(nextStart) && nextStart < this._logStart ? nextStart : 0;
                this._rebuildResultSummaries();
                // Loading history is not new activity: auto-follow must not drag
                // the view to the bottom just because the page grew.
                const wasScrolledUp = this._userScrolledUp;
                this._userScrolledUp = true;
                this._renderResultPanel();
                this._userScrolledUp = wasScrolledUp;
                if (rp && anchor !== null) rp.scrollTop = rp.scrollHeight - anchor;

                // The Task view is built from completions; a page of step logs can
                // legitimately add nothing here. Say so instead of looking broken —
                // that content lives in All Logs.
                // Count RUNS, not items: the "here is your request" bubble appears
                // whenever no run exists yet and would otherwise read as a gain.
                const gained = this._timeline.items.filter(i => i.kind === 'run').length - runsBefore;
                this._setEarlierNote(gained > 0
                    ? `Loaded ${older.length} entries (+${gained} exchange(s))`
                    : `Loaded ${older.length} entries (no completed results in this range — see All Logs)`);

                // Rebuild All Logs now if the user is looking at it; otherwise mark
                // it stale so the next switch picks the new entries up.
                const consoleEl = document.getElementById('console-logs');
                const allLogsActive = !!document.querySelector('.mfilter-btn[data-filter="all"].active');
                if (consoleEl && allLogsActive) {
                    consoleEl.innerHTML = this.renderAllLogs();
                    this._allLogsDirty = false;
                } else {
                    this._allLogsDirty = true;
                }
            } else {
                this._logStart = 0;
                this._setEarlierNote('No earlier logs');
            }
        } catch (e) {
            console.warn('Failed to load earlier logs:', e);
            this._setEarlierNote(`Failed to load: ${e?.message || e}`);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '↑ Load earlier'; }
            this._syncEarlierButton();
        }
    }

    async loadHistoricalLogs(taskId) {
        if (!window.apiClient) return;
        const consoleEl = document.getElementById('console-logs');
        try {
            // Only the newest slice: a long run used to ship every entry on open,
            // which is the dominant "selecting a task is slow" cost. Earlier ones
            // load on demand via the button above the timeline.
            const logs = await window.apiClient.getTaskLogs(taskId, { limit: LOG_PAGE_SIZE });
            // Stale-response guard: if the user already navigated to another task
            // (or away) while this fetch was in flight, do NOT paint the previous
            // task's results into the currently-shown task's panels.
            if (this._destroyed || this.selectedTaskId !== taskId) return;
            // Fetch finished → the loading indicator has served its purpose.
            // (The success path also replaces it via _renderResultPanel; this
            // covers the empty-logs case.)
            document.getElementById('result-loading')?.remove();
            if (Array.isArray(logs) && logs.length > 0) {
                this.logs = logs.map(l => ({ ...l, data: l.data || {} }));
                // `_idx` is the ABSOLUTE index in the stored log, so it tells us
                // whether anything precedes what we fetched.
                this._logStart = Number(this.logs[0]?.data?._idx) || 0;
                this._syncEarlierButton();
                // Seed the accumulator from the loaded run, so the header and the
                // inspector agree about a task opened from history.
                this.tokenUsage = { ...this.tokenUsage, ...this._usageTotals() };
                // Recover ALL run results from the persisted `complete` events
                // (a continued task has more than one) — same canonical derivation
                // as the live/replay paths.
                this._rebuildResultSummaries();
                // Seed the context gauge from the newest LLM call of the stored run.
                const lastUsage = [...this.logs].reverse().find(l => l.event === 'token_usage');
                if (lastUsage) this._updateContextGauge(lastUsage.data);
                this._renderResultPanel();
                // Land on the NEWEST content (bottom) once results are in — a long
                // conversation should open at its latest exchange, not the top.
                requestAnimationFrame(() => {
                    if (this._destroyed || this.selectedTaskId !== taskId) return;
                    const rp = document.getElementById('result-panel');
                    if (rp) rp.scrollTop = rp.scrollHeight;
                });
                // Defer the (potentially large) All Logs DOM build until the user
                // actually opens that tab. Result is the default view, so most opens
                // never need it — this is the dominant "Monitor feels heavy on open"
                // cost on low-end machines (big per-step logs → huge DOM + reflow).
                if (consoleEl) {
                    const allLogsActive = !!document.querySelector('.mfilter-btn[data-filter="all"].active');
                    if (allLogsActive) {
                        consoleEl.innerHTML = this.renderAllLogs();
                        this._allLogsDirty = false;
                    } else {
                        this._allLogsDirty = true;   // build lazily on first switch
                    }
                }
                // Completed task with a result → open on the Result tab by default.
                if (this.resultSummaries.length > 0) {
                    this._activateResultTab();
                }
                // Finished task → allow continuing it (re-run) from the steer box.
                this._taskFinished = true;
                const si = document.getElementById('input-steering');
                const sb = document.getElementById('btn-send-steering');
                const sba = document.getElementById('steer-btn-attach');
                const sbs = document.getElementById('steer-btn-skills');
                if (si) {
                    si.disabled = false;
                    // Match the placeholder to how the task actually ended.
                    const st = this.tasks.find(t => t.id === taskId)?.status;
                    si.placeholder = (st === 'failed' || st === 'aborted')
                        ? '⚠ Stopped. Add a message to continue / retry (Ctrl+Enter, / for skills)'
                        : '✓ Done. Add a message to continue the task (Ctrl+Enter, / for skills)';
                }
                if (sb) sb.disabled = false;
                if (sba) sba.disabled = false;
                if (sbs) sbs.disabled = false;
            }
        } catch (e) {
            console.error('Failed to load task logs:', e);
            // Don't leave the spinner running forever on a failed fetch.
            if (!this._destroyed) document.getElementById('result-loading')?.remove();
        }
    }

    // NOTE: _groupFilesByDir / _filesDetailsHtml / _requestHtml are gone with the
    // string renderers that called them. Directory grouping is buildFileTree in
    // monitor/inspector.js (shared by the inspector's tree and the card's file
    // list); the request's clamp is CSS on .tl-card-request plus the card's own
    // is-open state, rather than two copies of the text and a delegated toggle.

    /**
     * Show the user's just-sent message immediately, the way ChatView does.
     *
     * This goes through the TIMELINE, not a separate slot. It used to write into
     * `#result-pending`, an element the single-timeline redesign deleted — so the
     * lookup returned null and a follow-up request simply never appeared on
     * screen until the run finished.
     *
     * `pushRequest` is the designed path: the item lands ahead of the steps with
     * the send time on it, and `pushRun` later settles that same item in place, so
     * the exchange ends up in chronological order without anything to clear.
     */
    _showPendingUser(text, images = []) {
        const hasImages = Array.isArray(images) && images.length > 0;
        if (!text && !hasImages) return;
        // An image-only message still deserves a visible bubble.
        this._timeline.pushRequest(String(text || '(image)'), hasImages ? images : null);
        this._renderResultPanel();
        this._scrollTaskToBottom();
    }

    _clearPendingUser() {
        // The completed run now carries this exchange; pushRun() already dropped
        // the live request item, so there is nothing separate to clear.
        this._renderResultPanel();
    }

    /**
     * Settle the just-sent request into a PERSISTENT exchange when no
     * resultSummary arrived to replace it (a mid-run steer that folded into the
     * current run, or a completion carrying no summary).
     *
     * Without this the request stays `live`, which makes it a trim/clearLive
     * candidate — the reported "the follow-up request never shows / the result
     * briefly disappears". Any final message becomes the answer beneath it.
     */
    _finalizePendingUser(answerText) {
        let dirty = this._timeline.settleRequest();
        const ans = String(answerText || '').trim();
        if (ans && this._timeline.pushDeliverable('markdown', ans)) dirty = true;
        if (dirty) this._renderResultPanel();
    }

    /** Extract the human-readable body from a present_result envelope. */
    _envelopeText(env) {
        // One definition, shared with the replay path (monitor/taskTimeline.js),
        // so a delivered report is extracted identically live and after a reload.
        return envelopeText(env);
    }

    /** Render a present_result deliverable as a LIVE AI bubble during the run, so
     *  a plan is visible together with a following ask_user question (not only
     *  after completion). Replaced by the permanent run bubble on complete. */
    _showLiveDeliverable(envelope) {
        // pushDeliverable refuses to let an EMPTY follow-up envelope replace real
        // content, so the "model emits a good result then an empty one" misfire
        // is handled by the model rather than by ad-hoc guards here.
        if (this._timeline.pushDeliverable(envelope?.kind, this._envelopeText(envelope))) {
            this._renderResultPanel();
        }
    }

    _clearLiveDeliverable() {
        // pushRun() drops every live item, so this only runs on teardown paths.
        this._renderResultPanel();
    }

    /**
     * Live narration: append the model's streamed tokens as prose so the user can
     * see what it's thinking/doing while it works. DISPLAY-ONLY — the stream is
     * never stored, never rendered in All Logs, and never feeds the result
     * summary, so this cannot affect the report / finish output / JHEditor.
     * extractNarration() cuts at the first JSON/code/tool-call marker, so a
     * JSON-mode model (whole reply = one envelope) renders NOTHING here.
     * Rendering is rAF-coalesced — a per-token markdown re-render would thrash.
     */
    _appendNarration(chunk) {
        if (!chunk) return;
        this._streamBuf = (this._streamBuf || '') + chunk;
        if (this._narrationRaf) return;                  // a render is already queued
        this._narrationRaf = requestAnimationFrame(() => {
            this._narrationRaf = null;
            if (this._destroyed) return;
            const prose = extractNarration(this._streamBuf);
            if (!prose) return;                          // pure machinery → show nothing
            this._narrationText = prose;
            this._timeline.pushNarration(prose);
            this._renderResultPanel();
        });
    }

    /** New LLM step → start a fresh narration bubble (the previous one stays,
     *  so the run reads as an interleaved back-and-forth with the tool feed). */
    _startNarrationStep() {
        this._streamBuf = '';
        this._narrationText = '';
        // Closing the open narration makes the NEXT prose a new item, so a run
        // reads as an interleaved back-and-forth with the activity groups.
        this._timeline.closeNarration();
    }

    _clearNarration() {
        if (this._narrationRaf) { cancelAnimationFrame(this._narrationRaf); this._narrationRaf = null; }
        this._streamBuf = '';
        this._narrationText = '';
    }

    /** Drop the "thinking…" placeholder under the pending user message once real
     *  activity starts streaming — the "Working…" strip below now shows
     *  progress, so the dots would just sit there stale until completion. Keeps
     *  the user's message bubble. */
    _stopPendingThinking() {
        // Both spots: the pending slot (steer-sent message) AND the initial
        // request bubble rendered in #result-runs for a brand-new task.
        document.querySelectorAll('#task-timeline .mrc-thinking')
            .forEach(t => t.closest('.mrc-row')?.remove());
    }

    /**
     * Every file this task touched, across all turns, deduped.
     *
     * Used to be rendered TWICE — a pinned bar at the top of the reading surface
     * and a list in the inspector. The bar is gone (it cost the top of the view on
     * every task that wrote a file); this is now just the data behind the
     * inspector's tree.
     *
     * @returns {Array<{path:string, action:string}>} in first-touched order
     */
    _touchedFiles() {
        const seen = new Map();   // path → action (first wins)
        for (const r of (this.resultSummaries || [])) {
            for (const f of (r?.files || [])) {
                if (f?.path && !seen.has(f.path)) seen.set(f.path, f.action || '');
            }
        }
        return [...seen.entries()].map(([path, action]) => ({ path, action }));
    }

    /** D: show/hide the "⏳ Working…" boundary above the live feed, and the
     *  sticky-bottom wrapper that keeps the live region visible. */
    _setWorkingLabel(on) {
        const el = document.getElementById('result-live-label');
        if (el) el.style.display = on ? 'flex' : 'none';
        const wrap = document.getElementById('result-live-wrap');
        if (wrap) wrap.style.display = on ? 'block' : 'none';
        if (on) this._applyFeedCollapsed();
    }

    /** #2/#4: fold/unfold the live activity list (keeps the "Working" label). Folding
     *  frees vertical space so the results / plan above are readable — done
     *  automatically when the run pauses on ask_user, and manually via the label. */
    _setFeedCollapsed(collapsed) {
        this._feedCollapsed = collapsed;
        this._applyFeedCollapsed();
    }
    _applyFeedCollapsed() {
        const label = document.getElementById('result-live-label');
        const collapsed = !!this._feedCollapsed;
        // Fold the reasoning GROUPS rather than hiding the whole region. Hiding it
        // is what made an ask_user question invisible: the question was written
        // into the feed and the feed was collapsed in the same breath.
        document.querySelectorAll('#task-timeline .mtl-group')
            .forEach(g => g.classList.toggle('collapsed', collapsed));
        if (label) label.classList.toggle('is-folded', collapsed);
    }

    /** C: is the Task scroll pinned to the bottom (following live activity)? */
    _isTaskAtBottom() {
        const rp = document.getElementById('result-panel');
        if (!rp) return true;
        return rp.scrollHeight - rp.scrollTop - rp.clientHeight < 60;
    }

    _scrollTaskToBottom() {
        const rp = document.getElementById('result-panel');
        if (rp) rp.scrollTop = rp.scrollHeight;
        // Going back to the bottom re-arms auto-follow.
        this._userScrolledUp = false;
        const jump = document.getElementById('result-jump');
        if (jump) jump.style.display = 'none';
    }

    /** A: show the ⏹ stop button only while a run is actually in progress. */
    _syncStopButton() {
        const b = document.getElementById('btn-stop-steering');
        if (!b) return;
        const done = this._taskFinished
            || ['completed', 'failed', 'aborted', 'idle'].includes(this.currentStatus);
        b.style.display = done ? 'none' : '';
        if (!done) { b.disabled = false; b.textContent = '⏹ Stop'; }
    }

    /** Re-render the run bubbles (NOT the live feed sibling) and rebind file links. */
    /**
     * Canonical source of the Task-tab result bubbles: derive `resultSummaries`
     * from `this.logs` (every `complete` event that carries a resultSummary),
     * deduped by timestamp+request. ALL paths (live complete, continue, reload,
     * replay-flush) call this so they can never diverge — the previous split
     * between "incremental push + dedup set" (live) and "filter/map from logs"
     * (reload) let a run silently go missing from one path but not the other.
     */
    _rebuildResultSummaries() {
        const seen = new Set();
        const out = [];
        for (const l of (this.logs || [])) {
            if (l.event !== 'complete' || !l.data?.resultSummary) continue;
            const rs = l.data.resultSummary;
            const key = `${l.timestamp || ''}|${String(rs.request || '').slice(0, 120)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(rs);
        }
        this.resultSummaries = out;

        // Rebuild the timeline from the SAME logs, through the SAME reducer the
        // live socket drives. The previous split (incremental push while live,
        // filter/map on reload) is what let a run appear in one path and not the
        // other.
        const task = (this.tasks || []).find(t => t.id === this.selectedTaskId);
        this._timeline = buildTimeline(this.logs, { prompt: task?.prompt });
    }

    /**
     * Project the timeline onto the DOM.
     *
     * Cheap by construction: Timeline.svelte's keyed `{#each}` keeps one node per
     * item id and updates only what changed, so a streaming run touches one line's
     * worth of DOM instead of rebuilding the panel. That was hand-rolled in
     * timelineRender.js before this region was migrated.
     */
    _renderResultPanel() {
        ensureResultViewStyles();
        this._renderHubStrip();
        const host = document.getElementById('task-timeline');
        if (!host) return;

        const wasAtBottom = this._isTaskAtBottom();

        // The deliverable is lifted out of the trace and rendered as a document,
        // but it stays at the END of the same single column — that is where it
        // belongs chronologically, and it needs the full width to be readable.
        // The document is already positioned inside `stream` — it sits where the
        // agent produced it, which is what makes the story read in order.
        const { stream } = splitForPanes(this._timeline.items);
        const items = withExchangeFolds(stream, this._collapsedExchanges(stream));
        this._timelineCmp = mountComponent(Timeline, host, {
            items,
            collapsed: collapsedIds(this._timeline.items),
            renderMarkdown: (t) => renderMarkdown(t),
            workspace: this._workspaceOf(),
            onToggleStory: (ex, what) => this._toggleExchange(ex, what),
            onToggleCollapse: (id) => this._toggleCard(id),
            onAnswer: (ans) => this._answerAsk(ans),
            onCopyDoc: (text) => this._copyDeliverable(text),
            onOpenFile: (path) => openPathInDefaultApp(path, this._workspaceOf()),
        });
        this._renderPendingAsk(items);
        this._renderInspector(items);
        this._syncFoldAllButton();
        document.getElementById('result-loading')?.remove();

        // Follow the newest content only when the reader has NOT scrolled away.
        // `wasAtBottom` alone let a tall incoming card yank the view — the reader
        // was at the bottom when the render started and mid-page by the end of it.
        //
        // The scroll has to happen AFTER the new content exists. Prop pushes are
        // batched (see mount.svelte.js), so this waits a microtask rather than
        // forcing a synchronous flush — forcing one on every streamed line is what
        // made a long run feel like it stalled.
        if (wasAtBottom && !this._userScrolledUp) {
            Promise.resolve().then(() => {
                if (!this._destroyed) this._scrollTaskToBottom();
            });
        } else {
            const jump = document.getElementById('result-jump');
            if (jump) jump.style.display = 'block';
        }
    }

    /**
     * Render the connected-apps strip. Clicking an intent or a live document
     * COMPOSES the request in the input box rather than dispatching it — the
     * user stays the one who decides to send.
     */
    _renderHubStrip() {
        const el = document.getElementById('hub-strip');
        if (!el) return;
        const apps = hubApps(mcpManager.clients);
        const any = apps.some(a => a.intents.length || a.resources.length);
        el.style.display = any ? 'block' : 'none';
        // MIGRATED: HubStrip.svelte. This was innerHTML plus a
        // querySelectorAll('[data-hub-kind]') loop that read the app, kind, id, uri
        // and name back off each button's data attributes — to reconstruct exactly
        // what it had just rendered from.
        this._hubStrip = mountComponent(HubStrip, el, {
            apps,
            onCompose: (text) => {
                const input = document.getElementById('input-steering');
                if (!input) return;
                input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${text}` : text;
                input.focus();
            },
        });
    }

    /**
     * The metadata column. Rendered only while it is open — a closed inspector
     * costs nothing, which is what lets it default to closed without the panel
     * feeling like something is missing.
     */
    _renderInspector(items) {
        const el = document.getElementById('task-inspector');
        if (!el) return;
        // Remembered so a late arrival (the cost rates) can redraw without the
        // caller's item list.
        if (items) this._inspectorItems = items;
        items = items || this._inspectorItems || [];
        const open = !!this._inspectorOpen;
        el.style.display = open ? 'block' : 'none';

        document.getElementById('btn-inspector')?.classList.toggle('active', open);
        if (!open) return;
        this._loadCostRates();

        const task = (this.tasks || []).find(t => t.id === this.selectedTaskId) || null;
        const lastRun = [...(this.resultSummaries || [])].reverse()[0] || {};
        const files = this._touchedFiles();
        // One bar per LLM call, split by where the tokens went.
        const perStep = (this.logs || [])
            .filter(l => l.event === 'token_usage')
            .map(l => ({
                in: Number(l.data?.prompt_tokens) || 0,
                cache: Number(l.data?.cache_read_input_tokens) || 0,
                out: Number(l.data?.completion_tokens) || 0,
            }));

        // MIGRATED to Svelte (the first component — see docs/design/svelte-migration.md).
        // This view's only remaining job for the inspector is to gather the props
        // and push them; it must NOT touch this subtree's DOM again. The callbacks
        // are passed in rather than delegated from a click handler elsewhere,
        // which is what let the old Project-instructions action rot into a no-op.
        this._inspector = mountComponent(Inspector, el, {
            task: task ? { ...task, status: this.currentStatus || task.status } : null,
            stats: lastRun.stats || {},
            usage: this._usageTotals(),
            files,
            perStep,
            rates: this._costRates,
            chapters: chapters(items),
            activeChapter: this._activeChapter,
            onAction: (act) => this._inspectorAction(act),
            onChapter: (id) => this._jumpToChapter(id),
            onOpenFile: (path) => openPathInDefaultApp(path, this._workspaceOf()),
        });
    }

    /** An inspector action button. Extracted so the component just names the intent. */
    _inspectorAction(act) {
        if (act === 'workspace') {
            const ws = (this.tasks || []).find(t => t.id === this.selectedTaskId)?.workspace_path;
            if (ws) invoke('open_path_default', { path: ws }).catch(e => console.warn(e));
        } else if (act === 'instructions') {
            this._openProjectInstructions();
        } else if (act === 'copy') {
            const { doc } = splitForPanes(this._timeline.items);
            if (doc) this._copyDeliverable(doc.text);
        }
    }

    /** Scroll the story to a chapter, and mark it active in the rail. */
    _jumpToChapter(id) {
        this._activeChapter = id;
        document.querySelector(`#task-timeline [data-item-id="${id}"]`)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        // The rail reads activeChapter from its props, so a re-push is the update.
        this._inspector?.update({ activeChapter: id });
    }

    /**
     * Open this workspace's `.agent/instructions.md`, creating it from a template
     * the first time. The only surface that reveals the file exists.
     *
     * @param {HTMLElement} [btn] disabled while the work is in flight
     */
    async _openProjectInstructions(btn = null) {
        const ws = (this.tasks || []).find(t => t.id === this.selectedTaskId)?.workspace_path;
        if (!ws || !String(ws).trim()) return;
        const { instructionsTemplate, instructionsPathFor } =
            await import('../../modules/ai/agent/ProjectInstructions.js');
        const loc = instructionsPathFor(ws);
        if (!loc) return;
        if (btn) btn.disabled = true;
        try {
            // The path guard only knows workspaces an agent session has opened, so
            // a task merely SELECTED here is still unregistered and the create
            // would be blocked. Invoking this action is the approval; grant just
            // the .agent directory.
            try {
                await invoke('set_allowed_roots', { roots: [loc.dir] });
            } catch (e) {
                console.warn('Failed to register .agent as a path-guard root:', e);
            }
            let exists = true;
            try { await invoke('read_file', { path: loc.file }); } catch (_) { exists = false; }
            if (!exists) {
                const name = loc.root.split('/').pop();
                await invoke('write_file', { path: loc.file, content: instructionsTemplate(name), encoding: 'utf-8' });
            }
            await invoke('open_path_default', { path: loc.file });
        } catch (e) {
            alert(`Could not open the project instructions: ${e?.message || e}`);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /**
     * Which exchanges are folded.
     *
     * Until the reader touches a fold, this is DERIVED rather than stored: every
     * exchange but the newest is folded, so opening a long task shows the recent
     * work and a list of what came before instead of a wall of steps. Once they
     * fold or unfold anything, their choice is the answer and nothing overrides
     * it — a set that silently re-derived itself on the next render would undo
     * the click that produced it.
     */
    _collapsedExchanges(stream) {
        const n = exchangeCount(stream);
        if (!this._foldTouched) {
            const auto = new Set();
            for (let i = 1; i < n; i++) auto.add(i);
            this._collapsedEx = auto;
            this._collapsedOut = new Set(auto);
        }
        return { working: this._collapsedEx, outcome: this._collapsedOut };
    }

    /**
     * Fold or unfold ONE card, by item id.
     *
     * The flag lives on the timeline item because the MODEL also sets it — opening a
     * new step folds every earlier one, and a completed run folds them all. The
     * renderer reads it and reports clicks here; it must never keep its own copy.
     */
    _toggleCard(id) {
        const item = this._timeline.items.find(i => i.id === id);
        if (!item) return;
        if (this._timeline.setCollapsed(id, !item.collapsed)) this._renderResultPanel();
    }

    /**
     * Fold or unfold ONE exchange.
     * @param {number} ex the exchange
     * @param {'working'|'outcome'} what which half — they are independent.
     */
    _toggleExchange(ex, what = 'working') {
        const n = Number(ex);
        if (!Number.isFinite(n)) return;
        this._foldTouched = true;
        const set = what === 'outcome' ? this._collapsedOut : this._collapsedEx;
        if (set.has(n)) set.delete(n);
        else set.add(n);
        this._renderResultPanel();
    }

    /**
     * One control for the whole story: fold everything, or open everything.
     *
     * "Anything open → close it all" rather than a remembered mode, so the button
     * always does the thing the current view makes you want.
     */
    _toggleAllExchanges() {
        const { stream } = splitForPanes(this._timeline.items);
        const n = exchangeCount(stream);
        const shut = this._anythingOpen(stream, n);
        this._foldTouched = true;
        this._collapsedEx = new Set();
        this._collapsedOut = new Set();
        // This one control acts on BOTH halves: it is the "show me the shape of
        // the whole task" shortcut, not a per-half toggle.
        if (shut) for (let i = 1; i <= n; i++) { this._collapsedEx.add(i); this._collapsedOut.add(i); }
        this._renderResultPanel();
        this._syncFoldAllButton();
    }

    /** Is any half of any exchange still open? */
    _anythingOpen(stream, n) {
        const { working, outcome } = this._collapsedExchanges(stream);
        for (let i = 1; i <= n; i++) {
            if (!working.has(i) || !outcome.has(i)) return true;
        }
        return false;
    }

    /** Keep the fold-all button saying what the next click will do. */
    _syncFoldAllButton() {
        const btn = document.getElementById('btn-fold-all');
        if (!btn) return;
        const { stream } = splitForPanes(this._timeline?.items || []);
        const n = exchangeCount(stream);
        const anyOpen = this._anythingOpen(stream, n);
        btn.textContent = anyOpen ? '⊟ Collapse all' : '⊞ Expand all';
        btn.title = anyOpen ? 'Fold every exchange' : 'Open every exchange';
        btn.style.display = n > 1 ? '' : 'none';
    }

    /**
     * A pinned notice while a question is unanswered.
     *
     * The question card sits where it happened, which is correct — but on a long
     * story that can be far above the reader, and an agent waiting for an answer
     * looks exactly like an agent that has stopped. The banner stays in view and
     * scrolls to the question.
     */
    _renderPendingAsk(items) {
        const slot = document.getElementById('task-pending-ask');
        if (!slot) return;
        const ask = (items || []).find(i => i.kind === 'ask' && !i.answered);
        if (!ask) { slot.innerHTML = ''; slot.style.display = 'none'; return; }

        slot.style.display = 'block';
        slot.innerHTML = `<div class="mask-pending" role="button">`
            + `${icon('question', 14)}<span>Waiting for your answer</span>`
            + `<span class="mask-pending-go">Go to the question ↓</span></div>`;
        slot.querySelector('.mask-pending')?.addEventListener('click', () => {
            document.querySelector(`#task-timeline [data-item-id="${ask.id}"]`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
    }

    /**
     * The run's token totals, from whichever source actually has them.
     *
     * There were three: a live accumulator, the task record the server keeps, and
     * the `token_usage` log events. The header read one and the inspector another,
     * so a task opened from history showed real numbers up top and zeros in the
     * inspector. One function, three fallbacks, in order of authority:
     *
     *   1. the LIVE accumulator — the only one that is current during a run;
     *   2. the task record — authoritative for a finished task, and unaffected by
     *      log paging (which can drop the early `token_usage` events entirely);
     *   3. summing the logs — the last resort.
     */
    _usageTotals() {
        const live = this.tokenUsage || {};
        if (live.total_tokens > 0) return live;

        const stored = (this.tasks || []).find(t => t.id === this.selectedTaskId)?.token_usage;
        if (stored && (stored.total_tokens > 0 || stored.prompt_tokens > 0)) return stored;

        const sum = {
            prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        };
        for (const l of (this.logs || [])) {
            if (l.event !== 'token_usage') continue;
            const d = l.data || {};
            const cr = d.cache_read_input_tokens || 0;
            const cc = d.cache_creation_input_tokens || 0;
            sum.prompt_tokens += d.prompt_tokens || 0;
            sum.completion_tokens += d.completion_tokens || 0;
            sum.cache_read_input_tokens += cr;
            sum.cache_creation_input_tokens += cc;
            sum.total_tokens += d.total_tokens
                || ((d.prompt_tokens || 0) + (d.completion_tokens || 0) + cr + cc);
        }
        return sum;
    }

    /**
     * Per-1M-token USD rates, fetched once and cached on the view.
     *
     * The server owns pricing (it reads the per-model table out of the config),
     * so the inspector asks for the rates rather than keeping a second copy that
     * would drift the moment someone edited a model's cost in Config.
     */
    async _loadCostRates() {
        if (this._costRates || this._costRatesPending) return;
        this._costRatesPending = true;
        try {
            const stats = await window.apiClient?.getStats?.();
            const r = stats?.costRates;
            // Rates of all zero mean "not configured": showing $0.00 everywhere
            // would read as "this was free", so leave the cost column out.
            if (r && (r.input_per_1m || r.cache_read_per_1m || r.output_per_1m)) {
                this._costRates = r;
                if (!this._destroyed) this._renderInspector();
            }
        } catch { /* pricing is a nicety — never let it break the inspector */ }
    }

    /** The selected task's workspace root — the base for relative tool paths. */
    _workspaceOf() {
        return (this.tasks || []).find(t => t.id === this.selectedTaskId)?.workspace_path || '';
    }

    /** Show or hide the task list, and keep the toggle in sync. */
    _applyListCollapsed() {
        const pane = document.querySelector('.mpanel-left');
        if (pane) pane.style.display = this._listCollapsed ? 'none' : '';
        document.getElementById('btn-toggle-list')?.classList.toggle('active', !this._listCollapsed);
    }

    // NOTE: _bindInspector is gone. It queried [data-chap] / [data-insp-act] out
    // of the rendered HTML and attached listeners after every redraw — the pattern
    // that produced today's dead-button bugs. The Svelte component takes its
    // callbacks as props instead, so a handler cannot be lost by a re-render.

    // NOTE: _timelineCtx is gone. It bundled the renderer and the callbacks into a
    // `ctx` object that createItemNode/bindItem needed because the item renderers
    // were plain functions with no way to receive anything else. Timeline.svelte
    // takes them as props.

    /** Copy the deliverable body — the document is meant to leave the app. */
    async _copyDeliverable(text) {
        try {
            await navigator.clipboard.writeText(String(text || ''));
            const btn = document.querySelector('.mtl-doc-copy');
            if (btn) {
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '⧉'; }, 1200);
            }
        } catch (e) {
            console.warn('Copy failed:', e);
        }
    }

    /** Send an ask_user answer picked from the question card. */
    _answerAsk(answer) {
        const text = String(answer || '').trim();
        if (!text) return;
        // Remember WHAT was answered. _clearAskCard reads this to record the
        // reply on the question item; nothing ever set it, so every answered
        // question in the story showed the question and a blank reply.
        this._lastAnswerText = text;
        const input = document.getElementById('input-steering');
        if (input) input.value = text;
        document.getElementById('btn-send-steering')?.click();
    }

    /**
     * Real-time activity FEED (chat-style), shown above the Task view while the
     * task runs. Each meaningful step (thinking / tool use / result) is appended
     * as its own line — like the ChatView tool-activity display — so you can see
     * the work progressing, not just a single stale line. Consecutive duplicates
     * are skipped and the feed is capped to keep it light.
     */
    /**
     * Concise "what a finished tool did" label from a TOOL telemetry entry —
     * mirrors AgentController._toolArgHint (command / file basename / query),
     * preserving any "🤖 [sub:…]" prefix from the forwarded stepLabel so the
     * feed reads e.g. "🤖 [sub:reviewer#1] ✓ run_command: cargo build".
     */
    _toolActionLabel(data) {
        // The formatting rule lives in monitor/toolLine.js, which also returns the
        // path as a FIELD — a step now offers the file it touched as a link, and
        // that only works if the path never gets baked into prose in the first place.
        const prefix = String(data?.stepLabel || '').match(/🤖\s*\[[^\]]+\]/)?.[0] || '';
        return toolLineText(data?.name, data?.request, { done: true, prefix });
    }

    /**
     * One line of live activity. Goes into the timeline (which owns grouping and
     * ordering); the DOM follows. The old version built nodes here and cached the
     * open group's node — that cache went stale after any panel rebuild and the
     * feed visibly stopped nesting.
     */
    _setResultLive(text, type = 'live', meta = null) {
        if (!text || this._taskFinished) return;
        const str = String(text);
        // Status updates fire many times per step — skip an exact repeat.
        if (this._lastLiveText === str) return;
        // The narration bubble already streamed this step's reasoning as prose;
        // the trailing `thought` event is an extract of the same response, so a
        // feed line would echo it. (JSON-mode models have no narration, so their
        // feed line remains the fallback.)
        if ((type === 'thought' || type === 'live') && this._narrationText) {
            const nar = String(this._narrationText).trim();
            const s = str.trim();
            if (nar && s && (nar.includes(s) || s.includes(nar))) return;
        }
        this._lastLiveText = str;

        this._liveActivitySeen = true;
        this._setWorkingLabel(true);
        this._timeline.pushActivity(type, str, meta);
        this._renderResultPanel();
    }


    /** Sync the header status badge with the live status (running → completed/failed). */
    _syncStatusBadge() {
        this._syncStopButton();   // A: keep the ⏹ stop button in sync with run state
        this._syncHeader();
    }

    /** Abort the running task — the header's ⏹, and the steer row's ⏹ Stop. */
    _abortTask() {
        if (!confirm('Abort this agent task?')) return;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ action: 'abort' }));
        } else if (window.apiClient && this.selectedTaskId) {
            window.apiClient.abortTask(this.selectedTaskId);
        }
        // The button is prop-driven: the status change that follows swaps it for
        // Delete on its own, so there is nothing to disable by hand.
    }

    /** Remove the task from history (memory + disk), then go back to the list. */
    async _deleteTask() {
        if (!this.selectedTaskId) return;
        if (!confirm('Delete this task from history? This cannot be undone.')) return;
        try {
            await window.apiClient.deleteTaskHistory(this.selectedTaskId);
            invalidateTasksCache();
            this.selectedTaskId = null;
            // We were at #monitor?id=X, so this hash change re-renders the view.
            window.location.hash = '#monitor';
        } catch (e) {
            alert('Failed to delete: ' + (e.message || e));
        }
    }

    /**
     * Push the whole header state to TaskHeader.svelte.
     *
     * ONE function for what used to be a dozen `getElementById(...).textContent =`
     * writes spread over four call sites (the replay flush, the live token_usage
     * handler, the status handler, and the completion handler). Each of those
     * could — and did — go stale on its own when the markup moved.
     *
     * Called on every status change, token_usage event and timeline render, so it
     * must stay cheap: it is a prop assignment, and Svelte updates only the text
     * nodes whose value actually changed.
     */
    _syncHeader() {
        const el = document.getElementById('task-header');
        if (!el) return;
        const task = (this.tasks || []).find(t => t.id === this.selectedTaskId) || null;
        if (!task) return;
        // The live status wins, except before the socket has said anything.
        const status = (this.currentStatus && this.currentStatus !== 'idle')
            ? this.currentStatus : task.status;

        this._header = mountComponent(TaskHeader, el, {
            task,
            status,
            steps: this._timeline.items.filter(i => i.kind === 'group').length,
            usage: this._usageTotals(),
            context: this._contextReading,
            // Elapsed measures against the clock while running, so the component
            // needs a changing input to recompute it.
            now: Date.now(),
            onAbort: () => this._abortTask(),
            onDelete: () => this._deleteTask(),
        });
    }

    /**
     * Keep `this.tasks` and the LEFT-LIST row of the current task in sync with
     * live WS state. Without this the list showed stale dots/statuses (a task
     * that finished while watched stayed "running" in the list) until a full
     * reload happened to refetch.
     */
    _syncTaskEntry(status, progress) {
        // Update the MODEL, then re-push. This used to end with a dozen lines that
        // reached into the row and patched its className, its status dot and its
        // progress bar by hand — the row is derived from the task now, and
        // `rowStatus` (monitor/taskList.js) owns the waiting→running mapping.
        const t = (this.tasks || []).find(x => x.id === this.selectedTaskId);
        if (!t) return;
        t.status = rowStatus(status);
        if (typeof progress === 'number') t.progress = progress;
        this._syncTaskList();
    }

    /**
     * Context gauge — shows how full the model's context window currently is,
     * as `usedK / limitK (pct%)` + a fill bar. Fed by each token_usage event:
     * `context_used`/`context_limit` when present (newer AgentController), else
     * derived from the call's input-side token counts, with the active
     * connection's effective limit as the limit fallback.
     */
    _updateContextGauge(d) {
        let limit = 0;
        try { limit = llmService.getEffectiveModelLimit?.() || 0; } catch (_) {}
        const reading = contextReading(d, limit);
        // null = a tool-only step with no LLM call. KEEP the last reading; drawing
        // a zero would read as "the context emptied".
        if (!reading) return;
        this._contextReading = reading;
        this._syncHeader();
    }

    /** Hide the live-activity strip (task finished / stopped). */
    _hideResultLive() {
        const el = document.getElementById('result-live');
        if (el) el.style.display = 'none';
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
    /**
     * @param {string} text     header text (the step's "story")
     * @param {string} [type]   feed/severity type
     * @param {string} [feedText] when given, the FEED shows this instead of `text`.
     *   Needed because the two surfaces want different things: on tool completion
     *   the HEADER should show the step's thought, but echoing that thought into
     *   the chronological feed repeated it right after its own "Running: X" line
     *   (the reported duplicate). The feed gets the tool's own action instead.
     */
    _updateActiveStepStatus(text, type = 'live', feedText = undefined, meta = null) {
        // The compact live strip reflects the LATEST activity (no priority gating) —
        // it's the "what's happening right now" indicator shown above both views.
        this._setResultLive(feedText === undefined ? text : feedText, type, meta);

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

    /**
     * Handle a click inside an approval card, wherever that card is rendered.
     *
     * Lives in one method because the card appears in TWO surfaces — the Story
     * timeline and the Raw Log step body — and duplicating this once already left
     * one of them dead.
     *
     * @param {MouseEvent} e
     * @returns {boolean} true when the click belonged to an approval card, so the
     *          caller can stop looking for other targets.
     */
    _onConfirmCardClick(e) {
        if (e.target.closest('.acm-open')) { this._showApprovedCommandsModal(); return true; }
        const cb = e.target.closest('.cb-autows');
        if (cb) { this._setWsAutoApprove(cb.getAttribute('data-ws'), cb.checked); return true; }
        const always  = e.target.closest('.btn-approve-always');
        const approve = e.target.closest('.btn-approve');
        const reject  = e.target.closest('.btn-reject');
        if (always)  { this.sendConfirmResponse(always.getAttribute('data-confirm-id'), true, /*always*/ true); return true; }
        if (approve) { this.sendConfirmResponse(approve.getAttribute('data-confirm-id'), true); return true; }
        if (reject)  { this.sendConfirmResponse(reject.getAttribute('data-confirm-id'), false); return true; }
        return false;
    }

    sendConfirmResponse(confirmId, approved, always = false) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ event: 'confirm_response', data: { confirmId, approved, always, modifiedContent: null } }));
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
        // The same approval can be shown in TWO places (All Logs step body + the
        // Task view) — both share data-confirm-card, so resolve every copy.
        const cards = document.querySelectorAll(`[data-confirm-card="${confirmId}"]`);
        if (!cards.length) return;
        const suffix = byOther ? ' <span style="opacity:0.6;font-weight:400;font-size:11px">(by another client)</span>' : '';
        cards.forEach(card => {
            const actions = card.querySelector('.mconfirm-actions');
            if (!actions) return;
            const stillPending = !!(actions.querySelector('.btn-approve') || actions.querySelector('.btn-reject'));
            if (!stillPending) return;
            actions.innerHTML = approved
                ? `<span style="color:var(--success);font-weight:600">🟢 Approved${suffix}</span>`
                : `<span style="color:var(--error);font-weight:600">🔴 Rejected${suffix}</span>`;
        });
        // Settle the timeline's confirm item shortly after, so the card stops
        // reading as pending. Guarded on the id we are still tracking: a newer
        // approval — possibly of another task after navigation — must not be
        // resolved by a stale timer.
        setTimeout(() => {
            if (this._destroyed) return;
            if (this._confirmId === String(confirmId)) this._clearTaskConfirm();
        }, 1200);

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

    async _showChatModal(entries) {
        const overlay = document.getElementById('mchat-modal-overlay');
        const body    = document.getElementById('mchat-modal-body');
        const title   = document.getElementById('mchat-modal-title');
        if (!overlay || !body) return;

        // Slim entries (listing/replay strips history / system_prompt /
        // sent_request / tools — the O(steps²) payload fix): lazily fetch the
        // FULL entry for this modal only. Failures degrade to the slim view.
        try {
            await Promise.all((entries || []).map(async (en) => {
                if (en?.request?._slim && Number.isFinite(en?._idx)
                    && window.apiClient && this.selectedTaskId) {
                    const full = await window.apiClient.getTaskLogEntry(this.selectedTaskId, en._idx);
                    if (full?.data?.request) {
                        en.request = full.data.request;
                        if (full.data.response !== undefined) en.response = full.data.response;
                    }
                }
            }));
        } catch (_) { /* show the slim payload */ }

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
                ? `↑${d.usage.prompt_tokens||0}${(d.usage.cache_read_input_tokens||0) > 0 ? ` (cached ${d.usage.cache_read_input_tokens})` : ''}${(d.usage.cache_creation_input_tokens||0) > 0 ? ` (+cache ${d.usage.cache_creation_input_tokens})` : ''} / ↓${d.usage.completion_tokens||0} / total: ${d.usage.total_tokens||0} tokens`
                : '';

            const r = safeObj(d.request);
            const systemText = typeof r.system_prompt === 'string' ? r.system_prompt : '';
            const historyArr = Array.isArray(r.history) ? r.history : (Array.isArray(r.messages) ? r.messages : null);
            const toolsArr   = Array.isArray(r.tools) ? r.tools : null;
            // Scalar request params (model / tool_calling / temperature / max_tokens / …).
            const paramsObj = {};
            for (const k of Object.keys(r)) {
                if (['system_prompt', 'history', 'messages', 'tools', 'url', 'headers', 'sent_request'].includes(k)) continue;
                if (typeof r[k] === 'string' && r[k].trim() === '') continue;
                paramsObj[k] = r[k];
            }
            const responseText = unescapeNL(typeof d.response === 'string'
                ? d.response
                : (d.response ? JSON.stringify(d.response, null, 2) : (d.error || '')));

            // The EXACT assembled body sent to the provider (cache_control, system
            // stable/volatile split, trailing volatile message, messages in send
            // order). Shown FIRST so you can read the request as actually thrown.
            const sentRaw = r.sent_request != null
                ? (typeof r.sent_request === 'string' ? r.sent_request : JSON.stringify(r.sent_request, null, 2))
                : '';

            // Build the tab set (only include tabs that have content).
            const tabs = [];
            if (sentRaw) tabs.push({ key: 'sent', label: '📡 Sent (raw)', content: sentRaw });
            if (Object.keys(paramsObj).length) tabs.push({ key: 'params', label: '⚙ Params', content: JSON.stringify(paramsObj, null, 2) });
            if (systemText) tabs.push({ key: 'system', label: '🧾 System (pre-assembly)', content: systemText });
            if (historyArr) tabs.push({ key: 'history', label: `💬 History (${historyArr.length})`, content: fmtMsgArray(historyArr, 'history') });
            if (toolsArr) tabs.push({ key: 'tools', label: `🛠 Tools (${toolsArr.length})`, content: JSON.stringify(toolsArr, null, 2) });
            tabs.push({ key: 'response', label: '📤 Response', content: responseText || '(empty)' });
            if (d.headers) tabs.push({ key: 'headers', label: '🔖 Headers', content: JSON.stringify(d.headers, null, 2) });

            // Default to the as-sent body when available, else History.
            const preferred = tabs.findIndex(t => t.key === 'sent');
            const defaultIdx = Math.max(0, preferred >= 0 ? preferred : tabs.findIndex(t => t.key === 'history'));
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
                    <div class="mchat-subtabs">
                        ${tabBtns}
                        <button class="mchat-copy" data-grp="${grp}" title="Copy the visible tab" style="margin-left:auto;background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-secondary);font-size:11px;padding:2px 8px;border-radius:5px;cursor:pointer;">📋 Copy</button>
                    </div>
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

        // Per-entry "Copy" — copies the CURRENTLY-VISIBLE tab's raw text.
        body.querySelectorAll('.mchat-copy').forEach(btn => {
            btn.addEventListener('click', async () => {
                const grp = btn.getAttribute('data-grp');
                const panels = [...body.querySelectorAll(`.mchat-panel[data-grp="${grp}"]`)];
                const panel = panels.find(p => p.style.display !== 'none');
                const text = panel ? panel.textContent : '';
                try {
                    await navigator.clipboard.writeText(text);
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copied';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                } catch (_) { /* clipboard blocked */ }
            });
        });

        overlay.classList.add('open');
    }

    // ─── init() ─────────────────────────────────────────────────────────────

    init() {
        // Setup CHAT modal overlay (once, appended to body)
        this._setupChatModal();

        // Task list: one prop push. Its clicks, its filters and its group collapse
        // are the component's own (TaskList.svelte).
        this._syncTaskList();

        // New-task button → creation modal (DirectChat replacement; Phase 1)
        const newTaskBtn = document.getElementById('btn-new-task');
        if (newTaskBtn) {
            newTaskBtn.addEventListener('click', () => this._openNewTaskModal());
        }
        // Ctrl+N (⌘N) → open the new-task modal from anywhere in the Monitor.
        // Stored on the instance so destroy() can release it (document-level).
        this._newTaskKeyHandler = (e) => {
            if (this._destroyed) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
                if (document.getElementById('mnt-modal-overlay')) return;  // already open
                e.preventDefault();
                this._openNewTaskModal();
            }
        };
        document.addEventListener('keydown', this._newTaskKeyHandler);
        // Auto-open the modal when arriving from the Dashboard's "New Task" button.
        try {
            if (localStorage.getItem('jh_open_new_task')) {
                localStorage.removeItem('jh_open_new_task');
                this._openNewTaskModal();
            }
        } catch (_) {}

        // NOTE: the search box, the status select and the date/WS toggle are all
        // TaskList.svelte's, wired through the onSearch / onStatusFilter / onGroupBy
        // props in _syncTaskList. They each used to need their own listener plus a
        // re-render-and-rebind helper.

        this._bindDetailEvents();
        this._autoConnect();
    }

    /**
     * Bind every handler that lives INSIDE the right detail panel. Called from
     * init() AND from _switchTask() (in-place task switching replaces the
     * panel's DOM, so element listeners die with it and must be rebound; the
     * one window-level listener — Tauri drag-drop — is tracked in
     * this._dragUnlisten and released before rebinding).
     */
    _bindDetailEvents() {
        if (this._dragUnlisten) { try { this._dragUnlisten(); } catch (_) {} this._dragUnlisten = null; }

        // The header is a migrated region: the markup _renderDetail returned is
        // just an empty mount point, so it has to be populated here rather than
        // being part of the template string.
        this._syncHeader();

        // ── Project instructions (.agent/instructions.md) ──────────────────
        // The file feeds the agent's system prompt verbatim, but nothing in the
        // UI used to reveal that it exists. Open it if present; otherwise create
        // it from a template first, so the feature is discoverable.
        document.getElementById('btn-load-earlier')
            ?.addEventListener('click', () => this.loadEarlierLogs());
        document.getElementById('btn-fold-all')
            ?.addEventListener('click', () => this._toggleAllExchanges());

        // Redraw the connected-apps strip when an app connects or drops, not
        // only when the task re-renders.
        if (!this._mcpUnwatch) {
            this._mcpUnwatch = mcpManager.onChange(() => {
                if (!this._destroyed) this._renderHubStrip();
            });
        }

        document.getElementById('btn-inspector')?.addEventListener('click', () => {
            this._inspectorOpen = !this._inspectorOpen;
            try { localStorage.setItem('jhai_inspector_open', this._inspectorOpen ? '1' : '0'); } catch (_) {}
            this._renderResultPanel();
        });

        // The task list folds away too — on a laptop the reading surface is worth
        // more than a list you have already used to get here.
        document.getElementById('btn-toggle-list')?.addEventListener('click', () => {
            this._listCollapsed = !this._listCollapsed;
            try { localStorage.setItem('jhai_list_collapsed', this._listCollapsed ? '1' : '0'); } catch (_) {}
            this._applyListCollapsed();
        });
        this._applyListCollapsed();

        // NOTE: the header's Abort and Delete are TaskHeader.svelte's, wired
        // through props to _abortTask / _deleteTask below.

        // A: stop button in the steer row — aborts the running task (same as the
        // header Abort, but reachable from the bottom where the work happens).
        const stopBtn = document.getElementById('btn-stop-steering');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (!confirm('Stop this running task?')) return;
                if (this.socket?.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ action: 'abort' }));
                } else if (window.apiClient && this.selectedTaskId) {
                    window.apiClient.abortTask(this.selectedTaskId);
                }
                stopBtn.disabled = true; stopBtn.textContent = 'Stopping…';
            });
        }

        // C: "new activity" pill → jump to the bottom; scroll listener hides it once
        // the user is back at the bottom on their own.
        const jumpBtn = document.getElementById('result-jump');
        if (jumpBtn) jumpBtn.addEventListener('click', () => this._scrollTaskToBottom());
        // #4: click the "Working" label to fold/unfold the activity list.
        const liveLabel = document.getElementById('result-live-label');
        if (liveLabel) liveLabel.addEventListener('click', () => this._setFeedCollapsed(!this._feedCollapsed));
        const resultPanelEl = document.getElementById('result-panel');
        if (resultPanelEl) {
            // The pill tracks the SCROLL POSITION, not the arrival of new content:
            // scrolling up to read is exactly when you want a way back down, even
            // on a finished task where nothing more is coming.
            resultPanelEl.addEventListener('scroll', () => {
                const atBottom = this._isTaskAtBottom();
                // Remember that the reader LEFT the bottom. Auto-follow then stops
                // until they come back — measuring "am I at the bottom" per render
                // was not enough, because a tall card can arrive and move the
                // bottom out from under them mid-read.
                this._userScrolledUp = !atBottom;
                const j = document.getElementById('result-jump');
                if (j) j.style.display = atBottom ? 'none' : 'block';
            });
            // Delegated: expand/collapse long requests, zoom attached images, and
            // the approval card's buttons.
            //
            // The approval buttons MUST be delegated from here. They are rendered
            // inside the timeline (#task-timeline, a child of this panel) by the
            // single-timeline redesign; the handler was still bound to the old
            // #result-confirm slot, which that redesign deleted — so
            // getElementById returned null, no listener was ever attached, and
            // Approve/Reject in the Story view did nothing at all.
            resultPanelEl.addEventListener('click', (e) => {
                if (this._onConfirmCardClick(e)) return;
                const img = e.target.closest('.mrc-img');
                if (img) this._openImageZoom(img.src);
            });
        }

        // NOTE: the ask_user card's own choices are rendered by the timeline and
        // wired through ctx.onAnswer (see _timelineCtx), not from here. The
        // #result-ask slot this used to bind to no longer exists.

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

                // ② Approval card: manage link, auto-approve toggle, Approve /
                //    Always-allow / Reject. Same method the Story surface uses.
                if (this._onConfirmCardClick(e)) return;

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

        // Filter buttons (All Logs ↔ Result)
        const filterBtns = document.querySelectorAll('.mfilter-btn');
        const resultPanel = document.getElementById('result-panel');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this._userPickedTab = true;
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const filter = btn.getAttribute('data-filter');
                if (filter === 'result') {
                    if (consoleEl) consoleEl.style.display = 'none';
                    if (resultPanel) { resultPanel.style.display = 'block'; this._renderResultPanel(); }
                } else {
                    if (resultPanel) resultPanel.style.display = 'none';
                    if (consoleEl) {
                        // Lazily build the All Logs DOM the first time it's opened
                        // (deferred from loadHistoricalLogs to keep tab-open fast).
                        if (this._allLogsDirty) {
                            consoleEl.innerHTML = this.renderAllLogs();
                            this._allLogsDirty = false;
                        }
                        consoleEl.style.display = '';
                    }
                }
            });
        });

        // Steering
        const steerBtn   = document.getElementById('btn-send-steering');
        const steerInput = document.getElementById('input-steering');
        const steerAttachBtn = document.getElementById('steer-btn-attach');
        const steerFileInput = document.getElementById('steer-file-input');
        const steerPreviews = document.getElementById('steer-input-previews');
        
        if (steerBtn && steerInput) {
            let slash = null;
            let attachments = [];
            
            try {
                slash = new SlashCommands(steerInput, document.getElementById('steer-slash-popup'), document.getElementById('steer-input-skills'));
            } catch (err) {
                console.error("Failed to init SlashCommands:", err);
            }

            const renderPreviews = () => {
                if (!steerPreviews) return;
                if (attachments.length === 0) { steerPreviews.style.display = 'none'; steerPreviews.innerHTML = ''; return; }
                steerPreviews.style.display = 'flex';
                steerPreviews.innerHTML = attachments.map(a => a.type === 'image'
                    ? `<div class="nt-prev" data-id="${a.id}" style="position:relative;border:1px solid var(--border);border-radius:6px;padding:4px;background:var(--bg-tertiary);">
                           <img src="${a.dataUrl}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;display:block;cursor:zoom-in;">
                           <button class="nt-prev-x" title="Remove" style="position:absolute;top:-6px;right:-6px;background:var(--error);border:none;color:#fff;width:16px;height:16px;border-radius:50%;font-size:9px;cursor:pointer;">✕</button>
                       </div>`
                    : `<div class="nt-prev" data-id="${a.id}" style="position:relative;display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:4px 20px 4px 8px;background:var(--bg-tertiary);font-size:11px;color:var(--text-secondary);max-width:180px;">
                           <span>📄</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.name)}</span>
                           <button class="nt-prev-x" title="Remove" style="position:absolute;top:2px;right:2px;background:none;border:none;color:var(--error);cursor:pointer;font-size:10px;">✕</button>
                       </div>`).join('');
                steerPreviews.querySelectorAll('.nt-prev-x').forEach(btn => btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = btn.closest('.nt-prev').getAttribute('data-id');
                    const i = attachments.findIndex(a => a.id === id);
                    if (i >= 0) { attachments.splice(i, 1); renderPreviews(); }
                }));
                steerPreviews.querySelectorAll('.nt-prev img').forEach(img => {
                    img.addEventListener('click', () => this._openImageZoom(img.src));
                });
            };

            const handleFile = (file) => {
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) { alert('File is too large (max 10MB).'); return; }
                const isImage = file.type.startsWith('image/');
                const isExcel = /\.(xlsx|xls|ods)$/i.test(file.name);
                const reader = new FileReader();
                reader.onload = async (e) => {
                    let dataUrl = null, content = null;
                    if (isImage) {
                        dataUrl = e.target.result;
                    } else if (isExcel) {
                        try {
                            const bytes = new Uint8Array(e.target.result);
                            content = await invoke('parse_excel_to_html', { bytes: Array.from(bytes), ext: file.name.split('.').pop() || '' });
                        } catch (err) { alert(`Failed to parse Excel: ${err.message || err}`); return; }
                    } else {
                        content = reader.result;
                    }
                    attachments.push({ id: Math.random().toString(36).slice(2, 8), name: file.name, type: isImage ? 'image' : 'file', dataUrl, content });
                    renderPreviews();
                };
                if (isImage) reader.readAsDataURL(file);
                else if (isExcel) reader.readAsArrayBuffer(file);
                else reader.readAsText(file);
            };

            if (steerAttachBtn && steerFileInput) {
                steerAttachBtn.addEventListener('click', () => steerFileInput.click());
                steerFileInput.addEventListener('change', (e) => {
                    for (const f of e.target.files) handleFile(f);
                    steerFileInput.value = '';
                });
            }

            steerInput.addEventListener('paste', (e) => {
                for (const it of (e.clipboardData?.items || [])) {
                    if (it.type.indexOf('image') !== -1) handleFile(it.getAsFile());
                }
            });

            // Native Tauri Drag and Drop handling (window-level listener —
            // tracked on the instance so _bindDetailEvents/destroy release it;
            // it used to leak one listener per view instance).
            const setDragHL = (on) => { 
                const box = steerInput.closest('.msteering-wrapper');
                if (box) { box.style.outline = on ? '2px dashed var(--accent)' : ''; box.style.outlineOffset = on ? '-4px' : ''; }
            };
            const readDroppedPath = async (path) => {
                try {
                    const fd = await invoke('read_file_bytes', { path });
                    const bytes = new Uint8Array(fd.bytes);
                    const ext = (fd.ext || '').toLowerCase();
                    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
                    const mime = mimeMap[ext] || 'application/octet-stream';
                    handleFile(new File([new Blob([bytes], { type: mime })], fd.name, { type: mime }));
                } catch (e) { console.error('Dropped file read failed:', e); }
            };
            // Tauri v2: getCurrentWebviewWindow lives in .../webviewWindow (NOT .../window).
            // Wrapped so a resolution/API mismatch can't throw an uncaught promise error.
            import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
                if (typeof getCurrentWebviewWindow !== 'function') return;
                getCurrentWebviewWindow().onDragDropEvent((event) => {
                    if (!document.getElementById('input-steering')) return;
                    const t = event.payload.type;
                    if (t === 'enter' || t === 'over') setDragHL(true);
                    else if (t === 'drop') { setDragHL(false); for (const p of (event.payload.paths || [])) readDroppedPath(p); }
                    else setDragHL(false);
                }).then(un => {
                    // View already destroyed / rebound while awaiting → release now.
                    if (this._destroyed || this._dragUnlisten) { try { un(); } catch (_) {} }
                    else this._dragUnlisten = un;
                }).catch(() => {});
            }).catch(() => {});

            const sendSteer = async () => {
                const rawText = steerInput.value.trim();
                if ((!slash || !slash.hasContent(rawText)) && attachments.length === 0) return;
                
                let prompt = await (slash ? slash.buildPrompt(rawText) : rawText);
                const fileAtts = attachments.filter(a => a.type === 'file');
                if (fileAtts.length > 0) {
                    prompt += '\n\n' + fileAtts.map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\`\n`).join('\n');
                }
                const images = attachments.filter(a => a.type === 'image').map(a => a.dataUrl);

                // Any pending ask_user card is now being answered — drop it.
                this._clearAskCard();
                // Show the sent message instantly in the Task tab as a chat bubble
                // (mirrors ChatView), INCLUDING attached image thumbnails so the
                // attachment is visible after sending. Cleared when the run
                // completes and the real request→answer bubble replaces it.
                this._showPendingUser(rawText || prompt, images);

                if (this._taskFinished) {
                    steerInput.value = '';
                    steerInput.style.height = '';   // collapse back to one row
                    attachments = []; renderPreviews();
                    if (slash) { slash.activeSkills = []; slash._renderChips(); }
                    
                    steerInput.disabled = true; steerBtn.disabled = true;
                    if (steerAttachBtn) steerAttachBtn.disabled = true;

                    if (consoleEl) {
                        // Boundary line between the previous turn and this new one, so a
                        // continued conversation reads as distinct exchanges in All Logs.
                        consoleEl.insertAdjacentHTML('beforeend',
                            `<div class="mturn-divider"><span>↪ continued</span></div>` +
                            `<div class="mlog mlog-status"><span class="mlog-icon">↪</span><span class="mlog-body" style="color:var(--accent)"><strong>Continue:</strong> ${escapeHtml(prompt)}</span></div>`);
                    }
                    try {
                        const payload = { message: prompt };
                        if (images.length > 0) payload.images = images;
                        // Stamp the cutoff BEFORE kicking off the new run so every
                        // event from here on is treated as live; the reconnect's
                        // replay of older events (< cutoff) is discarded.
                        this._replayCutoffTs = Date.now();
                        await window.apiClient.continueTask(this.selectedTaskId, payload);
                        this._taskFinished = false;
                        // preserveResults: keep prior run bubbles so the Task tab
                        // reads as one continuous conversation across continues.
                        this.connectWebSocket(this.selectedTaskId, /*preserveResults*/ true);
                    } catch (e) {
                        console.error('continueTask failed:', e);
                        steerInput.disabled = false; steerBtn.disabled = false;
                        if (steerAttachBtn) steerAttachBtn.disabled = false;
                        alert(`Failed to continue: ${e.message || e}`);
                    }
                    return;
                }
                if (this.socket?.readyState === WebSocket.OPEN) {
                    const payload = { message: prompt };
                    if (images.length > 0) payload.images = images;
                    this.socket.send(JSON.stringify({ event: 'steering', data: payload }));
                    if (consoleEl) {
                        consoleEl.insertAdjacentHTML('beforeend',
                            `<div class="mlog mlog-status"><span class="mlog-icon">👉</span><span class="mlog-body" style="color:var(--accent)"><strong>Steered:</strong> ${escapeHtml(prompt)}</span></div>`);
                        consoleEl.scrollTop = consoleEl.scrollHeight;
                    }
                    steerInput.value = '';
                    steerInput.style.height = '';   // collapse back to one row
                    attachments = []; renderPreviews();
                    if (slash) { slash.activeSkills = []; slash._renderChips(); }
                }
            };
            // Auto-grow the steer box with its content (up to the CSS max-height,
            // after which it scrolls internally). Shift+Enter / Enter insert newlines;
            // only Ctrl+Enter sends — so the box needs to expand as the user types.
            const autoGrowSteer = () => {
                steerInput.style.height = 'auto';
                steerInput.style.height = Math.min(steerInput.scrollHeight, 160) + 'px';
            };
            this._autoGrowSteer = autoGrowSteer;
            steerInput.addEventListener('input', autoGrowSteer);

            steerBtn.addEventListener('click', sendSteer);
            steerInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendSteer(); }
            });
        }
    }

    /**
     * Auto-connect — verify the CURRENT status first. The left-list data can
     * be up to TASKS_CACHE_MS stale; deciding live-vs-historical from it
     * sometimes picked "historical" for a task that was actually RUNNING,
     * leaving a frozen view with no updates until the user switched away and
     * back (the reported bug). One cheap GET /tasks/:id makes it correct.
     */
    _autoConnect() {
        if (this.selectedTaskId) {
            const cached = this.tasks.find(t => t.id === this.selectedTaskId);
            if (cached) {
                (async () => {
                    let task = cached;
                    try {
                        const fresh = await window.apiClient?.getTask(this.selectedTaskId);
                        if (fresh && fresh.id) {
                            task = fresh;
                            // Sync the (possibly stale) list entry + header badge.
                            const i = this.tasks.findIndex(t => t.id === fresh.id);
                            if (i >= 0) this.tasks[i] = { ...this.tasks[i], ...fresh };
                        }
                    } catch (_) { /* offline / old backend — fall back to cached */ }
                    if (this._destroyed || this.selectedTaskId !== task.id) return;
                    if (task.status === 'running') this.connectWebSocket(task.id);
                    else this.loadHistoricalLogs(task.id);
                })();
            }
        }
    }

    /**
     * New-task creation modal (Phase 1 — the DirectChat-as-launcher replacement).
     * Keeps the useful chat settings (agent mode, workspace, MCP servers) and a
     * large prompt box, WITHOUT the chat transcript. On send it creates an agent
     * task via POST /tasks (same path as DirectChat agent mode) and navigates to
     * that task in the Monitor so you watch it where it runs.
     */
    /** Full-size image lightbox (click an attachment thumbnail to zoom). */
    _openImageZoom(src) {
        const z = document.createElement('div');
        z.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:5000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;';
        z.innerHTML = `<img src="${src}" style="max-width:96vw;max-height:92vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);">`;
        const close = () => { try { document.body.removeChild(z); } catch (_) {} document.removeEventListener('keydown', onEsc); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        z.addEventListener('click', close);
        document.addEventListener('keydown', onEsc);
        document.body.appendChild(z);
    }

    async _openNewTaskModal(presetWs = null) {
        let config = {};
        try { config = (await invoke('get_ai_config')) || {}; } catch (_) {}
        const projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
        // An explicit workspace (e.g. the "＋" on a WS group header) wins over the
        // remembered / first-project default.
        const defaultWs = presetWs || this._lastNewTaskWs || projects[0] || '';
        const mcpServers = config.mcp_servers || {};
        const running = new Set(mcpManager.clients.keys());

        const modeDropdown = new ModeDropdown(this._lastNewTaskMode || DEFAULT_MODE_ID);

        const wsDatalist = projects.map(p => `<option value="${escapeHtml(p)}"></option>`).join('');

        const mcpHtml = Object.keys(mcpServers).length === 0
            ? `<div style="font-size:11.5px;color:var(--text-tertiary)">No MCP servers configured (Settings → MCP).</div>`
            : Object.keys(mcpServers).map(name => `
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;">
                    <input type="checkbox" class="nt-mcp-cb" data-name="${escapeHtml(name)}" ${running.has(name) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                </label>`).join('');

        const overlay = document.createElement('div');
        overlay.id = 'mnt-modal-overlay';   // lets Ctrl+N detect it's already open
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;`;
        overlay.innerHTML = `
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;width:640px;max-width:92vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.5);">
                <div style="padding:14px 18px;border-bottom:1px solid var(--border);background:var(--bg-tertiary);display:flex;justify-content:space-between;align-items:center;">
                    <strong style="font-size:15px;display:flex;align-items:center;gap:7px;"><span style="color:var(--accent);display:inline-flex">${icon('bolt')}</span>New Task</strong>
                    <button class="nt-close" style="background:none;border:none;color:var(--text-primary);cursor:pointer;font-size:18px;">✖</button>
                </div>
                <div style="padding:16px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;">
                    <div>
                        <label class="input-label" style="font-size:11px;">Workspace (required for agent tasks)</label>
                        <div style="display:flex;gap:8px;">
                            <input type="text" id="nt-ws" class="input" value="${escapeHtml(defaultWs)}" list="nt-ws-list" placeholder="C:\\path\\to\\project" style="flex:1;">
                            <datalist id="nt-ws-list">${wsDatalist}</datalist>
                            <button class="btn btn-secondary nt-browse" type="button" style="padding:0 12px;display:flex;align-items:center;">${icon('folder')}</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:14px;flex-wrap:wrap;">
                        <div style="flex:1;min-width:180px;">
                            <label class="input-label" style="font-size:11px;">Agent mode</label>
                            ${modeDropdown.render()}
                        </div>
                    </div>
                    <div>
                        <label class="input-label" style="font-size:11px;">MCP servers to use (optional)</label>
                        <div style="display:flex;flex-wrap:wrap;gap:14px;padding:8px 10px;border:1px solid var(--border-light);border-radius:6px;background:var(--bg-tertiary);">
                            ${mcpHtml}
                        </div>
                    </div>
                    <div style="position:relative;">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <label class="input-label" style="font-size:11px;margin:0;">Task <span style="opacity:0.6">(/ to expand a template or attach a skill)</span></label>
                            <button class="btn btn-secondary nt-attach" type="button" style="height:24px;padding:0 8px;font-size:11px;display:flex;align-items:center;gap:4px;" title="Attach image or file">📎 Attach</button>
                            <input type="file" id="nt-file-input" style="display:none;" multiple accept="image/*,text/*,.log,.json,.md,.js,.py,.rs,.csv,.xlsx,.xls">
                        </div>
                        <div id="nt-skill-chips" class="sc-chips" style="display:none;margin-top:6px;"></div>
                        <div id="nt-previews" style="display:none;flex-wrap:wrap;gap:8px;margin-top:6px;"></div>
                        <div id="nt-slash-popup" class="slash-popup" style="display:none;"></div>
                        <textarea id="nt-prompt" class="input" rows="8" placeholder="Describe the task to run…  (/ for commands, Ctrl+Enter to create, paste images too)" style="width:100%;resize:vertical;min-height:160px;font-size:13.5px;line-height:1.6;margin-top:6px;"></textarea>
                    </div>
                </div>
                <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;">
                    <button class="btn btn-secondary nt-cancel">Cancel</button>
                    <button class="btn btn-primary nt-send">Create & Run ▶</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        let dragUnlisten = null;
        const close = () => {
            if (dragUnlisten) { try { dragUnlisten(); } catch (_) {} dragUnlisten = null; }
            try { document.body.removeChild(overlay); } catch (_) {}
        };
        overlay.querySelector('.nt-close').onclick = close;
        overlay.querySelector('.nt-cancel').onclick = close;
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

        const wsInput = overlay.querySelector('#nt-ws');
        const textarea = overlay.querySelector('#nt-prompt');
        const sendBtn = overlay.querySelector('.nt-send');
        modeDropdown.init(); // custom dropdown (SVG icons + per-row descriptions)

        // "/" command popup — templates EXPAND, skills ATTACH as chips (same as
        // ChatView); skill bodies are injected at send via slash.buildPrompt().
        promptTemplateManager.loadFromConfig(config);
        skillManager.refresh().catch(() => {});
        const slash = new SlashCommands(textarea, overlay.querySelector('#nt-slash-popup'), overlay.querySelector('#nt-skill-chips'));

        // ── Image / file attachments ─────────────────────────────────────
        // Images → sent to the LLM (task `images`). Text/Excel files → their
        // content is appended to the prompt at send (same as ChatView).
        const attachments = [];
        const fileInput = overlay.querySelector('#nt-file-input');
        const previews = overlay.querySelector('#nt-previews');
        const renderPreviews = () => {
            if (attachments.length === 0) { previews.style.display = 'none'; previews.innerHTML = ''; return; }
            previews.style.display = 'flex';
            previews.innerHTML = attachments.map(a => a.type === 'image'
                ? `<div class="nt-prev" data-id="${a.id}" style="position:relative;border:1px solid var(--border);border-radius:6px;padding:4px;background:var(--bg-tertiary);">
                       <img src="${a.dataUrl}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;display:block;">
                       <button class="nt-prev-x" title="Remove" style="position:absolute;top:-6px;right:-6px;background:var(--error);border:none;color:#fff;width:16px;height:16px;border-radius:50%;font-size:9px;cursor:pointer;">✕</button>
                   </div>`
                : `<div class="nt-prev" data-id="${a.id}" style="position:relative;display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:4px 20px 4px 8px;background:var(--bg-tertiary);font-size:11px;color:var(--text-secondary);max-width:180px;">
                       <span>📄</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.name)}</span>
                       <button class="nt-prev-x" title="Remove" style="position:absolute;top:2px;right:2px;background:none;border:none;color:var(--error);cursor:pointer;font-size:10px;">✕</button>
                   </div>`).join('');
            previews.querySelectorAll('.nt-prev-x').forEach(btn => btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.closest('.nt-prev').getAttribute('data-id');
                const i = attachments.findIndex(a => a.id === id);
                if (i >= 0) { attachments.splice(i, 1); renderPreviews(); }
            }));
            // Click an image thumbnail → zoom (#2).
            previews.querySelectorAll('.nt-prev img').forEach(img => {
                img.style.cursor = 'zoom-in';
                img.addEventListener('click', () => this._openImageZoom(img.src));
            });
        };
        const handleFile = (file) => {
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) { alert('File is too large (max 10MB).'); return; }
            const isImage = file.type.startsWith('image/');
            const isExcel = /\.(xlsx|xls|ods)$/i.test(file.name);
            const reader = new FileReader();
            reader.onload = async (e) => {
                let dataUrl = null, content = null;
                if (isImage) {
                    dataUrl = e.target.result;
                } else if (isExcel) {
                    try {
                        const bytes = new Uint8Array(e.target.result);
                        content = await invoke('parse_excel_to_html', { bytes: Array.from(bytes), ext: file.name.split('.').pop() || '' });
                    } catch (err) { alert(`Failed to parse Excel: ${err.message || err}`); return; }
                } else {
                    content = reader.result;
                }
                attachments.push({ id: Math.random().toString(36).slice(2, 8), name: file.name, type: isImage ? 'image' : 'file', dataUrl, content });
                renderPreviews();
            };
            if (isImage) reader.readAsDataURL(file);
            else if (isExcel) reader.readAsArrayBuffer(file);
            else reader.readAsText(file);
        };
        overlay.querySelector('.nt-attach').onclick = () => fileInput.click();
        fileInput.addEventListener('change', (e) => { for (const f of e.target.files) handleFile(f); fileInput.value = ''; });
        textarea.addEventListener('paste', (e) => {
            for (const it of (e.clipboardData?.items || [])) {
                if (it.type.indexOf('image') !== -1) handleFile(it.getAsFile());
            }
        });

        // ── Drag & drop (#1) — Tauri native file drops from Explorer/Finder ──
        // HTML5 drop doesn't receive OS files in Tauri; use the window drag-drop
        // event (gives file PATHS), read each, then feed into handleFile. Only
        // active while this modal is open (unlistened on close).
        const modalBox = overlay.firstElementChild;
        const setDragHL = (on) => { modalBox.style.outline = on ? '2px dashed var(--accent)' : ''; modalBox.style.outlineOffset = on ? '-4px' : ''; };
        const readDroppedPath = async (path) => {
            try {
                const fd = await invoke('read_file_bytes', { path });
                const bytes = new Uint8Array(fd.bytes);
                const ext = (fd.ext || '').toLowerCase();
                const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
                const mime = mimeMap[ext] || 'application/octet-stream';
                handleFile(new File([new Blob([bytes], { type: mime })], fd.name, { type: mime }));
            } catch (e) { console.error('Dropped file read failed:', e); }
        };
        getCurrentWebviewWindow().onDragDropEvent((event) => {
            const t = event.payload.type;
            if (t === 'enter' || t === 'over') setDragHL(true);
            else if (t === 'drop') { setDragHL(false); for (const p of (event.payload.paths || [])) readDroppedPath(p); }
            else setDragHL(false);
        }).then(un => { dragUnlisten = un; }).catch(() => {});

        textarea.focus();

        overlay.querySelector('.nt-browse').onclick = async () => {
            try { const sel = await invoke('select_folder'); if (sel) wsInput.value = sel; } catch (_) {}
        };

        const send = async () => {
            const rawText = textarea.value.trim();
            const ws = wsInput.value.trim();
            if (!slash.hasContent(rawText) && attachments.length === 0) { textarea.focus(); return; }
            if (!ws) { alert('Please specify a workspace (required for agent tasks).'); wsInput.focus(); return; }
            // Inject any attached skill bodies (preamble), then append file contents.
            let prompt = await slash.buildPrompt(rawText);
            const fileAtts = attachments.filter(a => a.type === 'file');
            if (fileAtts.length > 0) {
                prompt += '\n\n' + fileAtts.map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\`\n`).join('\n');
            }
            const images = attachments.filter(a => a.type === 'image').map(a => a.dataUrl);
            const modeId = modeDropdown.value;
            const selectedMcp = [...overlay.querySelectorAll('.nt-mcp-cb')]
                .filter(c => c.checked).map(c => c.getAttribute('data-name'));
            // Remember for next time (per view instance).
            this._lastNewTaskWs = ws;
            this._lastNewTaskMode = modeId;

            sendBtn.disabled = true;
            sendBtn.textContent = 'Creating…';
            try {
                // Start any selected MCP server that isn't running yet (best-effort).
                for (const name of selectedMcp) {
                    if (!mcpManager.clients.has(name)) {
                        try { await mcpManager.startClient(name, mcpServers[name]); }
                        catch (e) { console.warn(`MCP start failed for ${name}:`, e); }
                    }
                }
                // NOTE: do NOT pass behavior.mcp_servers — that flags the run as
                // an "external caller" in AgentController and strips the built-in
                // toolset. The selected servers are simply STARTED above; their
                // tools then surface globally (relevance-pruned), same as DirectChat.
                const behavior = { mode: 'iterative_agent', ...buildBehavior(modeId) };
                const res = await window.apiClient.request('/tasks', {
                    method: 'POST',
                    body: JSON.stringify({
                        prompt, workspace_path: ws, caller: 'NewTask', behavior,
                        images: images.length > 0 ? images : undefined,
                    })
                });
                const taskId = res.task_id;
                close();
                // Navigate to the new task in the Monitor (#2 — auto-select).
                // Invalidate the list cache so the just-created task shows up.
                invalidateTasksCache();
                this.selectedTaskId = taskId;
                window.location.hash = `#monitor?id=${taskId}`;
            } catch (e) {
                alert('Failed to create task: ' + (e.message || e));
                sendBtn.disabled = false;
                sendBtn.textContent = 'Create & Run ▶';
            }
        };
        sendBtn.onclick = send;
        const slashPopupEl = overlay.querySelector('#nt-slash-popup');
        textarea.addEventListener('keydown', (e) => {
            // Defer Enter/Escape/arrows to the "/" command popup when it's open.
            const slashOpen = slashPopupEl && slashPopupEl.style.display !== 'none';
            if (slashOpen && ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        });
    }

    destroy() {
        // Every hash change builds a FRESH MonitorView over the SAME DOM ids.
        // Anything async this instance still has in flight (WS messages, fetches,
        // timers) must become a no-op, or it writes the PREVIOUS task's data into
        // the NEW task's panels (the "other task's result shows up" bug).
        // Preserve the in-progress request + activity feed for a RUNNING task so
        // re-opening it restores what we were watching (snapshot reads the DOM,
        // which is still live at this point — before the next view overwrites it).
        this._snapshotLiveState();
        this._destroyed = true;
        if (this._mcpUnwatch) { this._mcpUnwatch(); this._mcpUnwatch = null; }
        if (this._newTaskKeyHandler) { document.removeEventListener('keydown', this._newTaskKeyHandler); this._newTaskKeyHandler = null; }
        if (this.socket) { this.socket.close(); this.socket = null; }
        if (this._replayFlushTimer) { clearTimeout(this._replayFlushTimer); this._replayFlushTimer = null; }
        // Release the window-level Tauri drag-drop listener (previously leaked
        // one per view instance).
        if (this._dragUnlisten) { try { this._dragUnlisten(); } catch (_) {} this._dragUnlisten = null; }
        // Unmount migrated Svelte regions. A fresh view is about to mount over the
        // same ids, and two live instances writing to one subtree is the failure
        // mode the seam exists to prevent.
        destroyComponent(document.getElementById('task-inspector'));
        destroyComponent(document.getElementById('task-header'));
        destroyComponent(document.getElementById('task-timeline'));
        destroyComponent(document.getElementById('mtask-list'));
        destroyComponent(document.getElementById('hub-strip'));
        this._inspector = null;
        this._header = null;
        this._timelineCmp = null;
        this._taskListCmp = null;
        this._hubStrip = null;
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
