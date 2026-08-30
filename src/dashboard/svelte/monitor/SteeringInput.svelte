<!--
  SteeringInput — the box under a task.

  Replaces the 200-line steering block inside MonitorView._bindDetailEvents plus
  the markup it bound to. Two things made that shape expensive:

  • Its enabled/placeholder state was written from SEVEN places by id
    (`document.getElementById('input-steering')`, then `.disabled` and
    `.placeholder`), each re-deriving the same three sentences. `enabled` and
    `placeholder` are props now, and the sentences come from
    monitor/liveEvents.js `steerPlaceholder`.
  • It carried the THIRD copy of the attachment reader — the same 10MB cap and
    the same image/spreadsheet/text decision already written in ChatView and in
    the New Task modal. It uses chat/chatAttachments.js like the other two.

  SlashCommands stays imperative and is attached to the textarea through an
  $effect: it owns its own popup, and it is shared with the New Task modal.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { invoke } from '@tauri-apps/api/core';
    import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { SlashCommands } from '../../components/SlashCommands.js';
    import { readAttachment } from '../../views/chat/chatAttachments.js';
    import { hasSomethingToSend } from '../../views/monitor/steering.js';

    let {
        enabled = false,
        placeholder = 'Steer the agent... (Ctrl+Enter to send, / for skills)',
        showStop = false,
        /** Focus the box — the agent asked a question and is waiting on it. */
        focusRequest = 0,
        /** ({text, expandedPrompt, attachments}) => Promise<boolean> — true clears the box. */
        onSend = null,
        onStop = null,
        onZoom = null,
        /**
         * (api|null) => void. The view needs three things the box owns: put text
         * in it, and send. Those used to be done by reaching for the textarea by
         * id, assigning `.value`, and clicking the Send button — which is how the
         * "answer this question" card submitted an answer.
         */
        onReady = null,
        notify = (msg) => window.alert(msg),
    } = $props();

    let draft = $state('');
    let attachments = $state([]);
    let dragOver = $state(false);
    let stopping = $state(false);
    let sending = $state(false);

    let textareaEl = $state(null);
    let popupEl = $state(null);
    let chipsEl = $state(null);
    let fileInputEl = $state(null);
    let slash = null;
    // Mirrored into state because SlashCommands mutates its own array, which
    // Svelte cannot observe — and a skill ALONE is a valid message, so whether
    // Send is usable depends on it.
    let activeSkills = $state([]);

    const canSend = $derived(enabled && !sending && hasSomethingToSend({
        text: draft, attachments, activeSkills,
    }));

    $effect(() => {
        if (!textareaEl || !popupEl || !chipsEl) return;
        try {
            slash = new SlashCommands(textareaEl, popupEl, chipsEl, {
                onSkillsChange: (skills) => { activeSkills = skills; },
            });
        } catch (err) {
            // A missing template store must not cost the user the whole box.
            console.error('Failed to init SlashCommands:', err);
        }
        return () => { slash?.destroy(); slash = null; };
    });

    $effect(() => {
        onReady?.({
            compose(text, mode = 'append') {
                draft = mode === 'replace'
                    ? String(text ?? '')
                    : (draft ? `${draft.replace(/\s*$/, '')} ${text}` : String(text ?? ''));
                queueMicrotask(() => { grow(); try { textareaEl?.focus(); } catch (_) {} });
            },
            submit: () => send(),
        });
        return () => onReady?.(null);
    });

    // A question is waiting: put the caret where the answer goes. Driven by a
    // counter rather than a boolean so a second question re-focuses.
    $effect(() => {
        if (!focusRequest || !textareaEl || !enabled) return;
        try { textareaEl.focus(); } catch (_) {}
    });

    // Files dropped from Explorer. HTML5 drop carries no OS path inside Tauri.
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
            await attach(new File([new Blob([new Uint8Array(fd.bytes)], { type: mime })], fd.name, { type: mime }));
        } catch (e) {
            console.error('Dropped file read failed:', e);
        }
    }

    /** Grow with the content up to the CSS max, then scroll inside. */
    function grow() {
        if (!textareaEl) return;
        textareaEl.style.height = 'auto';
        textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + 'px';
    }

    function reset() {
        draft = '';
        attachments = [];
        if (textareaEl) textareaEl.style.height = '';   // back to one row
        if (slash) { slash.activeSkills = []; slash._renderChips(); }
        activeSkills = [];
    }

    async function send() {
        if (!canSend) return;
        sending = true;
        try {
            const text = draft.trim();
            const expandedPrompt = slash ? await slash.buildPrompt(text) : text;
            const ok = await onSend?.({ text, expandedPrompt, attachments });
            if (ok !== false) reset();
        } finally {
            sending = false;
        }
    }

    function stop() {
        stopping = true;
        onStop?.();
    }

    // Only Ctrl+Enter sends: Enter and Shift+Enter insert newlines, because a
    // steering message is often a paragraph.
    function onKeydown(e) {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); send(); }
    }
</script>

<div class="msteering-wrapper" class:steer-drag={dragOver}>
    <div class="msteering-top">
        <!-- SlashCommands fills this and owns its display; the component only
             provides the host. -->
        <div class="msteering-skills chat-input-skills" bind:this={chipsEl}></div>
        {#if attachments.length}
            <div class="msteering-previews steer-shown">
                {#each attachments as a (a.id)}
                    <div class="nt-prev" class:nt-prev-file={a.type !== 'image'}>
                        {#if a.type === 'image'}
                            <img src={a.dataUrl} alt={a.name} role="presentation"
                                onclick={() => onZoom?.(a.dataUrl)}>
                        {:else}
                            <span>📄</span><span class="nt-prev-name">{a.name}</span>
                        {/if}
                        <button class="nt-prev-x" type="button" title={t('common.remove')}
                            onclick={() => (attachments = attachments.filter(x => x.id !== a.id))}>✕</button>
                    </div>
                {/each}
            </div>
        {/if}
    </div>

    <div class="msteering-input-row">
        <button type="button" class="steer-btn-icon steer-attach-btn" title={t('common.attach')}
            disabled={!enabled} onclick={() => fileInputEl?.click()}>📎</button>
        <input type="file" class="steer-file-input" multiple bind:this={fileInputEl}
            onchange={(e) => { for (const f of e.currentTarget.files || []) attach(f); e.currentTarget.value = ''; }}>
        <textarea
            id="input-steering"
            bind:this={textareaEl}
            bind:value={draft}
            rows="1"
            {placeholder}
            disabled={!enabled}
            oninput={grow}
            onkeydown={onKeydown}
            onpaste={(e) => { for (const it of e.clipboardData?.items || []) if (it.type.includes('image')) attach(it.getAsFile()); }}
        ></textarea>
        <button class="btn btn-primary btn-sm" type="button" disabled={!canSend} onclick={send}>{t('common.send')}</button>
        {#if showStop}
            <button class="btn btn-error btn-sm" type="button" title={t('task.stop')}
                disabled={stopping} onclick={stop}>{stopping ? 'Stopping…' : '⏹ Stop'}</button>
        {/if}
    </div>

    <div class="slash-popup steer-slash" bind:this={popupEl}>
        <div class="slash-popup-list"></div>
    </div>
</div>

<style>
    /* Layout lives in MonitorView.styles.js; these are the rules that used to be
       written as inline styles or toggled from JS. */
    .steer-drag { outline: 2px dashed var(--accent); outline-offset: -4px; }
    .steer-file-input { display: none; }
    .msteering-skills { display: none; }
    .msteering-previews { display: none; flex-wrap: wrap; gap: 8px; }
    .msteering-previews.steer-shown { display: flex; }
    .steer-slash {
        display: none;
        bottom: 100%; top: auto; max-height: 200px;
        z-index: 1000; margin-bottom: 4px; left: 10px; right: 10px;
    }

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
</style>
