import { openPathInDefaultApp, ensureResultViewStyles, renderMarkdown, normalizeLeakedEscapes } from '../utils/resultView.js';
import { extractNarration } from '../utils/narration.js';
import { invoke } from '@tauri-apps/api/core';
import { mcpManager } from '../../modules/ai/McpManager.js';
// The steering input still uses the shared "/" helper; the New Task modal now
// attaches its own instance inside NewTaskModal.svelte.
import { SlashCommands } from '../components/SlashCommands.js';
import llmService from '../../modules/ai/LLMService.js';
import { TaskTimeline, buildTimeline, envelopeText, splitForPanes, chapters, withExchangeFolds, exchangeCount, collapsedIds, applyFileDescriptions, pinLiveProgress } from './monitor/taskTimeline.js';
// timelineRender.js is retired: Timeline.svelte's keyed {#each} does the keyed
// DOM reuse it hand-rolled, and timelineItems.js now exports only pure vocabulary.
import { hubApps } from './monitor/hubStrip.js';
// The whole surface is MonitorRoot.svelte — it renders TaskList, TaskHeader,
// Timeline, Inspector, HubStrip, RawLog and SteeringInput itself. This file
// computes their props and pushes them; it holds no element id for anything it
// draws. The pure calculations stay in monitor/inspector.js and
// monitor/headerStats.js.
import NewTaskModal from '../svelte/monitor/NewTaskModal.svelte';
import ApiCallModal from '../svelte/monitor/ApiCallModal.svelte';
import AllowlistModal from '../svelte/monitor/AllowlistModal.svelte';
import ImageZoom from '../svelte/monitor/ImageZoom.svelte';
import MonitorRoot from '../svelte/monitor/MonitorRoot.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
import { contextReading } from './monitor/headerStats.js';
import { rowStatus } from './monitor/taskList.js';
import { toolTarget, toolLineText } from './monitor/toolLine.js';
import { MONITOR_STYLES } from './MonitorView.styles.js';
import { extractThoughtSummary, fmtThought, formatThoughtDetail, fmtTool, fmtFile, fmtStatus, isChatLog, fmtEfficiency, fmtReview, fmtTelemetry } from './monitorLogFormat.js';
// P4 monolith split: approval-card markup, token-usage aggregation and the
// All-Logs step-grouping loop live in monitor/ pure modules; this file keeps
// the view orchestration (DOM + WS + Svelte mounts).
import { fmtConfirm, renderSimpleDiff, isWsAutoApprove, setWsAutoApprove } from './monitor/confirmCards.js';
import { usageTotals as resolveUsageTotals } from './monitor/usageTotals.js';
import { buildLogSteps, chatButtonHtml, requestDividerHtml } from './monitor/logs.js';
// The task socket's GATE — replay discard, the timestamp fallback, token
// accumulation — and the step-header label rules. Both were branch chains buried
// inside connectWebSocket's onmessage, where every rule needed a live socket and
// a live DOM to reach. See monitor/liveEvents.js for what each guard is for.
import {
    routePacket, isRunning, clearsAwaitingUser, runOutcome, isStepBoundary, stepNumber,
    accumulateUsage, emptyUsage, seedUsage, steerPlaceholder,
} from './monitor/liveEvents.js';
import { stepStatusFor, nextStepStatus } from './monitor/stepStatus.js';
// Column widths, the drag arithmetic and the scroll-following test —
// monitor/paneLayout.js records which reported symptom each rule is for.
import {
    LEFT_KEY, INSP_KEY, LEFT_DEFAULT, INSP_DEFAULT, readWidth, writeWidth, isAtBottom,
} from './monitor/paneLayout.js';
// Steer (a live nudge down the open socket) versus continue (a NEW run over
// HTTP, which must stamp a replay cutoff first) - monitor/steering.js.
import {
    hasSomethingToSend, steerMode, buildSteerMessage, steerPayload, steerFrame,
} from './monitor/steering.js';


// One implementation for all of these — see utils/html.js for what the
// nine local copies disagreed about.
import { escapeHtml } from '../utils/html.js';
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
let _taskGroupByPref = 'workspace';
// Remembered task-list filters (search text + status), folded in from History.
let _taskSearchPref = '';
let _taskStatusPref = 'all';
// Collapsed group keys (persisted across re-routes). Keys are group labels.
let _collapsedGroups = new Set();
// Group keys seen at least once — so non-first groups can be default-COLLAPSED
// on their first appearance without overriding the user's later manual toggles.
let _seenGroupKeys = new Set();

// Remembered pane widths for the two drag-resizable edges (task list ↔ story,
// story ↔ inspector). Module vars so they survive re-routes (a new MonitorView
// is built on every hash change); read from localStorage on first use, written
// back on drag-end.
let _leftPaneWidth = readWidth(LEFT_KEY, LEFT_DEFAULT);
let _inspPaneWidth = readWidth(INSP_KEY, INSP_DEFAULT);

/** How many log entries the Task view fetches on open (newest first). */
const LOG_PAGE_SIZE = 400;

/** The one element this view owns; everything inside it is MonitorRoot's. */
const ROOT_HOST = 'monitor-root';

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
        // Remembered pane widths (px) for the two drag-resizable edges. Module
        // vars so they survive re-routes; written back on drag-end.
        this._leftPaneWidth = _leftPaneWidth;
        this._inspPaneWidth = _inspPaneWidth;
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
        // The steering box's state, pushed to SteeringInput.svelte as props. It
        // starts DISABLED: there is nothing to steer until a socket opens or the
        // task turns out to be finished.
        this._steerEnabled = false;
        // Set only when a question owns the box (an ask_user the run paused on,
        // or one a finished run left unanswered) — otherwise the placeholder is
        // derived from the run's state.
        this._steerAskPlaceholder = '';
        this._steerFocusSeq = 0;
        this._steerApi = null;
        // What the step in flight is doing, priority-gated (monitor/stepStatus.js).
        // Null means "nothing live" and the header falls back to what the step
        // achieved, which buildLogSteps derives from the log list.
        this._liveStepStatus = null;
        // What that step remembers between events — its thought summary and the
        // tool it last started. This used to be stashed on the step's DOM node as
        // dataset fields, which is why every arm of the old chain re-queried for
        // that node before it could read or write them.
        this._stepMemory = {};
        this._logVersion = 0;
        // Which tab is showing. It used to live in the DOM, as an `active` class
        // on one of the two filter buttons that three other places then read back.
        this._filter = 'result';
        this._working = false;
        this._earlierNote = '';
        this._rootApi = null;
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
     * In-place task switch (perf): tear down the previous task's live state, reset
     * everything that belonged to the outgoing task, and connect to the new one.
     *
     * The URL hash is updated via replaceState so deep links stay correct WITHOUT
     * firing hashchange — which would rebuild the whole view (sidebar + layout +
     * the ~1,300-line <style> + the task list) on every task click.
     */
    _switchTask(taskId) {
        if (!taskId) return;
        if (taskId === this.selectedTaskId) return;
        const task = (this.tasks || []).find(t => t.id === taskId);
        const mounted = document.getElementById(ROOT_HOST);
        if (!task || !mounted) {
            // List entry / panel missing (stale DOM?) — fall back to a full route.
            window.location.hash = `#monitor?id=${taskId}`;
            return;
        }

        // ── Tear down the previous task's live plumbing ──
        if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
        if (this._replayFlushTimer) { clearTimeout(this._replayFlushTimer); this._replayFlushTimer = null; }
        this._replaying = false;
        // Migrated regions belong to the OUTGOING task; a fresh mount follows.
        // One host: MonitorRoot owns every component inside it.
        destroyComponent(document.getElementById(ROOT_HOST));
        this._rootApi = null;
        this._steerApi = null;

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
        // Everything below used to be reset by REBUILDING the detail markup: the
        // fresh string opened on Story, with no "load earlier" row, no live label
        // and no step status. Those are props now, so they leak into the next task
        // unless they are cleared here — which is what left the incoming task
        // showing the previous one's "Load earlier" button over an empty story.
        this._logStart = 0;
        this._earlierNote = '';
        this._working = false;
        this._feedCollapsed = false;
        this._liveStepStatus = null;
        this._stepMemory = {};
        this._steerAskPlaceholder = '';
        this._userScrolledUp = false;
        this._activeChapter = '';
        this._filter = 'result';

        // ── Left list: move the selection highlight (a prop now) ──
        this._sync();

        // ── URL without re-route ──
        try { history.replaceState(null, '', `#monitor?id=${taskId}`); } catch (_) {}

        // ── Rebind + connect ──
        // There is no panel to swap any more: MonitorRoot redraws itself from the
        // props _sync() pushes. The `right.innerHTML = this._renderDetail(task)`
        // that used to stand here outlived both `right` and `_renderDetail`, so
        // every task click threw a ReferenceError BEFORE _autoConnect() ran —
        // the logs for the newly selected task were never fetched and the story
        // column stayed empty.
        this._bindDetailEvents();
        this._autoConnect();
    }

    /** The left column's props. */
    _taskListProps() {
        return {
            tasks: this.tasks || [],
            selectedId: this.selectedTaskId,
            search: this._taskSearch || '',
            statusFilter: this._taskStatusFilter || 'all',
            groupBy: this._taskGroupBy || 'workspace',
            // Module-level sets: the collapse memory has to outlive this view
            // instance, or every task click would re-fold the groups.
            seenKeys: _seenGroupKeys,
            collapsedKeys: _collapsedGroups,
            onSelect: (id) => this._switchTask(id),
            onDelete: (id) => this._deleteTaskFromList(id),
            onNewTask: (ws) => this._openNewTaskModal(ws || null),
            onSearch: (q) => { this._taskSearch = q; _taskSearchPref = q; this._sync(); },
            onStatusFilter: (s) => { this._taskStatusFilter = s; _taskStatusPref = s; this._sync(); },
            onGroupBy: (g) => { this._taskGroupBy = g; _taskGroupByPref = g; this._sync(); },
        };
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
            this._sync();
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

        // MIGRATED: svelte/monitor/MonitorRoot.svelte. This used to be two template
        // strings (this method and _renderDetail, 160 lines) whose every live field
        // was then written by id from elsewhere in this file, and re-bound after
        // every re-render.
        return `<style>${MONITOR_STYLES}</style><div id="${ROOT_HOST}"></div>`;
    }


    // ─── Log Rendering ──────────────────────────────────────────────────────

    /**
     * The raw log's props.
     *
     * This replaces `renderAllLogs`, which built the whole panel as one HTML
     * string, AND the ~150 lines in connectWebSocket that maintained the same
     * structure incrementally. Both derived the same thing from the same list.
     *
     * `version` is what the component actually watches: `this.logs` is mutated in
     * place (one push per packet), so its identity never changes.
     */
    _rawLogProps() {
        return {
            logs: this.logs,
            version: this._logVersion,
            liveStatus: this._liveStepStatus,
            formatLine: (log) => this.formatLogLine(log),
            formatTime,
            filter: 'all',
            dividerPreview: (requestNum) => {
                // The request's own prompt, so a long task's dividers say WHICH
                // request each block belongs to.
                const req = this.resultSummaries?.[requestNum - 1]?.request;
                return req ? escapeHtml(String(req).replace(/\s+/g, ' ').slice(0, 60)) : '';
            },
            onOpenChat: (entries) => { if (entries?.length) this._showChatModal(entries); },
            // The approval card renders inside a step body here too, and its
            // buttons are the view's — the same handler the Story panel uses.
            onCardClick: (e) => this._onConfirmCardClick(e),
        };
    }

    _syncRawLog({ follow = false } = {}) {
        this._logVersion = (this._logVersion || 0) + 1;
        this._sync();
        if (follow && !this._userScrolledUp) {
            Promise.resolve().then(() => { if (!this._destroyed) this._rootApi?.scrollToBottom(); });
        }
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
            case 'ask_user':
            case 'result':          return '';
            case 'thought':         return fmtThought(log);
            case 'tool_call':       return fmtTool(log);
            case 'file_modified':   return fmtFile(log);
            case 'status':          return fmtStatus(log);
            case 'complete': {
                // A run stopped by a safety limit still arrives as `complete`, because
                // the work so far is real and resumable. But it is NOT a clean finish,
                // and a green tick was the whole reason "it just stopped" was a mystery.
                const stopped = log.data?.stopReason;
                const cls = stopped ? 'mlog-warn log-warn' : 'mlog-success log-success';
                const ic = stopped ? '⚠️' : '✅';
                const label = stopped ? '中断（上限到達）' : 'Complete';
                return `<div class="mlog ${cls}"><span class="mlog-icon">${ic}</span><span class="mlog-body"><strong>${label}:</strong> ${escapeHtml(normalizeLeakedEscapes(log.data.message || ''))}</span></div>`;
            }
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

    // NOTE: _fmtConfirm / renderSimpleDiff / _isWsAutoApprove / _setWsAutoApprove
    // now live in monitor/confirmCards.js (P4 split). The workspace + its
    // auto-approve state are resolved here (view state) and passed in.
    _fmtConfirm(data, idPrefix = 'confirm') {
        const ws = this.tasks?.find(t => t.id === this.selectedTaskId)?.workspace_path || '';
        return fmtConfirm(data, idPrefix, isWsAutoApprove(ws), ws);
    }

    /** localStorage-backed per-workspace "auto-approve commands" set (shared with
     *  ToolExecutor._isAutoApproveWorkspace, which reads it live). Now delegated
     *  to monitor/confirmCards.js (P4 split). */
    _isWsAutoApprove(ws) { return isWsAutoApprove(ws); }

    _setWsAutoApprove(ws, on) { setWsAutoApprove(ws, on); }

    /** Manage the command-approval whitelist: view + remove "always allow"
     *  patterns and auto-approve workspaces. */
    /**
     * The command-approval allowlist.
     *
     * MIGRATED: svelte/monitor/AllowlistModal.svelte, which rebuilt the entire
     * overlay with innerHTML after every single removal — the only refresh it
     * had — and used one delegated handler to tell close from delete.
     */
    _showApprovedCommandsModal() {
        this._openOverlay('macm-host', AllowlistModal, (close) => ({ onClose: close }));
    }


    /** Show the pending approval in the Task view too (mirrors the All Logs card),
     *  so the user can approve without switching to All Logs. */
    _showTaskConfirm(data) {
        if (!data) return;
        // A confirm with NO id used to return here, silently. The raw log renders
        // the same packet without that check, so the card appeared there and not
        // in the story — the exact shape of "the approval is missing from the
        // Story view". Show it either way; a card whose buttons then report the
        // missing id is a far better failure than a card that never exists.
        this._confirmId = data.confirmId ? String(data.confirmId) : null;
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
        this._sync();
        if (lastUsage) this._updateContextGauge(lastUsage);

        // ── Result bubbles from the replayed complete events ──
        this._rebuildResultSummaries();
        this._renderResultPanel();
        requestAnimationFrame(() => {
            if (!this._destroyed) this._rootApi?.scrollToBottom();
        });

        // ── All Logs DOM: build ONCE now only if that tab is visible ──
        {
            const allLogsActive = this._filter === 'all';
            if (allLogsActive) {
                this._syncRawLog({ follow: true });
                this._allLogsDirty = false;
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
            // The wording follows from _taskFinished + currentStatus; see
            // steerPlaceholder. Nothing to write by hand.
            this._setSteerEnabled(true);
        }

        if (status === 'waiting') {
            // Run is paused on an ask_user question — re-surface it.
            const q = [...this.logs].reverse().find(l => l.event === 'status' && l.data?.status === 'waiting');
            if (q) {
                this._awaitingUser = true;
                this._setResultLive(q.data.message || 'The agent is asking for your input — reply below to continue.', 'question');
                this._showAskCard(q.data);
                this._setSteerEnabled(true);
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
        this.tokenUsage = seedUsage({
            preserveResults,
            current: this.tokenUsage,
            task: (this.tasks || []).find(t => t.id === taskId),
        });
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
        // A fresh run: follow again from here, and show the stop button.
        this._userScrolledUp = false;
        this._sync();
        this._awaitingUser = false;
        this._userPickedTab = false;
        this._activeStepChatEntries = [];
        this._activeStepChatUid = null;
        if (!window.apiClient) return;

        const wsUrl = `ws://localhost:${window.apiClient.port}/ws/tasks/${taskId}?token=${window.apiClient.token}`;
        this.socket = new WebSocket(wsUrl);

        const disableSteering = () => this._setSteerEnabled(false);

        this.socket.onopen = () => {
            // Stale socket opening after navigation OR an in-place task switch
            // (same instance, different selectedTaskId) must not touch the DOM.
            if (this._destroyed || this.selectedTaskId !== taskId) return;
            // Fresh connect rebuilds All Logs from the server replay → start clean.
            // On a CONTINUE the prior run's entries are KEPT — the replay is
            // discarded, and wiping them erased every earlier step from the raw
            // log until a manual re-render. A fresh connect already emptied
            // `this.logs`, which the raw log derives from.
            if (!preserveResults) this._syncRawLog();
            this._setSteerEnabled(true);
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

                // What is this packet FOR? The replay discard, the timestamp
                // fallback and the buffering rules live in monitor/liveEvents.js
                // with the symptom each one exists for; here we only act on the
                // answer.
                const route = routePacket(packet, {
                    replaying: this._replaying,
                    discardUntilReplayDone: this._discardUntilReplayDone,
                    replayCutoffTs: this._replayCutoffTs,
                });
                if (route.kind === 'replay-done') {
                    if (route.flush) this._flushReplay();
                    if (route.endDiscard) {
                        this._discardUntilReplayDone = false;
                        clearTimeout(this._discardReplayTimer);
                    }
                    return;
                }
                if (route.kind === 'drop') return;
                if (route.kind === 'narrate') { this._appendNarration(route.chunk); return; }
                if (route.kind === 'buffer') {
                    // Accumulate only; ALL rendering is deferred to _flushReplay.
                    // Live events arriving during the burst flush with it, so
                    // ordering is preserved.
                    if (route.store) this.logs.push(packet);
                    clearTimeout(this._replayFlushTimer);
                    this._replayFlushTimer = setTimeout(() => {
                        if (!this._destroyed) this._flushReplay();
                    }, 250);
                    return;
                }

                // Any non-terminal event means a run is actively streaming → the
                // steer box is in "steer" (not "continue") mode.
                if (isRunning(packet)) this._taskFinished = false;
                // Clearing the ask_user "waiting" state is only correct on REAL
                // progress — see clearsAwaitingUser for the two ways this went
                // wrong (post-pause bookkeeping, and `phase: 'teardown'`).
                if (clearsAwaitingUser(packet)) this._awaitingUser = false;

                // Resolved BEFORE the log push, so an already-answered approval is
                // never replayed on the next view load.
                if (route.kind === 'resolve-confirm') {
                    this._markConfirmResolved(route.confirmId, route.approved, /*byOther*/ true);
                    return;
                }

                this.logs.push(packet);

                // Task-view approval card — handled at TOP level, independent of
                // the All Logs DOM (the `if (!consoleEl) return` below used to
                // silently drop it, so the card sometimes never appeared until a
                // re-visit replayed the event).
                if (packet.event === 'confirm_request') {
                    this._showTaskConfirm(packet.data);
                }
                // The agent's subtask checklist (task_progress tool) becomes its
                // own chapter in the story: the plan and its current state are
                // exactly what a reader wants while the run is still going.
                if (packet.event === 'task_progress' && Array.isArray(packet.data?.items)) {
                    if (this._timeline.pushTaskProgress(packet.data.items)) this._renderResultPanel();
                }
                // Live deliverable (present_result) — render it NOW so a plan is
                // visible together with a following ask_user question. Only fires
                // LIVE (replay is buffered above, so this never runs during flush).
                if (packet.event === 'result' && packet.data?.envelope) {
                    this._showLiveDeliverable(packet.data.envelope);
                }
                // Per-file descriptions that landed AFTER completion (they are
                // decoration, so they must never delay the result). The packet is
                // already in `this.logs`, so the canonical rebuild picks it up and
                // patches the run's file table in place — no second run bubble.
                if (packet.event === 'result_update' && Array.isArray(packet.data?.files)) {
                    this._rebuildResultSummaries();
                    this._renderResultPanel();
                }
                // New LLM step → the next stream chunks belong to a NEW narration
                // bubble. Done at top level (not inside the All Logs branch below)
                // so it still fires when the console DOM isn't present.
                if (isStepBoundary(packet)) this._startNarrationStep();

                // ── The raw log ──────────────────────────────────────
                // One model, one render. This was ~150 lines that maintained the
                // step DOM by hand: insertAdjacentHTML per step, a
                // querySelectorAll per event to find the last one, and
                // `dataset.thoughtSummary` / `dataset.lastTool` stashed on the
                // element to carry state between events. RawLog.svelte derives all
                // of it from `this.logs` through monitor/logs.js buildLogSteps —
                // which the REPLAY path already used, so the two paths agreed only
                // by coincidence before.
                if (isStepBoundary(packet)) {
                    // A new step starts clean: the previous one's header falls back
                    // to what it achieved, and CHAT tracking resets.
                    this._liveStepStatus = null;
                    this._activeStepChatEntries = [];
                    this._activeStepChatUid = null;
                }

                // What the step in flight should say (monitor/stepStatus.js). The
                // step's own memory travels with the status now, rather than living
                // on a DOM node's dataset.
                const st = stepStatusFor(packet, this._stepMemory || {}, {
                    summarizeThought: extractThoughtSummary,
                    toolActionLabel: (d) => this._toolActionLabel(d),
                    toolTarget,
                });
                if (st) {
                    if (st.remember) this._stepMemory = { ...(this._stepMemory || {}), ...st.remember };
                    this._updateActiveStepStatus(st.text, st.type, st.feed, st.target ?? null);
                }
                if (isStepBoundary(packet)) this._stepMemory = {};

                this._syncRawLog({ follow: true });

                // Update progress/status/tokens
                if (packet.event === 'token_usage') {
                    // ACCUMULATE across LLM calls — each token_usage event is one
                    // call's usage, not the running total. (Previously this overwrote,
                    // so the header showed only the last step's tokens, which for a
                    // tool-only final step is often 0 → the "Tokens: 0" bug.)
                    const d = packet.data || {};
                    this.tokenUsage = accumulateUsage(this.tokenUsage, d);
                    // Totals + the breakdown (input full-priced · cached ~10% ·
                    // output) are props now, so one push covers all four fields.
                    // The context gauge says how full the window is RIGHT NOW —
                    // it replaced a step-count progress % that predicted nothing.
                    this._updateContextGauge(d);
                    this._sync();
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
                        // _awaitingUser is already set, so the placeholder asks
                        // for the answer; pull focus to where it goes.
                        this._setSteerEnabled(true, { focus: true });
                    }
                } else if (runOutcome(packet)) {
                    // A non-terminal 'error' is a RECOVERABLE mid-run failure and
                    // never reaches here — see runOutcome.
                    this.currentStatus = runOutcome(packet);
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

                    // The run is over: the last step's header stops pulsing with a
                    // stale "Calling LLM…" and falls back to what it achieved.
                    this._clearLiveStepStatus();

                    // Clear the live activity feed — the run's request/answer bubbles
                    // (rendered in #result-runs above) now represent this turn. The
                    // feed was the ephemeral "in progress" stream.
                    // ...but when ask_user paused the run, KEEP the highlighted question
                    // card visible — the "task" isn't over, it's waiting for the reply.
                    if ((packet.event === 'complete' || packet.event === 'error') && !this._awaitingUser) {
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
                    }

                    if (packet.event === 'complete' || packet.event === 'error') {
                        // Keep the steer box usable so the user can CONTINUE the task —
                        // for BOTH a clean finish AND a stop/error/stall. A stalled or
                        // failed run is exactly when "just keep going" is most useful.
                        this._taskFinished = true;
                        this._sync();   // the stop button is derived from run state
                        this._clearLiveDeliverable();   // run over → drop any live plan bubble
                        this._clearNarration();         // …and the live narration (result bubble takes over)
                        // ask_user pauses the run and returns via 'complete' — but the
                        // task is NOT actually done, it's waiting for the user's answer.
                        // Keep the question-answer framing so the reply box reads as
                        // "answer this", not "task finished".
                        const awaiting = this._awaitingUser;
                        const done = packet.event === 'complete' && !awaiting;
                        // The wording follows from _awaitingUser + currentStatus
                        // (steerPlaceholder); a question pulls focus to the reply.
                        this._setSteerEnabled(true, { focus: awaiting });
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


    _setEarlierNote(text) {
        this._earlierNote = String(text || '');
        this._sync();
    }

    /** Prepend the previous page of logs and re-derive the timeline from them. */
    async loadEarlierLogs() {
        if (!window.apiClient || !this.selectedTaskId || this._logStart <= 0) return;
        this._setEarlierNote('Loading…');
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
                const rp = document.querySelector('.mresult');
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
                const allLogsActive = this._filter === 'all';
                if (allLogsActive) {
                    this._syncRawLog();
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
            // The row and its button are derived from _logStart plus the note, so
            // there is nothing to re-enable — one push settles both.
            this._sync();
        }
    }

    async loadHistoricalLogs(taskId) {
        if (!window.apiClient) return;

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
            this._loadingResults = false;
            if (Array.isArray(logs) && logs.length > 0) {
                this.logs = logs.map(l => ({ ...l, data: l.data || {} }));
                // `_idx` is the ABSOLUTE index in the stored log, so it tells us
                // whether anything precedes what we fetched.
                this._logStart = Number(this.logs[0]?.data?._idx) || 0;
                this._sync();
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
                    this._rootApi?.scrollToBottom();
                });
                // Defer the (potentially large) All Logs DOM build until the user
                // actually opens that tab. Result is the default view, so most opens
                // never need it — this is the dominant "Monitor feels heavy on open"
                // cost on low-end machines (big per-step logs → huge DOM + reflow).
                {
                    const allLogsActive = this._filter === 'all';
                    if (allLogsActive) {
                        this._syncRawLog();
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
                // The wording follows from _taskFinished + currentStatus; a run
                // that ended PAUSED ON A QUESTION nobody answered keeps the
                // question on the box instead, because that is where the answer
                // goes - saying "Done. Continue..." hid it and the task could
                // never be resumed from the question.
                const pendingQ = this._timeline.items.find(i => i.kind === 'ask' && i.unanswered);
                this._steerAskPlaceholder = pendingQ ? `❓ ${pendingQ.text}` : '';
                this.currentStatus = this.tasks.find(t => t.id === taskId)?.status || this.currentStatus;
                this._setSteerEnabled(true);
            }
        } catch (e) {
            console.error('Failed to load task logs:', e);
            // Don't leave the spinner running forever on a failed fetch.
            // Don't leave the spinner running forever on a failed fetch.
            if (!this._destroyed) { this._loadingResults = false; this._sync(); }
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

        // Acknowledge INSTANTLY. The agent's first status event is one LLM call
        // away — tens of seconds on a long context — and until it arrived the
        // story sat unchanged, so a sent message looked like a message that had
        // not been sent. This line and the "⏳ Working…" strip are the receipt.
        this._liveActivitySeen = true;
        this._setWorkingLabel(true);
        this._timeline.pushActivity('thought', '📨 リクエストを受け付けました — 処理を開始します…');
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

    _setWorkingLabel(on) {
        this._working = !!on;
        this._sync();
    }

    /** #2/#4: fold/unfold the live activity list (keeps the "Working" label). Folding
     *  frees vertical space so the results / plan above are readable — done
     *  automatically when the run pauses on ask_user, and manually via the label. */
    _setFeedCollapsed(collapsed) {
        this._feedCollapsed = collapsed;
        this._sync();
    }

    _isTaskAtBottom() {
        return this._rootApi ? this._rootApi.isAtBottom() : true;
    }

    _scrollTaskToBottom() {
        // Going back to the bottom re-arms auto-follow.
        this._userScrolledUp = false;
        this._rootApi?.scrollToBottom();
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
            // Per-file descriptions are generated AFTER completion (they must not
            // delay the result), so they arrive as a patch on the run they belong
            // to — the one most recently pushed at this point in the log.
            if (l.event === 'result_update' && Array.isArray(l.data?.files)) {
                const target = out[out.length - 1];
                if (target) applyFileDescriptions(target.files, l.data.files);
                continue;
            }
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

        // Replayed confirm items carry only the confirmId (see buildTimeline);
        // the live path pushed full _fmtConfirm markup through _showTaskConfirm.
        // Render the real card for any that survive as still-pending, so a task
        // reloaded while parked on an approval shows the actual Approve/Reject
        // card in the story — not a placeholder.
        for (const item of this._timeline.items) {
            if (item.kind !== 'confirm') continue;
            const cid = item.payload?.confirmId;
            const src = (this.logs || []).find(l => l.event === 'confirm_request' && l.data?.confirmId === cid)?.data;
            if (src) item.text = this._fmtConfirm(src, 'confirm-task');
        }
    }

    /**
     * The story column's props.
     *
     * The deliverable is lifted out of the trace and rendered as a document, but
     * it stays at the END of the same single column — that is where it belongs
     * chronologically, and it needs the full width to be readable.
     */
    _timelineProps() {
        const { stream } = splitForPanes(this._timeline.items);
        const folded = withExchangeFolds(stream, this._collapsedExchanges(stream));
        const running = this.currentStatus === 'running';
        // While the run is live the checklist card is PINNED below the newest
        // message rather than staying where the plan first registered — a long
        // run would otherwise bury the one thing the reader is watching. Pinned
        // means worth seeing, so an UNTOUCHED card is forced open; a reader who
        // folded it once keeps it folded.
        if (running) {
            const progs = this._timeline.items.filter(i => i.kind === 'task_progress');
            const latest = progs[progs.length - 1];
            if (latest && !latest.userFolded) latest.collapsed = false;
        }
        const items = pinLiveProgress(folded, running);
        this._inspectorItems = items;
        return {
            items,
            collapsed: collapsedIds(this._timeline.items),
            renderMarkdown: (t) => renderMarkdown(t),
            workspace: this._workspaceOf(),
            // The activity groups fold as a block when a run pauses on a question:
            // HIDING the feed is what made the question itself invisible, because
            // it was written into the feed and the feed was collapsed in the same
            // breath.
            groupsCollapsed: !!this._feedCollapsed,
            onToggleStory: (ex, what) => this._toggleExchange(ex, what),
            onToggleCollapse: (id) => this._toggleCard(id),
            onAnswer: (ans) => this._answerAsk(ans),
            onReopenAsk: (item) => this._reopenAsk(item),
            onCopyDoc: (text) => this._copyDeliverable(text),
            onOpenFile: (path) => openPathInDefaultApp(path, this._workspaceOf()),
        };
    }

    /**
     * Redraw the story.
     *
     * Follow the newest content only when the reader has NOT scrolled away.
     * Measuring "am I at the bottom" before the render alone let a tall incoming
     * card yank the view: the reader was at the bottom when it started and
     * mid-page by the time it finished.
     */
    _renderResultPanel() {
        ensureResultViewStyles();
        const wasAtBottom = this._isTaskAtBottom();
        this._loadingResults = false;
        this._sync();
        if (wasAtBottom && !this._userScrolledUp) {
            // Prop pushes are batched, so this waits a microtask rather than
            // forcing a synchronous flush — forcing one on every streamed line is
            // what made a long run feel like it had stalled.
            Promise.resolve().then(() => {
                if (!this._destroyed) this._scrollTaskToBottom();
            });
        }
    }

    /** The connected apps and what they offer. */
    _hubProps() {
        return {
            apps: hubApps(mcpManager.clients),
            onCompose: (text) => this._steerApi?.compose(text),
        };
    }


    /**
     * The metadata column's props, or null while it is closed.
     *
     * A closed inspector costs nothing to compute, which is what lets it default
     * to closed without the panel feeling like something is missing. The
     * callbacks are props rather than clicks delegated from elsewhere, which is
     * what let the old Project-instructions action rot into a no-op.
     */
    _inspectorProps(items) {
        // Remembered so a late arrival (the cost rates) can redraw without the
        // caller's item list.
        if (items) this._inspectorItems = items;
        items = items || this._inspectorItems || [];
        if (!this._inspectorOpen) return null;
        this._loadCostRates();

        const task = (this.tasks || []).find(t => t.id === this.selectedTaskId) || null;
        const lastRun = [...(this.resultSummaries || [])].reverse()[0] || {};
        return {
            task: task ? { ...task, status: this.currentStatus || task.status } : null,
            stats: lastRun.stats || {},
            usage: this._usageTotals(),
            files: this._touchedFiles(),
            // One bar per LLM call, split by where the tokens went.
            perStep: (this.logs || [])
                .filter(l => l.event === 'token_usage')
                .map(l => ({
                    in: Number(l.data?.prompt_tokens) || 0,
                    cache: Number(l.data?.cache_read_input_tokens) || 0,
                    out: Number(l.data?.completion_tokens) || 0,
                })),
            rates: this._costRates,
            costTable: this._costTable,
            chapters: chapters(items),
            activeChapter: this._activeChapter,
            onAction: (act) => this._inspectorAction(act),
            onChapter: (id) => this._jumpToChapter(id),
            onOpenFile: (path) => openPathInDefaultApp(path, this._workspaceOf()),
        };
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
        // `#task-timeline` was the HOST this view used to mount Timeline into. It
        // is MonitorRoot's own `.mtl` now, so the old id matched nothing and every
        // chapter jump silently did nothing.
        this._scrollStoryTo(
            document.querySelector(`.mresult .mtl [data-item-id="${id}"]`),
            'start',
        );
        // The rail reads activeChapter from its props, so a re-push is the update.
        this._sync();
    }

    /**
     * Scroll the story panel to an item WITHOUT touching any outer scroll
     * container. scrollIntoView scrolls EVERY scrollable ancestor — including
     * the app shell's .main-content — so a chapter jump yanked the whole page
     * up and hid the task header behind the top edge. The only container that
     * should move is #result-panel, so compute the offset within it and scroll
     * that alone.
     *
     * @param {HTMLElement|null} el the timeline row to reveal
     * @param {'start'|'center'} block where to place it in the panel
     */
    _scrollStoryTo(el, block = 'start') {
        const panel = document.querySelector('.mresult');
        if (!panel || !el) return;
        const pRect = panel.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const rel = eRect.top - pRect.top;
        let top;
        if (block === 'center') {
            top = panel.scrollTop + rel - (pRect.height - eRect.height) / 2;
        } else {
            // Leave a little air below the filter bar instead of gluing the row
            // flush to the panel's top edge.
            top = panel.scrollTop + rel - 8;
        }
        panel.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
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
        // A user click is a deliberate choice: remember it so the live pinning
        // never force-opens a card the reader chose to fold. (The pinning only
        // opens cards that have never been touched.)
        item.userFolded = true;
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
        this._sync();
    }

    /** Is any half of any exchange still open? */
    _anythingOpen(stream, n) {
        const { working, outcome } = this._collapsedExchanges(stream);
        for (let i = 1; i <= n; i++) {
            if (!working.has(i) || !outcome.has(i)) return true;
        }
        return false;
    }

    /**
     * The fold-everything control, or null when there is nothing to fold.
     *
     * It only earns its place once a task has more than one exchange.
     */
    _foldAllProps() {
        const { stream } = splitForPanes(this._timeline?.items || []);
        const n = exchangeCount(stream);
        if (n <= 1) return null;
        const anyOpen = this._anythingOpen(stream, n);
        return {
            label: anyOpen ? '⊟ Collapse all' : '⊞ Expand all',
            title: anyOpen ? 'Fold every exchange' : 'Open every exchange',
        };
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
    // NOTE: _usageTotals' fallback chain now lives in monitor/usageTotals.js
    // (P4 split). The view resolves its three inputs and delegates.
    _usageTotals() {
        const stored = (this.tasks || []).find(t => t.id === this.selectedTaskId)?.token_usage || null;
        return resolveUsageTotals({ live: this.tokenUsage, stored, logs: this.logs });
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
            // model → rates, so a run that escalated tiers is priced per model
            // rather than re-priced wholesale at whatever model is active now.
            if (stats?.costTable && typeof stats.costTable === 'object') {
                this._costTable = stats.costTable;
            }
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
        this._steerApi?.compose(text, 'replace');
        this._steerApi?.submit();
    }

    /**
     * Re-arm the reply box for a question that CLOSED UNANSWERED.
     *
     * A replay of a finished task shows the question as history ("未回答のまま
     * 終了しました") — which is honest, but it was also a dead end: the card
     * offered no way in, and the reply box below only said "Done. Continue…", so
     * an answer sent from there read as a fresh instruction rather than the reply
     * the run is still paused on. This puts the QUESTION back on the reply box,
     * so what the user sends next is unmistakably the answer — sending it
     * continues the task (the same path any message to a finished task takes).
     */
    _reopenAsk(item) {
        // The QUESTION becomes the box's placeholder, so what the user sends
        // next is unmistakably the answer rather than a fresh instruction.
        this._steerAskPlaceholder = `❓ ${item.text}`;
        this._setSteerEnabled(true, { focus: true });
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
        this._sync();
        this._sync();
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
     * The header's props.
     *
     * The live status wins, except before the socket has said anything. The mini
     * progress bar reads the LATEST task_progress card, and only while a run is
     * live — the card returns to history once it settles.
     */
    _headerProps() {
        const task = (this.tasks || []).find(t => t.id === this.selectedTaskId) || null;
        if (!task) return null;
        const status = (this.currentStatus && this.currentStatus !== 'idle')
            ? this.currentStatus : task.status;
        const progs = this._timeline.items.filter(i => i.kind === 'task_progress');
        const progressItem = progs[progs.length - 1];
        return {
            task,
            status,
            steps: this._timeline.items.filter(i => i.kind === 'group').length,
            progress: (status === 'running' && Array.isArray(progressItem?.items))
                ? {
                    done: progressItem.items.filter(t => t.status === 'completed').length,
                    total: progressItem.items.length,
                }
                : null,
            usage: this._usageTotals(),
            context: this._contextReading,
            // Elapsed measures against the clock while running, so the component
            // needs a changing input to recompute it.
            now: Date.now(),
            onAbort: () => this._abortTask(),
            onDelete: () => this._deleteTask(),
        };
    }


    /**
     * Push the whole layout to MonitorRoot.
     *
     * One call replaces twelve `_syncX()` / `_applyX()` helpers that each reached
     * for one element by id and wrote a `style.display`, a `textContent` or a
     * class onto it. Prop pushes are batched (see mount.svelte.js), so calling
     * this from several places in one turn costs one render.
     */
    _sync() {
        if (this._destroyed) return;
        const host = document.getElementById(ROOT_HOST);
        if (!host) return;
        mountComponent(MonitorRoot, host, {
            taskList: this._taskListProps(),
            taskCount: (this.tasks || []).length,
            header: this._headerProps(),
            timeline: this._timelineProps(),
            inspector: this._inspectorProps(),
            hub: this._hubProps(),
            rawLog: this._filter === 'all' ? this._rawLogProps() : null,
            steer: this._steerProps(),

            listCollapsed: this._listCollapsed,
            inspectorOpen: this._inspectorOpen,
            leftWidth: this._leftPaneWidth,
            inspWidth: this._inspPaneWidth,

            filter: this._filter,
            foldAll: this._foldAllProps(),
            loading: !!this._loadingResults,
            earlier: { canLoadMore: this._logStart > 0, note: this._earlierNote },
            working: this._working
                ? { text: this._workingText || '⏳ Working…', collapsed: !!this._feedCollapsed }
                : null,

            onNewTask: () => this._openNewTaskModal(),
            onFilter: (f) => {
                // A manual tab choice suppresses the auto-switch-to-Story on
                // completion — it must not yank the reader off what they opened.
                this._userPickedTab = true;
                this._filter = f;
                this._sync();
            },
            onToggleList: () => {
                this._listCollapsed = !this._listCollapsed;
                try { localStorage.setItem('jhai_list_collapsed', this._listCollapsed ? '1' : '0'); } catch (_) {}
                this._sync();
            },
            onToggleInspector: () => {
                this._inspectorOpen = !this._inspectorOpen;
                try { localStorage.setItem('jhai_inspector_open', this._inspectorOpen ? '1' : '0'); } catch (_) {}
                this._sync();
            },
            onFoldAll: () => this._toggleAllExchanges(),
            onLoadEarlier: () => this.loadEarlierLogs(),
            onToggleWorking: () => this._setFeedCollapsed(!this._feedCollapsed),
            onPanelScroll: (atBottom) => {
                // Remember that the reader LEFT the bottom. Auto-follow then stops
                // until they come back — measuring "am I at the bottom" per render
                // was not enough, because a tall card can arrive and move the
                // bottom out from under them mid-read.
                this._userScrolledUp = !atBottom;
            },
            onPanelClick: (e) => {
                // The approval card's buttons and the attached-image zoom are
                // rendered inside the timeline, so they are delegated from the
                // panel. They used to be bound to a slot a redesign had deleted,
                // so Approve and Reject in the Story view did nothing at all.
                if (this._onConfirmCardClick(e)) return;
                const img = e.target.closest?.('.mrc-img');
                if (img) this._openImageZoom(img.src);
            },
            onWidths: ({ left, insp }) => {
                if (Number.isFinite(left)) {
                    this._leftPaneWidth = left;
                    _leftPaneWidth = left;
                    writeWidth(LEFT_KEY, left);
                }
                if (Number.isFinite(insp)) {
                    this._inspPaneWidth = insp;
                    _inspPaneWidth = insp;
                    writeWidth(INSP_KEY, insp);
                }
                // Push it back: the drag wrote the CSS variable directly for
                // responsiveness, but the NEXT drag reads its base from the prop.
                this._sync();
            },
            onReady: (api) => { this._rootApi = api; },
        });
    }

    /** The steering box's props — see steerPlaceholder for the wording. */
    _steerProps() {
        const running = !this._taskFinished
            && !['completed', 'failed', 'aborted', 'idle'].includes(this.currentStatus);
        return {
            enabled: !!this._steerEnabled,
            placeholder: this._steerAskPlaceholder || steerPlaceholder({
                awaiting: this._awaitingUser,
                finished: this._taskFinished,
                done: this.currentStatus === 'completed' && !this._awaitingUser,
            }),
            showStop: running,
            focusRequest: this._steerFocusSeq || 0,
            onZoom: (src) => this._openImageZoom(src),
            onStop: () => {
                if (!confirm('Stop this running task?')) return;
                if (this.socket?.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ action: 'abort' }));
                } else if (window.apiClient && this.selectedTaskId) {
                    window.apiClient.abortTask(this.selectedTaskId);
                }
            },
            onSend: (msg) => this._sendSteer(msg),
            onReady: (api) => { this._steerApi = api; },
        };
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
        this._sync();
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
        this._sync();
    }

    /**
     * Hide the live-activity strip.
     *
     * The strip became timeline items in the single-timeline redesign, so this is
     * now just "stop showing the Working label".
     */
    _hideResultLive() {
        this._setWorkingLabel(false);
    }

    /** Open the Story tab — what a completed run has to say. */
    _activateResultTab() {
        this._filter = 'result';
        this._sync();
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
    /**
     * Record what the step in flight is doing.
     *
     * The compact live strip always shows the LATEST activity; the step HEADER is
     * priority-gated (monitor/stepStatus.js), because a step emits a thought, a
     * tool and sometimes an approval at once and the header has room for one.
     *
     * This used to walk the DOM for the last step element, read the current
     * priority back off a `data-status-priority` attribute, and write the text
     * and CSS class onto the node.
     */
    _updateActiveStepStatus(text, type = 'live', feedText = undefined, meta = null) {
        this._setResultLive(feedText === undefined ? text : feedText, type, meta);
        const next = nextStepStatus(this._liveStepStatus, { text, type });
        if (next === this._liveStepStatus) return;
        this._liveStepStatus = next;
        this._syncRawLog();
    }

    /**
     * The step is over: drop the live label so the header falls back to what the
     * step ACHIEVED.
     *
     * `_finalizePreviousStep` used to do this by reading the summary back out of
     * the DOM and choosing between a stashed thought, a stashed tool name and a
     * placeholder — the same three-way choice buildLogSteps already makes from
     * the log list, which is now the only place it is made.
     */
    _clearLiveStepStatus() {
        if (!this._liveStepStatus) return;
        this._liveStepStatus = null;
        this._syncRawLog();
    }

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
        // Nothing identifies the request, so the server cannot be told which
        // approval this answers. Saying so beats a button that does nothing —
        // which is what a card built from a packet with no confirmId produced.
        if (!confirmId || confirmId === 'undefined' || confirmId === 'null') {
            alert('This approval cannot be answered: the request carried no id. '
                + 'Stop the task and run it again.');
            return;
        }
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

        // The header was holding "⏸ Awaiting approval…" at confirm priority, which
        // outranks tool events — without demoting it the step would sit on that
        // line for the rest of its life. `final` is deliberate: the outcome of an
        // approval is the last word on that step.
        if (this._liveStepStatus?.type === 'confirm') {
            this._liveStepStatus = { text: approved ? '✓ Approved — continuing' : '✗ Rejected', type: 'thought' };
            this._syncRawLog();
        }
    }

    // NOTE: renderSimpleDiff now lives in monitor/confirmCards.js (P4 split).
    renderSimpleDiff(oldText, newText) { return renderSimpleDiff(oldText, newText); }

    // ─── CHAT Modal ─────────────────────────────────────────────────────────

    /**
     * Show what was actually sent to the provider for a step, and what came back.
     *
     * MIGRATED: svelte/monitor/ApiCallModal.svelte. This was a 145-line <style>
     * injected into document.head plus a 195-line render that built every entry
     * as one innerHTML string and then re-queried its own output to bind a
     * listener per sub-tab and per copy button — so which tab was open lived
     * only in the DOM. What the tabs contain is monitor/apiCallView.js.
     */
    _showChatModal(entries) {
        this._openOverlay('mchat-host', ApiCallModal, (close) => ({
            entries: entries || [],
            taskId: this.selectedTaskId,
            api: window.apiClient,
            onClose: close,
        }));
    }

    /**
     * Mount a modal on its own host under <body>, and tear it down on close.
     *
     * One helper for all three overlays: each used to create its own element,
     * write its own inline styles, append itself to document.body and remove
     * itself again from inside its own click handler.
     */
    _openOverlay(hostId, Component, propsFor) {
        if (document.getElementById(hostId)) return;
        const host = document.createElement('div');
        host.id = hostId;
        document.body.appendChild(host);
        const close = () => {
            destroyComponent(host);
            try { document.body.removeChild(host); } catch (_) {}
        };
        mountComponent(Component, host, propsFor(close));
        return close;
    }

    // ─── init() ─────────────────────────────────────────────────────────────

    init() {
        // Everything visible is MonitorRoot's; this pushes it once and then only
        // when something changes. (The API-call, allowlist, image-zoom and
        // new-task overlays are mounted on demand by _openOverlay.)
        this._sync();

        // Ctrl+N (⌘N) → open the new-task modal from anywhere in the Monitor.
        // Stored on the instance so destroy() can release it (document-level).
        this._newTaskKeyHandler = (e) => {
            if (this._destroyed) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
                if (document.getElementById('mnt-new-task-host')) return;  // already open
                e.preventDefault();
                this._openNewTaskModal();
            }
        };
        document.addEventListener('keydown', this._newTaskKeyHandler);

        // Auto-open the modal when arriving from the Dashboard's launcher.
        //
        // The handoff used to be a bare '1' flag. It now carries what the user
        // already typed there — {prompt, ws} — so the modal opens filled in
        // rather than making them retype it. The old '1' is still honoured: it is
        // what a stale flag written by a previous build looks like.
        try {
            const raw = localStorage.getItem('jh_open_new_task');
            if (raw) {
                localStorage.removeItem('jh_open_new_task');
                let preset = null;
                if (raw !== '1') {
                    try { preset = JSON.parse(raw); } catch (_) { /* treat as bare flag */ }
                }
                this._openNewTaskModal(preset?.ws || null, preset?.prompt || '');
            }
        } catch (_) {}

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
    /**
     * Re-bind what belongs to the SELECTED task.
     *
     * Almost nothing does any more: the header, the filter bar, the panel
     * toggles, the jump pill and the steering box are all MonitorRoot's, wired
     * through props. What is left is the drag-drop listener (window level) and
     * the MCP watcher, both of which have to be released and re-taken.
     */
    _bindDetailEvents() {
        if (this._dragUnlisten) { try { this._dragUnlisten(); } catch (_) {} this._dragUnlisten = null; }

        // Redraw the connected-apps strip when an app connects or drops, not only
        // when the task re-renders.
        if (!this._mcpUnwatch) {
            this._mcpUnwatch = mcpManager.onChange(() => {
                if (!this._destroyed) this._sync();
            });
        }
        this._sync();
    }


    /** Enable or disable the box, optionally pulling focus to it. */
    _setSteerEnabled(on, { focus = false } = {}) {
        this._steerEnabled = !!on;
        if (focus) this._steerFocusSeq = (this._steerFocusSeq || 0) + 1;
        this._sync();
    }

    /**
     * Send what the box collected: a live nudge down the socket, or a NEW run.
     *
     * Which one is monitor/steering.js — and the CONTINUE path has to stamp the
     * replay cutoff before it starts, because the reconnect replays the whole
     * prior task and that replayed `complete` would wipe the message just sent.
     *
     * @returns {Promise<boolean>} false leaves the box's contents alone
     */
    async _sendSteer({ text, expandedPrompt, attachments }) {
        const { body: prompt, display, images } = buildSteerMessage({ text, expandedPrompt, attachments });
        const mode = steerMode({
            taskFinished: this._taskFinished,
            socketOpen: this.socket?.readyState === WebSocket.OPEN,
        });
        if (mode === 'none') return false;

        // Any pending ask_user card is now being answered.
        this._clearAskCard();
        // Show it instantly as a chat bubble, image thumbnails included, so the
        // attachment stays visible after sending. Replaced when the run's real
        // request/answer bubble arrives.
        this._showPendingUser(display, images);

        if (mode === 'continue') {
            this._setSteerEnabled(false);
            try {
                // Stamped BEFORE the run starts, so every event from here counts
                // as live and the replay of older ones is discarded.
                this._replayCutoffTs = Date.now();
                await window.apiClient.continueTask(
                    this.selectedTaskId, steerPayload({ body: prompt, images }));
                this._taskFinished = false;
                // preserveResults: keep the prior run bubbles so the Task tab
                // reads as one conversation across continues.
                this.connectWebSocket(this.selectedTaskId, /*preserveResults*/ true);
            } catch (e) {
                console.error('continueTask failed:', e);
                this._setSteerEnabled(true);
                alert(`Failed to continue: ${e.message || e}`);
            }
            return true;
        }

        this.socket.send(steerFrame(steerPayload({ body: prompt, images })));
        return true;
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
                // "Loading results…" used to be baked into the detail markup for a
                // non-running task and removed once the fetch landed. It is a prop
                // now, and nothing set it — so a slow log fetch showed a blank
                // column instead of saying it was working.
                this._loadingResults = cached.status !== 'running';
                this._sync();
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
    /**
     * A screenshot at full size.
     *
     * MIGRATED: svelte/monitor/ImageZoom.svelte. The predecessor wrote the <img>
     * through innerHTML with the src interpolated unescaped, and registered a
     * document-level keydown it had to remember to remove itself.
     */
    _openImageZoom(src) {
        this._openOverlay('mzoom-host', ImageZoom, (close) => ({ src, onClose: close }));
    }

    /**
     * @param {string|null} presetWs  workspace to preselect (WS group "+", or the
     *        Dashboard launcher's choice)
     * @param {string} presetPrompt   text the user already typed on the Dashboard.
     *        Filled in here rather than re-collected: this modal owns workspace
     *        validation, the mode picker, MCP selection, "/" templates and
     *        attachments, so it stays the single task-creation path.
     */
    _openNewTaskModal(presetWs = null, presetPrompt = '') {
        // MIGRATED: svelte/monitor/NewTaskModal.svelte. This was 315 lines that
        // injected a <style> into document.head on first open, built the dialog
        // as one innerHTML string with every rule inline, appended it to
        // document.body and then re-queried its own markup to attach handlers.
        // What the request contains is monitor/newTaskRequest.js.
        this._openOverlay('mnt-new-task-host', NewTaskModal, (close) => ({
            presetWs,
            presetPrompt,
            lastWs: this._lastNewTaskWs || '',
            lastMode: this._lastNewTaskMode || '',
            onClose: close,
            onZoom: (src) => this._openImageZoom(src),
            onCreated: (taskId, { workspace, modeId }) => {
                // Remembered so the next task starts where this one left off.
                this._lastNewTaskWs = workspace;
                this._lastNewTaskMode = modeId;
                close();
                // The list cache is short-TTL; without this the task just created
                // would be missing from the list it navigates into.
                invalidateTasksCache();
                this.selectedTaskId = taskId;
                window.location.hash = `#monitor?id=${taskId}`;
            },
        }));
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
        destroyComponent(document.getElementById(ROOT_HOST));
        this._rootApi = null;
        this._steerApi = null;
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


