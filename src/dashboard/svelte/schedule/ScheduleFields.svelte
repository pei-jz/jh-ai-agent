<!--
  ScheduleFields — "when does this run", as one control, defined once.

  There were three of these: the round day-buttons and segmented type picker in
  ScheduleDetail, a plainer copy in JobDetail's trigger row, and a third set of
  bare checkboxes in the setup wizard. All three edited the same five fields
  (scheduleType / time / days / intervalMinutes / dayOfMonth) and all three
  looked different, which made the wizard read as a worse version of a screen
  the app already had.

  One component, bound to one trigger object. `compact` is the only variation —
  the trigger row inside JobDetail has no room for the segmented buttons — and
  it changes density, not which fields exist.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { INTERVAL_OPTIONS, DOM_OPTIONS } from '../../views/schedule/scheduleModel.js';

    let {
        /** The object holding the five fields. Mutated in place. */
        value = $bindable(),
        /** Dense single-row form, for a list of triggers. */
        compact = false,
        idPrefix = 'sf',
    } = $props();

    /**
     * Japanese single characters, because the picker is seven circles wide.
     * `DAY_LABELS` in scheduleModel is the English list the old screen used;
     * keeping both would be the same duplication this component is undoing, so
     * this is the one place the short form is written.
     */
    const DAYS = [['日', 0], ['月', 1], ['火', 2], ['水', 3], ['木', 4], ['金', 5], ['土', 6]];

    const TYPES = [
        ['fixed', 'jobs.time.fixed'],
        ['interval', 'jobs.time.interval'],
        ['monthly', 'jobs.time.monthly'],
        ['once', 'jobs.time.once'],
    ];

    /**
     * The option labels, in the form's language.
     *
     * `scheduleModel` spells them in English because the screen it was written
     * for is English throughout. Reused inside a Japanese form they read as
     * leftovers, so the VALUES come from the model (one list) and the words
     * come from i18n.
     */
    const intervalLabel = (min) => (min % 60 === 0
        ? t('sched.every.hours', { n: min / 60 })
        : t('sched.every.minutes', { n: min }));
    const dayLabel = (v) => (v === 'last' ? t('sched.dom.last') : t('sched.dom', { n: v }));

    /** Weekdays only mean something for the two types that repeat within a week. */
    const usesDays = $derived(value?.scheduleType === 'fixed' || value?.scheduleType === 'interval');

    function toggleDay(d) {
        const days = new Set(value.days || []);
        if (days.has(d)) days.delete(d); else days.add(d);
        value.days = [...days].sort((a, b) => a - b);
    }
</script>

{#if value}
<div class="sf" class:sf-compact={compact}>
    {#if compact}
        <select class="sch-select sch-select-auto" bind:value={value.scheduleType}>
            {#each TYPES as [id, key] (id)}<option value={id}>{t(key)}</option>{/each}
        </select>
    {:else}
        <div class="sch-type-group">
            {#each TYPES as [id, key] (id)}
                <button type="button" class="sch-type-btn" class:selected={value.scheduleType === id}
                    onclick={() => (value.scheduleType = id)}>{t(key)}</button>
            {/each}
        </div>
    {/if}

    <!-- Each type owns its OWN inputs; nothing is hidden-but-still-read, which
         is how the original form managed to silently save 09:00. -->
    <div class="sch-time-row">
        {#if value.scheduleType === 'interval'}
            <select id={`${idPrefix}-int`} class="sch-select sch-select-auto" bind:value={value.intervalMinutes}>
                {#each INTERVAL_OPTIONS as o (o.value)}<option value={o.value}>{intervalLabel(o.value)}</option>{/each}
            </select>
        {:else if value.scheduleType === 'once'}
            <input id={`${idPrefix}-once`} type="datetime-local" class="sch-datetime-input"
                bind:value={value.onceAt} />
        {:else}
            {#if value.scheduleType === 'monthly'}
                <select id={`${idPrefix}-dom`} class="sch-select sch-select-auto" bind:value={value.dayOfMonth}>
                    {#each DOM_OPTIONS as v (v)}<option value={v}>{dayLabel(v)}</option>{/each}
                </select>
            {/if}
            <input id={`${idPrefix}-time`} type="time" class="sch-time-input" bind:value={value.time} />
        {/if}

        {#if usesDays}
            <div class="sch-days-picker">
                {#each DAYS as [label, d] (d)}
                    <button type="button" class="sch-day-btn" class:selected={(value.days || []).includes(d)}
                        onclick={() => toggleDay(d)}>{label}</button>
                {/each}
            </div>
        {/if}
    </div>
</div>
{/if}

<style>
    .sf { display: flex; flex-direction: column; gap: 10px; }
    .sf-compact { flex-direction: row; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sf-compact .sch-time-row { gap: 8px; }
</style>
