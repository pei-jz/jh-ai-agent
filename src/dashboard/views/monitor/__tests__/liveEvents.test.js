// liveEvents — the task socket's gate, without a socket.
//
// Every rule here corresponds to a bug that was reported and fixed inside the
// 654-line `connectWebSocket`, where it could only be reached by driving a real
// WebSocket against a real DOM.

import { describe, it, expect } from 'vitest';
import {
    routePacket, isRunning, clearsAwaitingUser, runOutcome,
    isStepBoundary, stepNumber, accumulateUsage, emptyUsage, seedUsage, steerPlaceholder,
} from '../liveEvents.js';

const pkt = (event, data = {}, timestamp = null) => ({ event, data, timestamp });
const FRESH = { replaying: false, discardUntilReplayDone: false, replayCutoffTs: 0 };

describe('routePacket — the replay boundary', () => {
    it('flushes the buffered backlog when the marker arrives mid-replay', () => {
        expect(routePacket(pkt('replay_done'), { ...FRESH, replaying: true }))
            .toMatchObject({ kind: 'replay-done', flush: true });
    });

    it('closes the discard window on a continue, with nothing to flush', () => {
        expect(routePacket(pkt('replay_done'), { ...FRESH, discardUntilReplayDone: true }))
            .toMatchObject({ kind: 'replay-done', flush: false, endDiscard: true });
    });

    // A CONTINUE reconnects and the server replays the whole prior task, which is
    // already on screen. The replayed `complete` used to wipe the just-sent
    // message and switch tabs.
    it('drops everything before the marker on a continue', () => {
        const gate = { ...FRESH, discardUntilReplayDone: true };
        for (const e of ['complete', 'thought', 'status', 'token_usage']) {
            expect(routePacket(pkt(e), gate)).toMatchObject({ kind: 'drop', why: 'discarded' });
        }
    });
});

describe('routePacket — the timestamp fallback', () => {
    const cutoff = Date.parse('2026-08-18T10:00:00Z');

    it('drops what predates the cutoff and keeps what follows it', () => {
        const gate = { ...FRESH, replayCutoffTs: cutoff };
        expect(routePacket(pkt('thought', {}, '2026-08-18T09:59:59Z'), gate))
            .toMatchObject({ kind: 'drop', why: 'stale' });
        expect(routePacket(pkt('thought', {}, '2026-08-18T10:00:01Z'), gate).kind).toBe('process');
    });

    // The cutoff compares two machines' clocks, so it is the FALLBACK: the marker
    // is checked first. A cutoff that outranked the marker could drop the new
    // run's early events — the "approved but nothing happens" bug.
    it('never outranks the marker', () => {
        const gate = { ...FRESH, replayCutoffTs: cutoff, discardUntilReplayDone: true };
        expect(routePacket(pkt('replay_done', {}, '2026-08-18T09:00:00Z'), gate).kind)
            .toBe('replay-done');
    });

    it('keeps a packet with no timestamp rather than guessing', () => {
        expect(routePacket(pkt('thought'), { ...FRESH, replayCutoffTs: cutoff }).kind).toBe('process');
    });

    it('keeps a packet whose timestamp will not parse', () => {
        expect(routePacket(pkt('thought', {}, 'not a date'), { ...FRESH, replayCutoffTs: cutoff }).kind)
            .toBe('process');
    });
});

describe('routePacket — streaming and buffering', () => {
    it('turns a live token into narration', () => {
        expect(routePacket(pkt('stream', { chunk: 'hel' }), FRESH))
            .toEqual({ kind: 'narrate', chunk: 'hel' });
    });

    it('does not narrate during the replay burst', () => {
        expect(routePacket(pkt('stream', { chunk: 'x' }), { ...FRESH, replaying: true }))
            .toMatchObject({ kind: 'drop', why: 'stream-replay' });
    });

    it('buffers the opening backlog instead of rendering it event by event', () => {
        expect(routePacket(pkt('thought'), { ...FRESH, replaying: true }))
            .toEqual({ kind: 'buffer', store: true });
    });

    // These two are handled out of band; storing them would replay an already
    // answered approval and bloat the log with stdout.
    it('buffers but does not store per-token command output', () => {
        expect(routePacket(pkt('command_chunk'), { ...FRESH, replaying: true }))
            .toEqual({ kind: 'buffer', store: false });
    });

    // `confirm_resolved` used to be dropped here too, and it is the ONLY
    // authoritative record that an approval was answered. Dropping it meant
    // re-opening a task rebuilt every approval card from a log with no answers
    // in it, offered buttons for questions settled long ago, and clicking one
    // sent an id nobody was waiting for — so nothing happened.
    it('KEEPS the record that an approval was answered', () => {
        expect(routePacket(pkt('confirm_resolved', { confirmId: 'c1' }), { ...FRESH, replaying: true }))
            .toEqual({ kind: 'buffer', store: true });
    });
});

describe('routePacket — the live path', () => {
    it('surfaces an approval answered by another client', () => {
        expect(routePacket(pkt('confirm_resolved', { confirmId: 'c1', approved: true }), FRESH))
            .toEqual({ kind: 'resolve-confirm', confirmId: 'c1', approved: true });
    });

    it('ignores a resolution that names no approval', () => {
        expect(routePacket(pkt('confirm_resolved', {}), FRESH))
            .toMatchObject({ kind: 'drop', why: 'confirm-no-id' });
    });

    it('drops live stdout chunks', () => {
        expect(routePacket(pkt('command_chunk', { chunk: 'x' }), FRESH))
            .toMatchObject({ kind: 'drop', why: 'chunk' });
    });

    it('processes everything else', () => {
        for (const e of ['thought', 'tool_call', 'status', 'complete', 'token_usage', 'result']) {
            expect(routePacket(pkt(e), FRESH).kind).toBe('process');
        }
    });

    it('drops a packet with no event rather than throwing', () => {
        expect(routePacket({}, FRESH).kind).toBe('drop');
        expect(routePacket(null, FRESH).kind).toBe('drop');
    });
});

describe('isRunning', () => {
    it('is true for anything that is not the end of the run', () => {
        expect(isRunning(pkt('thought'))).toBe(true);
        expect(isRunning(pkt('complete'))).toBe(false);
        expect(isRunning(pkt('error'))).toBe(false);
    });
});

describe('clearsAwaitingUser', () => {
    it('clears on real progress', () => {
        expect(clearsAwaitingUser(pkt('thought'))).toBe(true);
        expect(clearsAwaitingUser(pkt('tool_call'))).toBe(true);
        expect(clearsAwaitingUser(pkt('status', { status: 'running' }))).toBe(true);
    });

    // These fire while the result summary is assembled AFTER the pause; clearing
    // on them let the trailing `complete` wipe the question.
    it('does not clear on the bookkeeping that follows a pause', () => {
        expect(clearsAwaitingUser(pkt('token_usage'))).toBe(false);
        expect(clearsAwaitingUser(pkt('log'))).toBe(false);
        expect(clearsAwaitingUser(pkt('complete'))).toBe(false);
    });

    // Long-term memory and learned cards are emitted after the loop has already
    // broken. Treating that as a new run erased the question it paused on.
    it('does not treat teardown as a new run progressing', () => {
        expect(clearsAwaitingUser(pkt('status', { status: 'running', phase: 'teardown' }))).toBe(false);
    });
});

describe('runOutcome', () => {
    it('reports how a terminal packet ended the run', () => {
        expect(runOutcome(pkt('complete'))).toBe('completed');
        expect(runOutcome(pkt('error', { terminal: true }))).toBe('failed');
    });

    // A recoverable mid-run failure — a generation retry — keeps going, and is
    // shown inline as "recovering" rather than flipping the whole view to failed.
    it('does not end the run on a non-terminal error', () => {
        expect(runOutcome(pkt('error', { message: 'retrying' }))).toBeNull();
        expect(runOutcome(pkt('thought'))).toBeNull();
    });
});

describe('step boundaries', () => {
    it('recognises the announcement and reads its number', () => {
        const p = pkt('status', { message: 'Thinking... (step 7)' });
        expect(isStepBoundary(p)).toBe(true);
        expect(stepNumber(p)).toBe(7);
    });

    it('is not fooled by another status message', () => {
        expect(isStepBoundary(pkt('status', { message: 'Running: npm test' }))).toBe(false);
        expect(isStepBoundary(pkt('status', {}))).toBe(false);
        expect(stepNumber(pkt('status', { message: 'Thinking...' }))).toBeNull();
    });
});

describe('accumulateUsage', () => {
    // Each event is ONE call. Overwriting showed only the last step's tokens —
    // zero whenever that step was tool-only, the "Tokens: 0" bug.
    it('adds each call to the running total instead of replacing it', () => {
        let t = emptyUsage();
        t = accumulateUsage(t, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
        t = accumulateUsage(t, { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 });
        expect(t).toMatchObject({ prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 });
    });

    it('derives the total when the provider omits it, cache tokens included', () => {
        const t = accumulateUsage(emptyUsage(), {
            prompt_tokens: 10, completion_tokens: 5,
            cache_read_input_tokens: 100, cache_creation_input_tokens: 7,
        });
        expect(t.total_tokens).toBe(122);
        expect(t.cache_read_input_tokens).toBe(100);
        expect(t.cache_creation_input_tokens).toBe(7);
    });

    it('treats missing fields as zero rather than NaN', () => {
        expect(accumulateUsage(emptyUsage(), {})).toEqual(emptyUsage());
        expect(accumulateUsage(null, { prompt_tokens: 3 }).prompt_tokens).toBe(3);
    });
});

describe('seedUsage', () => {
    const task = { token_usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } };

    it('starts a fresh connect at zero — the replay rebuilds it', () => {
        expect(seedUsage({ preserveResults: false, current: { total_tokens: 500 }, task }))
            .toEqual(emptyUsage());
    });

    // Zeroing here made the header restart the count at every continuation.
    it('keeps what this view already counted on a continue', () => {
        const current = { ...emptyUsage(), total_tokens: 500, prompt_tokens: 400 };
        expect(seedUsage({ preserveResults: true, current, task })).toBe(current);
    });

    // The task was opened as history: nothing was seen live, so the server's
    // cumulative totals are the only truth available.
    it('seeds from the server when this view saw none of the earlier runs', () => {
        expect(seedUsage({ preserveResults: true, current: emptyUsage(), task }))
            .toMatchObject({ prompt_tokens: 9, total_tokens: 10, cache_read_input_tokens: 0 });
    });

    it('stays at zero when the server has no totals either', () => {
        expect(seedUsage({ preserveResults: true, current: emptyUsage(), task: {} }))
            .toEqual(emptyUsage());
    });
});

describe('steerPlaceholder', () => {
    // ask_user pauses the run and returns through `complete` — the task is NOT
    // done, and saying so would be a lie.
    it('asks for an answer when the run paused on a question', () => {
        expect(steerPlaceholder({ awaiting: true, finished: true, done: true })).toMatch(/Answer the agent/);
    });

    it('invites a continuation after a clean finish', () => {
        expect(steerPlaceholder({ finished: true, done: true })).toMatch(/Done\./);
    });

    it('offers a retry after a stop or failure', () => {
        expect(steerPlaceholder({ finished: true, done: false })).toMatch(/Stopped\./);
    });

    it('says steer while the run is still going', () => {
        expect(steerPlaceholder({})).toMatch(/Steer the agent/);
    });
});
