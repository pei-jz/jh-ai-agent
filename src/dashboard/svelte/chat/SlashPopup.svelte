<!--
  SlashPopup — the /command picker above the chat input.

  Region 6. It was innerHTML plus a `querySelectorAll(...).forEach` re-binding a
  mousedown per row after every keystroke, because the list is filtered as you type —
  so that rebind ran on EVERY character.

  `mousedown` rather than `click` is deliberate and load-bearing: a click fires after
  the textarea has already blurred, and the caret position the insertion needs is gone
  by then. `preventDefault` stops the blur.
-->
<script>
    let {
        items = [],
        /** Which row the keyboard is on. Owned by the view: ↑/↓ are its key handler. */
        selected = 0,
        onPick = null,
    } = $props();

    const list = $derived(Array.isArray(items) ? items : []);
    const typeLabel = (t) => (t === 'template' ? 'template' : 'skill');

    /**
     * Keep the keyboard selection visible. The predecessor did this with a
     * scrollIntoView after each innerHTML swap; an $effect ties it to the value that
     * actually changed.
     */
    let listEl = $state(null);
    $effect(() => {
        const row = listEl?.querySelector('.slash-popup-item.selected');
        // Guarded: scrollIntoView is missing in jsdom, and an exception thrown from
        // inside an $effect takes the whole update with it — a popup that fails to
        // render is far worse than one that fails to scroll.
        if (typeof row?.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    });
</script>

{#if !list.length}
    <div class="slash-popup-header">Commands</div>
    <div class="slash-popup-empty">No matching template or skill</div>
{:else}
    <div class="slash-popup-header">Commands — ↑↓ select, Enter confirm, Esc close</div>
    <div class="slash-popup-list" bind:this={listEl}>
        {#each list as item, idx (item.type + item.key)}
            <div
                class="slash-popup-item"
                class:selected={idx === selected}
                data-idx={idx}
                onmousedown={(e) => { e.preventDefault(); onPick?.(item); }}
                role="button"
                tabindex="-1"
            >
                <span class="slash-popup-icon">{item.icon}</span>
                <span class="slash-popup-key">/{item.key}</span>
                <span class="slash-popup-label">{item.label}</span>
                <span class="slash-popup-type">{typeLabel(item.type)}</span>
            </div>
        {/each}
    </div>
{/if}
