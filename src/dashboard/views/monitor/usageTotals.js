// usageTotals — pure token-usage aggregation for the Monitor (P4 split from
// MonitorView.js). The run's token totals come from one of three sources, in
// order of authority:
//   1. the LIVE accumulator — the only one that is current during a run;
//   2. the task record — authoritative for a finished task, and unaffected by
//      log paging (which can drop the early `token_usage` events entirely);
//   3. summing the logs — the last resort.
// Extracted so the fallback chain is unit-testable without a view.

const ZERO = {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
};

function isEmpty(usage) {
    return !usage || (usage.total_tokens || 0) <= 0;
}

/** Sum one token_usage log event into an accumulator. */
export function accumulateUsage(acc, d) {
    const a = acc || { ...ZERO };
    const cr = d.cache_read_input_tokens || 0;
    const cc = d.cache_creation_input_tokens || 0;
    a.prompt_tokens += d.prompt_tokens || 0;
    a.completion_tokens += d.completion_tokens || 0;
    a.cache_read_input_tokens += cr;
    a.cache_creation_input_tokens += cc;
    a.total_tokens += d.total_tokens
        || ((d.prompt_tokens || 0) + (d.completion_tokens || 0) + cr + cc);
    return a;
}

/** Sum every token_usage event in a log array. */
export function sumLogUsage(logs) {
    let acc = { ...ZERO };
    for (const l of (Array.isArray(logs) ? logs : [])) {
        if (l.event !== 'token_usage') continue;
        acc = accumulateUsage(acc, l.data || {});
    }
    return acc;
}

/**
 * Resolve the authoritative totals for a task.
 *
 * @param {object} opts
 * @param {object} opts.live        the view's live accumulator
 * @param {object|null} opts.stored  the task record's token_usage
 * @param {Array} opts.logs         the task's log events
 * @returns {object} the winning totals object
 */
export function usageTotals({ live = {}, stored = null, logs = [] }) {
    if (!isEmpty(live)) return live;
    if (stored && (stored.total_tokens > 0 || stored.prompt_tokens > 0)) return stored;
    return sumLogUsage(logs);
}
