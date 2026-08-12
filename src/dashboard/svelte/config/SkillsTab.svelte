<!--
  SkillsTab — invocable procedures, the /skill equivalent.

  Region 5. Same shape as TemplatesTab: a table plus an inline form whose fields were
  read back by id. The name field is absent while editing because the name IS the
  file on disk — that was previously expressed by conditionally omitting the markup
  AND by a matching branch in the save handler, two places to keep in step.
-->
<script>
    import { untrack } from 'svelte';
    import { icon } from '../../utils/icons.js';
    import { skillRefusal } from '../../views/config/lists.js';

    let {
        skills = [],
        /** null = adding; otherwise {name, content}. */
        editing = null,
        showForm = false,
        onNew = null,
        onEdit = null,
        onDelete = null,
        onSave = null,
        onCancel = null,
    } = $props();

    const isEdit = $derived(!!editing);
    // Seeded once — see the note in ConnectionModal.svelte.
    let form = $state(untrack(() => ({ name: '', content: editing?.content || '' })));
    let error = $state('');

    const submit = () => {
        const next = {
            name: isEdit ? editing.name : form.name.trim(),
            content: form.content,
        };
        error = skillRefusal(next, isEdit) || '';
        if (error) return;
        onSave?.(next);
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head">
        <div>
            <h3>{@html icon('bolt', 15)} Skills</h3>
            <p class="subtitle">Invocable procedures like Claude Code's /skill.
                Saved in <code>~/.config/JH AI Agent/skills/</code>.</p>
        </div>
        <button class="btn btn-primary" id="btn-skill-new" onclick={() => onNew?.()}>
            {@html icon('plus', 13)} Create new</button>
    </div>

    <div class="cfg-tab-body">
        {#if showForm}
            <div class="cfg-inline-form">
                <h4 class="cfg-inline-form-h">
                    {#if isEdit}{@html icon('edit', 14)} Edit skill: {editing.name}
                    {:else}{@html icon('plus', 14)} New skill{/if}
                </h4>
                <div class="provider-card-fields">
                    <!-- No name field while editing: the name is the file. -->
                    {#if !isEdit}
                        <div class="input-group">
                            <label class="input-label" for="skill-name">
                                Skill name <span class="cfg-req">*</span></label>
                            <input id="skill-name" class="input" type="text" bind:value={form.name}
                                placeholder="e.g. backlog-register (letters, numbers, hyphens, underscores)">
                            <p class="input-hint">Invoke by typing <code>/skill-name</code> in chat</p>
                        </div>
                    {/if}
                    <div class="input-group">
                        <label class="input-label" for="skill-content">
                            Content (Markdown) <span class="cfg-req">*</span></label>
                        <textarea id="skill-content" class="textarea cfg-mono-area" rows="12"
                            bind:value={form.content}
                            placeholder="# Skill title"></textarea>
                        <p class="input-hint">The first line <code># Title</code> becomes the display
                            name. Selecting the slash command expands this entire text into the prompt.</p>
                    </div>
                </div>
                {#if error}<div class="cfg-modal-errors" role="alert">{error}</div>{/if}
                <div class="cfg-form-actions">
                    <button class="btn btn-secondary" id="btn-skill-cancel" onclick={() => onCancel?.()}>Cancel</button>
                    <button class="btn btn-primary" id="btn-skill-save" onclick={submit}>
                        {@html icon('save', 13)} Save</button>
                </div>
            </div>
        {/if}

        {#if !skills.length}
            <div class="cfg-empty">
                <span class="cfg-empty-ic">⚡</span>
                <p>No skills yet.<br>Create one with the "Create new" button.</p>
            </div>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Command</th>
                            <th>Title</th>
                            <th class="cfg-col-acts">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each skills as s (s.name)}
                            <tr>
                                <td><code class="cfg-cmd">/{s.name}</code></td>
                                <td class="cfg-inst-name">{s.title}</td>
                                <td>
                                    <div class="cfg-row-actions">
                                        <button class="btn btn-secondary btn-sm btn-skill-edit" data-name={s.name}
                                            onclick={() => onEdit?.(s.name)}>{@html icon('edit', 12)} Edit</button>
                                        <button class="btn btn-danger btn-sm btn-skill-delete" data-name={s.name}
                                            onclick={() => onDelete?.(s.name)}>{@html icon('trash', 12)}</button>
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
