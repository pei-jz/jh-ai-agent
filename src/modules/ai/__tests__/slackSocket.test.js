// Slack Socket Mode — the one chat platform this app can reach without a
// server of its own.
//
// The two rules worth testing are not about parsing. They are: the app must not
// answer its own messages (or a run starts itself, for ever), and it must
// acknowledge everything Slack sends — including what it deliberately ignores,
// because an unacknowledged frame is re-delivered on a loop.
import { describe, it, expect, vi } from 'vitest';
import {
    rejectReason, readFrame, backoffMs, openConnection, SlackConnection,
    CONNECTIONS_OPEN_URL,
} from '../triggers/SlackSocket.js';

const W = { id: 'w1', eventName: 'slack.message' };
const msg = (over = {}) => ({
    type: 'message', channel: 'C1', user: 'U1', ts: '1700.1', text: 'do the thing', ...over,
});
const frame = (event, envelope_id = 'e1') => ({
    type: 'events_api', envelope_id, payload: { team_id: 'T1', event },
});

describe('what is not an instruction', () => {
    // A loop is worse than a miss, so this is checked before anything else.
    it('ignores anything a bot said — including this app answering itself', () => {
        expect(rejectReason(W, msg({ bot_id: 'B1' }))).toBe('from a bot');
        expect(rejectReason(W, msg({ subtype: 'bot_message' }))).toBe('from a bot');
    });

    it('ignores edits, joins and other non-messages', () => {
        expect(rejectReason(W, msg({ subtype: 'message_changed' }))).toContain('subtype');
        expect(rejectReason(W, { type: 'reaction_added' })).toBe('not a message');
        expect(rejectReason(W, msg({ text: '   ' }))).toBe('empty');
    });

    it('accepts an ordinary message', () => {
        expect(rejectReason(W, msg())).toBeNull();
    });
});

describe('the allowlists', () => {
    // A workspace is full of people. Without these, a job driven by chat is a
    // job anyone in the workspace can start.
    it('limit which channels count', () => {
        const w = { ...W, slackChannels: 'C1, C2' };
        expect(rejectReason(w, msg({ channel: 'C2' }))).toBeNull();
        expect(rejectReason(w, msg({ channel: 'C9' }))).toBe('channel not allowed');
    });

    it('limit who counts', () => {
        const w = { ...W, slackUsers: 'U1' };
        expect(rejectReason(w, msg({ user: 'U1' }))).toBeNull();
        expect(rejectReason(w, msg({ user: 'U2' }))).toBe('user not allowed');
    });

    it('are off when empty, which is why the UI warns about it', () => {
        expect(rejectReason({ ...W, slackChannels: '', slackUsers: '  ' }, msg())).toBeNull();
    });
});

describe('reading a frame', () => {
    it('turns a message into an event keyed by Slack own identity', () => {
        const r = readFrame(W, frame(msg()), 1700);
        expect(r.event).toMatchObject({ source: 'watcher', watcherId: 'w1', event: 'slack.message' });
        // Re-delivered after a reconnect, this is the same key — so it cannot
        // start a second run.
        expect(r.event.key).toBe('C1|1700.1');
        expect(r.event.payload).toMatchObject({ text: 'do the thing', user: 'U1', channel: 'C1' });
    });

    // Slack re-delivers anything unacknowledged. An ignored message that is
    // never acked comes back on a loop, and the filter looks broken.
    it('acknowledges what it ignores, not only what it accepts', () => {
        const accepted = readFrame(W, frame(msg()));
        const ignored = readFrame(W, frame(msg({ bot_id: 'B1' }), 'e2'));
        expect(accepted.ack).toEqual({ envelope_id: 'e1' });
        expect(ignored.ack).toEqual({ envelope_id: 'e2' });
        expect(ignored.event).toBeUndefined();
        expect(ignored.ignored).toBe('from a bot');
    });

    it('recognises the handshake and the reconnect request', () => {
        expect(readFrame(W, { type: 'hello' }).hello).toBe(true);
        expect(readFrame(W, { type: 'disconnect', reason: 'warning' }).disconnect).toBe('warning');
    });
});

describe('reconnecting', () => {
    // Instant, lockstep reconnects turn a transient Slack outage into a
    // stampede from every instance at once.
    it('backs off, caps, and jitters', () => {
        expect(backoffMs(1, () => 0)).toBe(500);
        expect(backoffMs(1, () => 1)).toBe(1000);
        expect(backoffMs(4, () => 1)).toBe(8000);
        expect(backoffMs(99, () => 1)).toBe(30000);
        expect(backoffMs(99, () => 0)).toBe(15000);
    });
});

describe('opening the connection', () => {
    it('posts the app-level token to the fixed Slack endpoint', async () => {
        const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: true, url: 'wss://x' }) }));
        const url = await openConnection('xapp-1', fetchImpl);
        expect(url).toBe('wss://x');
        expect(fetchImpl.mock.calls[0][0]).toBe(CONNECTIONS_OPEN_URL);
        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer xapp-1');
    });

    // `not_allowed_token_type` means a bot token was pasted where an app-level
    // one belongs — far more useful than "connection failed".
    it('carries Slack own error through', async () => {
        const fetchImpl = async () => ({ json: async () => ({ ok: false, error: 'not_allowed_token_type' }) });
        await expect(openConnection('xoxb-wrong', fetchImpl))
            .rejects.toThrow(/not_allowed_token_type/);
    });
});

describe('the connection', () => {
    /** A WebSocket stand-in that records what was sent. */
    function fakeWs() {
        const sent = [];
        class WS {
            constructor(url) { WS.last = this; this.url = url; this.sent = sent; }
            send(s) { sent.push(JSON.parse(s)); }
            close() { this.onclose?.(); }
        }
        WS.sent = sent;
        return WS;
    }

    const conn = (over = {}) => {
        const WS = fakeWs();
        const events = [];
        const c = new SlackConnection({
            watcher: W,
            getToken: async () => 'xapp-1',
            onEvent: (e) => events.push(e),
            ws: WS,
            opener: async () => 'wss://x',
            ...over,
        });
        return { c, WS, events };
    };

    it('acks every frame and forwards only the real messages', async () => {
        const { c, WS, events } = conn();
        await c.start();
        WS.last.onmessage({ data: JSON.stringify(frame(msg())) });
        WS.last.onmessage({ data: JSON.stringify(frame(msg({ bot_id: 'B1' }), 'e2')) });

        expect(WS.sent).toEqual([{ envelope_id: 'e1' }, { envelope_id: 'e2' }]);
        expect(events).toHaveLength(1);
    });

    it('reports a missing token instead of failing silently', async () => {
        const seen = [];
        const { c } = conn({ getToken: async () => '', onStatus: (s) => seen.push(s) });
        await c.start();
        expect(seen.at(-1).ok).toBe(false);
        expect(seen.at(-1).error).toMatch(/xapp/);
        c.stop();
    });

    // A watcher switched off that keeps its socket open keeps answering.
    it('stops for good, with no reconnect left armed', async () => {
        vi.useFakeTimers();
        const { c, WS, events } = conn();
        await c.start();
        c.stop();
        WS.last.onclose?.();
        await vi.advanceTimersByTimeAsync(120000);
        expect(events).toEqual([]);
        expect(c.socket).toBeNull();
        vi.useRealTimers();
    });
});
