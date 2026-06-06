// FuzzyPath — PURE fuzzy file-name matching for path auto-correction.
// Extracted from ToolExecutor (Phase 3). The directory READ (invoke read_dir)
// stays in ToolExecutor; this module does the levenshtein + scoring + decision
// on an already-fetched entry list, so it's fully unit-testable.

/** Levenshtein edit distance (iterative, O(m·n)). */
export function levenshtein(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        let cur = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[n];
}

/**
 * Given a (possibly mistyped) resolved path and the entries of its parent dir,
 * pick the closest file. Returns { path, name, sim, autoCorrect, suggestions }
 * or null. Similarity is on the name-without-extension (+0.1 if the extension
 * matches). `autoCorrect` is true only for a STRONG (≥0.62) and clearly UNIQUE
 * (≥0.12 ahead of the runner-up) match, so we never silently hit the wrong file.
 *
 * @param {string} resolvedPath   the path the model asked for
 * @param {Array<{name:string,is_dir?:boolean}>} entries  parent-dir listing
 * @param {string} [workspacePath] fallback dir when path has no slash
 */
export function pickClosestFile(resolvedPath, entries, workspacePath = '.') {
    if (!Array.isArray(entries)) return null;
    const norm = String(resolvedPath).replace(/\\/g, '/');
    const lastSlash = norm.lastIndexOf('/');
    const dir = lastSlash > 0 ? norm.slice(0, lastSlash) : (workspacePath || '.');
    const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
    const baseLower = base.toLowerCase();
    const baseNoExt = baseLower.replace(/\.[^.]+$/, '');
    const baseExt = (baseLower.match(/\.[^.]+$/) || [''])[0];

    const scored = entries
        .filter(e => !e.is_dir)
        .map(e => {
            const n = e.name.toLowerCase();
            const nNoExt = n.replace(/\.[^.]+$/, '');
            const nExt = (n.match(/\.[^.]+$/) || [''])[0];
            const dist = levenshtein(nNoExt, baseNoExt);
            const sim = 1 - dist / Math.max(nNoExt.length, baseNoExt.length, 1);
            const extBonus = (nExt === baseExt && baseExt) ? 0.1 : 0;
            return { name: e.name, sim: sim + extBonus };
        })
        .sort((a, b) => b.sim - a.sim);

    if (scored.length === 0) return null;
    const best = scored[0];
    const second = scored[1];
    const autoCorrect = best.sim >= 0.62 && (!second || best.sim - second.sim >= 0.12);
    return {
        path: `${dir}/${best.name}`,
        name: best.name,
        sim: best.sim,
        autoCorrect,
        suggestions: scored.filter(s => s.sim > 0.3).slice(0, 5).map(s => `${dir}/${s.name}`),
    };
}
