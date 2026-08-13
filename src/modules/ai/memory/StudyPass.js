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
export const STUDY_FILE_CAP = 400;
/** Symbols kept per file. A 2000-line module does not need 300 entries here. */
export const SYMBOLS_PER_FILE = 12;
/** Source types SymbolIndex can actually parse. */
export const STUDY_GLOB = '**/*.{js,jsx,mjs,cjs,ts,tsx,rs,py,java}';

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
 * I/O only — every decision it makes lives in the pure functions above. Reports
 * progress so a long pass is not a frozen dialog, and stops at STUDY_FILE_CAP so
 * pointing it at a monorepo cannot hang the app.
 *
 * @param {{workspacePath:string, invoke:Function, onProgress?:Function,
 *          fileCap?:number, commit?:string}} opts
 */
export async function runStudyPass({
    workspacePath, invoke, onProgress = null, fileCap = STUDY_FILE_CAP, commit = '',
} = {}) {
    if (!workspacePath || typeof invoke !== 'function') {
        return { cards: [], files: 0, symbols: 0, paths: [] };
    }
    const date = new Date().toISOString().split('T')[0];

    let paths = [];
    try {
        const res = await invoke('glob_files', {
            pattern: STUDY_GLOB, path: workspacePath, maxResults: fileCap,
        });
        paths = Array.isArray(res?.files) ? res.files : (Array.isArray(res) ? res : []);
    } catch (e) {
        return { cards: [], files: 0, symbols: 0, paths: [], error: String(e?.message || e) };
    }
    paths = paths.slice(0, fileCap);

    const symbols = [];
    let read = 0;
    for (const path of paths) {
        try {
            const content = await invoke('read_file', { path });
            const found = extractSymbols(path, String(content || ''));
            // Exported names first: they are what another task will search for.
            found.sort((a, b) => (b.exported === true) - (a.exported === true));
            symbols.push(...found.slice(0, SYMBOLS_PER_FILE));
        } catch (_) {
            // An unreadable file is not a failure of the pass.
        }
        read++;
        if (onProgress && (read % 20 === 0 || read === paths.length)) {
            onProgress({ read, total: paths.length, symbols: symbols.length });
        }
    }

    return { cards: symbolCards(symbols, { date, commit }), files: read, symbols: symbols.length, paths };
}
