// What the user waits for after `finish_task`.
//
// The loop used to chain several LLM calls onto the tail of a run — file
// descriptions, a completion report, then the long-term-memory summarisation and
// (near the facts cap) a store-wide consolidation — all awaited before `run()`
// returned, and the caller only emits `complete` once it does. The reported
// symptom was a run whose raw log showed finish_task succeeding while the app sat
// silent for tens of seconds.
//
// These tests pin the rule that fixed it: NOTHING that fails to change the
// answer is allowed to delay it.

import { describe, it, expect, vi } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

/** A long deliverable, so the run has an answer without an LLM report call. */
const REPORT = '# 調査結果\n\n' + 'この行は成果物の本文です。'.repeat(40);

/** A run that modifies one file and finishes with a real deliverable. */
function editRun(extra = {}) {
    return makeHarness({
        script: [
            toolStep('write_file', { path: 'src/a.js', content: 'x' }),
            finishStep(REPORT),
        ],
        toolResults: { write_file: () => 'Success: wrote src/a.js' },
        ...extra,
    });
}

/** Make `generate` answer the file-description call with `descriptions`. */
function mockDescriptions(h, descriptions) {
    h.llmService.generate.mockImplementation(async (_prompt, _sys, onStream) => {
        onStream?.(JSON.stringify(descriptions));
        return { usage: {} };
    });
}

/**
 * Same, but the call does not resolve until the returned `release()` is called.
 *
 * A GATE rather than a timer: "did the run wait for this?" is a causal question,
 * and a wall-clock threshold answers it only on an unloaded machine. Here, a run
 * that awaited the descriptions can never reach `release()` — the test deadlocks
 * and fails on timeout instead of flaking under parallel load.
 */
function gateDescriptions(h, descriptions) {
    let release;
    const gate = new Promise(r => { release = r; });
    h.llmService.generate.mockImplementation(async (_prompt, _sys, onStream) => {
        await gate;
        onStream?.(JSON.stringify(descriptions));
        return { usage: {} };
    });
    return () => release();
}

describe('long-term memory is off the result path', () => {
    it('completes the run even when addEntry never settles', async () => {
        const h = editRun();
        // A summarisation call that hangs forever. Before the fix this awaited
        // value was the last thing between finish_task and the result.
        h.conversationMemory.addEntry.mockImplementation(() => new Promise(() => {}));

        const result = await Promise.race([
            h.run('edit it', { workspacePath: 'C:/ws' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('run() waited for addEntry')), 2000)),
        ]);

        expect(result.resultSummary.answer).toContain('調査結果');
    });

    it('still records the session', async () => {
        const h = editRun();
        await h.run('edit it', { workspacePath: 'C:/ws' });
        expect(h.conversationMemory.addEntry).toHaveBeenCalledTimes(1);
    });

    it('does not throw out of the run when recording fails', async () => {
        const h = editRun();
        h.conversationMemory.addEntry.mockRejectedValue(new Error('disk full'));
        await expect(h.run('edit it', { workspacePath: 'C:/ws' })).resolves.toBeTruthy();
    });
});

describe('file descriptions do not gate the result', () => {
    it('applies them inline when they arrive in time', async () => {
        const h = editRun();
        mockDescriptions(h, [{ path: 'src/a.js', description: 'エントリポイント' }]);

        const result = await h.run('edit it', { workspacePath: 'C:/ws' });

        expect(result.resultSummary.files[0].description).toBe('エントリポイント');
        // Arriving in time means ONE completion carries everything.
        expect(h.events.some(e => e.event === 'result_update')).toBe(false);
    });

    it('returns the result without waiting for a slow description call', async () => {
        const h = editRun();
        // Never released: reaching the assertions at all proves the run did not
        // await this call.
        gateDescriptions(h, [{ path: 'src/a.js', description: '遅れて届く説明' }]);

        const result = await h.run('edit it', { workspacePath: 'C:/ws' });

        expect(result.resultSummary.answer).toContain('調査結果');
        // The table is delivered empty and patched later, rather than held back.
        expect(result.resultSummary.files[0].description).toBe('');
    });

    it('emits the late descriptions as a result_update patch', async () => {
        const h = editRun();
        const release = gateDescriptions(h, [{ path: 'src/a.js', description: '遅れて届く説明' }]);

        await h.run('edit it', { workspacePath: 'C:/ws' });
        expect(h.events.some(e => e.event === 'result_update')).toBe(false);

        release();
        // The emit is deferred by a macrotask so it can never overtake the
        // `complete` it patches; wait past that boundary.
        await new Promise(r => setTimeout(r, 20));

        const patch = h.events.find(e => e.event === 'result_update');
        expect(patch).toBeTruthy();
        expect(patch.files[0].description).toBe('遅れて届く説明');
    });

    it('skips the call entirely when nothing was modified', async () => {
        const h = makeHarness({ script: [finishStep(REPORT)] });
        await h.run('just answer', { workspacePath: 'C:/ws' });
        expect(h.llmService.generate).not.toHaveBeenCalled();
    });
});

describe('auxiliary calls use the Fast tier', () => {
    it('routes file descriptions to the configured fast model', async () => {
        const h = editRun({ config: { fast_model_id: 'mock:cheap', deep_model_id: 'mock:expensive' } });
        mockDescriptions(h, [{ path: 'src/a.js', description: 'x' }]);

        await h.run('edit it', { workspacePath: 'C:/ws' });

        // generate(prompt, system, onStream, abortSignal, modelOverride)
        const call = h.llmService.generate.mock.calls.find(c => /\[Files\]/.test(c[0]));
        expect(call).toBeTruthy();
        expect(call[4]).toBe('mock:cheap');
    });

    it('keeps the active model when no fast tier is configured', async () => {
        const h = editRun({ config: {} });
        mockDescriptions(h, [{ path: 'src/a.js', description: 'x' }]);

        await h.run('edit it', { workspacePath: 'C:/ws' });

        const call = h.llmService.generate.mock.calls.find(c => /\[Files\]/.test(c[0]));
        expect(call[4]).toBe(null);
    });
});
