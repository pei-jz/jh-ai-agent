// spotlightRun — a Spotlight question is an ask × none, ephemeral task.
// docs/scratch/Report_20260913.md §6-4.

import { describe, it, expect, vi } from 'vitest';
import { spotlightBehavior, spotlightTaskBody, followTask } from '../spotlightRun.js';
import { resolveLane } from '../../../modules/ai/agent/RunLane.js';

class FakeWS {
    static last = null;
    constructor(url) { this.url = url; this.closed = false; FakeWS.last = this; }
    close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
    recv(event, data) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
}

describe('what a Spotlight question asks for', () => {
    it('is ask × none, ephemeral, with no MCP server', () => {
        const b = spotlightBehavior();
        expect(b).toMatchObject({ shape: 'ask', reach: 'none', ephemeral: true, mcp_servers: [] });
        // …and the server reads it the same way.
        expect(resolveLane(b, { caller: 'Spotlight' })).toMatchObject({ shape: 'ask', reach: 'none', error: null });
    });

    it('sends no workspace', () => {
        const body = spotlightTaskBody('what changed in rust 1.90?');
        expect(body.workspace_path).toBeNull();
        expect(body.caller).toBe('Spotlight');
        expect(body.prompt).toBe('what changed in rust 1.90?');
    });
});

describe('followTask', () => {
    const follow = (o = {}) => followTask('ws://x/ws/tasks/1', { WebSocketImpl: FakeWS, ...o });

    it('resolves with the delivered answer, not finish_task\'s summary', async () => {
        const p = follow();
        FakeWS.last.recv('stream', { chunk: 'looking it up…' });
        FakeWS.last.recv('complete', { message: 'Answered.', answer: '## Full answer' });
        await expect(p).resolves.toBe('## Full answer');
    });

    it('falls back to the summary, then to what streamed', async () => {
        const p1 = follow();
        FakeWS.last.recv('complete', { message: 'Only a summary' });
        await expect(p1).resolves.toBe('Only a summary');

        const p2 = follow();
        FakeWS.last.recv('stream', { chunk: 'streamed text' });
        FakeWS.last.recv('complete', {});
        await expect(p2).resolves.toBe('streamed text');
    });

    it('forwards stream chunks and tool names as they happen', async () => {
        const onStream = vi.fn(); const onTool = vi.fn();
        const p = follow({ onStream, onTool });
        FakeWS.last.recv('stream', { chunk: 'a' });
        FakeWS.last.recv('tool_call', { name: 'web_search' });
        FakeWS.last.recv('complete', { answer: 'x' });
        await p;
        expect(onStream).toHaveBeenCalledWith('a');
        expect(onTool).toHaveBeenCalledWith('web_search');
    });

    // The loop emits recoverable errors mid-run and then carries on.
    it('ignores a non-terminal error and rejects on a terminal one', async () => {
        const p = follow();
        FakeWS.last.recv('error', { error: 'retrying' });
        FakeWS.last.recv('complete', { answer: 'still answered' });
        await expect(p).resolves.toBe('still answered');

        const p2 = follow();
        FakeWS.last.recv('error', { error: 'no model configured', terminal: true });
        await expect(p2).rejects.toThrow(/no model configured/);
    });

    it('rejects when the socket closes with no answer', async () => {
        const p = follow();
        FakeWS.last.close();
        await expect(p).rejects.toThrow(/closed/);
    });

    it('resolves empty when the caller aborts, and closes the socket', async () => {
        const ac = new AbortController();
        const p = follow({ signal: ac.signal });
        const ws = FakeWS.last;
        ac.abort();
        await expect(p).resolves.toBe('');
        expect(ws.closed).toBe(true);
    });
});
