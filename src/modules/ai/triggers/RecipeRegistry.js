// RecipeRegistry — the recipes that exist, and whether they may run.
//
// Two sources, one list: the ones that ship with the app (BUILTIN_RECIPES) and
// the ones in `<app_config_dir>/watchers/`. A user recipe with the id of a
// built-in WINS, because someone who put a file there meant it — but the fact
// is recorded so the UI can say so rather than leaving them wondering why the
// built-in behaves oddly.
//
// This layer also owns approval, which is the part that matters. A recipe is a
// file somebody can send you; a watcher runs it unattended on a timer. So
// before one is switched on, the app records WHAT it read — the hash of the
// recipe and its script, and the hosts it will talk to — and refuses to poll
// when what is on disk no longer matches. That is the sandbox substitute: not
// confinement, but a guarantee that the code that runs is the code that was
// approved.
//
// See docs/design/watcher-recipes.md.

import { invoke } from '@tauri-apps/api/core';
import { BUILTIN_RECIPES } from './recipes/builtinRecipes.js';
import { normalizeRecipe, validateRecipe, recipeHosts } from './recipes/recipeFormat.js';
import { sha256, approvalMatches } from './recipes/scriptContract.js';

const APPROVALS_KEY = 'jh_recipe_approvals';

export class RecipeRegistry {
    constructor({ invoker = null, storage = null } = {}) {
        this._invoke = invoker;
        this._storage = storage;
        /** @type {Map<string, object>} id -> recipe */
        this.recipes = new Map();
        /** @type {Map<string, string[]>} id -> why a file was rejected */
        this.rejected = new Map();
        this._loaded = false;
    }

    get invoke() { return this._invoke ?? invoke; }
    get storage() { return this._storage ?? globalThis.localStorage; }

    /**
     * Load the built-ins, then let the disk shadow them.
     *
     * Built-ins are normalized through exactly the same path as a file, so the
     * shipped format cannot quietly diverge from the one users have to write.
     */
    async refresh() {
        this.recipes = new Map();
        this.rejected = new Map();
        for (const raw of BUILTIN_RECIPES) {
            const r = normalizeRecipe({ ...raw, builtin: true }, raw.id);
            const problems = validateRecipe(r);
            // A broken built-in is OUR bug and must be loud in development, but
            // it must not take the panel down for a user who cannot fix it.
            if (problems.length) { this.rejected.set(r.id, problems); continue; }
            this.recipes.set(r.id, r);
        }

        let files = [];
        try { files = await this.invoke('list_watcher_recipes'); }
        catch (e) { files = []; }

        for (const f of files || []) {
            let raw = null;
            try { raw = JSON.parse(f.json || '{}'); }
            catch (e) {
                this.rejected.set(f.name, [`JSON として読めません: ${e.message}`]);
                continue;
            }
            const r = normalizeRecipe(raw, f.name);
            r.dir = f.dir || '';
            r.path = f.path || '';
            r.scriptPath = f.scriptPath || '';
            r.source = f.json || '';
            r.script = f.script || '';
            r.shadows = this.recipes.get(r.id)?.builtin ? r.id : '';
            const problems = validateRecipe(r);
            if (problems.length) { this.rejected.set(r.id || f.name, problems); continue; }
            this.recipes.set(r.id, r);
        }
        this._loaded = true;
        return this.getAll();
    }

    getAll() { return [...this.recipes.values()]; }

    /**
     * Check a recipe WITHOUT saving it.
     *
     * The same path a file goes through on load, so the editor cannot accept
     * something the loader would then reject — which would look like the recipe
     * had vanished after a successful save.
     *
     * @returns {{ok: boolean, problems: string[], recipe: object|null}}
     */
    check(json, id) {
        let parsed;
        try {
            parsed = JSON.parse(json);
        } catch (e) {
            return { ok: false, problems: [`JSON として読めません: ${e.message}`], recipe: null };
        }
        const r = normalizeRecipe(parsed, id);
        const problems = validateRecipe(r);
        return { ok: problems.length === 0, problems, recipe: r };
    }

    /**
     * Write a user recipe.
     *
     * Validated first, always. A recipe is code that runs unattended on a
     * timer; the moment to catch a broken one is while someone is looking at
     * it, not at 3am when a watcher stops firing.
     */
    async save(id, json) {
        const { ok, problems } = this.check(json, id);
        if (!ok) return { ok: false, problems };
        try {
            await this.invoke('write_watcher_recipe', { name: id, json });
        } catch (e) {
            return { ok: false, problems: [String(e?.message || e)] };
        }
        await this.refresh();
        return { ok: true, problems: [] };
    }

    /** Remove a user recipe. Built-ins are files we ship and cannot be deleted. */
    async remove(id) {
        try {
            await this.invoke('delete_watcher_recipe', { name: id });
        } catch (e) {
            return { ok: false, problems: [String(e?.message || e)] };
        }
        await this.refresh();
        return { ok: true, problems: [] };
    }

    /** Where user recipes live, for the "open the folder" button. */
    async folder() {
        try { return await this.invoke('watcher_recipes_dir'); }
        catch (_) { return ''; }
    }
    get(id) { return this.recipes.get(id) || null; }
    problemsFor(id) { return this.rejected.get(id) || []; }

    /**
     * What this recipe IS, as one string.
     *
     * The built-ins are hashed from their normalized form rather than from a
     * file, so an app update that changes one invalidates the approval — which
     * is the correct outcome: the user approved the old behaviour.
     */
    async fingerprint(recipe) {
        const body = recipe?.source ?? JSON.stringify({
            engine: recipe?.engine, config: recipe?.config, fields: recipe?.fields,
        });
        return sha256(`${body}\n---\n${recipe?.script || ''}`);
    }

    // ── Approvals ────────────────────────────────────────────────────────
    _approvals() {
        try { return JSON.parse(this.storage?.getItem(APPROVALS_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    }

    _writeApprovals(all) {
        try { this.storage?.setItem(APPROVALS_KEY, JSON.stringify(all)); }
        catch (_) { /* best effort */ }
    }

    approvalFor(watcherId) { return this._approvals()[watcherId] || null; }

    /** Record what the user saw when they switched this watcher on. */
    async approve(watcherId, recipe, values) {
        const hash = await this.fingerprint(recipe);
        const hosts = recipeHosts(recipe, values);
        const all = this._approvals();
        all[watcherId] = { hash, hosts, recipeId: recipe?.id || '', at: Date.now() };
        this._writeApprovals(all);
        return all[watcherId];
    }

    revoke(watcherId) {
        const all = this._approvals();
        delete all[watcherId];
        this._writeApprovals(all);
    }

    /**
     * May this watcher poll right now?
     *
     * Called before every poll, not only at save time. The recipe file can be
     * replaced between the two, and "it was fine when you enabled it" is not
     * something the app gets to assume about a file on disk.
     *
     * @returns {Promise<string|null>} the reason to refuse, or null
     */
    async blockedReason(watcher, recipe, values) {
        if (!recipe) return `レシピ「${watcher?.recipeId}」が見つかりません。`;
        const hash = await this.fingerprint(recipe);
        if (!hash) return 'レシピの内容を検証できませんでした。';
        const hosts = recipeHosts(recipe, values);
        const approval = this.approvalFor(watcher.id);
        // Two different situations, and telling them apart is the whole value
        // of the message: one is "you have not looked at this yet", the other is
        // "what you looked at is not what is on disk now".
        if (!approval) {
            return 'この監視はまだ内容を確認していません。編集画面で通信先とコマンドを'
                + '確認して、保存し直してください。';
        }
        if (!approvalMatches(approval, { hash, hosts })) {
            return 'レシピの内容か通信先が、確認したときから変わっています。'
                + '中身を確認して、保存し直してください。';
        }
        return null;
    }
}

export const recipeRegistry = new RecipeRegistry();
