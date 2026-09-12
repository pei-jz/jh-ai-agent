<!--
  JobCatalog — "what should I automate", which nothing in the app answered.

  The wizard answers "how do I register this". That is the easy half. The hard
  half is the blank page: the author of the feature could not remember what to
  do with it a day after shipping, and a user meeting the empty list has less to
  go on than that.

  So this leads with the WORK, grouped by what it saves you, and the trigger
  arrives attached to whatever you pick. Every card carries one line saying why
  the job needs a model at all — which is also the admission rule. A template
  whose value is only moving data does not appear here: it is a script, and
  saying "you don't need AI for this" on the first screen someone meets invites
  them to conclude they don't need the app. Those stay in the 監視 / ひな形 tabs,
  where people arrive already knowing what they want. The honesty is kept, and
  put where it helps: the footer names the cheaper pattern outright.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { catalogGroups } from '../../../modules/ai/jobs/wizardPlan.js';

    let {
        recipes = [],
        /** MCP server names configured in settings. */
        configuredMcp = [],
        onPick = () => {},
        onCustom = null,
    } = $props();

    const groups = $derived(catalogGroups(recipes, configuredMcp));
</script>

<div class="cat">
    <!-- Says outright that these are EXAMPLES. "Common shapes" did not: eight
         cards and nothing else on screen reads as a list of what is supported,
         which is the opposite of true — anything you can write in the prompt
         can be a job. -->
    <p class="sch-note">{@html t('cat.hint')}</p>

    {#each groups as g (g.category)}
        <h4 class="cat-group">{t(`cat.cat.${g.category}`)}</h4>
        <ul class="cat-cards">
            {#each g.items as c (c.id)}
                <li>
                    <button class="cat-card" class:blocked={c.missingMcp.length}
                        onclick={() => onPick(c)}>
                        <span class="cat-name">{c.name}</span>
                        <span class="cat-desc">{c.description}</span>
                        <!-- Why a model, in one line. If this cannot be written,
                             the template does not belong in the catalogue. -->
                        <span class="cat-why">🤖 {c.needsAI}</span>
                        {#if c.missingMcp.length}
                            <!-- Which server, not merely "an MCP server": the
                                 vaguer message is the same blank page one level
                                 down. -->
                            <span class="cat-need">{t('cat.needsMcp', { names: c.missingMcp.join(', ') })}</span>
                        {/if}
                    </button>
                </li>
            {/each}
        </ul>
    {/each}

    {#if onCustom}
        <!-- A CARD, the same size as the rest, in the same grid.
             As a small button below eight cards it read as the way out of a
             menu, which made the eight look like the whole of what the app can
             do. They are examples; this is the ninth option, not an escape. -->
        <h4 class="cat-group">{t('cat.cat.own')}</h4>
        <ul class="cat-cards">
            <li>
                <button class="cat-card cat-card-own" onclick={onCustom}>
                    <span class="cat-name">{t('cat.custom')}</span>
                    <span class="cat-desc">{t('cat.custom.desc')}</span>
                </button>
            </li>
        </ul>
    {/if}

    <p class="cat-foot">{t('cat.foot')}</p>
</div>

<style>
    .cat { display: flex; flex-direction: column; gap: 10px; }
    .cat-group { margin: 6px 0 0; font-size: var(--fs-sm); color: var(--ink-soft); }
    .cat-cards {
        list-style: none; margin: 0; padding: 0;
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    }
    @media (max-width: 720px) { .cat-cards { grid-template-columns: 1fr; } }
    .cat-card {
        width: 100%; height: 100%; text-align: left;
        display: grid; gap: 4px; align-content: start;
        padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--r-2);
        background: var(--surface-raised); cursor: pointer;
    }
    .cat-card:hover { border-color: var(--accent); background: var(--accent-surface); }
    /* Same size and shape as the examples, drawn as an outline so it reads as
       "start from nothing" rather than as a ninth ready-made job. */
    .cat-card-own { border-style: dashed; background: transparent; }
    /* Still clickable: the wizard is where you find out what to configure. */
    .cat-card.blocked { opacity: .72; }
    .cat-name { font-weight: 600; }
    .cat-desc { color: var(--ink-soft); font-size: var(--fs-sm); line-height: 1.45; }
    .cat-why { color: var(--ink-faint); font-size: var(--fs-sm); line-height: 1.4; }
    .cat-need {
        justify-self: start; margin-top: 2px; padding: 1px 8px; border-radius: var(--r-2);
        background: var(--warning-surface); color: var(--warning); font-size: var(--fs-sm);
    }
    .cat-foot {
        margin: 4px 0 0; padding: 8px 12px; border-radius: var(--r-2);
        background: var(--surface-sunken); color: var(--ink-soft);
        font-size: var(--fs-sm); line-height: 1.5;
    }
</style>
