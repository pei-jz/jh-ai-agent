import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { Sidebar } from './dashboard/components/Sidebar.js';
import { OverviewView } from './dashboard/views/OverviewView.js';
import { ChatView } from './dashboard/views/ChatView.js';
import { MonitorView } from './dashboard/views/MonitorView.js';
import { HistoryView } from './dashboard/views/HistoryView.js';
import { ConfigView } from './dashboard/views/ConfigView.js';
import { ScheduleView } from './dashboard/views/ScheduleView.js';
import { AnalyticsView } from './dashboard/views/AnalyticsView.js';
import { taskBridge } from './modules/bridge/TaskBridge.js';
import llmService from './modules/ai/LLMService.js';

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
        case 'history':
            viewInstance = new HistoryView();
            break;
        case 'schedule':
            viewInstance = new ScheduleView();
            break;
        case 'analytics':
            viewInstance = new AnalyticsView();
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
        .search-input-icon { font-size: 16px; opacity: 0.6; flex-shrink: 0; }
        #search-input {
            flex: 1;
            background: none;
            border: none;
            outline: none;
            color: hsl(220, 20%, 90%);
            font-size: 16px;
            font-family: inherit;
            caret-color: hsl(185, 100%, 55%);
        }
        #search-input::placeholder { color: hsl(220, 12%, 40%); }

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
    `;
    document.head.appendChild(style);
}

function buildSearchOverlayHTML() {
    return `
        <div class="search-backdrop" id="search-backdrop"></div>
        <div class="search-container" role="dialog" aria-label="Quick Search">
            <div class="search-input-row">
                <span class="search-input-icon">🔍</span>
                <input id="search-input" type="text" placeholder="Search tasks…" autocomplete="off" spellcheck="false" />
                <button class="search-expand-btn" id="search-expand-btn" title="Open full app (Ctrl+Enter)">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/>
                    </svg>
                    Open App
                </button>
            </div>
            <div id="search-results"></div>
            <div class="search-footer">
                <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
                <span><kbd>↵</kbd> Open task</span>
                <span><kbd>Ctrl+↵</kbd> Full app</span>
                <span style="margin-left:auto"><kbd>Esc</kbd> Close</span>
            </div>
        </div>
    `;
}

let _searchUnlisten = null;
let _searchFocusIndex = -1;
let _searchItems = [];

function initSearchOverlay() {
    injectSearchOverlayStyles();

    const el = document.createElement('div');
    el.id = 'search-overlay';
    el.innerHTML = buildSearchOverlayHTML();
    document.body.appendChild(el);

    // Backdrop click → close
    el.querySelector('#search-backdrop').addEventListener('click', hideSearch);

    // Expand button → close overlay (main window already visible)
    el.querySelector('#search-expand-btn').addEventListener('click', hideSearch);

    // Input events
    const input = el.querySelector('#search-input');
    input.addEventListener('input', () => renderSearchResults(input.value));
    input.addEventListener('keydown', onSearchKeydown);
}

function showSearch() {
    const overlay = document.getElementById('search-overlay');
    if (!overlay) return;
    _searchFocusIndex = -1;
    overlay.classList.add('visible');
    const input = document.getElementById('search-input');
    input.value = '';
    input.focus();
    renderSearchResults('');
}

function hideSearch() {
    const overlay = document.getElementById('search-overlay');
    overlay?.classList.remove('visible');
    _searchFocusIndex = -1;
}

async function renderSearchResults(query) {
    const container = document.getElementById('search-results');
    if (!container) return;

    let tasks = [];
    try {
        const list = await window.apiClient?.listTasks();
        tasks = (list?.tasks || list || []);
    } catch (_) { /* API not ready */ }

    const q = query.trim().toLowerCase();
    const filtered = tasks
        .filter(t => !q || (t.prompt || '').toLowerCase().includes(q))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 8);

    _searchItems = filtered;
    _searchFocusIndex = -1;

    if (!filtered.length) {
        container.innerHTML = '';
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
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => openSearchResult(item.getAttribute('data-task-id')));
    });
}

function openSearchResult(taskId) {
    hideSearch();
    if (taskId) {
        window.location.hash = `#monitor?task=${taskId}`;
    }
}

function onSearchKeydown(e) {
    const items = document.querySelectorAll('.search-result-item');
    if (e.key === 'Escape') {
        e.preventDefault();
        hideSearch();
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        _searchFocusIndex = Math.min(_searchFocusIndex + 1, items.length - 1);
        updateSearchFocus(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _searchFocusIndex = Math.max(_searchFocusIndex - 1, 0);
        updateSearchFocus(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey) {
            // Ctrl+Enter → just close overlay (full app is already visible)
            hideSearch();
        } else if (_searchFocusIndex >= 0 && _searchItems[_searchFocusIndex]) {
            openSearchResult(_searchItems[_searchFocusIndex].id);
        }
    }
}

function updateSearchFocus(items) {
    items.forEach((el, i) => el.classList.toggle('focused', i === _searchFocusIndex));
    items[_searchFocusIndex]?.scrollIntoView({ block: 'nearest' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Initialization
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
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

        // Initialize TaskBridge for background agent runs
        await taskBridge.init();

        // Listen for global-shortcut event from Rust backend
        _searchUnlisten = await listen('show-search', () => showSearch());

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
