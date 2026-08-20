// liveEvents — what to DO with a packet arriving on the task WebSocket.
//
// Extracted from MonitorView.connectWebSocket, a 654-line method whose
// `onmessage` interleaved four unrelated jobs: deciding whether a packet was
// even relevant, accumulating counters, building the All-Logs DOM by hand, and
// re-rendering Svelte regions. Only the first two are decisions; the rest is
// drawing. This module owns the decisions.
//
// It is worth separating because that gate is where the bugs actually were, and
// each of them is a rule that is one line to state and was several branches deep
// to read:
//
//   • a CONTINUE reconnects and the server replays the ENTIRE prior task. The
//     replayed `complete` used to wipe the just-sent message and switch tabs.
//   • the timestamp cutoff that guarded against it could itself drop the NEW
//     run's early events when client and server clocks disagreed — the "approved
//     but nothing happens" bug — so a server marker (`replay_done`) supersedes it
//     and the cutoff survives only as the fallback for older backends.
//   • `phase: 'teardown'` events are bookkeeping the agent loop emits AFTER it
//     has already stopped. Treating them as "a run is progressing" cleared the
//     ask_user question the run had just paused on.
//   • `token_usage` is per-CALL, not cumulative. Overwriting showed only the last
//     step's tokens — zero whenever the final step was tool-only.

/** Events that are never stored: high-volume, or already handled out of band. */
const NEVER_STORED = new Set(['command_chunk', 'confirm_resolved']);

/**
 * Decide what a packet is for, given the connection's current gate.
 *
 * @param {object} packet  {event, data, timestamp}
 * @param {object} gate
 * @param {boolean} gate.replaying              buffering the server's opening backlog
 * @param {boolean} gate.discardUntilReplayDone a CONTINUE: drop the backlog entirely
 * @param {number}  gate.replayCutoffTs         fallback cutoff (ms) for backends with no marker
 * @returns {{kind: string, [k: string]: any}}
 *   replay-done   the boundary marker — flush the buffer / close the discard window
 *   drop          ignore it, with `why` for the reason
 *   narrate       a live token; `chunk` is the text
 *   buffer        accumulate it; `store` says whether it belongs in the log list
 *   resolve-confirm  an approval was answered, possibly by another client
 *   process       everything else: the normal path
 */
export function routePacket(packet, gate = {}) {
    const event = packet?.event;
    if (!event) return { kind: 'drop', why: 'empty' };

    const { replaying = false, discardUntilReplayDone = false, replayCutoffTs = 0 } = gate;

    if (event === 'replay_done') {
        return { kind: 'replay-done', flush: replaying, endDiscard: discardUntilReplayDone };
    }

    // A CONTINUE has the prior task already rendered; the backlog is noise until
    // the marker above says the new run starts.
    if (discardUntilReplayDone) return { kind: 'drop', why: 'discarded' };

    // Fallback for a backend that never sends the marker. Deliberately second:
    // it compares clocks, and clocks disagree.
    if (replayCutoffTs && packet.timestamp) {
        const at = new Date(packet.timestamp).getTime();
        if (Number.isFinite(at) && at < replayCutoffTs) return { kind: 'drop', why: 'stale' };
    }

    // Per-token narration. Never stored — the server does not persist it either,
    // and a replayed backlog contains none.
    if (event === 'stream') {
        return replaying
            ? { kind: 'drop', why: 'stream-replay' }
            : { kind: 'narrate', chunk: packet.data?.chunk || '' };
    }

    // The opening burst: accumulate, render once at the end. Rendering each event
    // as it arrived meant a DOM insertion plus a forced layout per event — the
    // "selecting a running task is slow" cost, quadratic in the task's length.
    if (replaying) return { kind: 'buffer', store: !NEVER_STORED.has(event) };

    if (event === 'confirm_resolved') {
        const { confirmId, approved } = packet.data || {};
        return confirmId
            ? { kind: 'resolve-confirm', confirmId, approved }
            : { kind: 'drop', why: 'confirm-no-id' };
    }

    // Live stdout. Thousands of these on a broad command, none of them rendered.
    if (event === 'command_chunk') return { kind: 'drop', why: 'chunk' };

    return { kind: 'process' };
}

/** Does this packet mean a run is actively streaming (so not finished)? */
export function isRunning(packet) {
    const e = packet?.event;
    return !!e && e !== 'complete' && e !== 'error';
}

/**
 * Does this packet mean a NEW run is genuinely progressing?
 *
 * Only then may the ask_user "waiting" state be cleared. `token_usage` and `log`
 * fire while the result summary is assembled AFTER the pause, and clearing on
 * those let the trailing `complete` wipe the question. `phase: 'teardown'` is the
 * same mistake through a different door: memory writes and learned cards are
 * emitted after the loop has already broken.
 */
export function clearsAwaitingUser(packet) {
    const e = packet?.event;
    if (e === 'thought' || e === 'tool_call') return true;
    return e === 'status'
        && packet.data?.status === 'running'
        && packet.data?.phase !== 'teardown';
}

/**
 * Is this the end of the run, and how did it end?
 *
 * An `error` WITHOUT `data.terminal` is a RECOVERABLE mid-run failure (a
 * generation retry, say). The run continues, so it must not flip the UI to
 * failed — it is already shown inline in the feed as "recovering".
 */
export function runOutcome(packet) {
    const e = packet?.event;
    if (e === 'complete') return 'completed';
    if (e === 'error' && packet.data?.terminal) return 'failed';
    return null;
}

/** A step boundary — the next narration chunks belong to a new bubble. */
export function isStepBoundary(packet) {
    return packet?.event === 'status'
        && typeof packet.data?.message === 'string'
        && packet.data.message.startsWith('Thinking... (step ');
}

/** The step number the boundary announces, or null when it carries none. */
export function stepNumber(packet) {
    const m = String(packet?.data?.message || '').match(/\(step (\d+)\)/);
    return m ? Number(m[1]) : null;
}

const ZERO_USAGE = {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
};

/** A fresh zeroed usage record. */
export function emptyUsage() {
    return { ...ZERO_USAGE };
}

/**
 * Fold one call's usage into the running totals.
 *
 * ACCUMULATES: each `token_usage` event is one LLM call, not the task's total.
 * `total_tokens` is derived when the provider omits it — including the cache
 * fields, which are real input tokens even when billed differently.
 */
export function accumulateUsage(totals, data = {}) {
    const cacheRead = data.cache_read_input_tokens || 0;
    const cacheWrite = data.cache_creation_input_tokens || 0;
    const prompt = data.prompt_tokens || 0;
    const completion = data.completion_tokens || 0;
    const base = totals || ZERO_USAGE;
    return {
        prompt_tokens: base.prompt_tokens + prompt,
        completion_tokens: base.completion_tokens + completion,
        total_tokens: base.total_tokens + (data.total_tokens || (prompt + completion + cacheRead + cacheWrite)),
        cache_read_input_tokens: base.cache_read_input_tokens + cacheRead,
        cache_creation_input_tokens: base.cache_creation_input_tokens + cacheWrite,
    };
}

/**
 * The usage a reconnect should start from.
 *
 * Totals are the TASK's whole life, and the server accumulates them across
 * continues too. A fresh connect rebuilds them from the replay, so it starts at
 * zero; a CONTINUE must NOT, or the header restarts the count at every
 * continuation. When this view never saw the earlier runs live (the task was
 * opened as history) there is nothing to keep, so seed from the server's totals.
 */
export function seedUsage({ preserveResults, current, task }) {
    if (!preserveResults) return emptyUsage();
    if (current?.total_tokens) return current;
    const t = task?.token_usage;
    if (!t) return current || emptyUsage();
    return {
        prompt_tokens: t.prompt_tokens || 0,
        completion_tokens: t.completion_tokens || 0,
        total_tokens: t.total_tokens || 0,
        cache_read_input_tokens: t.cache_read_input_tokens || 0,
        cache_creation_input_tokens: t.cache_creation_input_tokens || 0,
    };
}

/**
 * What the steering box invites you to do once a run stops.
 *
 * ask_user pauses the run and returns through `complete` — but the task is not
 * done, it is waiting. Saying "Done" there would be a lie, and the reply box has
 * to read as "answer this".
 */
export function steerPlaceholder({ awaiting = false, finished = false, done = false } = {}) {
    if (awaiting) return '❓ Answer the agent\'s question to continue (Ctrl+Enter)…';
    if (!finished) return 'Steer the agent... (Ctrl+Enter to send, / for skills)';
    return done
        ? '✓ Done. Add a message to continue the task (Ctrl+Enter, / for skills)'
        : '⚠ Stopped. Add a message to continue / retry (Ctrl+Enter, / for skills)';
}
