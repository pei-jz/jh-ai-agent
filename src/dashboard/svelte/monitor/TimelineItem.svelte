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
    import { t } from '../../../i18n/index.js';
    import {
        chapterTag, chapterKind, deliverableLabel, toolChipList, itemClass,
        spanOf, spanLabel, wordCount,
    } from '../../views/monitor/timelineItems.js';
    import { clockText } from '../../views/monitor/taskTimeline.js';
    import { chapterTally } from '../../views/monitor/storyChapters.js';
    import { outcomeLine, resultStats, splitLead } from '../../views/monitor/storyExchanges.js';

    const NL = String.fromCharCode(10);
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
        onShowRaw = null,
        onOpenExchange = null,
    } = $props();

    /** A digest row's status mark. Drawn icons, like every other marker here. */
    const DIGEST_ICON = { done: 'check', waiting: 'question', running: 'pulse', failed: 'alert', stopped: 'circle' };

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

    /**
     * Plan-revision input state. The approval card's ✏️ option ("Request
     * changes") does NOT send the option text verbatim — that would read to the
     * agent as "修正したい" and the continuation would just start editing.
     * Instead it opens this textarea; the typed revision is sent as the answer
     * with an explicit marker so the agent RE-PRESENTS the plan for a second
     * approval.
     */
    let revising = $state(false);
    let revisionText = $state('');
    const isReviseOption = (opt) => String(opt || '').startsWith('✏️');
    const pickOption = (opt) => {
        if (isReviseOption(opt)) { revising = true; revisionText = ''; return; }
        onAnswer?.(opt);
    };
    const submitRevision = () => {
        const txt = revisionText.trim();
        if (!txt) return;
        onAnswer?.(`✏️ 計画修正: ${txt}`);
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

    /**
     * Is the request PINNED to the top of the panel?
     *
     * Minimising made it a sliver; it still held the top of the column. Reading
     * a long result on a short window is the case that wants it gone entirely,
     * so this un-sticks it and lets it scroll away with everything else.
     *
     * Remembered, because it is a reading preference rather than a per-task one:
     * someone who wants the full height wants it on the next task too.
     */
    let requestPinned = $state((() => {
        try { return localStorage.getItem('jhai_request_pinned') !== '0'; } catch (_) { return true; }
    })());
    const setPinned = (on) => {
        requestPinned = on;
        try { localStorage.setItem('jhai_request_pinned', on ? '1' : '0'); } catch (_) { /* private mode */ }
    };

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
    class:is-unpinned={!requestPinned}
    class:is-bodyless={!!item._bodyless}
    class:is-story-result={!!item._story}
    data-item-id={item.id}
>

<!-- The heading row. Steps and bare lines get none — see chapterTag. -->
{#if tag}
    <div class="tl-when">
        {#if item.at}<span class="tl-clock">{clockText(item.at)}</span>{/if}
        {#if item._story}
            <!-- The label IS the fold control, like the folded row's "› 結果":
                 the header band it used to live on is gone. -->
            <button type="button" class="tl-tag tl-tag-{kind} tl-result-toggle" aria-expanded="true"
                title={t('story.fold')} onclick={foldOutcome}>{@html icon('chevron-down', 12)}{t(`story.tag.${kind}`, null, tag)}</button>
            <span class="tl-phase-meta">{wordCount(item.kind === 'run' ? item.answer : item.text)} words</span>
        {:else}
            <span class="tl-tag tl-tag-{kind}">{t(`story.tag.${kind}`, null, tag)}</span>
        {/if}
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
    {@const gist = outcomeLine(item.text ?? item.answer)}
    <!-- Same shape as a chapter (label column + one line) rather than a dashed
         box: folded, the result is one more line of the story. -->
    <div class="tl-phase-side">
        <button type="button" class="tl-phase-label tl-outcome-label tl-result-toggle" aria-expanded="false"
            title={t('task.showResult')}
            onclick={() => onToggleStory?.(item._ex, 'outcome')}>{@html icon('chevron-right', 12)}{d.label === 'Agent · Final' ? t('story.tag.final') : d.label}</button>
        {#if words}<span class="tl-phase-meta">{words} words</span>{/if}
    </div>
    <button type="button" class="tl-outcome-row tl-fold-out"
        data-unfold-ex={item._ex}
        onclick={() => onToggleStory?.(item._ex, 'outcome')}>
        <span class="tl-outcome-gist">{gist || d.label}</span>
        <span class="tl-fold-hint">{t('task.showResult')}</span>
    </button>

{:else if item.kind === 'request'}
    <!-- A REAL button for the marker. It used to be the chapter's ::before, and a
         pseudo-element takes no clicks — so the "fold the story" affordance never
         fired at all. -->
    <button type="button" class="tl-story-toggle" class:is-folded={item._folded}
        title={t('task.foldExchange')}
        onclick={() => onToggleStory?.(item._ex, 'working')}></button>
    <div class="tl-card tl-card-request"
        class:is-min={requestMin}
        onclick={() => { if (requestMin) { requestMin = false; requestOpen = true; } else { requestOpen = !requestOpen; } }}
        role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') { if (requestMin) { requestMin = false; requestOpen = true; } else { requestOpen = !requestOpen; } } }}>
        <div class="tl-q-label">
            <span>{t('task.yourRequest')}</span>
            <!-- Minimise / restore: the sticky request is tall fixed furniture;
                 this gives it a one-line sliver. stopPropagation so the toggle
                 does not also flip the open/closed state. -->
            <span class="tl-request-acts">
                <!-- Unpin: let the request scroll away, so a long result gets the
                     whole column. Minimising only ever made it a shorter piece of
                     fixed furniture. -->
                <button type="button" class="tl-request-act"
                    title={requestPinned ? '固定を解除（スクロールで隠れる）' : '上部に固定する'}
                    aria-pressed={requestPinned}
                    onclick={(e) => { e.stopPropagation(); setPinned(!requestPinned); }}>
                    {@html icon(requestPinned ? 'pin' : 'pin-off', 12)}
                </button>
                <button type="button" class="tl-request-act"
                    title={requestMin ? 'Expand the request' : 'Minimise the request'}
                    onclick={(e) => { e.stopPropagation(); requestMin = !requestMin; if (!requestMin) requestOpen = true; }}>
                    {@html icon(requestMin ? 'plus' : 'minus', 12)}
                </button>
            </span>
        </div>
        <div class="tl-q-text">{item.text}</div>
        {#if item.images?.length}
            <div class="mrc-imgs">
                {#each item.images as src, i (i)}
                    <img class="mrc-img" {src} alt={t('common.attachment')}>
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
        <span class="tl-fold-hint">{t('task.showWorking')}</span>
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

{:else if item.kind === 'digest'}
    <!-- A folded exchange, as one line (storyExchanges.js). Clicking opens the
         whole exchange — both halves. -->
    {@const dur = spanLabel(spanOf(item.at, item.to))}
    <button type="button" class="tl-digest-row is-{item.status}" title={item.text}
        onclick={() => onOpenExchange?.(item.ex)}>
        <span class="tl-digest-st" title={t(`story.status.${item.status}`)}>{@html icon(DIGEST_ICON[item.status] || 'circle', 14)}</span>
        <span class="tl-digest-req">{item.text}</span>
        {#if item.path.length}
            <span class="tl-digest-path">{item.path.map(r => r === '…' ? r : t(`story.role.${r}`)).join(' → ')}</span>
        {/if}
        <span class="tl-digest-out">{item.outcome}</span>
        {#if dur}<span class="tl-digest-dur">{dur}</span>{/if}
        <span class="tl-digest-chev">›</span>
    </button>
{:else if item.kind === 'phase'}
    <!-- A Story chapter: what a run of steps DID, as prose plus the files it
         touched. The steps themselves are one click away (内訳) and the Raw Log
         keeps everything; this is the reading, not the record. -->
    {@const dur = spanLabel(spanOf(item.at, item.to))}
    {@const tally = chapterTally(item, t)}
    {@const writes = item.writes.filter(f => f.path)}
    <div class="tl-phase-side">
        <span class="tl-phase-label">{t(`story.role.${item.role}`)}</span>
        {#if dur}<span class="tl-phase-meta">{dur}</span>
        {:else if item.at}<span class="tl-phase-meta">{clockText(item.at)}</span>{/if}
    </div>
    <div class="tl-phase-main">
        {#if item.summary}<p class="tl-phase-prose">{item.summary}</p>{/if}
        {#if item.role === 'loop'}
            <div class="tl-phase-loop" class:is-failed={item.lastFailed}>
                {t('story.loop.rounds', { n: item.rounds })} — {item.lastFailed ? t('story.loop.failed') : t('story.loop.passed')}
            </div>
        {/if}
        {#if writes.length || item.reads.length}
            <div class="tl-phase-files">
                {#each writes as f (f.path)}
                    <button type="button" class="tl-phase-file is-write" title={f.path}
                        onclick={() => onOpenFile?.(f.path)}>{@html icon('edit', 12)} {f.label || f.base}</button>
                {/each}
                {#each item.reads.slice(0, 6) as f (f.path)}
                    <button type="button" class="tl-phase-file" class:is-aside={writes.length > 0} title={f.path}
                        onclick={() => onOpenFile?.(f.path)}>{@html icon('file', 12)} {f.label || f.base}</button>
                {/each}
                {#if item.reads.length > 6}<span class="tl-phase-more">+{item.reads.length - 6}</span>{/if}
            </div>
        {/if}
        {#if (item.role === 'verify' || item.role === 'loop') && item.commands.length}
            <div class="tl-phase-cmds">
                {#each [...new Set(item.commands)].slice(0, 3) as c (c)}<code>{c}</code>{/each}
            </div>
        {/if}
        {#if item.live && item.now}
            <div class="tl-phase-now" title={item.now}>
                <span class="tl-phase-dot"></span><span class="tl-phase-now-k">{t('story.now')}</span>
                <span class="tl-phase-now-t">{item.now}</span>
            </div>
        {/if}
        <div class="tl-phase-foot">
            {#if tally.length}<span>{tally.join(' · ')}</span>{/if}
            {#if item.failed}<span class="tl-phase-failed">{t('story.tally.failed', { n: item.failed })}</span>{/if}
            {#if item.trace.length}
                <details class="tl-phase-detail">
                    <summary>{t('story.detail')}</summary>
                    <div class="tl-phase-trace">
                        {#each item.trace as e, i (i)}
                            {#if e.kind === 'thought'}
                                <div class="tl-phase-th">{e.text}</div>
                            {:else if e.kind === 'line'}
                                <StepLine line={e.line} {onOpenFile} />
                            {:else if e.kind === 'stdout'}
                                <div class="tl-phase-out"><code>{e.item.command}</code>
                                    <pre>{(e.item.lines || []).slice(-30).join(NL)}</pre></div>
                            {/if}
                        {/each}
                    </div>
                </details>
            {/if}
            {#if onShowRaw}
                <button type="button" class="tl-phase-raw" onclick={() => onShowRaw()}>{t('story.openRaw')}</button>
            {/if}
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
        <div class="tl-note-label">{t('task.note')}</div>
        <div class="rv-summary chat-md">{@html renderMarkdown(item.text)}</div>
    </div>

{:else if item.kind === 'task_progress'}
    <!-- The plan. It stays on screen for the whole exchange, so it is the
         quiet one: a thin rounded frame on a ground a shade off the page — the
         result is the loud one. It says where the run IS (a bar, and the step
         under way), not just which steps are struck through. Folded, it is one
         line; once every step is done the view folds it by itself
         (MonitorView), unless the reader has opened or folded it. Marks are
         drawn icons, never emoji or ▸, which render differently per font. -->
    {@const steps = item.items || []}
    {@const done = steps.filter(x => x.status === 'completed').length}
    {@const total = steps.length}
    {@const allDone = total > 0 && done === total}
    {@const current = steps.find(x => x.status === 'in_progress')
        || (done > 0 && !allDone ? steps.find(x => x.status !== 'completed') : null)}
    <div class="tl-plan tl-card-progress" class:is-done={allDone}>
        <button type="button" class="tl-plan-h" aria-expanded={!collapsed} onclick={toggleCollapsed}>
            {#if allDone}<span class="tl-plan-ok">{@html icon('check', 13)}</span>{/if}
            <span class="tl-plan-n">{allDone ? t('story.plan.done', { n: total }) : `${done} / ${total}`}</span>
            {#if !allDone}
                <span class="tl-plan-bar"><span class="tl-plan-fill" style="width:{total ? Math.round(done / total * 100) : 0}%"></span></span>
            {/if}
            {#if collapsed}
                <span class="tl-plan-gist">{(current ? [current] : steps).map(x => x.title).join(' → ')}</span>
            {/if}
            <span class="tl-plan-chev">{@html icon(collapsed ? 'chevron-right' : 'chevron-down', 13)}</span>
        </button>
        {#if !collapsed}
            <div class="tl-plan-body">
                {#each steps as step (step.id)}
                    <div class="tl-progress-row" class:is-done={step.status === 'completed'}
                        class:is-current={step === current} class:is-blocked={step.status === 'blocked'}>
                        <span class="tl-progress-ic">{@html icon(step === current ? 'pulse' : progressIcon(step.status), 13)}</span>
                        <span class="tl-progress-title">{step.title}</span>
                        {#if step.note}<span class="tl-progress-note">{step.note}</span>{/if}
                    </div>
                {/each}
            </div>
        {/if}
    </div>

{:else if item.kind === 'stdout'}
    <!-- Live command output, accumulated per command into one collapsible card.
         Stdout is not stored (see liveEvents.js), so this is a live-only chapter;
         it folds on its OWN via the model's collapsed flag, like task_progress. -->
    <div class="tl-card tl-card-stdout">
        <div class="tl-card-h tl-fold-h" role="button" tabindex="0"
            onclick={toggleCollapsed}
            onkeydown={(e) => { if (e.key === 'Enter') toggleCollapsed(); }}>
            {@html icon('code')} <span class="tl-stdout-cmd">{item.command || 'command'}</span>
            <span class="tl-stdout-n">{item.lines?.length} line{(item.lines?.length ?? 0) === 1 ? '' : 's'}</span>
            <span class="tl-card-chev">▼</span>
        </div>
        <div class="tl-card-body tl-stdout-body">
            {#each (item.lines || []) as line, i (i)}
                <div class="tl-stdout-line">{line}</div>
            {/each}
            {#if item.truncated}<div class="tl-stdout-more">… truncated (only the latest {item.lines.length} lines shown)</div>{/if}
        </div>
    </div>

{:else if item._story && (item.kind === 'run' || item.kind === 'document' || item.kind === 'deliverable')}
    <!-- The Story's result: the chapters' shape (label column + body), not a
         framed card with a header band. No tint and no bar — a rule above it and
         the theme's accent on the label and the conclusion mark the landing. The
         conclusion leads, and is taken OUT of the body so it is not said twice. -->
    {@const body = item.kind === 'run' ? String(item.answer || '').trim() : String(item.text || '')}
    {@const split = splitLead(body)}
    {@const stats = resultStats(item.stats, t)}
    <div class="tl-result">
        {#if split.lead}<p class="tl-result-lead">{split.lead}</p>{/if}
        {#if split.rest || !split.lead}
            <div class="rv-summary chat-md">{@html renderMarkdown(split.rest || '(no answer)')}</div>
        {/if}
        {#if item.kind !== 'deliverable'}<FileList files={item.files} {workspace} {onOpenFile} />{/if}
        {#if stats.length || item.kind === 'document'}
            <div class="tl-phase-foot tl-result-foot">
                {#if stats.length}<span>{stats.join('・')}</span>{/if}
                {#if item.kind === 'document'}
                    <button type="button" class="tl-phase-raw" onclick={() => onCopyDoc?.(item.text)}>{t('task.copyBody')}</button>
                {/if}
            </div>
        {/if}
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
                <button type="button" class="tl-doc-copy" title={t('task.copyBody')}
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
                <div class="mask-answered is-none">{t('ask.unanswered')}</div>
                <!-- …but the question is still the only thing the run is paused on,
                     so reopening the task must offer a way INTO answering it: the
                     reply goes through the ordinary reply box (which continues the
                     task), with the question as its placeholder. Without this the
                     card was a dead end and the task could never be resumed. -->
                <div class="mask-actions">
                    <button type="button" class="btn btn-primary btn-sm mask-reopen"
                        onclick={() => onReopenAsk?.(item)}>{t('ask.reopen')}</button>
                </div>
            {:else}
                <div class="mask-answered">↩ {item.answer || '(answered)'}</div>
            {/if}
        </div>
    {:else}
        {@const opts = item.options || []}
        <div class="mask-box is-open">
            <div class="mask-q">{@html icon('question')} {item.text}</div>
            {#if opts.length && !revising}
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
                                onclick={() => pickOption(o)}>{o}</button>
                        {/if}
                    {/each}
                </div>
            {/if}
            {#if item.multi && opts.length && !revising}
                <div class="mask-actions">
                    <button class="btn btn-primary btn-sm mask-submit"
                        onclick={() => { if (picked.length) onAnswer?.(picked.join(', ')); }}
                    >{t('common.submit')}</button>
                </div>
            {/if}
            {#if revising}
                <!-- Plan revision input: the user picked the ✏️ option and now
                     types WHAT they want changed. The typed text — not the option
                     label — is what gets sent, so the agent sees a real revision
                     instruction instead of "修正したい". -->
                <div class="mask-revise">
                    <div class="mask-revise-label">✏️ {t('plan.revise.label')}</div>
                    <textarea class="mask-revise-input" rows="3"
                        placeholder={t('plan.revise.placeholder')}
                        bind:value={revisionText}></textarea>
                    <div class="mask-actions">
                        <button type="button" class="btn btn-sm mask-revise-cancel"
                            onclick={() => { revising = false; revisionText = ''; }}>{t('common.cancel')}</button>
                        <button type="button" class="btn btn-primary btn-sm mask-revise-submit"
                            onclick={submitRevision}>{t('plan.revise.submit')}</button>
                    </div>
                </div>
            {/if}
            <div class="mask-hint">
                {#if revising}{t('plan.revise.placeholder')}
                {:else if !opts.length}Answer in the box below
                {:else if item.multi}Select any that apply and submit, or type an answer below
                {:else}Click to answer, or type one below{/if}
            </div>
        </div>
    {/if}
    {#if item._interim}
        <!-- The run's closing report when it stopped on THIS question. It is
             where things stand, not the result, so it sits folded under the
             question instead of above it as "結果" (storyExchanges.js). -->
        <details class="mask-interim">
            <summary>{t('story.interim')}</summary>
            <div class="rv-summary chat-md">{@html renderMarkdown(item._interim.text)}</div>
            <FileList files={item._interim.files} {workspace} {onOpenFile} />
            <StatChips stats={item._interim.stats} />
        </details>
    {/if}

{:else if item.kind === 'confirm'}
    <!-- The approval card's markup is built by MonitorView._fmtConfirm and its
         buttons are handled by the delegated _onConfirmCardClick on #result-panel.
         Not yet migrated: it is shared with the Raw Log surface, so it moves when
         that one does. -->
    <div class="mresult-confirm-box">{@html item.text}</div>
{/if}
</div>

