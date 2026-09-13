// Pairing — how an app gets a token, and what it does when the token dies.
//
// This replaced reading a credential out of %APPDATA%/JH/ai-connection.json.
// Two properties carry the whole change and neither is visible from a call
// site: the token must never be written down, and a client holding a token the
// agent has never seen must RECOVER rather than report itself broken. The
// second is the common case — the agent's tokens live in memory, so every
// restart of the agent invalidates every connected app at once.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JhAiClient } from '../index.js';

const BASE = 'http://127.0.0.1:14300/api';

/**
 * A fake agent.
 *
 * `approve` decides what the poll eventually answers; `tokenFor` lets a test
 * hand out a different token on a second pairing, which is what distinguishes
 * "re-paired" from "reused the old one".
 */
function fakeAgent({ approve = 'approved', tokens = ['TOK-1', 'TOK-2'] } = {}) {
    const state = { pairRequests: [], posts: [], issued: [], polls: 0 };
    let nextToken = 0;

    const fetchImpl = vi.fn(async (url, options = {}) => {
        const path = String(url).replace(BASE, '');

        if (path === '/pair/request') {
            const body = JSON.parse(options.body);
            state.pairRequests.push(body);
            return {
                ok: true, status: 200,
                json: async () => ({ request_id: `req-${state.pairRequests.length}`, expires_in: 120 }),
            };
        }
        if (path.startsWith('/pair/')) {
            state.polls += 1;
            if (approve === 'approved') {
                const token = tokens[Math.min(nextToken++, tokens.length - 1)];
                state.issued.push(token);
                return { ok: true, status: 200, json: async () => ({ status: 'approved', token }) };
            }
            return { ok: true, status: 200, json: async () => ({ status: approve }) };
        }

        // Any authenticated route.
        const auth = options.headers?.Authorization || '';
        state.posts.push({ path, auth });
        if (state.reject401 && state.reject401(auth)) {
            return { ok: false, status: 401, text: async () => 'unauthorized' };
        }
        return { ok: true, status: 200, json: async () => ({ task_id: 'T-1' }) };
    });

    return { state, fetchImpl };
}

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

const client = (opts = {}) => new JhAiClient({ host: '127.0.0.1', port: 14300, appName: 'JHEditor', ...opts });

describe('getting a token', () => {
    it('asks, waits, and keeps the answer in memory only', async () => {
        const { state, fetchImpl } = fakeAgent();
        globalThis.fetch = fetchImpl;

        const c = client();
        expect(c.token).toBeNull();
        await c.ready();

        expect(state.pairRequests).toHaveLength(1);
        expect(state.pairRequests[0].app).toBe('JHEditor');
        expect(c.token).toBe('TOK-1');
        // Nothing reads or writes a file: the only I/O is the two HTTP calls.
        expect(fetchImpl.mock.calls.every(([u]) => String(u).startsWith('http://'))).toBe(true);
    });

    // Six digits, both ends, so the user COMPARES rather than assumes. A code
    // the editor does not show is a code that proves nothing.
    it('sends a six-digit code and hands the same one to the host to display', async () => {
        const { state, fetchImpl } = fakeAgent();
        globalThis.fetch = fetchImpl;

        const shown = [];
        const c = client({ onPairing: ({ code }) => { shown.push(code); return () => {}; } });
        await c.ready();

        expect(state.pairRequests[0].code).toMatch(/^\d{6}$/);
        expect(shown).toEqual([state.pairRequests[0].code]);
    });

    it('tears the notice down once the pairing settles', async () => {
        const { fetchImpl } = fakeAgent();
        globalThis.fetch = fetchImpl;
        const done = vi.fn();
        await client({ onPairing: () => done }).ready();
        expect(done).toHaveBeenCalledTimes(1);
    });

    // Two callers in one app must not put two prompts in front of the user.
    it('shares one pairing between concurrent callers', async () => {
        const { state, fetchImpl } = fakeAgent();
        globalThis.fetch = fetchImpl;

        const c = client();
        await Promise.all([c.ready(), c.ready(), c.ready()]);
        expect(state.pairRequests).toHaveLength(1);
    });

    it('says so plainly when the user declines', async () => {
        const { fetchImpl } = fakeAgent({ approve: 'denied' });
        globalThis.fetch = fetchImpl;
        await expect(client().ready()).rejects.toThrow(/declined/i);
    });

    // A refusal to ask must not itself ask. 429 is the agent saying "stop".
    it('reports the rate limit instead of retrying into it', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, text: async () => '' }));
        await expect(client().ready()).rejects.toThrow(/refusing|shortly/i);
    });
});

describe('when the agent restarted', () => {
    // THE case this exists for. The agent's tokens are in memory, so every
    // connected app is suddenly holding a string it has never seen. Without
    // recovery the editor reports "not reachable" and stays broken until the
    // user restarts it too.
    it('re-pairs once on a 401 and retries the original request', async () => {
        const { state, fetchImpl } = fakeAgent({ tokens: ['STALE', 'FRESH'] });
        let seen = 0;
        state.reject401 = (auth) => auth === 'Bearer STALE' && seen++ === 0;
        globalThis.fetch = fetchImpl;

        const c = client();
        await c.ready();                       // holds STALE
        const res = await c._post('/tasks', { prompt: 'x' });

        expect(res.task_id).toBe('T-1');
        expect(c.token).toBe('FRESH');
        expect(state.pairRequests).toHaveLength(2);
        // The retry carried the NEW token, not the one that was refused.
        expect(state.posts.at(-1).auth).toBe('Bearer FRESH');
    });

    // Once. A second 401 after a fresh pairing is a real failure, and looping
    // would put an approval prompt on screen over and over.
    it('does not loop when a fresh token is refused too', async () => {
        const { state, fetchImpl } = fakeAgent();
        state.reject401 = () => true;
        globalThis.fetch = fetchImpl;

        const c = client();
        await expect(c._post('/tasks', { prompt: 'x' })).rejects.toThrow(/401/);
        expect(state.pairRequests).toHaveLength(2);
    });

    // 403 is a SCOPE refusal — a real credential on a route it may not reach.
    // Re-pairing would not change the answer, so it must surface as an error.
    it('does not re-pair on a 403', async () => {
        const { state, fetchImpl } = fakeAgent();
        globalThis.fetch = vi.fn(async (url, options) => {
            if (String(url).includes('/pair')) return fetchImpl(url, options);
            return { ok: false, status: 403, text: async () => 'forbidden' };
        });

        const c = client();
        await expect(c._post('/tasks', { prompt: 'x' })).rejects.toThrow(/403/);
        expect(state.pairRequests).toHaveLength(1);
    });
});
