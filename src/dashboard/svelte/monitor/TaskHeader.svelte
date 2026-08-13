<!--
  TaskHeader — the task detail header and its context gauge.

  Region 2 of the Svelte migration. This one existed as a template string whose
  every live field was then updated by id from four different places in
  MonitorView (`getElementById('val-elapsed')`, `('val-steps')`,
  ('val-total-tokens')`, `('detail-context-bar')`, …). Those writes are now a
  single prop push.

  Layout notes carried over from the vanilla version, because they were hard-won:
    • the request leads, then the vital signs, then the ids. Provenance is the
      least-read line, and putting it between the title and the numbers separated
      the two things that ARE read together.
    • the title is ONE line. A wrapping title pushed the whole story down on
      every task with a long prompt, which is most of them.
    • this block is fixed furniture above a scrolling story, so the rhythm is
      deliberately tight — at its earlier spacing it ate the top third of the
      panel.
    • the workspace lives in the Inspector, not here. It cannot change during a
      run, so a permanent row for it was pure cost.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import {
        contextGauge, elapsedText, compactTokens,
    } from '../../views/monitor/headerStats.js';

    let {
        task = null,
        /** Live run status; falls back to the task's stored status. */
        status = '',
        /** Reasoning steps so far, from the timeline. */
        steps = 0,
        usage = {},
        /** {used, limit} from headerStats.contextReading, or null before the first call. */
        context = null,
        /** Re-render trigger for elapsed while running — pass Date.now(). */
        now = Date.now(),
        onAbort = null,
        onDelete = null,
    } = $props();

    const running = $derived(status === 'running');
    const gauge = $derived(contextGauge(context));
    const elapsed = $derived(elapsedText({
        startedAt: task?.started_at,
        completedAt: task?.completed_at,
        running,
        now,
    }));
    // "—" rather than "0": an unfilled dash reads as "not yet", where a zero next
    // to real numbers reads as a measurement that came back empty.
    const n = (v) => Number(v || 0).toLocaleString();
</script>

{#if task}
    <div class="mdetail-header">
        <div class="mdh-icon">{@html icon('monitor', 18)}</div>
        <div class="mdh-main">
            <div class="mdh-title" title={task.prompt}>{task.prompt}</div>
            <div class="mdh-meta">
                <!-- Status / started / steps are gone: the task list on the left
                     and the Inspector already carry them, and the header's job is
                     the numbers that change while you watch. What stays: the
                     wall-clock elapsed and the token totals. -->
                <span class="mdh-chip"><b>{elapsed}</b> elapsed</span>
                <span class="mdh-chip" title="Input ↑ · cache ⚡ · output ↓">
                    <b>{compactTokens(usage.total_tokens)}</b> tokens
                </span>
                <span class="mdh-tokens-bd">(<span
                    title="Input (excl. cached, full-price)">↑{n(usage.prompt_tokens)}</span> · <span
                    title="Cache reads (~10% price = savings)">⚡{n(usage.cache_read_input_tokens)}</span> · <span
                    title="Output">↓{n(usage.completion_tokens)}</span>)</span>
            </div>
            <!-- The id / caller line is gone: the Inspector on the right already
                 shows both, and a header line that only repeats what is visible
                 beside it costs vertical space without adding anything. -->
        </div>
        <!-- Abort exists only while there is something to abort; it used to be
             REMOVED from the DOM by hand on completion. -->
        {#if running}
            <button class="btn btn-error mdh-act" onclick={() => onAbort?.()}>⏹ Abort</button>
        {:else}
            <button class="btn btn-secondary mdh-act mdh-act-del"
                title="Delete this task from history"
                onclick={() => onDelete?.()}>{@html icon('trash', 13)} Delete</button>
        {/if}
    </div>
    <!-- One bar, its % on the right. An earlier version put the label and the
         number on a second line, which read as a second statistic rather than as
         the bar's own value. -->
    <div class="mdh-ctx" title="How full the model's context window is (last LLM call's input vs the window)">
        <span class="mdh-ctx-label">Context</span>
        <span class="mdh-ctx-track">
            <span class="mdh-ctx-fill" class:is-danger={gauge.danger} style={`width:${gauge.pct}%`}></span>
        </span>
        <span class="mdh-ctx-pct">{gauge.label}</span>
    </div>
{/if}
