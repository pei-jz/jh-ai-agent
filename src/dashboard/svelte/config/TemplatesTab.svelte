<!--
  TemplatesTab — reusable prompts invoked as /command in chat.

  Region 5. The form's four fields were written into a template literal and read back
  with `getElementById('tpl-…').value`; the `readonly` on the key while editing was
  an inline style. Validation (the command-name charset in particular) is
  `templateRefusal` — pure and tested, because an invalid key produces a slash
  command that can never be invoked.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { icon } from '../../utils/icons.js';
    import { templateRefusal } from '../../views/config/lists.js';

    let {
        templates = [],
        /** null = adding; otherwise the template being edited. */
        editing = null,
        showForm = false,
        onNew = null,
        onEdit = null,
        onDelete = null,
        onSave = null,
        onCancel = null,
    } = $props();

    const PREVIEW = 80;

    const blank = () => ({ key: '', label: '', prompt: '', icon: '📝' });
    let form = $state(untrack(blank));
    let error = $state('');

    /** Which row the form currently holds; null while it is closed. */
    let seededFor = $state(null);

    /**
     * Re-seed the form when it OPENS, and only then.
     *
     * `untrack` seeding was copied from ConnectionModal, where it is right: that
     * modal lives inside an `{#if}` and is mounted fresh on every open, so its
     * first read of the prop IS the current row. This tab is not — it is the tab
     * body, mounted once and kept. Clicking Edit changes the `editing` prop on an
     * already-mounted component, and a form seeded at mount (when `editing` was
     * null) stayed empty forever: every Edit showed a blank New form.
     *
     * The key is what is being edited, so typing does not re-seed — a $derived
     * would throw the draft away on every keystroke — while switching rows, or
     * closing and reopening, does.
     */
    $effect(() => {
        const key = showForm ? (editing?.key ?? '\u0000new') : null;
        if (key === seededFor) return;
        seededFor = key;
        if (key === null) return;
        error = '';
        form = editing
            ? {
                key: editing.key || '',
                label: editing.label || '',
                prompt: editing.prompt || '',
                icon: editing.icon || '📝',
            }
            : blank();
    });
    const isEdit = $derived(!!editing);

    const submit = () => {
        const next = {
            key: form.key.trim(),
            label: form.label.trim(),
            prompt: form.prompt,
            icon: form.icon.trim() || '📝',
        };
        error = templateRefusal(next) || '';
        if (error) return;
        onSave?.(next);
    };

    const preview = (tpl) => {
        const s = String(tpl.prompt || '');
        return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head">
        <div>
            <h3>📝 {t('tmpl.title')}</h3>
            <p class="subtitle">{t('tmpl.subtitle')}</p>
        </div>
        <button class="btn btn-primary" id="btn-tpl-new" onclick={() => onNew?.()}>
            {@html icon('plus', 13)} Add new</button>
    </div>

    <div class="cfg-tab-body">
        {#if showForm}
            <div class="cfg-inline-form">
                <h4 class="cfg-inline-form-h">
                    {#if isEdit}{@html icon('edit', 14)} Edit template
                    {:else}{@html icon('plus', 14)} New template{/if}
                </h4>
                <div class="provider-card-fields">
                    <div class="grid-2 cfg-gap-12">
                        <div class="input-group">
                            <label class="input-label" for="tpl-key">{t('tmpl.slashName')}<span class="cfg-req">*</span></label>
                            <!-- The key IS the identity, so editing one means creating
                                 another; locked rather than silently renaming. -->
                            <input id="tpl-key" class="input" type="text" bind:value={form.key}
                                readonly={isEdit} class:cfg-readonly={isEdit}
                                placeholder={t('tmpl.name.placeholder')}>
                            <p class="input-hint">{t('tmpl.invoke')}<code>/name</code> {t('skill.invoke.tail')}</p>
                        </div>
                        <div class="input-group">
                            <label class="input-label" for="tpl-label">{t('tmpl.label')}<span class="cfg-req">*</span></label>
                            <input id="tpl-label" class="input" type="text" bind:value={form.label}
                                placeholder={t('tmpl.title.placeholder')}>
                        </div>
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="tpl-prompt">{t('tmpl.promptText')}<span class="cfg-req">*</span></label>
                        <textarea id="tpl-prompt" class="textarea" rows="5" bind:value={form.prompt}
                            placeholder={t('tmpl.placeholder')}></textarea>
                        <p class="input-hint">{t('tmpl.expandHint')}</p>
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="tpl-icon">{t('common.icon')}</label>
                        <input id="tpl-icon" class="input cfg-icon-input" type="text"
                            bind:value={form.icon} placeholder="📝">
                    </div>
                </div>
                {#if error}<div class="cfg-modal-errors" role="alert">{error}</div>{/if}
                <div class="cfg-form-actions">
                    <button class="btn btn-secondary" id="btn-tpl-cancel" onclick={() => onCancel?.()}>{t('common.cancel')}</button>
                    <button class="btn btn-primary" id="btn-tpl-save" onclick={submit}>
                        {@html icon('save', 13)} Save</button>
                </div>
            </div>
        {/if}

        {#if !templates.length}
            <div class="cfg-empty">
                <span class="cfg-empty-ic">📝</span>
                <p>{t('tmpl.none')}<br>{t('tmpl.createHint')}</p>
            </div>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th class="cfg-col-icon">{t('common.icon')}</th>
                            <th>{t('common.command')}</th>
                            <th>{t('tmpl.label')}</th>
                            <th>{t('tmpl.promptStart')}</th>
                            <th class="cfg-col-acts">{t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each templates as tpl (tpl.key)}
                            <tr>
                                <td class="cfg-col-icon cfg-emoji">{tpl.icon}</td>
                                <td><code class="cfg-cmd">/{tpl.key}</code></td>
                                <td class="cfg-inst-name">{tpl.label}</td>
                                <td class="cfg-prompt-preview">{preview(tpl)}</td>
                                <td>
                                    <div class="cfg-row-actions">
                                        <button class="btn btn-secondary btn-sm btn-tpl-edit" data-key={tpl.key}
                                            onclick={() => onEdit?.(tpl.key)}>{@html icon('edit', 12)} Edit</button>
                                        <button class="btn btn-danger btn-sm btn-tpl-delete" data-key={tpl.key}
                                            onclick={() => onDelete?.(tpl.key)}>{@html icon('trash', 12)}</button>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </div>
</div>
