<!--
  Welcome — what Work shows before a task is selected.

  It replaced "Select a task / Choose an agent task from the left panel", which
  described the furniture rather than offering anything: the reason you are on
  this screen with nothing selected is almost always that you have not started
  something yet, and the previous copy answered a question nobody had.

  The presets are the user's own templates, ranked by use
  (views/overview/recipes.js — the ranking the Dashboard's recipe chips used,
  kept when that screen was dissolved). NOT invented examples: a starting point
  that cannot actually be run teaches the wrong thing about the product.

  Each one carries the mode it would start in, computed with the SAME predicate
  the composer uses (`looksReadOnly` in agent/TaskComplexity.js), so the badge
  cannot promise one thing and the run do another.
-->
<script>
    import { ASK, BUILD } from '../../../modules/ai/agent/InteractionMode.js';
    import { looksReadOnly } from '../../../modules/ai/agent/TaskComplexity.js';
    import { icon } from '../../utils/icons.js';

    let {
        /** [{ key, label, prompt }] — already ranked. */
        presets = [],
        /** (preset) => void — fills the composer. */
        onPick = null,
        /**
         * The composer, rendered BETWEEN the lede and the presets.
         *
         * Passed in rather than placed beside this component, because the order
         * is the point: you type first and reach for a template only if nothing
         * comes to mind. With the presets above the box they were the first
         * thing offered, which is backwards for a screen whose question is
         * "what would you like to do".
         */
        children = null,
    } = $props();

    const kindOf = (p) => (looksReadOnly(p?.prompt || '') ? ASK : BUILD);
    const clip = (s, n) => {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    };
</script>

<div class="wel">
    <h2 class="wel-title">何をしますか？</h2>
    <!-- It used to say "短い質問も、長い作業も、同じ入力欄からです" while the
         input was a 240px sliver in the other column. The box is here now, so
         the text says the one thing the box does not: that the mode is a guess
         you can change. -->
    <p class="wel-lede">
        短い質問も、長い作業も、ここから。モードは文面から推定され、チップで変えられます。
    </p>

    {@render children?.()}

    {#if presets.length}
        <span class="wel-or">よく使う依頼から</span>
        <div class="wel-presets">
            {#each presets as p (p.key)}
                <button type="button" class="wel-preset" onclick={() => onPick?.(p)}
                    title={p.prompt}>
                    <span class="wel-badge is-{kindOf(p)}">{kindOf(p) === ASK ? '聞く' : '頼む'}</span>
                    <span class="wel-preset-text">{clip(p.label || p.prompt, 48)}</span>
                </button>
            {/each}
        </div>
    {:else}
        <!-- No templates yet. A link, not an empty frame: the thing to do is
             make one, and this is where you would want to be told that. -->
        <a class="wel-add" href="#config?tab=templates">
            {@html icon('plus', 12)} よく使う依頼をテンプレートにすると、ここから1クリックで始められます
        </a>
    {/if}
</div>

<style>
    .wel {
        display: flex;
        flex-direction: column;
        align-items: center;
        /* The composer sits between the lede and the templates, so the rhythm
           is: question, answer-box, shortcuts. A wider gap around the box than
           inside the text keeps those three as three things. */
        gap: var(--space-4);
        width: 100%;
        max-width: 620px;
        text-align: center;
    }
    .wel > :global(.mcomp) { width: 100%; }
    .wel-title {
        font-family: var(--font-accent);
        font-size: var(--fs-2xl);
        font-weight: 700;
        color: var(--ink);
        margin: 0;
    }
    .wel-lede {
        font-size: var(--fs-base);
        line-height: 1.9;
        color: var(--ink-soft);
        margin: 0;
        max-width: 30em;
    }
    .wel-or {
        font-family: var(--font-mono);
        font-size: var(--fs-2xs);
        letter-spacing: .08em;
        color: var(--ink-faint);
    }
    .wel-presets {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        width: 100%;
        max-width: 460px;
        margin-top: var(--space-2);
    }
    /* A preset IS a control, so it keeps its edge — see the "Regions, not cards"
       note in styles/dashboard.css. */
    .wel-preset {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        width: 100%;
        text-align: left;
        font-family: inherit;
        font-size: var(--fs-md);
        color: var(--ink-soft);
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-2);
        padding: 10px 14px;
        cursor: pointer;
        transition: border-color var(--transition-fast), color var(--transition-fast);
    }
    .wel-preset:hover { border-color: var(--accent); color: var(--ink); }
    .wel-preset:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .wel-preset-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .wel-badge {
        flex: 0 0 auto;
        font-family: var(--font-mono);
        font-size: var(--fs-2xs);
        font-weight: 600;
        border-radius: var(--r-1);
        padding: 2px 7px;
    }
    .wel-badge.is-ask { background: var(--info-surface); color: var(--info); }
    .wel-badge.is-build { background: var(--accent-surface); color: var(--accent); }
    .wel-add {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--fs-sm);
        color: var(--ink-faint);
        text-decoration: none;
    }
    .wel-add:hover { color: var(--accent); }
</style>
