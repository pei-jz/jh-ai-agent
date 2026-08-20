<!--
  RawLog — the unedited telemetry, grouped into steps.

  This replaces TWO implementations of the same thing. `renderAllLogs` built the
  whole panel as a string on demand, while `connectWebSocket` maintained the SAME
  structure incrementally: `insertAdjacentHTML` for each new step, a
  `querySelectorAll('.mstep:not(#mstep-init)')` per event to find the last one,
  `dataset.thoughtSummary` / `dataset.lastTool` stashed on the element to carry
  state between events, and `_finalizePreviousStep` reading the summary back out
  of the DOM to decide what a collapsed step should say.

  Two bugs came from that shape and are recorded where they were fixed:
  content was once routed by the user's EXPAND state (`.mstep-header.expanded`),
  so clicking an old step to read it sent every later event into that step and
  left the real one empty; and the CHAT button was attached the same way.

  Here there is one model — monitor/logs.js `buildLogSteps` over the log list,
  which the replay path already used — and expand state is a set of indexes that
  cannot influence it.
-->
<script>
    import { buildLogSteps, chatButtonLabel, requestDividerHtml } from '../../views/monitor/logs.js';
    import { extractThoughtSummary, isChatLog } from '../../views/monitorLogFormat.js';

    let {
        logs = [],
        /**
         * Bumped by the view when it has appended to `logs`.
         *
         * The list is mutated in place (a push per packet), so its identity never
         * changes and a $derived over it alone would never recompute.
         */
        version = 0,
        /** The label the step in flight should carry, from monitor/stepStatus.js. */
        liveStatus = null,
        /** (log) => html — the per-line formatter still lives with the view. */
        formatLine = () => '',
        formatTime = (t) => String(t ?? ''),
        onOpenChat = null,
        /**
         * (event) => boolean — the approval card's own controls.
         *
         * The card is markup the view builds (monitor/confirmCards.js) and is
         * shared with the Story surface, so its buttons are delegated rather
         * than bound. Losing this handler in the migration is what left Approve
         * and Reject dead in the raw log.
         */
        onCardClick = null,
        /** (requestNum) => string — the request's own prompt, shown on its divider. */
        dividerPreview = () => '',
        /** 'all' | 'result' — CSS hides the lines that do not match. */
        filter = 'all',
    } = $props();

    const model = $derived.by(() => {
        version;                        // the dependency that actually changes
        const dividers = new Map();
        let n = 0;
        const built = buildLogSteps(logs, {
            lineHtmlFor: formatLine,
            isChatLog,
            extractThoughtSummary,
            formatTime,
            onRequestDivider: (num) => { n = num; },
        });
        built.requestStepIndexes.forEach((stepIdx, i) => dividers.set(stepIdx, i + 1));
        return { ...built, dividers, requestCount: n };
    });

    /**
     * Which steps are expanded, by index.
     *
     * `null` means "not chosen yet", which renders as: the newest step open and
     * the rest collapsed. The predecessor achieved that by collapsing the
     * previous step by hand every time a new one began.
     */
    let opened = $state(null);

    const isOpen = (i, last) => (opened ? opened.has(i) : i === last);

    function toggle(i, last) {
        const next = new Set(opened ?? (last >= 0 ? [last] : []));
        if (next.has(i)) next.delete(i); else next.add(i);
        opened = next;
    }

    let rootEl = $state(null);

    /** Open or close a disclosure, and turn its arrow to match. */
    function toggleDetail(target, arrow) {
        if (!target) return;
        const open = target.classList.toggle('open');
        if (arrow) arrow.textContent = open ? '▼' : '▶';
    }

    // Controls INSIDE a formatted line: the thought detail, a tool's result, a
    // telemetry row and its Request/Response/Headers tabs.
    //
    // The lines arrive as HTML from the view's formatter (monitorLogFormat.js),
    // so their controls cannot be ordinary handlers — this is the one place
    // delegation is still right. All four used to live in one handler on
    // #console-logs; keeping only the first when that handler moved here is what
    // made a TOOL row stop opening.
    $effect(() => {
        if (!rootEl) return;
        const onClick = (e) => {
            const t = e.target;
            if (!t?.closest) return;

            // The approval card first: its buttons sit inside a step body, and
            // every other branch below would treat them as ordinary content.
            if (onCardClick?.(e)) { e.stopPropagation(); return; }

            // A telemetry tab — checked first, because it sits INSIDE the body a
            // header click would otherwise close.
            const tab = t.closest('.mlog-tele-tab');
            if (tab) {
                e.stopPropagation();
                const uid = tab.getAttribute('data-uid');
                const which = tab.getAttribute('data-tab');
                tab.closest('.mlog-tele-tabs')?.querySelectorAll('.mlog-tele-tab')
                    .forEach(x => x.classList.toggle('active', x === tab));
                const content = rootEl.querySelector(`#tele-content-${uid}`);
                content?.querySelectorAll('.tele-pane').forEach(pane => {
                    pane.style.display = pane.classList.contains(`tele-${which}-${uid}`) ? 'block' : 'none';
                });
                return;
            }

            // An explicit ▶ button, or the thought summary line that stands in
            // for it (the arrow alone is a small target).
            const btn = t.closest('.mlog-expand-btn')
                || t.closest('.mlog-thought-summary')?.querySelector('.mlog-expand-btn');
            if (btn) {
                e.stopPropagation();
                toggleDetail(rootEl.querySelector(`#${btn.getAttribute('data-target')}`), btn);
                return;
            }

            // The whole tool row opens its result.
            const toolRow = t.closest('.mlog-tool-row');
            if (toolRow) {
                e.stopPropagation();
                const uid = toolRow.getAttribute('data-uid');
                toggleDetail(rootEl.querySelector(`#tool-result-${uid}`),
                    toolRow.querySelector('.mlog-expand-btn'));
                return;
            }

            // The telemetry header opens the payload below it.
            const teleHeader = t.closest('.mlog-tele-header');
            if (teleHeader) {
                e.stopPropagation();
                toggleDetail(teleHeader.nextElementSibling, teleHeader.querySelector('span:last-child'));
            }
        };
        rootEl.addEventListener('click', onClick);
        return () => rootEl.removeEventListener('click', onClick);
    });
</script>

<div class="mconsole" bind:this={rootEl} data-current-filter={filter}>
    {#if !logs.length}
        <div class="mconsole-placeholder">Waiting for execution logs...</div>
    {:else}
        {#if model.init.length}
            <!-- Events before the first step: project scan, workspace setup. -->
            <div class="mstep" id="mstep-init">
                <div class="mstep-header" class:expanded={isOpen('init', -2)}
                    role="button" tabindex="0"
                    onclick={() => toggle('init', model.steps.length - 1)}
                    onkeydown={(e) => { if (e.key === 'Enter') toggle('init', model.steps.length - 1); }}>
                    <span class="mstep-toggle">{isOpen('init', -2) ? '▼' : '▶'}</span>
                    <span class="mstep-num">Init</span>
                    <span class="mstep-summary">Initialization</span>
                </div>
                <div class="mstep-body" class:open={isOpen('init', -2)}>
                    {#each model.init as line, i (i)}{@html line}{/each}
                </div>
            </div>
        {/if}

        {#each model.steps as step, i (`${step.stepId}-${i}`)}
            {@const last = model.steps.length - 1}
            {@const open = isOpen(i, last)}
            {@const chat = step.chatEntries.length ? chatButtonLabel(step.chatEntries) : null}
            {#if model.dividers.has(i)}
                {@html requestDividerHtml(model.dividers.get(i), dividerPreview(model.dividers.get(i)))}
            {/if}
            <div class="mstep">
                <div class="mstep-header" class:expanded={open}
                    role="button" tabindex="0"
                    onclick={() => toggle(i, last)}
                    onkeydown={(e) => { if (e.key === 'Enter') toggle(i, last); }}>
                    <span class="mstep-toggle">{open ? '▼' : '▶'}</span>
                    {#if i === last && liveStatus}<span class="mstep-pulse"></span>{/if}
                    <span class="mstep-num">Step {step.stepId}</span>
                    <!-- The step in flight shows what it is DOING; a finished one
                         shows what it achieved (its thought), which is why the
                         live label is an override rather than part of the model. -->
                    <span class="mstep-summary">{(i === last && liveStatus?.text) || step.summary}</span>
                    {#if chat}
                        <button class="mstep-chat-btn" class:err={chat.isError} type="button"
                            onclick={(e) => { e.stopPropagation(); onOpenChat?.(step.chatEntries); }}
                        >{chat.text}</button>
                    {/if}
                    <span class="mstep-time">{step.time}</span>
                </div>
                <div class="mstep-body" class:open>
                    {#each step.lines as line, li (li)}{@html line}{/each}
                </div>
            </div>
        {/each}
    {/if}
</div>
