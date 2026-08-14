// StudyPass — learn a workspace's STRUCTURE up front, without running a task.
//
// Step 3.8 of docs/design/agent-memory-learning.plan.md, and the answer to a
// limitation of everything before it: experience only records where the agent
// happened to walk. Lessons come from where it failed, insights from where it
// recovered, locators from what it searched. The result is a map of "places we
// stumbled and places we looked", never a map of the project — and it is skewed
// with a direction, over-representing the awkward corners and missing the
// central-but-straightforward ones entirely.
//
// Humans do not learn a codebase that way. The structure, the vocabulary and the
// conventions come first, and episodes attach to that frame. Without the frame,
// episodes never generalise.
//
// ── Why this pass uses NO LLM ───────────────────────────────────────────────
// The rest of the memory layer records only what was OBSERVED (review item A1),
// and study would be the one exception: reading code and writing down what it
// probably means is inference, not observation. Adding a pile of unverified
// claims to a store whose whole credibility rests on being verified is a bad
// trade.
//
// So this pass records only things that are FACTS about the tree:
//
//   • a symbol is declared at file:line          — parsed, not guessed
//   • a directory contains N source files        — counted
//
// which is why its output can sit beside experience without a confidence
// discount. Summarising what a module is FOR needs a model, and that is a
// separate step, gated on this one proving insufficient.
//
// ── Staleness (Step 5a) ────────────────────────────────────────────────────
// Structural knowledge rots: the symbol moves, the file is deleted. Every card
// minted here carries the commit it was read at, so a later pass can retire what
// no longer matches instead of leaving the agent confidently wrong.

import { extractSymbols } from '../tools/SymbolIndex.js';
import { fingerprint, extOf } from './FailureSignature.js';
import { CodeIndexClient, contentHash, langOf, importEdges } from './CodeIndex.js';

/**
 * The file part of a `path:line` target.
 *
 * NOT `split(':')[0]` — on Windows every absolute path this app produces starts
 * `C:\…`, so that returns the drive letter and every path comparison silently
 * fails. Only a trailing `:digits` is the line number.
 */
export function targetPath(target) {
    return String(target || '').replace(/:\d+$/, '');
}

/** Files parsed per pass. A cap, not a target — the point is breadth, not depth. */
export const STUDY_FILE_CAP = 1000;
/** Symbols kept per file. A 2000-line module does not need 300 entries here. */
export const SYMBOLS_PER_FILE = 12;
/** Source types SymbolIndex can actually parse. */
export const STUDY_GLOB = '**/*.{js,jsx,mjs,cjs,ts,tsx,rs,py,java}';
/**
 * Workbooks, indexed for their formula graph.
 *
 * A cross-sheet formula is an explicit dependency — `=SUM(Sheet2!B:B)` states
 * outright that this sheet reads that one — so it belongs in the same edge table
 * as an import. In a lot of enterprise work the real system knowledge lives in
 * the workbook rather than the code, and indexing only source leaves the agent
 * blind to the half that decides the answer.
 */
export const STUDY_SHEET_GLOB = '**/*.{xlsx,xlsm}';
/** Workbooks opened per pass. Lower than the source cap: each one is a zip read. */
export const SHEET_FILE_CAP = 60;
/**
 * Depth of the directory buckets for the fair-share selection.
 * `src/modules/ai/a.js` at depth 2 is the area `src/modules`.
 */
export const FAIRSHARE_DEPTH = 2;

/**
 * Directory prefix of a path, bucketed for fair-share selection.
 *
 * Workspace-relative or absolute, forward or back slashes — always normalised
 * to forward slashes first so the two never disagree.
 */
export function dirOf(path, depth = FAIRSHARE_DEPTH) {
    let parts = String(path || '').replace(/\\/g, '/').split('/');
    // A leading drive letter (`C:`) is not a directory. Without dropping it,
    // every absolute Windows path under one drive buckets to the same place and
    // the fair share never spreads.
    if (parts.length > 1 && /^[A-Za-z]:$/.test(parts[0])) parts = parts.slice(1);
    const dir = parts.length > 1
        ? parts.slice(0, Math.min(depth, parts.length - 1)).join('/')
        : '(root)';
    return dir || '(root)';
}

/**
 * Pick `cap` files spread across directories, not dominated by one.
 *
 * A 2000-file monorepo with 1900 files in `src/a` and 100 everywhere else must
 * not produce an index that is 95% one area: the search that matters is "where
 * is X in a place I have not looked", and a cap that always spends itself on
 * the busiest directory never reaches the places the agent has not looked.
 *
 * Round-robin over the directory buckets, one file per bucket per round. When a
 * bucket runs out, its budget is re-spent on the remaining ones — so a bucket
 * with few files is not starved, it just finishes early.
 *
 * @param {string[]} files all matching files, in glob order
 * @param {number} cap how many to keep
 * @returns {{selected: string[], omitted: number}} the kept paths and how many were skipped
 */
export function fairShare(files, cap = STUDY_FILE_CAP) {
    if (!Array.isArray(files) || files.length <= cap) {
        return { selected: files || [], omitted: 0 };
    }
    const buckets = new Map();
    for (const f of files) {
        const d = dirOf(f);
        if (!buckets.has(d)) buckets.set(d, []);
        buckets.get(d).push(f);
    }
    const keys = [...buckets.keys()];
    const selected = [];
    const seen = new Set(keys);
    while (selected.length < cap && seen.size > 0) {
        for (const d of keys) {
            if (!seen.has(d)) continue;
            const list = buckets.get(d);
            if (!list.length) { seen.delete(d); continue; }
            selected.push(list.shift());
            if (selected.length >= cap) break;
        }
        // Drop buckets that ran dry so their budget flows to the rest.
        for (const d of [...seen]) {
            if (!buckets.get(d).length) seen.delete(d);
        }
    }
    return { selected, omitted: files.length - selected.length };
}

/**
 * Is this symbol worth remembering as "where X lives"?
 *
 * Exported/public names are the ones another task will search for. A local
 * helper called `fmt` is real, and useless as a landmark: it exists in fifty
 * files and matches every future query for none of the right reasons.
 */
export function isLandmark(sym) {
    const name = String(sym?.name || '');
    if (name.length < 4 || name.length > 60) return false;
    // Anonymous / generated names carry no meaning for a later search.
    if (/^(default|constructor|anonymous|main|init|new|run|get|set)$/i.test(name)) return false;
    return true;
}

/**
 * Turn parsed symbols into locator cards — the SAME shape experience produces,
 * because they answer the same question ("where is X?") with the same kind of
 * evidence. The origin field is what distinguishes them for review and pruning.
 *
 * @param {Array<{name,kind,line,path}>} symbols
 * @param {{date:string, commit?:string}} meta
 */
export function symbolCards(symbols, { date, commit = '' } = {}) {
    const out = [];
    const seen = new Set();
    for (const s of (symbols || [])) {
        if (!isLandmark(s)) continue;
        const target = `${s.path}:${s.line}`;
        const key = `${s.name}|${s.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            id: `S-${fingerprint(key)}`,
            type: 'insight', kind: 'locator',
            // No `signature`: cardKey() keys a locator by q + target.
            q: s.name,
            target,
            what: `"${s.name}" → ${target}`,
            trigger: { tool: 'grep_search', ext: extOf(s.path), scope: 'workspace' },
            // Read from the tree, not inferred — same standing as a locator the
            // agent verified by using it.
            origin: 'study',
            symbolKind: s.kind,
            hits: 1, shown: 0, recurrences_after_hit: 0,
            confidence: 0.6,
            costSteps: 1,
            first_seen: date, last_recurrence: date,
            stale: false, disabled: false,
            evidence: commit ? [`commit:${commit}`] : [],
        });
    }
    return out;
}

/**
 * Which study-derived cards no longer match the tree, given the files that exist
 * now. Pure: takes the answer to "what files are there", returns what to retire.
 *
 * Only `origin: 'study'` cards are judged. An experience card records something
 * that DID happen; the file moving does not make it untrue, and retiring it
 * would erase history. A study card is a claim about the present, and a claim
 * about a file that is gone is simply wrong.
 *
 * @param {Array} cards
 * @param {Set<string>|Array<string>} livePaths paths that exist now
 * @returns {{stale: Array, fresh: Array}}
 */
export function staleStudyCards(cards, livePaths) {
    const live = livePaths instanceof Set ? livePaths : new Set(livePaths || []);
    const stale = [];
    const fresh = [];
    for (const c of (cards || [])) {
        if (c?.origin !== 'study') { fresh.push(c); continue; }
        const path = targetPath(c.target);
        (live.has(path) ? fresh : stale).push(c);
    }
    return { stale, fresh };
}

/**
 * Fold a completed study into a card store: retire what the tree no longer has,
 * then merge what it does. Pure — the caller owns the I/O.
 *
 * Retired cards are DROPPED rather than flagged: unlike a lesson, a locator for
 * a deleted file has no residual value, and keeping it would only make the
 * store's size stop meaning anything.
 */
export function applyStudy(existing, minted, livePaths) {
    const { fresh } = staleStudyCards(existing, livePaths);
    const byKey = new Map(fresh.map(c => [`${c.q}|${c.target}`, c]));
    for (const c of minted) {
        const key = `${c.q}|${c.target}`;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, c); continue; }
        // Seen again by a later pass: keep the richer record, refresh the date.
        prev.last_recurrence = c.last_recurrence;
        prev.stale = false;
        if (c.evidence?.length) prev.evidence = c.evidence;
    }
    return [...byKey.values()];
}

/**
 * Drop cards the first study pass wrote into cards.jsonl.
 *
 * A migration, run once by the next study. Those rows recorded where a symbol
 * was — which now lives in the index, where it can be queried instead of listed
 * — so leaving them would keep 700-odd unreadable entries in a panel whose whole
 * purpose is being reviewable. Experience cards are untouched: they record what
 * happened, which nothing else holds.
 *
 * @returns {{kept: Array, dropped: number}}
 */
export function dropStudyCards(cards) {
    const all = Array.isArray(cards) ? cards : [];
    const kept = all.filter(c => c?.origin !== 'study');
    return { kept, dropped: all.length - kept.length };
}

/** Per-directory counts, for the coverage read-out (Step 3.9). */
export function coverageByDir(cards, depth = 2) {
    const counts = new Map();
    for (const c of (cards || [])) {
        const path = targetPath(c?.target);
        if (!path) continue;
        const dir = path.replace(/\\/g, '/').split('/').slice(0, depth).join('/');
        counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([dir, count]) => ({ dir, count }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Run a study pass over a workspace.
 *
 * Writes to the SQLite index, not to cards. The first version of this pass wrote
 * one card per symbol and produced 716 rows of `setSel → NewFileModal.js:307` in
 * a list the user was expected to read: symbols are a lookup, not advice, and a
 * lookup belongs behind a query.
 *
 * Incremental by content hash — a second pass over an unchanged tree parses
 * nothing. Returns the digest the overview step summarises, so the caller does
 * not have to read the index back out.
 *
 * @param {{workspacePath:string, invoke:Function, onProgress?:Function,
 *          fileCap?:number, commit?:string}} opts
 */
export async function runStudyPass({
    workspacePath, invoke, onProgress = null, fileCap = STUDY_FILE_CAP, commit = '',
} = {}) {
    if (!workspacePath || typeof invoke !== 'function') {
        return { files: 0, parsed: 0, symbols: 0, edges: 0, paths: [], areas: [] };
    }

    // Two globs on purpose. The first asks for EVERYTHING (up to the backend's
    // hard cap) so the pass knows how big the tree really is and can pick a
    // representative spread; a cap-sized glob would silently bias the index
    // toward whatever alphabetical prefix came first. The second is the fair
    // share: keep `fileCap` files, spread across directories.
    let all = [];
    let truncated = false;
    try {
        const res = await invoke('glob_files', {
            pattern: STUDY_GLOB, path: workspacePath, maxResults: 5000,
        });
        all = Array.isArray(res?.files) ? res.files : (Array.isArray(res) ? res : []);
        truncated = !!(res && res.truncated);
    } catch (e) {
        return { files: 0, parsed: 0, symbols: 0, edges: 0, paths: [], areas: [], error: String(e?.message || e) };
    }
    const { selected: paths, omitted } = fairShare(all, fileCap);

    const index = new CodeIndexClient({ workspacePath, invoke });
    // Built once. `changedFiles` rebuilds this map per call, so asking it inside
    // the loop would be O(files x indexed) for no reason.
    const known = new Map(await index.knownHashes());

    // Read every file once: the hash needs the content anyway, and a second read
    // for the changed ones would double the I/O to save nothing.
    const seen = [];
    const areas = [];
    let read = 0, symbolCount = 0, edgeCount = 0;
    const batch = [];

    for (const path of paths) {
        let content = '';
        try { content = String(await invoke('read_file', { path }) || ''); }
        catch (_) { read++; continue; }

        const hash = contentHash(content);
        seen.push({ path, hash });
        read++;

        if (onProgress && (read % 20 === 0 || read === paths.length)) {
            onProgress({ read, total: paths.length, symbols: symbolCount });
        }
        // Unchanged since the last pass ⇒ nothing to re-parse.
        if (known.get(path) !== hash) {
            const found = extractSymbols(path, content).filter(isLandmark);
            found.sort((a, b) => (b.exported === true) - (a.exported === true));
            const symbols = found.slice(0, SYMBOLS_PER_FILE).map(s => ({
                name: s.name, kind: s.kind || '', line: s.line || 0, exported: !!s.exported,
            }));
            const deps = importEdges(path, content).map(dst => [dst, 'imports']);

            symbolCount += symbols.length;
            edgeCount += deps.length;
            batch.push({ path, hash, lang: langOf(path), symbols, deps });
            areas.push({ path, names: symbols.map(s => s.name) });
        }

        // Flush in chunks so a huge tree does not build one enormous IPC payload.
        if (batch.length >= 100) { await index.putFiles(batch.splice(0)); }
    }
    if (batch.length) await index.putFiles(batch);

    // Workbooks: same edge table, different extractor.
    const sheets = await indexSpreadsheets({ workspacePath, invoke, index, onProgress });
    edgeCount += sheets.edges;
    for (const p of sheets.paths) seen.push({ path: p, hash: '' });

    // Retire files the tree no longer has. A truncated glob means the list is
    // NOT the whole tree, so pruning against it would delete files that still
    // exist — the backend refuses that, and the pass reports it instead.
    const gone = await index.prune(seen.map(f => f.path), { truncated });

    return {
        files: read + sheets.files,
        parsed: areas.length,
        symbols: symbolCount,
        edges: edgeCount,
        sheets: sheets.files,
        pruned: gone,
        total: all.length,
        omitted,
        truncated,
        paths: seen.map(f => f.path),
        areas,
    };
}

/**
 * Index the formula graph of the workbooks in a workspace.
 *
 * Nodes are `workbook.xlsx#SheetName`, so a sheet is addressable the way a file
 * is and `code_deps` answers the same question over both. Entirely best-effort:
 * a workbook that will not open is skipped, never fatal — the source index is
 * the expensive part and must not be lost to a corrupt spreadsheet.
 */
export async function indexSpreadsheets({ workspacePath, invoke, index, onProgress = null }) {
    let books = [];
    try {
        const res = await invoke('glob_files', {
            pattern: STUDY_SHEET_GLOB, path: workspacePath, maxResults: SHEET_FILE_CAP,
        });
        books = (Array.isArray(res?.files) ? res.files : []).slice(0, SHEET_FILE_CAP);
    } catch (_) {
        return { files: 0, edges: 0, paths: [] };
    }

    const batch = [];
    let edges = 0;
    let done = 0;
    for (const path of books) {
        let refs = [];
        try { refs = await invoke('spreadsheet_refs', { path }) || []; }
        catch (_) { done++; continue; }
        done++;
        onProgress?.({ read: done, total: books.length, symbols: 0, phase: 'sheets' });
        if (!refs.length) continue;

        // One index entry per SHEET, carrying its outgoing references.
        const bySheet = new Map();
        for (const r of refs) {
            const from = `${path}#${r.from_sheet}`;
            const list = bySheet.get(from) || [];
            list.push([`${path}#${r.to_sheet}`, 'references']);
            bySheet.set(from, list);
        }
        for (const [node, deps] of bySheet) {
            edges += deps.length;
            batch.push({ path: node, hash: '', lang: 'excel', symbols: [], deps });
        }
    }
    if (batch.length) await index.putFiles(batch);
    return { files: done, edges, paths: batch.map(b => b.path) };
}
