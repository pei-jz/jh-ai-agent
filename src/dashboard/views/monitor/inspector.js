// inspector — the CALCULATIONS behind the metadata column.
//
// Proposal A's contribution to the layout: keep the timeline a pure reading
// surface and move everything you *look up* — ids, timings, token flow, the
// files a run touched, the actions you might take — into a column of its own.
//
// ── What lives here, and what does not ────────────────────────────────────────
// The RENDERING moved to Svelte (dashboard/svelte/monitor/Inspector.svelte) as
// the first step of the migration. What is left is the part that is genuinely
// hard and genuinely worth testing on its own: cache accounting, cost splitting,
// and the shaping of a flat path list into a tree. Those are pure functions of
// their inputs, they have no DOM, and they are consumed by the components.
//
// Keeping them here rather than inside the .svelte files is deliberate: a
// component test has to mount to assert anything, while these can be checked
// directly with a table of inputs — which is how the cache-inclusive/exclusive
// provider disagreement got pinned down in the first place.

/** Tokens in the units a reader can hold in their head. */
export const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/**
 * Do the reported input tokens ALREADY include the cache reads?
 *
 * Providers disagree. OpenAI-compatible endpoints report `prompt_tokens`
 * INCLUSIVE of the cached part (total = prompt + completion); Anthropic reports
 * the two as separate buckets. Guessing by vendor would be wrong the first time
 * a new endpoint appeared, so ask the data instead: which accounting reproduces
 * the total the provider itself reported?
 *
 * This matters twice over — a bar that stacks in + cache + out double-counts the
 * cached tokens, and a cost that prices `prompt_tokens` at the full input rate
 * bills the cache twice.
 */
export function cacheInsideInput(usage = {}) {
    const inn = num(usage.prompt_tokens);
    const cache = num(usage.cache_read_input_tokens);
    if (!cache) return false;
    const out = num(usage.completion_tokens);
    const total = num(usage.total_tokens);
    if (!total) return inn > cache;   // no total to check against: the sizes tell
    return Math.abs(total - (inn + out)) <= Math.abs(total - (inn + out + cache));
}

/** Input tokens actually billed at the full rate, i.e. the part cache missed. */
export function freshInput(inn, cache, inclusive) {
    return inclusive ? Math.max(0, num(inn) - num(cache)) : num(inn);
}

/** USD, at the precision the number deserves — a run can cost less than a cent. */
export function fmtCost(usd) {
    const v = Number(usd);
    if (!Number.isFinite(v) || v <= 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
}

/**
 * What this run cost, split the same way the chart is.
 *
 * The input figure prices ONLY the tokens that missed the cache: billing the
 * whole `prompt_tokens` at the input rate charges the cached part twice, once
 * at full price and once at the cache rate.
 *
 * @param {object} usage token totals
 * @param {{input_per_1m, cache_read_per_1m, output_per_1m}} rates USD per 1M
 * @returns {{in:number, cache:number, out:number, total:number}|null}
 */
export function costOf(usage = {}, rates = null) {
    if (!rates) return null;
    const ri = Number(rates.input_per_1m) || 0;
    const rc = Number(rates.cache_read_per_1m) || 0;
    const ro = Number(rates.output_per_1m) || 0;
    if (!(ri || rc || ro)) return null;
    const inclusive = cacheInsideInput(usage);
    const cache = num(usage.cache_read_input_tokens);
    const per = (tok, rate) => (tok / 1_000_000) * rate;
    const c = {
        in: per(freshInput(usage.prompt_tokens, cache, inclusive), ri),
        cache: per(cache, rc),
        out: per(num(usage.completion_tokens), ro),
    };
    c.total = c.in + c.cache + c.out;
    return c;
}

/**
 * Group a flat list of touched paths into a directory TREE.
 *
 * The flat list of basenames it replaced could not answer the question you
 * actually bring to it — "what part of the project did this run change?" —
 * because twelve rows reading `index.js`, `index.js`, `index.js` say nothing
 * about where they live.
 *
 * Single-child directory chains are COLLAPSED into one row (`src/dashboard/views`
 * rather than three nested rows). Without that, a Java- or Rust-shaped tree spends
 * its whole width on indentation before reaching a filename.
 *
 * @param {Array<{path:string, action?:string}>} files
 * @param {string} workspace  paths under it are shown relative
 * @returns {{name:string, dirs:Map, files:Array}} root node
 */
export function buildFileTree(files, workspace = '') {
    const ws = String(workspace || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const root = { name: '', dirs: new Map(), files: [] };

    for (const f of (files || [])) {
        if (!f?.path) continue;
        const norm = String(f.path).replace(/\\/g, '/');
        // Relative to the workspace when it lives there; otherwise keep the
        // absolute path so an out-of-tree file is visibly out of tree.
        let rel = norm;
        if (ws && norm.toLowerCase().startsWith(ws + '/')) rel = norm.slice(ws.length + 1);
        const parts = rel.split('/').filter(Boolean);
        const name = parts.pop() || rel;
        let node = root;
        for (const p of parts) {
            if (!node.dirs.has(p)) node.dirs.set(p, { name: p, dirs: new Map(), files: [] });
            node = node.dirs.get(p);
        }
        node.files.push({ path: f.path, name, action: f.action || '' });
    }

    // Collapse a directory that holds exactly one subdirectory and no files:
    // `src` → `dashboard` → `views` becomes the single row `src/dashboard/views`.
    const collapse = (node) => {
        for (const [key, child] of [...node.dirs]) {
            let merged = collapse(child);
            while (merged.files.length === 0 && merged.dirs.size === 1) {
                const only = [...merged.dirs.values()][0];
                merged = { name: `${merged.name}/${only.name}`, dirs: only.dirs, files: only.files };
            }
            if (merged !== child) { node.dirs.delete(key); node.dirs.set(merged.name, merged); }
        }
        return node;
    };
    return collapse(root);
}

// NOTE: rendering used to continue here — treeRowsHtml / fileTreeHtml /
// inspectorHtml / chapterRailHtml, ~115 lines of string concatenation with
// hand-written escaping and hand-written indentation. All four are now
// dashboard/svelte/monitor/{Inspector,FileTree,Sparkline}.svelte.
//
// What that bought, concretely:
//   • the recursive tree IS the markup, instead of a function concatenating its
//     own indent strings;
//   • every interpolation is escaped by the compiler, so `esc()` around each
//     path and label is gone (and cannot be forgotten);
//   • a clickable row is a real <button> with an onclick, not a <div> that needed
//     a delegated handler registered somewhere else entirely — which is exactly
//     the split that left the approval buttons dead.
