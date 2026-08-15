<!--
  TimelineItem — one chapter of the story.

  Replaces cardHtml() + bindItem() from views/monitor/timelineItems.js: ~200 lines
  of string concatenation and a 72-line function that re-attached listeners to
  freshly-written innerHTML after every render. Every handler now sits on the
  element it belongs to, so a re-render cannot separate them.

  ── On state, and a trap worth naming ──────────────────────────────────────────
  This component owns NO fold state. `isCollapsed` is the model's flag, passed in as
  its own prop, and a click reports upward through `onToggleCollapse`.

  It is a separate prop rather than a field on `item` so the items can stay
  REFERENCE-STABLE across renders. Spreading them to stamp a flag made every step look
  changed on every streamed line, which on a long run cost ~30ms a line instead of ~5.

  It is worth saying why, because the obvious shortcut is wrong: an earlier version
  seeded a local `$state` from the prop and wrote back to the item. That broke TWO
  things at once. The model flips `collapsed` ITSELF — opening a new step folds every
  earlier one, and a completed run folds them all — so a component holding its own
  copy never saw those and the steps silently stopped auto-folding. And writing back
  into a prop is a mutation of state this component does not own, which Svelte
  correctly warns about (`ownership_invalid_mutation`).

  Exchange-level folding was always shaped this way: it belongs to the exchange, not
  the card, so it goes through `onToggleStory` and comes back as `_folded` /
  `_bodyless`. Card-level folding now matches.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import {
        chapterTag, chapterKind, deliverableLabel, toolChipList, itemClass,
        spanOf, spanLabel, wordCount,
    } from '../../views/monitor/timelineItems.js';
    import { clockText } from '../../views/monitor/taskTimeline.js';
    import StepLine from './StepLine.svelte';
    import StatChips from './StatChips.svelte';
    import FileList from './FileList.svelte';

    let {
        item,
        /** Folded? Owned by the model, passed in — never cached here. */
        isCollapsed = false,
        /** Markdown → HTML. Injected so the view owns the renderer. */
        renderMarkdown = (t) => String(t ?? ''),
        workspace = '',
        onToggleStory = null,
        /** (itemId) => void — fold/unfold THIS card. The model owns the flag. */
        onToggleCollapse = null,
        onAnswer = null,
        /** (item) => void — re-arm the reply box for a question left unanswered. */
        onReopenAsk = null,
        onCopyDoc = null,
        onOpenFile = null,
    } = $props();

    const kind = $derived(chapterKind(item));
    const tag = $derived(chapterTag(item));
    const tools = $derived(toolChipList(item.lines));
    const lineCount = $derived((item.lines || []).length);
    // Two-digit step numbers so the column of them stays aligned.
    const stepNo = $derived(item._stepNo ? String(item._stepNo).padStart(2, '0') : '–');

    /** Multi-select answers, local until submitted. */
    let picked = $state([]);
    const togglePick = (opt, on) => {
        picked = on ? [...picked, opt] : picked.filter(p => p !== opt);
    };

    // Read, never owned — see the note above.
    const collapsed = $derived(!!isCollapsed);
    /** The clamped request text opens on click. Genuinely component-local: nothing
        outside cares, and the model has no opinion about it. */
    let requestOpen = $state(false);
    /** Minimised to ONE line — the sticky request is fixed furniture above the
        story, so on a narrow window the user must be able to shrink it to a
        sliver and give the reading surface the room. Independent of `requestOpen`
        (which chooses between 3 lines and the full text); `is-min` wins. */
    let requestMin = $state(false);

    const toggleCollapsed = () => onToggleCollapse?.(item.id);

    /** Status icon for one task_progress row — drawn, not emoji, like every
        other marker in the story (emoji render differently per machine). */
    const progressIcon = (status) => ({
        pending: 'circle', in_progress: 'pulse', completed: 'check', blocked: 'alert',
    }[status] || 'circle');

    /**
     * A card with a foldable header. When the card belongs to an exchange, folding
     * goes through the exchange's state so it survives the next render; a
     * standalone card folds itself.
     */
    const foldOutcome = () => {
        if (item._ex !== undefined && onToggleStory) onToggleStory(item._ex, 'outcome');
        else toggleCollapsed();
    };
</script>

<!-- The wrapper row. `collapsed` and `is-open` live here because the CSS that
     acts on them (clamping the request, hiding a step body) is written against
     the chapter, not the card. -->
<div
    class={itemClass(item)}
    class:collapsed
    class:is-open={requestOpen}
    class:is-min={requestMin}
    data-item-id={item.id}
>

<!-- The heading row. Steps and bare lines get none — see chapterTag. -->
{#if tag}
    <div class="tl-when">
        {#if item.at}<span class="tl-clock">{clockText(item.at)}</span>{/if}
        <span class="tl-tag tl-tag-{kind}">{tag}</span>
    </div>
{/if}

{#if item._bodyless}
    <!-- A folded exchange's RESULT, rendered as its header alone rather than as a
         full card with display:none. That is what makes a long task open quickly:
         the markdown of every past exchange no longer has to be parsed to show a
         line that says "Agent · Final". -->
    {@const d = item.kind === 'run'
        ? { icon: 'report', label: 'Agent · Final' }
        : deliverableLabel(item.envKind, 'Deliverable')}
    {@const words = wordCount(item.text || item.answer)}
    <button type="button" class="tl-fold-bar tl-fold-out"
        data-unfold-ex={item._ex}
        onclick={() => onToggleStory?.(item._ex, 'outcome')}>
        {@html icon(d.icon)}<span class="tl-fold-n">{d.label}</span>
        {#if words}<span class="tl-fold-dur">{words} words</span>{/if}
        <span class="tl-fold-hint">Show result</span>
    </button>

{:else if item.kind === 'request'}
    <!-- A REAL button for the marker. It used to be the chapter's ::before, and a
         pseudo-element takes no clicks — so the "fold the story" affordance never
         fired at all. -->
    <button type="button" class="tl-story-toggle" class:is-folded={item._folded}
        title="Fold or unfold this exchange's working"
        onclick={() => onToggleStory?.(item._ex, 'working')}></button>
    <div class="tl-card tl-card-request"
        class:is-min={requestMin}
        onclick={() => { if (requestMin) { requestMin = false; requestOpen = true; } else { requestOpen = !requestOpen; } }}
        role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') { if (requestMin) { requestMin = false; requestOpen = true; } else { requestOpen = !requestOpen; } } }}>
        <div class="tl-q-label">
            <span>Your request</span>
            <!-- Minimise / restore: the sticky request is tall fixed furniture;
                 this gives it a one-line sliver. stopPropagation so the toggle
                 does not also flip the open/closed state. -->
            <button type="button" class="tl-request-min"
                title={requestMin ? 'Expand the request' : 'Minimise the request'}
                onclick={(e) => { e.stopPropagation(); requestMin = !requestMin; if (!requestMin) requestOpen = true; }}>
                {@html icon(requestMin ? 'plus' : 'minus')}
            </button>
        </div>
        <div class="tl-q-text">{item.text}</div>
        {#if item.images?.length}
            <div class="mrc-imgs">
                {#each item.images as src, i (i)}
                    <img class="mrc-img" {src} alt="attachment">
                {/each}
            </div>
        {/if}
    </div>

{:else if item.kind === 'fold'}
    <!-- What a folded exchange leaves behind: enough to decide whether to open
         it, in one line. -->
    {@const dur = spanLabel(spanOf(item.at, item.to))}
    <button type="button" class="tl-fold-bar" data-unfold-ex={item.ex}
        onclick={() => onToggleStory?.(item.ex, 'working')}>
        {@html icon('steps')}<span class="tl-fold-n">{item.steps || item.n} steps</span>
        {#if dur}<span class="tl-fold-dur">{dur}</span>{/if}
        <span class="tl-fold-hint">Show working</span>
    </button>

{:else if item.kind === 'turn'}
    <!-- A boundary between exchanges. Without it the previous run's steps ran
         straight into the next request and looked like its working. -->
    <div class="tl-turn"><span class="tl-turn-label">
        {item.n ? `Request ${item.n}` : 'New request'}</span></div>

{:else if item.kind === 'group'}
    <!-- The step list is a TRACE — diagnostic, not the point. The head carries a
         step count so a folded group still says what happened. -->
    <div class="tl-card tl-card-step">
        <div class="tl-step-title mtask-group-head" title={item.head?.text}
            role="button" tabindex="0"
            onclick={toggleCollapsed}
            onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed(); }}>
            <span class="tl-step-num" class:is-live={item.live}>{stepNo}</span>
            <span class="tl-step-sum">{item.head?.text}</span>
            {#if tools.chips.length}
                <span class="tl-step-tools">
                    {#each tools.chips as c (c.tool)}
                        <span class="tl-tchip" class:is-write={c.write} title={c.tool}>
                            {@html icon(c.icon)} {c.tool}</span>
                    {/each}
                    {#if tools.more > 0}<span class="tl-tchip is-more">+{tools.more}</span>{/if}
                </span>
            {/if}
            {#if lineCount}<span class="tl-step-count">{lineCount}</span>{/if}
            {#if item.at}<span class="tl-step-at">{clockText(item.at)}</span>{/if}
            <span class="tl-step-chev">▼</span>
        </div>
        <div class="tl-step-body mtask-group-body">
            {#each (item.lines || []) as line, i (i)}
                <StepLine {line} {onOpenFile} />
            {/each}
        </div>
    </div>

{:else if item.kind === 'activity'}
    <!-- A bare line, not a framed step — see chapterKind('activity'). -->
    <div class="tl-bare-line"><StepLine line={item} {onOpenFile} /></div>

{:else if item.kind === 'error'}
    <div class="tl-card tl-card-error">
        <div class="mtask-feed-item is-error" title={item.text}>
            <span class="mtask-feed-ic">{@html icon('alert')}</span>
            <span class="mtask-feed-tx">{item.text}</span>
        </div>
    </div>

{:else if item.kind === 'narration'}
    <div class="tl-card tl-card-note">
        <div class="tl-note-label">The agent's note</div>
        <div class="rv-summary chat-md">{@html renderMarkdown(item.text)}</div>
    </div>

{:else if item.kind === 'task_progress'}
    <!-- The agent's subtask checklist, as its own chapter. Unlike a step, it
         folds on its OWN — clicking the header toggles just this card via the
         model's collapsed flag (onToggleCollapse), never the exchange's working.
         The header always shows the live tally so a folded card still says how
         far the plan got. -->
    {@const done = (item.items || []).filter(t => t.status === 'completed').length}
    {@const total = (item.items || []).length}
    <div class="tl-card tl-card-progress">
        <div class="tl-card-h tl-fold-h" role="button" tabindex="0"
            onclick={toggleCollapsed}
            onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed(); }}>
            {@html icon('steps')} task_progress ({done}/{total} complete)
            <span class="tl-card-chev">▼</span>
        </div>
        <div class="tl-card-body tl-progress-body">
            {#each (item.items || []) as t (t.id)}
                <div class="tl-progress-row" class:is-done={t.status === 'completed'}>
                    <span class="tl-progress-ic">{@html icon(progressIcon(t.status))}</span>
                    <span class="tl-progress-id">[{t.id}]</span>
                    <span class="tl-progress-title">{t.title}</span>
                    {#if t.note}<span class="tl-progress-note">({t.note})</span>{/if}
                </div>
            {/each}
        </div>
    </div>

{:else if item.kind === 'run'}
    <div class="tl-card tl-card-final">
        <div class="tl-card-h tl-fold-h" role="button" tabindex="0"
            onclick={foldOutcome}
            onkeydown={(e) => { if (e.key === 'Enter') foldOutcome(); }}>
            {@html icon('report')} Agent · Final
            <span class="tl-card-chev">▼</span>
        </div>
        <div class="tl-card-body">
            <div class="rv-summary chat-md">
                {@html renderMarkdown(String(item.answer || '').trim() || '(no answer)')}</div>
            <FileList files={item.files} {workspace} {onOpenFile} />
            <StatChips stats={item.stats} />
        </div>
    </div>

{:else if item.kind === 'deliverable' || item.kind === 'document'}
    <!-- Both use the same card shell as every other chapter, so they fold like
         them AND the markdown styling (scoped to .tl-card) actually reaches them.
         `document` additionally offers a copy button: the deliverable is meant to
         leave the app. -->
    {@const d = deliverableLabel(item.envKind, item.kind === 'document' ? 'Deliverable' : 'Result')}
    <div class="tl-card tl-card-deliverable">
        <div class="tl-card-h tl-fold-h" role="button" tabindex="0"
            onclick={foldOutcome}
            onkeydown={(e) => { if (e.key === 'Enter') foldOutcome(); }}>
            {@html icon(d.icon)} {d.label}
            {#if item.kind === 'document'}
                <button type="button" class="tl-doc-copy" title="Copy the body"
                    onclick={(e) => { e.stopPropagation(); onCopyDoc?.(item.text); }}
                >{@html icon('clipboard')}</button>
            {/if}
            <span class="tl-card-chev">▼</span>
        </div>
        <div class="tl-card-body">
            <div class="rv-summary chat-md">{@html renderMarkdown(item.text)}</div>
            {#if item.kind === 'document'}
                <FileList files={item.files} {workspace} {onOpenFile} />
                <StatChips stats={item.stats} />
            {/if}
        </div>
    </div>

{:else if item.kind === 'ask'}
    <!-- Question AND choices in ONE card. Previously the question lived in the
         activity feed — collapsed at exactly this moment — while the buttons sat
         in a separate slot near the input box, and a free-text question produced
         no card at all. -->
    {#if item.answered}
        <div class="mask-box is-answered">
            <div class="mask-q">{@html icon('question')} {item.text}</div>
            {#if item.unanswered}
                <!-- Closed by replay because the run ended, not because anyone
                     replied. Saying "answered" here would be a small lie about the
                     user's own history. -->
                <div class="mask-answered is-none">— 未回答のまま終了しました</div>
                <!-- …but the question is still the only thing the run is paused on,
                     so reopening the task must offer a way INTO answering it: the
                     reply goes through the ordinary reply box (which continues the
                     task), with the question as its placeholder. Without this the
                     card was a dead end and the task could never be resumed. -->
                <div class="mask-actions">
                    <button type="button" class="btn btn-primary btn-sm mask-reopen"
                        onclick={() => onReopenAsk?.(item)}>この質問に答えてタスクを続ける</button>
                </div>
            {:else}
                <div class="mask-answered">↩ {item.answer || '(answered)'}</div>
            {/if}
        </div>
    {:else}
        {@const opts = item.options || []}
        <div class="mask-box is-open">
            <div class="mask-q">{@html icon('question')} {item.text}</div>
            {#if opts.length}
                <div class="mask-opts" class:is-multi={item.multi}>
                    {#each opts as o, i (i)}
                        {#if item.multi}
                            <label class="mask-check">
                                <input type="checkbox" value={o} data-i={i}
                                    onchange={(e) => togglePick(o, e.currentTarget.checked)}>
                                <span>{o}</span>
                            </label>
                        {:else}
                            <button class="btn mask-opt" data-ans={o}
                                onclick={() => onAnswer?.(o)}>{o}</button>
                        {/if}
                    {/each}
                </div>
            {/if}
            {#if item.multi && opts.length}
                <div class="mask-actions">
                    <button class="btn btn-primary btn-sm mask-submit"
                        onclick={() => { if (picked.length) onAnswer?.(picked.join(', ')); }}
                    >Submit</button>
                </div>
            {/if}
            <div class="mask-hint">
                {#if !opts.length}Answer in the box below
                {:else if item.multi}Select any that apply and submit, or type an answer below
                {:else}Click to answer, or type one below{/if}
            </div>
        </div>
    {/if}

{:else if item.kind === 'confirm'}
    <!-- The approval card's markup is built by MonitorView._fmtConfirm and its
         buttons are handled by the delegated _onConfirmCardClick on #result-panel.
         Not yet migrated: it is shared with the Raw Log surface, so it moves when
         that one does. -->
    <div class="mresult-confirm-box">{@html item.text}</div>
{/if}
</div>

