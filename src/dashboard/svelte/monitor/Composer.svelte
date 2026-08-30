<!--
  Composer — "what should the agent do?", at the top of the executions list.

  This is step 1 of docs/design/information-architecture.md: the box that used to
  live on the Dashboard now lives where the results appear. The Dashboard's
  launcher handed off by writing the prompt to localStorage and navigating to
  #monitor, which is what you write when two REGIONS of one screen have been
  split across two routes — so the box moved rather than the handoff getting a
  better channel.

  What this is NOT: a second creation path. Sending goes through
  views/monitor/createTask.js, the same function NewTaskModal calls, with the
  same payload assembly (newTaskRequest.js) and the same MCP start rule. What
  the modal still owns is the things this box deliberately does not ask for —
  agent mode, MCP selection, attachments — reachable here as "Details", which
  opens it pre-filled with whatever has been typed.

  Mode and MCP are inherited from the last create rather than defaulted, because
  the common case is a run of tasks in one project with one mode, and asking
  again each time is the friction this box exists to remove.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { AGENT_MODES, DEFAULT_MODE_ID } from '../../../modules/ai/AgentModes.js';
    import { mcpManager } from '../../../modules/ai/McpManager.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { skillManager } from '../../../modules/ai/SkillManager.js';
    import { SlashCommands } from '../../components/SlashCommands.js';
    import { validateNewTask, modeName, MODE_ICON } from '../../views/monitor/newTaskRequest.js';
    import { ASK, BUILD } from '../../../modules/ai/agent/InteractionMode.js';
    import { looksReadOnly } from '../../../modules/ai/agent/TaskComplexity.js';
    import { createTask } from '../../views/monitor/createTask.js';

    let {
        /** Seeded from the last create, or from a Dashboard handoff. */
        workspace = '',
        /** Prefill — a pending launch, a template pick, or the "＋" on a group. */
        presetPrompt = '',
        /**
         * Bumped by the view on every pick.
         *
         * Without it, choosing the SAME template twice is an unchanged string
         * and the effect below does not re-run — so the second pick appears to
         * do nothing.
         */
        presetSeq = 0,
        /** '' → DEFAULT_MODE_ID. Carried from the last create by the view. */
        modeId = '',
        /** Something is already running — changes the placeholder, nothing else. */
        busy = false,
        /** (taskId, {workspace, modeId}) => void */
        onCreated = null,
        /** ({prompt, ws}) => void — hand what is typed to the full modal. */
        onDetails = null,
        /**
         * Where this instance is mounted: 'rail' (the list column) or 'hero'
         * (the middle of an empty Work screen). Exactly ONE is mounted at a
         * time — see MonitorRoot. Two boxes would raise the question of which
         * one is the real one, and would need keeping in step.
         */
        place = 'rail',
        /**
         * The draft, OWNED BY THE VIEW.
         *
         * Lifted out of this component because the box moves between two mount
         * points: a component-local draft would be lost the moment the user
         * clicked a task while writing.
         */
        text = '',
        /** (value) => void — every keystroke. */
        onText = null,
        api = null,
        notify = (msg) => window.alert(msg),
    } = $props();

    const client = () => api ?? window.apiClient;
    const activeMode = $derived(modeId || DEFAULT_MODE_ID);
    const mode = $derived(AGENT_MODES[activeMode] || AGENT_MODES[DEFAULT_MODE_ID]);

    // Seeded ONCE. `untrack` marks the capture as deliberate — reading the prop
    // directly does the same thing but warns, and those warnings drown out the
    // ones that mean something. The $effects below re-seed while the field is
    // still untouched, so a workspace resolved late still lands.
    // Mirrors the prop; every write goes back out through onText so the view
    // stays the source of truth across a move.
    let prompt = $state(untrack(() => text || presetPrompt));
    /**
     * The last value this box and the view agreed on.
     *
     * The draft is CONTROLLED: the view owns it (because the box moves between
     * two mount points) and a view that ignores `onText` will lose it. What this
     * guards is narrower — a re-render carrying the SAME text must not re-assign
     * `prompt`, which would move the caret to the end mid-sentence. It
     * distinguishes "the view changed it" from "the view re-rendered".
     */
    let mirrored = untrack(() => text || presetPrompt);
    const setPrompt = (v) => { prompt = v; mirrored = v; onText?.(v); };
    $effect(() => {
        const incoming = text;
        untrack(() => {
            if (incoming === mirrored) return;
            mirrored = incoming;
            prompt = incoming;
        });
    });
    let ws = $state(untrack(() => workspace));
    let creating = $state(false);

    // The box is one line until it is being used. `open` is what reveals the
    // controls — an empty three-line textarea plus six controls made the column
    // look full before anything was in it.
    //
    // Tracked on the WHOLE composer, not the textarea. Pressing a button starts
    // with the textarea losing focus, so a textarea-scoped blur closed the box —
    // unmounting the very button being pressed — and the click never landed.
    // That is why every control "just reverted" the box.
    let focused = $state(false);
    // The hero placement is ALWAYS open: it is the only thing on the screen, so
    // there is nothing for the collapsed state to make room for — and a large
    // empty middle containing one thin closed line is what this exists to fix.
    const open = $derived(place === 'hero' || focused || !!prompt.trim());

    /**
     * The workspace as a NAME, not a path.
     *
     * Windows and POSIX separators both, because the field accepts whatever the
     * folder picker returned and the user may have pasted the other kind. The
     * full path is still the button's title — this only changes what is shown.
     */
    const wsName = $derived(
        String(ws || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
    );

    // ── The interaction axis: asked, or given a job? ────────────────────────
    //
    // `looksReadOnly`, NOT `looksComplex`. The two answer different questions and
    // this used the wrong one:
    //
    //   looksComplex   — "does this need a PLAN?" Deliberately conservative, so
    //                    "MCP の再接続を直して" is false: it is work, but it is
    //                    not multi-step work.
    //   looksReadOnly  — "is this about producing an ANSWER rather than a
    //                    change?" Which is exactly this axis.
    //
    // With the wrong one, a short work request guessed `ask`, and an `ask` run
    // gets read-only tools — so it would have been unable to do the job it was
    // given. Both live in agent/TaskComplexity.js, so the chip and the plan-first
    // gate still cannot drift apart.
    //
    // Always overridable: "short but do it" and "long but just asking" are both
    // ordinary, and a guess the user cannot correct is worse than no guess.
    let pickedInteraction = $state(null);
    const guessed = $derived(looksReadOnly(prompt) ? ASK : BUILD);
    const interaction = $derived(pickedInteraction ?? guessed);

    // Loaded here rather than pushed in as props, so the view does not have to
    // carry config it has no other use for — the same shape NewTaskModal uses.
    // The MCP default is "whatever is running", which is what the modal defaults
    // to as well: a task started from this box gets the servers the user already
    // brought up, and the modal is where that selection gets changed.
    let projects = $state([]);
    let mcpServers = $state({});
    let selectedMcp = $state([]);

    $effect(() => {
        let alive = true;
        (async () => {
            let config = {};
            try { config = (await invoke('get_ai_config')) || {}; } catch (_) { /* not under Tauri */ }
            if (!alive) return;
            projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
            mcpServers = config.mcp_servers || {};
            selectedMcp = Object.keys(mcpServers).filter(n => mcpManager.clients.has(n));
            promptTemplateManager.loadFromConfig(config);
            skillManager.refresh().catch(() => {});
            if (!ws) ws = projects[0] || '';
        })();
        return () => { alive = false; };
    });

    let taEl = $state(null);
    let popupEl = $state(null);
    let chipsEl = $state(null);
    let slash = null;

    let wsSeeded = $state(false);
    $effect(() => {
        if (!wsSeeded && workspace) { ws = workspace; wsSeeded = true; }
    });

    // A handoff arriving after mount (navigate → Work with a queued launch) has
    // to reach the box. Only when it is empty: never overwrite live typing.
    $effect(() => {
        const p = presetPrompt;
        presetSeq;                                  // dependency, deliberately
        if (!p) return;
        untrack(() => {
            // Never over what is being written: a template is a starting point,
            // and clobbering a half-typed prompt with one is worse than ignoring
            // the pick.
            if (prompt.trim()) return;
            setPrompt(p);
            queueMicrotask(() => { grow(); taEl?.focus(); });
        });
    });

    $effect(() => {
        if (!taEl || !popupEl || !chipsEl) return;
        slash = new SlashCommands(taEl, popupEl, chipsEl);
        return () => { slash?.destroy(); slash = null; };
    });

    function grow() {
        if (!taEl) return;
        taEl.style.height = 'auto';
        // 30 closed (one line), 60 open (room to see what you are writing), 180
        // ceiling. The floor changes with `open` so the box visibly makes room
        // when you start rather than reserving it in advance.
        const floor = open ? 60 : 30;
        taEl.style.height = Math.min(180, Math.max(floor, taEl.scrollHeight)) + 'px';
    }

    // Re-measure when the box opens or closes, or when it is re-mounted in the
    // other place, so the height follows the state rather than waiting for the
    // next keystroke.
    $effect(() => { open; place; prompt; queueMicrotask(grow); });

    async function send() {
        if (creating) return;
        const raw = prompt.trim();
        const hasContent = slash ? slash.hasContent(raw) : !!raw;
        const check = validateNewTask({ hasContent, workspace: ws, interaction });
        if (!check.ok) {
            if (check.reason) notify(check.reason);
            // The workspace is no longer a field here — a missing one is fixed
            // in the modal that owns it, so that is where the user is sent.
            if (check.field === 'workspace') onDetails?.({ prompt: prompt.trim(), ws: ws.trim(), interaction });
            else taEl?.focus();
            return;
        }

        const body = slash ? await slash.buildPrompt(raw) : raw;
        creating = true;
        try {
            const id = await createTask({
                prompt: body,
                workspace: ws,
                modeId: activeMode,
                selectedMcp,
                mcpServers,
                interaction,
                client: client(),
                caller: 'Composer',
            });
            setPrompt('');
            pickedInteraction = null;
            queueMicrotask(grow);
            onCreated?.(id, { workspace: ws.trim(), modeId: activeMode });
        } catch (e) {
            notify('Failed to create task: ' + (e.message || e));
        } finally {
            creating = false;
        }
    }

    function onKeydown(e) {
        // While the "/" popup is up those keys are its own.
        if (popupEl && popupEl.style.display !== 'none'
            && ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        // Enter sends, Shift+Enter is a newline. `isComposing` keeps an IME
        // candidate selection from submitting — the failure this app must never
        // have, since Japanese is its first language.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
        }
    }

    async function browse() {
        try {
            const sel = await invoke('select_folder');
            if (sel) ws = sel;
        } catch (_) { /* cancelled */ }
    }
</script>

<!--
  Layout: one input, one row of TWO controls, one line of text.

  What it replaces: six controls on one row — the ask/build pair, a full-path
  workspace field, a folder button, the agent-mode button and send — inside a
  240px column. Everything was at its minimum width, so nothing had room and the
  eye had six places to land before the box you actually type in.

  Three decisions get it back:

    1. The workspace shows its BASENAME. `C:\cusor_workspace\jh-ai-agent` is
       thirty characters of noise on a box you use in one project all day; the
       full path is the title. This alone frees most of the row.
    2. Only what you CHANGE per task stays a control — the interaction chip and
       send. Workspace and mode become a status line: they are read far more
       often than set, so they read as text and open the picker when pressed.
    3. The box is one line until you use it. An empty three-line textarea makes
       the column feel full before anything is in it.
-->
<div class="mcomp mcomp-{place}" class:is-open={open}
    onfocusin={() => { focused = true; queueMicrotask(grow); }}
    onfocusout={(e) => {
        // Only when focus leaves the composer ENTIRELY. `relatedTarget` is null
        // when focus goes nowhere (a click on dead space), which is a real exit.
        if (!e.currentTarget.contains(e.relatedTarget)) focused = false;
    }}>
    <div class="mcomp-chips" bind:this={chipsEl}></div>
    <div class="mcomp-ta-wrap">
        <textarea
            bind:this={taEl}
            value={prompt}
            oninput={(e) => { setPrompt(e.currentTarget.value); grow(); }}
            class="mcomp-ta"
            rows="1"
            placeholder={busy ? 'もう一件依頼する…' : '何をしますか？'}
            onkeydown={onKeydown}
            disabled={creating}
        ></textarea>
        <div class="slash-popup mcomp-slash" bind:this={popupEl}></div>
    </div>

    {#if open}
        <div class="mcomp-row">
            <!-- Two states of one control, not two buttons: exactly one is always
                 on, and pressing the active one is a no-op rather than a toggle
                 to "neither". -->
            <span class="mcomp-int" role="group" aria-label={t('composer.interaction')}>
                <button type="button" class="mcomp-int-btn is-ask"
                    aria-pressed={interaction === ASK}
                    title="聞く — 読み取り専用・計画なし・すぐ答える"
                    onclick={() => (pickedInteraction = ASK)}>聞く</button>
                <button type="button" class="mcomp-int-btn is-build"
                    aria-pressed={interaction === BUILD}
                    title="頼む — 計画を先に・フルツール"
                    onclick={() => (pickedInteraction = BUILD)}>頼む</button>
            </span>
            <!-- "送信", not the mode's own word: the chip beside it already says
                 which kind of run this is, and labelling this one 聞く put the
                 same word on two controls that do different things. -->
            <button type="button" class="mcomp-send" onclick={send} disabled={creating}>
                {creating ? '…' : '送信'}
            </button>
        </div>

        <!--
          Where it will run and how, as a sentence rather than as fields. Pressing
          it opens the modal that owns all of it (workspace, mode, MCP,
          attachments) — one target instead of three, and the two things it shows
          are the two the user would check before sending.
        -->
        <button type="button" class="mcomp-ctx"
            title={`${ws || '(no workspace)'} · ${modeName(mode)}`}
            onclick={() => onDetails?.({ prompt: prompt.trim(), ws: ws.trim(), interaction })}>
            {@html icon('folder', 11)}
            <span class="mcomp-ctx-ws">{wsName || 'ワークスペース未設定'}</span>
            <span class="mcomp-ctx-sep">·</span>
            {@html icon(MODE_ICON[mode?.id] || 'gear', 11)}
            <span class="mcomp-ctx-mode">{modeName(mode)}</span>
            <span class="mcomp-ctx-more">⋯</span>
        </button>

    {/if}
</div>
