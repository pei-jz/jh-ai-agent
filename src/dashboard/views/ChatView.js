import llmService from '../../modules/ai/LLMService.js';
import { ToolExecutor } from '../../modules/ai/ToolExecutor.js';
import { mcpManager } from '../../modules/ai/McpManager.js';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ensureResultViewStyles } from '../utils/resultView.js';
import { escapeHtml, formatMessageContent, formatMarkdown, renderTableHtml } from './chat/chatMarkdown.js';
import { STORAGE_KEY as CHAT_SESSIONS_KEY, parseSessions, pruneSessions } from './chat/chatSessions.js';
import { extractToolCall } from './chat/chatRenderer.js';
import { icon } from '../utils/icons.js';
import { CHAT_STYLES } from './ChatView.styles.js';
// MIGRATED (region 6 of docs/design/svelte-migration.md): the conversation
// surface. chat/chatMarkdown.js still owns how content is parsed.
import ChatMessages from '../svelte/chat/ChatMessages.svelte';
import SlashPopup from '../svelte/chat/SlashPopup.svelte';
import SkillChips from '../svelte/chat/SkillChips.svelte';
import AttachmentPreviews from '../svelte/chat/AttachmentPreviews.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';

// Simple-mode tool loop's executor. sendMessage referenced `toolExecutor` but no
// instance was ever created/imported (latent ReferenceError when tools were
// enabled in Simple mode) — this module-level instance restores the intended
// behavior. Agent mode is unaffected (it runs server-side via TaskBridge).
const toolExecutor = new ToolExecutor();

/** Every host id a migrated region mounts into — teardown walks this list. */
const CHAT_MOUNT_HOSTS = [
    'chat-messages-container', 'slash-popup', 'chat-input-skills', 'chat-input-previews',
];

export class ChatView {
    constructor() {
        // Transient system notices (validation errors, one-off status). Kept out
        // of `messages` so they are never saved with the conversation.
        this._notices = [];
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
                    badge = `<span style="font-size: 10px; background: var(--accent); color: var(--text-inverse); border-radius: 4px; padding: 1px 5px; font-weight: 600;">🟢 ${toolCount}t</span>`;
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
        const activeTools = ToolExecutor.getAllAvailableToolsForNativeAPI(this.config);
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

        // ChatView is now a SIMPLE chat surface only (agent tasks live in the
        // Monitor "new task" flow). Web search + relevant MCP tools are available;
        // there is no mode toggle / workspace / agent picker here.
        const headerTitle = 'Chat';
        const headerSubtitle = 'Chat with AI (web search + relevant MCP tools available). Run agents from Monitor → New Task';

        return `
            <style>${CHAT_STYLES}</style>

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
                            <label id="chat-jsonmode-wrap" class="chat-jsonmode-toggle" title="このモデルはツール呼び出しにJSON形式を使う（native function-callが不安定なモデル向け）">
                                <input type="checkbox" id="chat-jsonmode-cb"> <span>JSON tools</span>
                            </label>
                            <button id="btn-new-chat" class="btn btn-primary btn-sm">${icon('doc-plus', 14)} New Chat</button>
                            <button id="btn-chat-history" class="btn btn-secondary btn-sm">${icon('history', 14)} History</button>
                            <button id="btn-clear-chat" class="btn btn-secondary btn-sm">${icon('trash', 14)} Clear Chat</button>
                        </div>
                    </div>

                    <!-- System Prompt & Chat Settings Collapsible -->
                    <div class="chat-system-prompt-container">
                        <div class="chat-system-prompt-toggle" id="prompt-toggle-btn">
                            <span>${icon('gear', 14)}</span> Chat Settings
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
                    <!-- MIGRATED: ChatMessages.svelte, mounted by _syncMessages().
                         The bubbles used to be appended by hand on every message push
                         during generation. -->
                    <div class="chat-body" id="chat-messages-container"></div>

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
        const promptToggle = document.getElementById('prompt-toggle-btn');
        const promptPanel = document.getElementById('prompt-panel');
        const systemInput = document.getElementById('chat-system-input');
        const workspaceInput = document.getElementById('chat-workspace-input');
        const btnSelectWorkspace = document.getElementById('btn-select-workspace');
        const toolsToggle = document.getElementById('chat-tools-enabled-toggle');
        const toolsWrap = document.getElementById('chat-tools-enabled-wrap');

        // The conversation is a migrated region: the markup render() returned is an
        // empty host, so it has to be populated here.
        this._syncMessages();

        // Scroll to bottom
        if (chatBody) {
            chatBody.scrollTop = chatBody.scrollHeight;

            // Delegated click handler for dynamically-rendered message content.
            // Inline on* handlers were removed so a strict CSP (script-src 'self',
            // no 'unsafe-inline') can be enforced — see tauri.conf.json.
            chatBody.addEventListener('click', (e) => {
                // (Copy-code button is handled by the GLOBAL delegated handler
                // installed in ensureChatMarkdownStyles — it also covers the
                // spotlight overlay and the Monitor result view. Keeping a
                // second handler here would double-copy.)
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
                this._syncJsonModeToggle();
            });
        }

        // "JSON tools" per-model toggle — force JSON-envelope tool calls for a model
        // whose native function-calling misbehaves (stored in localStorage
        // `jhai_json_mode_models`; read by LLMService.supportsNativeTools).
        this._syncJsonModeToggle();
        document.getElementById('chat-jsonmode-cb')?.addEventListener('change', (e) => {
            const model = (llmService.getCurrentModel() || '').trim();
            if (!model) return;
            let list = [];
            try { list = JSON.parse(localStorage.getItem('jhai_json_mode_models') || '[]'); } catch (_) {}
            if (!Array.isArray(list)) list = [];
            const low = model.toLowerCase();
            list = list.filter(m => String(m).toLowerCase() !== low);
            if (e.target.checked) list.push(model);
            try { localStorage.setItem('jhai_json_mode_models', JSON.stringify(list)); } catch (_) {}
        });

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
                // Clear through the COMPONENT, not by wiping its host.
                //
                // This used to be `container.innerHTML = ''`, which destroys the
                // mounted component's DOM while the seam still records it as mounted —
                // so the next mountComponent call takes the update() path and pushes
                // props into an instance whose nodes are gone. `_syncMessages` flushes
                // synchronously, so this clears just as immediately.
                this._notices = [];
                this._syncMessages();
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

    /**
     * Show what is attached to the next message.
     *
     * Was innerHTML plus a per-item remove listener rebound after every change, with
     * the id read back out of `data-id` on the closest ancestor.
     */
    renderAttachmentPreviews() {
        const host = document.getElementById('chat-input-previews');
        if (!host) return;
        host.style.display = this.attachments.length ? 'flex' : 'none';
        mountComponent(AttachmentPreviews, host, {
            attachments: this.attachments,
            onRemove: (id) => {
                this.attachments = this.attachments.filter(a => a.id !== id);
                this.renderAttachmentPreviews();
                this.updateSendButtonState();
            },
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
        // Mark stale so any still-in-flight async work (e.g. the MCP server
        // startup in _startEnabledMcpServers, which can take seconds right
        // after app start) can NEVER call reRender() and overwrite whichever
        // view the user has navigated to since (the "Chat screen suddenly
        // replaces the Monitor once after reload" bug).
        this._destroyed = true;
        if (this._dragDropUnlisten) {
            this._dragDropUnlisten();
            this._dragDropUnlisten = null;
        }
        // Unmount the migrated region: reRender() and navigation both replace this
        // view's innerHTML, and an instance left on a detached host keeps its
        // listeners.
        for (const id of CHAT_MOUNT_HOSTS) destroyComponent(document.getElementById(id));
    }

    /**
     * Start every configured MCP server that isn't already running, so its tools
     * become available to the chat (in BOTH Simple and Agent mode). Best-effort
     * and idempotent. Called when tools are enabled or when switching modes.
     */
    /** Reflect whether the CURRENT model is on the JSON-tools list into the checkbox. */
    _syncJsonModeToggle() {
        const cb = document.getElementById('chat-jsonmode-cb');
        if (!cb) return;
        const model = (llmService.getCurrentModel() || '').toLowerCase();
        let list = [];
        try { list = JSON.parse(localStorage.getItem('jhai_json_mode_models') || '[]'); } catch (_) {}
        cb.checked = Array.isArray(list) && !!model && list.some(m => model.includes(String(m).toLowerCase()));
    }

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

        // A new turn supersedes the previous turn's transient notices.
        this._clearSystemMessages();

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
        // NO agent-control tools. Chat has no task to finish, no Result Contract
        // to deliver and nowhere to pause — offering finish_task made the model
        // spend its turn "finishing" and the user got a tool trace instead of an
        // answer. In Chat the reply IS the deliverable.
        toolExecutor.setToolAllowlist(['web_search', 'fetch_url'], { agentControl: false });
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
Once you have what you need, ANSWER in plain text. This is a conversation, not a
task: there is no \`finish_task\` to call, and a tool call is never a substitute
for the answer itself.
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
                    // When the model is emitting a tool-call JSON block, don't render
                    // the raw JSON forming in the chat — show a compact "researching"
                    // placeholder instead. The compact tool indicator replaces this
                    // bubble once the call is parsed. A plain prose answer (the common
                    // case) renders as markdown as before.
                    const trimmed = aiResponse.trimStart();
                    const looksLikeToolCall = trimmed.startsWith('```json') || trimmed.startsWith('{"thought"') || trimmed.startsWith('{ "thought"');
                    aiContentEl.innerHTML = looksLikeToolCall
                        ? `<span style="font-size:12.5px;color:var(--text-secondary);">🤔 Thinking or using tools…</span>`
                        : formatMessageContent(aiResponse);
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
                      } else if (toolCall && (!toolCall.tool_calls || toolCall.tool_calls.length === 0)) {
                          // The LLM outputted JSON, but NO tool calls. It's just planning/thinking.
                          // We must prompt it to continue and output the actual answer.
                          loopCount++;

                          // Drop the streamed bubble
                          if (aiBubbleRow) { aiBubbleRow.remove(); aiBubbleRow = null; aiContentEl = null; }

                          this.messages.push({
                              role: 'assistant',
                              content: res.content,
                              isToolCall: true,
                              toolCalls: []
                          });
                          this.messages.push({
                              role: 'user',
                              content: `You outputted a thought/planning JSON but no tool calls and no final answer. Please provide your final response to the user in plain text now.`
                          });
                          this.saveHistory();
                          this._appendLastMessage(); // Render the empty tool call as "Thinking..."
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

        // Robust: a throw here (e.g. a manager not yet loaded) used to silently
        // leave the popup hidden — the "/ shows nothing" symptom. Guard each source
        // independently and always render (even an empty list shows the header).
        let templates = [];
        let skills = [];
        try {
            templates = (promptTemplateManager.search(query) || []).map(t => ({
                type: 'template', key: t.key, label: t.label, icon: t.icon || '📝', prompt: t.prompt,
            }));
        } catch (e) { console.error('slash: template search failed', e); }
        try {
            skills = (skillManager.search(query) || []).map(s => ({
                type: 'skill', key: s.name, label: s.title, icon: '⚡',
            }));
        } catch (e) { console.error('slash: skill search failed', e); }

        this._slashItems = [...templates, ...skills];
        this._slashIndex = 0;
        this._renderSlashPopup();
    }

    /**
     * The /command picker.
     *
     * Was innerHTML plus a `querySelectorAll(...).forEach` re-binding a mousedown per
     * row — and because the list filters as you type, that rebind ran on EVERY
     * keystroke.
     *
     * `mousedown` (not click) is load-bearing and preserved in the component: a click
     * fires after the textarea has blurred, by which point the caret position the
     * insertion needs is gone.
     */
    _renderSlashPopup() {
        const popup = document.getElementById('slash-popup');
        if (!popup) return;
        popup.style.display = this._slashItems.length ? 'flex' : 'block';
        mountComponent(SlashPopup, popup, {
            items: this._slashItems,
            selected: this._slashIndex,
            onPick: (item) => {
                const textarea = document.getElementById('chat-textarea-input');
                if (item && textarea) this._selectSlashItem(item, textarea);
            },
        });
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

    /**
     * The skills attached to the next message.
     *
     * Was innerHTML plus a per-chip remove listener rebound on every change.
     */
    renderSkillChips() {
        const host = document.getElementById('chat-input-skills');
        if (!host) return;
        host.style.display = this.activeSkills.length ? 'flex' : 'none';
        mountComponent(SkillChips, host, {
            skills: this.activeSkills,
            onRemove: (name) => {
                this.activeSkills = this.activeSkills.filter(s => s.name !== name);
                this.renderSkillChips();
                this.updateSendButtonState();
            },
        });
    }

    _hideSlashPopup() {
        const popup = document.getElementById('slash-popup');
        if (popup) popup.style.display = 'none';
        this._slashItems = [];
        this._slashIndex = 0;
        // Unmount rather than only hiding: the popup is rebuilt from scratch on the
        // next `/`, and a hidden instance would keep its $effect (the scroll-into-view)
        // alive against a subtree nobody can see.
        destroyComponent(popup);
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
    /**
     * Push the conversation to ChatMessages.svelte.
     *
     * This is the HOT PATH — called after every message push during generation, so it
     * has to stay cheap. A keyed {#each} leaves existing bubbles untouched when one is
     * appended, which is what the hand-rolled append achieved; the difference is that
     * a bubble whose CONTENT changed (the streaming assistant reply) now updates in
     * place instead of needing its own code path.
     *
     * What this replaced:
     *   • _renderMessageHtml — a one-line delegation to the string renderer;
     *   • _appendLastMessage — built a detached <div>, set innerHTML, took
     *     firstElementChild, appended it, and had to remove the empty-state
     *     placeholder by hand first;
     *   • _appendSystemMessage — a near-duplicate of the above for transient notices,
     *     which it injected straight into the DOM where any re-render silently
     *     dropped them. Notices are a prop now, so their lifetime is explicit.
     */
    _syncMessages({ scroll = false } = {}) {
        const host = document.getElementById('chat-messages-container');
        if (!host) return;
        mountComponent(ChatMessages, host, {
            messages: this.messages,
            notices: this._notices || [],
            renderMarkdown: (t) => formatMessageContent(t),
            renderUserMarkdown: (t) => formatMarkdown(t),
        });
        if (scroll) host.scrollTop = host.scrollHeight;
    }

    /** Append one message and follow it. The generation loop's entry point. */
    _appendLastMessage() {
        this._syncMessages({ scroll: true });
    }

    /**
     * A transient notice: a validation error or one-off status line that is NOT part
     * of the conversation and must not be persisted with it.
     */
    _appendSystemMessage(text) {
        if (!Array.isArray(this._notices)) this._notices = [];
        this._notices.push(String(text ?? ''));
        this._syncMessages({ scroll: true });
    }

    /** Drop the transient notices (a new turn supersedes them). */
    _clearSystemMessages() {
        if (this._notices?.length) {
            this._notices = [];
            this._syncMessages();
        }
    }

    // ─── Full reRender (structural changes only) ────────────────────────────

    async reRender() {
        // A destroyed (navigated-away) instance must never repaint — the
        // .main-content container now belongs to ANOTHER view.
        if (this._destroyed) return;
        const container = document.querySelector('.main-content');
        if (container) {
            // Preserve scroll position
            const chatBody = document.getElementById('chat-messages-container');
            const wasAtBottom = !chatBody || (chatBody.scrollHeight - chatBody.scrollTop <= chatBody.clientHeight + 30);

            const html = await this.render();
            for (const id of CHAT_MOUNT_HOSTS) destroyComponent(document.getElementById(id));
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
