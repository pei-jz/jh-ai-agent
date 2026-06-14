import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';

import { Sidebar } from './dashboard/components/Sidebar.js';
import { OverviewView } from './dashboard/views/OverviewView.js';
import { ChatView } from './dashboard/views/ChatView.js';
import { MonitorView } from './dashboard/views/MonitorView.js';
import { ConfigView } from './dashboard/views/ConfigView.js';
import { ScheduleView } from './dashboard/views/ScheduleView.js';
// AnalyticsView is now embedded inside the Overview dashboard (no standalone route).
import { taskBridge } from './modules/bridge/TaskBridge.js';
import { scheduleManager } from './modules/ai/ScheduleManager.js';
import { mcpManager } from './modules/ai/McpManager.js';
import llmService from './modules/ai/LLMService.js';
import { renderMarkdown, ensureResultViewStyles } from './dashboard/utils/resultView.js';
import { STORAGE_KEY as CHAT_SESSIONS_KEY, parseSessions, pruneSessions } from './dashboard/views/chat/chatSessions.js';

// API Client Helper
class ApiClient {
    constructor(port, token) {
        this.port = port;
        this.token = token;
        this.baseUrl = `http://localhost:${port}/api`;
    }

    async request(path, options = {}) {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`,
            ...(options.headers || {})
        };

        const res = await fetch(url, { ...options, headers });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`API Request Error (${res.status}): ${errText}`);
        }
        return res.json();
    }

    getHealth() { return this.request('/health'); }
    getModels() { return this.request('/models'); }
    listTasks() { return this.request('/tasks'); }
    getTask(id) { return this.request(`/tasks/${id}`); }
    createTask(prompt, workspacePath) {
        return this.request('/tasks', {
            method: 'POST',
            body: JSON.stringify({ prompt, workspace_path: workspacePath })
        });
    }
    abortTask(id) {
        return this.request(`/tasks/${id}`, { method: 'DELETE' });
    }
    deleteTaskHistory(id) {
        // Permanently removes the task from history (memory + disk).
        // Returns { status, id, started_at, completed_at } for API-log cleanup.
        return this.request(`/tasks/${id}/history`, { method: 'DELETE' });
    }
    getConfig() { return this.request('/config'); }
    updateConfig(config) {
        return this.request('/config', {
            method: 'PUT',
            body: JSON.stringify(config)
        });
    }
    testConnection(config) {
        return this.request('/config/test', {
            method: 'POST',
            body: JSON.stringify(config)
        });
    }
    getStats() { return this.request('/stats'); }
    getTaskLogs(id) { return this.request(`/tasks/${id}/logs`); }
    continueTask(id, message) {
        // Re-run a completed task with a new message under the SAME task id.
        return this.request(`/tasks/${id}/continue`, {
            method: 'POST',
            body: JSON.stringify({ message })
        });
    }
}

// Router State
let currentView = null;

// Initialize Titlebar Window Event Listeners (decorations: false)
function initTitlebar() {
    const appWindow = getCurrentWindow();
    
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        appWindow.minimize();
    });
    
    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        const isMaximized = await appWindow.isMaximized();
        if (isMaximized) {
            appWindow.unmaximize();
        } else {
            appWindow.maximize();
        }
    });
    
    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        // Hide to tray instead of closing the app
        appWindow.hide();
    });
}

// Handle routing
async function handleRoute() {
    const hash = window.location.hash || '#overview';
    const route = hash.split('?')[0].substring(1);
    
    // Destroy previous view if needed
    if (currentView && typeof currentView.destroy === 'function') {
        currentView.destroy();
    }

    const appContainer = document.getElementById('app');
    if (!appContainer) return;

    // Resolve Views
    let viewInstance;
    switch (route) {
        case 'overview':
            viewInstance = new OverviewView();
            break;
        case 'chat':
            viewInstance = new ChatView();
            break;
        case 'monitor':
            viewInstance = new MonitorView();
            break;
        // 'history' route removed — its search/filter folded into Monitor.
        // Legacy #history links fall through to the default (Overview).
        case 'schedule':
            viewInstance = new ScheduleView();
            break;
        case 'config':
            viewInstance = new ConfigView();
            break;
        default:
            viewInstance = new OverviewView();
            break;
    }

    currentView = viewInstance;

    // Render layout: Sidebar + Content Container
    const sidebarInstance = new Sidebar(route, (targetRoute) => {
        window.location.hash = `#${targetRoute}`;
    });

    const contentHtml = await viewInstance.render();
    
    appContainer.innerHTML = `
        <div class="dashboard-layout" style="display: flex; height: 100%; width: 100%;">
            ${sidebarInstance.render()}
            <main class="main-content page-enter">
                ${contentHtml}
            </main>
        </div>
    `;

    // Initialize logic
    sidebarInstance.init();
    viewInstance.init();
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Overlay (triggered by global shortcut Ctrl+Shift+Space)
// ─────────────────────────────────────────────────────────────────────────────
function injectSearchOverlayStyles() {
    const style = document.createElement('style');
    style.textContent = `
        /* ── Search Overlay ────────────────────────────────── */
        #search-overlay {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 9000;
            align-items: flex-start;
            justify-content: center;
            padding-top: 120px;
        }
        #search-overlay.visible { display: flex; }

        .search-backdrop {
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
        }

        .search-container {
            position: relative;
            z-index: 1;
            width: min(620px, calc(100vw - 80px));
            background: hsl(220, 20%, 12%);
            border: 1px solid hsla(220, 20%, 35%, 0.5);
            border-radius: 14px;
            box-shadow: 0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
            overflow: hidden;
            animation: searchSlideIn 0.15s ease;
        }
        @keyframes searchSlideIn {
            from { opacity: 0; transform: translateY(-10px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0)     scale(1); }
        }

        .search-input-row {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 16px 18px;
            border-bottom: 1px solid hsla(220, 20%, 30%, 0.5);
        }
        .search-input-icon { font-size: 16px; opacity: 0.6; flex-shrink: 0; align-self: flex-start; margin-top: 2px; }
        #search-input {
            flex: 1;
            background: none;
            border: none;
            outline: none;
            color: hsl(220, 20%, 90%);
            font-size: 16px;
            font-family: inherit;
            caret-color: hsl(185, 100%, 55%);
            /* Multiline support: a textarea that auto-grows up to a cap. */
            resize: none;
            line-height: 1.5;
            max-height: 160px;
            overflow-y: auto;
            padding: 0;
            display: block;
        }
        #search-input::placeholder { color: hsl(220, 12%, 40%); }
        .search-input-row { align-items: flex-start; }

        .search-expand-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 11px;
            background: hsla(185, 100%, 55%, 0.12);
            border: 1px solid hsla(185, 100%, 55%, 0.35);
            border-radius: 8px;
            color: hsl(185, 100%, 65%);
            font-size: 12px;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s;
        }
        .search-expand-btn:hover { background: hsla(185, 100%, 55%, 0.22); }
        .search-expand-btn svg { width: 14px; height: 14px; flex-shrink: 0; }

        #search-results {
            max-height: 320px;
            overflow-y: auto;
        }
        #search-results:empty::after {
            content: 'No recent tasks';
            display: block;
            padding: 24px;
            text-align: center;
            color: hsl(220, 12%, 40%);
            font-size: 13px;
        }

        .search-result-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 18px;
            cursor: pointer;
            transition: background 0.1s;
            border-bottom: 1px solid hsla(220, 20%, 25%, 0.4);
        }
        .search-result-item:last-child { border-bottom: none; }
        .search-result-item:hover, .search-result-item.focused {
            background: hsla(220, 18%, 20%, 0.6);
        }
        .search-result-status {
            width: 8px; height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .search-result-status.completed { background: hsl(145, 70%, 50%); }
        .search-result-status.running   { background: hsl(185, 100%, 55%); animation: pulse 1.5s infinite; }
        .search-result-status.failed    { background: hsl(0, 75%, 55%); }
        .search-result-status.pending   { background: hsl(40, 90%, 55%); }
        @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }

        .search-result-text { flex: 1; min-width: 0; }
        .search-result-prompt {
            font-size: 13px;
            color: hsl(220, 20%, 85%);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-result-meta {
            font-size: 11px;
            color: hsl(220, 12%, 45%);
            margin-top: 2px;
        }
        .search-result-arrow {
            font-size: 14px;
            color: hsl(220, 12%, 40%);
            flex-shrink: 0;
        }

        .search-footer {
            padding: 8px 18px;
            border-top: 1px solid hsla(220, 20%, 25%, 0.5);
            font-size: 11px;
            color: hsl(220, 12%, 40%);
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .search-footer kbd {
            display: inline-block;
            padding: 1px 5px;
            background: hsla(220, 18%, 20%, 0.8);
            border: 1px solid hsla(220, 20%, 35%, 0.5);
            border-radius: 4px;
            font-size: 10px;
            font-family: monospace;
        }
        .search-ask-ai-row {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 18px;
            cursor: pointer;
            border-top: 1px solid hsla(220, 20%, 25%, 0.4);
            color: hsl(185, 100%, 65%);
            font-size: 13px;
            transition: background 0.1s;
        }
        .search-ask-ai-row:hover, .search-ask-ai-row.focused {
            background: hsla(185, 100%, 55%, 0.1);
        }
        .search-ask-ai-icon { font-size: 15px; flex-shrink: 0; }
        .search-ask-ai-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* ── Inline AI answer (Simple-mode direct message) ── */
        #search-ai-answer {
            max-height: 420px;
            overflow-y: auto;
            padding: 14px 18px;
            border-top: 1px solid hsla(220, 20%, 25%, 0.5);
            font-size: 13px;
            color: hsl(220, 20%, 88%);
            line-height: 1.6;
        }
        .search-ai-q {
            font-size: 12px;
            color: hsl(185, 100%, 65%);
            margin-bottom: 8px;
            font-weight: 600;
            display: flex;
            gap: 6px;
            align-items: flex-start;
        }
        .search-ai-thinking { color: hsl(220, 12%, 55%); }
        .search-ai-stream { white-space: pre-wrap; word-break: break-word; }
        #search-ai-answer .rv-summary { font-size: 13px; }

        /* ── Spotlight window: the modal FILLS the window (no white margins) ── */
        html.spotlight-mode, .spotlight-mode, .spotlight-mode body {
            background: transparent !important;
            margin: 0; padding: 0;
        }
        .spotlight-mode #titlebar,
        .spotlight-mode #app { display: none !important; }
        .spotlight-mode #search-overlay {
            position: fixed; inset: 0;
            padding: 0;
            display: flex;
        }
        .spotlight-mode #search-overlay .search-backdrop { display: none; }
        /* Container covers 100% of the window → the dark surface IS the window,
           so there's no transparent/white frame showing around it. */
        .spotlight-mode .search-container {
            width: 100vw;
            height: 100vh;
            border-radius: 0;
            box-shadow: none;
            border: none;
            animation: none;
            display: flex;
            flex-direction: column;
        }
        /* Middle area grows; footer sticks to the bottom. */
        .spotlight-mode #search-results { flex: 0 1 auto; }
        .spotlight-mode #search-ai-answer { flex: 1 1 auto; max-height: none; }
        .spotlight-mode .search-footer { margin-top: auto; }
        /* Drag handles (no native titlebar): grab the top bar or footer to move. */
        .spotlight-mode .search-input-row,
        .spotlight-mode .search-footer { cursor: move; }
        .spotlight-mode #search-input,
        .spotlight-mode .search-expand-btn { cursor: auto; }
    `;
    document.head.appendChild(style);
}

function buildSearchOverlayHTML() {
    return `
        <div class="search-backdrop" id="search-backdrop"></div>
        <div class="search-container" role="dialog" aria-label="Quick Search">
            <div class="search-input-row">
                <span class="search-input-icon">🔍</span>
                <textarea id="search-input" rows="1" placeholder="Search / Ask AI…  (Enter to send, Shift+Enter for newline)" autocomplete="off" spellcheck="false"></textarea>
                <button class="search-expand-btn" id="search-expand-btn" title="Open full app (Ctrl+Enter)">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/>
                    </svg>
                    Open App
                </button>
            </div>
            <div id="search-results"></div>
            <div id="search-ai-answer" style="display:none"></div>
            <div class="search-footer">
                <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
                <span><kbd>↵</kbd> Send / Open</span>
                <span><kbd>Shift+↵</kbd> Newline</span>
                <span><kbd>Ctrl+↵</kbd> Full app</span>
                <span style="margin-left:auto"><kbd>Esc</kbd> Close</span>
            </div>
        </div>
    `;
}

let _searchUnlisten = null;
let _searchFocusIndex = -1;
let _searchItems = [];
// Task list fetched once per overlay-open; keystrokes filter locally instead of
// re-hitting the REST API on every input event.
let _searchTasksCache = null;

function initSearchOverlay() {
    injectSearchOverlayStyles();

    const el = document.createElement('div');
    el.id = 'search-overlay';
    el.innerHTML = buildSearchOverlayHTML();
    document.body.appendChild(el);

    // Backdrop click → close
    el.querySelector('#search-backdrop').addEventListener('click', hideSearch);

    // Expand button → open the full app. From the spotlight window this brings
    // the main window forward and hides the spotlight; in-app it just closes.
    el.querySelector('#search-expand-btn').addEventListener('click', onExpandApp);

    // Input events
    const input = el.querySelector('#search-input');
    input.addEventListener('input', () => {
        autoGrowSearchInput(input);
        renderSearchResults(input.value);
    });
    input.addEventListener('keydown', onSearchKeydown);
}

function showSearch() {
    const overlay = document.getElementById('search-overlay');
    if (!overlay) return;
    _searchFocusIndex = -1;
    _searchTasksCache = null;   // refresh the task list once per open
    overlay.classList.add('visible');
    clearAiAnswer();
    const input = document.getElementById('search-input');
    input.value = '';
    input.style.height = 'auto';   // reset multiline growth
    input.focus();
    renderSearchResults('');
}

function hideSearch() {
    const overlay = document.getElementById('search-overlay');
    overlay?.classList.remove('visible');
    _searchFocusIndex = -1;
    clearAiAnswer();
    // In the dedicated spotlight window, "closing" means hiding the window itself
    // (the overlay IS the whole window). In-app, just dismiss the overlay.
    if (document.body.classList.contains('spotlight-mode')) {
        try { getCurrentWindow().hide(); } catch (_) {}
    }
}

/** "Open App" button: bring the main window forward (and hide spotlight). */
async function onExpandApp() {
    if (document.body.classList.contains('spotlight-mode')) {
        clearAiAnswer();
        try { await invoke('open_main_window'); } catch (e) { console.error(e); }
        return;
    }
    hideSearch();
}

async function renderSearchResults(query) {
    const container = document.getElementById('search-results');
    if (!container) return;

    // Typing a new query dismisses any shown AI answer and returns to the list.
    clearAiAnswer();
    container.style.display = '';

    if (!_searchTasksCache) {
        try {
            const list = await window.apiClient?.listTasks();
            _searchTasksCache = (list?.tasks || list || []);
        } catch (_) { _searchTasksCache = []; /* API not ready */ }
    }
    const tasks = _searchTasksCache;

    const q = query.trim().toLowerCase();
    const filtered = tasks
        .filter(t => !q || (t.prompt || '').toLowerCase().includes(q))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 8);

    _searchItems = filtered;
    _searchFocusIndex = -1;

    const askAiHtml = q ? `
        <div class="search-ask-ai-row" id="search-ask-ai-row">
            <span class="search-ask-ai-icon">✨</span>
            <span class="search-ask-ai-label">Ask AI: ${q.replace(/</g, '&lt;')}</span>
            <span style="font-size:11px;opacity:0.6">Shift+↵</span>
        </div>` : '';

    if (!filtered.length) {
        container.innerHTML = askAiHtml;
        if (q) {
            container.querySelector('#search-ask-ai-row')?.addEventListener('click', () => askAI(q));
        }
        return;
    }

    container.innerHTML = filtered.map((t, i) => {
        const statusClass = t.status === 'completed' ? 'completed'
                          : t.status === 'running'   ? 'running'
                          : t.status === 'failed'    ? 'failed'
                          : 'pending';
        const date = t.created_at ? new Date(t.created_at).toLocaleString() : '';
        const prompt = (t.prompt || '(no prompt)').replace(/</g, '&lt;');
        return `
            <div class="search-result-item" data-index="${i}" data-task-id="${t.id}">
                <span class="search-result-status ${statusClass}"></span>
                <div class="search-result-text">
                    <div class="search-result-prompt">${prompt}</div>
                    <div class="search-result-meta">${statusClass} · ${date}</div>
                </div>
                <span class="search-result-arrow">→</span>
            </div>
        `;
    }).join('') + askAiHtml;

    container.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => openSearchResult(item.getAttribute('data-task-id')));
    });
    if (q) {
        container.querySelector('#search-ask-ai-row')?.addEventListener('click', () => askAI(q));
    }
}

function openSearchResult(taskId) {
    if (!taskId) { hideSearch(); return; }
    const hash = `#monitor?task=${taskId}`;
    if (document.body.classList.contains('spotlight-mode')) {
        // The spotlight window has no router/monitor — ask the MAIN window to
        // navigate, then bring it forward (open_main_window also hides spotlight).
        clearAiAnswer();
        try { emit('spotlight-navigate', { hash }); } catch (_) {}
        invoke('open_main_window').catch(() => {});
        return;
    }
    hideSearch();
    window.location.hash = hash;
}

/** Auto-grow the multiline search textarea up to its CSS max-height. */
function autoGrowSearchInput(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

function onSearchKeydown(e) {
    const ta = document.getElementById('search-input');
    const items = document.querySelectorAll('.search-result-item');
    // Once the query spans multiple lines, arrows edit the text (cursor movement)
    // instead of navigating the task list.
    const isMultiline = !!ta && ta.value.includes('\n');

    if (e.key === 'Escape') {
        e.preventDefault();
        hideSearch();
        return;
    }
    if (e.key === 'ArrowDown' && !isMultiline) {
        e.preventDefault();
        _searchFocusIndex = Math.min(_searchFocusIndex + 1, items.length - 1);
        updateSearchFocus(items);
        return;
    }
    if (e.key === 'ArrowUp' && !isMultiline) {
        e.preventDefault();
        _searchFocusIndex = Math.max(_searchFocusIndex - 1, 0);
        updateSearchFocus(items);
        return;
    }
    if (e.key === 'Enter') {
        // Shift+Enter inserts a newline (default textarea behavior).
        if (e.shiftKey) return;
        e.preventDefault();
        if (e.ctrlKey) {
            // Ctrl+Enter → open the full app.
            onExpandApp();
            return;
        }
        const q = ta?.value.trim();
        if (_searchFocusIndex >= 0 && _searchItems[_searchFocusIndex]) {
            openSearchResult(_searchItems[_searchFocusIndex].id);
        } else if (q) {
            askAI(q);
        }
    }
}

// In-flight abort handle for the inline Simple-mode generation.
let _aiAbort = null;

/**
 * Send the query as a Simple-mode (single LLM call, no tools/agent loop) message
 * and render the streamed answer INLINE inside the Ctrl+Shift+Space overlay —
 * the modal stays open and the result appears directly below the input box.
 */
async function askAI(query) {
    if (!query) return;
    const answerEl = document.getElementById('search-ai-answer');
    if (!answerEl) {
        // Fallback (overlay not initialized): old behavior — open Chat and auto-send.
        try { localStorage.setItem('jh_pending_chat_question', query); } catch (_) {}
        hideSearch();
        window.location.hash = '#chat';
        return;
    }

    // Abort any previous in-flight generation before starting a new one.
    if (_aiAbort) { try { _aiAbort.abort(); } catch (_) {} }
    _aiAbort = new AbortController();
    const myAbort = _aiAbort;

    ensureResultViewStyles();
    // Give the answer full focus — hide the task list while it's shown.
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.style.display = 'none';
    answerEl.style.display = 'block';
    answerEl.innerHTML =
        `<div class="search-ai-q"><span>🧑</span><span>${query.replace(/</g, '&lt;')}</span></div>` +
        `<div class="search-ai-body"><span class="search-ai-thinking">✨ Thinking…</span></div>`;
    const bodyEl = answerEl.querySelector('.search-ai-body');
    answerEl.scrollTop = answerEl.scrollHeight;

    let full = '';
    let streamNode = null;
    try {
        await llmService.chat(
            [{ role: 'user', content: query }],
            "You are a helpful AI assistant. Answer concisely and in the user's language.",
            (chunk) => {
                if (myAbort.signal.aborted) return;
                full += chunk;
                if (!streamNode) {
                    bodyEl.innerHTML = '<div class="search-ai-stream"></div>';
                    streamNode = document.createTextNode('');
                    bodyEl.querySelector('.search-ai-stream').appendChild(streamNode);
                    // Pin to the top so the answer is read from the start as it
                    // streams — no jarring auto-scroll-to-bottom each chunk.
                    answerEl.scrollTop = 0;
                }
                // Append ONLY the new delta to the existing text node — O(chunk),
                // not O(n) per chunk (the old `textContent = full` was O(n²) total
                // and the per-chunk scrollHeight read forced a reflow every time).
                streamNode.appendData(chunk);
            },
            myAbort.signal,
            []
        );
        if (myAbort.signal.aborted) return;
        // Render the final answer as markdown.
        bodyEl.innerHTML = `<div class="rv-summary">${renderMarkdown(full)}</div>`;
        answerEl.scrollTop = 0;
        // Persist the Q&A to the chat-session store so it shows up in the
        // Chat → History list when the user switches back to the app.
        if (full.trim()) {
            saveQuickSearchToHistory(query, full).catch(e =>
                console.warn('Quick-search history save failed:', e));
        }
    } catch (e) {
        if (myAbort.signal.aborted) return;
        bodyEl.innerHTML =
            `<span style="color:hsl(0,75%,65%)">Error: ${(e?.message || String(e)).replace(/</g, '&lt;')}</span>`;
    }
}

/**
 * Save a quick-search Q&A as a chat session (same store ChatView uses), so the
 * answer remains visible in Chat → History after the overlay closes.
 *
 * Runs in BOTH the in-app overlay and the dedicated spotlight window. Since the
 * spotlight window's localStorage could in principle be stale, the file backup
 * is merged in first so we never clobber sessions saved by the main window.
 * The active session is intentionally NOT changed — an in-progress chat in the
 * main window must keep writing to its own session.
 */
async function saveQuickSearchToHistory(question, answer) {
    const data = parseSessions(localStorage.getItem(CHAT_SESSIONS_KEY));

    // Merge sessions from the file backup (union, newest wins by id).
    let configDir = null;
    try {
        configDir = await invoke('get_app_config_dir');
        if (configDir) {
            const raw = await invoke('read_file', { path: `${configDir}/chat_sessions.json` });
            if (raw) {
                const fileData = JSON.parse(raw);
                for (const [id, s] of Object.entries(fileData.sessions || {})) {
                    if (!data.sessions[id]) data.sessions[id] = s;
                }
                if (!data.activeSessionId) data.activeSessionId = fileData.activeSessionId;
            }
        }
    } catch (_) { /* backup may not exist yet */ }

    const q = question.replace(/\s+/g, ' ').trim();
    const id = Date.now().toString();
    data.sessions[id] = {
        id,
        title: '🔍 ' + q.substring(0, 28) + (q.length > 28 ? '…' : ''),
        timestamp: Date.now(),
        messages: [
            { role: 'user', content: question, displayContent: question },
            { role: 'assistant', content: answer }
        ],
        chatMode: 'simple',
    };
    pruneSessions(data);

    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(data));
    if (configDir) {
        await invoke('write_file', {
            path: `${configDir}/chat_sessions.json`,
            content: JSON.stringify(data, null, 2)
        });
    }
}

/** Hide and clear the inline AI answer area, aborting any running generation. */
function clearAiAnswer() {
    if (_aiAbort) { try { _aiAbort.abort(); } catch (_) {} _aiAbort = null; }
    const answerEl = document.getElementById('search-ai-answer');
    if (answerEl) { answerEl.style.display = 'none'; answerEl.innerHTML = ''; }
}

function updateSearchFocus(items) {
    items.forEach((el, i) => el.classList.toggle('focused', i === _searchFocusIndex));
    items[_searchFocusIndex]?.scrollIntoView({ block: 'nearest' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval OS Notifications
// ─────────────────────────────────────────────────────────────────────────────

let _approvalNotifyUnlisten = null;

async function initApprovalNotifications() {
    // Request Web Notification permission once at startup
    if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
    }

    // Listen to task-event-bridge for confirm_request / complete / error
    _approvalNotifyUnlisten = await listen('task-event-bridge', (event) => {
        const { taskId, event: evtType, data } = event.payload || {};

        if (evtType === 'confirm_request') {
            _sendApprovalNotification(taskId, data);
        } else if (evtType === 'complete') {
            _sendTaskDoneNotification(taskId, data, false);
        } else if (evtType === 'error') {
            _sendTaskDoneNotification(taskId, data, true);
        }
    });
}

function _sendApprovalNotification(taskId, data) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const isCommand = data?.type === 'command_confirm';
    const title = isCommand ? '🛡 Approval required' : '📋 Plan approval required';
    const body = isCommand
        ? `Requesting permission to run a command:\n${(data.command || '').slice(0, 120)}`
        : `Requesting plan approval:\n${(data.title || data.message || '').slice(0, 120)}`;

    const n = new Notification(title, { body, tag: `approval-${data.confirmId}`, requireInteraction: true });

    // Clicking the notification focuses the app window and navigates to the task
    n.onclick = () => {
        window.focus();
        if (taskId) window.location.hash = `#monitor?id=${taskId}`;
        n.close();
    };
}

async function _sendTaskDoneNotification(taskId, data, isError) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const title = isError ? '❌ Task failed' : '✅ Task completed';
    let body = isError
        ? (data?.error || 'An error occurred').slice(0, 120)
        : 'The task completed successfully';

    // Fetch task prompt for a meaningful notification body
    try {
        const task = await window.apiClient?.getTask(taskId);
        if (task?.prompt) {
            body = (isError ? '[Failed] ' : '') + task.prompt.slice(0, 120);
        }
    } catch (_) {}

    const n = new Notification(title, { body, tag: `task-done-${taskId}` });
    n.onclick = () => {
        window.focus();
        if (taskId) window.location.hash = `#monitor?id=${taskId}`;
        n.close();
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Initialization
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Minimal bootstrap for the dedicated spotlight window. Renders only the
 * quick-search / ask-AI overlay (Simple mode), with no dashboard chrome.
 */
async function initSpotlightWindow() {
    document.documentElement.classList.add('spotlight-mode');
    document.body.classList.add('spotlight-mode');
    initSearchOverlay();

    // Make the top input row and footer draggable so the frameless window can be
    // moved by grabbing them. Tauri starts a drag only when the grabbed element
    // ITSELF carries the attribute, so we tag the row, its leading icon, and the
    // footer (its text spans). The input and "Open App" button stay interactive.
    [
        '#search-overlay .search-input-row',
        '#search-overlay .search-input-icon',
        '#search-overlay .search-footer',
    ].forEach(sel => document.querySelector(sel)?.setAttribute('data-tauri-drag-region', ''));

    try {
        const token = await invoke('get_api_token');
        const port = await invoke('get_server_port');
        window.apiClient = new ApiClient(port, token);
        await llmService.initFromConfig();
    } catch (e) {
        console.error('Spotlight: backend init failed:', e);
    }

    // Re-focus / reset the overlay each time the window is re-shown by the shortcut.
    // Also re-resolve the active LLM connection: this window has its OWN llmService
    // singleton, so a default-connection change saved in the main window's Settings
    // would otherwise never reach the spotlight until an app restart (symptom:
    // quick-search kept using the old provider, e.g. Gemini, after switching the
    // default to DeepSeek).
    _searchUnlisten = await listen('show-search', () => {
        llmService.initFromConfig().catch(() => {});
        showSearch();
    });

    // Show immediately (the window itself was just shown by the shortcut handler).
    showSearch();
}

window.addEventListener('DOMContentLoaded', async () => {
    // The spotlight window loads this same bundle. Detect it by label and run a
    // minimal bootstrap that renders ONLY the quick-search/ask-AI overlay — no
    // dashboard, router, TaskBridge, or scheduler.
    let isSpotlight = false;
    try { isSpotlight = getCurrentWindow().label === 'spotlight'; } catch (_) {}
    if (isSpotlight) {
        await initSpotlightWindow();
        return;
    }

    initTitlebar();

    // Search overlay (must be set up before async work so the DOM element exists)
    initSearchOverlay();

    try {
        // Fetch API Connection Params from Tauri
        const token = await invoke('get_api_token');
        const port = await invoke('get_server_port');

        console.log(`Configured backend. Port: ${port}, Token: ${token.slice(0, 4)}...`);
        window.apiClient = new ApiClient(port, token);

        // Resolve which configured LLM instance the agent should use.
        // Must run AFTER apiClient is set up but BEFORE the first agent task / route.
        const picked = await llmService.initFromConfig();
        if (picked) {
            console.log(`Active LLM model: ${picked}`);
        } else {
            console.warn('No LLM instance configured — agent will fail until one is added in Settings.');
        }

        // Register persistent write/exec roots with the Rust path guard so the
        // backend permits writes to the user's configured projects and log dir
        // (defense-in-depth allowlist; the app config dir + temp are pre-seeded
        // by the backend). Agent sessions add their workspace on top of this.
        try {
            const cfg = await invoke('get_ai_config');
            const roots = [
                ...(Array.isArray(cfg?.approved_projects) ? cfg.approved_projects : []),
                ...(Array.isArray(cfg?.write_allowed_paths) ? cfg.write_allowed_paths : []),
                cfg?.log_dir,
            ].filter(p => typeof p === 'string' && p.trim());
            if (roots.length > 0) {
                await invoke('set_allowed_roots', { roots });
            }
        } catch (e) {
            console.warn('Failed to register persistent path-guard roots:', e);
        }

        // Initialize TaskBridge for background agent runs
        await taskBridge.init();

        // Activate the inbound MCP-over-WebSocket listener (Part A / T1) so apps
        // that dial JHAI's /mcp/ws (JHEditor/JHER/mock) register as MCP servers
        // and their tools (e.g. get_buffer) become available to agent tasks.
        // NOTE: this was previously only inside mcpManager.init(), which is never
        // called (stdio servers are started directly by ChatView), so WS-dialed
        // tool providers were silently never registered.
        try {
            await mcpManager.listenForWsServers();
        } catch (e) {
            console.warn('Failed to activate MCP-WS listener:', e);
        }

        // Initialize background task scheduler
        scheduleManager.init();

        // Initialize OS notification support for approval requests
        initApprovalNotifications();

        // Listen for global-shortcut event from Rust backend
        _searchUnlisten = await listen('show-search', () => showSearch());

        // The spotlight window asks the main window to navigate (e.g. open a task
        // from the history list). open_main_window (Rust) shows/focuses us.
        await listen('spotlight-navigate', (e) => {
            const hash = e.payload?.hash;
            if (hash) window.location.hash = hash;
        });

        // Listen for routes
        window.addEventListener('hashchange', handleRoute);

        // Load initial page
        await handleRoute();

    } catch (e) {
        console.error("Critical: Failed to connect backend API:", e);
        document.getElementById('app').innerHTML = `
            <div style="padding: 40px; color: #ff5555; text-align: center;">
                <h2>Critical Error</h2>
                <p>Failed to initialize Tauri and connect to the local server API.</p>
                <pre>${e.message || e}</pre>
            </div>
        `;
    }
});
