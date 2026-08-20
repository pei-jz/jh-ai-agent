<!--
  MonitorRoot — the Monitor's layout and its chrome.

  The last step of the Svelte migration (docs/design/svelte-migration.md §5-E3).
  What it replaces is the pair of template strings `render()` and `_renderDetail()`
  returned, plus the handlers `_bindDetailEvents` re-attached to them by id after
  every re-render — and the twelve `_syncX()` / `_applyX()` helpers whose whole
  job was to write `style.display`, `textContent` or a class onto one of those
  elements from somewhere else in the file.

  Everything visible is now a prop. The view still owns the socket, the timeline
  and the log list — it computes one bag of props and pushes it — but it no
  longer holds a single element id for anything it draws.

  The leaves (TaskList, TaskHeader, Timeline, Inspector, HubStrip, RawLog,
  SteeringInput) are rendered HERE rather than mounted into hosts this file
  emits, so there is no shared-ownership seam left inside the Monitor.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { LEFT_VAR, INSP_VAR, dragWidth, isAtBottom } from '../../views/monitor/paneLayout.js';

    import TaskList from './TaskList.svelte';
    import TaskHeader from './TaskHeader.svelte';
    import Timeline from './Timeline.svelte';
    import Inspector from './Inspector.svelte';
    import HubStrip from './HubStrip.svelte';
    import RawLog from './RawLog.svelte';
    import SteeringInput from './SteeringInput.svelte';

    let {
        /** Everything the left column needs (TaskList's own props). */
        taskList = null,
        taskCount = 0,
        /** null until a task is selected — the right column shows a placeholder. */
        header = null,
        timeline = null,
        inspector = null,
        hub = null,
        rawLog = null,
        steer = null,

        listCollapsed = false,
        inspectorOpen = false,
        leftWidth = 240,
        inspWidth = 264,

        /** 'result' (the story) | 'all' (the raw telemetry). */
        filter = 'result',
        /** null while there is nothing to fold — the control hides itself. */
        foldAll = null,
        loading = false,
        /** { canLoadMore, note } — the row stays while a note is showing. */
        earlier = null,
        /** { text, collapsed } while a run is streaming, else null. */
        working = null,

        onNewTask = null,
        onFilter = null,
        onToggleList = null,
        onToggleInspector = null,
        onFoldAll = null,
        onLoadEarlier = null,
        onToggleWorking = null,
        onPanelClick = null,
        onPanelScroll = null,
        onWidths = null,
        /** ({scrollToBottom}) => void — the view follows new content through this. */
        onReady = null,
    } = $props();

    let panelEl = $state(null);
    /** The reader left the bottom, so new content must stop pulling the view. */
    let scrolledUp = $state(false);

    const hasTask = $derived(!!header);
    const pendingAsk = $derived((timeline?.items || []).find(i => i.kind === 'ask' && !i.answered) || null);

    function scrollToBottom() {
        if (!panelEl) return;
        panelEl.scrollTop = panelEl.scrollHeight;
        scrolledUp = false;
    }

    $effect(() => {
        onReady?.({ scrollToBottom, isAtBottom: () => isAtBottom(panelEl, 60) });
        return () => onReady?.(null);
    });

    function onScroll() {
        // The pill tracks the SCROLL POSITION, not the arrival of new content:
        // scrolling up to read is exactly when you want a way back down, even on
        // a finished task where nothing more is coming.
        const atBottom = isAtBottom(panelEl, 60);
        scrolledUp = !atBottom;
        onPanelScroll?.(atBottom);
    }

    /**
     * A drag is ONE session: the base width is snapshotted on pointerdown and
     * every move applies base ± dx. Adding dx to the LIVE width double-counted
     * it, so the pane ran ahead of the cursor.
     */
    function startDrag(edge) {
        return (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const base = edge === 'right' ? inspWidth : leftWidth;
            let latest = base;
            // Reached from the event rather than a `bind:this`: the binding is
            // populated by an effect, and a drag can begin in the same turn as
            // the mount — which is exactly when it would still be null.
            const layout = e.currentTarget.closest('.monitor-layout');
            const move = (ev) => {
                const w = dragWidth(base, ev.clientX - startX, edge);
                if (w === null) return;
                latest = w;
                // Written straight onto the layout root rather than through
                // state: a drag updates per pointer move, and a batched render
                // per frame would lag the cursor. The view is told the final
                // width on pointerup and pushes it back as a prop.
                layout?.style.setProperty(edge === 'right' ? INSP_VAR : LEFT_VAR, `${w}px`);
            };
            const end = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', end);
                document.body.classList.remove('resizing-panes');
                onWidths?.(edge === 'right' ? { insp: latest } : { left: latest });
            };
            document.body.classList.add('resizing-panes');
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', end);
        };
    }

    function jumpToAsk() {
        const el = panelEl?.querySelector(`[data-item-id="${pendingAsk?.id}"]`);
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
</script>

<!-- The panes size themselves from these custom properties (MonitorView.styles.js
     and monitor/timelineStyles.js), so the widths are written there rather than as
     an inline `width` — which looks right until the next render and then snaps back. -->
<div class="monitor-layout" style={`${LEFT_VAR}:${leftWidth}px;${INSP_VAR}:${inspWidth}px`}>
    <div class="mpanel-left" class:pane-hidden={listCollapsed}>
        <div class="mpanel-left-header">
            <span>Executions <span class="mpl-count">{taskCount}</span></span>
            <button class="btn btn-primary mpl-new" type="button" title="Create a new task"
                onclick={() => onNewTask?.()}>{@html icon('plus', 12)} New</button>
        </div>
        {#if taskList}<TaskList {...taskList} />{/if}
    </div>

    <!-- The 12px flex gap is the hit area; the divider itself is invisible. -->
    <div class="mpane-divider" title="Drag to resize the task list"
        role="separator" aria-orientation="vertical"
        onpointerdown={startDrag('left')}></div>

    <div class="mpanel-right">
        {#if !hasTask}
            <div class="mdetail-empty">
                <span class="mdetail-empty-icon">📊</span>
                <h3>Select a task</h3>
                <p>Choose an agent task from the left panel.</p>
            </div>
        {:else}
            <TaskHeader {...header} />

            <div class="mfilter-bar">
                <!-- "Story" is the narrative timeline; "Raw Log" is the unedited
                     telemetry. The old names said where the data came from, not
                     what you get. -->
                <button class="mfilter-btn" class:active={filter === 'result'} type="button"
                    data-filter="result" onclick={() => onFilter?.('result')}>
                    {@html icon('report', 13)} Story
                </button>
                <button class="mfilter-btn" class:active={filter === 'all'} type="button"
                    data-filter="all" onclick={() => onFilter?.('all')}>
                    {@html icon('code', 13)} Raw Log
                </button>
                {#if foldAll}
                    <!-- One control for every exchange at once. Per-exchange
                         folding is the marker beside each request; this is the
                         "show me the shape of the whole task" shortcut. -->
                    <button class="mfold-all" type="button" title={foldAll.title}
                        onclick={() => onFoldAll?.()}>{foldAll.label}</button>
                {/if}
                <button class="mpanel-toggle mfilter-spacer" class:active={!listCollapsed}
                    type="button" title="Show or hide the task list"
                    onclick={() => onToggleList?.()}>◧</button>
                <button class="mpanel-toggle" class:active={inspectorOpen} type="button"
                    title="Task details, token flow and chapter jumps"
                    onclick={() => onToggleInspector?.()}>◨</button>
            </div>

            <!-- Built only while it is the visible tab: rendering every log line
                 into a hidden panel is pure cost on a long task. -->
            <div class="mrawlog-slot" class:pane-hidden={filter !== 'all'}>
                {#if filter === 'all' && rawLog}<RawLog {...rawLog} />{/if}
            </div>

            <!-- ONE ordered stream: requests, reasoning groups, the deliverable,
                 narration and the ask_user question with its choices are all
                 items in the same list. -->
            <!-- The click handler is DELEGATION, not an interaction of its own:
                 the approval buttons and the zoomable images live inside the
                 timeline this panel scrolls, and they are real <button>/<img>
                 elements with their own keyboard behaviour. Binding here is what
                 fixed Approve/Reject doing nothing — the handler used to be
                 attached to a slot a redesign had deleted. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="mconsole mresult" class:pane-hidden={filter !== 'result'}
                bind:this={panelEl} onscroll={onScroll}
                role="log"
                onclick={(e) => onPanelClick?.(e)}>
                <!-- The surface a terminal-scoped agent cannot have, and it used
                     to be invisible. -->
                {#if hub?.apps?.some(a => a.intents.length || a.resources.length)}
                    <div class="hub-strip"><HubStrip {...hub} /></div>
                {/if}

                {#if earlier?.canLoadMore || earlier?.note}
                    <!-- Only the newest slice of a long task's logs is fetched on
                         open; the row stays while a note is showing so the outcome
                         of the last click does not vanish with the button. -->
                    <div class="mresult-earlier">
                        {#if earlier.canLoadMore}
                            <button class="btn btn-sm" type="button"
                                onclick={() => onLoadEarlier?.()}>↑ Load earlier</button>
                        {/if}
                        <div class="mresult-earlier-note">{earlier.note || ''}</div>
                    </div>
                {/if}

                {#if pendingAsk}
                    <div class="mask-pending" role="button" tabindex="0"
                        onclick={jumpToAsk}
                        onkeydown={(e) => { if (e.key === 'Enter') jumpToAsk(); }}>
                        {@html icon('question', 14)}<span>Waiting for your answer</span>
                        <span class="mask-pending-go">Go to the question ↓</span>
                    </div>
                {/if}

                {#if timeline}<div class="mtl"><Timeline {...timeline} /></div>{/if}

                {#if loading}
                    <div class="mload"><span class="mload-spin"></span>Loading results…</div>
                {/if}

                {#if working}
                    <div class="mresult-live-label" class:is-folded={working.collapsed}
                        role="button" tabindex="0" title="Toggle the activity log"
                        onclick={() => onToggleWorking?.()}
                        onkeydown={(e) => { if (e.key === 'Enter') onToggleWorking?.(); }}>
                        <span class="mll-dot"></span>
                        <span class="mll-text"> {working.text || '⏳ Working…'}</span>
                        <span class="mll-chev">▼</span>
                    </div>
                {/if}
            </div>

            <!-- Shown whenever the reader has scrolled up, not only when new
                 activity arrives. -->
            {#if scrolledUp && filter === 'result'}
                <button class="mresult-jump" type="button" onclick={scrollToBottom}>↓ Jump to latest</button>
            {/if}

            {#if steer}<SteeringInput {...steer} />{/if}
        {/if}
    </div>

    <!-- Hidden while the inspector is closed. -->
    {#if inspectorOpen}
        <div class="mpane-divider" title="Drag to resize the inspector"
            role="separator" aria-orientation="vertical"
            onpointerdown={startDrag('right')}></div>
        <!-- The inspector is its OWN column, a sibling of the story rather than a
             child of it: nested inside the scrolling panel it moved with the
             content, which defeats the point of a reference column. -->
        <aside class="mtl-insp">
            {#if inspector}<Inspector {...inspector} />{/if}
        </aside>
    {/if}
</div>

<style>
    .pane-hidden { display: none !important; }
    .mpl-count { font-weight: 400; opacity: 0.6; }
    .mpl-new { height: 24px; padding: 0 8px; font-size: 11px; font-weight: 600; }
    .mrawlog-slot { display: contents; }
</style>
