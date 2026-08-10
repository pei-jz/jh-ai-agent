<!-- StatChips — a finished run's numbers: steps, tool calls, tokens, duration. -->
<script>
    import { icon } from '../../utils/icons.js';
    import { statChips } from '../../views/monitor/timelineItems.js';

    let { stats = {} } = $props();
    const chips = $derived(statChips(stats));
</script>

{#if chips.length}
    <div class="mrc-stats">
        {#each chips as c (c.icon + c.text)}
            <span>{@html icon(c.icon)} {c.text}</span>
        {/each}
    </div>
{/if}
