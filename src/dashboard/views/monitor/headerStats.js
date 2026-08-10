// headerStats — the arithmetic behind the task detail header.
//
// Same split as monitor/inspector.js: the numbers are computed here as pure
// functions and rendered by svelte/monitor/TaskHeader.svelte. These three were
// previously inlined in MonitorView between `getElementById` calls, so the only
// way to check the 85%-danger threshold or the minute rollover was to run the app
// and squint at it.

/** Thousands, at the precision the magnitude deserves. 128000 → "128K". */
export function fmtK(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}K` : String(v);
}

/**
 * How full the model's context window is.
 *
 * The gauge is fed by each `token_usage` event. `context_used`/`context_limit`
 * are used when the event carries them (newer AgentController); otherwise the
 * input-side counts are summed, because a cache read still occupies the window
 * even though it is billed at a tenth of the price.
 *
 * @param {object} d a token_usage payload
 * @param {number} [limitFallback] the active connection's effective window
 * @returns {{used:number, limit:number}|null} null for a tool-only step with no
 *          LLM call — the caller must KEEP the previous reading rather than
 *          drawing a zero, which would read as "the context emptied".
 */
export function contextReading(d = {}, limitFallback = 0) {
    const used = (typeof d.context_used === 'number' && d.context_used > 0)
        ? d.context_used
        : (d.prompt_tokens || 0) + (d.cache_read_input_tokens || 0) + (d.cache_creation_input_tokens || 0);
    if (!used) return null;
    return { used, limit: d.context_limit || limitFallback || 0 };
}

/**
 * The gauge's display form.
 *
 * @param {{used:number, limit:number}|null} reading
 * @returns {{label:string, pct:number, danger:boolean}} pct is 0 when the window
 *          size is unknown — a bar cannot honestly show a fraction of "?".
 */
export function contextGauge(reading) {
    if (!reading || !reading.used) return { label: '—', pct: 0, danger: false };
    const { used, limit } = reading;
    if (!(limit > 0)) return { label: `${fmtK(used)} / ?`, pct: 0, danger: false };
    const pct = Math.min(100, Math.round((used / limit) * 100));
    // Red once the window is nearly full: history trimming is imminent, and that
    // is the moment a reader can still do something about it.
    return { label: `${fmtK(used)} / ${fmtK(limit)} (${pct}%)`, pct, danger: pct >= 85 };
}

/**
 * How long the run has taken.
 *
 * A running task measures to NOW; a finished one measures to its completion
 * stamp, falling back to now only when the stamp is missing — measuring a
 * finished task against the clock made its elapsed time keep growing.
 *
 * @returns {string} '—' when there is no usable start time
 */
export function elapsedText({ startedAt, completedAt, running, now = Date.now() } = {}) {
    const start = Date.parse(startedAt || '');
    if (!Number.isFinite(start)) return '—';
    const end = running ? now : (Date.parse(completedAt || '') || now);
    const secs = Math.max(0, Math.round((end - start) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** The clock part of an ISO stamp, which is all the header has room for. */
export function startedText(startedAt) {
    return String(startedAt || '').slice(11, 19);
}

/** Token totals in the header's compact form: 12400 → "12.4k". */
export function compactTokens(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
