// recipes — the launcher's one-click starts.
//
// Kimi K3's proposal called these 再利用レシピ and put them in the memory hub,
// next to what the agent had learned. They are here instead, beside the prompt
// field, because "run that again" is a way of STARTING a task, not a thing you
// browse. Putting them in the memory panel would mean the one control on that
// panel that does something is the one that leaves it.
//
// They are the app's existing prompt templates (Settings → Templates), so there
// is no second store to keep in sync — only a local counter recording which ones
// you actually reach for, so the list sorts itself instead of staying in
// whatever order they were defined.

/** localStorage key for the use counter: { [templateKey]: count }. */
export const USE_COUNTS_KEY = 'jhai_recipe_uses';
/** How many chips the launcher shows before the rest are behind Templates. */
export const RECIPE_LIMIT = 4;

/** Read the counter. A corrupt or absent value reads as "nothing used yet". */
export function readUseCounts(storage = globalThis.localStorage) {
    try {
        const raw = JSON.parse(storage?.getItem(USE_COUNTS_KEY) || '{}');
        return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (_) { return {}; }
}

/** Record one use. Silent on failure — a private-mode browser is not an error. */
export function recordUse(key, storage = globalThis.localStorage) {
    const k = String(key || '');
    if (!k) return readUseCounts(storage);
    const counts = readUseCounts(storage);
    counts[k] = (Number(counts[k]) || 0) + 1;
    try { storage?.setItem(USE_COUNTS_KEY, JSON.stringify(counts)); } catch (_) {}
    return counts;
}

/**
 * The chips to show: most-used first, then the rest in their defined order.
 *
 * Stable within a tie on purpose. A list that reshuffles between visits costs
 * you the muscle memory that made the shortcut worth having — the counter is
 * there to float the ones you use, not to keep the list moving.
 *
 * @param {Array<{key:string,label:string,prompt:string,icon?:string}>} templates
 * @param {Record<string, number>} counts
 * @param {number} limit
 */
export function rankRecipes(templates, counts = {}, limit = RECIPE_LIMIT) {
    const list = (Array.isArray(templates) ? templates : [])
        .filter(t => t && t.key && String(t.prompt || '').trim());
    return list
        .map((t, i) => ({ ...t, uses: Number(counts[t.key]) || 0, i }))
        .sort((a, b) => (b.uses - a.uses) || (a.i - b.i))
        .slice(0, limit);
}
