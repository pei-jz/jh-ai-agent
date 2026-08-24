// Playbook — the shape a KIND of task takes here, extracted from runs that worked.
//
// Step 6 of docs/design/agent-memory-learning.plan.md. A lesson says "this went
// wrong"; an insight says "this worked once". A playbook says "tasks like this
// go like this here" — the backbone that survives across several successful runs
// of the same kind of work.
//
// ── The trap this module is built around ──────────────────────────────────
//
// The obvious implementation is: take every successful run, LCS their tool
// sequences, store the result. That produces `read_file → write_file`. Which is
// true, and worthless, because it is what the agent does anyway.
//
// We know it is worthless because we measured it. Over 89 runs, cards whose
// advice was a tool ordering were followed 53.8% of the time — against a 50.0%
// rate in control runs where the card was never shown. The advice was describing
// the base rate back to the agent.
//
// So a skeleton earns its place only by being MORE SPECIFIC than the global one:
// it is kept when it says something about `.rs` files that is not already true
// of every file. Everything else is dropped, however many runs support it.
//
// Pure module: no I/O, no LLM. The plan's "LCS skeleton → LLM flesh-out" keeps
// the first half only. Prose generated over a skeleton is exactly the kind of
// plausible invention the rest of this subsystem is arranged to keep out, and
// nothing measured so far suggests the agent needs the skeleton explained.

import { extOf } from './FailureSignature.js';

/** A backbone shorter than this is a coincidence, not a procedure. */
export const MIN_SKELETON = 3;
/** Longer than this is a transcript of a few similar runs, not a procedure. */
export const MAX_SKELETON = 6;
/** Runs of one kind needed before their common shape means anything. */
export const MIN_RUNS = 3;

/**
 * Bookkeeping calls that end or narrate a run rather than doing its work.
 *
 * Every run finishes with `finish_task`, so leaving it in put it in every
 * skeleton — a step that is 100% supported and 0% informative, which is the same
 * base-rate failure this module is built to avoid, just in miniature.
 */
const CEREMONY = /^(finish_task|present_result|ask_user|update_todo|attempt_completion)$/;

/**
 * Reduce a raw LCS to the distinct steps in first-appearance order.
 *
 * On the real trace history the .js skeleton came out as `read_file →
 * grep_search` repeated five times and then the actual work. That is what four
 * similar runs happen to share, not a procedure anyone would follow: the
 * repetition is how much searching those runs needed, which is exactly the part
 * that will not generalise. The phases in order are the part that does.
 */
export function phases(steps) {
    const seen = new Set();
    const out = [];
    for (const s of (Array.isArray(steps) ? steps : [])) {
        if (CEREMONY.test(s) || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/**
 * Tool names in order, with consecutive repeats collapsed.
 *
 * Three `read_file`s in a row are one "reading" step in a procedure; kept
 * separate they let a run that happened to read a lot dominate the LCS with
 * repetitions of a single tool.
 */
export function sequenceOf(events) {
    const out = [];
    for (const e of (Array.isArray(events) ? events : [])) {
        if (!e || e.ok === false || !e.tool) continue;
        if (out[out.length - 1] !== e.tool) out.push(e.tool);
    }
    return out;
}

/** Longest common subsequence of two tool-name arrays. */
export function lcs(a, b) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (!A.length || !B.length) return [];
    // Standard DP table. Sequences here are tens of entries, not thousands.
    const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
    for (let i = 1; i <= A.length; i++) {
        for (let j = 1; j <= B.length; j++) {
            dp[i][j] = A[i - 1] === B[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const out = [];
    let i = A.length; let j = B.length;
    while (i > 0 && j > 0) {
        if (A[i - 1] === B[j - 1]) { out.push(A[i - 1]); i--; j--; }
        else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
        else j--;
    }
    return out.reverse();
}

/**
 * The backbone common to every sequence given.
 *
 * Folded pairwise, which is not guaranteed to find the true multi-sequence LCS
 * — that problem is NP-hard — but is stable and cheap, and errs toward SHORTER
 * skeletons. Erring short is the right direction: a procedure this module is
 * unsure about should say less, not more.
 */
export function commonSkeleton(sequences) {
    const seqs = (Array.isArray(sequences) ? sequences : []).filter(s => Array.isArray(s) && s.length);
    if (!seqs.length) return [];
    return seqs.reduce((acc, s) => lcs(acc, s));
}

/** The extension a run was working on: the first file it successfully edited. */
const EDITED = /^(write_file|multi_replace_file_content|replace_lines|write_xlsx|update_xlsx|write_docx)$/;
export function subjectExt(events) {
    for (const e of (Array.isArray(events) ? events : [])) {
        if (e?.ok !== false && EDITED.test(e?.tool || '') && e?.target) return extOf(e.target) || '';
    }
    return '';
}

/**
 * Extract playbooks from successful sessions, one per file kind.
 *
 * @param {Array<{events:Array}>} sessions  successful runs only — a playbook
 *   built from runs that failed is a recipe for failing the same way.
 * @returns {Array<{ext, steps, runs, id, type, kind}>}
 */
export function mintPlaybooks(sessions, { minRuns = MIN_RUNS, minLen = MIN_SKELETON } = {}) {
    const list = (Array.isArray(sessions) ? sessions : []).filter(s => s && Array.isArray(s.events));
    if (list.length < minRuns) return [];

    // The global backbone — what every task here looks like regardless of kind.
    // This is the base rate, and it is subtracted rather than reported.
    const global = phases(commonSkeleton(list.map(s => sequenceOf(s.events))));

    const byExt = new Map();
    for (const s of list) {
        const ext = subjectExt(s.events);
        if (!ext) continue;
        if (!byExt.has(ext)) byExt.set(ext, []);
        byExt.get(ext).push(sequenceOf(s.events));
    }

    const out = [];
    for (const [ext, seqs] of byExt) {
        if (seqs.length < minRuns) continue;
        const steps = phases(commonSkeleton(seqs));
        if (steps.length < minLen || steps.length > MAX_SKELETON) continue;
        // The test that keeps this from restating the base rate: a skeleton that
        // is no longer than the one shared by EVERY task says nothing about this
        // file kind, and telling the agent it says nothing costs a slot.
        if (steps.length <= global.length) continue;
        out.push({
            id: `P-${ext.replace(/^\./, '') || 'none'}`,
            type: 'playbook',
            ext,
            steps,
            runs: seqs.length,
        });
    }
    return out.sort((a, b) => b.runs - a.runs || b.steps.length - a.steps.length);
}

/** Trace files read when extracting. Older runs describe a project that moved on. */
export const TRACE_WINDOW = 40;

/**
 * Read the recent session traces and extract playbooks from them.
 *
 * Reads at teardown, not per step: it touches up to TRACE_WINDOW files, which is
 * fine once at the end of a run and would not be fine inside the loop.
 *
 * @param {{workspacePath:string, invoke:Function}} io
 */
export async function extractFromTraces({ workspacePath, invoke, window = TRACE_WINDOW } = {}) {
    if (!workspacePath || typeof invoke !== 'function') return [];
    const dir = `${workspacePath}/.agent/trace`;
    let names = [];
    try {
        const entries = await invoke('read_dir', { path: dir });
        names = (Array.isArray(entries) ? entries : [])
            .map(e => e?.name || '')
            .filter(n => n.startsWith('sess_') && n.endsWith('.jsonl'))
            .sort()
            .slice(-window);
    } catch (_) {
        return [];   // no traces yet
    }

    const sessions = [];
    for (const name of names) {
        try {
            const text = await invoke('read_file', { path: `${dir}/${name}` });
            const events = String(text || '').split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean);
            // A run that ended in an unresolved failure is not a model to copy.
            // Trace events carry `ok`, not `isError` — see TraceRecorder.toEvent.
            if (events.length && events[events.length - 1]?.ok !== false) sessions.push({ events });
        } catch (_) { /* skip an unreadable trace rather than losing the batch */ }
    }
    return mintPlaybooks(sessions);
}

/** The playbook covering the file kind a task is about, if there is one. */
export function playbookFor(playbooks, ext) {
    if (!ext) return null;
    return (Array.isArray(playbooks) ? playbooks : []).find(p => p.ext === ext) || null;
}

/**
 * The injected line. Same DO: shape as a card, for the same reason — measured
 * over 89 runs, advice embedded in prose was followed no more often than it
 * would have been with nothing shown at all.
 */
export function renderPlaybook(pb) {
    if (!pb || !Array.isArray(pb.steps) || !pb.steps.length) return '';
    return `[Playbook — how ${pb.ext} work has gone here, across ${pb.runs} successful runs]\n`
        + `  DO: ${pb.steps.join(' → ')}`;
}
