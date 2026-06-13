import { invoke } from '@tauri-apps/api/core';
import { mcpManager } from './McpManager.js';
import { workflowManager } from './WorkflowManager.js';
import { toStrictSchema } from './strictSchema.js';
import { levenshtein, pickClosestFile } from './tools/FuzzyPath.js';
import { shouldBlock as planShouldBlock, planGateMessage } from './tools/PlanGate.js';
import {
    detectLineEnding, normalizeLE, countOccurrences, replaceAllLiteral,
    findClosestRegion, visualizeWS
} from './tools/FileEdit.js';
import { TOOL_DEFINITIONS } from './tools/toolSchemas.js';
import { selectMcpTools } from './tools/ToolRelevance.js';
import {
    handleListFiles, handleReadFile, handleGrepSearch, handleGlob, handleFetchUrl
} from './tools/handlers/readOnlyHandlers.js';
import {
    handleWriteFile, handleMultiReplace, handleReplaceLines
} from './tools/handlers/editHandlers.js';
import {
    handleDeleteFile, handleMoveFile, handleRunCommand
} from './tools/handlers/fsShellHandlers.js';
import {
    handleProposePlan, handleArtifact, handleFinishTask,
    handleVerifySyntax, handleTaskProgress, handlePresentResult,
    handleAskUser
} from './tools/handlers/agentMetaHandlers.js';

// ── Built-in tool dispatch table ───────────────────────────────────────────
// Replaces the long switch in executeTool: tool name → a thin adapter that
// calls the matching handler with exactly the args it expects. Each adapter
// returns the handler's value/promise DIRECTLY (no extra await), so the
// surrounding try/catch in executeTool behaves identically to the old switch.
// open_file's tiny inline body lives here too; MCP/unknown tools fall through
// to _dispatchMcpTool. Keep this in sync when adding/removing a built-in tool.
const TOOL_HANDLERS = {
    list_files:  (ex, c) => handleListFiles(ex, c.args, c.onAgentStatus, c.resolvedPath),
    read_file:   (ex, c) => handleReadFile(ex, c.args, c.onAgentStatus, c.resolvedPath),
    grep_search: (ex, c) => handleGrepSearch(ex, c.args, c.onAgentStatus),
    glob:        (ex, c) => handleGlob(ex, c.args, c.onAgentStatus),
    delete_file: (ex, c) => handleDeleteFile(ex, c.args, c.onConfirm, c.onAgentStatus, c.resolvedPath),
    move_file:   (ex, c) => handleMoveFile(ex, c.args, c.onConfirm, c.onAgentStatus),
    write_file:  (ex, c) => handleWriteFile(ex, c.args, c.onConfirm, c.onAgentStatus, c.resolvedPath),
    run_command: (ex, c) => handleRunCommand(ex, c.args, c.onConfirm, c.onAgentStatus),
    open_file:   (ex, c) => {
        c.onAgentStatus?.(`Opening file in editor: ${c.resolvedPath}...`);
        ex.onToolEvent?.('open_file', { path: c.resolvedPath });
        return `Success: File ${c.resolvedPath} opened in client editor tab.`;
    },
    multi_replace_file_content: (ex, c) => handleMultiReplace(ex, c.args, c.onConfirm, c.onAgentStatus),
    replace_lines:   (ex, c) => handleReplaceLines(ex, c.args, c.onConfirm, c.onAgentStatus),
    propose_plan:    (ex, c) => handleProposePlan(ex, c.args, c.onConfirm, c.onAgentStatus),
    present_result:  (ex, c) => handlePresentResult(ex, c.args, c.onAgentStatus),
    create_artifact: (ex, c) => handleArtifact(ex, c.args, c.name, c.onAgentStatus),
    update_artifact: (ex, c) => handleArtifact(ex, c.args, c.name, c.onAgentStatus),
    fetch_url:       (ex, c) => handleFetchUrl(ex, c.args, c.onAgentStatus),
    finish_task:     (ex, c) => handleFinishTask(ex, c.args, c.onAgentStatus),
    ask_user:        (ex, c) => handleAskUser(ex, c.args, c.onAgentStatus),
    verify_syntax:   (ex, c) => handleVerifySyntax(ex, c.args, c.onAgentStatus, c.resolvedPath),
    task_progress:   (ex, c) => handleTaskProgress(ex, c.args),
};

export class ToolExecutor {
    constructor() {
        this._taskCompleted = false;
        this._awaitingUser = false;
        this._userQuestion = '';
        this.toolDefinitions = TOOL_DEFINITIONS;
        this.sessionModifiedFiles = new Map();
        this._sessionActive = false;
        this._currentSessionId = null;
        this.workspacePath = null;
        this.onToolEvent = null; // Callback for notifying UI/Client on tool execution events

        // ── Plan gate (investigate → plan → approve → execute) ──────────
        // When _planRequired is set (by AgentController for complex tasks) and the
        // user hasn't approved a plan yet, mutating tools are blocked. Reset per session.
        this._planRequired = false;
        this._planApproved = false;
        this._approvedPlan = null;

        // ── New per-session state introduced for the safety/UX upgrade ──
        // edit count per file (normalized path → count). Used to warn the LLM
        // when it's been hammering the same file repeatedly (often a sign of
        // a fundamentally wrong approach).
        this._fileEditCount = new Map();
        // task_progress tool state (now workspace-persistent across sessions).
        this._taskProgressItems = [];   // [{ id, title, status, note }, ...]
        this._taskProgressLoaded = false;
        this._taskProgressCarriedOver = false; // incomplete items loaded from a prior session

        // ── Tool allowlist (per-session, set by behavior) ─────────────────
        // null  → all tools allowed (default)
        // Set() → only the names in the set are allowed; others return an error
        // []    → effectively disables all tools (caller wants chat-only mode)
        this._toolAllowlist = null;
        this._mcpBypassesAllowlist = false;
        // ── MCP server filter (per-session, set by behavior.mcp_servers) ───
        // null     → all MCP servers available
        // Set<str> → only tools from listed server names are included
        this._mcpServerFilter = null;
        // ── MCP per-task context (set by behavior.mcp_context) ─────────────
        // Injected into every tools/call as params._meta.jhai so an app-hosted
        // MCP server can resolve the live document/window the call targets.
        this._mcpContext = null;
        // ── MCP tool pruning (interactive callers only) ────────────────────
        // When a relevance query is set (the task prompt), only the top-5 most
        // relevant MCP tools are sent to the LLM; the rest are omitted entirely.
        this._mcpRelevanceQuery = null;
    }

    /**
     * Enable MCP tool pruning by relevance to `query` (the task prompt).
     * null/empty → pruning off (ALL MCP tools sent with full schemas — the
     * previous behavior; also what external app callers keep).
     */
    setMcpRelevanceQuery(query) {
        this._mcpRelevanceQuery = (typeof query === 'string' && query.trim()) ? query : null;
    }

    /** Per-task MCP context object (e.g. {app,windowId,documentId}) or null. */
    setMcpContext(ctx) {
        this._mcpContext = (ctx && typeof ctx === 'object') ? ctx : null;
    }

    /**
     * Configure which tools may be invoked during the active session.
     * Called by AgentController when behavior.enabled_tools is provided.
     *
     * @param {string[]|null} allowedNames null → unrestricted; array → allowlist.
     *   The minimal agent-CONTROL tools (finish_task / present_result / ask_user)
     *   are ALWAYS implicitly allowed so a capability-scoped task can still
     *   terminate, deliver its Result Contract, or pause for clarification — even
     *   when the intent only lists domain tools (e.g. get_buffer).
     * @param {object} [opts]
     * @param {boolean} [opts.includePlanTools] also allow task_progress + propose_plan.
     *   These help multi-step / plan-first tasks but invite needless over-planning
     *   on single-shot app intents, so the caller opts in (plan-mode / complex task).
     */
    setToolAllowlist(allowedNames, { includePlanTools = false } = {}) {
        if (allowedNames === null || allowedNames === undefined) {
            this._toolAllowlist = null;
            return;
        }
        const set = new Set(allowedNames);
        set.add('finish_task');
        set.add('present_result');
        set.add('ask_user');
        if (includePlanTools) {
            set.add('task_progress');
            set.add('propose_plan');
        }
        this._toolAllowlist = set;
    }

    /** Restrict which MCP servers contribute tools this session. null = all. */
    setMcpServerFilter(serverNames) {
        if (!serverNames || serverNames.length === 0) {
            this._mcpServerFilter = null;
            return;
        }
        this._mcpServerFilter = new Set(serverNames);
    }

    /** Returns the tool definitions filtered by the active allowlist. */
    getActiveToolDefinitions() {
        if (!this._toolAllowlist) return this.toolDefinitions;
        return this.toolDefinitions.filter(t => this._toolAllowlist.has(t.name));
    }

    async startSession(workspacePath) {
        this._sessionActive = true;
        this._currentSessionId = `sess_${Date.now()}`;
        this.sessionModifiedFiles.clear();
        this._fileEditCount.clear();
        // task_progress is now WORKSPACE-persistent (.agent/tasks.json), not
        // per-session: items survive across runs so a multi-session project keeps
        // its checklist. We clear the in-memory copy and reset the loaded flag so
        // the first task_progress access this session RELOADS from the workspace
        // file (rather than wiping it).
        this._taskProgressItems = [];
        this._taskProgressLoaded = false;
        this._taskProgressCarriedOver = false; // reset; set true if prior-session items load
        this._taskCompleted = false;
        this._awaitingUser = false;    // reset ask_user pause flag per session
        this._userQuestion = '';
        this._toolAllowlist = null;    // reset; caller may re-set after startSession
        this._mcpBypassesAllowlist = false;
        this._mcpServerFilter = null; // reset MCP server filter
        this._mcpContext = null;      // reset per-task MCP context
        this._mcpRelevanceQuery = null;        // reset MCP pruning (caller re-sets)
        // Plan gate resets each session (caller sets requirement via setPlanGate).
        this._planRequired = false;
        this._planApproved = false;
        this._approvedPlan = null;
        this.workspacePath = workspacePath || '.';

        // ── Write-allowed directories ──────────────────────────────────
        // Directories (besides the workspace) where write_file /
        // multi_replace_file_content may write WITHOUT user approval.
        // Populated from config: `write_allowed_paths` (explicit list) plus
        // `approved_projects` (already-trusted project roots). Writes outside
        // the workspace AND outside all of these still require approval.
        this._writeAllowedPaths = [];
        try {
            const cfg = await invoke('get_ai_config');
            const explicit = Array.isArray(cfg?.write_allowed_paths) ? cfg.write_allowed_paths : [];
            const projects = Array.isArray(cfg?.approved_projects) ? cfg.approved_projects : [];
            this._writeAllowedPaths = [...explicit, ...projects]
                .filter(p => typeof p === 'string' && p.trim())
                .map(p => p.replace(/\\/g, '/').replace(/\/+$/, ''));
        } catch (e) { /* config unavailable — only workspace is allowed */ }

        // ── Register write/exec roots with the Rust path guard ─────────
        // Defense-in-depth: the backend refuses to write/delete/exec outside
        // these roots even if this layer's confirm logic is bypassed.
        try {
            const roots = [this.workspacePath, ...(this._writeAllowedPaths || [])]
                .filter(p => typeof p === 'string' && p.trim() && p !== '.');
            if (roots.length > 0) {
                await invoke('set_allowed_roots', { roots });
            }
        } catch (e) {
            console.warn('Failed to register path-guard roots:', e);
        }

        // ── Session file cache ─────────────────────────────────────────
        // Stores the most-recent content of every file read or written this
        // session so ConversationMemory can re-inject them verbatim after
        // context compaction instead of the agent having to re-read them.
        //
        // Schema: Map<normalizedPath, { content, readCount, editedAt, readAt }>
        //   editedAt  null if file was only read, Date.now() if written/replaced
        //   readCount increments each time read_file is called for this path
        this._fileCache = new Map();

        // ── Consecutive multi_replace failure count per file ──────────
        // When a file racks up 3 failed multi_replace_file_content attempts
        // in a row, we force a fresh read (bypassing cache) and surface the
        // current content in the error so the LLM can build a correct
        // old_text on the next try instead of looping forever. Resets to 0
        // on a successful edit OR after a forced-recovery cycle so the LLM
        // gets a clean slate.
        this._multiReplaceFailCount = new Map();

        // Create session artifact directory
        try {
            const sessionDir = this.getSessionArtifactDir(this.workspacePath);
            await invoke('create_dir', { path: sessionDir });
            console.log(`Agent Session started: ${this._currentSessionId} in ${this.workspacePath}`);
        } catch (e) {
            console.warn('Failed to create session directory:', e);
        }
    }

    /**
     * Handle a multi_replace_file_content failure (Fix D).
     *
     * Bumps the per-file consecutive-failure counter. When the counter reaches
     * 3, evicts the file from cache, re-reads it fresh from disk, and appends
     * the current content to the error message — giving the LLM a known-good
     * basis for its next old_text. The counter is then reset so the LLM has a
     * clean slate to retry.
     *
     * @param {string} editPath  resolved file path (forward-slash form)
     * @param {string} normPath  cache key (same as editPath here, but kept
     *                           separate so we don't recompute)
     * @param {string} errMsg    base error message to augment
     * @returns {string} the (possibly augmented) error to return to the LLM
     */
    async _handleMultiReplaceFailure(editPath, normPath, errMsg) {
        const newCount = (this._multiReplaceFailCount.get(normPath) || 0) + 1;
        this._multiReplaceFailCount.set(normPath, newCount);

        if (newCount < 3) {
            return errMsg;
        }

        // ── Auto-recovery: force fresh read ─────────────────────────────
        this._multiReplaceFailCount.set(normPath, 0); // reset — give LLM a clean slate

        let fresh;
        try {
            fresh = await invoke('read_file', { path: editPath });
        } catch (_) {
            return errMsg; // recovery best-effort; if re-read fails, just return original error
        }

        // Update cache with the fresh content so subsequent calls don't return stale data.
        if (this._fileCache) {
            const existing = this._fileCache.get(normPath);
            this._fileCache.set(normPath, {
                content: fresh,
                readCount: (existing?.readCount || 0) + 1,
                readAt: Date.now(),
                editedAt: existing?.editedAt || null
            });
        }

        const lines = fresh.split('\n');
        const PREVIEW = 200;
        const preview = lines.length > PREVIEW
            ? lines.slice(0, PREVIEW).join('\n') +
              `\n... [${lines.length - PREVIEW} more lines — call read_file with offset=${PREVIEW + 1} for the rest]`
            : fresh;

        return `${errMsg}\n\n` +
            `[Auto-recovery — 3rd consecutive multi_replace failure on this file]\n` +
            `Cache cleared and file just re-read from disk. Current content ` +
            `(${Math.min(lines.length, PREVIEW)} of ${lines.length} lines):\n\n` +
            `=== ${editPath} ===\n${preview}\n\n` +
            `Build your next old_text using the EXACT content above — copy whitespace, ` +
            `tabs, and line breaks as-is. Do not paraphrase.`;
    }

    /**
     * Increment the per-file edit counter and return the new count.
     * Caller (multi_replace_file_content / write_file handlers) can use this
     * to surface a warning message when the same file has been edited many times.
     */
    _bumpFileEditCount(path) {
        const key = (path || '').replace(/\\/g, '/');
        const n = (this._fileEditCount.get(key) || 0) + 1;
        this._fileEditCount.set(key, n);
        return n;
    }

    /**
     * Shared write-back path for line/region edits (used by replace_lines).
     * Handles: outside-workspace confirmation (fail-closed), write, modification
     * tracking + UI events, read-back, structural sanity check, session-cache
     * update, edit-count warning, and a truncated content preview. Returns the
     * tool-result string to hand back to the model.
     *
     * @param {string} editPath           resolved file path
     * @param {string} currentContent     file content BEFORE the edit
     * @param {string} finalEditedContent file content AFTER the edit (line endings restored)
     * @param {Function|null} onConfirm   approval channel
     * @param {string} opSummary          short human description of the op (e.g. "Replaced lines 10-14")
     */
    async _finalizeEdit(editPath, currentContent, finalEditedContent, onConfirm, opSummary) {
        const isSafeRootEdit = this._isWriteAllowed(editPath);
        if (!isSafeRootEdit) {
            if (!onConfirm) {
                return `Error: edit denied — ${editPath} is outside the workspace and allowed write paths, and no approval channel is available.`;
            }
            const res = await onConfirm({
                type: 'diff_review',
                path: editPath,
                newContent: finalEditedContent,
                oldContent: currentContent,
                message: `AI wants to write to file outside workspace:\nPath: ${editPath}`
            });
            if (res === false || res === null) return 'Error: User Denied file write.';
            await this._allowApprovedPath(editPath);
            if (typeof res === 'string') {
                await invoke('write_file', { path: editPath, content: res });
                return `Success: User modified and saved to ${editPath}`;
            }
        }

        await invoke('write_file', { path: editPath, content: finalEditedContent });
        this._recordModification(editPath, currentContent, finalEditedContent);
        this.onToolEvent?.('file_modified', { path: editPath, action: 'edit', diff: `- original\n+ modified` });
        this.onToolEvent?.('open_file', { path: editPath });

        // Auto read-back so corruption is visible to the model next turn.
        let verifiedContent = finalEditedContent;
        try { verifiedContent = await invoke('read_file', { path: editPath }); } catch (_) { /* keep written */ }

        if (this._fileCache) {
            const normPath = editPath.replace(/\\/g, '/');
            const existing = this._fileCache.get(normPath);
            this._fileCache.set(normPath, {
                content: verifiedContent,
                readCount: existing?.readCount || 0,
                readAt: existing?.readAt || null,
                editedAt: Date.now()
            });
        }

        const editCount = this._bumpFileEditCount(editPath);
        const oldLines = currentContent.split('\n').length;
        const newLines = verifiedContent.split('\n').length;
        const lineDelta = newLines - oldLines;

        const balance = (txt) => {
            const counts = { '{': 0, '}': 0, '[': 0, ']': 0, '(': 0, ')': 0 };
            for (const ch of txt) if (counts[ch] !== undefined) counts[ch]++;
            return { braces: counts['{'] - counts['}'], brackets: counts['['] - counts[']'], parens: counts['('] - counts[')'] };
        };
        const before = balance(currentContent);
        const after = balance(verifiedContent);
        const warnings = [];
        if (Math.abs(after.braces) > Math.abs(before.braces) + 1) warnings.push(`brace imbalance worsened (was ${before.braces}, now ${after.braces})`);
        if (Math.abs(after.brackets) > Math.abs(before.brackets) + 1) warnings.push(`bracket imbalance worsened (was ${before.brackets}, now ${after.brackets})`);
        if (Math.abs(after.parens) > Math.abs(before.parens) + 1) warnings.push(`paren imbalance worsened (was ${before.parens}, now ${after.parens})`);

        let editCountWarning = '';
        if (editCount === 5) {
            editCountWarning = `\n[Warning] This is the 5th edit to ${editPath} in this session. If the file is getting tangled, reassess the approach.`;
        } else if (editCount >= 8) {
            editCountWarning = `\n[Warning] ${editCount} edits to ${editPath} so far — STOP and reassess; you may be thrashing.`;
        }

        const PREVIEW_LINES = 400;
        const previewLines = verifiedContent.split('\n').slice(0, PREVIEW_LINES);
        const truncated = newLines > PREVIEW_LINES;
        const preview = previewLines.join('\n') + (truncated ? `\n... [${newLines - PREVIEW_LINES} more lines truncated; call read_file if you need the rest]` : '');

        const warnBlock = warnings.length > 0
            ? `\n[Structural Warning] ${warnings.join('; ')}. The edit may have corrupted the file — INSPECT the content below and fix immediately if broken. Also call verify_syntax for .js/.ts/.json files.`
            : '';

        return `Success: ${opSummary} in ${editPath}. ` +
            `(${oldLines} → ${newLines} lines, delta ${lineDelta >= 0 ? '+' : ''}${lineDelta})` +
            warnBlock + editCountWarning +
            `\n\n=== File content after edit (first ${Math.min(newLines, PREVIEW_LINES)} lines) ===\n${preview}`;
    }

    /**
     * Path of the WORKSPACE-level persistent task list.
     * Stored at <workspace>/.agent/tasks.json so the checklist survives across
     * SESSIONS (not just the loop) — a multi-run project keeps its tasks. Falls
     * back to the session artifact dir only when there's no real workspace.
     */
    _taskProgressPath() {
        const root = this.workspacePath && this.workspacePath !== '.'
            ? this.workspacePath.replace(/[\\/]+$/, '')
            : null;
        return root ? `${root}/.agent/tasks.json` : `${this.getSessionArtifactDir()}/task_progress.json`;
    }

    /** Directory that holds the task list file (create_dir target before write). */
    _taskProgressDir() {
        const root = this.workspacePath && this.workspacePath !== '.'
            ? this.workspacePath.replace(/[\\/]+$/, '')
            : null;
        return root ? `${root}/.agent` : this.getSessionArtifactDir();
    }

    async _loadTaskProgress() {
        if (this._taskProgressLoaded) return;
        try {
            const raw = await invoke('read_file', { path: this._taskProgressPath() });
            if (raw) {
                const data = JSON.parse(raw);
                if (Array.isArray(data) && data.length > 0) {
                    // Cross-session safety: DROP completed items on load so a
                    // finished project can't haunt the next (possibly unrelated)
                    // session. Only INCOMPLETE work carries over, and it's flagged
                    // as a prior-session carryover (rendered with a warning) so the
                    // agent treats it as old — it can continue it or replace the
                    // whole list via action="set". Within a session this never
                    // re-runs (guarded by _taskProgressLoaded), so completed items
                    // stay visible until the session ends.
                    const incomplete = data.filter(it => it && it.status !== 'completed');
                    this._taskProgressItems = incomplete;
                    this._taskProgressCarriedOver = incomplete.length > 0;
                }
            }
        } catch (_) { /* file missing on first call — fine */ }
        this._taskProgressLoaded = true;
    }

    async _saveTaskProgress() {
        try {
            await invoke('create_dir', { path: this._taskProgressDir() });
            await invoke('write_file', {
                path: this._taskProgressPath(),
                content: JSON.stringify(this._taskProgressItems, null, 2)
            });
        } catch (e) {
            console.warn('Failed to persist task_progress:', e);
        }
    }

    /** Pretty-format the current task_progress list for return from the tool. */
    _renderTaskProgress() {
        if (!this._taskProgressItems || this._taskProgressItems.length === 0) {
            return 'task_progress is empty. Use action="set" to register subtasks.';
        }
        const icon = (s) => ({
            pending: '⬜', in_progress: '🔵', completed: '✅', blocked: '🚫'
        }[s] || '⬜');
        const lines = this._taskProgressItems.map(it => {
            const note = it.note ? `  (${it.note})` : '';
            return `${icon(it.status)} [${it.id}] ${it.title || '(no title)'}${note}`;
        });
        const done = this._taskProgressItems.filter(it => it.status === 'completed').length;
        const total = this._taskProgressItems.length;
        const carryNote = this._taskProgressCarriedOver
            ? '⚠ These tasks were CARRIED OVER from a PREVIOUS session (incomplete items only). ' +
              'If your current goal continues this work, use them; if this is unrelated new work, ' +
              'call task_progress(action="set", ...) to replace the list with fresh subtasks.\n'
            : '';
        return `${carryNote}task_progress (${done}/${total} complete):\n${lines.join('\n')}`;
    }

    /**
     * Returns the session file cache Map so ConversationMemory can re-inject
     * file contents verbatim after context compaction.
     * Schema: Map<normalizedPath, { content, readCount, editedAt, readAt }>
     */
    getFileCache() {
        return this._fileCache || new Map();
    }

    endSession() {
        console.log(`Agent Session ended: ${this._currentSessionId}`);
        this._sessionActive = false;
        this._currentSessionId = null;
        this.workspacePath = null;
        this._toolAllowlist = null;
        this._mcpServerFilter = null;
        this._mcpContext = null;
    }

    isSessionActive() {
        return this._sessionActive;
    }

    isTaskCompleted() {
        return !!this._taskCompleted;
    }

    /** True when ask_user paused the run waiting for the user's reply. */
    isAwaitingUser() {
        return !!this._awaitingUser;
    }

    /** The clarifying question (+ optional context) ask_user surfaced, if any. */
    getUserQuestion() {
        return this._userQuestion || '';
    }

    getCurrentSessionId() {
        return this._currentSessionId;
    }

    getSessionArtifactDir(workspacePath) {
        const root = workspacePath || this.workspacePath || '.';
        if (this._currentSessionId) {
            return `${root}/.agent/sessions/${this._currentSessionId}`;
        }
        return `${root}/.agent/artifacts`;
    }

    getModifiedFiles() {
        return Array.from(this.sessionModifiedFiles.entries()).map(([path, data]) => ({
            path,
            original: data.original,
            current: data.current
        }));
    }

    _recordModification(path, original, current) {
        const normalizedPath = path.replace(/\\/g, '/');
        if (!this.sessionModifiedFiles.has(normalizedPath)) {
            this.sessionModifiedFiles.set(normalizedPath, { original, current });
        } else {
            this.sessionModifiedFiles.get(normalizedPath).current = current;
        }
    }

    // Pure fuzzy matching → ./tools/FuzzyPath.js (unit-tested). This wrapper does
    // the directory READ, then delegates the scoring/decision.
    _levenshtein(a, b) { return levenshtein(a, b); }

    async _fuzzyFindFile(resolvedPath) {
        const norm = String(resolvedPath).replace(/\\/g, '/');
        const lastSlash = norm.lastIndexOf('/');
        const dir = lastSlash > 0 ? norm.slice(0, lastSlash) : (this.workspacePath || '.');
        let entries;
        try { entries = await invoke('read_dir', { path: dir }); }
        catch (_) { return null; }
        return pickClosestFile(resolvedPath, entries, this.workspacePath);
    }

    /** Build a helpful "file not found" error with did-you-mean suggestions. */
    _notFoundError(resolvedPath, suggestions) {
        const hint = (suggestions && suggestions.length > 0)
            ? `\n\nDid you mean one of these?\n  ${suggestions.join('\n  ')}`
            : `\n\n(No similar file names found. Try list_files on the parent directory, or grep_search for content you know is in the file.)`;
        return `Error: file not found: ${resolvedPath}${hint}`;
    }

    /**
     * Read a file, fuzzy-correcting a mistyped path when there is exactly one
     * confident match in the folder (e.g. Side.tsx → Sidebar.tsx). Returns
     * { ok:true, path, content, note } on success (note is non-empty when the
     * path was auto-corrected) or { ok:false, error } with suggestions.
     */
    async _readFileSmart(resolvedPath) {
        try {
            const content = await invoke('read_file', { path: resolvedPath });
            return { ok: true, path: resolvedPath, content, note: '' };
        } catch (readErr) {
            const msg = String(readErr?.message || readErr || '');
            const isNotFound = /not found|os error 2|cannot find|no such file/i.test(msg);
            if (!isNotFound) {
                return { ok: false, error: `Error: read failed for ${resolvedPath} — ${msg}` };
            }
            const fix = await this._fuzzyFindFile(resolvedPath);
            if (fix && fix.autoCorrect) {
                try {
                    const content = await invoke('read_file', { path: fix.path });
                    const wrong = resolvedPath.split(/[\\/]/).pop();
                    return {
                        ok: true,
                        path: fix.path,
                        content,
                        note: `ℹ️ Auto-corrected path: "${wrong}" → "${fix.name}" (closest match in folder). Use this exact path from now on.\n`
                    };
                } catch (_) { /* fall through to not-found */ }
            }
            return { ok: false, error: this._notFoundError(resolvedPath, fix?.suggestions || []) };
        }
    }

    isSafeTool(name) {
        const tool = this.toolDefinitions.find(t => t.name === name);
        return tool ? !!tool.isSafe : false;
    }

    /**
     * Returns true if a resolved write path may be written WITHOUT user
     * approval — i.e. it is inside the workspace OR inside any configured
     * allowed directory (write_allowed_paths / approved_projects).
     */
    _isWriteAllowed(resolvedPath) {
        const p = (resolvedPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!p) return false;
        const ws = this.workspacePath ? this.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '') : '';
        if (ws && (p === ws || p.startsWith(ws + '/'))) return true;
        return (this._writeAllowedPaths || []).some(a => p === a || p.startsWith(a + '/'));
    }

    /** True if `resolvedPath` is the workspace root or nested inside it. */
    _isInsideWorkspace(resolvedPath) {
        const p = (resolvedPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const ws = this.workspacePath ? this.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '') : '';
        if (!p || !ws) return false;
        return p === ws || p.startsWith(ws + '/');
    }

    /**
     * Classify a tool call into a permission level the AgentController uses to
     * decide execution strategy:
     *   "Allow" → safe; run in parallel without confirmation.
     *   "Ask"   → potentially destructive / outside-workspace; run sequentially
     *             and require user approval (onConfirm) before executing.
     *   "Deny"  → disabled by the active per-session allowlist; never executes.
     *
     * This is the source of truth the agent loop consults; executeTool ALSO
     * enforces a fail-closed confirmation gate as defense-in-depth, so an
     * "Ask" operation can never run when no approval channel is wired.
     */
    getPermissionLevel(name, args = {}) {
        const isNative = this.toolDefinitions.some(t => t.name === name);
        if (!isNative) {
            // MCP/External tools (provided by another app/API) bypass all permission checks
            return 'Allow';
        }

        if (this._toolAllowlist && name !== 'finish_task' && !this._toolAllowlist.has(name)) {
            if (isNative || !this._mcpBypassesAllowlist) {
                return 'Deny';
            }
        }
        const a = args || {};
        const pickPath = () => this.resolvePath(a.path || a.file_path || a.filepath || a.file || a.dir || a.directory);
        switch (name) {
            case 'run_command':
                return 'Ask'; // arbitrary shell execution is always gated
            case 'delete_file':
                return this._isInsideWorkspace(pickPath()) ? 'Allow' : 'Ask';
            case 'move_file': {
                const from = this.resolvePath(a.from);
                const to = this.resolvePath(a.to);
                return (this._isInsideWorkspace(from) && this._isInsideWorkspace(to)) ? 'Allow' : 'Ask';
            }
            case 'write_file':
            case 'multi_replace_file_content':
            case 'replace_lines':
                return this._isWriteAllowed(pickPath()) ? 'Allow' : 'Ask';
            default:
                return 'Allow';
        }
    }

    /**
     * Fail-closed confirmation gate for boolean-approval operations.
     * Returns true if the op may proceed, false if it must be blocked.
     *   • safe op                       → true  (no prompt)
     *   • unsafe op + approval channel  → user's decision
     *   • unsafe op + NO channel        → false (denied — closes the headless
     *                                     "no onConfirm ⇒ silent execution" hole)
     */
    async _confirmUnsafe(isSafe, onConfirm, payload) {
        if (isSafe) return true;
        if (!onConfirm) return false;
        return !!(await onConfirm(payload));
    }

    /**
     * Register a path the user has just approved so the Rust path guard will
     * permit the imminent write/delete/move to it. Best-effort — a registration
     * failure is logged but does not block the (already user-approved) action.
     */
    async _allowApprovedPath(...paths) {
        try {
            const roots = paths.filter(p => typeof p === 'string' && p.trim());
            if (roots.length > 0) await invoke('set_allowed_roots', { roots });
        } catch (e) {
            console.warn('Path-guard registration failed for approved path:', e);
        }
    }

    static getAllAvailableToolsForNativeAPI() {
        const dummy = new ToolExecutor();
        return dummy.getToolsForNativeAPI();
    }

    /** MCP tools passing the session's server filter + allowlist (pre-pruning). */
    _eligibleMcpTools() {
        const allow = this._toolAllowlist;
        return mcpManager.getAllTools().filter(t => {
            if (this._mcpServerFilter && !this._mcpServerFilter.has(t._serverName)) return false;
            if (allow && !this._mcpBypassesAllowlist && !allow.has(t.name)) return false;
            return true;
        });
    }

    getToolsForNativeAPI() {
        // Respect the per-session allowlist so the LLM is only PRESENTED tools it
        // may actually use. Otherwise a capability-scoped task (e.g. an app intent
        // with tools:['get_buffer']) sees every built-in, wastes steps calling
        // them, and gets "not enabled for this task" at execution — looking like a
        // permission wall. (Mirrors getActiveToolDefinitions filtering.)
        const allow = this._toolAllowlist;

        // Built-in tool schemas are authored strict-compliant, so they are
        // always eligible for OpenAI Structured Outputs. The `_strict_ok` hint
        // is read by the Rust layer, which sets function.strict per provider.
        const nativeTools = this.toolDefinitions
            .filter(t => !allow || allow.has(t.name))
            .map(t => ({
                type: 'function',
                _strict_ok: true,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));

        // MCP tools: when a relevance query is set (interactive callers), only
        // the top-5 most relevant to the task prompt are sent; the rest are
        // omitted. With no query (Simple chat, external app callers) ALL
        // eligible tools load — the previous behavior.
        const { loaded: mcpTools } = selectMcpTools(
            this._eligibleMcpTools(),
            this._mcpRelevanceQuery
        );
        mcpTools.forEach(t => {
            const rawSchema = t.inputSchema || { type: 'object', properties: {} };
            // Third-party MCP schemas: convert the ones we safely can to strict
            // form, leave the rest as-is (sent WITHOUT strict).
            const { schema, eligible } = toStrictSchema(rawSchema);
            nativeTools.push({
                type: 'function',
                _strict_ok: eligible,
                function: {
                    name: t.name,
                    description: t.description || `MCP tool from ${t._serverName}`,
                    parameters: schema
                }
            });
        });

        return nativeTools;
    }

    resolvePath(path) {
        const root = this.workspacePath || '.';
        if (!path) return root;

        // ── Recover from JSON-escape damage in Windows paths ──
        // LLMs frequently miss a backslash inside JSON strings — e.g. they
        // intend `C:\projects\app\plan.md` but write
        // `C:\projectsapp\plan.md` (the `\a` consumed by JSON.parse as an
        // invalid escape, leaving the next char attached to the previous
        // segment). If we see a Windows-drive-style path that doesn't exist
        // and the project root is a prefix-ish match, splice it back in.
        if (typeof path === 'string' && /^[a-zA-Z]:/.test(path) && this.workspacePath) {
            const wsNorm = this.workspacePath.replace(/\\/g, '/').replace(/\/$/, '');
            const pNorm  = path.replace(/\\/g, '/');
            // If the workspace root is "C:/foo/bar" and the supplied path looks
            // like "C:/foo/barbaz.md", peel the workspace prefix off and re-attach with /.
            if (pNorm.toLowerCase().startsWith(wsNorm.toLowerCase()) &&
                pNorm.length > wsNorm.length &&
                pNorm[wsNorm.length] !== '/') {
                const rebuilt = wsNorm + '/' + pNorm.slice(wsNorm.length);
                console.warn(`resolvePath: repaired likely escape-damaged path "${path}" → "${rebuilt}"`);
                path = rebuilt;
            }
        }

        let normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');

        // Absolute path Check
        if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
            const safeRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
            const isWindowsRoot = /^[a-zA-Z]:/.test(safeRoot);

            if (isWindowsRoot && normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)) {
                const relativePart = normalized.replace(/^\/+/, '');
                return `${safeRoot}/${relativePart}`.replace(/\/+/g, '/');
            }
            return normalized;
        }

        // Relative path
        const safeRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
        if (normalized === '.' || normalized === './') return safeRoot;
        if (normalized.startsWith('./')) {
            normalized = normalized.substring(2);
        }

        const relativePart = normalized.replace(/^\/+/, '');
        return `${safeRoot}/${relativePart}`.replace(/\/+/g, '/');
    }

    /** Configure the plan gate for the current session (called by AgentController). */
    setPlanGate(required) {
        this._planRequired = !!required;
        if (!required) this._planApproved = true; // gate off ⇒ nothing to approve
    }

    async executeTool(call, onAgentStatus, onConfirm) {
        const { name } = call;
        const args = call.args || {};
        workflowManager.autoAdvance(name);

        // Enforce per-session tool allowlist (configured via setToolAllowlist).
        // Always permit finish_task so a restricted agent can still terminate.
        const isNative = this.toolDefinitions.some(t => t.name === name);
        if (isNative && this._toolAllowlist && !this._toolAllowlist.has(name)) {
            return `Error: Tool "${name}" is not enabled for this task. Allowed tools: ${[...this._toolAllowlist].join(', ')}.`;
        }

        // ── Plan gate ───────────────────────────────────────────────────
        // Block mutating tools until an approved plan exists (complex tasks).
        // Investigation tools and propose_plan are always allowed.
        if (planShouldBlock(name, this._planRequired, this._planApproved)) {
            return planGateMessage(name);
        }

        const rawPath = args.path || args.file_path || args.filepath || args.file || args.dir || args.directory;

        const needsFilePath = ['read_file', 'write_file', 'open_file', 'multi_replace_file_content', 'replace_lines', 'delete_file'];
        if (needsFilePath.includes(name) && (!rawPath || typeof rawPath !== 'string' || rawPath.trim() === '')) {
            return `Error: Missing required valid 'path' parameter for tool '${name}'.`;
        }

        // Tools that handle path resolution themselves (or take no single path):
        //   run_command  — command string, cwd is workspace
        //   grep_search  — args.path is optional, resolved inside the handler
        //   glob         — same
        //   move_file    — uses args.from / args.to, both resolved inside the handler
        const noAutoResolve = new Set(['run_command', 'grep_search', 'glob', 'move_file']);
        const resolvedPath = noAutoResolve.has(name) ? null : this.resolvePath(rawPath);

        try {
            // Dispatch built-ins via the registry; everything else is an MCP /
            // unknown tool. Adapters return the handler's value/promise directly,
            // so this try/catch wraps them exactly as the old switch did.
            const handler = TOOL_HANDLERS[name];
            if (handler) {
                // MUST await: a bare `return handler(...)` returns the handler's
                // promise without awaiting, so a rejection (e.g. read_dir → os
                // error 3 on a missing path) escapes this try/catch and aborts the
                // whole agent run instead of being returned as a tool-error string.
                return await handler(this, { args, onConfirm, onAgentStatus, resolvedPath, name });
            }
            return await this._dispatchMcpTool(name, args, onAgentStatus);
        } catch (e) {
            return `Error executing ${name}: ${e.message || e}`;
        }
    }

    /**
     * Dispatch a non-built-in tool to its MCP server (the old switch `default`).
     * Returns the tool's text result, or an error string if the tool is unknown.
     */
    async _dispatchMcpTool(name, args, onAgentStatus) {
        const targetTool = mcpManager.getAllTools().find(t => t.name === name);
        if (!targetTool) {
            return `Error: Tool "${name}" not found. Available MCP tools: ${mcpManager.getAllTools().map(t => t.name).join(', ') || 'none'}.`;
        }
        onAgentStatus?.(`Calling MCP tool: ${name} (${targetTool._serverName})...`);
        // Strict Structured Outputs forces the model to emit every (now-required)
        // optional field as null. Drop top-level null args so MCP servers that
        // distinguish "absent" from "null" see the field as omitted.
        const cleanArgs = Object.fromEntries(
            Object.entries(args || {}).filter(([, v]) => v !== null)
        );
        const meta = this._mcpContext ? { jhai: this._mcpContext } : null;
        const response = await mcpManager.callTool(targetTool._serverName, name, cleanArgs, meta);

        // MCP tool response format: { content: [{type:"text", text:"..."}], isError: bool }
        if (response && typeof response === 'object') {
            const isError = response.isError === true;
            const contentArr = Array.isArray(response.content) ? response.content : null;
            if (contentArr !== null) {
                const text = contentArr
                    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
                    .map(c => c.text)
                    .join('\n');
                return isError ? `Error (MCP ${name}): ${text}` : (text || '(empty response)');
            }
        }
        return typeof response === 'string' ? response : JSON.stringify(response, null, 2);
    }
}
