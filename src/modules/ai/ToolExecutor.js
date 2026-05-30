import { invoke } from '@tauri-apps/api/core';
import { mcpManager } from './McpManager.js';
import { workflowManager } from './WorkflowManager.js';

class ToolExecutor {
    constructor() {
        this._taskCompleted = false;
        this.toolDefinitions = [
            {
                name: 'list_files',
                isSafe: true,
                description: 'List files and subdirectories directly under the specified directory path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Directory path to list (. for project root)' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'read_file',
                isSafe: true,
                description: 'Read the content of a file as a UTF-8 text string. By default returns up to 2000 lines from the start. Use offset (1-indexed start line) and limit (max lines) for partial reads of large files. The result is prefixed with line numbers in `<lineno>\\t<content>` format for easy reference — these line numbers are display-only and must NEVER be included in multi_replace_file_content\'s old_text (use only the content after the tab).',
                parameters: {
                    type: 'object',
                    properties: {
                        path:   { type: 'string',  description: 'Path of the file to read' },
                        offset: { type: 'integer', description: 'Optional. 1-indexed starting line number (default 1). Use to skip past content you already have.' },
                        limit:  { type: 'integer', description: 'Optional. Maximum number of lines to return (default 2000). Increase for files where you need the whole content.' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'grep_search',
                isSafe: true,
                description: 'Recursively search for a regex pattern across files (respects .gitignore). Returns matching lines with file path and line number. Use this INSTEAD of read_file when you want to find where something is defined/used — it is dramatically cheaper than reading every file.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern:          { type: 'string',  description: 'Rust regex pattern (e.g. "function\\s+foo", "TODO|FIXME"). Special characters must be escaped.' },
                        path:             { type: 'string',  description: 'Optional. Root directory to search. Defaults to workspace root.' },
                        include_glob:     { type: 'string',  description: 'Optional. Limit search to files matching this glob (e.g. "*.{js,ts}", "src/**/*.rs"). Comma-separate multiple patterns.' },
                        case_insensitive: { type: 'boolean', description: 'Optional. Default false.' },
                        max_results:      { type: 'integer', description: 'Optional. Max matches to return (default 200, hard cap 2000).' },
                        context_lines:    { type: 'integer', description: 'Optional. Lines of context above/below each match (default 0, max 5).' }
                    },
                    required: ['pattern']
                }
            },
            {
                name: 'glob',
                isSafe: true,
                description: 'Find files whose path matches a glob pattern (respects .gitignore). Use ** for any directories, * for any chars within one segment. Examples: "**/*.test.js", "src/**/*.{ts,tsx}", "**/README*".',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern:     { type: 'string',  description: 'Glob pattern.' },
                        path:        { type: 'string',  description: 'Optional. Root directory to search. Defaults to workspace root.' },
                        max_results: { type: 'integer', description: 'Optional. Max files to return (default 500, hard cap 5000).' }
                    },
                    required: ['pattern']
                }
            },
            {
                name: 'delete_file',
                isSafe: false,
                description: 'Delete a single file. Refuses to delete directories. Asks the user to confirm unless inside the workspace root.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path of the file to delete' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'move_file',
                isSafe: false,
                description: 'Rename or move a file/directory. Creates any missing parent directories. Will not overwrite an existing destination unless overwrite=true.',
                parameters: {
                    type: 'object',
                    properties: {
                        from:      { type: 'string',  description: 'Source path' },
                        to:        { type: 'string',  description: 'Destination path' },
                        overwrite: { type: 'boolean', description: 'Optional. If true, replace an existing destination. Default false.' }
                    },
                    required: ['from', 'to']
                }
            },
            {
                name: 'write_file',
                isSafe: false,
                description: 'Create a new file or completely overwrite an existing file. The existing file\'s charset encoding is automatically preserved. SAFETY: if the file already exists but was not read in this session, the call is BLOCKED unless overwrite_unread=true is passed — this prevents accidental destruction of unfamiliar files. For partial edits, prefer multi_replace_file_content over full overwrite.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path of the file to write' },
                        content: { type: 'string', description: 'Entire content to write to the file' },
                        encoding: { type: 'string', description: 'Optional charset override: "utf-8" (default), "shift-jis", "euc-jp", "utf-16le", "utf-16be". If omitted, the existing file\'s encoding is preserved.' },
                        overwrite_unread: { type: 'boolean', description: 'Optional. Required (true) to overwrite a pre-existing file that has NOT been read with read_file in this session. Default false — protects you from clobbering a file you don\'t know the contents of.' }
                    },
                    required: ['path', 'content']
                }
            },
            {
                name: 'run_command',
                isSafe: false,
                description: 'Execute a shell command for builds, tests, or system checks. Defaults to a 60-second timeout; set timeout_ms for longer operations.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'Command string to run in the shell (e.g., "npm run test", "cargo check")' },
                        safe_to_auto_run: { type: 'boolean', description: 'Set to true if command is safe and has no side-effects. Skips user confirmation.' },
                        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 60000). Increase for long-running builds (e.g., 120000 for 2 minutes).' }
                    },
                    required: ['command']
                }
            },
            {
                name: 'multi_replace_file_content',
                description: 'Apply one or more content-based search-and-replace edits to an existing file. Each replacement provides the exact original text (old_text) and its replacement (new_text); old_text MUST match EXACTLY once in the file. BEST PRACTICE: keep old_text SHORT — ideally ONE line containing a unique identifier (plus a few words of context only if needed for uniqueness). Short exact anchors succeed far more often than large multi-line blocks, which are easy to mis-transcribe. To disambiguate when a line repeats, add the minimum extra context to make it unique. Set replace_all=true to update every occurrence (useful for renames). Line numbers are NEVER used — only literal string matching. IMPORTANT: when copying text from read_file output, strip the leading `<lineno>\\t` prefix from each line — that prefix is display-only and is NOT part of the file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path of the file to edit' },
                        replacements: {
                            type: 'array',
                            description: 'Ordered list of search-and-replace operations. Each is applied sequentially to the running content, so later old_texts must match what the file looks like AFTER earlier replacements.',
                            items: {
                                type: 'object',
                                properties: {
                                    old_text: { type: 'string', description: 'Exact literal text to find. Must match exactly once (unless replace_all=true). Include surrounding context if the snippet alone is ambiguous.' },
                                    new_text: { type: 'string', description: 'Replacement text. Use the empty string to delete the matched region.' },
                                    replace_all: { type: 'boolean', description: 'Optional. If true, every occurrence of old_text is replaced (uniqueness is not required). Default: false.' }
                                },
                                required: ['old_text', 'new_text']
                            }
                        }
                    },
                    required: ['path', 'replacements']
                }
            },
            {
                name: 'create_artifact',
                description: 'Create a new markdown artifact (e.g. implementation plan, checklist) and show it in a dedicated tab.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: "Name of the artifact file (e.g. 'task_plan')" },
                        content: { type: 'string', description: 'Content of the artifact in markdown format' }
                    },
                    required: ['name', 'content']
                }
            },
            {
                name: 'update_artifact',
                description: 'Update an existing markdown artifact (overwrites entire content).',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Name of the artifact file to update' },
                        content: { type: 'string', description: 'Updated entire content of the artifact' }
                    },
                    required: ['name', 'content']
                }
            },
            {
                name: 'finish_task',
                isSafe: true,
                description: "Declare that all changes, tests, and verification have successfully completed, achieving the user's goal.",
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string', description: 'A concise final summary of what was accomplished' }
                    },
                    required: ['summary']
                }
            },
            {
                name: 'verify_syntax',
                isSafe: true,
                description: 'Validate a file using a real parser. JSON files are parsed in-process; JS/JSX/MJS/CJS files are validated by spawning `node --check` (real V8 parser); TS/TSX files are skipped with guidance (use `run_command npx tsc --noEmit` for type checking). Call after every edit to .json/.js/.jsx/.mjs/.cjs files to catch syntax breakage immediately.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path of the file to syntax-check' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'task_progress',
                isSafe: true,
                description: 'Track subtask completion state across the agent loop. State persists independently of conversation history (survives context compaction). Use action="set" once at task start to register items, action="update" to mark items complete/in_progress/blocked, action="get" to check current state without re-reading task_plan.md.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['set', 'update', 'get'],
                            description: '"set" replaces the entire item list (use at task start). "update" patches one or more items by id. "get" returns the current state without changes.'
                        },
                        items: {
                            type: 'array',
                            description: 'For "set": full list of subtasks. For "update": one or more items with id + new status (other fields optional).',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: 'Stable identifier (e.g. "1", "2a")' },
                                    title: { type: 'string', description: 'Short subtask description' },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'in_progress', 'completed', 'blocked'],
                                        description: 'Current state of the subtask'
                                    },
                                    note: { type: 'string', description: 'Optional brief note (e.g. blocker reason)' }
                                },
                                required: ['id']
                            }
                        }
                    },
                    required: ['action']
                }
            }
        ];
        this.sessionModifiedFiles = new Map();
        this._sessionActive = false;
        this._currentSessionId = null;
        this.workspacePath = null;
        this.onToolEvent = null; // Callback for notifying UI/Client on tool execution events

        // ── New per-session state introduced for the safety/UX upgrade ──
        // edit count per file (normalized path → count). Used to warn the LLM
        // when it's been hammering the same file repeatedly (often a sign of
        // a fundamentally wrong approach).
        this._fileEditCount = new Map();
        // task_progress tool state (persisted to disk per session).
        this._taskProgressItems = [];   // [{ id, title, status, note }, ...]
        this._taskProgressLoaded = false;

        // ── Tool allowlist (per-session, set by behavior) ─────────────────
        // null  → all tools allowed (default)
        // Set() → only the names in the set are allowed; others return an error
        // []    → effectively disables all tools (caller wants chat-only mode)
        this._toolAllowlist = null;
    }

    /**
     * Configure which tools may be invoked during the active session.
     * Called by AgentController when behavior.enabled_tools is provided.
     *
     * @param {string[]|null} allowedNames null → unrestricted; array → allowlist.
     *   "finish_task" is always implicitly allowed so the agent can still end.
     */
    setToolAllowlist(allowedNames) {
        if (allowedNames === null || allowedNames === undefined) {
            this._toolAllowlist = null;
            return;
        }
        const set = new Set(allowedNames);
        set.add('finish_task'); // always allow termination
        this._toolAllowlist = set;
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
        this._taskProgressItems = [];
        this._taskProgressLoaded = false;
        this._taskCompleted = false;
        this._toolAllowlist = null; // reset; caller may re-set after startSession
        this.workspacePath = workspacePath || '.';

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
     * Path of the per-session task_progress JSON.
     * Stored next to other session artifacts so it survives across the loop
     * but is scoped to one task (cleared on startSession).
     */
    _taskProgressPath() {
        return `${this.getSessionArtifactDir()}/task_progress.json`;
    }

    async _loadTaskProgress() {
        if (this._taskProgressLoaded) return;
        try {
            const raw = await invoke('read_file', { path: this._taskProgressPath() });
            if (raw) {
                const data = JSON.parse(raw);
                if (Array.isArray(data)) this._taskProgressItems = data;
            }
        } catch (_) { /* file missing on first call — fine */ }
        this._taskProgressLoaded = true;
    }

    async _saveTaskProgress() {
        try {
            const dir = this.getSessionArtifactDir();
            await invoke('create_dir', { path: dir });
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
        return `task_progress (${done}/${total} complete):\n${lines.join('\n')}`;
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
    }

    isSessionActive() {
        return this._sessionActive;
    }

    isTaskCompleted() {
        return !!this._taskCompleted;
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

    isSafeTool(name) {
        const tool = this.toolDefinitions.find(t => t.name === name);
        return tool ? !!tool.isSafe : false;
    }

    getToolsForNativeAPI() {
        const nativeTools = this.toolDefinitions.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        }));

        const mcpTools = mcpManager.getAllTools();
        mcpTools.forEach(t => {
            nativeTools.push({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || `MCP tool from ${t._serverName}`,
                    parameters: t.inputSchema || { type: 'object', properties: {} }
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

    async executeTool(call, onAgentStatus, onConfirm) {
        const { name } = call;
        const args = call.args || {};
        workflowManager.autoAdvance(name);

        // Enforce per-session tool allowlist (configured via setToolAllowlist).
        // Always permit finish_task so a restricted agent can still terminate.
        if (this._toolAllowlist && !this._toolAllowlist.has(name)) {
            return `Error: Tool "${name}" is not enabled for this task. Allowed tools: ${[...this._toolAllowlist].join(', ')}.`;
        }

        const rawPath = args.path || args.file_path || args.filepath || args.file || args.dir || args.directory;

        const needsFilePath = ['read_file', 'write_file', 'open_file', 'multi_replace_file_content', 'delete_file'];
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
            switch (name) {
                case 'list_files': {
                    onAgentStatus?.(`Exploring directory: ${resolvedPath}...`);
                    const entries = await invoke('read_dir', { path: resolvedPath });
                    if (!Array.isArray(entries) || entries.length === 0) {
                        return `(empty) ${resolvedPath}`;
                    }
                    // Format: dirs first (alpha), then files (alpha), with size annotation.
                    // This is much easier for the LLM to parse than the raw entry objects.
                    const fmtSize = (b) => {
                        if (!Number.isFinite(b)) return '';
                        if (b < 1024) return `${b}B`;
                        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
                        return `${(b / 1024 / 1024).toFixed(1)}MB`;
                    };
                    const dirs  = entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
                    const files = entries.filter(e => !e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
                    const lines = [];
                    lines.push(`--- ${resolvedPath} (${dirs.length} dirs, ${files.length} files) ---`);
                    for (const d of dirs)  lines.push(`📁 ${d.name}/`);
                    for (const f of files) {
                        const sz = fmtSize(f.size);
                        lines.push(`📄 ${f.name}${sz ? `  (${sz})` : ''}`);
                    }
                    return lines.join('\n');
                }
                case 'read_file': {
                    onAgentStatus?.(`Reading file: ${resolvedPath}...`);
                    let fileContent;
                    try {
                        fileContent = await invoke('read_file', { path: resolvedPath });
                    } catch (readErr) {
                        // ── Fix C: "Did you mean?" file suggestions ──────
                        // Most read_file failures are extension typos (.ts vs .tsx),
                        // path-segment mistakes, or off-by-one paths. List the parent
                        // dir and suggest names that look close to what the agent asked
                        // for — turns a useless "not found" into a one-shot recovery hint.
                        const msg = String(readErr?.message || readErr || '');
                        const isNotFound = /not found|os error 2|cannot find|no such file/i.test(msg);
                        if (!isNotFound) {
                            return `Error: read_file failed for ${resolvedPath} — ${msg}`;
                        }

                        const lastSlash = resolvedPath.lastIndexOf('/');
                        const dir  = lastSlash > 0 ? resolvedPath.slice(0, lastSlash) : (this.workspacePath || '.');
                        const base = lastSlash >= 0 ? resolvedPath.slice(lastSlash + 1) : resolvedPath;
                        const baseNoExt = base.replace(/\.[^.]+$/, '').toLowerCase();
                        const baseLower = base.toLowerCase();

                        let suggestions = [];
                        try {
                            const entries = await invoke('read_dir', { path: dir });
                            if (Array.isArray(entries)) {
                                // Score each entry by (a) prefix overlap with base, (b) shared characters.
                                const scored = entries
                                    .filter(e => !e.is_dir)
                                    .map(e => {
                                        const n = e.name.toLowerCase();
                                        const nNoExt = n.replace(/\.[^.]+$/, '');
                                        let score = 0;
                                        if (n === baseLower) score = 100;          // exact case-insensitive
                                        else if (nNoExt === baseNoExt) score = 90;  // extension typo (.ts vs .tsx)
                                        else if (n.startsWith(baseNoExt)) score = 70;
                                        else if (nNoExt.startsWith(baseNoExt.slice(0, 6))) score = 50;
                                        else if (n.includes(baseNoExt)) score = 30;
                                        return { name: e.name, score };
                                    })
                                    .filter(s => s.score > 0)
                                    .sort((a, b) => b.score - a.score)
                                    .slice(0, 5);
                                suggestions = scored.map(s => s.name);
                            }
                        } catch (_) { /* parent dir listing failed — fall through */ }

                        let hint = '';
                        if (suggestions.length > 0) {
                            hint = `\n\nDid you mean one of these in ${dir}?\n  ` +
                                suggestions.map(n => `${dir}/${n}`).join('\n  ');
                        } else {
                            hint = `\n\n(No similar file names found in ${dir}. ` +
                                `Try list_files on the parent directory, or grep_search for content you know is in the file.)`;
                        }
                        return `Error: read_file: file not found: ${resolvedPath}${hint}`;
                    }

                    // ── Session file cache update ──────────────────────────
                    // Cache stores the FULL content regardless of slicing — the cache
                    // is used by ConversationMemory.compactHistory to restore content
                    // verbatim, and slicing is just a per-call presentation concern.
                    if (this._fileCache) {
                        const normPath = resolvedPath.replace(/\\/g, '/');
                        const existing = this._fileCache.get(normPath);
                        this._fileCache.set(normPath, {
                            content: fileContent,
                            readCount: (existing?.readCount || 0) + 1,
                            readAt: Date.now(),
                            editedAt: existing?.editedAt || null
                        });
                    }

                    // ── Slicing & line-numbering ──────────────────────────
                    // Default cap = 2000 lines (matches Claude Code's Read tool).
                    // Returning a line-numbered view costs ~6-8 chars per line of overhead
                    // but lets the LLM reference exact lines in its OBSERVE/PLAN reasoning
                    // and gives multi_replace_file_content a clear anchor when extracting
                    // old_text snippets.
                    const DEFAULT_LIMIT = 2000;
                    const allLines = fileContent.split('\n');
                    const total = allLines.length;

                    let offset = Number.isFinite(args.offset) && args.offset >= 1 ? Math.floor(args.offset) : 1;
                    let limit  = Number.isFinite(args.limit)  && args.limit  >= 1 ? Math.floor(args.limit)  : DEFAULT_LIMIT;

                    if (offset > total) {
                        return `Error: offset ${offset} exceeds file length (${total} lines) for ${resolvedPath}. ` +
                            `Use offset between 1 and ${total}, or omit to start from the beginning.`;
                    }

                    const startIdx = offset - 1;
                    const endIdx   = Math.min(total, startIdx + limit);
                    const slice    = allLines.slice(startIdx, endIdx);

                    // Pad line numbers to constant width for alignment.
                    const lastLineNo = endIdx;
                    const numWidth = String(lastLineNo).length;
                    const numbered = slice
                        .map((line, i) => `${String(startIdx + 1 + i).padStart(numWidth, ' ')}\t${line}`)
                        .join('\n');

                    // Header tells the LLM exactly what range it's looking at.
                    const showingAll = (offset === 1 && endIdx === total);
                    const header = showingAll
                        ? `--- ${resolvedPath} (${total} lines) ---\n`
                        : `--- ${resolvedPath} (showing lines ${offset}-${endIdx} of ${total}) ---\n`;
                    const footer = endIdx < total
                        ? `\n... [${total - endIdx} more lines — call read_file again with offset=${endIdx + 1} to continue]`
                        : '';

                    return header + numbered + footer;
                }
                case 'grep_search': {
                    const searchRoot = args.path ? this.resolvePath(args.path) : this.workspacePath;
                    onAgentStatus?.(`Searching: /${args.pattern}/ in ${searchRoot}...`);
                    try {
                        const res = await invoke('grep_search', {
                            pattern: args.pattern,
                            path: searchRoot,
                            includeGlob: args.include_glob || null,
                            caseInsensitive: !!args.case_insensitive,
                            maxResults: Number.isFinite(args.max_results) ? args.max_results : null,
                            contextLines: Number.isFinite(args.context_lines) ? args.context_lines : null
                        });
                        const { matches = [], files_searched = 0, truncated = false } = res || {};
                        this.onToolEvent?.('grep_search', { pattern: args.pattern, matchCount: matches.length });
                        if (matches.length === 0) {
                            return `No matches for /${args.pattern}/ in ${searchRoot} ` +
                                `(${files_searched} files searched).` +
                                (args.include_glob ? ` Filter: ${args.include_glob}` : '');
                        }
                        const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`);
                        const header = `Found ${matches.length} match(es)` +
                            (truncated ? ' (truncated)' : '') +
                            ` across ${files_searched} files for /${args.pattern}/:`;
                        return `${header}\n${lines.join('\n')}` +
                            (truncated ? `\n[Result truncated. Narrow the search with include_glob or a more specific pattern.]` : '');
                    } catch (e) {
                        return `Error: grep_search failed — ${e?.message || e}`;
                    }
                }
                case 'glob': {
                    const searchRoot = args.path ? this.resolvePath(args.path) : this.workspacePath;
                    onAgentStatus?.(`Globbing: ${args.pattern} in ${searchRoot}...`);
                    try {
                        const res = await invoke('glob_files', {
                            pattern: args.pattern,
                            path: searchRoot,
                            maxResults: Number.isFinite(args.max_results) ? args.max_results : null
                        });
                        const { files = [], truncated = false } = res || {};
                        if (files.length === 0) {
                            return `No files match glob '${args.pattern}' under ${searchRoot}.`;
                        }
                        return `Found ${files.length}${truncated ? '+' : ''} file(s) matching '${args.pattern}':\n` +
                            files.join('\n') +
                            (truncated ? `\n[Result truncated — narrow the pattern or pass max_results.]` : '');
                    } catch (e) {
                        return `Error: glob failed — ${e?.message || e}`;
                    }
                }
                case 'delete_file': {
                    const isSafeRootDel = this.workspacePath && resolvedPath.startsWith(this.workspacePath.replace(/\\/g, '/'));
                    if (onConfirm && !isSafeRootDel) {
                        const ok = await onConfirm({
                            type: 'command_confirm',
                            command: `delete_file ${resolvedPath}`,
                            message: `AI wants to delete this file (outside workspace):\n${resolvedPath}`
                        });
                        if (!ok) return 'Error: User Denied file deletion.';
                    }
                    onAgentStatus?.(`Deleting file: ${resolvedPath}...`);
                    try {
                        await invoke('delete_file', { path: resolvedPath });
                        // Evict from session cache so a subsequent read doesn't silently
                        // serve stale content.
                        if (this._fileCache) {
                            this._fileCache.delete(resolvedPath.replace(/\\/g, '/'));
                        }
                        this.onToolEvent?.('file_modified', { path: resolvedPath, action: 'delete', diff: '- deleted' });
                        return `Success: Deleted ${resolvedPath}.`;
                    } catch (e) {
                        return `Error: delete_file failed — ${e?.message || e}`;
                    }
                }
                case 'move_file': {
                    if (!args.from || !args.to) {
                        return `Error: move_file requires both 'from' and 'to' parameters.`;
                    }
                    const fromPath = this.resolvePath(args.from);
                    const toPath   = this.resolvePath(args.to);
                    const bothInsideWs = this.workspacePath &&
                        fromPath.startsWith(this.workspacePath.replace(/\\/g, '/')) &&
                        toPath.startsWith(this.workspacePath.replace(/\\/g, '/'));
                    if (onConfirm && !bothInsideWs) {
                        const ok = await onConfirm({
                            type: 'command_confirm',
                            command: `move_file ${fromPath} → ${toPath}`,
                            message: `AI wants to move/rename a file crossing the workspace boundary:\nFrom: ${fromPath}\nTo:   ${toPath}`
                        });
                        if (!ok) return 'Error: User Denied file move.';
                    }
                    onAgentStatus?.(`Moving: ${fromPath} → ${toPath}...`);
                    try {
                        await invoke('move_file', {
                            from: fromPath,
                            to: toPath,
                            overwrite: !!args.overwrite
                        });
                        // Migrate cache entry to the new key.
                        if (this._fileCache) {
                            const fromKey = fromPath.replace(/\\/g, '/');
                            const toKey   = toPath.replace(/\\/g, '/');
                            const existing = this._fileCache.get(fromKey);
                            if (existing) {
                                this._fileCache.delete(fromKey);
                                this._fileCache.set(toKey, existing);
                            }
                        }
                        this.onToolEvent?.('file_modified', { path: toPath, action: 'move', diff: `- ${fromPath}\n+ ${toPath}` });
                        return `Success: Moved ${fromPath} → ${toPath}.`;
                    } catch (e) {
                        return `Error: move_file failed — ${e?.message || e}`;
                    }
                }
                case 'write_file': {
                    let finalContent = args.content ?? '';
                    const encoding = args.encoding || null;
                    const isSafeRoot = this.workspacePath && resolvedPath.startsWith(this.workspacePath.replace(/\\/g, '/'));
                    let oldContent = "";
                    let preExisting = false;
                    try {
                        oldContent = await invoke('read_file', { path: resolvedPath });
                        preExisting = true; // read succeeded ⇒ file already exists
                    } catch (e) { /* file doesn't exist — fine, this is a create */ }

                    // ── Read-before-overwrite guard ─────────────────────────
                    // If the file already exists but the agent has NEVER read it (or written it)
                    // in this session, REFUSE the write unless overwrite_unread=true.
                    // This is the same safety Claude Code's Write tool provides — it stops the
                    // agent from accidentally clobbering a file whose contents it doesn't know.
                    if (preExisting && !args.overwrite_unread) {
                        const normPath = resolvedPath.replace(/\\/g, '/');
                        const cached = this._fileCache?.get(normPath);
                        const seenThisSession = !!(cached && (cached.readAt || cached.editedAt));
                        if (!seenThisSession) {
                            return `Error: write_file BLOCKED — ${resolvedPath} already exists but you have not read it in this session. ` +
                                `Overwriting it would destroy content you haven't seen.\n` +
                                `Choose one:\n` +
                                `  1. Call read_file first, then retry write_file (recommended).\n` +
                                `  2. If you intend to make a partial edit, use multi_replace_file_content instead.\n` +
                                `  3. If you genuinely want to discard the existing content unseen, retry with overwrite_unread: true.`;
                        }
                    }

                    if (onConfirm && !isSafeRoot) {
                        const result = await onConfirm({
                            type: 'diff_review',
                            path: resolvedPath,
                            newContent: args.content,
                            oldContent: oldContent,
                            message: `AI wants to write to file outside workspace:\nPath: ${resolvedPath}`
                        });

                        if (result === false || result === null) return "Error: User Denied file write.";
                        if (typeof result === 'string') finalContent = result;
                    }

                    onAgentStatus?.(`Writing file: ${resolvedPath}...`);
                    await invoke('write_file', { path: resolvedPath, content: finalContent, encoding });

                    this._recordModification(resolvedPath, oldContent, finalContent);
                    this.onToolEvent?.('file_modified', { path: resolvedPath, action: 'write', diff: `- original\n+ modified` });
                    // Auto-open in editor tab — replaces the now-deprecated open_file tool
                    // so the LLM doesn't have to spend a step requesting the UI to show the edit.
                    this.onToolEvent?.('open_file', { path: resolvedPath });

                    // ── Session file cache update ──────────────────────────
                    if (this._fileCache) {
                        const normPath = resolvedPath.replace(/\\/g, '/');
                        const existing = this._fileCache.get(normPath);
                        this._fileCache.set(normPath, {
                            content: finalContent,
                            readCount: existing?.readCount || 0,
                            readAt: existing?.readAt || null,
                            editedAt: Date.now()
                        });
                    }

                    // Track edit count + size for the same anti-loop signal that
                    // multi_replace_file_content uses.
                    const wfEditCount = this._bumpFileEditCount(resolvedPath);
                    const wfOldLines = oldContent ? oldContent.split('\n').length : 0;
                    const wfNewLines = finalContent.split('\n').length;
                    let wfWarning = '';
                    if (wfEditCount >= 5) {
                        wfWarning = `\n[Warning] ${wfEditCount} edits to ${resolvedPath} in this session — if you're still iterating, are you sure the approach is right?`;
                    }

                    return `Success: File saved to ${resolvedPath}. (${wfOldLines} → ${wfNewLines} lines)${wfWarning}`;
                }
                case 'run_command': {
                    if (onConfirm) {
                        const approved = await onConfirm({
                            type: 'command_confirm',
                            command: args.command,
                            message: `AI wants to run this terminal command:\n${args.command}`
                        });
                        if (!approved) return "Error: User Denied command execution.";
                    }
                    onAgentStatus?.(`Running command: ${args.command}...`);

                    // Default 60-second timeout prevents infinite hangs.
                    // Agent can pass timeout_ms to override (e.g. long builds).
                    const timeoutMs = (Number.isFinite(args.timeout_ms) && args.timeout_ms > 0)
                        ? args.timeout_ms
                        : 60_000;

                    // ── Streaming setup ────────────────────────────────────
                    // Generate a per-call id so live stdout/stderr chunks emitted by the
                    // Rust side ("command-chunk" event) can be associated with this call.
                    // We forward each chunk through onToolEvent so MonitorView shows the
                    // command's output live instead of waiting until completion.
                    const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    let unlisten = null;
                    try {
                        const { listen } = await import('@tauri-apps/api/event');
                        unlisten = await listen('command-chunk', (event) => {
                            const p = event?.payload;
                            if (!p || p.command_id !== cmdId) return;
                            this.onToolEvent?.('command_chunk', {
                                command_id: cmdId,
                                command: args.command,
                                stream: p.stream,
                                line: p.line
                            });
                        });
                    } catch (e) {
                        // Listener attach failure shouldn't abort the command — just lose streaming.
                        console.warn('run_command: failed to attach streaming listener:', e);
                    }

                    const commandPromise = invoke('run_command', {
                        command: args.command,
                        cwd: this.workspacePath,
                        commandId: cmdId
                    });
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`run_command timed out after ${timeoutMs / 1000}s`)),
                            timeoutMs
                        )
                    );

                    let result;
                    try {
                        result = await Promise.race([commandPromise, timeoutPromise]);
                    } catch (e) {
                        if (e.message?.includes('timed out')) {
                            return `Error: Command timed out after ${timeoutMs / 1000} seconds. ` +
                                `The process may still be running in the background. ` +
                                `If this command needs more time, retry with a larger timeout_ms value.`;
                        }
                        throw e;
                    } finally {
                        // Always detach the streaming listener so we don't leak event subscriptions.
                        if (unlisten) { try { unlisten(); } catch (_) {} }
                    }

                    this.onToolEvent?.('command_run', { command: args.command, result });
                    return result;
                }
                case 'open_file':
                    onAgentStatus?.(`Opening file in editor: ${resolvedPath}...`);
                    this.onToolEvent?.('open_file', { path: resolvedPath });
                    return `Success: File ${resolvedPath} opened in client editor tab.`;
                
                case 'multi_replace_file_content': {
                    const editPath = this.resolvePath(args.path);
                    const normPath = editPath.replace(/\\/g, '/');
                    onAgentStatus?.(`Editing file: ${editPath}...`);

                    let currentContent;
                    try {
                        currentContent = await invoke('read_file', { path: editPath });
                    } catch (e) {
                        return `Error: File not found: ${editPath}`;
                    }

                    if (!args.replacements || !Array.isArray(args.replacements) || args.replacements.length === 0) {
                        return `Error: 'replacements' array is required and must not be empty.`;
                    }

                    // ── Line-ending detection (Fix A) ─────────────────────
                    // Windows files commonly use CRLF, but LLMs almost always
                    // produce LF in their old_text. Bytewise-strict matching
                    // would fail on every CRLF file. So: normalize BOTH sides
                    // to LF for search/replace, and restore the file's original
                    // line ending when we write back.
                    const crlfCount = (currentContent.match(/\r\n/g) || []).length;
                    const lfCount   = (currentContent.match(/(?<!\r)\n/g) || []).length;
                    const fileLineEnding = crlfCount > lfCount ? '\r\n' : '\n';
                    const normalizeLE = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s);

                    let workingContent = normalizeLE(currentContent);
                    let appliedCount = 0;

                    // ── Helpers ───────────────────────────────────────────
                    const countOccurrences = (haystack, needle) => {
                        if (!needle) return 0;
                        let n = 0, idx = 0;
                        while ((idx = haystack.indexOf(needle, idx)) !== -1) {
                            n++;
                            idx += needle.length;
                        }
                        return n;
                    };

                    const replaceAllLiteral = (haystack, needle, replacement) => {
                        let out = '';
                        let idx = 0, prev = 0;
                        while ((idx = haystack.indexOf(needle, prev)) !== -1) {
                            out += haystack.slice(prev, idx) + replacement;
                            prev = idx + needle.length;
                        }
                        out += haystack.slice(prev);
                        return out;
                    };

                    // ── Fix B: "Did you mean?" — find closest region in file ──
                    // Uses ORDER-RESPECTING per-line similarity (Dice coefficient on each
                    // line's token set), aligned line-by-line against a same-size window.
                    //
                    // Why not plain token-set overlap (the previous approach)? Two reasons it
                    // misfired:
                    //   1. It ignored line ORDER, so an unrelated line that merely shared common
                    //      tokens (e.g. `import … from …`) could outscore the real target block.
                    //   2. `hits / anchorTokens.length` counted window tokens, so a window larger
                    //      than the anchor could exceed 100% ("~110% token overlap").
                    // Dice is symmetric and bounded to [0,1], and per-line alignment respects order.
                    const tokenize = (s) => s
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase()
                        .split(' ')
                        .filter(Boolean);
                    const lineTokenSet = (line) => new Set(tokenize(line));
                    const dice = (aSet, bSet) => {
                        if (aSet.size === 0 && bSet.size === 0) return 1;
                        if (aSet.size === 0 || bSet.size === 0) return 0;
                        let inter = 0;
                        for (const t of aSet) if (bSet.has(t)) inter++;
                        return (2 * inter) / (aSet.size + bSet.size);
                    };

                    const findClosestRegion = (content, target) => {
                        const fileLines   = content.split('\n');
                        const targetLines = target.split('\n');
                        const n = targetLines.length;
                        if (n === 0) return null;

                        const targetSets = targetLines.map(lineTokenSet);
                        const targetTokenTotal = targetSets.reduce((s, set) => s + set.size, 0);
                        if (targetTokenTotal === 0) return null; // target is all whitespace

                        // Precompute file line token sets once (O(fileLines)).
                        const fileSets = fileLines.map(lineTokenSet);

                        let bestIdx = -1;
                        let bestScore = 0;
                        for (let i = 0; i < fileLines.length; i++) {
                            const windowLen = Math.min(n, fileLines.length - i);
                            let sum = 0;
                            for (let k = 0; k < windowLen; k++) {
                                sum += dice(targetSets[k], fileSets[i + k]);
                            }
                            // Divide by full target length so windows shorter than the
                            // target (near EOF) are penalized rather than inflated.
                            const score = sum / n;
                            if (score > bestScore) {
                                bestScore = score;
                                bestIdx = i;
                            }
                        }
                        if (bestIdx < 0 || bestScore < 0.4) return null;
                        const endIdx = Math.min(fileLines.length, bestIdx + n);
                        return {
                            startLine: bestIdx + 1,
                            endLine:   endIdx,
                            content:   fileLines.slice(bestIdx, endIdx).join('\n'),
                            score:     Math.min(1, bestScore) // clamp — never report >100%
                        };
                    };

                    // Visualize whitespace so the LLM can SEE tab-vs-space differences.
                    const visualizeWS = (s) => s
                        .replace(/\t/g, '→')
                        .replace(/ /g, '·');

                    // Build a verbose "not found" error with a "did you mean?" diff.
                    const buildNotFoundError = (i, origOldText) => {
                        const normOld = normalizeLE(origOldText);
                        const closest = findClosestRegion(workingContent, normOld);
                        let hint = '';
                        if (closest) {
                            const expectedVis = visualizeWS(normOld.split('\n').slice(0, 8).join('\n'));
                            const actualVis   = visualizeWS(closest.content.split('\n').slice(0, 8).join('\n'));
                            hint =
                                `\n\nClosest matching region (lines ${closest.startLine}-${closest.endLine}, ` +
                                `~${Math.round(closest.score * 100)}% line similarity):\n` +
                                `--- Your old_text (whitespace visualized: · = space, → = tab) ---\n${expectedVis}\n` +
                                `--- File ACTUALLY contains ---\n${actualVis}\n\n` +
                                `=== File region as-is (copy this verbatim) ===\n` +
                                `${closest.content}\n` +
                                `=== end ===\n` +
                                `\nFix (recommended): instead of re-sending the whole block, pick the ONE line above ` +
                                `that contains a unique identifier and use just that line (plus minimal context) as your ` +
                                `old_text. Short, exact anchors succeed far more often than large multi-line blocks. ` +
                                `Copy it character-for-character from the "File region as-is" section.`;
                        } else {
                            hint = `\n(No close match found — the file likely does not contain anything similar to your old_text. ` +
                                `Call read_file to refresh your view of the file.)`;
                        }
                        return `Error: replacement[${i}]: old_text not found in ${editPath}. ` +
                            `Cause is usually one of: ` +
                            `(a) the file has changed since you last read it, ` +
                            `(b) your old_text has different whitespace (tabs vs spaces / trailing whitespace), or ` +
                            `(c) you copied a "<lineno>\\t" prefix from read_file output by accident.${hint}`;
                    };

                    for (let i = 0; i < args.replacements.length; i++) {
                        const rep = args.replacements[i];

                        if (typeof rep !== 'object' || rep === null) {
                            return await this._handleMultiReplaceFailure(editPath, normPath,
                                `Error: replacement[${i}] is not an object. Each entry must be { old_text, new_text }.`);
                        }
                        if (typeof rep.old_text !== 'string' || rep.old_text.length === 0) {
                            return await this._handleMultiReplaceFailure(editPath, normPath,
                                `Error: replacement[${i}] is missing required 'old_text' (must be a non-empty string).`);
                        }
                        if (rep.new_text === undefined || rep.new_text === null) {
                            return await this._handleMultiReplaceFailure(editPath, normPath,
                                `Error: replacement[${i}] is missing required 'new_text'. Pass "" (empty string) to delete.`);
                        }

                        // Normalize both sides to LF for matching (Fix A).
                        const oldText    = normalizeLE(rep.old_text);
                        const newText    = normalizeLE(String(rep.new_text));
                        const replaceAll = rep.replace_all === true;

                        if (replaceAll) {
                            const count = countOccurrences(workingContent, oldText);
                            if (count === 0) {
                                return await this._handleMultiReplaceFailure(editPath, normPath,
                                    buildNotFoundError(i, rep.old_text));
                            }
                            workingContent = replaceAllLiteral(workingContent, oldText, newText);
                            appliedCount += count;
                            continue;
                        }

                        // Uniqueness mode (default)
                        const count = countOccurrences(workingContent, oldText);
                        if (count === 0) {
                            return await this._handleMultiReplaceFailure(editPath, normPath,
                                buildNotFoundError(i, rep.old_text));
                        }
                        if (count > 1) {
                            return await this._handleMultiReplaceFailure(editPath, normPath,
                                `Error: replacement[${i}]: old_text matches ${count} times in ${editPath}. ` +
                                `Each replacement must be unique — include 3-5 more lines of surrounding context to disambiguate, ` +
                                `or set "replace_all": true if you intend to update every occurrence.` +
                                `\n--- old_text preview (first 200 chars) ---\n${rep.old_text.slice(0, 200)}${rep.old_text.length > 200 ? '…' : ''}`);
                        }

                        // Exactly one match — safe to replace.
                        const matchIdx = workingContent.indexOf(oldText);
                        workingContent =
                            workingContent.slice(0, matchIdx) +
                            newText +
                            workingContent.slice(matchIdx + oldText.length);
                        appliedCount += 1;
                    }

                    // ── Success — reset failure counter for this file ──────
                    this._multiReplaceFailCount.delete(normPath);

                    // ── Restore original line ending before writing back ──
                    const finalEditedContent = fileLineEnding === '\r\n'
                        ? workingContent.replace(/\n/g, '\r\n')
                        : workingContent;
                    const isSafeRootEdit = this.workspacePath && editPath.startsWith(this.workspacePath.replace(/\\/g, '/'));

                    if (onConfirm && !isSafeRootEdit) {
                        const res = await onConfirm({
                            type: 'diff_review',
                            path: editPath,
                            newContent: finalEditedContent,
                            oldContent: currentContent,
                            message: `AI wants to write to file outside workspace:\nPath: ${editPath}`
                        });

                        if (res === false || res === null) return "Error: User Denied file write.";
                        if (typeof res === 'string') {
                            await invoke('write_file', { path: editPath, content: res });
                            return `Success: User modified and saved to ${editPath}`;
                        }
                    }

                    await invoke('write_file', { path: editPath, content: finalEditedContent });

                    this._recordModification(editPath, currentContent, finalEditedContent);
                    this.onToolEvent?.('file_modified', { path: editPath, action: 'edit', diff: `- original\n+ modified` });
                    // Auto-open in editor tab so user sees the edit without an explicit open_file call.
                    this.onToolEvent?.('open_file', { path: editPath });

                    // ── Auto read-back & sanity check ────────────────────
                    // The #1 cause of "agent corrupts file then doesn't notice" is that
                    // multi_replace_file_content reports success without showing the
                    // resulting content. Read the file back and surface the new content
                    // plus a quick structural sanity check (bracket balance, line delta).
                    // This makes corruption *visible* to the LLM in the very next turn.
                    let verifiedContent = finalEditedContent;
                    try {
                        verifiedContent = await invoke('read_file', { path: editPath });
                    } catch (_) {
                        // If we can't re-read, fall through to the basic content we wrote.
                    }

                    // ── Session file cache update (use verified/read-back content) ──
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

                    // Quick "obvious break" detector: balance braces, brackets, parens.
                    const balance = (txt) => {
                        const counts = { '{': 0, '}': 0, '[': 0, ']': 0, '(': 0, ')': 0 };
                        // Naive scan — false positives in strings/comments are fine
                        // (we're looking for catastrophic imbalance, not 100% accuracy).
                        for (const ch of txt) if (counts[ch] !== undefined) counts[ch]++;
                        return {
                            braces: counts['{'] - counts['}'],
                            brackets: counts['['] - counts[']'],
                            parens: counts['('] - counts[')'],
                        };
                    };
                    const before = balance(currentContent);
                    const after = balance(verifiedContent);
                    const warnings = [];
                    if (Math.abs(after.braces) > Math.abs(before.braces) + 1) {
                        warnings.push(`brace imbalance worsened (was ${before.braces}, now ${after.braces})`);
                    }
                    if (Math.abs(after.brackets) > Math.abs(before.brackets) + 1) {
                        warnings.push(`bracket imbalance worsened (was ${before.brackets}, now ${after.brackets})`);
                    }
                    if (Math.abs(after.parens) > Math.abs(before.parens) + 1) {
                        warnings.push(`paren imbalance worsened (was ${before.parens}, now ${after.parens})`);
                    }

                    // Same-file edit-count warning. If the LLM has been hammering one
                    // file, that's almost always a signal the approach is wrong.
                    let editCountWarning = '';
                    if (editCount === 5) {
                        editCountWarning = `\n[Warning] This is the 5th edit to ${editPath} in this session. If the file is getting tangled, consider doing ONE final write_file with the complete intended content instead of more multi_replace_file_content calls.`;
                    } else if (editCount >= 8) {
                        editCountWarning = `\n[Warning] ${editCount} edits to ${editPath} so far — STOP using multi_replace. Read the file once, then write_file the entire correct version.`;
                    }

                    // Truncate the readback so the LLM context doesn't explode on
                    // huge files. The first 400 lines is usually enough to spot
                    // obvious damage; the LLM can read_file for the rest if needed.
                    const PREVIEW_LINES = 400;
                    const previewLines = verifiedContent.split('\n').slice(0, PREVIEW_LINES);
                    const truncated = newLines > PREVIEW_LINES;
                    const preview = previewLines.join('\n') + (truncated ? `\n... [${newLines - PREVIEW_LINES} more lines truncated; call read_file if you need the rest]` : '');

                    const warnBlock = warnings.length > 0
                        ? `\n[Structural Warning] ${warnings.join('; ')}. The edit may have corrupted the file — INSPECT the content below and fix immediately if broken. Also call verify_syntax for .js/.ts/.json files.`
                        : '';

                    const opLabel = appliedCount === args.replacements.length
                        ? `${appliedCount} replacement(s)`
                        : `${appliedCount} replacement(s) from ${args.replacements.length} entry/entries`;
                    return `Success: Applied ${opLabel} to ${editPath}. ` +
                        `(${oldLines} → ${newLines} lines, delta ${lineDelta >= 0 ? '+' : ''}${lineDelta})` +
                        warnBlock + editCountWarning +
                        `\n\n=== File content after edit (first ${Math.min(newLines, PREVIEW_LINES)} lines) ===\n${preview}`;
                }
                case 'propose_plan': {
                    onAgentStatus?.(`Proposed plan: ${args.title}`);
                    const planText = `# ${args.title}\n\n` + args.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
                    if (onConfirm) {
                        const approved = await onConfirm({
                            type: 'plan_review',
                            title: args.title,
                            message: planText
                        });
                        if (!approved) return "Error: User Rejected the plan. Please propose a different plan.";
                    }
                    this.onToolEvent?.('plan_proposed', { title: args.title, steps: args.steps });
                    return 'Success: Plan proposed (no confirmation required).';
                }
                case 'create_artifact':
                case 'update_artifact': {
                    const actionName = name === 'create_artifact' ? 'Creating' : 'Updating';
                    const artifactName = args.name.endsWith('.md') ? args.name : `${args.name}.md`;
                    onAgentStatus?.(`${actionName} artifact: ${artifactName}...`);
                    
                    const artifactDir = this.getSessionArtifactDir();
                    const artifactPath = `${artifactDir}/${artifactName}`;
                    
                    await invoke('create_dir', { path: artifactDir });
                    await invoke('write_file', { path: artifactPath, content: args.content });
                    
                    this.onToolEvent?.('artifact_modified', { name: artifactName, path: artifactPath, content: args.content });
                    return `Success: Artifact ${artifactName} ${name === 'create_artifact' ? 'created' : 'updated'}.`;
                }
                case 'finish_task': {
                    // ── Pre-finish syntax gate (real-parser based) ────────
                    // Sanity-check every modified file before accepting completion.
                    //   .json          → JSON.parse  (in-process, fast, reliable)
                    //   .js/.jsx/...   → node --check (real V8 parser)
                    //   .ts/.tsx       → skipped (TS needs project tsc; we surface a soft reminder
                    //                    in the success message instead of blocking).
                    // Files we can't parse (no Node, unreadable) are skipped silently — the
                    // gate's purpose is to catch broken edits, not to block on environment gaps.
                    const jsonFiles = [];
                    const jsFiles = [];
                    const tsFiles = [];
                    for (const [p] of this.sessionModifiedFiles) {
                        if (/\.json$/i.test(p)) jsonFiles.push(p);
                        else if (/\.(js|jsx|mjs|cjs)$/i.test(p)) jsFiles.push(p);
                        else if (/\.(ts|tsx)$/i.test(p)) tsFiles.push(p);
                    }

                    const failures = [];

                    // JSON files — in-process check
                    for (const filePath of jsonFiles) {
                        try {
                            const src = await invoke('read_file', { path: filePath });
                            try { JSON.parse(src); }
                            catch (e) { failures.push(`${filePath} (JSON): ${e.message}`); }
                        } catch (_) { /* unreadable — skip */ }
                    }

                    // JS files — node --check subprocess
                    let nodeMissing = false;
                    for (const filePath of jsFiles) {
                        if (nodeMissing) break; // don't spam if node isn't installed
                        const quoted = `"${filePath.replace(/"/g, '\\"')}"`;
                        try {
                            await invoke('run_command', {
                                command: `node --check ${quoted}`,
                                cwd: this.workspacePath
                            });
                        } catch (e) {
                            const raw = String(e?.message || e || '');
                            if (/is not recognized|command not found|ENOENT/i.test(raw) &&
                                !/SyntaxError/i.test(raw)) {
                                // Node isn't on PATH — skip rather than fail completion.
                                nodeMissing = true;
                                continue;
                            }
                            const lines = raw.split('\n').filter(l => l.trim().length > 0);
                            const sig = lines.findIndex(l => /SyntaxError|Unexpected|Invalid/i.test(l));
                            const slice = sig >= 0
                                ? lines.slice(Math.max(0, sig - 1), sig + 2).join(' ')
                                : lines.slice(0, 3).join(' ');
                            failures.push(`${filePath} (node --check): ${slice}`);
                        }
                    }

                    if (failures.length > 0) {
                        return `Error: finish_task BLOCKED. The following file(s) you modified still have syntax errors. Fix them BEFORE calling finish_task again:\n\n` +
                            failures.map(f => '  • ' + f).join('\n') +
                            `\n\nUse verify_syntax to recheck after fixing.`;
                    }

                    onAgentStatus?.(`Task finished: ${args.summary}`);
                    this._taskCompleted = true;
                    // NOTE: use a DISTINCT event name ('finish_task'), NOT 'complete'.
                    // The task-level 'complete' event (emitted by TaskBridge after run()
                    // returns, carrying the full result.response as `message`) is what the
                    // Chat UI renders as the final answer. If we also emit 'complete' here
                    // it arrives FIRST with only `summary` (no `message`), so ChatView
                    // resolves on it and shows the "(task complete)" placeholder instead of
                    // the real summary. Keeping this event distinct avoids that collision.
                    this.onToolEvent?.('finish_task', { summary: args.summary });

                    // Soft reminder about TS files (not a block — just guidance).
                    let tsNote = '';
                    if (tsFiles.length > 0) {
                        tsNote = `\n\n[Reminder] ${tsFiles.length} TypeScript file(s) were modified. ` +
                            `If you haven't already, run the project's type checker ` +
                            `(e.g. "npx tsc --noEmit") to catch type errors.`;
                    }
                    if (nodeMissing && jsFiles.length > 0) {
                        tsNote += `\n[Note] 'node' was not on PATH, so JS files were not syntax-checked.`;
                    }

                    return `Success: Task completion declared. Summary: ${args.summary}${tsNote}`;
                }

                case 'verify_syntax': {
                    // Real-parser delegation strategy (industry standard):
                    //   .json          → JSON.parse (in-process, reliable, instant)
                    //   .js/.jsx/.mjs/.cjs → `node --check` (real V8 parser, ~100ms)
                    //   .ts/.tsx       → skip with guidance (TS needs tsc, which is a project-level concern)
                    //   other          → skip
                    //
                    // We deliberately do NOT do a hand-rolled regex+`new Function` check for
                    // JS/TS anymore — it produced both false positives (rejecting valid modern
                    // syntax) and false negatives (passing broken code that happened to look
                    // JS-like after type-stripping). `node --check` is the real V8 parser and
                    // gives the same answer Node itself would.
                    onAgentStatus?.(`Verifying syntax: ${resolvedPath}...`);

                    const lower = resolvedPath.toLowerCase();
                    const isJson = lower.endsWith('.json');
                    const isJs = /\.(js|jsx|mjs|cjs)$/.test(lower);
                    const isTs = /\.(ts|tsx)$/.test(lower);

                    if (isJson) {
                        let src;
                        try {
                            src = await invoke('read_file', { path: resolvedPath });
                        } catch (e) {
                            return `Error: Cannot read file for syntax check: ${e.message || e}`;
                        }
                        try {
                            JSON.parse(src);
                            return `OK: ${resolvedPath} is valid JSON.`;
                        } catch (e) {
                            // Extract "at position N" → line/col for actionable feedback.
                            const m = String(e.message).match(/position\s+(\d+)/i);
                            let loc = '';
                            if (m) {
                                const pos = parseInt(m[1], 10);
                                const before = src.slice(0, pos);
                                const line = before.split('\n').length;
                                const col = pos - before.lastIndexOf('\n');
                                loc = ` (line ${line}, col ${col})`;
                            }
                            return `Error: JSON parse failure in ${resolvedPath}${loc} — ${e.message}`;
                        }
                    }

                    if (isJs) {
                        // Cross-platform path quoting for the shell.
                        // PowerShell (Windows) and sh (Unix) both accept "double-quoted" paths,
                        // and we escape any embedded double quotes.
                        const quoted = `"${resolvedPath.replace(/"/g, '\\"')}"`;
                        try {
                            // node --check is silent on success (exit 0) and prints the SyntaxError
                            // location to stderr on failure (exit 1). run_command throws on non-zero
                            // exit, so a syntax error lands in the catch block below.
                            await invoke('run_command', {
                                command: `node --check ${quoted}`,
                                cwd: this.workspacePath
                            });
                            return `OK: ${resolvedPath} parses without syntax errors (node --check).`;
                        } catch (e) {
                            const raw = String(e?.message || e || '');
                            // Detect "node not found" so we can give a clearer message instead of
                            // pretending the file is broken.
                            if (/is not recognized|command not found|ENOENT/i.test(raw) &&
                                !/SyntaxError/i.test(raw)) {
                                return `Skipped: 'node' executable not found on PATH. ` +
                                    `verify_syntax cannot check JavaScript files without Node installed. ` +
                                    `Inspect the file manually or install Node.js.`;
                            }
                            // Surface only the most useful slice of node's output — the SyntaxError line
                            // plus its caret pointer is usually all that's needed.
                            const lines = raw.split('\n').filter(l => l.trim().length > 0);
                            const sig = lines.findIndex(l => /SyntaxError|Unexpected|Invalid/i.test(l));
                            const slice = sig >= 0
                                ? lines.slice(Math.max(0, sig - 2), sig + 3).join('\n')
                                : lines.slice(0, 8).join('\n');
                            return `Error: Syntax error in ${resolvedPath} (node --check):\n${slice}\n\n` +
                                `Fix this before doing anything else — the previous edit likely corrupted the file.`;
                        }
                    }

                    if (isTs) {
                        return `Skipped: verify_syntax does not directly check TypeScript. ` +
                            `Catastrophic structural breakage (unbalanced braces/brackets) is already ` +
                            `flagged automatically by multi_replace_file_content's auto read-back. ` +
                            `For full type-checking, call: run_command("npx tsc --noEmit ${resolvedPath}") ` +
                            `or run the project's type-check script.`;
                    }

                    return `Skipped: verify_syntax only checks .json / .js / .jsx / .mjs / .cjs. ` +
                        `Got: ${resolvedPath}. For other languages, invoke the appropriate checker via run_command ` +
                        `(e.g. "python -m py_compile <file>", "cargo check").`;
                }

                case 'task_progress': {
                    await this._loadTaskProgress();
                    const action = (args.action || '').toLowerCase();

                    if (action === 'get' || (!action && (!args.items || args.items.length === 0))) {
                        return this._renderTaskProgress();
                    }

                    if (action === 'set') {
                        const items = Array.isArray(args.items) ? args.items : [];
                        this._taskProgressItems = items.map(it => ({
                            id: String(it.id ?? ''),
                            title: String(it.title ?? ''),
                            status: ['pending', 'in_progress', 'completed', 'blocked'].includes(it.status)
                                ? it.status : 'pending',
                            note: it.note ? String(it.note).slice(0, 200) : ''
                        })).filter(it => it.id);
                        await this._saveTaskProgress();
                        this.onToolEvent?.('task_progress', { items: this._taskProgressItems });
                        return `Set ${this._taskProgressItems.length} subtask(s).\n${this._renderTaskProgress()}`;
                    }

                    if (action === 'update') {
                        const patches = Array.isArray(args.items) ? args.items : [];
                        let updated = 0;
                        for (const patch of patches) {
                            const id = String(patch.id ?? '');
                            if (!id) continue;
                            const target = this._taskProgressItems.find(it => it.id === id);
                            if (!target) continue;
                            if (patch.title !== undefined) target.title = String(patch.title);
                            if (patch.status !== undefined &&
                                ['pending', 'in_progress', 'completed', 'blocked'].includes(patch.status)) {
                                target.status = patch.status;
                            }
                            if (patch.note !== undefined) target.note = String(patch.note).slice(0, 200);
                            updated++;
                        }
                        await this._saveTaskProgress();
                        this.onToolEvent?.('task_progress', { items: this._taskProgressItems });
                        return `Updated ${updated} subtask(s).\n${this._renderTaskProgress()}`;
                    }

                    return `Error: task_progress action must be one of "set" / "update" / "get". Got: ${args.action}`;
                }

                default: {
                    const mcpToolsAll = mcpManager.getAllTools();
                    const targetTool = mcpToolsAll.find(t => t.name === name);
                    if (targetTool) {
                        onAgentStatus?.(`Calling MCP tool: ${name} (${targetTool._serverName})...`);
                        const response = await mcpManager.callTool(targetTool._serverName, name, args);

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
                    return `Error: Tool "${name}" not found. Available MCP tools: ${mcpManager.getAllTools().map(t => t.name).join(', ') || 'none'}.`;
                }
            }
        } catch (e) {
            return `Error executing ${name}: ${e.message || e}`;
        }
    }
}

export const toolExecutor = new ToolExecutor();
