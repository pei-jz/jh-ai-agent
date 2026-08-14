// CodeIndex — building and reading the structural index.
//
// The pure half of the SQLite index in commands/code_index.rs: what counts as a
// dependency edge, how a file is hashed for incremental re-indexing, and how a
// query result is rendered for the agent. The I/O is `invoke`, injected.
//
// The index is QUERIED, never injected. That distinction is the whole reason
// this exists separately from cards.jsonl — see the header of code_index.rs.

/**
 * Content hash for change detection.
 *
 * FNV-1a over the text: not cryptographic, and does not need to be. It answers
 * "did this file change since we parsed it", where the cost of a collision is
 * one stale entry until the next edit, and the cost of a slow hash is a pass
 * over every file in the project.
 */
export function contentHash(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${h.toString(16)}-${s.length}`;
}

/** Language tag from a path, matching what SymbolIndex can parse. */
export function langOf(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js';
    if (['ts', 'tsx'].includes(ext)) return 'ts';
    if (ext === 'rs') return 'rust';
    if (ext === 'py') return 'python';
    if (ext === 'java') return 'java';
    if (ext === 'svelte') return 'svelte';
    if (['xlsx', 'xlsm', 'xls'].includes(ext)) return 'excel';
    return ext || '';
}

const IMPORT_RE = [
    // import … from '…' / export … from '…'
    /^\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/,
    // import '…'  (side-effect)
    /^\s*import\s*['"]([^'"]+)['"]/,
    // require('…')
    /require\(\s*['"]([^'"]+)['"]\s*\)/,
    // dynamic import('…')
    /import\(\s*['"]([^'"]+)['"]\s*\)/,
];

/**
 * Relative imports a file declares, resolved against its own directory.
 *
 * Package imports are deliberately dropped: `import { invoke } from
 * '@tauri-apps/api/core'` is a fact about the ecosystem, not about this
 * project's shape, and including them would bury the edges that answer "what in
 * OUR code breaks if I change this".
 *
 * @param {string} path the importing file, workspace-relative or absolute
 * @param {string} content its source
 * @returns {string[]} resolved destination paths
 */
export function importEdges(path, content) {
    const out = new Set();
    const dir = String(path || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    for (const line of String(content || '').split('\n')) {
        if (line.length > 400) continue;             // minified bundle, not source
        for (const re of IMPORT_RE) {
            const m = line.match(re);
            if (!m) continue;
            const spec = m[1];
            if (!spec.startsWith('.')) break;        // package, not our code
            out.add(resolveRelative(dir, spec));
            break;
        }
    }
    return [...out];
}

/** Join a relative specifier onto a directory, collapsing `.` and `..`. */
export function resolveRelative(dir, spec) {
    const parts = String(dir || '').split('/').filter(Boolean);
    for (const seg of String(spec || '').split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
}

/**
 * Which files need re-parsing, given what the index already holds.
 *
 * @param {Array<{path:string, hash:string}>} current what the tree has now
 * @param {Array<[string,string]>} known  path/hash pairs from the index
 */
export function changedFiles(current, known) {
    const map = new Map(known || []);
    return (current || []).filter(f => map.get(f.path) !== f.hash);
}

/**
 * Render index hits for the agent.
 *
 * Compact on purpose: this is a tool RESULT, and the saving that justifies an
 * index at all comes from it being small. Path and line, nothing else — the
 * agent reads the file if it wants the body.
 */
export function renderSymbolHits(hits, query) {
    const rows = Array.isArray(hits) ? hits : [];
    if (rows.length === 0) {
        return `No declaration of "${query}" in the index. `
            + 'It may be a local name, or the index may not cover this file type — '
            + 'fall back to grep_search.';
    }
    const lines = rows.map(h =>
        `${h.name}${h.kind ? ` (${h.kind})` : ''}${h.exported ? ' [exported]' : ''} — ${h.path}:${h.line}`);
    return `${rows.length} declaration(s) of "${query}":\n${lines.join('\n')}`;
}

/** Render a dependency answer. */
export function renderDeps(hits, path, direction) {
    const rows = Array.isArray(hits) ? hits : [];
    const heading = direction === 'in'
        ? `Files that depend on ${path}`
        : `Files ${path} depends on`;
    if (rows.length === 0) {
        return `${heading}: none recorded. `
            + '(Only relative imports within this project are indexed, and only for files the study pass has read.)';
    }
    return `${heading} (${rows.length}):\n${rows.map(h => `- ${h.path}${h.kind !== 'imports' ? ` [${h.kind}]` : ''}`).join('\n')}`;
}

/**
 * How much of the tree the index actually covers, per area.
 *
 * The one question nobody's tooling answers: not "what does the agent know" but
 * "what does it NOT know". An area with no rows is one where every answer it
 * gives is a guess, and that is worth seeing before trusting one.
 *
 * @param {string[]} paths indexed paths
 * @param {{root?:string, depth?:number, limit?:number}} opts
 */
export function coverage(paths, { root = '', depth = 2, limit = 12 } = {}) {
    const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const counts = new Map();
    for (const raw of (paths || [])) {
        let p = String(raw || '').replace(/\\/g, '/');
        if (!p) continue;
        if (r && p.toLowerCase().startsWith(r + '/')) p = p.slice(r.length + 1);
        // A workbook sheet (`book.xlsx#Sheet`) belongs to its workbook's folder.
        p = p.split('#')[0];
        const parts = p.split('/');
        // Never let the FILENAME become the directory: `lib/z.js` at depth 2 is
        // the area `lib`, not the area `lib/z.js`.
        const dir = parts.length > 1
            ? parts.slice(0, Math.min(depth, parts.length - 1)).join('/')
            : '(root)';
        counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([dir, files]) => ({ dir, files }))
        .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
        .slice(0, limit);
}

/** Thin I/O wrapper so callers do not repeat the command names. */
export class CodeIndexClient {
    constructor({ workspacePath, invoke } = {}) {
        this.workspacePath = workspacePath || '';
        this._invoke = invoke;
        this.enabled = !!(this.workspacePath && typeof invoke === 'function');
    }

    /**
     * Indexed path/hash pairs. Shape-checked rather than trusted: a backend that
     * predates this command, or one that errors into a string, would otherwise
     * be fed to `new Map()` and take the whole study pass down.
     */
    async knownHashes() {
        if (!this.enabled) return [];
        try {
            const rows = await this._invoke('index_hashes', { workspace: this.workspacePath });
            if (!Array.isArray(rows)) return [];
            return rows.filter(r => Array.isArray(r) && r.length >= 2);
        } catch (_) { return []; }
    }

    async putFiles(files) {
        if (!this.enabled || !files.length) return 0;
        return await this._invoke('index_put_files', { workspace: this.workspacePath, files });
    }

    async prune(livePaths, { truncated = false } = {}) {
        if (!this.enabled) return 0;
        try {
            return await this._invoke('index_prune', {
                workspace: this.workspacePath, livePaths, truncated,
            });
        }
        catch (_) { return 0; }
    }

    async findSymbol(query, { kind = '', limit = 40 } = {}) {
        if (!this.enabled) return [];
        return await this._invoke('index_find_symbol', {
            workspace: this.workspacePath, query, kind, limit,
        }) || [];
    }

    async deps(path, { direction = 'out', limit = 60 } = {}) {
        if (!this.enabled) return [];
        return await this._invoke('index_deps', {
            workspace: this.workspacePath, path, direction, limit,
        }) || [];
    }

    async stats() {
        if (!this.enabled) return { files: 0, symbols: 0, edges: 0, languages: [] };
        try { return await this._invoke('index_stats', { workspace: this.workspacePath }); }
        catch (_) { return { files: 0, symbols: 0, edges: 0, languages: [] }; }
    }
}
