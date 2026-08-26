<!--
  ChatRoot — the whole Chat surface.

  Svelte migration step 4 (docs/design/svelte-migration.md). The bubbles, the slash
  popup, the skill chips and the attachment previews were already components, and
  the turn itself is views/chat/chatLoop.js. What this replaces is the 1,700-line
  shell that held them together: `render()` returned a template string, `init()`
  re-attached ~15 listeners to it by id, and every structural change went through
  `reRender()` — which rebuilt the markup and re-ran `init()`, taking the textarea's
  caret and the scroll position with it. Toggling one MCP checkbox did that.

  Two things the old shape forced, now structurally impossible:
    • "Clear chat" had to clear THROUGH the messages component rather than wiping
      its host, because `innerHTML = ''` destroys a mounted subtree the mount seam
      still believes in. There is no host to wipe here.
    • The streamed reply and the thinking indicator were hand-built DOM appended to
      `#chat-messages-container` — a sibling of a mounted component's subtree, i.e.
      exactly the shared-ownership the seam forbids. Both are state now.
-->
<script>
    import { invoke } from '@tauri-apps/api/core';
    import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { icon } from '../../utils/icons.js';
    import llmService from '../../../modules/ai/LLMService.js';
    import { ToolExecutor } from '../../../modules/ai/ToolExecutor.js';
    import { mcpManager } from '../../../modules/ai/McpManager.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { skillManager } from '../../../modules/ai/SkillManager.js';
    import { formatMessageContent, formatMarkdown } from '../../views/chat/chatMarkdown.js';
    import { extractToolCall } from '../../views/chat/chatRenderer.js';
    import { ensureResultViewStyles } from '../../utils/resultView.js';
    import { runChatTurn, looksLikeToolCall } from '../../views/chat/chatLoop.js';
    import { readAttachment, filesPreamble } from '../../views/chat/chatAttachments.js';
    import { STORAGE_KEY, parseSessions, pruneSessions } from '../../views/chat/chatSessions.js';

    import ChatMessages from './ChatMessages.svelte';
    import SlashPopup from './SlashPopup.svelte';
    import SkillChips from './SkillChips.svelte';
    import AttachmentPreviews from './AttachmentPreviews.svelte';
    import HistoryModal from './HistoryModal.svelte';

    let {
        api = null,
        /** Injected so the turn can be driven without a real executor in tests. */
        tools = null,
        llm = llmService,
        confirmAction = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
    } = $props();

    const client = () => api ?? window.apiClient;
    // Created on first use rather than at init, so reading the `tools` prop happens
    // inside a closure (Svelte otherwise warns that it captures only the initial
    // value) and no executor is constructed for a chat that never sends anything.
    let ownExecutor = null;
    const toolbox = () => tools ?? (ownExecutor ??= new ToolExecutor());

    // ── State ─────────────────────────────────────────────────────────────
    let messages = $state([]);
    /** Transient warnings. Deliberately NOT in `messages` — they are never saved. */
    let notices = $state([]);
    let systemPrompt = $state('You are a helpful AI assistant.');
    let models = $state([]);
    let selectedModel = $state('');
    let isGenerating = $state(false);
    let attachments = $state([]);
    let activeSkills = $state([]);
    let allMcpServers = $state({});
    /** Which MCP servers are up. Mirrored into state because mcpManager is not reactive. */
    let mcpRunning = $state([]);
    let mcpBusy = $state([]);
    let settingsExpanded = $state(false);
    let jsonMode = $state(false);
    let showHistory = $state(false);
    let store = $state({ activeSessionId: null, sessions: {} });

    let draft = $state('');
    let slashItems = $state([]);
    let slashIndex = $state(0);
    /**
     * Whether the picker is open, tracked SEPARATELY from whether it has rows.
     * A query that matches nothing still has to say so — driving visibility off
     * `slashItems.length` made SlashPopup's own empty state unreachable, which is
     * the "/ shows nothing" symptom the popup was hardened against in the first
     * place.
     */
    let slashOpen = $state(false);
    let thinking = $state(false);
    let thinkingLabel = $state('Thinking... (0.0s)');
    /** The reply as it arrives. A bubble that is not yet a message. */
    let streamText = $state('');
    let streaming = $state(false);

    let abortController = null;
    let thinkingTimer = null;
    let textareaEl = $state(null);
    let bodyEl = $state(null);
    let fileInputEl = $state(null);
    let dropActive = $state(false);

    const canSend = $derived(!!draft.trim() || attachments.length > 0 || activeSkills.length > 0);
    const sessionList = $derived(Object.values(store.sessions || {}));
    const mcpNames = $derived(Object.keys(allMcpServers || {}));

    // ── Session store ─────────────────────────────────────────────────────

    const readStore = () => parseSessions(localStorage.getItem(STORAGE_KEY));

    function writeStore(data) {
        pruneSessions(data);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* quota */ }
        store = data;
        // Durable backup, fire and forget: it survives a localStorage clear.
        backupToFile(data).catch(e => console.warn('[ChatSessions] File backup failed (non-critical):', e));
    }

    async function backupToFile(data) {
        const dir = await invoke('get_app_config_dir');
        if (!dir) return;
        await invoke('write_file', { path: `${dir}/chat_sessions.json`, content: JSON.stringify(data, null, 2) });
    }

    async function restoreFromFile() {
        try {
            const dir = await invoke('get_app_config_dir');
            if (!dir) return;
            const raw = await invoke('read_file', { path: `${dir}/chat_sessions.json` });
            if (!raw) return;
            const fromFile = JSON.parse(raw);
            // Only when the file genuinely knows more, so a fresh session never
            // resurrects a conversation the user just cleared.
            if (Object.keys(fromFile.sessions || {}).length > Object.keys(readStore().sessions || {}).length) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(fromFile));
                loadActive();
            }
        } catch (_) { /* no backup yet */ }
    }

    function persist() {
        const data = readStore();
        const s = data.sessions?.[data.activeSessionId];
        if (!s) return;
        s.messages = messages;
        s.timestamp = Date.now();
        s.systemPrompt = systemPrompt;
        // The title is the first thing the user said, once they have said it.
        if (messages.length && (s.title === 'New Chat' || s.title === '新しいチャット')) {
            const first = messages.find(m => m.role === 'user');
            if (first) {
                const c = String(first.displayContent || first.content || '');
                s.title = c.substring(0, 30) + (c.length > 30 ? '...' : '');
            }
        }
        writeStore(data);
    }

    function loadActive() {
        const data = readStore();
        if (!data.activeSessionId || !data.sessions?.[data.activeSessionId]) {
            const id = Date.now().toString();
            data.activeSessionId = id;
            data.sessions = data.sessions || {};
            data.sessions[id] = { id, title: 'New Chat', timestamp: Date.now(), messages: [] };
            writeStore(data);
        } else {
            store = data;
        }
        const s = store.sessions[store.activeSessionId];
        messages = s?.messages || [];
        if (s?.systemPrompt) systemPrompt = s.systemPrompt;
    }

    function startNewChat() {
        const data = readStore();
        const id = Date.now().toString();
        data.activeSessionId = id;
        data.sessions = data.sessions || {};
        data.sessions[id] = { id, title: 'New Chat', timestamp: Date.now(), messages: [], systemPrompt };
        writeStore(data);
        messages = [];
        notices = [];
    }

    function clearChat() {
        if (!confirmAction('Clear the contents of the current chat?')) return;
        messages = [];
        notices = [];
        const data = readStore();
        const s = data.sessions?.[data.activeSessionId];
        if (s) { s.messages = []; s.title = 'New Chat'; s.timestamp = Date.now(); }
        writeStore(data);
    }

    function pickSession(id) {
        const data = readStore();
        if (!data.sessions?.[id]) return;
        data.activeSessionId = id;
        writeStore(data);
        loadActive();
        showHistory = false;
    }

    function deleteSession(id, title) {
        if (!confirmAction(`Delete the chat "${title}"?`)) return;
        const data = readStore();
        delete data.sessions[id];
        if (data.activeSessionId === id) {
            const newest = Object.values(data.sessions).sort((a, b) => b.timestamp - a.timestamp)[0];
            data.activeSessionId = newest?.id || null;
        }
        // Never leave the store without an active session — the input would have
        // nowhere to save to and the next message would be silently lost.
        if (!data.activeSessionId) {
            const fresh = Date.now().toString();
            data.activeSessionId = fresh;
            data.sessions[fresh] = { id: fresh, title: 'New Chat', timestamp: Date.now(), messages: [] };
        }
        writeStore(data);
        loadActive();
    }

    function clearAllSessions() {
        if (!confirmAction('Delete all chat history? This cannot be undone.')) return;
        const id = Date.now().toString();
        writeStore({ activeSessionId: id, sessions: { [id]: { id, title: 'New Chat', timestamp: Date.now(), messages: [] } } });
        messages = [];
        notices = [];
        showHistory = false;
    }

    // ── Composition ───────────────────────────────────────────────────────

    function grow() {
        if (!textareaEl) return;
        textareaEl.style.height = 'auto';
        textareaEl.style.height = textareaEl.scrollHeight + 'px';
    }

    function closeSlash() {
        slashOpen = false;
        slashItems = [];
    }

    function updateSlash(value) {
        // The popup opens only when the WHOLE input is a command.
        if (!String(value).startsWith('/')) { closeSlash(); return; }
        const query = value.slice(1);
        // Each source is guarded on its own: a throw from either used to leave the
        // popup empty with no clue which one failed.
        let templates = [];
        let skills = [];
        try {
            templates = (promptTemplateManager.search(query) || []).map(t => ({
                type: 'template', key: t.key, label: t.label, icon: t.icon || '📝', prompt: t.prompt,
            }));
        } catch (e) { console.error('slash: template search failed', e); }
        try {
            skills = (skillManager.search(query) || []).map(s => ({
                type: 'skill', key: s.name, label: s.title || s.name, hint: s.description, icon: '⚡',
            }));
        } catch (e) { console.error('slash: skill search failed', e); }
        slashItems = [...templates, ...skills];
        slashIndex = 0;
        slashOpen = true;
    }

    function pickSlash(item) {
        if (!item) return;
        if (item.type === 'template') {
            draft = item.prompt || '';
        } else {
            // A skill becomes a chip rather than being pasted into the input — its
            // body is injected at send time, so the box stays readable. Whatever the
            // user typed after "/key " is kept as their actual message.
            const after = draft.slice(1);
            const sp = after.indexOf(' ');
            draft = sp >= 0 ? after.slice(sp + 1) : '';
            if (!activeSkills.some(s => s.name === item.key)) {
                activeSkills = [...activeSkills, { name: item.key, title: item.label || item.key }];
            }
        }
        closeSlash();
        textareaEl?.focus();
        queueMicrotask(grow);
    }

    function onKeydown(e) {
        if (slashOpen) {
            if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
            // With no rows there is nothing to navigate or choose, so Enter falls
            // through and sends. The predecessor swallowed it, leaving a user who
            // typed a command that matched nothing unable to send at all.
            if (slashItems.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = Math.min(slashIndex + 1, slashItems.length - 1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = Math.max(slashIndex - 1, 0); return; }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickSlash(slashItems[slashIndex]); return; }
            }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
        }
    }

    async function attach(file) {
        const res = await readAttachment(file, { invoke });
        if (!res.ok) { notify(res.reason); return; }
        attachments = [...attachments, res.attachment];
    }

    /** A path dropped from Explorer — read through Rust, then the normal path. */
    async function attachPath(path) {
        try {
            const data = await invoke('read_file_bytes', { path });
            const ext = String(data.ext || '').toLowerCase();
            const mime = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
            }[ext] || 'application/octet-stream';
            const blob = new Blob([new Uint8Array(data.bytes)], { type: mime });
            await attach(new File([blob], data.name, { type: mime }));
        } catch (e) {
            notify(`Failed to read file: ${e.message || e}`);
        }
    }

    function onPaste(e) {
        for (const item of e.clipboardData?.items || []) {
            if (item.type.includes('image')) attach(item.getAsFile());
        }
    }

    function scrollDown() {
        queueMicrotask(() => { if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; });
    }

    // ── Sending ───────────────────────────────────────────────────────────

    async function send() {
        if (isGenerating || !canSend) return;
        notices = [];                        // a new turn supersedes them

        const text = draft.trim();
        draft = '';
        queueMicrotask(grow);

        const images = attachments.filter(a => a.type === 'image');
        const files = attachments.filter(a => a.type !== 'image');
        const skillRefs = [...activeSkills];

        // Skill bodies are read from disk and prepended to what the model sees, but
        // never to what the bubble shows — the transcript stays readable.
        let preamble = '';
        if (skillRefs.length) {
            const bodies = [];
            for (const s of skillRefs) {
                try { bodies.push(`# Skill: ${s.title} (/${s.name})\n${await skillManager.readContent(s.name)}`); }
                catch (e) { notices = [...notices, `⚠️ Failed to load skill "${s.name}": ${e.message || e}`]; }
            }
            if (bodies.length) preamble = bodies.join('\n\n') + '\n\n---\n\n';
        }

        messages = [...messages, {
            role: 'user',
            content: preamble + text + filesPreamble(files),
            displayContent: text,
            skills: skillRefs.map(s => ({ name: s.name, title: s.title })),
            images: images.map(i => i.dataUrl),
            files: files.map(f => ({ name: f.name, size: f.size })),
        }];
        attachments = [];
        activeSkills = [];
        persist();
        scrollDown();

        isGenerating = true;
        abortController = new AbortController();

        // Chat has no workspace, so file/shell tools make no sense: web search plus
        // the MCP tools RELEVANT to this message, and no agent-control tools —
        // offering finish_task made the model spend its turn "finishing" and the
        // user got a tool trace instead of an answer.
        const executor = toolbox();
        await executor.startSession('.');
        executor.setToolAllowlist(['web_search', 'fetch_url'], { agentControl: false });
        executor._mcpBypassesAllowlist = true;
        // Chat is a JHAI-owned surface, so it excludes EXTERNAL-APP (WS) MCP
        // tools for the same reason NewTask and Schedule do: `get_buffer` and
        // friends read a connected editor's live state, and a person chatting
        // here has not asked for the file they happen to have open to be sent.
        // Without this the allowlist bypass above let those tools through.
        executor.setExcludeExternalAppMcpTools(true);
        executor.setMcpRelevanceQuery(text);
        executor.setMcpPruneOptions({ minScore: 0.12, top: 5 });

        let outputLanguage = 'Japanese';
        try { outputLanguage = (await invoke('get_ai_config'))?.output_language || 'Japanese'; } catch (_) {}

        await runChatTurn({
            messages,
            push: (m) => { messages = [...messages, m]; persist(); scrollDown(); },
            llm,
            tools: executor,
            extractToolCall,
            systemPrompt,
            outputLanguage,
            images: images.map(i => i.dataUrl),
            signal: abortController.signal,
            onThinking: setThinking,
            onStatus: (msg) => { thinkingLabel = msg; },
            onStreamStart: () => { streaming = true; streamText = ''; scrollDown(); },
            onStreamDelta: (full) => { streamText = full; scrollDown(); },
            // `kept: false` means the reply turned out to be a tool call and the
            // bubble only ever held the placeholder; `true` means it IS the answer,
            // and the message pushed alongside it carries `streamed: true`.
            onStreamEnd: () => { streaming = false; streamText = ''; },
            confirm: async (req) => {
                if (req.type === 'command_confirm') {
                    return confirmAction(`AI wants to run this command:\n\n${req.command}\n\nDo you approve?`);
                }
                if (req.type === 'diff_review') {
                    return confirmAction(`AI wants to modify/write file outside workspace:\n\n${req.path}\n\nDo you approve?`);
                }
                return true;
            },
        });

        setThinking(false);
        isGenerating = false;
        abortController = null;
        scrollDown();
    }

    function setThinking(on) {
        thinking = on;
        if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
        if (!on) return;
        const at = Date.now();
        thinkingLabel = 'Thinking... (0.0s)';
        thinkingTimer = setInterval(() => {
            thinkingLabel = `Thinking... (${((Date.now() - at) / 1000).toFixed(1)}s)`;
        }, 100);
    }

    function stop() {
        try { abortController?.abort(); } catch (_) {}
    }

    // ── Model / MCP ───────────────────────────────────────────────────────

    function jsonModeList() {
        try {
            const list = JSON.parse(localStorage.getItem('jhai_json_mode_models') || '[]');
            return Array.isArray(list) ? list : [];
        } catch (_) { return []; }
    }

    function syncJsonMode() {
        const model = String(llm.getCurrentModel?.() || '').toLowerCase();
        jsonMode = !!model && jsonModeList().some(m => model.includes(String(m).toLowerCase()));
    }

    function toggleJsonMode(on) {
        const model = String(llm.getCurrentModel?.() || '').trim();
        if (!model) return;
        const low = model.toLowerCase();
        const list = jsonModeList().filter(m => String(m).toLowerCase() !== low);
        if (on) list.push(model);
        try { localStorage.setItem('jhai_json_mode_models', JSON.stringify(list)); } catch (_) {}
        jsonMode = on;
    }

    async function toggleMcp(name, on) {
        mcpBusy = [...mcpBusy, name];
        try {
            if (on) {
                await mcpManager.startClient(name, allMcpServers[name]);
            } else {
                const c = mcpManager.clients.get(name);
                if (c) { await c.stop(); mcpManager.clients.delete(name); }
            }
        } catch (err) {
            console.error(`Failed to toggle MCP server ${name}:`, err);
            notify(`Failed to toggle MCP server ${name}: ${err.message || err}`);
        } finally {
            mcpBusy = mcpBusy.filter(n => n !== name);
            // One reassignment, instead of the reRender() that used to rebuild the
            // entire view — and with it the textarea the user was typing in.
            mcpRunning = Array.from(mcpManager.clients.keys());
        }
    }

    function showMcpError(name) {
        const err = mcpManager.getError?.(name);
        if (!err) return;
        const when = err.at ? new Date(err.at).toLocaleString() : '';
        notify(`MCP server "${name}" failed to start\nTime: ${when}\n\n${err.message}`);
    }

    /** Bring up every configured server so its tools can be relevance-pruned in. */
    async function startConfiguredMcp() {
        if (!mcpNames.length) return;
        try {
            await mcpManager.loadConfig();
            for (const [name, config] of Object.entries(mcpManager.serversConfig?.mcpServers || {})) {
                if (!mcpManager.clients.has(name)) await mcpManager.startClient(name, config);
            }
        } catch (e) {
            console.warn('Failed to start MCP servers:', e);
        }
        mcpRunning = Array.from(mcpManager.clients.keys());
    }

    /** A question routed here from the global quick-search (Ctrl+Shift+Space). */
    function consumePendingQuestion() {
        let pending = null;
        try { pending = localStorage.getItem('jh_pending_chat_question'); } catch (_) { return; }
        if (!pending) return;
        try { localStorage.removeItem('jh_pending_chat_question'); } catch (_) {}
        startNewChat();                       // it should stand alone
        draft = pending;
        queueMicrotask(() => send());
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    // Init-time, NOT in an $effect: loadActive() both reads and writes `store`, so
    // running it inside one makes the effect depend on what it just assigned — a
    // self-retriggering loop. Everything here must happen exactly once anyway.
    ensureResultViewStyles();
    loadActive();

    $effect(() => {
        let alive = true;

        // Reads after the first await are not tracked, so this body can safely
        // consult the state it is filling in.
        (async () => {
            try {
                const res = await client()?.getModels?.();
                if (alive && res?.models?.length) {
                    models = res.models;
                    const current = llm.getCurrentModel?.();
                    selectedModel = models.some(m => m.id === current) ? current : models[0].id;
                    llm.setCurrentModel?.(selectedModel);
                }
            } catch (e) { console.error('Failed to load models for chat:', e); }

            if (alive && !models.length) {
                models = [
                    { id: 'openai:gpt-4o', name: 'GPT-4o (Fallback)' },
                    { id: 'anthropic:claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (Fallback)' },
                    { id: 'gemini:gemini-1.5-flash', name: 'Gemini 1.5 Flash (Fallback)' },
                ];
                selectedModel = models[0].id;
                llm.setCurrentModel?.(selectedModel);
            }
            if (!alive) return;
            syncJsonMode();

            try {
                const cfg = await invoke('get_ai_config');
                if (!alive) return;
                allMcpServers = cfg?.mcp_servers || {};
                promptTemplateManager.loadFromConfig(cfg || {});
                await skillManager.refresh();
            } catch (_) { /* not running under Tauri */ }
            if (!alive) return;
            mcpRunning = Array.from(mcpManager.clients.keys());
            await restoreFromFile();
            if (!alive) return;
            startConfiguredMcp();
            consumePendingQuestion();
        })();

        return () => {
            alive = false;
            if (thinkingTimer) clearInterval(thinkingTimer);
            try { abortController?.abort(); } catch (_) {}
        };
    });

    // Files dropped from Explorer. Tauri-native, because a browser dragover gives
    // no readable path on Windows.
    $effect(() => {
        let unlisten = null;
        let alive = true;
        // Guarded for the SYNCHRONOUS throw too, not just the rejection: outside
        // Tauri this reaches for window.__TAURI_INTERNALS__ and throws before it
        // ever returns a promise, and an exception out of an $effect takes the
        // whole update with it — losing drag-drop is not worth losing the view.
        try {
            getCurrentWebviewWindow().onDragDropEvent((event) => {
                const type = event.payload?.type;
                dropActive = type === 'enter' || type === 'over';
                if (type === 'drop') for (const p of event.payload.paths || []) attachPath(p);
            }).then(fn => {
                if (alive) unlisten = fn; else fn();
            }).catch(e => console.warn('Tauri drag-drop event registration failed:', e));
        } catch (e) {
            console.warn('Tauri drag-drop event registration failed:', e);
        }
        return () => { alive = false; unlisten?.(); };
    });

    // Delegated handlers for markup the markdown renderer produced — it emits no
    // inline `on*` attributes, so a strict CSP can be enforced.
    $effect(() => {
        if (!bodyEl) return;
        const onClick = (e) => {
            const img = e.target.closest?.('.chat-zoomable-img');
            if (img?.src) {
                const w = window.open();
                if (w) w.document.write(`<img src="${img.src.replace(/"/g, '&quot;')}" style="max-width:100%; height:auto;">`);
                return;
            }
            const link = e.target.closest?.('[data-open-path]');
            if (!link) return;
            e.preventDefault();
            const path = link.getAttribute('data-open-path');
            if (!path) return;
            invoke('open_path_default', { path }).catch(err => {
                console.error('Failed to open path:', path, err);
                link.classList.add('rv-open-error');
                link.title = `Could not open: ${err}`;
            });
        };
        bodyEl.addEventListener('click', onClick);
        return () => bodyEl.removeEventListener('click', onClick);
    });
</script>

<div class="view-container">
    <div class="chat-view-layout">
        <div class="chat-header">
            <div>
                <h1>Chat</h1>
                <p class="subtitle">Chat with AI (web search + relevant MCP tools available). Run agents from Monitor → New Task</p>
            </div>
            <div class="chat-header-actions">
                <select class="select chat-models-select" bind:value={selectedModel}
                    onchange={() => { llm.setCurrentModel?.(selectedModel); syncJsonMode(); }}>
                    {#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
                </select>
                <label class="chat-jsonmode-toggle"
                    title="このモデルはツール呼び出しにJSON形式を使う（native function-callが不安定なモデル向け）">
                    <input type="checkbox" checked={jsonMode}
                        onchange={(e) => toggleJsonMode(e.currentTarget.checked)}>
                    <span>JSON tools</span>
                </label>
                <button class="btn btn-primary btn-sm" onclick={startNewChat}>{@html icon('doc-plus', 14)} New Chat</button>
                <button class="btn btn-secondary btn-sm" onclick={() => { store = readStore(); showHistory = true; }}>
                    {@html icon('history', 14)} History
                </button>
                <button class="btn btn-secondary btn-sm" onclick={clearChat}>{@html icon('trash', 14)} Clear Chat</button>
            </div>
        </div>

        <div class="chat-system-prompt-container">
            <div class="chat-system-prompt-toggle" role="button" tabindex="0"
                onclick={() => (settingsExpanded = !settingsExpanded)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settingsExpanded = !settingsExpanded; } }}>
                <span>{@html icon('gear', 14)}</span> Chat Settings
            </div>
            {#if settingsExpanded}
                <div class="chat-system-prompt-panel chat-panel-open">
                    <div class="provider-card-fields chat-fields">
                        <div class="input-group">
                            <label class="input-label chat-label" for="chat-system-input">System Prompt</label>
                            <input id="chat-system-input" type="text" class="input" bind:value={systemPrompt}
                                placeholder="e.g. You are a helpful AI assistant.">
                        </div>
                        <div class="input-group chat-mcp-group">
                            <span class="input-label chat-label chat-label-strong">🔌 MCP Servers</span>
                            <p class="chat-mcp-note">Only MCP tools relevant to your message are sent automatically
                                (irrelevant ones are skipped). Web search is always available.</p>
                            <div class="chat-mcp-list">
                                {#if !mcpNames.length}
                                    <div class="chat-muted">No MCP servers configured in Settings.</div>
                                {:else}
                                    {#each mcpNames as name (name)}
                                        {@const running = mcpRunning.includes(name)}
                                        {@const err = mcpManager.getError?.(name)}
                                        <label class="chat-mcp-item">
                                            <input type="checkbox" class="chat-mcp-checkbox" checked={running}
                                                disabled={mcpBusy.includes(name)}
                                                onchange={(e) => toggleMcp(name, e.currentTarget.checked)}>
                                            <span>{name}</span>
                                            {#if running}
                                                <span class="chat-mcp-ok">🟢 {mcpManager.clients.get(name)?.tools?.length ?? 0}t</span>
                                            {:else if err}
                                                <button type="button" class="chat-mcp-err" title={err.message}
                                                    onclick={(e) => { e.preventDefault(); showMcpError(name); }}>⚠ Failed to start (details)</button>
                                            {/if}
                                        </label>
                                    {/each}
                                {/if}
                            </div>
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <div class="chat-body" bind:this={bodyEl}>
            <ChatMessages
                {messages}
                {notices}
                renderMarkdown={formatMessageContent}
                renderUserMarkdown={formatMarkdown}
            />

            {#if streaming}
                <div class="chat-message-row msg-ai">
                    <div class="message-bubble">
                        <div class="message-content">
                            {#if looksLikeToolCall(streamText)}
                                <!-- While a tool-call envelope is forming, show this rather than the
                                     raw JSON assembling itself in the transcript. -->
                                <span class="chat-stream-placeholder">🤔 Thinking or using tools…</span>
                            {:else}
                                {@html formatMessageContent(streamText)}
                            {/if}
                        </div>
                    </div>
                </div>
            {/if}

            {#if thinking}
                <div class="generating-indicator">
                    <div class="chat-thinking-row">
                        <div class="generating-dot"></div>
                        <div class="generating-dot"></div>
                        <div class="generating-dot"></div>
                        <span>{thinkingLabel}</span>
                    </div>
                </div>
            {/if}
        </div>

        <div class="chat-input-area-wrapper" class:chat-drop-active={dropActive}>
            {#if slashOpen}
                <div class="slash-popup">
                    <SlashPopup items={slashItems} selected={slashIndex} onPick={pickSlash} />
                </div>
            {/if}
            {#if activeSkills.length}
                <div class="chat-input-skills">
                    <SkillChips skills={activeSkills}
                        onRemove={(name) => (activeSkills = activeSkills.filter(s => s.name !== name))} />
                </div>
            {/if}
            {#if attachments.length}
                <div class="chat-input-previews">
                    <AttachmentPreviews {attachments}
                        onRemove={(id) => (attachments = attachments.filter(a => a.id !== id))} />
                </div>
            {/if}
            <div class="chat-input-container">
                <button class="btn-chat-attach" type="button" title="Attach image or file"
                    onclick={() => fileInputEl?.click()}>📎</button>
                <textarea
                    bind:this={textareaEl}
                    bind:value={draft}
                    class="chat-textarea"
                    rows="1"
                    placeholder="Type a message or / for commands… (Enter to send, Shift+Enter for new line)"
                    oninput={() => { grow(); updateSlash(draft); }}
                    onkeydown={onKeydown}
                    onpaste={onPaste}
                    onblur={() => setTimeout(closeSlash, 150)}
                ></textarea>
                <button class="btn-chat-send" class:btn-stop={isGenerating}
                    aria-label={isGenerating ? 'Stop generating' : 'Send message'}
                    disabled={!isGenerating && !canSend}
                    onclick={() => (isGenerating ? stop() : send())}>{isGenerating ? '🛑' : '➡️'}</button>
            </div>
            <input type="file" class="chat-file-input" multiple bind:this={fileInputEl}
                accept="image/*,text/*,.log,.json,.md,.js,.py,.rs"
                onchange={(e) => { for (const f of e.currentTarget.files || []) attach(f); e.currentTarget.value = ''; }}>
        </div>
    </div>
</div>

{#if showHistory}
    <HistoryModal
        sessions={sessionList}
        activeId={store.activeSessionId}
        onClose={() => (showHistory = false)}
        onPick={pickSession}
        onDelete={deleteSession}
        onClearAll={clearAllSessions}
    />
{/if}

<style>
    /* Layout and colours live in views/ChatView.styles.js, which the shell still
       emits — these are only the bits that were inline attributes before. */
    .chat-input-area-wrapper { position: relative; }
    .chat-drop-active { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    .chat-panel-open { display: block; }
    .chat-file-input { display: none; }
    .chat-fields { display: flex; flex-direction: column; gap: 12px; }
    .chat-label { font-size: 11px; margin-bottom: 4px; }
    .chat-label-strong { display: block; font-weight: 600; margin-bottom: 6px; }
    .chat-mcp-group { border-top: 1px solid var(--border-light); padding-top: 12px; }
    .chat-mcp-note { font-size: 11px; color: var(--text-tertiary); margin: 0 0 8px; }
    .chat-mcp-list { display: flex; flex-wrap: wrap; gap: 16px; }
    .chat-mcp-item { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
    .chat-mcp-item input { cursor: pointer; }
    .chat-muted { font-size: 11.5px; color: var(--text-tertiary); }
    .chat-mcp-ok {
        font-size: 10px; background: var(--accent); color: var(--text-inverse);
        border-radius: 4px; padding: 1px 5px; font-weight: 600;
    }
    .chat-mcp-err {
        font-size: 10px; background: var(--error, #c0392b); color: #fff; border: none;
        border-radius: 4px; padding: 1px 6px; font-weight: 600; cursor: pointer;
    }
    .chat-thinking-row { display: flex; gap: 6px; align-items: center; }
    .chat-stream-placeholder { font-size: 12.5px; color: var(--text-secondary); }
</style>
