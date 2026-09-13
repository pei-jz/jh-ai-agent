// What a client gets back. `complete.message` is finish_task's one-line
// summary; `complete.answer` is the deliverable. The JHEditor chat returned the
// summary, so the user read a sentence ABOUT an answer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JhAiClient } from '../index.js';

class FakeWS {
    static last = null;
    constructor(url) { this.url = url; FakeWS.last = this; }
    close() { this.onclose?.(); }
    send() {}
    recv(event, data) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
}

let realFetch, realWS;
beforeEach(() => {
    realFetch = globalThis.fetch; realWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeWS;
    FakeWS.last = null;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ task_id: 't1' }) }));
});
afterEach(() => { globalThis.fetch = realFetch; globalThis.WebSocket = realWS; });

const client = () => new JhAiClient({ host: '127.0.0.1', port: 14300, token: 'TOK' });
const body = () => JSON.parse(globalThis.fetch.mock.calls[0][1].body);

describe('invoke — the transform lane', () => {
    it('asks for shape transform and returns the answer', async () => {
        const p = client().invoke({ prompt: 'write a commit message' });
        await vi.waitFor(() => expect(FakeWS.last).toBeTruthy());
        FakeWS.last.recv('complete', { message: 'Done.', answer: 'feat: add lanes' });
        expect((await p).content).toBe('feat: add lanes');
        expect(body().behavior).toMatchObject({ mode: 'single_shot', shape: 'transform' });
    });

    it('streams deltas to onChunk', async () => {
        const chunks = [];
        const p = client().invoke({ prompt: 'x', onChunk: (c) => chunks.push(c) });
        await vi.waitFor(() => expect(FakeWS.last).toBeTruthy());
        FakeWS.last.recv('stream', { chunk: 'fe' });
        FakeWS.last.recv('stream', { chunk: 'at' });
        FakeWS.last.recv('complete', { answer: 'feat' });
        await p;
        expect(chunks).toEqual(['fe', 'at']);
    });
});

describe('invokeAgent — the deliverable, not the summary', () => {
    it('resolves with complete.answer', async () => {
        const task = client().invokeAgent({ prompt: 'review', behavior: { shape: 'ask', reach: 'app' } });
        await vi.waitFor(() => expect(FakeWS.last).toBeTruthy());
        FakeWS.last.recv('complete', { message: 'Reviewed.', answer: '## Findings\n1. …' });
        expect((await task.completed).content).toBe('## Findings\n1. …');
    });

    it('falls back to the summary for a server that sends no answer', async () => {
        const task = client().invokeAgent({ prompt: 'x' });
        await vi.waitFor(() => expect(FakeWS.last).toBeTruthy());
        FakeWS.last.recv('complete', { message: 'Only a summary' });
        expect((await task.completed).content).toBe('Only a summary');
    });
});

describe('compose — hand work over instead of starting it', () => {
    it('posts the text to /ui/compose', async () => {
        const ok = await client().compose({ prompt: 'refactor the parser', workspace: 'C:/proj' });
        expect(ok).toBe(true);
        const [url, opts] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:14300/api/ui/compose');
        expect(JSON.parse(opts.body)).toEqual({ prompt: 'refactor the parser', workspace: 'C:/proj' });
    });
});
