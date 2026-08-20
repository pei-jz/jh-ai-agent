<!--
  MemoryRow — one fact, lesson or insight, with its off switch.

  Shared by the digest sections and the search results, which is why it is its
  own component: `_memRowHtml` was called from three places and each caller had
  to remember to pass `{ plain: true }`.
-->
<script>
    import { t } from '../../../i18n/index.js';

    let {
        row,
        /** Search/digest rows hide the per-card meta line to stay scannable. */
        plain = false,
        onToggleCard = null,
    } = $props();

    const card = $derived(row?.card || null);
    const badge = $derived(row?.badge || 'note');
    const meta = $derived(card
        ? [
            card.costSteps ? `cost ${card.costSteps} steps` : '',
            card.hits > 1 ? `seen ${card.hits}×` : '',
            card.last_recurrence || card.first_seen || '',
          ].filter(Boolean).join(' · ')
        : (row?.detail || ''));
</script>

<div class="dm-row" class:is-off={card?.disabled}>
    <span class="dm-badge is-{badge}">{badge}</span>
    {#if row?.isNew}
        <span class="dm-new" title={t('dash.mem.new.title')}>{t('dash.mem.new')}</span>
    {/if}
    <span class="body">
        <span class="hl">{row?.headline || ''}</span>
        <span class="dt">{row?.detail || ''}</span>
        {#if card && !plain}<span class="mt">{meta}</span>{/if}
    </span>
    {#if card}
        <label class="dm-toggle" title={card.disabled ? 'Switch back on' : 'Switch off'}>
            <input type="checkbox" checked={!card.disabled}
                onchange={(e) => onToggleCard?.(card.id, !e.currentTarget.checked)}>
            <i></i>
        </label>
    {/if}
</div>
