<!--
  ContextPicker — the workspace / mode pickers on the composer's status line.

  A native <select> was the first attempt and it cannot be made to fit: the list
  is drawn by the operating system, in the OS palette, with the OS row height,
  so on this paper-coloured window it opened as a grey Windows menu with no
  relation to anything around it. It also cannot show a second line, and both of
  these choices need one — a workspace's full path under its folder name, a
  mode's description under its name (picking "読み取り専用" without knowing what
  it forbids is how a run fails ten minutes later).

  So: a button and a list, drawn by us.

  It opens UPWARD. The status line sits at the bottom of the composer, which
  itself sits at the bottom of its column; a list opening downward would be
  clipped by the window on the one screen this control exists for.
-->
<script>
    import { icon } from '../../utils/icons.js';

    let {
        /** The selected option's value. */
        value = '',
        /** [{ value, label, hint? }] — `hint` is the second line. */
        options = [],
        /** Icon name for the closed button. */
        glyph = 'gear',
        /** Read aloud; the button shows only the icon and the current label. */
        label = '',
        /** Hover text on the button — the full path, where the label is a name. */
        title = '',
        /** (value) => void */
        onPick = () => {},
    } = $props();

    let open = $state(false);
    let root = $state(null);
    /** Which row the keyboard is on. -1 = none, so Enter does nothing yet. */
    let cursor = $state(-1);

    const current = $derived(options.find(o => o.value === value) || null);
    const shown = $derived(current?.label || '');

    function toggle() {
        open = !open;
        // Opening puts the cursor on what is selected, so ↓ moves from there
        // rather than from the top of a list you are already part-way down.
        cursor = open ? Math.max(0, options.findIndex(o => o.value === value)) : -1;
    }

    function choose(option) {
        open = false;
        cursor = -1;
        if (option && option.value !== value) onPick(option.value);
        // Re-picking the SAME option still closes, and still reports: a row like
        // "choose a folder…" is an action, not a value, and must fire every time.
        else if (option?.always) onPick(option.value);
    }

    function onKey(e) {
        if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); open = false; cursor = -1; return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, options.length - 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); return; }
        if (e.key === 'Home') { e.preventDefault(); cursor = 0; return; }
        if (e.key === 'End') { e.preventDefault(); cursor = options.length - 1; return; }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(options[cursor]);
        }
    }
</script>

<!-- Pointer-down, not click: a click elsewhere that starts on this list (a drag
     over a long path) must not close it out from under the pointer. -->
<svelte:window onpointerdown={(e) => { if (open && root && !root.contains(e.target)) { open = false; cursor = -1; } }} />

<div class="ctxp" bind:this={root}>
    <button type="button" class="ctxp-btn" class:is-open={open}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        {title} onclick={toggle} onkeydown={onKey}>
        {@html icon(glyph, 11)}
        <span class="ctxp-cur">{shown}</span>
        <span class="ctxp-caret" aria-hidden="true">⌄</span>
    </button>

    {#if open}
        <div class="ctxp-list" role="listbox" aria-label={label} tabindex="-1">
            {#each options as o, i (o.value)}
                <button type="button" class="ctxp-opt"
                    class:is-sel={o.value === value}
                    class:is-cursor={i === cursor}
                    role="option" aria-selected={o.value === value}
                    onmouseenter={() => (cursor = i)}
                    onclick={() => choose(o)}>
                    <span class="ctxp-mark" aria-hidden="true">{o.value === value ? '✓' : ''}</span>
                    <span class="ctxp-texts">
                        <span class="ctxp-name">{o.label}</span>
                        {#if o.hint}<span class="ctxp-hint">{o.hint}</span>{/if}
                    </span>
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .ctxp { position: relative; display: inline-flex; min-width: 0; }

    .ctxp-btn {
        display: inline-flex; align-items: center; gap: 5px;
        min-width: 0; max-width: 26ch;
        padding: 2px 6px;
        border: 1px solid transparent; border-radius: var(--r-1);
        background: none; color: inherit; font: inherit;
        cursor: pointer;
    }
    .ctxp-btn:hover { color: var(--ink-soft); background: var(--surface-hover); }
    .ctxp-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .ctxp-btn.is-open {
        color: var(--ink); background: var(--surface-hover);
        border-color: var(--line);
    }
    .ctxp-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctxp-caret { opacity: 0.55; flex-shrink: 0; }

    .ctxp-list {
        position: absolute;
        bottom: calc(100% + 5px);
        left: 0;
        z-index: 40;
        min-width: 230px; max-width: 360px;
        max-height: 320px; overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--line); border-radius: var(--r-2);
        background: var(--surface-panel);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        /* The line it belongs to is monospaced and tiny; the list is prose. */
        font-family: var(--font-sans);
        font-size: var(--fs-sm);
    }
    .ctxp-opt {
        display: flex; align-items: flex-start; gap: 7px;
        width: 100%; padding: 6px 8px;
        border: none; border-radius: var(--r-1);
        background: none; color: var(--ink); font: inherit; text-align: left;
        cursor: pointer;
    }
    /* One highlight, driven by the cursor — the keyboard and the pointer move
       the same thing, so they can never disagree about which row is next. */
    .ctxp-opt.is-cursor { background: var(--accent-surface); }
    .ctxp-mark { width: 12px; flex-shrink: 0; color: var(--accent); }
    .ctxp-texts { display: grid; gap: 1px; min-width: 0; }
    .ctxp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctxp-opt.is-sel .ctxp-name { font-weight: 600; }
    .ctxp-hint {
        color: var(--ink-faint); font-size: var(--fs-xs); line-height: 1.4;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
</style>
