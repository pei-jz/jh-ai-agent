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
        /** (name) => void — turn a flat skill into a directory so it can bundle files. */
        onBundle = null,
    } = $props();

    const isEdit = $derived(!!editing);

    let form = $state(untrack(() => ({ name: '', content: '' })));
    let error = $state('');

    /** Which skill the form currently holds; null while it is closed. */
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
        const key = showForm ? (editing?.name ?? '\u0000new') : null;
        if (key === seededFor) return;
        seededFor = key;
        if (key === null) return;
        error = '';
        // The name is the file on disk, so it is not editable — and not seeded.
        form = { name: '', content: editing?.content || '' };
    });

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
            <p class="subtitle">Written procedures the agent can load on demand.
                Saved in <code>~/.config/JH AI Agent/skills/</code>. The agent is shown
                the <strong>description only</strong> and reads the body when the skill
                applies, so a long procedure costs nothing until it is used.</p>
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
                        <p class="input-hint">
                            Start with a <code>---</code> header so the agent knows when this
                            skill applies — the <code>description</code> is the only part it
                            sees until it loads the skill:
                        </p>
<pre class="cfg-fm-example">---
description: Build the monthly report from the raw export.
allowed-tools: read_office, write_xlsx
---
# Monthly report

1. …</pre>
                        <p class="input-hint">Without a header the old rule still applies:
                            the first line is the title and the next line is the description.</p>
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
                            <th>Description</th>
                            <th>Files</th>
                            <th class="cfg-col-acts">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each skills as s (s.name)}
                            <tr>
                                <td><code class="cfg-cmd">/{s.name}</code></td>
                                <td class="cfg-inst-name">
                                    <div>{s.title}</div>
                                    <!-- What the agent is shown. Saying so is the point:
                                         a skill with no description is one it will never
                                         reach for. -->
                                    {#if s.description}
                                        <div class="cfg-skill-desc">{s.description}</div>
                                    {:else}
                                        <div class="cfg-skill-desc is-missing">
                                            No description — the agent cannot tell when to use this.
                                        </div>
                                    {/if}
                                </td>
                                <td>
                                    {#if s.dir}
                                        <span class="cfg-skill-files" title={s.dir}>
                                            📁 {s.files?.length || 0}</span>
                                    {:else}
                                        <button class="btn btn-secondary btn-sm btn-skill-bundle" data-name={s.name}
                                            title="Turn into a folder so scripts and references can be bundled with it"
                                            onclick={() => onBundle?.(s.name)}>+ files</button>
                                    {/if}
                                </td>
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

<style>
    .cfg-skill-desc {
        font-size: 11.5px; color: var(--text-secondary);
        margin-top: 2px; line-height: 1.45;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .cfg-skill-desc.is-missing { color: var(--text-tertiary); font-style: italic; }
    .cfg-skill-files { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
    .cfg-fm-example {
        margin: 4px 0 6px;
        padding: 8px 10px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-sm);
        font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
        color: var(--text-secondary);
        white-space: pre; overflow-x: auto;
    }
</style>
