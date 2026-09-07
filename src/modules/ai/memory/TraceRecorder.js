// TraceRecorder — the per-session record of what each tool call did.
//
// Step 0 of docs/scratch/agent-memory-learning.plan.md: the measurement floor the
// rest of the memory work stands on. It answers the two questions Failure Cards
// (Step 1) need and nothing today can answer:
//
//   • is THIS failure the same one as last time?      → signature
//   • how much did it cost before it was resolved?    → costSteps
//
// It deliberately does NOT decide what to remember, write cards, or call an LLM.
// This step only records, so it can ship without changing agent behaviour: the
// recorder sits beside `_trackReadEfficiency` / `_logToolTelemetry`, which
// already run on every call — the trace is a tap on an existing stream, not new
// instrumentation.
//
// The pure functions (`toEvent`, `summarizeFailures`) carry the logic and are
// tested directly; the class is the thin I/O shell, with `invoke` injected so
// tests need no Tauri.

import { normalizeError, signatureOf, targetOf, argShapeOf, extOf, redact, queryOf } from './FailureSignature.js';

/** Normalized error text is kept for display only — capped, never a whole dump. */
const MESSAGE_MAX = 300;

/**
 * Build one trace event from a completed tool call. Pure.
 *
 * Successes are recorded too, and that is the point: a failure's cost is the
 * distance to the SUCCESS that resolved it, so a trace of failures alone cannot
 * measure anything.
 *
 * @param {{iteration:number, tool:string, args?:object, result?:any,
 *          isError?:boolean, ms?:number, denied?:boolean}} call
 */
export function toEvent({ iteration, tool, args, result, isError, ms, denied } = {}) {
    const target = targetOf(args);
    const ev = {
        i: Number(iteration) || 0,
        tool: String(tool || 'unknown'),
        argShape: argShapeOf(args),
        target: redact(target),
        ok: !isError,
        ms: Number(ms) || 0,
    };
    if (denied) ev.denied = true;
    // Search term (redacted, capped). Kept because a search the agent then ACTED
    // on is a discovery worth remembering — see CardStore's locator insights.
    const q = queryOf(tool, args);
    if (q) ev.q = q;
    if (isError) {
        const { kind, loc, message } = normalizeError(typeof result === 'string' ? result : String(result ?? ''));
        ev.kind = kind;
        ev.signature = signatureOf({ tool: ev.tool, kind, ext: extOf(target) });
        if (loc) ev.loc = loc;
        ev.message = message.substring(0, MESSAGE_MAX);
    }
    return ev;
}

/**
 * Fold a session's events into one row per distinct failure. Pure.
 *
 * `costSteps` is the review-agreed definition (plan §1.2 B2): the iteration of
 * the FIRST occurrence of a (signature, target) pair, to the iteration where the
 * same tool succeeded on the same target. `AgentController.retryCount` could not
 * be used for this — it is scoped to the LLM generation retry loop, not to tool
 * failures — and `consecutiveErrorCount` counts any error, not this one.
 *
 * A failure never resolved in the session is not free: it is charged to the end
 * of the session and flagged `unresolved`, since "gave up" is the expensive
 * outcome, not the cheap one.
 *
 * @param {Array} events
 * @returns {Array<{signature, target, kind, tool, first, resolvedAt, costSteps,
 *                  attempts, unresolved, denied, loc, message}>}
 */
export function summarizeFailures(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const lastIteration = events.reduce((m, e) => Math.max(m, e.i || 0), 0);

    /** @type {Map<string, any>} */
    const groups = new Map();
    for (const e of events) {
        if (e.ok || !e.signature) continue;
        const key = `${e.signature}::${e.target || ''}`;
        const g = groups.get(key);
        if (g) {
            g.attempts++;
            g.first = Math.min(g.first, e.i);
            g.last = Math.max(g.last, e.i);
        } else {
            groups.set(key, {
                signature: e.signature, target: e.target || '', kind: e.kind, tool: e.tool,
                argShape: e.argShape || '', loc: e.loc || '', message: e.message || '',
                denied: !!e.denied, attempts: 1, first: e.i, last: e.i,
            });
        }
    }

    const rows = [];
    for (const g of groups.values()) {
        // The resolving success: same tool, same target, after the first failure.
        const fix = events.find(e => e.ok && e.tool === g.tool && (e.target || '') === g.target && e.i > g.first);
        const resolvedAt = fix ? fix.i : null;
        rows.push({
            signature: g.signature, target: g.target, kind: g.kind, tool: g.tool,
            argShape: g.argShape, loc: g.loc, message: g.message, denied: g.denied,
            attempts: g.attempts,
            first: g.first,
            resolvedAt,
            unresolved: resolvedAt === null,
            costSteps: Math.max(1, (resolvedAt ?? lastIteration) - g.first),
        });
    }
    rows.sort((a, b) => b.costSteps - a.costSteps || b.attempts - a.attempts);
    return rows;
}

/**
 * Appends events to `<workspace>/.agent/trace/<sessionId>.jsonl`.
 *
 * Buffered: the file is rewritten from the in-memory list rather than appended
 * to, because the Rust side has no append command and a per-session trace is
 * small. Every method is failure-tolerant — a trace that cannot be written must
 * never take a task down with it.
 */
export class TraceRecorder {
    /**
     * @param {{workspacePath?:string, sessionId?:string, invoke:Function, flushEvery?:number}} opts
     */
    constructor({ workspacePath, sessionId, invoke, flushEvery = 20 } = {}) {
        this.workspacePath = workspacePath || '';
        this.sessionId = sessionId || '';
        this._invoke = invoke;
        this.flushEvery = flushEvery;
        this.events = [];
        this._dirty = 0;
        this._dirEnsured = false;
        /** Disabled (silently) when there is nowhere to write. */
        this.enabled = !!(this.workspacePath && this.sessionId && typeof invoke === 'function');
    }

    get path() {
        return `${this.workspacePath}/.agent/trace/${this.sessionId}.jsonl`;
    }

    /** Record one completed call. Sync; the flush it may trigger is detached. */
    record(call) {
        if (!this.enabled) return null;
        let ev;
        try { ev = toEvent(call); } catch (_) { return null; }
        this.events.push(ev);
        this._dirty++;
        if (this._dirty >= this.flushEvery) this.flush();
        return ev;
    }

    /** Write the buffer out. Resolves even on failure (never throws). */
    async flush() {
        if (!this.enabled || this._dirty === 0) return false;
        this._dirty = 0;
        const content = this.events.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            if (!this._dirEnsured) {
                try { await this._invoke('create_dir', { path: `${this.workspacePath}/.agent/trace` }); } catch (_) { /* exists */ }
                this._dirEnsured = true;
            }
            await this._invoke('write_file', { path: this.path, content });
            return true;
        } catch (e) {
            console.warn('TraceRecorder: could not write trace:', e);
            return false;
        }
    }

    /** Failure rows for this session (Step 1 reads these to mint cards). */
    summary() {
        return summarizeFailures(this.events);
    }
}
