// SlackSocket — a chat channel this app can actually reach.
//
// Slack, like LINE and WeChat, delivers messages by POSTing to a public URL.
// This app binds 127.0.0.1 and refuses a non-loopback Host, so none of that can
// arrive. Socket Mode is Slack's answer for exactly this case: the app dials
// OUT over one WSS and Slack pushes events down it. No port, no tunnel, no
// public address — and no cloud relay to run.
//
// It is therefore NOT a poller, and that is the one thing to keep in mind when
// reading it beside the other watchers: there is no interval and no baseline,
// because there is nothing to compare. Events arrive when they arrive.
//
// The pure half (parsing, filtering, backoff) is separated from the socket so
// the rules can be tested without a network — in particular the two that
// matter: ignoring the app's own messages, and honouring the allowlists.

/** Where a Socket Mode connection is opened. Fixed — never taken from config. */
export const CONNECTIONS_OPEN_URL = 'https://slack.com/api/apps.connections.open';

/**
 * Should this Slack event become a trigger event?
 *
 * Two jobs. The first is scope: a workspace is full of people, and a job driven
 * by chat is a job anyone in that workspace can start. The second is LOOPS —
 * if the agent posts its answer back to Slack, that post is itself an event,
 * and without this the run starts itself again, for ever.
 *
 * @param {object} watcher   the watcher's config (channel / user allowlists)
 * @param {object} event     Slack's inner `event` object
 * @returns {string|null}    null to accept, or the reason it was ignored
 */
export function rejectReason(watcher, event) {
    if (!event || event.type !== 'message') return 'not a message';
    // A message from any bot — including this app's own replies. Checked before
    // the allowlists because a loop is worse than a miss.
    if (event.bot_id || event.subtype === 'bot_message') return 'from a bot';
    // Edits, deletions, joins, topic changes: not instructions.
    if (event.subtype) return `subtype: ${event.subtype}`;
    if (!String(event.text || '').trim()) return 'empty';

    const channels = list(watcher.slackChannels);
    if (channels.length && !channels.includes(event.channel)) return 'channel not allowed';
    const users = list(watcher.slackUsers);
    if (users.length && !users.includes(event.user)) return 'user not allowed';
    return null;
}

/** A comma/space separated allowlist, as an array. */
function list(raw) {
    return String(raw || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Turn one Socket Mode frame into what the trigger rules consume.
 *
 * Returns `{ ack, event }`. `ack` must be sent back whatever happens — Slack
 * re-delivers anything unacknowledged, so dropping the ack for a message we
 * chose to ignore would make it arrive again and again.
 */
export function readFrame(watcher, frame, now = Date.now()) {
    const ack = frame?.envelope_id ? { envelope_id: frame.envelope_id } : null;

    if (frame?.type === 'hello') return { ack: null, hello: true };
    if (frame?.type === 'disconnect') return { ack: null, disconnect: frame.reason || 'requested' };
    if (frame?.type !== 'events_api') return { ack };

    const inner = frame?.payload?.event;
    const why = rejectReason(watcher, inner);
    if (why) return { ack, ignored: why };

    return {
        ack,
        event: {
            source: 'watcher',
            watcherId: watcher.id,
            event: watcher.eventName || 'slack.message',
            // Slack's own identity for the message. The same event re-delivered
            // after a reconnect is the same key, so it cannot start a second run.
            key: `${inner.channel}|${inner.ts}`,
            payload: {
                text: inner.text,
                user: inner.user,
                channel: inner.channel,
                ts: inner.ts,
                thread_ts: inner.thread_ts || null,
                team: frame?.payload?.team_id || null,
                at: now,
            },
        },
    };
}

/**
 * How long to wait before reconnecting, after `attempt` consecutive failures.
 *
 * Capped, and jittered. An app that reconnects instantly and in lockstep with
 * every other instance is how a transient Slack outage becomes a stampede.
 */
export function backoffMs(attempt, rand = Math.random) {
    const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.5 + rand() * 0.5));
}

/**
 * Ask Slack for a Socket Mode URL.
 *
 * Called with the app-level token (`xapp-…`), which is NOT the bot token and is
 * the only one that can open a connection. Uses the webview's own fetch: the
 * URL is a constant in this file, so there is nothing here for a config value
 * to redirect.
 */
export async function openConnection(appToken, fetchImpl = fetch) {
    const res = await fetchImpl(CONNECTIONS_OPEN_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${appToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    const body = await res.json().catch(() => ({}));
    if (!body?.ok || !body?.url) {
        // Slack's own error name is far more useful than "connection failed":
        // `invalid_auth` means the wrong token, `not_allowed_token_type` means
        // a bot token was pasted where an app-level one belongs.
        throw new Error(`Slack への接続を開けませんでした: ${body?.error || res.status}`);
    }
    return body.url;
}

/**
 * One live Socket Mode connection.
 *
 * Owns only the socket and the retry timer; every decision is above. Stopping
 * is explicit and final — `stop()` must not leave a reconnect armed, or a
 * watcher switched off keeps answering.
 */
export class SlackConnection {
    constructor({ watcher, getToken, onEvent, onStatus, ws = null, opener = openConnection }) {
        this.watcher = watcher;
        this.getToken = getToken;
        this.onEvent = onEvent || (() => {});
        this.onStatus = onStatus || (() => {});
        this._WS = ws || globalThis.WebSocket;
        this._open = opener;
        this.socket = null;
        this.attempt = 0;
        this.stopped = false;
        this._timer = null;
    }

    async start() {
        this.stopped = false;
        await this._connect();
        return this;
    }

    stop() {
        this.stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
        try { this.socket?.close(); } catch (_) { /* already gone */ }
        this.socket = null;
        this.onStatus({ ok: true, connected: false });
    }

    async _connect() {
        if (this.stopped) return;
        try {
            const token = await this.getToken();
            if (!token) throw new Error('アプリレベルトークン (xapp-…) が保存されていません。');
            const url = await this._open(token);
            const socket = new this._WS(url);
            this.socket = socket;

            socket.onopen = () => {
                this.attempt = 0;
                this.onStatus({ ok: true, connected: true });
            };
            socket.onmessage = (msg) => this._onFrame(msg);
            socket.onerror = () => { /* onclose follows and owns the retry */ };
            socket.onclose = () => {
                this.socket = null;
                this.onStatus({ ok: true, connected: false });
                this._retry();
            };
        } catch (e) {
            this.onStatus({ ok: false, connected: false, error: e?.message || String(e) });
            this._retry();
        }
    }

    _onFrame(msg) {
        let frame = null;
        try { frame = JSON.parse(msg?.data ?? msg); } catch (_) { return; }
        const r = readFrame(this.watcher, frame, Date.now());

        // Acknowledge FIRST, and for everything. Slack re-delivers anything
        // unacknowledged, so an ignored message that is never acked comes back
        // on a loop — the filter would look like it was not working.
        if (r.ack) {
            try { this.socket?.send(JSON.stringify(r.ack)); } catch (_) { /* closing */ }
        }
        if (r.disconnect) {
            // Slack asks clients to reconnect periodically; this is routine.
            try { this.socket?.close(); } catch (_) { /* already closing */ }
            return;
        }
        if (r.event) this.onEvent(r.event);
    }

    _retry() {
        if (this.stopped || this._timer) return;
        this.attempt += 1;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._connect();
        }, backoffMs(this.attempt));
    }
}
