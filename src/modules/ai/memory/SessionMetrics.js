// SessionMetrics — PURE measurement of one run, and the A/B comparison built on it.
//
// Step 3.5 of docs/design/agent-memory-learning.plan.md, added after the
// original Step 1 gate turned out to be untestable in practice: modern models
// fail rarely, so "did the failure recurrence rate fall?" yields roughly 0.2
// data points per session, and detecting a 0.3 → 0.1 drop needs ~60 per arm.
// Months of waiting to answer one question.
//
// The fix is not to abandon measurement but to measure things that happen EVERY
// session:
//
//   explorationCost  tool calls before the first file edit   1 per session
//   followThrough    did the agent do what a shown card said  ~3 per session
//   reReads          the same file read twice                 several per session
//   iterations       steps taken                              1 per session
//
// Recurrence rate is kept as a signal (see CardStore.recurrenceRate) but is no
// longer the gate: when it fires it matters, it is just too rare to test on.
//
// Nothing here does I/O except `appendSessionMetrics`, which takes `invoke`.

/**
 * Tools that CHANGE a file. `run_command` is deliberately excluded: a test run
 * is not the moment exploration ended, and counting it as one would make
 * "explored, then ran the tests, then explored more" look like a short run.
 */
const EDIT_TOOLS = new Set([
    'write_file', 'multi_replace_file_content', 'replace_lines',
    'delete_file', 'move_file', 'write_xlsx', 'update_xlsx', 'write_docx',
]);

const READ_TOOLS = new Set(['read_file', 'read_office']);

/**
 * How much looking around happened before the first change: the number of tool
 * calls preceding the first edit. This is the number `locator` insights ("X is
 * in Y") are supposed to move — and unlike a failure, every task produces one.
 * @returns {number|null} null when the run never edited anything (nothing to time)
 */
export function explorationCost(events) {
    if (!Array.isArray(events)) return null;
    let count = 0;
    for (const e of events) {
        if (EDIT_TOOLS.has(e.tool)) return count;
        count++;
    }
    return null;
}

/** Reads of a file that had already been read in this run. Pure waste. */
export function reReads(events) {
    if (!Array.isArray(events)) return 0;
    const seen = new Set();
    let n = 0;
    for (const e of events) {
        if (!READ_TOOLS.has(e.tool) || !e.target) continue;
        if (seen.has(e.target)) n++;
        else seen.add(e.target);
    }
    return n;
}

/** "read_file → write_file" → ['read_file','write_file'] */
export function parseRecipe(text) {
    return String(text || '')
        .split(/→|->/)
        .map(s => s.trim())
        .filter(s => /^[a-z_][a-z0-9_]*$/i.test(s));
}

/**
 * Did the recommended tool order actually appear after the card was shown?
 * Matched as a SUBSEQUENCE, not a contiguous run: the agent may legitimately do
 * other things in between and still have followed the advice.
 */
export function followsRecipe(events, recipe, fromIteration = 0) {
    if (!Array.isArray(events) || !Array.isArray(recipe) || recipe.length === 0) return false;
    let i = 0;
    for (const e of events) {
        if ((e.i || 0) < fromIteration) continue;
        if (e.tool === recipe[i]) i++;
        if (i === recipe.length) return true;
    }
    return false;
}

/**
 * Of the cards put in front of the agent, how many did it actually act on?
 *
 * This is the metric that replaces recurrence rate as the primary signal: ~3
 * observations per session instead of ~0.2, and it fails loudly in the case
 * that matters — advice being injected and ignored.
 *
 * @param {Array} events    trace events
 * @param {Array} shownLog  [{ id, at, recipe }] — recipe as stored on the card
 */
export function followThrough(events, shownLog) {
    const rows = (Array.isArray(shownLog) ? shownLog : [])
        .map(s => ({ ...s, steps: parseRecipe(s.recipe) }))
        // A card with no tool sequence (a locator, a lesson with no verified fix)
        // makes no checkable claim, so counting it either way would be noise.
        .filter(s => s.steps.length > 0);
    const followed = rows.filter(s => followsRecipe(events, s.steps, s.at || 0)).length;
    return {
        checked: rows.length,
        followed,
        rate: rows.length ? followed / rows.length : null,
    };
}

/**
 * One row per run — the unit the A/B comparison averages over.
 * @param {{events?:Array, shownLog?:Array, iterations?:number, recall?:string,
 *          memoryChars?:number, sessionId?:string, date?:string,
 *          failures?:Array}} input
 */
export function sessionMetrics({
    events = [], shownLog = [], iterations = 0, recall = 'on',
    memoryChars = 0, sessionId = '', date = '', failures = [],
} = {}) {
    const ft = followThrough(events, shownLog);
    return {
        sessionId,
        date: date || new Date().toISOString().split('T')[0],
        // The arm this run belongs to. Without it the rows cannot be compared.
        recall,
        iterations,
        toolCalls: events.length,
        failures: failures.length,
        unresolvedFailures: failures.filter(f => f.unresolved).length,
        explorationCost: explorationCost(events),
        reReads: reReads(events),
        // Chars, not tokens: this is a RATIO between two arms, and chars need no
        // estimator (which would vary by model and add a dependency to a pure module).
        memoryChars,
        cardsShown: shownLog.length,
        followChecked: ft.checked,
        followed: ft.followed,
    };
}

const mean = (rows, key) => {
    const vals = rows.map(r => r[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

/**
 * Compare the recall-on and recall-off arms.
 *
 * `delta` is on − off for each mean, so a NEGATIVE delta on iterations /
 * explorationCost / reReads is the improvement. Returns `null` deltas until both
 * arms have rows: an A/B with one arm is not a result, and reporting it as one
 * is how a memory layer gets declared a success without evidence.
 */
export function compareArms(rows) {
    const all = Array.isArray(rows) ? rows : [];
    const on = all.filter(r => r.recall !== 'off');
    const off = all.filter(r => r.recall === 'off');
    const KEYS = ['iterations', 'toolCalls', 'explorationCost', 'reReads', 'failures'];

    const summary = (arm) => {
        const out = { runs: arm.length };
        for (const k of KEYS) out[k] = mean(arm, k);
        return out;
    };

    const onS = summary(on);
    const offS = summary(off);
    const delta = {};
    for (const k of KEYS) {
        delta[k] = (on.length && off.length && onS[k] !== null && offS[k] !== null)
            ? onS[k] - offS[k]
            : null;
    }

    const checked = on.reduce((s, r) => s + (r.followChecked || 0), 0);
    const followed = on.reduce((s, r) => s + (r.followed || 0), 0);

    return {
        on: onS,
        off: offS,
        delta,
        followThroughRate: checked ? followed / checked : null,
        /** Both arms need rows before any delta means anything. */
        comparable: on.length > 0 && off.length > 0,
    };
}

/**
 * Append one row to `<workspace>/.agent/trace/metrics.jsonl`.
 *
 * Read-then-append rather than overwrite, because tasks run concurrently. A
 * lost row here costs one data point, not a session's learning, so this stays
 * simpler than CardStore's reconcile.
 */
export async function appendSessionMetrics({ workspacePath, invoke, row }) {
    if (!workspacePath || typeof invoke !== 'function' || !row) return false;
    const path = `${workspacePath}/.agent/trace/metrics.jsonl`;
    try {
        let existing = '';
        try { existing = (await invoke('read_file', { path })) || ''; } catch (_) { /* first row */ }
        try { await invoke('create_dir', { path: `${workspacePath}/.agent/trace` }); } catch (_) { /* exists */ }
        await invoke('write_file', { path, content: `${existing.trimEnd()}\n${JSON.stringify(row)}\n`.trimStart() });
        return true;
    } catch (e) {
        console.warn('SessionMetrics: could not append metrics:', e);
        return false;
    }
}

/** Parse a metrics.jsonl body into rows, skipping corrupt lines. */
export function parseMetrics(text) {
    return String(text || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
}
