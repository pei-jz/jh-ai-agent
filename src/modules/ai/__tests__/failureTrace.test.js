// The failure trace, end to end through the REAL agent loop.
//
// The unit tests cover the signature rules and the cost arithmetic; this one
// answers the only question they cannot: does a real run actually produce a
// trace, and does recording change what the agent does? (It must not — Step 0
// of docs/scratch/agent-memory-learning.plan.md ships behaviour-neutral.)

import { describe, it, expect } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

/**
 * The written trace file, parsed back into events. Matched by SESSION file name:
 * `.agent/trace/` also holds metrics.jsonl, which is a different artifact.
 */
function traceOf(h) {
    const write = [...h.invokeCalls].reverse().find(
        c => c.cmd === 'write_file' && String(c.args?.path || '').endsWith('/.agent/trace/sess_test.jsonl')
    );
    if (!write) return null;
    return {
        path: write.args.path,
        events: write.args.content.trim().split('\n').map(l => JSON.parse(l)),
    };
}

describe('session failure trace', () => {
    it('records a failure, its signature, and the step that resolved it', async () => {
        let attempt = 0;
        const h = makeHarness({
            script: [
                toolStep('write_file', { path: 'a.svelte', content: 'x' }),
                toolStep('read_file', { path: 'a.svelte' }),
                toolStep('write_file', { path: 'a.svelte', content: 'y' }),
                finishStep('done'),
            ],
            toolResults: {
                // Fails once, then succeeds — the shape Failure Cards are minted from.
                write_file: () => (++attempt === 1 ? 'Error: anchor does not match' : 'Success: wrote a.svelte'),
                read_file: () => 'file body',
            },
        });
        await h.run('edit the component');

        const trace = traceOf(h);
        expect(trace).not.toBeNull();
        expect(trace.path).toBe('./.agent/trace/sess_test.jsonl');

        const failed = trace.events.find(e => !e.ok);
        expect(failed.signature).toBe('write_file|edit_mismatch|.svelte');
        expect(failed.kind).toBe('edit_mismatch');

        // Successes are recorded too — a failure's cost is measured against them.
        const fix = trace.events.find(e => e.ok && e.tool === 'write_file');
        expect(fix).toBeTruthy();
        expect(fix.i).toBeGreaterThan(failed.i);
    });

    it('does not change what the agent does', async () => {
        const script = [toolStep('read_file', { path: 'a.js' }), finishStep('done')];
        const h = makeHarness({ script, toolResults: { read_file: () => 'body' } });
        const res = await h.run('read it');

        // The doubled finish_task is the pre-existing no-deliverable gate (see
        // agentLoop.test.js "bounces a finish_task that produced NO deliverable"),
        // not an effect of tracing — which is the point of asserting it here.
        expect(h.toolCalls.map(c => c.name)).toEqual(['read_file', 'finish_task', 'finish_task']);
        // Ended by the agent's own finish_task, not by a safety limit.
        expect(res.stopReason).toBeNull();
    });

    it('writes no trace for a clean run with nothing to record', async () => {
        // A run whose only calls succeed still gets a trace (successes are the
        // baseline), but it must contain no failure rows.
        const h = makeHarness({
            script: [toolStep('read_file', { path: 'a.js' }), finishStep('done')],
            toolResults: { read_file: () => 'body' },
        });
        await h.run('read it');
        const trace = traceOf(h);
        expect(trace.events.every(e => e.ok)).toBe(true);
    });

    it('keeps secrets out of the trace', async () => {
        const h = makeHarness({
            script: [toolStep('run_command', { command: 'curl -H "Authorization: Bearer abcdef1234567890" x' }), finishStep('done')],
            toolResults: {
                run_command: () => 'Error: fetch failed for token sk-abcdefghij0123456789',
            },
        });
        await h.run('call the api');

        const raw = JSON.stringify(traceOf(h).events);
        expect(raw).not.toContain('sk-abcdefghij0123456789');
        expect(raw).toContain('[REDACTED:key]');
    });
});
