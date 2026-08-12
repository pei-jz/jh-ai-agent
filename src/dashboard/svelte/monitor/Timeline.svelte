<!--
  Timeline — the task's story, as one ordered column.

  This replaces views/monitor/timelineRender.js (`syncTimeline`), which existed
  solely to hand-roll what a keyed `{#each}` does natively: keep one node per item
  id and touch only the ones whose contents changed.

  That constraint is not optional and it is why timelineRender was written in the
  first place. The three failures it was created to fix:
    • cost — the old view rebuilt whole panels with `innerHTML =` on every event,
      re-parsing the markdown of every completed exchange each time a line
      arrived;
    • lost state — an open <details>, a scroll position or a partial text
      selection died on each rebuild;
    • stale references — code held DOM nodes across rebuilds, so after one, new
      lines stopped nesting and the feed visibly "broke".

  A keyed each block satisfies all three by construction: `(item.id)` identifies
  the node, and Svelte updates the specific text nodes and attributes that
  changed rather than replacing the subtree. A streaming run touches one line's
  worth of DOM, which is what the hand-rolled differ achieved — without the
  bookkeeping WeakMap.
-->
<script>
    import TimelineItem from './TimelineItem.svelte';

    let {
        /** The stream from splitForPanes + withExchangeFolds, in order. */
        items = [],
        /**
         * Ids the model currently has folded (from collapsedIds()).
         *
         * Separate from the items so THEY can stay reference-stable: a spread per
         * item per render made every step look changed, and on a long run that was
         * the difference between a few milliseconds and thirty — per streamed line.
         */
        collapsed = new Set(),
        renderMarkdown = (t) => String(t ?? ''),
        workspace = '',
        onToggleStory = null,
        onToggleCollapse = null,
        onAnswer = null,
        onReopenAsk = null,
        onCopyDoc = null,
        onOpenFile = null,
    } = $props();

    const list = $derived(Array.isArray(items) ? items : []);
</script>

<!-- Each item renders its own wrapper row, so it can own its interactive state
     classes (collapsed / is-open) instead of having them written onto it from
     out here. -->
{#each list as item (item.id)}
    <TimelineItem
        {item}
        isCollapsed={collapsed.has(item.id) || !!item._bodyless}
        {renderMarkdown}
        {workspace}
        {onToggleStory}
        {onToggleCollapse}
        {onAnswer}
        {onReopenAsk}
        {onCopyDoc}
        {onOpenFile}
    />
{/each}
