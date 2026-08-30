<!--
  ConnectionTable — the LLM Connections list.

  Part of region 5 (ConfigView). The row used to be built by a `switch (provider)`
  inlined in a template literal, and the provider table had drifted: 'generic' was
  missing from it, so a generic OpenAI-compatible connection rendered the raw string
  "generic" with the default bot icon. `providerInfo` is the single table now.

  The ★ ACTIVE marker comes from `effectiveActiveId`, not from the stored id: with
  nothing chosen yet the FIRST connection is what the agent actually uses, and the
  table has to agree or the marker sits on no row at all.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { icon } from '../../utils/icons.js';
    import { providerInfo, effectiveActiveId } from '../../views/config/providers.js';

    let {
        instances = [],
        activeId = null,
        onSetActive = null,
        onEdit = null,
        onDelete = null,
    } = $props();

    const list = $derived(Array.isArray(instances) ? instances : []);
    const activeEffective = $derived(effectiveActiveId(list, activeId));
</script>

<div class="table-wrap">
    <table>
        <thead>
            <tr>
                <th class="cfg-col-default">{t('conn.default')}</th>
                <th>{t('common.provider')}</th>
                <th>{t('conn.name')}</th>
                <th>{t('common.model')}</th>
                <th>{t('conn.baseUrl')}</th>
                <th class="cfg-col-actions">{t('common.actions')}</th>
            </tr>
        </thead>
        <tbody>
            {#if !list.length}
                <tr>
                    <td colspan="6" class="cfg-table-empty">
                        {t('conn.none')}
                    </td>
                </tr>
            {:else}
                {#each list as inst (inst.id)}
                    {@const p = providerInfo(inst.provider)}
                    {@const isActive = activeEffective === inst.id}
                    <tr class:is-active={isActive}>
                        <td class="cfg-col-default">
                            <input
                                type="radio" name="active-llm-instance"
                                class="active-llm-radio" data-id={inst.id}
                                checked={isActive}
                                title={t('conn.default.title')}
                                onchange={() => onSetActive?.(inst.id)}
                            >
                        </td>
                        <!-- An unknown provider id gets the alert icon rather than the
                             generic bot: a typo used to look like a real provider. -->
                        <td class="cfg-provider" class:is-unknown={!p.known}>
                            <span class="cfg-provider-ic">{@html icon(p.icon, 15)}</span> {p.label}
                        </td>
                        <td class="cfg-inst-name">
                            {inst.name}
                            {#if isActive}<span class="cfg-active-tag">★ ACTIVE</span>{/if}
                        </td>
                        <td><code class="cfg-model">{inst.model}</code></td>
                        <td class="cfg-base-url">{inst.base_url || 'Default'}</td>
                        <td>
                            <div class="cfg-row-actions">
                                <button class="btn btn-secondary btn-sm btn-edit-instance"
                                    data-id={inst.id}
                                    onclick={() => onEdit?.(inst.id)}>{@html icon('edit', 12)} Edit</button>
                                <button class="btn btn-danger btn-sm btn-delete-instance"
                                    data-id={inst.id}
                                    onclick={() => onDelete?.(inst.id)}>{@html icon('trash', 12)} Delete</button>
                            </div>
                        </td>
                    </tr>
                {/each}
            {/if}
        </tbody>
    </table>
</div>
