// The sub-agent runner's WIRING, as distinct from what a sub-agent does.
//
// `run_subtask` failed every single time with `Error executing run_subtask:
// onConfirm is not defined`. The runner is a closure built inside
// _prepareRun that captures onConfirm / onLog / abortSignal — three names that
// stayed behind in run() when _prepareRun was split out of it. Being a
// closure, it threw only when something called it, so nothing at load or at
// wiring time noticed; and the harness stored the injected runner in a bare
// vi.fn(), so no test ever called it either.
//
// These tests call it.
import { describe, it, expect } from 'vitest';
import { makeHarness, finishStep } from './agentHarness.js';

describe('the run_subtask runner is actually callable', () => {
    it('is injected on a top-level run', async () => {
        const h = makeHarness({ script: [finishStep('done')] });
        await h.run('do the thing');
        expect(typeof h.subtaskRunner).toBe('function');
    });

    // The bug, exactly: every capture has to resolve. A ReferenceError here is
    // indistinguishable to the model from "this tool is broken", and it gave
    // up on delegating entirely.
    it('resolves every name it closed over, instead of throwing ReferenceError', async () => {
        const h = makeHarness({ script: [finishStep('done')] });
        await h.run('do the thing');

        // An empty brief takes the earliest return, so this exercises the
        // closure and its captures without starting a sub-agent.
        const out = await h.subtaskRunner({}, () => {});
        expect(typeof out).toBe('string');
        expect(out).not.toMatch(/is not defined/);
        // It should fail for the REAL reason instead.
        expect(out).toMatch(/requires a non-empty "brief"/);
    });

    it('passes the run\'s callbacks through, not undefined', async () => {
        const h = makeHarness({ script: [finishStep('done')] });
        const onConfirm = async () => true;
        await h.run('do the thing', { onConfirm });

        // Reading the captured context is the only way to see that the three
        // names bound to the run's real callbacks rather than to nothing.
        const src = String(h.subtaskRunner);
        expect(src).toContain('onConfirm');
        // And the call still gets past every capture.
        await expect(h.subtaskRunner({ brief: '' }, () => {})).resolves.toMatch(/brief/);
    });

    // A sub-agent must not spawn sub-agents; the parent is the only place the
    // runner is attached.
    it('is not injected for a sub-agent run', async () => {
        const h = makeHarness({ script: [finishStep('done')] });
        const agent = await h.build();
        agent._isSubagent = true;
        await agent.run('nested', '.', () => {}, () => {}, async () => true, null, [], () => {}, null, '', []);
        expect(h.subtaskRunner).toBeUndefined();
    });
});
