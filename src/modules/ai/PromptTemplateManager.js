/**
 * Manages named prompt templates stored in ai_config.json → prompt_templates.
 *
 * Template shape: { label: string, prompt: string, icon?: string }
 * Storage key:    { [key]: Template }  — key is the slash command name, e.g. "backlog"
 */

class PromptTemplateManager {
    constructor() {
        this._templates = {};
        // Whether `_templates` reflects the stored map (loaded, or changed by
        // the user). Until then there is nothing to say about templates, and
        // toConfigValue must not claim "there are none".
        this._known = false;
    }

    /** Load templates from the live config object (call after getConfig). */
    loadFromConfig(config) {
        this._known = true;
        const raw = config?.prompt_templates;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            this._templates = raw;
        } else {
            this._templates = {};
        }
    }

    /** All templates as array of { key, label, prompt, icon }. */
    getAll() {
        return Object.entries(this._templates).map(([key, t]) => ({
            key,
            label: t.label || key,
            prompt: t.prompt || '',
            icon: t.icon || '📝',
        }));
    }

    /** Search templates whose key or label starts with/contains `query`. */
    search(query) {
        const q = query.toLowerCase();
        return this.getAll().filter(t =>
            t.key.toLowerCase().includes(q) ||
            t.label.toLowerCase().includes(q)
        );
    }

    /** Get a single template by key. */
    get(key) {
        const t = this._templates[key];
        if (!t) return null;
        return { key, label: t.label || key, prompt: t.prompt || '', icon: t.icon || '📝' };
    }

    /** Add or update a template. Returns updated raw map for saving. */
    set(key, label, prompt, icon = '📝') {
        this._known = true;
        this._templates[key] = { label, prompt, icon };
        return { ...this._templates };
    }

    /** Remove a template. Returns updated raw map for saving. */
    remove(key) {
        this._known = true;
        delete this._templates[key];
        return { ...this._templates };
    }

    /**
     * The raw map ready to embed in the config payload.
     *
     * An empty map is sent as `{}`, never `null`. The save merges the payload
     * over the stored config and reads `null` as "not mentioned — keep what is
     * stored" (merge_preserving in ai_config.rs), so deleting the LAST template
     * used to send `null` and the deleted template came straight back.
     * `null` is only for "never loaded": then there is nothing to overwrite with.
     */
    toConfigValue() {
        return this._known ? { ...this._templates } : null;
    }
}

export const promptTemplateManager = new PromptTemplateManager();
