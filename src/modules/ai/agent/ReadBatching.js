// ReadBatching — notice when a run is reading files one at a time.
//
// `read_file` takes `paths` for several files in one call, and the schema says
// so in the strongest terms it has ("the single biggest saving available during
// investigation"). Measured over 93 real runs, the agent used it 58 times
// against 930 single reads — 6%. Grouping the single reads into consecutive
// runs, 485 of them (52%) sat inside a burst that one batched call could have
// replaced; the longest burst was 17 calls.
//
// That waste lands directly on `explorationCost` and `toolCalls`, which are the
// two primary metrics of the recall A/B — so this is not a cosmetic saving.
//
// ── Why this is not "memory", and why that matters ────────────────────────
//
// The card layer recalls what an EARLIER run learned. This reports what the
// CURRENT run just did: "you read these four files one at a time." No retrieval,
// no scoring, no decay — and nothing to be wrong about, since the evidence is
// the last few tool calls rather than a stored claim about the past.
//
// It is still injected text, which is why it ships behind a flag: the v2
// injection experiment is in flight, and a fourth injection would make its
// result unattributable (docs/design/agent-memory-learning.plan.md §4.4.3).
//
// PURE — no I/O.

/** Consecutive single reads before saying anything. */
export const BURST_THRESHOLD = 3;
/** Files named in the note. Beyond this the list stops being readable. */
export const NAMED_LIMIT = 5;

/**
 * The path a `read_file` call names, or null when it batched (or is not a read).
 *
 * A call carrying `paths` is the behaviour being encouraged, so it does not just
 * fail to extend the burst — it ENDS it. Otherwise a run that alternated between
 * batching and not would keep accumulating toward a nudge it had already earned
 * the right not to get.
 *
 * @returns {{single: string} | {batched: true} | null}
 */
export function readShape(call) {
    if (!call || call.name !== 'read_file') return null;
    const paths = call.args?.paths;
    if (Array.isArray(paths) && paths.filter(p => typeof p === 'string' && p.trim()).length > 1) {
        return { batched: true };
    }
    const one = call.args?.path;
    if (typeof one === 'string' && one.trim()) return { single: one.trim() };
    // A `paths` array holding exactly one entry is a single read wearing the
    // batch parameter — counted as what it is.
    if (Array.isArray(paths) && paths.length === 1 && typeof paths[0] === 'string' && paths[0].trim()) {
        return { single: paths[0].trim() };
    }
    return null;
}

/**
 * Fold one tool call into the burst state.
 *
 * Any call that is not a single read ends the burst: reading three files with a
 * grep and an edit in between is not the pattern this is looking for, and
 * treating it as one would nudge a run that was investigating normally.
 *
 * @param {string[]} burst  paths read singly and consecutively so far
 * @param {object} call
 * @returns {string[]} the new burst
 */
export function foldRead(burst, call) {
    const prev = Array.isArray(burst) ? burst : [];
    const shape = readShape(call);
    if (!shape || shape.batched) return [];
    return [...prev, shape.single];
}

/**
 * The note to append, or '' when there is nothing worth saying.
 *
 * Fires ONCE per run, at the moment the threshold is crossed. Repeating it on
 * every subsequent read would make it wallpaper — and the run has already been
 * told; a second telling carries no information the first did not.
 *
 * @param {string[]} burst  consecutive single reads, most recent last
 * @param {{threshold?: number, alreadySaid?: boolean}} opts
 */
export function batchHint(burst, { threshold = BURST_THRESHOLD, alreadySaid = false } = {}) {
    const list = Array.isArray(burst) ? burst.filter(Boolean) : [];
    if (alreadySaid || list.length !== threshold) return '';
    const shown = list.slice(-NAMED_LIMIT);
    const names = shown.map(p => p.split(/[\\/]/).pop()).join(', ');
    return `[Efficiency] Those last ${list.length} reads (${names}) were one call each. `
        + 'read_file takes `paths` for several files at once.\n'
        + '  DO: when you already know the next files you need, name them all in one read_file call.';
}
