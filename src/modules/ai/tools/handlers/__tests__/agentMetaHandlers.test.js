import { describe, it, expect, vi } from 'vitest';

// agentMetaHandlers imports invoke from the Tauri bridge at module load; mock it
// (handlePresentResult itself only uses ctx.onToolEvent).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { handlePresentResult } = await import('../agentMetaHandlers.js');

/** Capture the envelope emitted via ctx.onToolEvent('result', {envelope}). */
function runPresent(args) {
    let captured = null;
    const ctx = { onToolEvent: (event, data) => { if (event === 'result') captured = data.envelope; } };
    return handlePresentResult(ctx, args, () => {}).then(msg => ({ captured, msg }));
}

describe('handlePresentResult — Result Contract envelope', () => {
    it('markdown kind → payload.md', async () => {
        const { captured } = await runPresent({ kind: 'markdown', markdown: '# Hi', summary: 's', files: null, edits: null, actions: null });
        expect(captured.kind).toBe('markdown');
        expect(captured.payload).toEqual({ md: '# Hi' });
        expect(captured.summary).toBe('s');
        expect(captured.actions).toEqual([]);
    });

    it('answer kind → payload.text', async () => {
        const { captured } = await runPresent({ kind: 'answer', markdown: 'plain', summary: null, files: null, edits: null, actions: null });
        expect(captured.payload).toEqual({ text: 'plain' });
        expect(captured.summary).toBe('');
    });

    it('file-list kind → payload.files', async () => {
        const files = [{ path: 'a.js', line: 3, reason: 'x' }];
        const { captured } = await runPresent({ kind: 'file-list', markdown: null, summary: null, files, edits: null, actions: null });
        expect(captured.payload).toEqual({ files });
    });

    it('code-edit kind → payload.edits', async () => {
        const edits = [{ path: 'a.js', new_text: 'x', start_line: 1, end_line: 2 }];
        const { captured } = await runPresent({ kind: 'code-edit', markdown: null, summary: null, files: null, edits, actions: null });
        expect(captured.payload).toEqual({ edits });
    });

    it('normalizes actions: drops incomplete, strips null fields, builds apply', async () => {
        const actions = [
            { label: 'Open', type: 'openFile', path: 'a.js', line: 10, text: null },
            { label: 'Insert', type: 'insertMarkdown', path: null, line: null, text: 'hello' },
            { label: '', type: 'openFile', path: 'b.js', line: null, text: null }, // dropped (no label)
            { type: 'openFile', path: 'c.js', line: null, text: null },            // dropped (no label)
        ];
        const { captured } = await runPresent({ kind: 'markdown', markdown: 'x', summary: null, files: null, edits: null, actions });
        expect(captured.actions).toEqual([
            { label: 'Open', apply: { type: 'openFile', path: 'a.js', line: 10 } },
            { label: 'Insert', apply: { type: 'insertMarkdown', text: 'hello' } },
        ]);
    });

    it('defaults kind to answer and tolerates missing arrays', async () => {
        const { captured, msg } = await runPresent({ kind: undefined, markdown: 'hi' });
        expect(captured.kind).toBe('answer');
        expect(captured.payload).toEqual({ text: 'hi' });
        expect(typeof msg).toBe('string');
        expect(msg).toContain('present');
    });
});
