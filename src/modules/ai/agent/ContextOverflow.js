// ContextOverflow — keeping one oversized message from sinking a run.
//
// The failure this exists for (task 1a1fcea7, 2026-09-13): step 1 was a
// 16k-token request. Its grep_search matched inside public/lib/mermaid.min.js,
// where one "line" is megabytes long, and returned 3.75M characters. Every
// defence after that failed in turn:
//
//   • nothing capped a tool result, so the whole thing went into history;
//   • the pre-send trim keeps "the goal + the last 3 messages" — and the giant
//     result WAS one of the last three, so trimming removed nothing;
//   • the provider's 400 ("maximum context length is 1048576 tokens, you
//     requested 1460042") was read as "native tool calling failed", so the run
//     switched to JSON mode, dropped its tools, and sent the same oversized
//     history again;
//   • recovery pushed "try a different approach" onto a history that was still
//     too big, which fails identically every time.
//
// These helpers are the shared pieces: clip a single text, recognise a context
// overflow, and shrink a history until it fits.

/** A single tool result larger than this is clipped before it enters history. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

/** Nothing is clipped below this — a short result is never worth mangling. */
const MIN_CLIPPABLE_CHARS = 2_000;

/**
 * Keep the head and tail of `text`, dropping the middle, with a marker that
 * says how much went and why.
 *
 * Head AND tail rather than head only: a tool's summary line is often at the
 * end ("[Result truncated…]", an exit code), and a clip that removes it removes
 * the one sentence telling the model what happened.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clipText(text, max = MAX_TOOL_RESULT_CHARS) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.6);
    const tail = Math.max(0, max - head);
    const omitted = s.length - head - tail;
    return s.slice(0, head)
        + `\n\n…[${omitted.toLocaleString()} characters omitted — too large for the context window. `
        + `Narrow the request (a more specific pattern, include_glob, a path, offset/limit) to see this part.]…\n\n`
        + (tail > 0 ? s.slice(s.length - tail) : '');
}

/**
 * Is this error the provider refusing a request for being too long?
 *
 * Deliberately a message test: the providers agree on no error code, but they
 * all say it in words.
 */
export function isContextLengthError(err) {
    const msg = String(err?.message || err || '');
    return /maximum context length|context[_ ]length[_ ]exceeded|exceeds? the context window|context window (?:is|was) exceeded|too many tokens|reduce the length of the (?:messages|prompt)|prompt is too long|input is too long/i
        .test(msg);
}

/**
 * Shrink a history until `estimate(history) <= budgetTokens`, by halving the
 * largest string contents one at a time.
 *
 * Largest-first because the overflow is almost always ONE message (a search
 * result, a file, a page), and clipping everything evenly would damage the
 * small messages — the goal, the model's own reasoning — to spare the one that
 * caused it. Returns a new array; messages that were not clipped are the same
 * objects.
 *
 * @param {Array<{role:string, content:any}>} history
 * @param {number} budgetTokens
 * @param {(history: Array) => number} estimate
 * @returns {Array}
 */
export function fitHistoryToBudget(history, budgetTokens, estimate) {
    const out = Array.isArray(history) ? [...history] : [];
    let guard = 64;   // halving converges fast; this only stops a broken estimator
    while (guard-- > 0 && estimate(out) > budgetTokens) {
        let idx = -1;
        let len = MIN_CLIPPABLE_CHARS;
        for (let i = 0; i < out.length; i++) {
            const c = out[i]?.content;
            if (typeof c === 'string' && c.length > len) { idx = i; len = c.length; }
        }
        if (idx === -1) break;   // nothing left that is worth clipping
        out[idx] = { ...out[idx], content: clipText(out[idx].content, Math.max(MIN_CLIPPABLE_CHARS, Math.floor(len / 2))) };
    }
    return out;
}
