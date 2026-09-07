import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';

import { Sidebar } from './dashboard/components/Sidebar.js';
import { MemoryView } from './dashboard/views/MemoryView.js';
import { UsageView } from './dashboard/views/UsageView.js';
import { MonitorView } from './dashboard/views/MonitorView.js';
import { ConfigView } from './dashboard/views/ConfigView.js';
import { ScheduleView } from './dashboard/views/ScheduleView.js';
// AnalyticsView is now embedded inside the Overview dashboard (no standalone route).
import { taskBridge } from './modules/bridge/TaskBridge.js';
import { scheduleManager } from './modules/ai/ScheduleManager.js';
import { jobManager } from './modules/ai/jobs/JobManager.js';
import { watcherManager } from './modules/ai/triggers/WatcherManager.js';
import { mcpManager } from './modules/ai/McpManager.js';
import { install as installErrorReporter, recentErrors } from './dashboard/utils/errorReporter.js';
import { showNotification } from './dashboard/utils/notifications.js';
import { DEFAULT_MODE_ID } from './modules/ai/AgentModes.js';
import { ASK } from './modules/ai/agent/InteractionMode.js';
import llmService from './modules/ai/LLMService.js';
import { ToolExecutor } from './modules/ai/ToolExecutor.js';
import { isExternalCaller } from './modules/ai/agent/taskCaller.js';
import { promptTemplateManager } from './modules/ai/PromptTemplateManager.js';
import { skillManager } from './modules/ai/SkillManager.js';
import { renderMarkdown, ensureResultViewStyles } from './dashboard/utils/resultView.js';
import { formatMessageContent, escapeHtml, ensureChatMarkdownStyles } from './dashboard/views/chat/chatMarkdown.js';
import { extractToolCall } from './dashboard/views/chat/chatRenderer.js';
import { STORAGE_KEY as CHAT_SESSIONS_KEY, parseSessions, pruneSessions } from './dashboard/views/chat/chatSessions.js';
import { icon } from './dashboard/utils/icons.js';
import { initLocale } from './i18n/index.js';
import { normalizeTheme, themeList, themeLabel, themeAttr } from './dashboard/utils/theme.js';

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
    /**
     * Task logs. `limit` returns the newest N entries (the Task view only needs
     * the tail — a long run used to ship every entry on open); `before` pages
     * backwards from an index already held.
     */
    getTaskLogs(id, { limit, before } = {}) {
        const qs = new URLSearchParams();
        if (Number.isFinite(limit) && limit > 0) qs.set('limit', String(limit));
        if (Number.isFinite(before) && before >= 0) qs.set('before', String(before));
        const q = qs.toString();
        return this.request(`/tasks/${id}/logs${q ? `?${q}` : ''}`);
    }
    // Full (un-slimmed) single log entry — the logs listing/replay strips the
    // heavy per-step request payloads; the CHAT modal fetches them on demand.
    getTaskLogEntry(id, idx) { return this.request(`/tasks/${id}/logs/${idx}`); }
    continueTask(id, payload) {
        // Re-run a completed task with a new message/payload under the SAME task id.
        return this.request(`/tasks/${id}/continue`, {
            method: 'POST',
            body: JSON.stringify(typeof payload === 'string' ? { message: payload } : payload)
        });
    }
}

// Router State
let currentView = null;

// ── Theme (light / dark / paper) ────────────────────────────────────────────
// Persisted in localStorage `jhai_theme`; applied by setting data-theme on
// <html>. Applied at MODULE LOAD (below) so the first paint is already themed.
// The cycle itself lives in dashboard/utils/theme.js so it can be tested.
function applyTheme(theme) {
    const attr = themeAttr(theme);
    if (attr === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = attr;
    const btn = document.getElementById('titlebar-theme');
    if (btn) {
        // The button names where you ARE, not where the next press would take
        // you — it opens a list now rather than advancing a cycle.
        btn.innerHTML = `${icon('palette', 13)}<span class="titlebar-theme-name">${escapeHtml(themeLabel(theme))}</span>`;
        btn.title = 'テーマを選ぶ';
    }
    const menu = document.getElementById('theme-menu');
    if (menu) {
        menu.querySelectorAll('[data-theme-id]').forEach(el => {
            el.setAttribute('aria-checked', String(el.getAttribute('data-theme-id') === theme));
        });
    }
}

/** Open/close the theme list. One list, built once, re-marked on each apply. */
function initThemeMenu() {
    const btn = document.getElementById('titlebar-theme');
    if (!btn) return;

    const menu = document.createElement('div');
    menu.id = 'theme-menu';
    menu.className = 'theme-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = themeList().map(t => `
        <button type="button" class="theme-menu-item" role="menuitemradio"
                data-theme-id="${t.id}" aria-checked="false">
            <span class="theme-menu-sw" data-theme-sw="${t.id}"></span>
            <span class="theme-menu-text">
                <span class="theme-menu-name">${escapeHtml(t.label)}</span>
                <span class="theme-menu-hint">${escapeHtml(t.hint)}</span>
            </span>
        </button>`).join('');
    document.body.appendChild(menu);

    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => {
        const r = btn.getBoundingClientRect();
        menu.style.top = `${Math.round(r.bottom + 4)}px`;
        // Right-aligned to the button, clamped so it cannot leave the window.
        menu.style.left = `${Math.max(8, Math.round(r.right - 210))}px`;
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    };

    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.hidden) open(); else close();
    });
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-theme-id]');
        if (!item) return;
        const next = item.getAttribute('data-theme-id');
        try { localStorage.setItem('jhai_theme', next); } catch (_) { /* private mode */ }
        applyTheme(next);
        close();
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
function currentTheme() {
    try { return normalizeTheme(localStorage.getItem('jhai_theme')); }
    catch (_) { return 'light'; }
}
// Apply immediately (before DOMContentLoaded) to avoid a dark flash in light mode.
applyTheme(currentTheme());

// Resolve the UI language before anything renders — a view that renders first and
// re-renders in another language flashes the wrong words at the user.
initLocale();
// Cross-window sync: the spotlight window shares this localStorage, so a theme
// toggle in the main window re-themes it live via the storage event.
window.addEventListener('storage', (e) => {
    if (e.key === 'jhai_theme') applyTheme(currentTheme());
});

// Initialize Titlebar Window Event Listeners (decorations: false)
function initTitlebar() {
    const appWindow = getCurrentWindow();

    // Theme picker. The button names the CURRENT theme and opens the list.
    initThemeMenu();
    applyTheme(currentTheme());   // sync the button now that the DOM exists

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
    // The query half was parsed off and thrown away, so every `#config?tab=…`
    // link in the app — the Dashboard's memory panel and its "Add a template"
    // chip among them — landed on Settings' default tab instead of the one it
    // named. Monitor reads `?id=` itself; only the tab was going nowhere.
    const params = new URLSearchParams(hash.split('?')[1] || '');

    // Destroy previous view if needed
    if (currentView && typeof currentView.destroy === 'function') {
        currentView.destroy();
    }

    const appContainer = document.getElementById('app');
    if (!appContainer) return;

    // Resolve Views
    let viewInstance;
    switch (route) {
        case 'memory':
            viewInstance = new MemoryView(params.get('tab') || 'digest');
            break;
        case 'usage':
            viewInstance = new UsageView();
            break;
        case 'monitor':
            viewInstance = new MonitorView();
            break;
        // 'chat' route removed (docs/design/information-architecture.md §7 step 3):
        // a short conversation is a Work run with interaction:'ask', not a second
        // engine. Legacy #chat links fall through to the default, like #history.
        //
        // The stored sessions (chat_sessions.json) are deliberately NOT deleted.
        // Nothing reads them any more, but destroying a user's history as a side
        // effect of a navigation change is not a decision a refactor gets to make.
        case 'schedule':
            viewInstance = new ScheduleView();
            break;
        case 'config':
            viewInstance = new ConfigView(params.get('tab') || 'llm');
            break;
        default:
            // Work is where you land. The three commonest reasons to open this
            // app — start something, watch something, look at what finished —
            // are all one screen (information-architecture.md §1), so there is
            // nothing a separate landing page would add. #overview and #chat
            // both fall through to here.
            viewInstance = new MonitorView();
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
        /* Colors come from the dashboard theme variables so the overlay follows
           light/dark mode (accent tints via color-mix on --accent). */
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
            background: rgba(0, 0, 0, 0.45);
        }

        .search-container {
            position: relative;
            z-index: 1;
            width: min(620px, calc(100vw - 80px));
            background: var(--surface-panel);
            border: 1px solid var(--line);
            border-radius: var(--r-3);
            box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.04);
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
            border-bottom: 1px solid var(--line);
        }
        .search-input-icon { font-size: 16px; opacity: 0.6; flex-shrink: 0; align-self: flex-start; margin-top: 2px; }
        #search-input {
            flex: 1;
            background: none;
            border: none;
            outline: none;
            color: var(--ink);
            font-size: 16px;
            font-family: inherit;
            caret-color: var(--accent);
            /* Multiline support: a textarea that auto-grows up to a cap. */
            resize: none;
            line-height: 1.5;
            max-height: 160px;
            overflow-y: auto;
            padding: 0;
            display: block;
        }
        #search-input::placeholder { color: var(--ink-faint); }
        .search-input-row { align-items: flex-start; }

        .search-expand-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 11px;
            background: color-mix(in srgb, var(--accent) 12%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
            border-radius: var(--r-3);
            color: var(--accent);
            font-size: 12px;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s;
        }
        .search-expand-btn:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
        .search-expand-btn svg { width: 14px; height: 14px; flex-shrink: 0; }

        .search-footer {
            padding: 8px 18px;
            border-top: 1px solid var(--line-soft);
            font-size: 11px;
            color: var(--ink-faint);
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .search-footer kbd {
            display: inline-block;
            padding: 1px 5px;
            background: var(--surface-sunken);
            border: 1px solid var(--line);
            border-radius: var(--r-2);
            font-size: 10px;
            font-family: monospace;
        }

        /* ── Inline AI answer (Simple-mode direct message) ── */
        #search-ai-answer {
            max-height: 420px;
            overflow-y: auto;
            padding: 14px 18px;
            border-top: 1px solid var(--line-soft);
            font-size: 13px;
            color: var(--ink);
            line-height: 1.6;
        }
        .search-ai-q {
            font-size: 12px;
            color: var(--accent);
            margin-bottom: 8px;
            font-weight: 600;
            display: flex;
            gap: 6px;
            align-items: flex-start;
        }
        .search-ai-thinking { color: var(--ink-faint); }
        .search-ai-stream { white-space: pre-wrap; word-break: break-word; }
        #search-ai-answer .rv-summary { font-size: 13px; }
        .search-ai-toolnote {
            font-size: 12px;
            color: var(--ink-faint);
            margin: 6px 0;
            display: flex;
            gap: 6px;
            align-items: center;
        }

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
            border: none;
            animation: none;
            display: flex;
            flex-direction: column;
        }
        /* Middle area grows; footer sticks to the bottom. */
        .spotlight-mode #search-ai-answer { flex: 1 1 auto; max-height: none !important; }
        .spotlight-mode .search-footer { margin-top: auto; }
        /* Drag handles (no native titlebar): grab the top bar or footer to move. */
        .spotlight-mode .search-input-row,
        .spotlight-mode .search-footer { cursor: move; }
        .spotlight-mode #search-input,
        .spotlight-mode .search-expand-btn { cursor: auto; }

        /* ── Spotlight Slash Popup & Skills ───────────────── */
        .slash-popup {
            position: absolute;
            top: 100%;
            left: 18px;
            right: 18px;
            background: var(--surface-panel);
            border: 1px solid var(--line);
            border-radius: var(--r-3);
            box-shadow: 0 4px 20px rgba(0,0,0,0.25);
            overflow: hidden;
            z-index: 200;
            max-height: 200px;
            display: flex;
            flex-direction: column;
            display: none;
            margin-top: 4px;
        }
        .slash-popup-list { overflow-y: auto; flex: 1; }
        .slash-popup-item {
            display: flex; align-items: center; gap: 10px;
            padding: 8px 12px; cursor: pointer; font-size: 13px;
            color: var(--ink-soft);
        }
        .slash-popup-item.selected, .slash-popup-item:hover { background: var(--surface-sunken); }
        .slash-popup-key { font-family: monospace; color: var(--accent); min-width: 60px; font-weight: 600; }
        .slash-popup-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .slash-popup-type { font-size: 10px; color: var(--ink-faint); background: var(--surface-sunken); padding: 2px 6px; border-radius: var(--r-2); }

        .chat-input-skills {
            display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 18px 0 18px;
        }
        .skill-chip {
            display: inline-flex; align-items: center; gap: 5px;
            background: color-mix(in srgb, var(--accent) 12%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
            color: var(--ink);
            border-radius: var(--r-pill); padding: 3px 8px; font-size: 11.5px;
        }
        .skill-chip-remove { background: none; border: none; color: var(--ink-faint); cursor: pointer; padding: 0 0 0 2px; }
        .skill-chip-remove:hover { color: var(--error); }

        .search-mcp-row {
            padding: 8px 18px;
            border-top: 1px solid var(--line-soft);
            font-size: 11.5px;
            color: var(--ink-soft);
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            background: var(--surface-sunken);
        }
        .search-mcp-row label {
            display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
        }
    `;
    document.head.appendChild(style);
}

function buildSearchOverlayHTML() {
    return `
        <div class="search-backdrop" id="search-backdrop"></div>
        <div class="search-container" role="dialog" aria-label="Ask AI">
            <div id="search-input-skills" class="chat-input-skills" style="display: none;"></div>
            <div class="search-input-row" style="position: relative;">
                <span class="search-input-icon">✨</span>
                <textarea id="search-input" rows="1" placeholder="Ask AI…  (Enter to send, / for templates & skills)" autocomplete="off" spellcheck="false"></textarea>
                <button class="search-expand-btn" id="search-expand-btn" title="Open full app (Ctrl+Enter)">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/>
                    </svg>
                    Open App
                </button>
                <div id="spotlight-slash-popup" class="slash-popup">
                    <div class="slash-popup-list" id="spotlight-slash-list"></div>
                </div>
            </div>
            <div id="search-ai-answer" style="display:none; padding: 18px; font-size: 13.5px; line-height: 1.6; max-height: 400px; overflow-y: auto;"></div>
            
            <div class="search-mcp-row" id="spotlight-mcp-list" style="display:none">
                <!-- Checkboxes populated dynamically -->
            </div>

            <div class="search-footer">
                <span><kbd>↵</kbd> Send</span>
                <span><kbd>Shift+↵</kbd> Newline</span>
                <span><kbd>Ctrl+↵</kbd> Full app</span>
                <span style="margin-left:auto"><kbd>Esc</kbd> Close</span>
            </div>
        </div>
    `;
}

let _searchUnlisten = null;

let _spotlightActiveSkills = [];
let _spotlightSlashItems = [];
let _spotlightSlashIndex = 0;
let _spotlightSlashQuery = '';

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

    // Global Escape key handler
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const overlay = document.getElementById('search-overlay');
            if (overlay && overlay.classList.contains('visible')) {
                const popup = document.getElementById('spotlight-slash-popup');
                if (popup && popup.style.display === 'flex') {
                    hideSlashPopup();
                } else {
                    hideSearch();
                }
            }
        }
    });

    // Input events
    const input = el.querySelector('#search-input');
    let _lastValLen = 0;
    input.addEventListener('input', () => {
        // Only trigger auto-grow if length changed significantly or includes newline
        const val = input.value;
        if (Math.abs(val.length - _lastValLen) > 5 || val.includes('\n') || val.length < _lastValLen) {
            autoGrowSearchInput(input);
        }
        _lastValLen = val.length;

        // Slash command filtering
        if (val.startsWith('/')) {
            const query = val.slice(1).toLowerCase();
            const templates = promptTemplateManager.search(query).map(t => ({
                type: 'template', key: t.key, label: t.label, icon: t.icon, prompt: t.prompt
            }));
            const skills = skillManager.search(query).map(s => ({
                type: 'skill', key: s.name, label: s.title || s.name, icon: '⚡'
            }));
            _spotlightSlashItems = [...templates, ...skills];
            _spotlightSlashIndex = 0;
            _spotlightSlashQuery = query;
            if (_spotlightSlashItems.length > 0) {
                renderSlashPopup();
            } else {
                hideSlashPopup();
            }
        } else {
            hideSlashPopup();
        }
    });
    input.addEventListener('keydown', onSearchKeydown);
}

async function showSearch() {
    const overlay = document.getElementById('search-overlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    clearAiAnswer();
    
    // Reset state
    _spotlightActiveSkills = [];
    _spotlightSlashItems = [];
    _spotlightSlashIndex = 0;
    renderSkillChips();
    hideSlashPopup();

    // Ensure templates and skills are loaded
    try {
        const config = await invoke('get_ai_config');
        if (config) promptTemplateManager.loadFromConfig(config);
        await skillManager.refresh();
    } catch (e) {
        console.error('Failed to load Spotlight config/skills:', e);
    }

    // Render MCP checkboxes
    renderMcpCheckboxes();

    const input = document.getElementById('search-input');
    input.style.height = 'auto';   // reset multiline growth
    // Restore the previous Q&A so reopening doesn't lose the last answer. The text
    // is pre-selected, so typing immediately starts a fresh query (the input event
    // → clearAiAnswer/renderSearchResults clears the restored answer).
    if (_lastSpotlightAnswerHtml) {
        input.value = _lastSpotlightQuery || '';
        const answerEl = document.getElementById('search-ai-answer');
        if (answerEl) { answerEl.innerHTML = _lastSpotlightAnswerHtml; answerEl.style.display = 'block'; }
        input.focus();
        try { input.select(); } catch (_) {}
    } else {
        input.value = '';
        input.focus();
    }
}

function hideSlashPopup() {
    const popup = document.getElementById('spotlight-slash-popup');
    if (popup) popup.style.display = 'none';
    _spotlightSlashItems = [];
    _spotlightSlashIndex = 0;
}

async function renderMcpCheckboxes() {
    const mcpList = document.getElementById('spotlight-mcp-list');
    if (!mcpList) return;
    
    // Only show if there are running MCP clients
    const clients = Array.from(mcpManager.clients.entries());
    if (clients.length === 0) {
        mcpList.style.display = 'none';
        return;
    }
    
    mcpList.style.display = 'flex';
    mcpList.innerHTML = clients.map(([name, client]) => {
        const toolCount = client.tools?.length || 0;
        return `
            <label>
                <input type="checkbox" class="spotlight-mcp-checkbox" data-name="${escapeHtml(name)}" checked>
                ${escapeHtml(name)}
                <span style="font-size: 9px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border-radius: var(--r-2); padding: 1px 4px;">${toolCount}t</span>
            </label>
        `;
    }).join('');

    // Allow toggling local active state (does not stop server, just skips sending to ToolExecutor)
    // Actually, in ChatView, unchecking STOPS the server. Let's just track checked state locally for askAI filtering.
}

function hideSearch() {
    const overlay = document.getElementById('search-overlay');
    overlay?.classList.remove('visible');
    clearAiAnswer();
    // In the dedicated spotlight window, "closing" means hiding the window itself
    // (the overlay IS the whole window). In-app, just dismiss the overlay.
    if (document.body.classList.contains('spotlight-mode')) {
        try { getCurrentWindow().hide(); } catch (_) {}
    }
}

/** "Open App" button: bring the main window forward (and hide spotlight). */
/**
 * "Expand" — promote the exchange on screen into a Work run.
 *
 * This is the line between the two surfaces (docs/design/information-architecture.md
 * §5): Spotlight is the layer you use WITHOUT switching windows and that keeps
 * nothing; Work is where things are kept. Expanding is how something crosses.
 *
 * It used to just show the main window, leaving the answer behind in a window
 * that then hid itself — so the only way to keep a Spotlight answer was to
 * retype the question somewhere else.
 *
 * The run is created as `interaction: 'ask'`: it was a question, and creating it
 * as work would put a plan-first gate in front of something already answered.
 * A failure here must NOT swallow the expand — the user asked to open the app.
 */
async function onExpandApp() {
    const inSpotlight = document.body.classList.contains('spotlight-mode');
    const hash = await promoteSpotlightRun();

    // Work is the destination either way.
    //
    // With nothing to promote this used to call open_main_window, which brings
    // the window forward and says nothing about WHERE — so the app appeared on
    // whatever route it was last left on, which is not what "Open App" from a
    // search box means. Naming the route makes the button do one thing.
    const target = hash || '#monitor';

    if (inSpotlight) {
        clearAiAnswer();
        try {
            await invoke('spotlight_navigate', { hash: target });
        } catch (e) {
            console.error(e);
            // The user asked to open the app; a failed navigate must not leave
            // them looking at a search box that did nothing.
            try { await invoke('open_main_window'); } catch (_) {}
        }
        return;
    }
    window.location.hash = target;
    hideSearch();
}

/**
 * Create the Work run for the question Spotlight just answered.
 * @returns {Promise<string|null>} the hash to open, or null if there is nothing
 *   to promote (no exchange yet, no workspace, or the create failed).
 */
async function promoteSpotlightRun() {
    const question = (_lastSpotlightQuery || '').trim();
    if (!question || !window.apiClient) return null;
    try {
        const { createTask } = await import('./dashboard/views/monitor/createTask.js');
        const cfg = await invoke('get_ai_config');
        // The same default the composer uses. Without a workspace the server
        // accepts the task and its first tool call fails, so promoting into
        // nothing is worse than not promoting.
        let ws = '';
        try { ws = localStorage.getItem('jhai_last_ws') || ''; } catch (_) { /* private mode */ }
        ws = ws || (Array.isArray(cfg?.approved_projects) ? cfg.approved_projects[0] : '') || '';
        if (!ws) return null;

        const id = await createTask({
            prompt: question,
            workspace: ws,
            modeId: DEFAULT_MODE_ID,
            selectedMcp: [],
            interaction: ASK,
            caller: 'Spotlight',
            // The exchange Spotlight already had, handed over as history.
            //
            // Without it the run received only the question and answered it
            // again from scratch — a second call, a second wait, and a second
            // bill for something already on screen. Carrying it means the run
            // opens where the conversation left off, which is what "open this
            // in the app" is asking for.
            chatContext: _lastSpotlightAnswer
                ? [
                    { role: 'user', content: question },
                    { role: 'assistant', content: _lastSpotlightAnswer },
                ]
                : [],
            client: window.apiClient,
        });
        return `#monitor?id=${id}`;
    } catch (e) {
        console.warn('Could not promote the Spotlight exchange:', e);
        return null;
    }
}

/** Auto-grow the multiline search textarea up to its CSS max-height. */
function autoGrowSearchInput(ta) {
    if (!ta) return;
    
    // Store original height to avoid unnecessary DOM updates if it hasn't changed
    const oldHeight = ta.style.height;
    
    ta.style.height = 'auto';
    const newHeight = Math.min(ta.scrollHeight, 160) + 'px';
    
    // Only apply the new height if it actually changed, to minimize style recalculations
    ta.style.height = newHeight;
    
    // If it didn't need to change, restoring it immediately prevents a full reflow in some browsers
    if (oldHeight && oldHeight === newHeight) {
        ta.style.height = oldHeight;
    }
}

function renderSkillChips() {
    const container = document.getElementById('search-input-skills');
    if (!container) return;

    if (_spotlightActiveSkills.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = _spotlightActiveSkills.map(s => `
        <span class="skill-chip" data-name="${escapeHtml(s.name)}" title="Skill: ${escapeHtml(s.name)}">
            <span>⚡</span>
            <span>${escapeHtml(s.title)}</span>
            <button class="skill-chip-remove" title="Remove skill">✕</button>
        </span>
    `).join('');

    container.querySelectorAll('.skill-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.closest('.skill-chip').getAttribute('data-name');
            _spotlightActiveSkills = _spotlightActiveSkills.filter(s => s.name !== name);
            renderSkillChips();
        });
    });
}

function renderSlashPopup() {
    const popup = document.getElementById('spotlight-slash-popup');
    const list = document.getElementById('spotlight-slash-list');
    if (!popup || !list) return;

    if (_spotlightSlashItems.length === 0) {
        popup.style.display = 'none';
        return;
    }

    popup.style.display = 'flex';
    list.innerHTML = _spotlightSlashItems.map((item, i) => `
        <div class="slash-popup-item ${i === _spotlightSlashIndex ? 'selected' : ''}" data-index="${i}">
            <span class="slash-popup-icon">${item.icon || '⚡'}</span>
            <span class="slash-popup-key">/${escapeHtml(item.key)}</span>
            <span class="slash-popup-label">${escapeHtml(item.label || '')}</span>
            <span class="slash-popup-type">${item.type}</span>
        </div>
    `).join('');

    list.querySelectorAll('.slash-popup-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.getAttribute('data-index'), 10);
            _selectSlashItem(_spotlightSlashItems[idx]);
        });
    });

    const selected = list.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function _selectSlashItem(item) {
    const textarea = document.getElementById('search-input');
    if (!textarea || !item) return;

    hideSlashPopup();

    if (item.type === 'template') {
        textarea.value = item.prompt;
        autoGrowSearchInput(textarea);
        textarea.focus();
    } else if (item.type === 'skill') {
        const currentValue = textarea.value;
        const afterSlash = currentValue.slice(1);
        const spaceIdx = afterSlash.indexOf(' ');
        const remainder = spaceIdx >= 0 ? afterSlash.slice(spaceIdx + 1) : '';

        if (!_spotlightActiveSkills.some(s => s.name === item.key)) {
            _spotlightActiveSkills.push({ name: item.key, title: item.label || item.key });
        }
        renderSkillChips();

        textarea.value = remainder;
        autoGrowSearchInput(textarea);
        textarea.focus();
    }
}

function onSearchKeydown(e) {
    const ta = document.getElementById('search-input');

    const popup = document.getElementById('spotlight-slash-popup');
    if (popup && popup.style.display === 'flex') {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _spotlightSlashIndex = Math.min(_spotlightSlashIndex + 1, _spotlightSlashItems.length - 1);
            renderSlashPopup();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            _spotlightSlashIndex = Math.max(_spotlightSlashIndex - 1, 0);
            renderSlashPopup();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const item = _spotlightSlashItems[_spotlightSlashIndex];
            if (item) _selectSlashItem(item);
            return;
        }
    }

    if (e.key === 'Enter') {
        if (e.shiftKey) return;
        e.preventDefault();
        if (e.ctrlKey) {
            onExpandApp();
            return;
        }
        const q = ta?.value.trim();
        if (q || _spotlightActiveSkills.length > 0) {
            askAI(q || '');
        }
    }
}

// In-flight abort handle for the inline Simple-mode generation.
let _aiAbort = null;
// Last spotlight Q&A, kept so closing/reopening (Ctrl+Shift+Space) restores the
// previous answer instead of forcing the user to re-ask. Cleared only when a NEW
// query is typed/submitted.
let _lastSpotlightQuery = '';
let _lastSpotlightAnswerHtml = '';
// The answer as TEXT, not markup. The rendered HTML restores the overlay;
// only the text can be handed to a run as prior conversation.
let _lastSpotlightAnswer = '';
const _toolExecutor = new ToolExecutor();

async function askAI(query) {
    if (!query && _spotlightActiveSkills.length === 0) return;
    const answerEl = document.getElementById('search-ai-answer');
    if (!answerEl) {
        try { localStorage.setItem('jh_pending_chat_question', query); } catch (_) {}
        hideSearch();
        window.location.hash = '#chat';
        return;
    }

    if (_aiAbort) { try { _aiAbort.abort(); } catch (_) {} }
    _aiAbort = new AbortController();
    const myAbort = _aiAbort;

    ensureResultViewStyles();
    ensureChatMarkdownStyles();
    answerEl.style.display = 'block';

    const skillRefs = [..._spotlightActiveSkills];
    _spotlightActiveSkills = [];
    renderSkillChips();

    let skillPreamble = '';
    if (skillRefs.length > 0) {
        const bodies = [];
        for (const s of skillRefs) {
            try {
                const body = await skillManager.readContent(s.name);
                bodies.push(`# Skill: ${s.title} (/${s.name})\n${body}`);
            } catch (e) { console.error(e); }
        }
        if (bodies.length > 0) {
            skillPreamble = bodies.join('\n\n') + '\n\n---\n\n';
        }
    }
    const processedText = skillPreamble + query;

    // Two-part body: `.search-ai-segs` holds FINISHED segments (previous loop
    // turns / tool notes) and is never rewritten again; `.search-ai-cur` is the
    // only node updated while streaming. Rewriting the whole body every chunk
    // (the old behavior) redrew all earlier content each frame → the visible
    // "the answer keeps refreshing" flicker.
    answerEl.innerHTML =
        `<div class="search-ai-q"><span>🧑</span><span>${escapeHtml(query || '(Skill Only)')}</span></div>` +
        `<div class="search-ai-body">` +
            `<div class="search-ai-segs"></div>` +
            `<div class="search-ai-cur"><span class="search-ai-thinking">✨ Thinking…</span></div>` +
        `</div>`;
    const segsEl = answerEl.querySelector('.search-ai-segs');
    const curEl = answerEl.querySelector('.search-ai-cur');
    answerEl.scrollTop = answerEl.scrollHeight;

    const apiMessages = [{ role: 'user', content: processedText }];

    await _toolExecutor.startSession('.');
    // NO agent-control tools — same rule as Simple Chat (ChatView). The quick
    // search box is a conversation, not a task: offering finish_task made the
    // model spend its turn "finishing" and the user got a tool trace instead of
    // an answer. The reply itself IS the deliverable.
    _toolExecutor.setToolAllowlist(['web_search', 'fetch_url'], { agentControl: false });
    _toolExecutor._mcpBypassesAllowlist = true;
    _toolExecutor.setMcpRelevanceQuery(processedText);
    _toolExecutor.setMcpPruneOptions({ minScore: 0.12, top: 5 });

    let outputLanguage = 'Japanese';
    try { outputLanguage = (await invoke('get_ai_config'))?.output_language || 'Japanese'; } catch (_) {}

    const toolDefs = _toolExecutor.getToolsForNativeAPI().map(t => {
        return `<tool name="${t.function.name}">
<description>${t.function.description}</description>
<parameters>${JSON.stringify(t.function.parameters)}</parameters>
</tool>`;
    }).join('\n');

    let systemPrompt = "You are a helpful AI assistant. Answer concisely and in the user's language.";
    systemPrompt += `

<available_tools>
${toolDefs}
</available_tools>

<instructions>
If you need to perform actions, query/modify files, run commands, or use any other tools, you MUST reply with a JSON object wrapped inside a markdown code block (\`\`\`json).
The JSON object must contain a "thought" string and a "tool_calls" array.

Example:
\`\`\`json
{
  "thought": "Describe what you observed, what you plan to do, and why you are calling the tool.",
  "tool_calls": [
    {
      "name": "list_files",
      "args": { "path": "." }
    }
  ]
}
\`\`\`

If no tool execution is needed, you can reply normally in plain text.
Always write your thoughts and tool calls in the JSON structure if you use tools.
This is a conversation, not a task: there is no \`finish_task\` to call, and a tool call is never a substitute for the answer itself.
Your final responses and messages to the user MUST be in ${outputLanguage}.
</instructions>
`;

    try {
        let loopCount = 0;
        const maxLoops = 10;
        let keepRunning = true;
        let fullAnswer = '';

        while (keepRunning && loopCount < maxLoops) {
            if (myAbort.signal.aborted) break;

            let aiResponse = '';
            let streamRafPending = false;

            const renderStreamed = () => {
                streamRafPending = false;
                if (!curEl) return;

                // Follow the stream only if the user hasn't scrolled up to read.
                const nearBottom = answerEl.scrollHeight - answerEl.scrollTop - answerEl.clientHeight < 80;

                const trimmed = aiResponse.trimStart();
                const looksLikeToolCall = trimmed.startsWith('\`\`\`json') || trimmed.startsWith('{"thought"') || trimmed.startsWith('{ "thought"');
                if (looksLikeToolCall) {
                    // Update only if not already showing — avoids a per-chunk rewrite.
                    if (!curEl.dataset.toolNote) {
                        curEl.dataset.toolNote = '1';
                        curEl.innerHTML = `<span style="font-size:13px;color:var(--ink-soft);">🤔 Thinking or using tools…</span>`;
                    }
                } else {
                    delete curEl.dataset.toolNote;
                    curEl.innerHTML = `<div class="rv-summary chat-md">${formatMessageContent(aiResponse)}</div>`;
                }
                if (nearBottom) answerEl.scrollTop = answerEl.scrollHeight;
            };

            await llmService.chat(
                apiMessages,
                systemPrompt,
                (chunk) => {
                    if (myAbort.signal.aborted) return;
                    aiResponse += chunk;
                    if (!streamRafPending) {
                        streamRafPending = true;
                        requestAnimationFrame(renderStreamed);
                    }
                },
                myAbort.signal,
                []
            );
            
            if (myAbort.signal.aborted) break;
            renderStreamed(); // Final flush

            fullAnswer += aiResponse;

            const toolCallObj = extractToolCall(aiResponse);
            // Freeze this turn's visual into the segments area (never rewritten
            // again) and reset the streaming node for the next turn — this keeps
            // earlier turns stable on screen instead of re-rendering everything.
            const freezeTurn = (noteHtml) => {
                if (segsEl && noteHtml) segsEl.insertAdjacentHTML('beforeend', noteHtml);
                if (curEl) {
                    delete curEl.dataset.toolNote;
                    curEl.innerHTML = `<span class="search-ai-thinking">✨ Thinking…</span>`;
                }
            };
            if (toolCallObj && toolCallObj.tool_calls && toolCallObj.tool_calls.length > 0) {
                apiMessages.push({ role: 'assistant', content: aiResponse });
                const names = toolCallObj.tool_calls.map(c => c.name).filter(Boolean).join(', ');
                freezeTurn(`<div class="search-ai-toolnote">⚙ ${escapeHtml(names)}</div>`);

                const results = [];
                for (const call of toolCallObj.tool_calls) {
                    const resValue = await _toolExecutor.executeTool(call);
                    results.push({ toolName: call.name, result: typeof resValue === 'string' ? resValue : JSON.stringify(resValue) });
                }

                for (const res of results) {
                    apiMessages.push({
                        role: 'user',
                        content: `Tool result for ${res.toolName}:\n${res.result}`
                    });
                }
                loopCount++;
            } else if (toolCallObj && (!toolCallObj.tool_calls || toolCallObj.tool_calls.length === 0)) {
                apiMessages.push({ role: 'assistant', content: aiResponse });
                apiMessages.push({
                    role: 'user',
                    content: `You outputted a thought/planning JSON but no tool calls and no final answer. Please provide your final response to the user in plain text now.`
                });
                freezeTurn('');
                loopCount++;
            } else {
                keepRunning = false;
            }
        }
        
        if (myAbort.signal.aborted) return;

        if (fullAnswer.trim()) {
            // Remember the rendered Q&A so reopening the spotlight restores it.
            _lastSpotlightQuery = query || '';
            _lastSpotlightAnswerHtml = answerEl.innerHTML;
            _lastSpotlightAnswer = fullAnswer.trim();
            saveQuickSearchToHistory(processedText, fullAnswer).catch(e =>
                console.warn('Quick-search history save failed:', e));
        }
    } catch (e) {
        if (myAbort.signal.aborted) return;
        if (curEl) curEl.innerHTML =
            `<span style="color:var(--error)">Error: ${(e?.message || String(e)).replace(/</g, '&lt;')}</span>`;
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

// ─────────────────────────────────────────────────────────────────────────────
// Approval OS Notifications
// ─────────────────────────────────────────────────────────────────────────────

let _approvalNotifyUnlisten = null;
// Task ids currently paused on ask_user — so their follow-up `complete` isn't
// mis-announced as "Task completed".
const _waitingTasks = new Set();

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
        } else if (evtType === 'status' && data?.status === 'waiting') {
            // ask_user pause — notify "answer needed", and remember it so the
            // immediately-following `complete` isn't announced as "Task completed".
            _waitingTasks.add(taskId);
            _osNotify('❓ 回答が必要 / Answer needed',
                String(data.message || '').replace(/^❓\s*/, '').slice(0, 120) || 'The agent is asking for your input.');
        } else if (evtType === 'complete') {
            if (_waitingTasks.has(taskId)) { _waitingTasks.delete(taskId); return; }
            _sendTaskDoneNotification(taskId, data, false);
        } else if (evtType === 'error') {
            // Only TERMINAL errors end the run. AgentController emits 'error'
            // mid-run for recoverable failures (it retries and continues) —
            // notifying "task failed" for those is just noise.
            if (!data?.terminal) return;
            _waitingTasks.delete(taskId);
            _sendTaskDoneNotification(taskId, data, true);
        }
    });
}

// Single OS-notification path for the whole app (fires globally via the
// task-event-bridge listener, regardless of which view is open). Uses the
// tauri-plugin-notification (reliable in the webview) rather than the Web
// Notification API. Only fires when the app is NOT focused — if you're already
// looking at it you don't need one. This is the ONLY notifier; MonitorView no
// longer notifies, so there are never duplicates.
async function _osNotify(title, body) {
    try {
        if (document.hasFocus && document.hasFocus()) return;
        const t = String(title || 'J.H AI Agent');
        const b = String(body || '');
        // Preferred: our own Rust command (notify-rust with a registered
        // AppUserModelID) so the toast is attributed to "J.H AI Agent" — the
        // plugin path shows "Windows PowerShell" when running unpackaged.
        try {
            await invoke('os_notify', { title: t, body: b });
            return;
        } catch (_) { /* old binary without os_notify — fall through */ }
        let granted = await invoke('plugin:notification|is_permission_granted');
        if (!granted) {
            const perm = await invoke('plugin:notification|request_permission');
            granted = perm === 'granted';
        }
        if (!granted) return;
        await invoke('plugin:notification|notify', { options: { title: t, body: b } });
    } catch (_) { /* best-effort */ }
}

function _sendApprovalNotification(taskId, data) {
    const isCommand = data?.type === 'command_confirm';
    const title = isCommand ? '🛡 承認が必要 / Approval required' : '📋 Plan approval required';
    const body = isCommand
        ? `${(data.command || '').slice(0, 120)}`
        : `${(data.title || data.message || '').slice(0, 120)}`;
    _osNotify(title, body);
}

async function _sendTaskDoneNotification(taskId, data, isError) {
    // External tools (JHEditor / JHER / …) confirm completion on their own side,
    // so JHAI must not ALSO fire an OS toast for them — that is the reported
    // double notification. The caller name rides on the task record (REST POST
    // /tasks), and the WS `complete` event is left untouched either way, so a
    // caller holding the task WS still gets its result exactly as before.
    try {
        const task = await window.apiClient?.getTask(taskId);
        if (task && isExternalCaller(task.caller)) return;
        if (task?.prompt) {
            // (Resolved below, after the external-caller check, to avoid fetching
            // prompt text we are not going to show.)
        }
    } catch (_) {
        // Task lookup failed — keep notifying rather than swallow a completion.
    }

    const title = isError ? '❌ タスク失敗 / Task failed' : '✅ タスク完了 / Task completed';
    let body = isError
        ? (data?.error || 'An error occurred').slice(0, 120)
        : 'The task completed successfully';
    try {
        const task = await window.apiClient?.getTask(taskId);
        if (task?.prompt) body = (isError ? '[Failed] ' : '') + task.prompt.slice(0, 120);
    } catch (_) {}
    _osNotify(title, body);
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

/**
 * The error log's path, and the writer that appends to it.
 *
 * One file, truncated when it passes ~256KB. Rotation by size rather than by
 * date because the question this answers is "what happened just before the
 * thing I am reporting", and that is always the tail.
 */
const ERROR_LOG_MAX = 256 * 1024;
let _errorLogPath = null;

async function errorLogPath() {
    if (_errorLogPath) return _errorLogPath;
    const dir = await invoke('get_app_config_dir');
    _errorLogPath = `${dir}/errors.log`;
    return _errorLogPath;
}

async function appendErrorLog(entry) {
    try {
        const path = await errorLogPath();
        let prev = '';
        try { prev = (await invoke('read_file', { path })) || ''; } catch (_) { /* first write */ }
        if (prev.length > ERROR_LOG_MAX) prev = prev.slice(-Math.floor(ERROR_LOG_MAX / 2));
        const line = `${entry.at} [${entry.source}] ${entry.text}` + String.fromCharCode(10);
        await invoke('write_file', { path, content: prev + line });
    } catch (e) {
        // The log is a convenience. If writing it fails, the console entry the
        // reporter already made is what remains — and saying so here would be a
        // second failure notice for the same event.
        console.warn('Could not append to the error log:', e);
    }
}

/** Everything captured this session, for a bug report. Exposed for the console. */
window.jhaiDiagnostics = () => recentErrors()
    .map(e => `${e.at} [${e.source}] ${e.text}`)
    .join(String.fromCharCode(10, 10));

window.addEventListener('DOMContentLoaded', async () => {
    // FIRST, before anything that can fail. An app with no error channel is one
    // where a rejected promise inside an effect leaves a blank panel and no
    // explanation — the failure mode Report_20260829.md §1 proposal 8 describes.
    installErrorReporter({
        toast: (line) => showNotification(`エラー: ${line}`),
        write: (entry) => { appendErrorLog(entry); },
    });

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
        // ONE registry for everything that runs without being asked.
        //
        // `scheduleManager` and `triggerManager` are deliberately NOT started:
        // their records were migrated into jobs, so running them as well would
        // start every job twice. Their stores are still on disk and untouched,
        // so the migration can be re-run or abandoned.
        jobManager.init();
        // Cost of runs that finished while the app was closed. A total that
        // quietly under-reports is worse than no total.
        jobManager.reconcile().catch(() => {});

        // The app does its own watching. Before this, "run when mail arrives"
        // meant a Python script in Windows Task Scheduler — a scheduler-owning
        // app outsourcing the one part that makes it autonomous.
        watcherManager.init();

        await listen('trigger-event', (e) => {
            try { jobManager.onEvent(e.payload); }
            catch (err) { console.warn('event intake failed:', err); }
        });

        // Initialize OS notification support for approval requests
        initApprovalNotifications();

        // Listen for global-shortcut event from Rust backend
        _searchUnlisten = await listen('show-search', () => showSearch());

        // The spotlight window asks the main window to navigate (e.g. open a task
        // from the history list). open_main_window (Rust) shows/focuses us.
        await listen('spotlight-navigate', (e) => {
            const hash = e.payload?.hash;
            if (!hash) return;
            // The main window has its OWN search overlay, and the global hotkey
            // opens both it and the spotlight window. Handing over from
            // spotlight therefore arrives with that overlay still up, floating
            // over the view we are about to show — which is what the user saw
            // after "Open App": the app in front, with a search box on top of it.
            hideSearch();
            // Assigning the SAME hash fires no hashchange, so the view is never
            // (re)rendered — the window comes forward showing whatever was
            // there, which for a main window that has been hidden since start-up
            // is an empty content area. Route explicitly when nothing changed.
            if (window.location.hash === hash) handleRoute();
            else window.location.hash = hash;
        });

        // Listen for routes
        window.addEventListener('hashchange', handleRoute);

        // Load initial page
        await handleRoute();

        // FIRST-RUN SETUP. Asked after the route so the user sees the app behind the
        // wizard rather than a blank screen, and after initFromConfig so the check
        // reads the config the agent will actually use.
        //
        // The trigger is "is there a usable connection?", not a stored has-run flag —
        // see views/onboarding/steps.js for why that distinction matters.
        try {
            const { maybeShowOnboarding } = await import('./dashboard/onboarding.js');
            const shown = await maybeShowOnboarding();

            // Update check: silent (it speaks only when there IS one), NOT awaited, and
            // skipped while the wizard is up — a brand-new user has enough to read.
            // An unreachable release host must never delay the app starting.
            if (!shown) {
                import('./dashboard/updater.js')
                    .then(m => m.checkForUpdateOnLaunch())
                    .catch(e => console.warn('Updater unavailable:', e));
            }
        } catch (e) {
            // Never block startup on the wizard: a user with a working config would
            // be locked out of a working app by a bug in the thing that helps new ones.
            console.warn('Onboarding check failed (continuing):', e);
        }

    } catch (e) {
        console.error("Critical: Failed to connect backend API:", e);
        // escapeHtml, like every other interpolation in this file. This was the
        // one that P2-11's pass missed, and it is the one path whose content is
        // least under our control: the text comes from a backend error, an MCP
        // server's message or a thrown Response. Report_20260829.md B3.
        //
        // Themed rather than a hard-coded red on nothing: this is the LAST thing
        // some users will see, and an unstyled block reads as a crash inside a
        // crash. The log path is named because the reporter has already written
        // there by the time this renders.
        document.getElementById('app').innerHTML = `
            <div class="fatal">
                <h2 class="fatal-title">起動できませんでした</h2>
                <p class="fatal-body">ローカルサーバー API に接続できませんでした。アプリを再起動してください。</p>
                <pre class="fatal-detail">${escapeHtml(String(e?.message || e))}</pre>
                <p class="fatal-hint">詳細は設定ディレクトリの <code>errors.log</code> に記録されています。</p>
            </div>
        `;
    }
});
