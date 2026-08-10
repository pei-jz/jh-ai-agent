<!--
  StepLine — one line inside a reasoning step (or a bare pre-step line).

  The file a tool acted on is its own control, not part of the sentence. Opening
  what a step touched, from the step itself, is the thing a terminal transcript
  cannot do — so it gets a real <button>, where the string-built version was a
  <span> that depended on a delegated `[data-open-path]` scan.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { stepLineParts } from '../../views/monitor/timelineItems.js';

    let { line, onOpenFile = null } = $props();

    const p = $derived(stepLineParts(line));
    // Clamped lines open on click. Local state: this is a reading preference for
    // one line, with nothing else in the app depending on it.
    let expanded = $state(false);
</script>

<div
    class="mtask-feed-item"
    class:is-error={p.isError}
    class:clampable={p.clampable}
    class:expanded={p.clampable && expanded}
    title={p.text}
    onclick={() => { if (p.clampable) expanded = !expanded; }}
    role={p.clampable ? 'button' : undefined}
    tabindex={p.clampable ? 0 : undefined}
    onkeydown={(e) => {
        if (!p.clampable) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; }
    }}
>
    <span class="mtask-feed-ic">{@html icon(p.icon)}</span>
    <span class="mtask-feed-tx">{p.prose}</span>
    {#if p.path}
        <button
            type="button"
            class="mstep-file"
            class:is-write={p.write}
            data-open-path={p.path}
            title={p.path}
            onclick={(e) => { e.stopPropagation(); onOpenFile?.(p.path); }}
        >{@html icon(p.write ? 'edit' : 'file')} {p.base}</button>
    {/if}
</div>
