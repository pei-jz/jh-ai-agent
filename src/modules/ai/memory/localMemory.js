// localMemory — the DEVELOPER'S OWN cross-workspace memory (P5, "Local-first
// memory", the Mem0-style trend from Report_20260815 §4).
//
// Workspace memory (.agent/ in each project) is scoped to ONE project. A
// developer's preferences and working patterns — "I write Rust + Svelte",
// "commit messages in English", "Japanese user-facing replies" — apply across
// ALL of them and today are re-learned (or re-forgotten) per project.
//
// This module stores that personal layer in the APP config directory
// (<configDir>/local_memory.json), NOT inside any workspace, so it:
//   • survives workspace switches (it is not tied to a project),
//   • is machine-local (never leaves the disk),
//   • is plain JSON the user can read and edit by hand.
//
// The file layout:
//   { "entries": [ { "text": "...", "category": "preference"|"pattern"|"style",
//                    "createdAt": "...", "updatedAt": "...", "score": <number> } ] }
//
// Entries are injected into the system prompt as a small standing block
// (localMemoryContext), ranked by relevance to the current task when a query is
// given. The cap keeps the block cheap — this is memory, not a document store.

/** Default cap on stored entries; beyond it the lowest-score entry is dropped. */
export const LOCAL_MEMORY_MAX_ENTRIES = 25;
/** How many entries the prompt injection may show (budget guard). */
export const LOCAL_MEMORY_INJECT_MAX = 5;

/** Absolute path of the local memory file under the app config directory. */
export function localMemoryPath(configDir) {
    return `${String(configDir || '').replace(/[\\/]+$/, '')}/local_memory.json`;
}

/**
 * Read the developer memory. A missing/corrupt file is an empty store, never
 * an error — the first write creates it.
 *
 * @param {string} configDir app config dir (get_app_config_dir)
 * @param {(cmd:string,args:object)=>Promise<any>} invoke
 * @returns {Promise<{entries:object[]}>}
 */
export async function readLocalMemory(configDir, invoke) {
    if (!configDir || typeof invoke !== 'function') return { entries: [] };
    try {
        const raw = await invoke('read_file', { path: localMemoryPath(configDir) });
        if (!raw) return { entries: [] };
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return { entries: entries.filter(e => e && typeof e.text === 'string' && e.text.trim()) };
    } catch (_) {
        return { entries: [] };
    }
}

/**
 * Register the app config dir with the Rust path guard and write the store.
 * Writing here IS the approval (mirrors allowMemoryDir for workspace memory).
 *
 * @param {string} configDir
 * @param {object[]} entries
 * @param {(cmd:string,args:object)=>Promise<any>} invoke
 */
export async function writeLocalMemory(configDir, entries, invoke) {
    if (!configDir || typeof invoke !== 'function') return;
    try { await invoke('set_allowed_roots', { roots: [configDir] }); } catch (_) { /* older backend */ }
    try {
        await invoke('write_file', {
            path: localMemoryPath(configDir),
            content: JSON.stringify({ entries: entries || [] }, null, 2),
        });
    } catch (e) {
        console.warn('Failed to write local memory:', e);
    }
}

/**
 * Normalize one entry and append it (or bump `updatedAt` on a near-duplicate).
 * Returns the new entries array — the caller persists it.
 *
 * Dedup is exact-ish: same trimmed text within the same category. An update
 * refreshes the timestamp and score instead of stacking a twin.
 *
 * @param {object[]} entries current entries
 * @param {object} entry { text, category?, score? }
 * @param {string} [now] ISO timestamp override (testability; default Date.now)
 * @returns {object[]}
 */
export function addLocalMemoryEntry(entries, entry, now = new Date().toISOString()) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const text = String(entry?.text || '').trim();
    if (!text) return list;
    const category = ['preference', 'pattern', 'style'].includes(entry.category)
        ? entry.category
        : 'preference';
    const existing = list.find(e =>
        e && e.category === category && String(e.text || '').trim() === text);
    if (existing) {
        return list.map(e => (e === existing
            ? { ...e, updatedAt: now, score: entry.score ?? e.score ?? 0 }
            : e));
    }
    const normalized = {
        text,
        category,
        createdAt: now,
        updatedAt: now,
        score: typeof entry.score === 'number' ? entry.score : 0,
    };
    const next = [...list, normalized];
    // Enforce the cap by EVICTING the weakest entry — lowest score, ties broken
    // by the oldest update. Insertion order is preserved for everything else.
    //
    // (Sorting the array by score and truncating, as this did originally, was
    // doubly wrong: it permanently reordered the store, and since every entry
    // defaults to score 0 the stable sort left the just-added entry last — so
    // once the store was full, every new memory was dropped on the spot.)
    if (next.length > LOCAL_MEMORY_MAX_ENTRIES) {
        let weakest = 0;
        for (let i = 1; i < next.length; i++) {
            const a = next[i], b = next[weakest];
            const sa = a.score ?? 0, sb = b.score ?? 0;
            if (sa < sb || (sa === sb && String(a.updatedAt || '') < String(b.updatedAt || ''))) {
                weakest = i;
            }
        }
        next.splice(weakest, 1);
    }
    return next;
}

/** Lightweight relevance: shared tokens between the entry text and the query. */
function relevanceScore(text, query) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const words = q.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/).filter(Boolean);
    if (words.length === 0) return 0;
    let hits = 0;
    for (const w of words) {
        if (w.length < 2) continue;
        if (text.toLowerCase().includes(w)) hits++;
    }
    return hits / words.length;
}

/**
 * Render the memory as a prompt block for injection, best entries first.
 * Empty store → '' (the caller emits nothing).
 *
 * @param {object[]} entries
 * @param {string} [query] current task text, for ranking
 * @returns {string}
 */
export function localMemoryContext(entries, query = '') {
    const list = (Array.isArray(entries) ? entries : [])
        .filter(e => e && typeof e.text === 'string' && e.text.trim());
    if (list.length === 0) return '';
    const ranked = list
        .map(e => ({ e, rel: relevanceScore(e.text, query) }))
        .sort((a, b) => (b.rel - a.rel) || ((b.e.score ?? 0) - (a.e.score ?? 0)));
    const shown = ranked.slice(0, LOCAL_MEMORY_INJECT_MAX);
    const body = shown.map(({ e }) => `- [${e.category}] ${e.text.trim()}`).join('\n');
    const hidden = ranked.length - shown.length;
    return `<developer_memory>
The developer's own cross-workspace preferences and working patterns (machine-local).
${body}
${hidden > 0 ? `…and ${hidden} more (kept in the local store, omitted from the prompt).` : ''}
</developer_memory>`;
}
