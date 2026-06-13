import llmService from '../../modules/ai/LLMService.js';
import { ToolExecutor } from '../../modules/ai/ToolExecutor.js';
import { mcpManager } from '../../modules/ai/McpManager.js';
import { workflowManager } from '../../modules/ai/WorkflowManager.js';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';
import { AGENT_MODES, DEFAULT_MODE_ID, buildBehavior } from '../../modules/ai/AgentModes.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { renderFileList, filesFromModified, ensureResultViewStyles } from '../utils/resultView.js';
import { escapeHtml, formatMessageContent, formatMarkdown, renderTableHtml } from './chat/chatMarkdown.js';
import { STORAGE_KEY as CHAT_SESSIONS_KEY, parseSessions, pruneSessions } from './chat/chatSessions.js';
import { extractToolCall, parseThought, renderAgentSteps, renderMessageHtml, renderResultStatsChips } from './chat/chatRenderer.js';

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

        // ── Behavior mode for the new unified flow ──────────────────
        // 'simple'  → direct llmService.chat call with this.systemPrompt
        //             (existing fast path; no agent loop, no tools, no retries)
        // 'agent'   → goes through TaskBridge with mode=iterative_agent so the
        //             user gets the full ContextBuilder safety rules, verify,
        //             anti-loop, task_progress, retries, etc. — the same as
        //             external apps like JHEditor see.
        this.chatMode = 'simple';
        this.agentModeId = DEFAULT_MODE_ID; // agent execution mode
        this._activeAgentWs = null;   // active WebSocket for in-flight agent task
        this._activeAgentTaskId = null;

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
                        style="font-size: 10px; background: var(--error, #c0392b); color: #fff; border-radius: 4px; padding: 1px 6px; font-weight: 600; cursor: pointer;">⚠ 起動失敗 (詳細)</span>`;
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
                    <h3>会話を始めましょう</h3>
                    <p>選択したAIモデルに質問したり、コードを書いたり、アイデアを探索したりできます。</p>
                </div>
            `
            : this.messages.map((msg, index) => this._renderMessageHtml(msg, index)).join('');

        const headerTitle = this.chatMode === 'agent' ? 'Agent Chat' : 'Direct Chat';
        const headerSubtitle = this.chatMode === 'agent'
            ? 'Full agent loop — ContextBuilder safety rules, tools, anti-loop, retries'
            : 'Direct LLM call with your system prompt (fast, no agent loop)';

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
                            <!-- Mode toggle: always visible in header -->
                            <div class="chat-mode-pills">
                                <button class="chat-mode-pill ${this.chatMode === 'simple' ? 'active' : ''}" data-mode="simple">⚡ Simple</button>
                                <button class="chat-mode-pill ${this.chatMode === 'agent' ? 'active' : ''}" data-mode="agent">🤖 Agent</button>
                            </div>
                            <select id="chat-model-select" class="select chat-models-select">
                                ${modelOptions}
                            </select>
                            <button id="btn-new-chat" class="btn btn-primary btn-sm">📝 New Chat</button>
                            <button id="btn-chat-history" class="btn btn-secondary btn-sm">🕒 History</button>
                            <button id="btn-clear-chat" class="btn btn-secondary btn-sm">🗑️ Clear Chat</button>
                        </div>
                    </div>

                    <!-- Agent workspace bar: visible directly below header in agent mode -->
                    ${this.chatMode === 'agent' ? `
                    <div class="agent-workspace-bar">
                        <label>📁 Workspace:</label>
                        <input type="text" id="chat-workspace-inline" class="input" value="${escapeHtml(this.workspacePath || '')}"
                            placeholder="ワークスペースパス (例: C:\\projects\\myapp)" style="flex: 1; height: 28px; font-size: 12px; padding: 0 8px;">
                        <button id="btn-workspace-select-inline" class="btn btn-secondary" style="height: 28px; padding: 0 10px; font-size: 12px;" type="button">📁 参照</button>
                        <select id="chat-agent-mode-select" style="height:28px;font-size:12px;padding:0 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);cursor:pointer;outline:none;">
                            ${Object.values(AGENT_MODES).map(m =>
                                `<option value="${m.id}" ${this.agentModeId === m.id ? 'selected' : ''}>${m.label}</option>`
                            ).join('')}
                        </select>
                        <span id="agent-mode-desc" style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">${AGENT_MODES[this.agentModeId]?.description || ''}</span>
                    </div>
                    ` : ''}

                    <!-- System Prompt & Chat Settings Collapsible -->
                    <div class="chat-system-prompt-container">
                        <div class="chat-system-prompt-toggle" id="prompt-toggle-btn">
                            <span>⚙️</span> Chat Settings & Tools
                        </div>
                        <div class="chat-system-prompt-panel" id="prompt-panel" style="display: ${this.settingsExpanded ? 'block' : 'none'};">
                            <div class="provider-card-fields" style="display: flex; flex-direction: column; gap: 12px;">
                                <div class="input-group">
                                    <label class="input-label" style="font-size: 11px; margin-bottom: 4px;">System Prompt <span style="opacity:0.6">(Simple mode のみ使用。Agentモードは内部 ContextBuilder プロンプトを使用)</span></label>
                                    <input type="text" id="chat-system-input" class="input" value="${escapeHtml(this.systemPrompt)}" placeholder="e.g. You are a helpful AI assistant.">
                                </div>
                                <div class="input-group">
                                    <label class="input-label" style="font-size: 11px; margin-bottom: 4px;">Workspace Directory</label>
                                    <div style="display: flex; gap: 8px;">
                                        <input type="text" id="chat-workspace-input" class="input" value="${escapeHtml(this.workspacePath || '')}" placeholder="C:\\path\\to\\workspace" style="flex: 1; height: 36px;">
                                        <button class="btn btn-secondary" id="btn-select-workspace" style="padding: 0 12px; display: flex; align-items: center; justify-content: center; height: 36px; border: 1px solid var(--border);" type="button">📁 Select</button>
                                    </div>
                                </div>
                                <div class="input-group">
                                    <div class="toggle-wrap" id="chat-tools-enabled-wrap">
                                        <div class="toggle ${this.toolsEnabled ? 'active' : ''}" id="chat-tools-enabled-toggle"></div>
                                        <span class="toggle-label" style="font-size: 12px; font-weight: 500;">Enable Tool Execution (Simple / Agent 両対応)</span>
                                    </div>
                                </div>
                                <div class="input-group" style="border-top: 1px solid var(--border-light); padding-top: 12px;">
                                    <label class="input-label" style="font-size: 11px; margin-bottom: 6px; display: block; font-weight: 600;">🔌 Enabled MCP Servers</label>
                                    <div style="display: flex; flex-wrap: wrap; gap: 16px;">
                                        ${mcpServersHtml}
                                    </div>
                                </div>
                                <div class="input-group" style="border-top: 1px solid var(--border-light); padding-top: 12px;">
                                    <details style="outline: none;" ${this.toolsEnabled ? 'open' : ''}>
                                        <summary style="font-size: 12px; font-weight: 600; cursor: pointer; color: var(--text-secondary); user-select: none;">🛠️ Available Tools (${activeTools.length})</summary>
                                        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-top: 8px; max-height: 180px; overflow-y: auto; padding-right: 4px;">
                                            ${toolsListHtml}
                                        </div>
                                    </details>
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
                            fileLink.title = `開けませんでした: ${err}`;
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

        // Workspace Input change listener
        if (workspaceInput) {
            workspaceInput.addEventListener('change', (e) => {
                this.workspacePath = e.target.value.trim();
            });
        }

        // Workspace Folder dialog button click
        if (btnSelectWorkspace) {
            btnSelectWorkspace.addEventListener('click', async () => {
                try {
                    const selected = await invoke('select_folder');
                    if (selected) {
                        if (workspaceInput) workspaceInput.value = selected;
                        this.workspacePath = selected;
                    }
                } catch (e) {
                    console.error('Failed to select workspace folder:', e);
                }
            });
        }

        // Agent Mode toggle click
        if (toolsToggle && toolsWrap) {
            toolsWrap.addEventListener('click', () => {
                this.toolsEnabled = !this.toolsEnabled;
                toolsToggle.classList.toggle('active', this.toolsEnabled);
                this.reRender();
                // Tools work in Simple mode too — make sure MCP servers are up.
                if (this.toolsEnabled) this._startEnabledMcpServers();
            });
        }

        // Chat Mode pills in header (Simple / Agent)
        document.querySelectorAll('.chat-mode-pill').forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.getAttribute('data-mode');
                if (!mode || mode === this.chatMode) return;
                this.chatMode = mode;
                if (mode === 'agent') {
                    // Agent mode always runs with tools.
                    this.toolsEnabled = true;
                    this.reRender();
                    this._startEnabledMcpServers();
                } else {
                    // Simple mode: KEEP the user's current tool setting (tools/MCP
                    // such as Backlog are usable in Simple mode too — was previously
                    // force-disabled here). Start MCP servers if tools are on.
                    this.reRender();
                    if (this.toolsEnabled) this._startEnabledMcpServers();
                }
            });
        });

        // Inline workspace selector (shown in agent mode bar)
        const inlineWorkspaceInput = document.getElementById('chat-workspace-inline');
        if (inlineWorkspaceInput) {
            inlineWorkspaceInput.addEventListener('change', (e) => {
                this.workspacePath = e.target.value.trim();
                const settingsInput = document.getElementById('chat-workspace-input');
                if (settingsInput) settingsInput.value = this.workspacePath;
            });
        }
        const btnWorkspaceInline = document.getElementById('btn-workspace-select-inline');
        if (btnWorkspaceInline) {
            btnWorkspaceInline.addEventListener('click', async () => {
                try {
                    const selected = await invoke('select_folder');
                    if (selected) {
                        this.workspacePath = selected;
                        if (inlineWorkspaceInput) inlineWorkspaceInput.value = selected;
                        const settingsInput = document.getElementById('chat-workspace-input');
                        if (settingsInput) settingsInput.value = selected;
                    }
                } catch (e) {
                    console.error('Failed to select workspace folder:', e);
                }
            });
        }

        // Agent mode selector (agent workspace bar)
        const agentModeSelect = document.getElementById('chat-agent-mode-select');
        if (agentModeSelect) {
            agentModeSelect.addEventListener('change', (e) => {
                this.agentModeId = e.target.value;
                const descEl = document.getElementById('agent-mode-desc');
                if (descEl) descEl.textContent = AGENT_MODES[this.agentModeId]?.description || '';
            });
        }

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
                    alert(`MCP サーバー "${name}" 起動失敗\n発生時刻: ${when}\n\n${err.message}`);
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
                if (!confirm('現在のチャットの内容を削除しますか？')) return;
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

        // Force Direct Chat (simple) mode and open a fresh session so the question stands alone.
        this.chatMode = 'simple';
        const data = this.getSessions();
        const newId = Date.now().toString();
        data.activeSessionId = newId;
        data.sessions[newId] = {
            id: newId,
            title: '新しいチャット',
            timestamp: Date.now(),
            messages: [],
            chatMode: 'simple',
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
        try {
            await mcpManager.loadConfig();
            const servers = mcpManager.serversConfig.mcpServers || {};
            for (const [name, config] of Object.entries(servers)) {
                if (!mcpManager.clients.has(name)) {
                    await mcpManager.startClient(name, config);
                }
            }
            // Refresh the tools/MCP panel counts now that servers are up.
            this.reRender();
        } catch (e) {
            console.warn('Failed to start MCP servers:', e);
        }
    }

    async sendMessage() {
        const textarea = document.getElementById('chat-textarea-input');
        if (!textarea) return;
        const text = textarea.value.trim();
        if (!text && this.attachments.length === 0 && this.activeSkills.length === 0) return;
        if (this.isGenerating) return;

        // Guard: Agent mode requires a workspace path
        if (this.chatMode === 'agent' && !this.workspacePath?.trim()) {
            this._appendSystemMessage('⚠️ Agentモードではワークスペースの設定が必要です。「Workspace Directory」にプロジェクトのパスを入力してください。');
            return;
        }

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
                    this._appendSystemMessage(`⚠️ スキル「${s.name}」の読み込みに失敗しました: ${e.message || e}`);
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

        // ── Branch: Agent mode goes through TaskBridge for the full safety stack ──
        // This is the same code path JHEditor uses when calling the JH AI Agent
        // REST API. Direct Chat in Agent mode inherits all the improvements
        // (anti-loop detection, verify_syntax, task_progress, retries, ...).
        if (this.chatMode === 'agent') {
            try {
                await this._sendViaAgent(processedText, attachedImages.map(img => img.dataUrl));
            } catch (e) {
                console.error('Agent send failed:', e);
            } finally {
                this.isGenerating = false;
                this.updateSendButtonState();
            }
            return;
        }

        if (this.toolsEnabled) {
            await toolExecutor.startSession(this.workspacePath);
        }

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

                if (this.toolsEnabled) {
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
Your final responses and messages to the user MUST be in Japanese.
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
                    aiContentEl.innerHTML = formatMessageContent(aiResponse);
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
                    const toolCall = this.toolsEnabled ? this._extractToolCall(res.content) : null;

                    if (toolCall && toolCall.tool_calls && toolCall.tool_calls.length > 0) {
                        loopCount++;
                        
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
                            } else if (req.type === 'plan_review') {
                                return confirm(`AI proposed this plan:\n\n${req.message}\n\nDo you approve?`);
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
          } finally {
              if (this.toolsEnabled) {
                  toolExecutor.endSession();
              }
              this.isGenerating = false;
              this.abortController = null;
              this.updateSendButtonState();
              // Append any final/error message that was pushed in the catch block
              this._appendLastMessage();
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
                <div class="slash-popup-header">コマンド / Commands</div>
                <div class="slash-popup-empty">一致するテンプレート・スキルがありません</div>
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
            <div class="slash-popup-header">コマンド / Commands — ↑↓ 選択、Enter 確定、Esc 閉じる</div>
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

    /**
     * Agent-mode send: creates a task on the JH AI Agent server and streams
     * progress into the chat bubble with a structured step-by-step display.
     *
     * Each agent iteration is rendered as a collapsible step showing:
     *   • The full thought text (not truncated)
     *   • Tool calls executed within that step
     * The final LLM response is shown below the steps when streaming completes.
     *
     * Conversation history (chatContext) is forwarded so the agent has full
     * context from previous messages in this session.
     */
    async _sendViaAgent(promptText, images = []) {
        const chatBody = document.getElementById('chat-messages-container');
        if (!chatBody) return;

        const prevIndicator = document.getElementById('chat-generating-indicator');
        if (prevIndicator) prevIndicator.remove();

        const aiBubbleRow = document.createElement('div');
        aiBubbleRow.className = 'chat-message-row msg-ai';
        aiBubbleRow.innerHTML = `<div class="message-bubble"><div class="message-content"><em>🤖 Agent starting…</em></div></div>`;
        chatBody.appendChild(aiBubbleRow);
        chatBody.scrollTop = chatBody.scrollHeight;
        const aiContentEl = aiBubbleRow.querySelector('.message-content');

        if (!window.apiClient) {
            aiContentEl.innerHTML = `<span style="color: var(--error)">❌ API client not ready.</span>`;
            return;
        }

        let taskId = null;
        let ws = null;
        try {
            const userEditedPrompt = this.systemPrompt && this.systemPrompt !== 'You are a helpful AI assistant.'
                ? this.systemPrompt
                : null;

            // Build conversation context from previous messages so agent has history (fix #6)
            const chatContext = this.messages
                .slice(0, -1)
                .filter(m => !m.isToolCall && !m.isToolResult)
                .map(m => ({ role: m.role, content: m.displayContent || m.content }))
                .slice(-8);

            const modeBehavior = buildBehavior(this.agentModeId,
                userEditedPrompt ? { system_prompt: userEditedPrompt } : {}
            );
            const taskRes = await window.apiClient.request('/tasks', {
                method: 'POST',
                body: JSON.stringify({
                    prompt: promptText,
                    workspace_path: this.workspacePath || null,
                    caller: 'DirectChat',
                    images: images.length > 0 ? images : undefined,
                    chat_context: chatContext.length > 0 ? chatContext : undefined,
                    behavior: {
                        mode: 'iterative_agent',
                        ...modeBehavior,
                    }
                })
            });
            taskId = taskRes.task_id;
            this._activeAgentTaskId = taskId;

            const wsUrl = `ws://localhost:${window.apiClient.port}/ws/tasks/${taskId}?token=${window.apiClient.token}`;
            ws = new WebSocket(wsUrl);
            this._activeAgentWs = ws;

            // Agent progress state — accumulated steps, each with thought + tool calls (fixes #4, #5)
            let steps = [];          // [{thought, toolCalls:[{name,status}], completed}]
            let currentStep = null;
            let streamBuffer = '';

            const updateProgressUI = () => {
                aiContentEl.innerHTML = this._renderAgentSteps(steps, currentStep, streamBuffer || null);
                const wasAtBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight <= 60;
                if (wasAtBottom) chatBody.scrollTop = chatBody.scrollHeight;
            };

            await new Promise((resolve, reject) => {
                let gotFinalEvent = false;

                ws.onmessage = (ev) => {
                    let pkt;
                    try { pkt = JSON.parse(ev.data); } catch (_) { return; }
                    if (!pkt) return;

                    if (pkt.event === 'confirm_request') {
                        // The agent paused for approval (plan / command / file write).
                        // Approval happens in the Monitor view (an OS notification also
                        // fires) — show a clear pending indicator here.
                        const isPlan = pkt.data?.type === 'plan_review';
                        const label = isPlan ? '📋 プラン承認待ち' : '🛡 承認待ち';
                        const tid = this._activeAgentTaskId || '';
                        aiContentEl.innerHTML = this._renderAgentSteps(steps, currentStep, streamBuffer || null) +
                            `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-glow,rgba(0,200,255,0.07));font-size:13px;">` +
                            `<strong>${label}</strong> — <a href="#monitor?id=${tid}" style="color:var(--accent)">Monitorで内容を確認して承認/編集</a>してください。承認後に処理を続行します。</div>`;
                        chatBody.scrollTop = chatBody.scrollHeight;
                        return;
                    }

                    if (pkt.event === 'thought' && pkt.data?.text) {
                        // New thought = new step; mark previous step's tool calls done
                        if (currentStep) {
                            currentStep.toolCalls.forEach(tc => { if (tc.status === 'running') tc.status = 'done'; });
                            currentStep.completed = true;
                            steps.push(currentStep);
                        }
                        const thoughtText = typeof pkt.data.text === 'string'
                            ? pkt.data.text : JSON.stringify(pkt.data.text);
                        currentStep = { thought: thoughtText, toolCalls: [], completed: false };
                        updateProgressUI();

                    } else if (pkt.event === 'tool_call' && pkt.data?.name) {
                        if (!currentStep) {
                            currentStep = { thought: null, toolCalls: [], completed: false };
                        }
                        currentStep.toolCalls.push({ name: pkt.data.name, status: 'running' });
                        updateProgressUI();

                    } else if (pkt.event === 'stream' && pkt.data?.chunk) {
                        // Streaming final response — commit current step and show streamed content
                        if (currentStep) {
                            currentStep.toolCalls.forEach(tc => { if (tc.status === 'running') tc.status = 'done'; });
                            currentStep.completed = true;
                            steps.push(currentStep);
                            currentStep = null;
                        }
                        streamBuffer += pkt.data.chunk;
                        aiContentEl.innerHTML = this._renderAgentSteps(steps, null, streamBuffer);
                        chatBody.scrollTop = chatBody.scrollHeight;

                    } else if (pkt.event === 'status' && pkt.data?.message && !streamBuffer && !currentStep && steps.length === 0) {
                        aiContentEl.innerHTML = `<em>🤖 ${escapeHtml(pkt.data.message.slice(0, 100))}</em>`;

                    } else if (pkt.event === 'complete') {
                        gotFinalEvent = true;
                        // Prefer the structured result summary: `answer` is the
                        // LLM-written Markdown completion report (依頼内容/実施内容/結果),
                        // `summary` its deterministic fallback. The raw `message` is the
                        // agent's last thought (often a bare "OBSERVE: … | PLAN: … |
                        // CALL: finish_task" line) — only used as a last resort.
                        const rs = pkt.data?.resultSummary || null;
                        const finalMsg = rs?.answer || rs?.summary
                            || pkt.data?.message || streamBuffer || '(task complete)';
                        // Modified/created files: prefer the structured resultSummary,
                        // else derive from the raw modifiedFiles array.
                        const resultFiles = (rs?.files && rs.files.length)
                            ? rs.files
                            : filesFromModified(pkt.data?.modifiedFiles);
                        // Compact run-stats chips (steps / tokens / duration / files).
                        const resultStats = rs?.stats || null;
                        ensureResultViewStyles();
                        aiContentEl.innerHTML = formatMessageContent(finalMsg)
                            + this._renderResultStatsChips(resultStats);
                        if (resultFiles && resultFiles.length > 0) {
                            // Clicks are handled by the delegated [data-open-path]
                            // listener on the chat container — no per-element bind.
                            aiContentEl.insertAdjacentHTML('beforeend', renderFileList(resultFiles));
                        }
                        // Persist files/stats on the message so loadHistory can re-render them.
                        this.messages.push({ role: 'assistant', content: finalMsg, resultFiles, resultStats });
                        this.saveHistory();
                        resolve();

                    } else if (pkt.event === 'error') {
                        gotFinalEvent = true;
                        const errMsg = pkt.data?.error || 'Agent task failed';
                        aiContentEl.innerHTML = `<span style="color: var(--error)">❌ ${escapeHtml(errMsg)}</span>`;
                        reject(new Error(errMsg));
                    }
                };
                ws.onerror = () => reject(new Error('WebSocket接続エラーが発生しました'));
                ws.onclose = () => {
                    if (!gotFinalEvent) {
                        if (streamBuffer) {
                            this.messages.push({ role: 'assistant', content: streamBuffer });
                            this.saveHistory();
                            resolve();
                        } else {
                            reject(new Error('接続が予期せず切断されました。エージェントサーバーが起動しているか確認してください。'));
                        }
                    }
                };
            });
        } catch (e) {
            console.error('_sendViaAgent error:', e);
            aiContentEl.innerHTML = `<span style="color: var(--error)">❌ ${escapeHtml(e.message || String(e))}</span>`;
        } finally {
            if (ws) { try { ws.close(); } catch (_) {} }
            this._activeAgentWs = null;
            this._activeAgentTaskId = null;
        }
    }

    /**
     * Render accumulated agent steps as collapsible HTML blocks.
     * @param {Array}  steps        Completed steps [{thought, toolCalls, completed}]
     * @param {Object} currentStep  In-progress step (null when done)
     * @param {string} streamContent  Partial streaming text from the final response
     */
    /**
     * Parse an OBSERVE/PLAN/CALL thought string into structured parts.
     * Handles formats:
     *   - "<thought>\nOBSERVE: ...\nPLAN: ...\nCALL: ...\n</thought>"  (native XML)
     *   - "OBSERVE: ... | PLAN: ... | CALL: ..."                        (JSON pipe)
     *   - "OBSERVE: ...\nPLAN: ...\nCALL: ..."                          (native plain)
     *   - any other string (treated as unstructured plan text)
     * Returns { observe, plan, call, raw } — fields are null if absent.
     */
    _parseThought(raw) {
        return parseThought(raw);
    }

    _renderAgentSteps(steps, currentStep, streamContent) {
        return renderAgentSteps(steps, currentStep, streamContent);
    }

    _renderResultStatsChips(stats) {
        return renderResultStatsChips(stats);
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
                session.chatMode = this.chatMode;
                session.agentModeId = this.agentModeId;
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
            title: '新しいチャット',
            timestamp: Date.now(),
            messages: [],
            // Carry over current settings to the new session
            chatMode: this.chatMode,
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
                    title: '新しいチャット',
                    timestamp: Date.now(),
                    messages: []
                };
                this.saveSessions(data);
            }
            const activeSession = data.sessions[data.activeSessionId];
            this.messages = activeSession ? (activeSession.messages || []) : [];
            // Restore settings saved with this session
            if (activeSession) {
                if (activeSession.chatMode) this.chatMode = activeSession.chatMode;
                if (activeSession.agentModeId) this.agentModeId = activeSession.agentModeId;
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
            data.sessions[newId] = { id: newId, title: '新しいチャット', timestamp: Date.now(), messages: [] };
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
                [newId]: { id: newId, title: '新しいチャット', timestamp: Date.now(), messages: [] }
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
                <button class="clear-all-btn" title="全ての履歴を削除"
                    style="background:none; border:1px solid var(--error, #c0392b); color:var(--error, #c0392b); cursor:pointer; font-size:11px; border-radius:4px; padding:3px 8px; font-weight:600;">🗑 全削除</button>
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
                    <button class="session-delete-btn" title="このチャットを削除"
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
                    if (!confirm(`チャット「${s.title}」を削除しますか？`)) return;
                    this._deleteSession(s.id);
                    document.body.removeChild(overlay);
                    this.reRender();
                    this.showHistoryModal();
                };
                body.appendChild(item);
            });
        }

        header.querySelector('.clear-all-btn').onclick = () => {
            if (!confirm('全てのチャット履歴を削除しますか？この操作は取り消せません。')) return;
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
