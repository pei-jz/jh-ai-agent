/**
 * The skills the agent and the user share.
 *
 * A skill is a written procedure for a recurring job. Two layouts are read,
 * because the flat one is what already exists on disk:
 *
 *   <app_config_dir>/skills/<name>.md          flat — prose only
 *   <app_config_dir>/skills/<name>/SKILL.md    directory — may bundle scripts/
 *
 * `refresh()` loads METADATA ONLY — name, title, description, bundled files.
 * That is what makes the catalogue affordable: every skill costs one line of
 * context, and a body is fetched (readContent / the `read_skill` tool) when the
 * skill actually applies. Before this, the whole body of every attached skill
 * was pasted into the outgoing message and the agent could not see the others
 * at all.
 *
 * Invocation:
 *   • the user types /name — the skill becomes a chip and its body is injected
 *     at send time (SlashCommands.buildPrompt);
 *   • the agent reads the catalogue in its system prompt and calls `read_skill`.
 */

import { invoke } from '@tauri-apps/api/core';
import { skillMeta, skillCatalogue, skillPayload, isValidSkillName } from './skills/skillFormat.js';

class SkillManager {
    constructor() {
        /** [{name, title, description, allowedTools, files, scripts, path, dir}] — no bodies. */
        this._skills = [];
        this._loaded = false;
    }

    /** Reload the skill list from disk. Metadata only. */
    async refresh() {
        try {
            const files = await invoke('list_skill_files');
            this._skills = (files || []).map(f => ({
                name: f.name,
                title: f.title || f.name,
                description: f.description || '',
                allowedTools: splitTools(f.allowedTools),
                files: Array.isArray(f.files) ? f.files : [],
                scripts: (f.files || []).filter(x => String(x.rel || '').startsWith('scripts/')),
                path: f.path,
                dir: f.dir || '',
            }));
            this._loaded = true;
        } catch (e) {
            console.warn('[SkillManager] Failed to list skill files:', e);
            this._skills = [];
        }
        return this._skills;
    }

    /** All loaded skills. */
    getAll() {
        return [...this._skills];
    }

    get(name) {
        return this._skills.find(s => s.name === name) || null;
    }

    /** Filter by name, title or description — a description is often what you remember. */
    search(query) {
        const q = String(query || '').toLowerCase();
        if (!q) return this.getAll();
        return this._skills.filter(s =>
            s.name.toLowerCase().includes(q)
            || s.title.toLowerCase().includes(q)
            || (s.description || '').toLowerCase().includes(q));
    }

    /**
     * The one-line-per-skill list handed to the agent.
     *
     * This replaces the legacy `.agent/skills.json` the agent used to read: a
     * separate store the Skills tab could not edit and `/…` could not see, so
     * the two never held the same skills.
     */
    catalogue() {
        return skillCatalogue(this._skills);
    }

    /** Read a skill's raw file, header and all. */
    async readContent(name) {
        return invoke('read_skill_file', { name });
    }

    /**
     * A skill as it should be received: the body, plus where its bundled files
     * are, so a skill that ships a script need not explain the path.
     */
    async load(name) {
        if (!isValidSkillName(name)) throw new Error(`Invalid skill name: '${name}'`);
        const raw = await this.readContent(name);
        const meta = skillMeta(name, raw);
        const known = this.get(name);
        const files = known?.files || [];
        const dir = known?.dir || '';
        return {
            meta,
            files,
            dir,
            text: skillPayload(
                {
                    ...meta,
                    allowedTools: meta.allowedTools?.length ? meta.allowedTools : (known?.allowedTools || []),
                },
                { body: meta.body, files, dir },
            ),
        };
    }

    /** Read one file bundled with a skill (scripts/…, references/…). */
    async readResource(name, rel) {
        return invoke('read_skill_resource', { name, rel });
    }

    /**
     * Build the prompt sent when a skill is invoked from the chat box.
     * Extra args (what follows /name) are appended after the body.
     */
    async buildPrompt(name, extraArgs = '') {
        const { text } = await this.load(name);
        const extra = String(extraArgs || '').trim();
        return extra ? `${text}\n\n${extra}` : text;
    }

    /** Save (create or overwrite) a skill. An existing directory keeps its layout. */
    async save(name, content) {
        if (!isValidSkillName(name)) {
            throw new Error('スキル名には英数字・ハイフン・アンダースコアのみ使用できます。');
        }
        await invoke('write_skill_file', { name, content });
        await this.refresh();
    }

    /** Turn a flat skill into a directory one, so files can be bundled with it. */
    async promoteToDirectory(name) {
        if (!isValidSkillName(name)) throw new Error(`Invalid skill name: '${name}'`);
        const dir = await invoke('promote_skill_to_dir', { name });
        await this.refresh();
        return dir;
    }

    /** Delete a skill — the file, or the directory with what it bundles. */
    async delete(name) {
        await invoke('delete_skill_file', { name });
        this._skills = this._skills.filter(s => s.name !== name);
    }
}

/** `allowed-tools` arrives from Rust as the raw header string. */
function splitTools(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

export const skillManager = new SkillManager();
