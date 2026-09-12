<!--
  SegmentedChoice — a small set of fixed options, all visible at once.

  Replaces the <select> on settings with two or three choices. A dropdown there
  costs three actions (open, read, pick) to do what one click can, and hides
  both the number of options and the one in force until it is opened.

  REAL RADIO INPUTS, visually replaced rather than re-implemented with buttons
  and ARIA. That is what gives arrow-key movement between options, "2 of 3" to a
  screen reader, and form semantics — none of which a div of buttons gets
  without a pile of code that is wrong in some browser.

  Not for long or growing lists: four-plus options, or anything driven by what
  the user has configured (models, languages), stays a <select>. See
  docs/design/visual-language.md.
-->
<script>
    let {
        /** Groups the radios. Arrow keys move within one name, so it must be unique. */
        name,
        value = '',
        /** [{ value, label }] — labels are SHORT; the explanation lives below. */
        options = [],
        disabled = false,
        onChange = () => {},
        labelledBy = '',
    } = $props();
</script>

<div class="seg" class:seg-disabled={disabled} role="group" aria-labelledby={labelledBy}>
    {#each options as o (o.value)}
        <label class="seg-opt" class:active={value === o.value}>
            <input type="radio" id={`${name}-${o.value}`} {name} {disabled} value={o.value}
                checked={value === o.value}
                onchange={() => onChange(o.value)} />
            <span>{o.label}</span>
        </label>
    {/each}
</div>

<style>
    .seg {
        display: inline-flex;
        /* The parent is a flex column, whose children stretch by default — so
           a two-option control spanned the whole column and put "オフ" and
           "オン" a hand's width apart. It is as wide as its options. */
        align-self: flex-start;
        padding: 2px;
        gap: 2px;
        border: 1px solid var(--line);
        border-radius: var(--r-2);
        background: var(--surface-sunken);
        max-width: 100%;
    }
    .seg-opt {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        padding: 5px 14px;
        border-radius: calc(var(--r-2) - 2px);
        color: var(--ink-soft);
        font-size: var(--fs-sm);
        font-weight: 500;
        text-align: center;
        white-space: nowrap;
        cursor: pointer;
        transition: background var(--transition-fast), color var(--transition-fast);
    }
    /* The input still receives focus and keyboard events; it is only invisible.
       `display:none` would take it out of the tab order and kill the arrows. */
    .seg-opt input {
        position: absolute;
        width: 1px; height: 1px;
        opacity: 0;
        margin: 0;
        pointer-events: none;
    }
    .seg-opt:hover { color: var(--ink); }
    .seg-opt.active {
        background: var(--surface-panel);
        color: var(--accent);
        font-weight: 600;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
    }
    /* Focus lands on the hidden input, so the ring has to be drawn here. */
    .seg-opt:focus-within {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
    }
    .seg-disabled { opacity: 0.55; }
    .seg-disabled .seg-opt { cursor: not-allowed; }
</style>
