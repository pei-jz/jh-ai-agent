// RecoveryHints — PURE mapping from tool-execution errors to the next move.
//
// This is the one place that turns "the tool failed" into "here is what to do
// instead", so its precision is the agent's ability to get unstuck. It was an
// if-chain of three substring tests with a catch-all that fired for everything
// else — and the catch-all said "run verification after edits, bundle your
// tests", which is advice about editing style, not about the error. A timeout,
// a blocked path, a truncated call and a disabled tool all got it. Wrong advice
// is worse than none: the model acts on it and spends a step going nowhere.
//
// Two changes:
//   • a TABLE, so adding a hint is adding a row, not editing control flow;
//   • no catch-all. An error with no specific advice gets NOTHING, and the
//     model reads the (deliberately explanatory) tool error itself.
//
// The rules are ordered: the first match wins, so the specific ones come first.
// Matching is on the error text because that is what tools produce today; where
// a tool already emits a marker (ARGS_TRUNCATED and friends) the rule keys off
// that instead, which is exact. See docs/design/tool-failure-policy.md §4 for
// what a good tool error says on its own — a hint is a supplement to that, and
// the rules here deliberately stay short because of it.

/**
 * @typedef {object} RecoveryRule
 * @property {string} id     stable name, used to de-duplicate within a turn
 * @property {RegExp} match  tested against the LOWERCASED error text
 * @property {string} hint   what to do instead — one line, imperative
 */

/** @type {RecoveryRule[]} */
export const RECOVERY_RULES = [
    // ── the user said no ─────────────────────────────────────────────────
    // First, and phrased as a hard stop: a denial re-attempted is the failure
    // mode that most annoys a person, because it reads as not listening.
    {
        id: 'denied',
        match: /user denied|denied by user|was not approved|user rejected|blocked by user permission/,
        hint: 'The user declined this. Do NOT retry the same operation. Take a different '
            + 'approach, or use ask_user to ask what they want instead.',
    },
    {
        id: 'refused-replace',
        match: /already refused permission to replace|already exists/,
        hint: 'That file is protected from being replaced. Change it in place with '
            + 'update_xlsx / edit_file / apply_patch, or ask_user whether to overwrite. '
            + 'Deleting it and writing a new one is the same loss by another route.',
    },

    // ── the call itself did not arrive whole ─────────────────────────────
    // The one that cost six steps of guessing: the arguments were cut off at
    // the output limit, and the error looked like a missing parameter.
    {
        id: 'truncated-args',
        match: /truncated|cut off at the output limit|arguments did not arrive whole/,
        hint: 'The arguments were cut off by the output limit — NOTHING ran. Sending the '
            + 'same content through a different tool hits the same limit at the same '
            + 'place. Split the work into several smaller calls.',
    },
    {
        id: 'unparseable-args',
        match: /could not be parsed|invalid arguments for|json parse failure/,
        hint: 'The arguments were not valid JSON, so nothing ran. Re-emit the call with '
            + 'the exact argument names from the tool schema.',
    },

    // ── the tool is not available here ───────────────────────────────────
    {
        id: 'tool-unavailable',
        match: /is not enabled for this task|not found\. available|is not available in this context|provided by a connected external app/,
        hint: 'That tool is not available in this task. Use one of the listed tools; do not '
            + 'retry this one.',
    },

    // ── it ran, and stopped ──────────────────────────────────────────────
    {
        id: 'timed-out',
        match: /timed out after|did not return after|was killed|was abandoned/,
        hint: 'It exceeded its time budget and was abandoned — the work MAY still be running, '
            + 'so do not assume it did nothing. Narrow the request (fewer files, fewer '
            + 'sheets, a more specific query) before trying again.',
    },
    {
        id: 'aborted',
        match: /aborted|cancelled|canceled/,
        hint: 'The run was interrupted. Stop and report where things stand rather than '
            + 'starting new work.',
    },

    // ── paths ────────────────────────────────────────────────────────────
    {
        id: 'path-blocked',
        match: /path guard|write blocked|outside the workspace|outside all allowed roots|crosses the workspace boundary/,
        hint: 'That path is outside the writable area. Work inside the workspace, or use '
            + 'ask_user to have the location approved. Retrying the same path will fail '
            + 'the same way.',
    },
    {
        id: 'not-found',
        match: /not found|no such file|does not exist|cannot find/,
        hint: 'That path does not exist. Locate it with glob or list_files before using it — '
            + 'do not guess a second path.',
    },

    // ── edits that no longer fit the file ────────────────────────────────
    {
        id: 'stale-anchor',
        match: /invalid line range|does not match|anchor mismatch|stale|exceeds file length|produced no change/,
        hint: 'The text you targeted is not what the file currently contains. read_file the '
            + 'relevant part first, then retry with the exact current text.',
    },

    // ── things that are simply missing from the call ─────────────────────
    {
        id: 'missing-param',
        match: /requires? (a |an )?["']?\w+|missing required|needs a workspace/,
        hint: 'A required argument was missing or empty. Read the message for which one, and '
            + 're-issue the call with it.',
    },

    // ── the work happened but the result is not acceptable ───────────────
    {
        id: 'syntax',
        match: /syntax error|finish_task blocked/,
        hint: 'The file you wrote does not parse. Fix it now — the run cannot finish while it '
            + 'is broken.',
    },
    {
        id: 'network',
        match: /error fetching url|network|econnrefused|etimedout|dns/,
        hint: 'The network call failed. Try once more if it looks transient; otherwise carry '
            + 'on without it and say in your answer that it could not be reached.',
    },
];

/**
 * The rule that applies to one (already lowercased) error message.
 * @param {string} errMsgLower
 * @returns {RecoveryRule|null} null when nothing specific applies
 */
export function ruleForError(errMsgLower) {
    const m = String(errMsgLower || '');
    return RECOVERY_RULES.find(r => r.match.test(m)) || null;
}

/**
 * Hint for a single (already lowercased) error message.
 *
 * Returns '' when no rule matches, on purpose. The previous catch-all meant
 * every unrecognised error came back with advice about bundling test runs;
 * saying nothing leaves the tool's own error — which is written to explain
 * itself — as the thing the model reads.
 *
 * @param {string} errMsgLower
 * @returns {string} a hint line (leading "\n"), or ''
 */
export function hintForError(errMsgLower) {
    const rule = ruleForError(errMsgLower);
    return rule ? `\n[Self-Correction Hint] ${rule.hint}` : '';
}

/**
 * Build the combined recovery hint for a set of tool results.
 *
 * De-duplicated by rule. Three files that were not found used to append the
 * same paragraph three times — context spent to say one thing — and a model
 * reading the same instruction repeatedly weights it more heavily than the run
 * deserves. One line per distinct problem, with a count when it happened more
 * than once, says strictly more in less space.
 *
 * @param {Array<{result?: any}>} results
 * @returns {string} concatenated hints ('' when no errors)
 */
export function buildRecoveryHint(results) {
    if (!Array.isArray(results)) return '';
    /** @type {Map<string, {rule: RecoveryRule, count: number}>} */
    const hit = new Map();
    for (const r of results) {
        if (typeof r?.result !== 'string' || !r.result.startsWith('Error')) continue;
        const rule = ruleForError(r.result.toLowerCase());
        if (!rule) continue;
        const seen = hit.get(rule.id);
        if (seen) seen.count++;
        else hit.set(rule.id, { rule, count: 1 });
    }
    let out = '';
    for (const { rule, count } of hit.values()) {
        out += `\n[Self-Correction Hint]${count > 1 ? ` (×${count})` : ''} ${rule.hint}`;
    }
    return out;
}
