import llmService from '../../modules/ai/LLMService.js';
import { ToolExecutor } from '../../modules/ai/ToolExecutor.js';
import { mcpManager } from '../../modules/ai/McpManager.js';
import { workflowManager } from '../../modules/ai/WorkflowManager.js';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { renderFileList, filesFromModified, ensureResultViewStyles } from '../utils/resultView.js';
import { escapeHtml, formatMessageContent, formatMarkdown, renderTableHtml } from './chat/chatMarkdown.js';
import { STORAGE_KEY as CHAT_SESSIONS_KEY, parseSessions, pruneSessions } from './chat/chatSessions.js';
import { extractToolCall, renderMessageHtml } from './chat/chatRenderer.js';
import { icon } from '../utils/icons.js';

// Simple-mode tool loop's executor. sendMessage referenced `toolExecutor` but no
// instance was ever created/imported (latent ReferenceError when tools were
// enabled in Simple mode) — this module-level instance restores the intended
// behavior. Agent mode is unaffected (it runs server-side via TaskBridge).
const toolExecutor = new ToolExecutor();

export class ChatView {
    constructor() {
        this.messages = [];
        this.systemPrompt = 'You are a helpful AI assistant.';
        this.models = [];
        this.selectedModel = '';
        this.isGenerating = false;
        this.abortController = null;
        this.attachments = [];
        this._dragDropUnlisten = null;

        // ── Active skills ────────────────────────────────────────────────
        // Skills selected via the slash-popup are NOT expanded into the input
        // textarea (that bloated the box). Instead each is held here as a
        // lightweight reference {name, title} shown as a removable chip, and
        // its full body is auto-injected into the outgoing message at send
        // time (see sendMessage). The visible chat bubble shows only a small
        // badge, keeping the transcript clean.
        this.activeSkills = [];   // [{ name, title }]
        
        // Settings states
        this.selectedWorkflow = 'none'; // 'none', 'research', 'planning', 'execution', 'debugging', 'verification'
        this.workspacePath = '';
        this.toolsEnabled = false;
        this.allMcpServers = {};
        this.enabledMcpServers = [];
        this.settingsExpanded = false;

        // ChatView is a SIMPLE-CHAT surface: direct llmService.chat calls with a
        // small tool loop (web search + relevance-pruned MCP). The former 'agent'
        // mode (TaskBridge / iterative_agent) was removed — background agent runs
        // now go through Monitor's "New Task". No mode toggle here anymore.

        // Slash-command popup state
        this._slashItems = [];      // [{type, key, label, icon, prompt?}]
        this._slashIndex = 0;
        this._slashQuery = '';

        // Load sessions and history
        this.loadHistory();
    }

    async loadModels() {
        // Perf: the model list doesn't change while this view instance is alive,
        // but reRender() (mode switch, tool toggle, MCP toggle, …) re-runs
        // render() → loadModels(). Skip the repeat HTTP round-trip.
        if (this._modelsLoaded) return;
        this._modelsLoaded = true;
        try {
            if (window.apiClient) {
                const res = await window.apiClient.getModels();
                this.models = res.models || [];
                if (this.models.length > 0) {
                    // Check if current selected model is in list, otherwise default to first
                    const current = llmService.getCurrentModel();
                    if (this.models.some(m => m.id === current)) {
                        this.selectedModel = current;
                    } else {
                        this.selectedModel = this.models[0].id;
                        llmService.setCurrentModel(this.selectedModel);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load models for chat:', e);
        }

        // Fallback static list if no models configured
        if (this.models.length === 0) {
            this.models = [
                { id: 'openai:gpt-4o', name: 'GPT-4o (Fallback)', provider: 'openai' },
                { id: 'anthropic:claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (Fallback)', provider: 'anthropic' },
                { id: 'gemini:gemini-1.5-flash', name: 'Gemini 1.5 Flash (Fallback)', provider: 'gemini' }
            ];
            this.selectedModel = this.models[0].id;
            llmService.setCurrentModel(this.selectedModel);
        }
    }

    async loadChatConfig() {
        // Perf: config / templates / skills / session-file restore only need to
        // load once per view instance. reRender() re-runs render() frequently
        // (mode switch, tool toggle, MCP toggle, …) — without this guard each
        // one repeated several invoke() calls + a full skill-directory scan,
        // which is a big part of why the UI felt sluggish. Navigating away and
        // back creates a fresh ChatView, so settings changes still get picked up.
        if (this._chatConfigLoaded) {
            this.enabledMcpServers = Array.from(mcpManager.clients.keys());
            return;
        }
        try {
            const config = await invoke('get_ai_config');
            this.config = config || {};
            this._chatConfigLoaded = true;

            if (!this.workspacePath && this.config.approved_projects && this.config.approved_projects.length > 0) {
                this.workspacePath = this.config.approved_projects[0];
            }
            this.allMcpServers = this.config.mcp_servers || {};
            this.enabledMcpServers = Array.from(mcpManager.clients.keys());

            // Load prompt templates and skills for slash-command popup
            promptTemplateManager.loadFromConfig(this.config);
            await skillManager.refresh();

            // Restore sessions from file backup if it has more data than localStorage
            await this._restoreSessionsFromFile();
        } catch (e) {
            console.error('Failed to load chat config:', e);
        }
    }

    async render() {
        await this.loadModels();
        await this.loadChatConfig();

        const modelOptions = this.models.map(m => `
            <option value="${m.id}" ${this.selectedModel === m.id ? 'selected' : ''}>
                ${escapeHtml(m.name)}
            </option>
        `).join('');

        // Generate MCP server checkbox list
        const mcpServerKeys = Object.keys(this.allMcpServers || {});
        let mcpServersHtml = '';
        if (mcpServerKeys.length === 0) {
            mcpServersHtml = `<div style="font-size: 11.5px; color: var(--text-tertiary);">No MCP servers configured in Settings.</div>`;
        } else {
            mcpServersHtml = mcpServerKeys.map(name => {
                const isRunning = mcpManager.clients.has(name);
                const toolCount = isRunning ? (mcpManager.clients.get(name)?.tools?.length ?? 0) : 0;
                const err = mcpManager.getError(name);
                let badge = '';
                if (isRunning) {
                    badge = `<span style="font-size: 10px; background: var(--accent); color: #000; border-radius: 4px; padding: 1px 5px; font-weight: 600;">🟢 ${toolCount}t</span>`;
                } else if (err) {
                    // Failed badge: hover for full detail (native tooltip) + click for full dialog.
                    badge = `<span class="chat-mcp-error-badge" data-name="${escapeHtml(name)}"
                        title="${escapeHtml(err.message)}"
                        style="font-size: 10px; background: var(--error, #c0392b); color: #fff; border-radius: 4px; padding: 1px 6px; font-weight: 600; cursor: pointer;">⚠ Failed to start (details)</span>`;
                }
                return `
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none;">
                        <input type="checkbox" class="chat-mcp-checkbox" data-name="${name}" ${isRunning ? 'checked' : ''} style="cursor: pointer;">
                        <span>${escapeHtml(name)}</span>
                        ${badge}
                    </label>
                `;
            }).join('');
        }

        // Generate tools list
        const activeTools = ToolExecutor.getAllAvailableToolsForNativeAPI();
        let toolsListHtml = '';
        if (activeTools.length === 0) {
            toolsListHtml = `<div style="font-size: 11.5px; color: var(--text-tertiary);">No tools available.</div>`;
        } else {
            toolsListHtml = activeTools.map(t => {
                const func = t.function;
                return `
                    <div style="background: var(--bg-tertiary); border: 1px solid var(--border-light); border-radius: 4px; padding: 6px 8px; font-size: 11px;">
                        <div style="font-family: var(--font-mono); font-weight: 600; color: var(--accent); margin-bottom: 2px;">${escapeHtml(func.name)}</div>
                        <div style="color: var(--text-secondary); line-height: 1.4;">${escapeHtml(func.description)}</div>
                    </div>
                `;
            }).join('');
        }

        const messageListHtml = this.messages.length === 0
            ? `
                <div class="chat-empty-state">
                    <div class="chat-empty-icon">💬</div>
                    <h3>Start a conversation</h3>
                    <p>Ask the selected AI model questions, draft text, or explore ideas.</p>
                </div>
            `
            : this.messages.map((msg, index) => this._renderMessageHtml(msg, index)).join('');

        // ChatView is now a SIMPLE chat surface only (agent tasks live in the
        // Monitor "new task" flow). Web search + relevant MCP tools are available;
        // there is no mode toggle / workspace / agent picker here.
        const headerTitle = 'Chat';
        const headerSubtitle = 'Chat with AI (web search + relevant MCP tools available). Run agents from Monitor → New Task';

        return `
            <style>
                .chat-view-layout {
                    display: flex;
                    flex-direction: column;
                    height: calc(100vh - var(--titlebar-height) - 64px);
                    position: relative;
                }
                
                .chat-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--border);
                    margin-bottom: 16px;
                    flex-shrink: 0;
                }

                .chat-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .chat-models-select {
                    min-width: 220px;
                }

                .chat-body {
                    flex: 1;
                    overflow-y: auto;
                    padding-right: 8px;
                    margin-bottom: 16px;
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }

                .chat-empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    flex: 1;
                    opacity: 0.7;
                    padding: 40px;
                }

                .chat-empty-icon {
                    font-size: 48px;
                    margin-bottom: 16px;
                    filter: drop-shadow(0 0 10px var(--accent-glow));
                }

                .chat-message-row {
                    display: flex;
                    width: 100%;
                    animation: messageEnter 0.25s ease forwards;
                }

                @keyframes messageEnter {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .chat-message-row.msg-user {
                    justify-content: flex-end;
                }

                .chat-message-row.msg-ai {
                    justify-content: flex-start;
                }

                .message-bubble {
                    padding: 12px 16px;
                    border-radius: 12px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    color: var(--text-primary);
                    position: relative;
                    max-width: 85%;
                }

                .msg-user .message-bubble {
                    background: hsla(185, 100%, 55%, 0.08);
                    border-color: var(--border-focus);
                    border-bottom-right-radius: 2px;
                }

                .msg-ai .message-bubble {
                    background: var(--bg-secondary);
                    border-color: var(--border);
                    border-bottom-left-radius: 2px;
                }

                .message-content {
                    font-size: 13.5px;
                    line-height: 1.6;
                    word-break: break-word;
                }

                /* Markdown Styles inside Chat */
                .message-content p {
                    margin-bottom: 8px;
                }
                .message-content p:last-child {
                    margin-bottom: 0;
                }
                .message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6 {
                    margin: 12px 0 6px 0;
                    color: var(--accent);
                }
                .message-content h1:first-child, .message-content h2:first-child, .message-content h3:first-child {
                    margin-top: 0;
                }
                .message-content ul, .message-content ol {
                    margin: 8px 0;
                    padding-left: 20px;
                }
                .message-content li {
                    margin-bottom: 4px;
                }
                .message-content blockquote {
                    border-left: 3px solid var(--accent);
                    background: var(--bg-tertiary);
                    padding: 6px 12px;
                    margin: 8px 0;
                    color: var(--text-secondary);
                    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
                }
                .message-content table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 12px 0;
                    font-size: 13px;
                }
                .message-content th, .message-content td {
                    border: 1px solid var(--border);
                    padding: 8px 10px;
                    text-align: left;
                }
                .message-content th {
                    background: var(--bg-tertiary);
                    font-weight: 600;
                    color: var(--accent);
                }
                .message-content tr:nth-child(even) {
                    background: hsla(220, 18%, 15%, 0.3);
                }

                .inline-code {
                    font-family: var(--font-mono);
                    font-size: 12px;
                    background: var(--bg-tertiary);
                    padding: 2px 5px;
                    border-radius: 4px;
                    color: var(--accent);
                }
                .code-block-wrapper {
                    margin: 10px 0;
                    border-radius: 6px;
                    overflow: hidden;
                    border: 1px solid var(--border);
                }
                .code-block-header {
                    background: var(--bg-input);
                    padding: 6px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--border);
                }
                .code-block-lang {
                    font-size: 11px;
                    font-family: var(--font-mono);
                    color: var(--text-secondary);
                    text-transform: uppercase;
                }
                .btn-copy-code {
                    background: transparent;
                    border: none;
                    color: var(--accent);
                    font-size: 11px;
                    cursor: pointer;
                    font-weight: 500;
                }
                .btn-copy-code:hover {
                    color: var(--accent-hover);
                }
                .code-block-wrapper pre {
                    margin: 0;
                    padding: 12px;
                    background: var(--bg-primary);
                    overflow-x: auto;
                }
                .code-block-wrapper code {
                    font-family: var(--font-mono);
                    font-size: 12.5px;
                    color: #e6edf3;
                    line-height: 1.5;
                }

                .chat-system-prompt-container {
                    margin-bottom: 12px;
                    flex-shrink: 0;
                }

                .chat-system-prompt-toggle {
                    font-size: 12px;
                    color: var(--text-secondary);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    user-select: none;
                    width: fit-content;
                }

                .chat-system-prompt-toggle:hover {
                    color: var(--text-primary);
                }

                .chat-system-prompt-panel {
                    display: none;
                    margin-top: 6px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-md);
                    padding: 12px;
                    animation: slideDown var(--transition-fast) forwards;
                }

                @keyframes slideDown {
                    from { opacity: 0; transform: translateY(-4px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .chat-input-area-wrapper {
                    display: flex;
                    flex-direction: column;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    padding: 8px 12px;
                    flex-shrink: 0;
                }

                .chat-input-area-wrapper:focus-within {
                    border-color: var(--accent);
                    box-shadow: 0 0 0 3px var(--accent-glow);
                }

                .chat-input-container {
                    display: flex;
                    gap: 12px;
                    align-items: flex-end;
                    background: transparent;
                    border: none;
                    padding: 0;
                    width: 100%;
                }

                .btn-chat-attach {
                    background: transparent;
                    border: none;
                    color: var(--text-secondary);
                    font-size: 16px;
                    cursor: pointer;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--radius-sm);
                    transition: background var(--transition-fast), color var(--transition-fast);
                }

                .btn-chat-attach:hover {
                    color: var(--text-primary);
                    background: var(--bg-hover);
                }

                .chat-input-previews {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--border-light);
                }

                /* ── Active-skill chips ── */
                .chat-input-skills {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 8px;
                }
                .skill-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    background: hsla(265, 90%, 65%, 0.12);
                    border: 1px solid hsla(265, 90%, 65%, 0.45);
                    color: var(--text-primary);
                    border-radius: 999px;
                    padding: 3px 8px;
                    font-size: 11.5px;
                    font-weight: 500;
                    line-height: 1.4;
                }
                .skill-chip-icon { font-size: 11px; }
                .skill-chip-label {
                    max-width: 160px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .skill-chip-remove {
                    background: none;
                    border: none;
                    color: var(--text-tertiary);
                    cursor: pointer;
                    padding: 0 0 0 2px;
                    font-size: 11px;
                    line-height: 1;
                }
                .skill-chip-remove:hover { color: var(--error); }
                .skill-chip-static { background: hsla(265, 90%, 65%, 0.10); }

                .chat-preview-item {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    padding: 4px 24px 4px 8px;
                    font-size: 11px;
                    color: var(--text-secondary);
                    max-width: 180px;
                }

                .chat-preview-item.preview-image {
                    padding: 4px 24px 4px 4px;
                }

                .chat-preview-item img {
                    width: 32px;
                    height: 32px;
                    object-fit: cover;
                    border-radius: 4px;
                }

                .chat-preview-item .file-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 110px;
                }

                .chat-preview-item .btn-remove-preview {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    background: transparent;
                    border: none;
                    color: var(--error);
                    cursor: pointer;
                    font-size: 10px;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                }

                .chat-preview-item .btn-remove-preview:hover {
                    background: var(--error-bg);
                }

                /* Collapsible Thought Process Styling */
                .thought-process-block {
                    margin: 8px 0;
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-sm);
                    background: hsla(220, 20%, 6%, 0.5);
                    overflow: hidden;
                }

                .thought-process-block summary {
                    padding: 8px 12px;
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-secondary);
                    cursor: pointer;
                    user-select: none;
                    background: var(--bg-tertiary);
                    outline: none;
                }

                .thought-process-block summary:hover {
                    color: var(--text-primary);
                    background: var(--bg-hover);
                }

                .thought-process-content {
                    padding: 12px;
                    font-size: 12px;
                    line-height: 1.5;
                    color: var(--text-secondary);
                    font-family: var(--font-mono);
                    border-top: 1px solid var(--border-light);
                    white-space: pre-wrap;
                }

                .thought-process-streaming {
                    border-left: 2px solid var(--accent);
                }

                /* ── Mode pill toggle ── */
                .chat-mode-pills {
                    display: flex;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 3px;
                    gap: 2px;
                }
                .chat-mode-pill {
                    padding: 5px 14px;
                    border-radius: 6px;
                    border: none;
                    cursor: pointer;
                    font-size: 12.5px;
                    font-weight: 500;
                    transition: background var(--transition-fast), color var(--transition-fast);
                    background: transparent;
                    color: var(--text-secondary);
                    white-space: nowrap;
                }
                .chat-mode-pill.active {
                    background: var(--accent);
                    color: #000;
                }
                .chat-mode-pill:hover:not(.active) {
                    background: var(--bg-hover);
                    color: var(--text-primary);
                }

                /* ── Agent workspace bar ── */
                .agent-workspace-bar {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    background: hsla(185, 100%, 55%, 0.05);
                    border: 1px solid var(--border-focus);
                    border-radius: var(--radius-md);
                    margin-bottom: 12px;
                    flex-shrink: 0;
                }
                .agent-workspace-bar label {
                    font-size: 11.5px;
                    color: var(--accent);
                    font-weight: 600;
                    white-space: nowrap;
                }

                .chat-textarea {
                    flex: 1;
                    background: transparent;
                    border: none;
                    outline: none;
                    color: var(--text-primary);
                    font-family: inherit;
                    font-size: 13.5px;
                    resize: none;
                    max-height: 150px;
                    height: 24px;
                    line-height: 1.5;
                    padding: 4px 0;
                    margin: 0;
                }

                .chat-textarea::placeholder {
                    color: var(--text-tertiary);
                }

                .btn-chat-send {
                    background: var(--accent);
                    color: var(--text-inverse);
                    border: none;
                    border-radius: var(--radius-md);
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: background var(--transition-fast), transform var(--transition-fast);
                }

                .btn-chat-send:hover {
                    background: var(--accent-hover);
                }

                .btn-chat-send:active {
                    transform: scale(0.95);
                }

                .btn-chat-send.btn-stop {
                    background: var(--error);
                }

                .btn-chat-send.btn-stop:hover {
                    background: hsl(0, 75%, 60%);
                }

                /* ── Slash command popup ── */
                .slash-popup {
                    position: absolute;
                    bottom: calc(100% + 6px);
                    left: 0;
                    right: 0;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-focus);
                    border-radius: var(--radius-md);
                    box-shadow: 0 -4px 20px rgba(0,0,0,0.35);
                    overflow: hidden;
                    z-index: 200;
                    max-height: 260px;
                    display: flex;
                    flex-direction: column;
                }
                .slash-popup-header {
                    padding: 6px 12px;
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--text-tertiary);
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border-light);
                    flex-shrink: 0;
                }
                .slash-popup-list {
                    overflow-y: auto;
                    flex: 1;
                }
                .slash-popup-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 8px 12px;
                    cursor: pointer;
                    transition: background var(--transition-fast);
                    font-size: 13px;
                }
                .slash-popup-item:hover,
                .slash-popup-item.selected {
                    background: var(--bg-hover);
                }
                .slash-popup-item.selected {
                    background: rgba(0,200,255,0.08);
                }
                .slash-popup-icon {
                    font-size: 16px;
                    flex-shrink: 0;
                }
                .slash-popup-key {
                    font-family: var(--font-mono);
                    font-size: 12px;
                    color: var(--accent);
                    font-weight: 600;
                    min-width: 80px;
                }
                .slash-popup-label {
                    color: var(--text-secondary);
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .slash-popup-type {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: 3px;
                    padding: 1px 5px;
                    flex-shrink: 0;
                }
                .slash-popup-empty {
                    padding: 12px;
                    text-align: center;
                    font-size: 12px;
                    color: var(--text-tertiary);
                }

                /* ── Agent Step Display ── */
                .agent-steps-container {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    margin-bottom: 10px;
                }
                .agent-step-block {
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    overflow: hidden;
                    background: var(--bg-tertiary);
                    font-size: 12px;
                }
                .agent-step-block > summary {
                    padding: 6px 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    user-select: none;
                    background: var(--bg-secondary);
                    outline: none;
                    list-style: none;
                }
                .agent-step-block > summary::-webkit-details-marker { display: none; }
                .agent-step-block > summary:hover { background: var(--bg-hover); }
                .agent-step-num {
                    font-size: 10px;
                    font-weight: 700;
                    background: var(--accent);
                    color: #000;
                    border-radius: 3px;
                    padding: 1px 5px;
                    flex-shrink: 0;
                }
                .agent-step-label {
                    color: var(--text-secondary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                }
                .agent-step-body {
                    padding: 8px 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    border-top: 1px solid var(--border-light);
                }
                .agent-thought-text {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    font-family: var(--font-mono);
                    max-height: 220px;
                    overflow-y: auto;
                    line-height: 1.5;
                }
                /* Structured OBSERVE / PLAN / CALL rows */
                .agent-opc {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .agent-opc-row {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    font-size: 11.5px;
                    line-height: 1.5;
                }
                .agent-opc-label {
                    font-size: 9.5px;
                    font-weight: 700;
                    letter-spacing: 0.05em;
                    border-radius: 3px;
                    padding: 2px 5px;
                    flex-shrink: 0;
                    margin-top: 1px;
                    text-transform: uppercase;
                }
                .agent-opc-label.observe { background: #1e3a2f; color: #4ade80; }
                .agent-opc-label.plan    { background: #1e2e45; color: #60a5fa; }
                .agent-opc-label.call    { background: #2e1e3a; color: #c084fc; }
                .agent-opc-text {
                    color: var(--text-primary);
                    flex: 1;
                    font-family: var(--font-mono);
                }
                .agent-tool-badge {
                    font-size: 11px;
                    background: var(--bg-primary);
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    padding: 2px 8px;
                    color: var(--accent);
                    font-family: var(--font-mono);
                    align-self: flex-start;
                }
                .agent-final-content {
                    border-top: 1px solid var(--border-light);
                    padding-top: 10px;
                    margin-top: 4px;
                }

                /* Pulsing generating effect */
                .generating-indicator {
                    display: flex;
                    padding: 10px 14px;
                    align-self: flex-start;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    animation: messageEnter 0.2s ease forwards;
                    max-width: 85%;
                }

                .generating-dot {
                    width: 6px;
                    height: 6px;
                    background: var(--accent);
                    border-radius: 50%;
                    animation: pulseDot 1.4s infinite ease-in-out both;
                }

                .generating-dot:nth-child(1) { animation-delay: -0.32s; }
                .generating-dot:nth-child(2) { animation-delay: -0.16s; }

                @keyframes pulseDot {
                    0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
                    40% { transform: scale(1); opacity: 1; }
                }
            </style>

            <div class="view-container">
                <div class="chat-view-layout">
                    
                    <!-- Chat Header -->
                    <div class="chat-header">
                        <div>
                            <h1>${headerTitle}</h1>
                            <p class="subtitle">${headerSubtitle}</p>
                        </div>
                        <div class="chat-header-actions">
                            <select id="chat-model-select" class="select chat-models-select">
                                ${modelOptions}
                            </select>
                            <button id="btn-new-chat" class="btn btn-primary btn-sm">📝 New Chat</button>
                            <button id="btn-chat-history" class="btn btn-secondary btn-sm">🕒 History</button>
                            <button id="btn-clear-chat" class="btn btn-secondary btn-sm">🗑️ Clear Chat</button>
                        </div>
                    </div>

                    <!-- System Prompt & Chat Settings Collapsible -->
                    <div class="chat-system-prompt-container">
                        <div class="chat-system-prompt-toggle" id="prompt-toggle-btn">
                            <span>⚙️</span> Chat Settings
                        </div>
                        <div class="chat-system-prompt-panel" id="prompt-panel" style="display: ${this.settingsExpanded ? 'block' : 'none'};">
                            <div class="provider-card-fields" style="display: flex; flex-direction: column; gap: 12px;">
                                <div class="input-group">
                                    <label class="input-label" style="font-size: 11px; margin-bottom: 4px;">System Prompt</label>
                                    <input type="text" id="chat-system-input" class="input" value="${escapeHtml(this.systemPrompt)}" placeholder="e.g. You are a helpful AI assistant.">
                                </div>
                                <div class="input-group" style="border-top: 1px solid var(--border-light); padding-top: 12px;">
                                    <label class="input-label" style="font-size: 11px; margin-bottom: 6px; display: block; font-weight: 600;">🔌 MCP Servers</label>
                                    <p style="font-size: 11px; color: var(--text-tertiary); margin: 0 0 8px;">Only MCP tools relevant to your message are sent automatically (irrelevant ones are skipped). Web search is always available.</p>
                                    <div style="display: flex; flex-wrap: wrap; gap: 16px;">
                                        ${mcpServersHtml}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Chat Message Area -->
                    <div class="chat-body" id="chat-messages-container">
                        ${messageListHtml}
                    </div>

                    <!-- Input Area -->
                    <div class="chat-input-area-wrapper" style="position: relative;">
                        <div id="slash-popup" class="slash-popup" style="display:none;"></div>
                        <div class="chat-input-skills" id="chat-input-skills" style="display: none;"></div>
                        <div class="chat-input-previews" id="chat-input-previews" style="display: none;"></div>
                        <div class="chat-input-container">
                            <button id="btn-attach-file" class="btn-chat-attach" type="button" title="Attach image or file">📎</button>
                            <textarea id="chat-textarea-input" class="chat-textarea" placeholder="Type a message or / for commands… (Enter to send, Shift+Enter for new line)" rows="1"></textarea>
                            <button id="btn-send-message" class="btn-chat-send" aria-label="Send message">
                                ➡️
                            </button>
                        </div>
                        <input type="file" id="chat-file-input" style="display: none;" multiple accept="image/*,text/*,.log,.json,.md,.js,.py,.rs">
                    </div>

                </div>
            </div>
        `;
    }

    init() {
        const chatBody = document.getElementById('chat-messages-container');
        const textarea = document.getElementById('chat-textarea-input');
        const sendBtn = document.getElementById('btn-send-message');
        const clearBtn = document.getElementById('btn-clear-chat');
        const modelSelect = document.getElementById('chat-model-select');
        const workflowSelect = document.getElementById('chat-workflow-select');
        const promptToggle = document.getElementById('prompt-toggle-btn');
        const promptPanel = document.getElementById('prompt-panel');
        const systemInput = document.getElementById('chat-system-input');
        const workspaceInput = document.getElementById('chat-workspace-input');
        const btnSelectWorkspace = document.getElementById('btn-select-workspace');
        const toolsToggle = document.getElementById('chat-tools-enabled-toggle');
        const toolsWrap = document.getElementById('chat-tools-enabled-wrap');

        // Scroll to bottom
        if (chatBody) {
            chatBody.scrollTop = chatBody.scrollHeight;

            // Delegated click handler for dynamically-rendered message content.
            // Inline on* handlers were removed so a strict CSP (script-src 'self',
            // no 'unsafe-inline') can be enforced — see tauri.conf.json.
            chatBody.addEventListener('click', (e) => {
                // Copy-code button inside code blocks
                const copyBtn = e.target.closest('.btn-copy-code');
                if (copyBtn) {
                    const codeEl = copyBtn.parentElement?.nextElementSibling;
                    const text = codeEl ? codeEl.innerText : '';
                    navigator.clipboard.writeText(text).then(() => {
                        copyBtn.innerText = 'Copied!';
                        setTimeout(() => { copyBtn.innerText = 'Copy'; }, 2000);
                    }).catch(() => {});
                    return;
                }
                // Zoomable image in a chat bubble → open full-size in a new window
                const img = e.target.closest('.chat-zoomable-img');
                if (img && img.src) {
                    const w = window.open();
                    if (w) {
                        const safeSrc = img.src.replace(/"/g, '&quot;');
                        w.document.write(`<img src="${safeSrc}" style="max-width:100%; height:auto;">`);
                    }
                    return;
                }
                // Result-file link → open with the OS default app (covers both the
                // live-rendered list and history-restored bubbles).
                const fileLink = e.target.closest('[data-open-path]');
                if (fileLink) {
                    e.preventDefault();
                    const path = fileLink.getAttribute('data-open-path');
                    if (path) {
                        invoke('open_path_default', { path }).catch(err => {
                            console.error('Failed to open path:', path, err);
                            fileLink.classList.add('rv-open-error');
                            fileLink.title = `Could not open: ${err}`;
                        });
                    }
                }
            });
            // Styles for the result-file list (used by completed agent turns).
            ensureResultViewStyles();
        }

        // Toggle System Prompt & Settings Panel
        if (promptToggle && promptPanel) {
            promptToggle.addEventListener('click', () => {
                this.settingsExpanded = !this.settingsExpanded;
                promptPanel.style.display = this.settingsExpanded ? 'block' : 'none';
            });
        }

        // Auto-growing Textarea + slash-command popup
        if (textarea) {
            textarea.addEventListener('input', () => {
                textarea.style.height = 'auto';
                textarea.style.height = (textarea.scrollHeight) + 'px';
                this._updateSlashPopup(textarea.value);
            });

            textarea.addEventListener('keydown', (e) => {
                const popup = document.getElementById('slash-popup');
                const popupVisible = popup && popup.style.display !== 'none';

                if (popupVisible) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        this._slashIndex = Math.min(this._slashIndex + 1, this._slashItems.length - 1);
                        this._renderSlashPopup();
                        return;
                    }
                    if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        this._slashIndex = Math.max(this._slashIndex - 1, 0);
                        this._renderSlashPopup();
                        return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const item = this._slashItems[this._slashIndex];
                        if (item) this._selectSlashItem(item, textarea);
                        return;
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        this._hideSlashPopup();
                        return;
                    }
                }

                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            // Paste image handler on textarea
            textarea.addEventListener('paste', (e) => {
                const items = e.clipboardData?.items;
                if (items) {
                    for (const item of items) {
                        if (item.type.indexOf('image') !== -1) {
                            const file = item.getAsFile();
                            this.handleFileAttachment(file);
                        }
                    }
                }
            });

            // Hide popup on blur
            textarea.addEventListener('blur', () => {
                setTimeout(() => this._hideSlashPopup(), 150);
            });
        }

        // File Attachment Button click
        const attachBtn = document.getElementById('btn-attach-file');
        const fileInput = document.getElementById('chat-file-input');
        if (attachBtn && fileInput) {
            attachBtn.addEventListener('click', () => {
                fileInput.click();
            });
            fileInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files) {
                    for (const file of files) {
                        this.handleFileAttachment(file);
                    }
                }
                fileInput.value = ''; // Reset file input
            });
        }

        // Tauri-native drag-drop (works with Windows Explorer file drops)
        this._registerDragDrop();

        // Model Select change listener
        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                this.selectedModel = e.target.value;
                llmService.setCurrentModel(this.selectedModel);
            });
        }

        // Workflow Select change listener
        if (workflowSelect) {
            workflowSelect.addEventListener('change', (e) => {
                this.selectedWorkflow = e.target.value;
                if (this.selectedWorkflow !== 'none') {
                    workflowManager.setPhase(this.selectedWorkflow);
                }
            });
        }

        // ChatView is simple-chat only: no workspace, no agent-mode toggle, no
        // tools-enable toggle. Web search + relevant MCP tools are always on.
        // Ensure any configured MCP servers are running so their tools can be
        // relevance-pruned into the chat.
        this._startEnabledMcpServers();

        // MCP checkbox event listeners
        const mcpCheckboxes = document.querySelectorAll('.chat-mcp-checkbox');
        mcpCheckboxes.forEach(cb => {
            cb.addEventListener('change', async (e) => {
                const name = cb.getAttribute('data-name');
                const config = this.allMcpServers[name];
                cb.disabled = true;
                try {
                    if (cb.checked) {
                        await mcpManager.startClient(name, config);
                    } else {
                        const client = mcpManager.clients.get(name);
                        if (client) {
                            await client.stop();
                            mcpManager.clients.delete(name);
                        }
                    }
                    this.reRender();
                } catch (err) {
                    console.error(`Failed to toggle MCP server ${name}:`, err);
                    cb.checked = !cb.checked;
                    alert(`Failed to toggle MCP server ${name}: ${err.message || err}`);
                } finally {
                    cb.disabled = false;
                }
            });
        });

        // MCP error badge → show full failure detail in an alert dialog
        document.querySelectorAll('.chat-mcp-error-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const name = badge.getAttribute('data-name');
                const err = mcpManager.getError(name);
                if (err) {
                    const when = err.at ? new Date(err.at).toLocaleString() : '';
                    alert(`MCP server "${name}" failed to start\nTime: ${when}\n\n${err.message}`);
                }
            });
        });

        // New Chat Button
        const newChatBtn = document.getElementById('btn-new-chat');
        if (newChatBtn) {
            newChatBtn.addEventListener('click', () => {
                this.startNewChat();
            });
        }

        // History Button
        const historyBtn = document.getElementById('btn-chat-history');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                this.showHistoryModal();
            });
        }

        // Clear Chat History (current conversation only)
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (!confirm('Clear the contents of the current chat?')) return;
                this.messages = [];
                // Reset the active session's messages + title and persist to BOTH
                // localStorage and the file backup so it can't be restored.
                const data = this.getSessions();
                if (data.activeSessionId && data.sessions[data.activeSessionId]) {
                    data.sessions[data.activeSessionId].messages = [];
                    data.sessions[data.activeSessionId].title = 'New Chat';
                    data.sessions[data.activeSessionId].timestamp = Date.now();
                    this.saveSessions(data);
                } else {
                    this.saveHistory();
                }
                // Immediate DOM clear (in case a later re-render is delayed/throws).
                const container = document.getElementById('chat-messages-container');
                if (container) container.innerHTML = '';
                this.reRender();
            });
        }

        // Send Button click listener
        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                if (this.isGenerating) {
                    this.abortMessage();
                } else {
                    this.sendMessage();
                }
            });
        }

        // Sync model changes if systemInput is modified
        if (systemInput) {
            systemInput.addEventListener('change', (e) => {
                this.systemPrompt = e.target.value.trim();
            });
        }

        // Render attachment previews
        this.renderAttachmentPreviews();
        this.renderSkillChips();

        // Auto-send a pending question routed from the global quick-search (Ctrl+Shift+Space).
        this._consumePendingQuestion();
    }

    async _consumePendingQuestion() {
        let pending = null;
        try { pending = localStorage.getItem('jh_pending_chat_question'); } catch (_) {}
        if (!pending) return;
        try { localStorage.removeItem('jh_pending_chat_question'); } catch (_) {}

        // Open a fresh session so the question stands alone.
        const data = this.getSessions();
        const newId = Date.now().toString();
        data.activeSessionId = newId;
        data.sessions[newId] = {
            id: newId,
            title: 'New Chat',
            timestamp: Date.now(),
            messages: [],
        };
        this.saveSessions(data);
        this.messages = [];

        // reRender re-runs init(); the localStorage key is already cleared so it won't loop.
        await this.reRender();

        const textarea = document.getElementById('chat-textarea-input');
        if (textarea) {
            textarea.value = pending;
            this.sendMessage();
        }
    }

    handleFileAttachment(file) {
        if (!file) return;
        
        // Max file size: 10MB
        if (file.size > 10 * 1024 * 1024) {
            alert('File is too large (max 10MB).');
            return;
        }

        const isImage = file.type.startsWith('image/');
        const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.ods');
        const reader = new FileReader();

        reader.onload = async (e) => {
            let dataUrl = null;
            let base64 = null;
            let content = null;

            if (isImage) {
                dataUrl = e.target.result;
                base64 = dataUrl.split(',')[1];
            } else if (isExcel) {
                const arrayBuffer = e.target.result;
                const bytes = new Uint8Array(arrayBuffer);
                const ext = file.name.split('.').pop() || '';
                try {
                    content = await invoke('parse_excel_to_html', {
                        bytes: Array.from(bytes),
                        ext: ext
                    });
                } catch (err) {
                    console.error('Failed to parse Excel file:', err);
                    alert(`Failed to parse Excel file: ${err.message || err}`);
                    return;
                }
            } else {
                content = reader.result;
            }

            const attachment = {
                id: Math.random().toString(36).substring(7),
                name: file.name,
                type: isExcel ? 'file' : (isImage ? 'image' : 'file'),
                size: file.size,
                dataUrl: dataUrl,
                base64: base64,
                content: content
            };

            this.attachments.push(attachment);
            this.renderAttachmentPreviews();
        };

        if (isImage) {
            reader.readAsDataURL(file);
        } else if (isExcel) {
            reader.readAsArrayBuffer(file);
        } else {
            // Read as text
            reader.readAsText(file);
        }
    }

    renderAttachmentPreviews() {
        const previewContainer = document.getElementById('chat-input-previews');
        if (!previewContainer) return;

        if (this.attachments.length === 0) {
            previewContainer.style.display = 'none';
            previewContainer.innerHTML = '';
            return;
        }

        previewContainer.style.display = 'flex';
        previewContainer.innerHTML = this.attachments.map(att => {
            if (att.type === 'image') {
                return `
                    <div class="chat-preview-item preview-image" data-id="${att.id}">
                        <img src="${att.dataUrl}" alt="${escapeHtml(att.name)}">
                        <span class="file-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
                        <button class="btn-remove-preview" title="Remove attachment">✕</button>
                    </div>
                `;
            } else {
                return `
                    <div class="chat-preview-item preview-file" data-id="${att.id}">
                        <span>📄</span>
                        <span class="file-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
                        <button class="btn-remove-preview" title="Remove attachment">✕</button>
                    </div>
                `;
            }
        }).join('');

        // Bind remove buttons
        previewContainer.querySelectorAll('.btn-remove-preview').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const item = btn.closest('.chat-preview-item');
                const id = item.getAttribute('data-id');
                this.attachments = this.attachments.filter(att => att.id !== id);
                this.renderAttachmentPreviews();
            });
        });
    }

    _registerDragDrop() {
        // Clean up any previous listener
        if (this._dragDropUnlisten) {
            this._dragDropUnlisten();
            this._dragDropUnlisten = null;
        }

        const wrapper = document.querySelector('.chat-input-area-wrapper');

        getCurrentWebviewWindow().onDragDropEvent((event) => {
            const type = event.payload.type;

            if (type === 'enter' || type === 'over') {
                if (wrapper) {
                    wrapper.style.borderColor = 'var(--accent)';
                    wrapper.style.boxShadow = '0 0 0 3px var(--accent-glow)';
                }
            } else if (type === 'drop') {
                if (wrapper) {
                    wrapper.style.borderColor = '';
                    wrapper.style.boxShadow = '';
                }
                const paths = event.payload.paths || [];
                for (const path of paths) {
                    this.handleFilePath(path);
                }
            } else {
                if (wrapper) {
                    wrapper.style.borderColor = '';
                    wrapper.style.boxShadow = '';
                }
            }
        }).then(unlisten => {
            this._dragDropUnlisten = unlisten;
        }).catch(e => {
            console.warn('Tauri drag-drop event registration failed:', e);
        });
    }

    async handleFilePath(path) {
        try {
            const fileData = await invoke('read_file_bytes', { path });
            const bytes = new Uint8Array(fileData.bytes);
            const ext = (fileData.ext || '').toLowerCase();
            const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
            const mime = mimeMap[ext] || 'application/octet-stream';
            const blob = new Blob([bytes], { type: mime });
            const file = new File([blob], fileData.name, { type: mime });
            this.handleFileAttachment(file);
        } catch (e) {
            console.error('Failed to read dropped file:', e);
            alert(`Failed to read file: ${e.message || e}`);
        }
    }

    destroy() {
        if (this._dragDropUnlisten) {
            this._dragDropUnlisten();
            this._dragDropUnlisten = null;
        }
    }

    /**
     * Start every configured MCP server that isn't already running, so its tools
     * become available to the chat (in BOTH Simple and Agent mode). Best-effort
     * and idempotent. Called when tools are enabled or when switching modes.
     */
    async _startEnabledMcpServers() {
        if (!this.allMcpServers || Object.keys(this.allMcpServers).length === 0) return;
        // Re-entry guard: this is called from init(), and the reRender() below
        // re-runs init() — without the guard that's an infinite loop.
        if (this._mcpStarting) return;
        this._mcpStarting = true;
        try {
            await mcpManager.loadConfig();
            const servers = mcpManager.serversConfig.mcpServers || {};
            let startedAny = false;
            for (const [name, config] of Object.entries(servers)) {
                if (!mcpManager.clients.has(name)) {
                    await mcpManager.startClient(name, config);
                    startedAny = true;
                }
            }
            // Refresh the MCP panel counts ONLY if we actually started something
            // (avoids a needless re-render every time the view mounts).
            if (startedAny) this.reRender();
        } catch (e) {
            console.warn('Failed to start MCP servers:', e);
        } finally {
            this._mcpStarting = false;
        }
    }

    async sendMessage() {
        const textarea = document.getElementById('chat-textarea-input');
        if (!textarea) return;
        const text = textarea.value.trim();
        if (!text && this.attachments.length === 0 && this.activeSkills.length === 0) return;
        if (this.isGenerating) return;

        // Clear input area
        textarea.value = '';
        textarea.style.height = 'auto';

        // Segregate attachments
        const attachedImages = this.attachments.filter(a => a.type === 'image');
        const fileAttachments = this.attachments.filter(a => a.type === 'file');

        // ── Inject active-skill bodies (auto-injection) ──────────────────
        // Skill files are loaded from disk and prepended to the message sent
        // to the AI, but NOT shown in the visible bubble (only a small badge).
        // This keeps the transcript readable while giving the model the full
        // skill instructions.
        const skillRefs = [...this.activeSkills];
        let skillPreamble = '';
        if (skillRefs.length > 0) {
            const bodies = [];
            for (const s of skillRefs) {
                try {
                    const body = await skillManager.readContent(s.name);
                    bodies.push(`# Skill: ${s.title} (/${s.name})\n${body}`);
                } catch (e) {
                    console.error(`Failed to load skill "${s.name}":`, e);
                    this._appendSystemMessage(`⚠️ Failed to load skill "${s.name}": ${e.message || e}`);
                }
            }
            if (bodies.length > 0) {
                skillPreamble = bodies.join('\n\n') + '\n\n---\n\n';
            }
        }

        // Build processedText for API (with skill preamble + appended documents)
        let processedText = skillPreamble + text;
        if (fileAttachments.length > 0) {
            processedText += '\n\n';
            fileAttachments.forEach(file => {
                processedText += `[Attached File: ${file.name}]\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
            });
        }

        // Save user message in history. displayContent stays clean (no skill
        // body); the skills array drives the badge shown in the bubble.
        this.messages.push({
            role: 'user',
            content: processedText,
            displayContent: text,
            skills: skillRefs.map(s => ({ name: s.name, title: s.title })),
            images: attachedImages.map(img => img.dataUrl),
            files: fileAttachments.map(f => ({ name: f.name, size: f.size }))
        });

        // Clear attachments and active skills locally
        this.attachments = [];
        this.activeSkills = [];
        this.renderAttachmentPreviews();
        this.renderSkillChips();

        this.saveHistory();
        this._appendLastMessage();   // diff update — no full DOM rebuild

        // Messages container — used by the simple-mode generation loop below for
        // the thinking indicator and streamed reply bubble. (Was referenced but
        // never defined in this scope → "chatBody is not defined" in Simple mode.)
        const chatBody = document.getElementById('chat-messages-container');

        // Trigger AI Generation
        this.isGenerating = true;
        this.abortController = new AbortController();
        this.updateSendButtonState();

        const getApiMessages = () => {
            const apiMsgs = this.messages.map(m => {
                if (m.isToolCall) {
                    return { role: 'assistant', content: m.content };
                }
                if (m.isToolResult) {
                    return { role: 'user', content: m.content };
                }
                return { role: m.role, content: m.content };
            });
            // Slice to last 10 messages for cache efficiency and context limits
            const MAX_HISTORY_MESSAGES = 10;
            return apiMsgs.slice(-MAX_HISTORY_MESSAGES);
        };

        // ── Simple-chat tool set ─────────────────────────────────────────
        // ChatView has no workspace, so file/shell tools make no sense. Expose
        // only web search (fetch_url) from the built-ins, plus MCP tools that are
        // RELEVANT to this message (score threshold — sends none when nothing is
        // relevant, so casual chat costs no extra tokens). MCP servers were
        // started on mount; here we just scope + relevance-prune.
        await toolExecutor.startSession('.');
        toolExecutor.setToolAllowlist(['web_search', 'fetch_url']);  // + finish_task/present_result implicitly
        toolExecutor._mcpBypassesAllowlist = true;     // don't let the allowlist block MCP tools
        toolExecutor.setMcpRelevanceQuery(text);
        toolExecutor.setMcpPruneOptions({ minScore: 0.12, top: 5 });

        // Agent output language is config-driven (Settings → General → Agent Output
        // Language), shared with the AgentController path. Fetched once per send so
        // we don't read config on every tool-loop iteration. Defaults to Japanese.
        let outputLanguage = 'Japanese';
        try { outputLanguage = (await invoke('get_ai_config'))?.output_language || 'Japanese'; } catch (_) {}

        // Only the catch block (error / abort) pushes a message that the `finally`
        // must render. On the SUCCESS path the final answer is already on screen as
        // the streamed bubble, so re-appending it in `finally` duplicated the reply.
        let needsFinalAppend = false;
        try {
            let loopCount = 0;
            const maxLoops = 10;
            let keepRunning = true;
            // Images are sent only on the first iteration to avoid re-sending in tool loops
            const firstMessageImages = attachedImages.map(img => img.dataUrl);

            while (keepRunning && loopCount < maxLoops) {
                if (this.abortController?.signal?.aborted) {
                    break;
                }

                // Clear previous thinking indicator if any
                const prevIndicator = document.getElementById('chat-generating-indicator');
                if (prevIndicator) prevIndicator.remove();

                // Start timer & indicator
                let startTime = Date.now();
                let timerCleared = false;
                const timerInterval = setInterval(() => {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    const timerEl = document.getElementById('chat-thinking-timer');
                    if (timerEl) {
                        timerEl.innerText = `Thinking... (${elapsed}s)`;
                    }
                }, 100);

                const clearTimer = () => {
                    if (!timerCleared) {
                        clearInterval(timerInterval);
                        timerCleared = true;
                    }
                };

                if (chatBody) {
                      const indicator = document.createElement('div');
                      indicator.className = 'generating-indicator';
                      indicator.id = 'chat-generating-indicator';
                      indicator.innerHTML = `
                          <div style="display: flex; gap: 8px; flex-direction: column; align-items: flex-start;">
                              <div style="display: flex; gap: 6px; align-items: center;">
                                  <div class="generating-dot"></div>
                                  <div class="generating-dot"></div>
                                  <div class="generating-dot"></div>
                                  <span id="chat-thinking-timer">Thinking... (0.0s)</span>
                              </div>
                          </div>
                      `;
                      chatBody.appendChild(indicator);
                      chatBody.scrollTop = chatBody.scrollHeight;
                }

                // Build dynamic system prompt
                let dynamicSystemPrompt = this.systemPrompt;
                if (this.selectedWorkflow !== 'none') {
                    workflowManager.setPhase(this.selectedWorkflow);
                    dynamicSystemPrompt += `\n\n${workflowManager.getPromptContext()}`;
                }

                {
                    const toolDefs = toolExecutor.getToolsForNativeAPI().map(t => {
                        return `<tool name="${t.function.name}">
<description>${t.function.description}</description>
<parameters>${JSON.stringify(t.function.parameters)}</parameters>
</tool>`;
                    }).join('\n');

                    dynamicSystemPrompt += `

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

If no tool execution is needed, or if you have finished all tasks, you can reply normally in plain text.
Always write your thoughts and tool calls in the JSON structure if you use tools.
When you finish a task, call the \`finish_task\` tool.
Your final responses and messages to the user MUST be in ${outputLanguage}.
</instructions>
`;
                }

                const apiMessages = getApiMessages();
                let aiResponse = '';
                let aiBubbleRow = null;
                let aiContentEl = null;
                let streamRafPending = false;

                // Perf: re-rendering the WHOLE accumulated markdown on every chunk
                // is O(n²) over the response and forces a reflow per chunk. Batch
                // renders to at most one per animation frame instead.
                const renderStreamed = () => {
                    streamRafPending = false;
                    if (!aiContentEl) return;
                    const wasAtBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight <= 50;
                    // When the model is emitting a tool-call JSON block, don't render
                    // the raw JSON forming in the chat — show a compact "researching"
                    // placeholder instead. The compact tool indicator replaces this
                    // bubble once the call is parsed. A plain prose answer (the common
                    // case) renders as markdown as before.
                    const trimmed = aiResponse.trimStart();
                    const looksLikeToolCall = trimmed.startsWith('```json') || trimmed.startsWith('{"thought"') || trimmed.startsWith('{ "thought"');
                    aiContentEl.innerHTML = looksLikeToolCall
                        ? `<span style="font-size:12.5px;color:var(--text-secondary);">🔍 Using tools to research…</span>`
                        : formatMessageContent(aiResponse);
                    if (wasAtBottom) {
                        chatBody.scrollTop = chatBody.scrollHeight;
                    }
                };

                try {
                    const res = await llmService.chat(
                        apiMessages,
                        dynamicSystemPrompt,
                        (chunk) => {
                            clearTimer();

                            if (!aiBubbleRow && chatBody) {
                                const indicator = document.getElementById('chat-generating-indicator');
                                if (indicator) indicator.remove();

                                aiBubbleRow = document.createElement('div');
                                aiBubbleRow.className = 'chat-message-row msg-ai';
                                aiBubbleRow.innerHTML = `
                                    <div class="message-bubble">
                                        <div class="message-content"></div>
                                    </div>
                                `;
                                chatBody.appendChild(aiBubbleRow);
                                // Scope the lookup to THIS bubble — a global
                                // getElementById on a repeated id returned the
                                // bubble from a PREVIOUS tool-loop iteration.
                                aiContentEl = aiBubbleRow.querySelector('.message-content');
                            }

                            aiResponse += chunk;
                            if (aiContentEl && !streamRafPending) {
                                streamRafPending = true;
                                requestAnimationFrame(renderStreamed);
                            }
                        },
                        this.abortController.signal,
                        loopCount === 0 ? firstMessageImages : []
                    );

                    // Final flush — guarantees the last chunks are rendered even if
                    // no further animation frame fires (e.g. window minimized).
                    renderStreamed();

                    clearTimer();
                    const indicator = document.getElementById('chat-generating-indicator');
                    if (indicator) indicator.remove();

                    // Check for tool calls
                    const toolCall = this._extractToolCall(res.content);

                    if (toolCall && toolCall.tool_calls && toolCall.tool_calls.length > 0) {
                        loopCount++;

                        // Drop the streamed bubble (it only held the "researching…"
                        // placeholder / raw JSON) — the compact tool indicator pushed
                        // below replaces it, so the chat stays clean.
                        if (aiBubbleRow) { aiBubbleRow.remove(); aiBubbleRow = null; aiContentEl = null; }

                        // Push tool call message to history
                        this.messages.push({
                            role: 'assistant',
                            content: res.content,
                            isToolCall: true,
                            toolCalls: toolCall.tool_calls
                        });
                        this.saveHistory();
                        this._appendLastMessage();

                        // Execute tools
                        const results = [];
                        
                        const statusCallback = (statusMsg) => {
                            const statusEl = document.getElementById('chat-thinking-timer');
                            if (statusEl) {
                                statusEl.innerText = statusMsg;
                            }
                        };

                        const confirmCallback = async (req) => {
                            if (req.type === 'command_confirm') {
                                return confirm(`AI wants to run this command:\n\n${req.command}\n\nDo you approve?`);
                            } else if (req.type === 'diff_review') {
                                return confirm(`AI wants to modify/write file outside workspace:\n\n${req.path}\n\nDo you approve?`);
                            }
                            return true;
                          };

                          for (const call of toolCall.tool_calls) {
                              const result = await toolExecutor.executeTool(call, statusCallback, confirmCallback);
                              results.push({ tool_call_name: call.name, result });
                          }

                          // Push results message to history
                          const resultsText = `Tool Execution Results:\n${JSON.stringify(results, null, 2)}`;
                          this.messages.push({
                              role: 'user',
                              content: resultsText,
                              isToolResult: true,
                              results: results
                          });
                          this.saveHistory();
                          this._appendLastMessage();

                          // If finish_task was called, we should stop the loop
                          if (toolCall.tool_calls.some(c => c.name === 'finish_task')) {
                              keepRunning = false;
                          }
                      } else {
                          // Plain text response, end loop
                          this.messages.push({ role: 'assistant', content: res.content });
                          this.saveHistory();
                          keepRunning = false;
                      }

                  } catch (e) {
                      clearTimer();
                      const indicator = document.getElementById('chat-generating-indicator');
                      if (indicator) indicator.remove();
                      throw e;
                  }
              }
          } catch (e) {
              console.error('Chat loop error:', e);
              const indicator = document.getElementById('chat-generating-indicator');
              if (indicator) indicator.remove();

              if (e.name === 'AbortError' || e.message?.includes('aborted') || e.message?.includes('cancelled')) {
                  const lastMsg = this.messages[this.messages.length - 1];
                  if (lastMsg && lastMsg.role === 'user' && lastMsg.content.startsWith('Tool Execution Results:')) {
                      this.messages.push({ role: 'assistant', content: '*(Tool execution loop stopped by user)*' });
                  } else {
                      this.messages.push({ role: 'assistant', content: '*(Generation stopped by user)*' });
                  }
                  this.saveHistory();
              } else {
                  this.messages.push({
                      role: 'assistant',
                      content: `Failed to generate reply: ${e.message || e}`,
                      isError: true
                  });
                  this.saveHistory();
              }
              needsFinalAppend = true;  // the message just pushed isn't on screen yet
          } finally {
              toolExecutor.endSession();
              this.isGenerating = false;
              this.abortController = null;
              this.updateSendButtonState();
              // Render the error/abort message pushed in the catch block. On the
              // success path the answer is already shown (streamed bubble), so we
              // must NOT append again — that caused the duplicated reply.
              if (needsFinalAppend) this._appendLastMessage();
          }
      }

    // ── Slash command popup helpers ─────────────────────────────────────────

    _updateSlashPopup(value) {
        const popup = document.getElementById('slash-popup');
        if (!popup) return;

        // Show popup when the entire input starts with "/"
        if (!value.startsWith('/')) {
            this._hideSlashPopup();
            return;
        }

        const query = value.slice(1); // text after the leading "/"
        this._slashQuery = query;

        const templates = promptTemplateManager.search(query).map(t => ({
            type: 'template',
            key: t.key,
            label: t.label,
            icon: t.icon || '📝',
            prompt: t.prompt,
        }));

        const skills = skillManager.search(query).map(s => ({
            type: 'skill',
            key: s.name,
            label: s.title,
            icon: '⚡',
        }));

        this._slashItems = [...templates, ...skills];
        this._slashIndex = 0;
        this._renderSlashPopup();
    }

    _renderSlashPopup() {
        const popup = document.getElementById('slash-popup');
        if (!popup) return;

        if (this._slashItems.length === 0) {
            popup.style.display = 'block';
            popup.innerHTML = `
                <div class="slash-popup-header">Commands</div>
                <div class="slash-popup-empty">No matching template or skill</div>
            `;
            return;
        }

        const itemsHtml = this._slashItems.map((item, idx) => {
            const typeLabel = item.type === 'template' ? 'template' : 'skill';
            return `
                <div class="slash-popup-item${idx === this._slashIndex ? ' selected' : ''}" data-idx="${idx}">
                    <span class="slash-popup-icon">${item.icon}</span>
                    <span class="slash-popup-key">/${escapeHtml(item.key)}</span>
                    <span class="slash-popup-label">${escapeHtml(item.label)}</span>
                    <span class="slash-popup-type">${typeLabel}</span>
                </div>
            `;
        }).join('');

        popup.style.display = 'flex';
        popup.innerHTML = `
            <div class="slash-popup-header">Commands — ↑↓ select, Enter confirm, Esc close</div>
            <div class="slash-popup-list">${itemsHtml}</div>
        `;

        // Bind click handlers
        popup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent blur on textarea
                const idx = parseInt(el.getAttribute('data-idx'), 10);
                const item = this._slashItems[idx];
                const textarea = document.getElementById('chat-textarea-input');
                if (item && textarea) this._selectSlashItem(item, textarea);
            });
        });

        // Scroll selected item into view
        const selected = popup.querySelector('.slash-popup-item.selected');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    }

    async _selectSlashItem(item, textarea) {
        this._hideSlashPopup();

        if (item.type === 'template') {
            // Expand the template prompt in-place
            textarea.value = item.prompt;
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
            textarea.focus();
        } else if (item.type === 'skill') {
            // Attach the skill as a chip instead of dumping its body into the
            // input. The "/key" token is stripped from the textarea; any text
            // the user typed after "/key " is preserved as their message. The
            // skill body is injected at send time (see sendMessage).
            const currentValue = textarea.value;
            const afterSlash = currentValue.slice(1);
            const spaceIdx = afterSlash.indexOf(' ');
            const remainder = spaceIdx >= 0 ? afterSlash.slice(spaceIdx + 1) : '';

            // Avoid duplicates — re-selecting an active skill is a no-op.
            if (!this.activeSkills.some(s => s.name === item.key)) {
                this.activeSkills.push({ name: item.key, title: item.label || item.key });
            }
            this.renderSkillChips();

            textarea.value = remainder;
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
            textarea.focus();
        }
    }

    /** Render the active-skill chips above the input box. */
    renderSkillChips() {
        const container = document.getElementById('chat-input-skills');
        if (!container) return;

        if (this.activeSkills.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = 'flex';
        container.innerHTML = this.activeSkills.map(s => `
            <span class="skill-chip" data-name="${escapeHtml(s.name)}" title="Skill: ${escapeHtml(s.name)}">
                <span class="skill-chip-icon">⚡</span>
                <span class="skill-chip-label">${escapeHtml(s.title)}</span>
                <button class="skill-chip-remove" title="Remove skill">✕</button>
            </span>
        `).join('');

        container.querySelectorAll('.skill-chip-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.closest('.skill-chip').getAttribute('data-name');
                this.activeSkills = this.activeSkills.filter(s => s.name !== name);
                this.renderSkillChips();
            });
        });
    }

    _hideSlashPopup() {
        const popup = document.getElementById('slash-popup');
        if (popup) popup.style.display = 'none';
        this._slashItems = [];
        this._slashIndex = 0;
    }

    // ── End slash popup helpers ─────────────────────────────────────────────

    _extractToolCall(response) {
        return extractToolCall(response);
    }

    abortMessage() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }




    updateSendButtonState() {
        const sendBtn = document.getElementById('btn-send-message');
        if (sendBtn) {
            if (this.isGenerating) {
                sendBtn.classList.add('btn-stop');
                sendBtn.innerHTML = '🛑';
            } else {
                sendBtn.classList.remove('btn-stop');
                sendBtn.innerHTML = '➡️';
            }
        }
    }

    saveHistory() {
        try {
            const data = this.getSessions();
            if (data.activeSessionId && data.sessions[data.activeSessionId]) {
                const session = data.sessions[data.activeSessionId];
                session.messages = this.messages;
                session.timestamp = Date.now();
                // Persist UI settings so they survive navigation and app restart
                session.workspacePath = this.workspacePath;
                session.toolsEnabled = this.toolsEnabled;
                session.systemPrompt = this.systemPrompt;

                // Set session title dynamically
                if (this.messages.length > 0 && (session.title === 'New Chat' || session.title === '新しいチャット')) {
                    const firstUserMsg = this.messages.find(m => m.role === 'user');
                    if (firstUserMsg) {
                        const content = firstUserMsg.displayContent || firstUserMsg.content;
                        session.title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
                    }
                }
                this.saveSessions(data);
            }
        } catch (e) {
            console.error('Failed to save history:', e);
        }
    }

    // ─── Message rendering helpers ──────────────────────────────────────────

    /**
     * Render a single chat message to an HTML string.
     * Extracted from render() so it can be reused by _appendLastMessage()
     * without triggering a full DOM replacement.
     */
    _renderMessageHtml(msg, index) {
        return renderMessageHtml(msg);
    }

    /**
     * Append the last message in this.messages to the DOM without a full reRender.
     * This is the hot path — called after every message push during generation.
     */
    _appendLastMessage() {
        const container = document.getElementById('chat-messages-container');
        if (!container) return;

        // Remove empty state placeholder if present
        const emptyState = container.querySelector('.chat-empty-state');
        if (emptyState) emptyState.parentElement?.removeChild(emptyState);

        const msg = this.messages[this.messages.length - 1];
        if (!msg) return;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = this._renderMessageHtml(msg, this.messages.length - 1).trim();
        const node = wrapper.firstElementChild;
        if (node) {
            container.appendChild(node);
            node.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    }

    /**
     * Append a transient system notice to the chat (not persisted to this.messages).
     * Used for validation errors, warnings, and one-off status messages.
     */
    _appendSystemMessage(text) {
        const container = document.getElementById('chat-messages-container');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'chat-message-row msg-ai';
        div.innerHTML = `
            <div class="message-bubble" style="border-color: var(--warning, #f59e0b); background: hsla(38,92%,50%,0.07); max-width: 90%;">
                <div class="message-content" style="color: var(--warning, #f59e0b); font-size: 13px;">${escapeHtml(text)}</div>
            </div>
        `;
        container.appendChild(div);
        div.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    // ─── Full reRender (structural changes only) ────────────────────────────

    async reRender() {
        const container = document.querySelector('.main-content');
        if (container) {
            // Preserve scroll position
            const chatBody = document.getElementById('chat-messages-container');
            const wasAtBottom = !chatBody || (chatBody.scrollHeight - chatBody.scrollTop <= chatBody.clientHeight + 30);

            const html = await this.render();
            container.innerHTML = html;
            this.init();

            const newChatBody = document.getElementById('chat-messages-container');
            if (newChatBody && wasAtBottom) {
                newChatBody.scrollTop = newChatBody.scrollHeight;
            }
        }
    }

    getSessions() {
        return parseSessions(localStorage.getItem(CHAT_SESSIONS_KEY));
    }

    saveSessions(data) {
        // Cap to the most-recent N sessions (pure logic → chat/chatSessions.js).
        pruneSessions(data);

        // Primary: localStorage (synchronous, always available)
        localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(data));

        // Secondary: file-based backup (async, non-blocking).
        // Provides persistence across localStorage clears and larger storage.
        this._saveSessionsToFile(data).catch(e =>
            console.warn('[ChatSessions] File backup failed (non-critical):', e)
        );
    }

    /**
     * Write sessions to <app_config_dir>/chat_sessions.json as a durable backup.
     * Called fire-and-forget from saveSessions().
     */
    async _saveSessionsToFile(data) {
        try {
            const configDir = await invoke('get_app_config_dir');
            if (!configDir) return;
            await invoke('write_file', {
                path: `${configDir}/chat_sessions.json`,
                content: JSON.stringify(data, null, 2)
            });
        } catch (e) {
            throw e; // re-throw so the caller's .catch() can log it
        }
    }

    /**
     * Attempt to restore sessions from the file backup.
     * Called once from loadChatConfig() to migrate/restore data that
     * may not be in localStorage (e.g. after a clear or on first install).
     */
    async _restoreSessionsFromFile() {
        try {
            const configDir = await invoke('get_app_config_dir');
            if (!configDir) return;
            const raw = await invoke('read_file', { path: `${configDir}/chat_sessions.json` });
            if (!raw) return;
            const fileData = JSON.parse(raw);
            // Only restore if file has more sessions than localStorage
            const lsData = this.getSessions();
            const lsCount = Object.keys(lsData.sessions || {}).length;
            const fileCount = Object.keys(fileData.sessions || {}).length;
            if (fileCount > lsCount) {
                localStorage.setItem('direct_ai_sessions', JSON.stringify(fileData));
                this.loadHistory();
                console.log(`[ChatSessions] Restored ${fileCount} sessions from file backup.`);
            }
        } catch (_) { /* file may not exist yet — ignore */ }
    }

    startNewChat() {
        const data = this.getSessions();
        const newId = Date.now().toString();
        data.activeSessionId = newId;
        data.sessions[newId] = {
            id: newId,
            title: 'New Chat',
            timestamp: Date.now(),
            messages: [],
            // Carry over current settings to the new session
            workspacePath: this.workspacePath,
            toolsEnabled: this.toolsEnabled,
            systemPrompt: this.systemPrompt,
        };
        this.saveSessions(data);
        this.messages = [];
        this.reRender();
    }

    loadHistory() {
        try {
            const data = this.getSessions();
            if (!data.activeSessionId || !data.sessions[data.activeSessionId]) {
                const newId = Date.now().toString();
                data.activeSessionId = newId;
                data.sessions[newId] = {
                    id: newId,
                    title: 'New Chat',
                    timestamp: Date.now(),
                    messages: []
                };
                this.saveSessions(data);
            }
            // Ensure a default session exists
            if (!data.sessions[data.activeSessionId]) {
                data.sessions[data.activeSessionId] = {
                    id: data.activeSessionId,
                    title: 'New Chat',
                    timestamp: Date.now(),
                    messages: []
                };
                this.saveSessions(data);
            }
            const activeSession = data.sessions[data.activeSessionId];
            this.messages = activeSession ? (activeSession.messages || []) : [];
            // Restore settings saved with this session
            if (activeSession) {
                if (activeSession.workspacePath) this.workspacePath = activeSession.workspacePath;
                if (activeSession.toolsEnabled !== undefined) this.toolsEnabled = activeSession.toolsEnabled;
                if (activeSession.systemPrompt) this.systemPrompt = activeSession.systemPrompt;
            }
        } catch (e) {
            console.error('Failed to load history:', e);
            this.messages = [];
        }
    }

    /**
     * Delete one session from the store (localStorage + file backup).
     * If it was the active session, re-point at the newest survivor, or create
     * a fresh empty session when none remain.
     */
    _deleteSession(sessionId) {
        const data = this.getSessions();
        delete data.sessions[sessionId];
        if (data.activeSessionId === sessionId) {
            const remaining = Object.values(data.sessions).sort((a, b) => b.timestamp - a.timestamp);
            data.activeSessionId = remaining[0]?.id || null;
        }
        if (!data.activeSessionId) {
            const newId = Date.now().toString();
            data.activeSessionId = newId;
            data.sessions[newId] = { id: newId, title: 'New Chat', timestamp: Date.now(), messages: [] };
        }
        this.saveSessions(data);
        this.loadHistory();
    }

    /** Wipe ALL sessions (localStorage + file backup) and start a fresh one. */
    _clearAllSessions() {
        const newId = Date.now().toString();
        const data = {
            activeSessionId: newId,
            sessions: {
                [newId]: { id: newId, title: 'New Chat', timestamp: Date.now(), messages: [] }
            }
        };
        this.saveSessions(data);
        this.loadHistory();
    }

    showHistoryModal() {
        const data = this.getSessions();
        const sessions = Object.values(data.sessions).sort((a, b) => b.timestamp - a.timestamp);
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 3000;
            display: flex; justify-content: center; align-items: center;
        `;
        
        const content = document.createElement('div');
        content.style.cssText = `
            background: var(--bg-secondary); border: 1px solid var(--border);
            border-radius: 8px; width: 400px; max-height: 80vh;
            display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            color: var(--text-primary);
        `;
        
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 12px 16px; border-bottom: 1px solid var(--border);
            display: flex; justify-content: space-between; align-items: center;
            background: var(--bg-tertiary); font-weight: bold;
        `;
        header.innerHTML = `
            <span>Chat History</span>
            <div style="display:flex; align-items:center; gap:10px;">
                <button class="clear-all-btn" title="Delete all history"
                    style="background:none; border:1px solid var(--error, #c0392b); color:var(--error, #c0392b); cursor:pointer; font-size:11px; border-radius:4px; padding:3px 8px; font-weight:600;">🗑 Clear All</button>
                <button class="close-btn" style="background:none; border:none; color:var(--text-primary); cursor:pointer; font-size: 16px;">✖</button>
            </div>
        `;

        const body = document.createElement('div');
        body.style.cssText = 'padding: 10px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px;';

        if (sessions.length === 0) {
            body.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:20px;">No history found.</div>';
        } else {
            sessions.forEach(s => {
                const item = document.createElement('div');
                const isActive = s.id === data.activeSessionId;
                item.style.cssText = `
                    padding: 10px; border-radius: 6px; cursor: pointer;
                    background: ${isActive ? 'var(--accent)' : 'var(--bg-tertiary)'};
                    color: ${isActive ? 'var(--text-inverse)' : 'var(--text-primary)'};
                    display: flex; justify-content: space-between; align-items: center;
                    border: 1px solid var(--border);
                `;
                item.innerHTML = `
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; font-size:13px;">${escapeHtml(s.title)}</div>
                    <div style="font-size:11px; opacity:0.7; margin-left:10px;">${new Date(s.timestamp).toLocaleDateString()}</div>
                    <button class="session-delete-btn" title="Delete this chat"
                        style="background:none; border:none; cursor:pointer; font-size:13px; margin-left:8px; opacity:0.6; color:inherit;">🗑</button>
                `;
                item.onclick = () => {
                    data.activeSessionId = s.id;
                    this.saveSessions(data);
                    this.loadHistory();
                    this.reRender();
                    document.body.removeChild(overlay);
                };
                item.querySelector('.session-delete-btn').onclick = (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete the chat "${s.title}"?`)) return;
                    this._deleteSession(s.id);
                    document.body.removeChild(overlay);
                    this.reRender();
                    this.showHistoryModal();
                };
                body.appendChild(item);
            });
        }

        header.querySelector('.clear-all-btn').onclick = () => {
            if (!confirm('Delete all chat history? This cannot be undone.')) return;
            this._clearAllSessions();
            document.body.removeChild(overlay);
            this.reRender();
        };
        header.querySelector('.close-btn').onclick = () => document.body.removeChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
        
        content.appendChild(header);
        content.appendChild(body);
        overlay.appendChild(content);
        document.body.appendChild(overlay);
    }
}
