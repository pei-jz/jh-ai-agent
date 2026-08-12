<!--
  TemplatesTab — reusable prompts invoked as /command in chat.

  Region 5. The form's four fields were written into a template literal and read back
  with `getElementById('tpl-…').value`; the `readonly` on the key while editing was
  an inline style. Validation (the command-name charset in particular) is
  `templateRefusal` — pure and tested, because an invalid key produces a slash
  command that can never be invoked.
-->
<script>
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
    // Seeded once — see the note in ConnectionModal.svelte. untrack() says so to the
    // compiler instead of tripping its "only the initial value" warning.
    let form = $state(untrack(() => ({
        key: editing?.key || '',
        label: editing?.label || '',
        prompt: editing?.prompt || '',
        icon: editing?.icon || '📝',
    })));
    let error = $state('');
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

    const preview = (t) => {
        const s = String(t.prompt || '');
        return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head">
        <div>
            <h3>📝 Prompt Templates</h3>
            <p class="subtitle">Manage reusable prompts you can invoke by typing /command in chat</p>
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
                            <label class="input-label" for="tpl-key">
                                Slash command name <span class="cfg-req">*</span></label>
                            <!-- The key IS the identity, so editing one means creating
                                 another; locked rather than silently renaming. -->
                            <input id="tpl-key" class="input" type="text" bind:value={form.key}
                                readonly={isEdit} class:cfg-readonly={isEdit}
                                placeholder="e.g. backlog (letters, numbers, hyphens)">
                            <p class="input-hint">Invoke by typing <code>/name</code> in chat</p>
                        </div>
                        <div class="input-group">
                            <label class="input-label" for="tpl-label">
                                Display name <span class="cfg-req">*</span></label>
                            <input id="tpl-label" class="input" type="text" bind:value={form.label}
                                placeholder="e.g. Backlog task registration">
                        </div>
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="tpl-prompt">
                            Prompt text <span class="cfg-req">*</span></label>
                        <textarea id="tpl-prompt" class="textarea" rows="5" bind:value={form.prompt}
                            placeholder="Write the reusable prompt here."></textarea>
                        <p class="input-hint">This text is expanded into the chat input when the
                            slash command is selected</p>
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="tpl-icon">Icon</label>
                        <input id="tpl-icon" class="input cfg-icon-input" type="text"
                            bind:value={form.icon} placeholder="📝">
                    </div>
                </div>
                {#if error}<div class="cfg-modal-errors" role="alert">{error}</div>{/if}
                <div class="cfg-form-actions">
                    <button class="btn btn-secondary" id="btn-tpl-cancel" onclick={() => onCancel?.()}>Cancel</button>
                    <button class="btn btn-primary" id="btn-tpl-save" onclick={submit}>
                        {@html icon('save', 13)} Save</button>
                </div>
            </div>
        {/if}

        {#if !templates.length}
            <div class="cfg-empty">
                <span class="cfg-empty-ic">📝</span>
                <p>No templates yet.<br>Create one with the "Add new" button.</p>
            </div>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th class="cfg-col-icon">Icon</th>
                            <th>Command</th>
                            <th>Display name</th>
                            <th>Prompt (start)</th>
                            <th class="cfg-col-acts">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each templates as t (t.key)}
                            <tr>
                                <td class="cfg-col-icon cfg-emoji">{t.icon}</td>
                                <td><code class="cfg-cmd">/{t.key}</code></td>
                                <td class="cfg-inst-name">{t.label}</td>
                                <td class="cfg-prompt-preview">{preview(t)}</td>
                                <td>
                                    <div class="cfg-row-actions">
                                        <button class="btn btn-secondary btn-sm btn-tpl-edit" data-key={t.key}
                                            onclick={() => onEdit?.(t.key)}>{@html icon('edit', 12)} Edit</button>
                                        <button class="btn btn-danger btn-sm btn-tpl-delete" data-key={t.key}
                                            onclick={() => onDelete?.(t.key)}>{@html icon('trash', 12)}</button>
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
