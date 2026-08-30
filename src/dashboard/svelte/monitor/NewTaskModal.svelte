<!--
  NewTaskModal — "New Task".

  Replaces MonitorView._openNewTaskModal: 315 lines that injected a <style> block
  into document.head on first open, built the dialog as one innerHTML string with
  every rule written as an inline style attribute, appended it to document.body,
  then re-queried its own markup to attach handlers — and rebuilt the attachment
  strip from scratch (innerHTML plus a re-bound remove listener per item) after
  every add or remove.

  What the payload contains is monitor/newTaskRequest.js, and reading a file into
  an attachment is chat/chatAttachments.js — the modal had its own copy of the
  latter, with the same 10MB cap and the same three-way image/spreadsheet/text
  decision written out a second time.

  SlashCommands stays as it is: an imperative helper bound to the textarea. It is
  shared with the steering input, it owns its own popup, and it is attached here
  through an $effect rather than reimplemented.
-->
<script>
    import { untrack } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { AGENT_MODES, DEFAULT_MODE_ID } from '../../../modules/ai/AgentModes.js';
    import { ASK, BUILD } from '../../../modules/ai/agent/InteractionMode.js';
    import { looksReadOnly } from '../../../modules/ai/agent/TaskComplexity.js';
    import { mcpManager } from '../../../modules/ai/McpManager.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { skillManager } from '../../../modules/ai/SkillManager.js';
    import { SlashCommands } from '../../components/SlashCommands.js';
    import { icon } from '../../utils/icons.js';
    import { readAttachment } from '../../views/chat/chatAttachments.js';
    import {
        attachmentBlocks, validateNewTask, modeName, MODE_ICON,
    } from '../../views/monitor/newTaskRequest.js';
    import { createTask } from '../../views/monitor/createTask.js';

    let {
        /** An explicit workspace — the "＋" on a workspace group header wins over the default. */
        presetWs = null,
        presetPrompt = '',
        /** 'ask' | 'build' carried in from the composer's chip, or null. */
        presetInteraction = null,
        /** Remembered from the last create, so the next one starts where you left off. */
        lastWs = '',
        lastMode = '',
        onClose = null,
        /** (taskId, {workspace, modeId}) => void — the view navigates and remembers. */
        onCreated = null,
        api = null,
        notify = (msg) => window.alert(msg),
        onZoom = null,
    } = $props();

    const client = () => api ?? window.apiClient;
    const modes = Object.values(AGENT_MODES);

    let workspace = $state('');
    let projects = $state([]);
    let mcpServers = $state({});
    let selectedMcp = $state([]);
    // Seeded ONCE, deliberately — see ConnectionModal.svelte for the full note.
    // `untrack` says so to the compiler; reading the prop directly does the same
    // thing but warns that only the initial value is captured, and those warnings
    // drown out the ones that mean something.
    // (The dialog is mounted fresh on every open, so "once" is once per open.)
    let modeId = $state(untrack(() => lastMode || DEFAULT_MODE_ID));

    // The interaction axis, same rules as the composer: inferred from the text
    // with `looksReadOnly`, always overridable. It has to be HERE too, not only
    // in the composer — "Details" is a superset of that box, and a run created
    // through it would otherwise always be `build`, silently ignoring the chip
    // the user had just set.
    let pickedInteraction = $state(untrack(() => (presetInteraction || null)));
    const interaction = $derived(pickedInteraction ?? (looksReadOnly(prompt) ? ASK : BUILD));
    let prompt = $state(untrack(() => presetPrompt || ''));
    let attachments = $state([]);
    let creating = $state(false);
    let dragOver = $state(false);

    let textareaEl = $state(null);
    let popupEl = $state(null);
    let chipsEl = $state(null);
    let wsInputEl = $state(null);
    let fileInputEl = $state(null);
    let slash = null;

    const modeDesc = $derived(AGENT_MODES[modeId]?.description || '');
    const mcpNames = $derived(Object.keys(mcpServers));

    $effect(() => {
        let alive = true;
        (async () => {
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (!alive) return;
            projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
            mcpServers = config.mcp_servers || {};
            selectedMcp = mcpNames.filter(n => mcpManager.clients.has(n));
            workspace = presetWs || lastWs || projects[0] || '';
            promptTemplateManager.loadFromConfig(config);
            skillManager.refresh().catch(() => {});
        })();
        return () => { alive = false; };
    });

    // The "/" popup. Templates EXPAND into the box; skills ATTACH as chips whose
    // bodies are injected at send time by buildPrompt().
    $effect(() => {
        if (!textareaEl || !popupEl || !chipsEl) return;
        slash = new SlashCommands(textareaEl, popupEl, chipsEl);
        return () => { slash?.destroy(); slash = null; };
    });

    $effect(() => {
        if (!textareaEl) return;
        // Caret at the END so continuing to type appends rather than overwrites
        // what the launcher already collected.
        const at = textareaEl.value.length;
        try { textareaEl.setSelectionRange(at, at); textareaEl.focus(); } catch (_) {}
    });

    // Files dropped from Explorer. HTML5 drop gives no OS path inside Tauri, so
    // the window event (which carries paths) is what this listens to.
    $effect(() => {
        let unlisten = null;
        let alive = true;
        try {
            getCurrentWebviewWindow().onDragDropEvent((event) => {
                const t = event.payload?.type;
                dragOver = t === 'enter' || t === 'over';
                if (t === 'drop') for (const p of event.payload.paths || []) attachPath(p);
            }).then(fn => { if (alive) unlisten = fn; else fn(); }).catch(() => {});
        } catch (_) { /* not under Tauri */ }
        return () => { alive = false; unlisten?.(); };
    });

    async function attach(file) {
        const res = await readAttachment(file, { invoke });
        if (!res.ok) { notify(res.reason); return; }
        attachments = [...attachments, res.attachment];
    }

    async function attachPath(path) {
        try {
            const fd = await invoke('read_file_bytes', { path });
            const ext = String(fd.ext || '').toLowerCase();
            const mime = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
            }[ext] || 'application/octet-stream';
            await attach(new File([new Blob([fd.bytes && new Uint8Array(fd.bytes)], { type: mime })], fd.name, { type: mime }));
        } catch (e) {
            console.error('Dropped file read failed:', e);
        }
    }

    function toggleMcp(name, on) {
        selectedMcp = on ? [...new Set([...selectedMcp, name])] : selectedMcp.filter(n => n !== name);
    }

    async function browse() {
        try {
            const sel = await invoke('select_folder');
            if (sel) workspace = sel;
        } catch (_) { /* cancelled */ }
    }

    async function create() {
        if (creating) return;
        const raw = prompt.trim();
        const hasContent = slash ? slash.hasContent(raw) : (!!raw || attachments.length > 0);
        const check = validateNewTask({ hasContent: hasContent || attachments.length > 0, workspace, interaction });
        if (!check.ok) {
            if (check.reason) notify(check.reason);
            (check.field === 'workspace' ? wsInputEl : textareaEl)?.focus();
            return;
        }

        const files = attachments.filter(a => a.type !== 'image');
        const images = attachments.filter(a => a.type === 'image').map(a => a.dataUrl);
        const body = (slash ? await slash.buildPrompt(raw) : raw) + attachmentBlocks(files);

        creating = true;
        try {
            // Shared with the composer at the top of the list — see
            // views/monitor/createTask.js. Two entries, one creation path.
            const taskId = await createTask({
                prompt: body, workspace, modeId, selectedMcp, mcpServers, images,
                interaction,
                client: client(),
            });
            onCreated?.(taskId, { workspace: workspace.trim(), modeId });
        } catch (e) {
            notify('Failed to create task: ' + (e.message || e));
            creating = false;
        }
    }

    function onKeydown(e) {
        // Enter / Escape / arrows belong to the "/" popup while it is open.
        if (popupEl && popupEl.style.display !== 'none'
            && ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); }
        if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    }
</script>

<!-- The id is how Ctrl+N knows the dialog is already open. -->
<div
    id="mnt-modal-overlay"
    class="nt-overlay"
    role="button"
    tabindex="-1"
    onmousedown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }}
>
    <div class="nt-modal-box" class:nt-drag={dragOver} role="dialog" aria-label="New Task">
        <div class="nt-head">
            <strong><span class="nt-head-ico">{@html icon('bolt')}</span>New Task</strong>
            <button class="nt-close" type="button" aria-label="Close" onclick={() => onClose?.()}>✖</button>
        </div>

        <div class="nt-body">
            <div>
                <label class="input-label nt-label" for="nt-ws">Workspace (required for agent tasks)</label>
                <div class="nt-ws-row">
                    <!--
                      A real list, not an autocomplete.

                      `<datalist>` looked like a dropdown but behaved like a
                      suggestion popup: it filtered as you typed, hid itself when
                      nothing matched, and gave no way to just SEE the approved
                      projects — which is what anyone opening it actually wants.
                      A <select> shows them, and the browse button covers the
                      case a list cannot (a folder that is not approved yet).

                      The current value is included as an option even when it is
                      not an approved project, so the field can display a path
                      the picker returned.
                    -->
                    <select id="nt-ws" class="input cfg-grow" bind:value={workspace}>
                                                <!-- Always present, not only while empty: an option
                             that appears and disappears cannot be selected, so
                             there was no way to CLEAR a workspace once set. -->
                        <option value="">(ワークスペースを選択)</option>
                        {#if workspace && !projects.includes(workspace)}
                            <option value={workspace}>{workspace}</option>
                        {/if}
                        {#each projects as p (p)}<option value={p}>{p}</option>{/each}
                    </select>
                    <button class="btn btn-secondary nt-browse" type="button" onclick={browse}>{@html icon('folder')}</button>
                </div>
            </div>

            <div>
                <span class="input-label nt-label">この依頼の種類</span>
                <div class="nt-mode-group">
                    <button type="button" class="nt-int-btn" class:sel={interaction === ASK}
                        title="読み取り専用・計画なし・すぐ答える。ワークスペースは任意"
                        onclick={() => (pickedInteraction = ASK)}>
                        <span class="nt-mode-name">聞く</span>
                    </button>
                    <button type="button" class="nt-int-btn" class:sel={interaction === BUILD}
                        title="計画を先に・フルツール。ワークスペースが要る"
                        onclick={() => (pickedInteraction = BUILD)}>
                        <span class="nt-mode-name">頼む</span>
                    </button>
                </div>
            </div>

            <div>
                <span class="input-label nt-label">Agent mode</span>
                <div class="nt-mode-group">
                    {#each modes as mo (mo.id)}
                        <button type="button" class="nt-mode-btn" class:sel={mo.id === modeId}
                            data-id={mo.id} title={mo.description || ''}
                            onclick={() => (modeId = mo.id)}>
                            <span class="nt-mode-ico">{@html icon(MODE_ICON[mo.id] || 'gear')}</span>
                            <span class="nt-mode-name">{modeName(mo)}</span>
                        </button>
                    {/each}
                </div>
                <div class="nt-mode-desc">{modeDesc}</div>
            </div>

            <div>
                <span class="input-label nt-label">MCP servers to use (optional)</span>
                <div class="nt-mcp-box">
                    {#if !mcpNames.length}
                        <div class="nt-muted">No MCP servers configured (Settings → MCP).</div>
                    {:else}
                        {#each mcpNames as name (name)}
                            <label class="nt-mcp-item">
                                <input type="checkbox" class="nt-mcp-cb" data-name={name}
                                    checked={selectedMcp.includes(name)}
                                    onchange={(e) => toggleMcp(name, e.currentTarget.checked)}>
                                <span>{name}</span>
                            </label>
                        {/each}
                    {/if}
                </div>
            </div>

            <div class="nt-prompt-wrap">
                <div class="nt-prompt-head">
                    <label class="input-label nt-label nt-label-inline" for="nt-prompt">
                        Task <span class="nt-hint">(/ to expand a template or attach a skill)</span>
                    </label>
                    <button class="btn btn-secondary nt-attach" type="button" title="Attach image or file"
                        onclick={() => fileInputEl?.click()}>📎 Attach</button>
                    <input type="file" class="nt-file-input" bind:this={fileInputEl} multiple
                        accept="image/*,text/*,.log,.json,.md,.js,.py,.rs,.csv,.xlsx,.xls"
                        onchange={(e) => { for (const f of e.currentTarget.files || []) attach(f); e.currentTarget.value = ''; }}>
                </div>

                <div class="sc-chips nt-chips" bind:this={chipsEl}></div>

                {#if attachments.length}
                    <div class="nt-previews">
                        {#each attachments as a (a.id)}
                            <div class="nt-prev" class:nt-prev-file={a.type !== 'image'} data-id={a.id}>
                                {#if a.type === 'image'}
                                    <img src={a.dataUrl} alt={a.name} onclick={() => onZoom?.(a.dataUrl)}
                                        role="presentation">
                                {:else}
                                    <span>📄</span><span class="nt-prev-name">{a.name}</span>
                                {/if}
                                <button class="nt-prev-x" type="button" title="Remove"
                                    onclick={() => (attachments = attachments.filter(x => x.id !== a.id))}>✕</button>
                            </div>
                        {/each}
                    </div>
                {/if}

                <div class="slash-popup nt-slash" bind:this={popupEl}></div>
                <textarea id="nt-prompt" class="input nt-prompt" rows="8" bind:this={textareaEl}
                    bind:value={prompt} onkeydown={onKeydown}
                    onpaste={(e) => { for (const it of e.clipboardData?.items || []) if (it.type.includes('image')) attach(it.getAsFile()); }}
                    placeholder="Describe the task to run…  (/ for commands, Ctrl+Enter to create, paste images too)"
                ></textarea>
            </div>
        </div>

        <div class="nt-foot">
            <button class="btn btn-secondary nt-cancel" type="button" onclick={() => onClose?.()}>Cancel</button>
            <button class="btn btn-primary nt-send" type="button" disabled={creating} onclick={create}>
                {creating ? 'Creating…' : 'Create & Run ▶'}
            </button>
        </div>
    </div>
</div>

<style>
    .nt-overlay {
        position: fixed; inset: 0; z-index: 4000;
        background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
    }
    .nt-modal-box {
        position: relative;
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-3);
        width: 720px; max-width: 94vw;
        height: 80vh; min-height: 420px; min-width: 520px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        resize: both;
    }
    .nt-modal-box::-webkit-resizer { background: var(--ink-faint); border-radius: var(--r-1); }
    .nt-drag { outline: 2px dashed var(--accent); outline-offset: -4px; }

    .nt-head {
        padding: 10px 16px; flex-shrink: 0;
        border-bottom: 1px solid var(--line); background: var(--surface-sunken);
        display: flex; justify-content: space-between; align-items: center;
    }
    .nt-head strong { font-size: 14px; display: flex; align-items: center; gap: 7px; }
    .nt-head-ico { color: var(--accent); display: inline-flex; }
    .nt-close { background: none; border: none; color: var(--ink); cursor: pointer; font-size: 18px; }

    .nt-body {
        padding: 10px 16px; flex: 1; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 10px;
    }
    .nt-label { font-size: 11px; }
    .nt-label-inline { margin: 0; }
    .nt-hint { opacity: 0.6; }
    .nt-ws-row { display: flex; gap: 8px; }
    .nt-ws { flex: 1; }
    .nt-browse { padding: 0 12px; display: flex; align-items: center; }

    .nt-mode-group { display: flex; flex-wrap: wrap; gap: 6px; }
    .nt-int-btn,
    .nt-mode-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 12px; border-radius: var(--r-2); cursor: pointer;
        background: var(--surface-sunken); border: 1px solid var(--line);
        color: var(--ink-soft); font-size: 12px; user-select: none;
        transition: border-color .12s, background .12s, color .12s;
    }
    .nt-int-btn:hover,
    .nt-mode-btn:hover { border-color: var(--line-focus); color: var(--ink); }
    .nt-int-btn.sel,
    .nt-mode-btn.sel { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .nt-mode-ico { display: inline-flex; }
    .nt-mode-desc { margin-top: 6px; font-size: 11.5px; color: var(--ink-soft); line-height: 1.5; }

    .nt-mcp-box {
        display: flex; flex-wrap: wrap; gap: 10px;
        padding: 6px 10px; border: 1px solid var(--line-soft);
        border-radius: var(--r-2); background: var(--surface-sunken);
    }
    .nt-mcp-item {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; cursor: pointer; user-select: none;
    }
    .nt-muted { font-size: 11.5px; color: var(--ink-faint); }

    .nt-prompt-wrap { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .nt-prompt-head { display: flex; justify-content: space-between; align-items: center; }
    .nt-attach { height: 24px; padding: 0 8px; font-size: 11px; display: flex; align-items: center; gap: 4px; }
    .nt-file-input { display: none; }
    .nt-chips { margin-top: 6px; }
    .nt-slash { display: none; }
    .nt-prompt {
        width: 100%; flex: 1; min-height: 120px; resize: none;
        font-size: 13.5px; line-height: 1.6; margin-top: 6px;
    }

    .nt-previews { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .nt-prev {
        position: relative; padding: 4px;
        border: 1px solid var(--line); border-radius: var(--r-2); background: var(--surface-sunken);
    }
    .nt-prev img { width: 40px; height: 40px; object-fit: cover; border-radius: var(--r-2); display: block; cursor: zoom-in; }
    .nt-prev-file {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 20px 4px 8px; font-size: 11px;
        color: var(--ink-soft); max-width: 180px;
    }
    .nt-prev-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nt-prev-x {
        position: absolute; top: -6px; right: -6px;
        background: var(--error); border: none; color: #fff;
        width: 16px; height: 16px; border-radius: 50%;
        font-size: 9px; cursor: pointer; line-height: 1;
    }
    .nt-prev-file .nt-prev-x {
        top: 2px; right: 2px; width: auto; height: auto;
        background: none; color: var(--error); font-size: 10px; border-radius: 0;
    }

    .nt-foot {
        padding: 10px 16px; flex-shrink: 0;
        border-top: 1px solid var(--line);
        display: flex; justify-content: flex-end; gap: 8px;
    }
</style>
