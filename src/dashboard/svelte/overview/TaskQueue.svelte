<!--
  TaskQueue — what is waiting, running, recently broken, and recently done.

  Groups are omitted entirely when empty rather than rendered as an empty
  heading: the whole reason this page was rebuilt is that a fixed grid of mostly
  empty panels taught people it was not worth reading.
-->
<script>
    import { ago, ATTENTION_WINDOW_H } from '../../views/overview/overviewModel.js';

    let { metrics, now = Date.now() } = $props();

    const DOT = {
        running: 'dot-running', paused: 'dot-paused',
        failed: 'dot-failed', completed: 'dot-completed',
    };

    const groups = $derived([
        { label: 'Waiting for you', tasks: metrics.paused, sel: false },
        { label: 'Running', tasks: metrics.running, sel: true },
        { label: `Failed · last ${ATTENTION_WINDOW_H}h`, tasks: metrics.freshFailures.slice(0, 3), sel: false },
        { label: 'Recent', tasks: metrics.recent, sel: false },
    ].filter(g => g.tasks.length));

    const empty = $derived(groups.length === 0);
</script>

<div class="dq">
    {#each groups as g}
        <span class="a-lab dq-lab">{g.label}</span>
        {#each g.tasks as t (t.id)}
            <a class="dqi" class:is-sel={g.sel} href="#monitor?id={encodeURIComponent(t.id)}">
                <span class="drow-dot {DOT[t.status] || 'dot-aborted'}"></span>
                <span class="grow">{t.prompt || '(no prompt)'}</span>
                <span class="t">{ago(t.completed_at || t.started_at, now)}</span>
            </a>
        {/each}
    {/each}

    {#if empty}
        <div class="dq-empty">No tasks yet. Describe one above.</div>
    {/if}
    {#if metrics.staleFailures}
        <a class="dq-more" href="#monitor">{metrics.staleFailures} older failures in Monitor →</a>
    {/if}
</div>
