/**
 * Manages Claude Code-style skill procedures stored as .md files.
 *
 * Global skills : <app_config_dir>/skills/<name>.md
 * Workspace skills : <workspacePath>/.agent/skills/<name>.md  (future)
 *
 * Skill file format:
 *   # Title line        ← first line, used as display label
 *   Description…        ← second line (optional), used as subtitle
 *
 *   Prompt content…     ← the rest becomes the prompt sent to the AI
 *
 * Invocation: user types /skill-name in the chat box. Selecting it from the
 * slash-popup attaches the skill as a chip (ChatView.activeSkills) rather than
 * dumping its body into the textarea. The full skill body is auto-injected
 * into the outgoing message at send time (ChatView.sendMessage), so the input
 * stays clean and the chat bubble shows only a small badge.
 */

import { invoke } from '@tauri-apps/api/core';

class SkillManager {
    constructor() {
        this._skills = [];   // [{ name, title, description, path }]
        this._loaded = false;
    }

    /** Reload skill list from disk. Call before opening slash-popup or Skills tab. */
    async refresh() {
        try {
            const files = await invoke('list_skill_files');
            this._skills = files.map(f => ({
                name: f.name,
                title: f.title || f.name,
                path: f.path,
            }));
            this._loaded = true;
        } catch (e) {
            console.warn('[SkillManager] Failed to list skill files:', e);
            this._skills = [];
        }
    }

    /** All loaded skills. */
    getAll() {
        return [...this._skills];
    }

    /** Filter skills by query (name or title). */
    search(query) {
        const q = query.toLowerCase();
        return this._skills.filter(s =>
            s.name.toLowerCase().includes(q) ||
            s.title.toLowerCase().includes(q)
        );
    }

    /** Read a skill's full content from disk. */
    async readContent(name) {
        return invoke('read_skill_file', { name });
    }

    /**
     * Build the prompt string to send when a skill is invoked.
     * Extra args (the portion after /skill-name) are appended after the skill body.
     */
    async buildPrompt(name, extraArgs = '') {
        const content = await this.readContent(name);
        const extra = extraArgs.trim();
        return extra ? `${content}\n\n${extra}` : content;
    }

    /** Save (create or overwrite) a skill file. */
    async save(name, content) {
        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
            throw new Error('スキル名には英数字・ハイフン・アンダースコアのみ使用できます。');
        }
        await invoke('write_skill_file', { name, content });
        await this.refresh();
    }

    /** Delete a skill file. */
    async delete(name) {
        await invoke('delete_skill_file', { name });
        this._skills = this._skills.filter(s => s.name !== name);
    }
}

export const skillManager = new SkillManager();
