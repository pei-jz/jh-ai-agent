import { describe, it, expect, vi } from 'vitest';

// agentMetaHandlers imports invoke from the Tauri bridge at module load; mock it
// (handlePresentResult itself only uses ctx.onToolEvent).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { handlePresentResult, handleAskUser, coerceStringArray, coerceBool } = await import('../agentMetaHandlers.js');

describe('coerceStringArray — lenient list args', () => {
    it('passes a real array through, trimmed and compacted', () => {
        expect(coerceStringArray(['a', ' b ', '', null])).toEqual(['a', 'b']);
    });
    it('parses a JSON-array STRING (what the model actually sent)', () => {
        expect(coerceStringArray('["案1: F6トグル", "案2: ZoomIt"]')).toEqual(['案1: F6トグル', '案2: ZoomIt']);
    });
    it('falls back to newline separation', () => {
        expect(coerceStringArray('案1\n案2\n')).toEqual(['案1', '案2']);
    });
    it('falls back to comma separation', () => {
        expect(coerceStringArray('yes,no')).toEqual(['yes', 'no']);
    });
    it('prefers newlines so option text may contain commas', () => {
        expect(coerceStringArray('A, with comma\nB')).toEqual(['A, with comma', 'B']);
    });
    it('a lone string becomes a single option', () => {
        expect(coerceStringArray('only')).toEqual(['only']);
    });
    it('empty / non-string → []', () => {
        expect(coerceStringArray('')).toEqual([]);
        expect(coerceStringArray(null)).toEqual([]);
        expect(coerceStringArray(undefined)).toEqual([]);
        expect(coerceStringArray(42)).toEqual([]);
    });
});

describe('coerceBool — lenient boolean args', () => {
    it('handles real booleans', () => {
        expect(coerceBool(true)).toBe(true);
        expect(coerceBool(false)).toBe(false);
    });
    it('handles Python-style strings (the "False" is truthy trap)', () => {
        expect(coerceBool('False')).toBe(false);
        expect(coerceBool('True')).toBe(true);
    });
    it('handles common string forms', () => {
        expect(coerceBool('true')).toBe(true);
        expect(coerceBool('yes')).toBe(true);
        expect(coerceBool('1')).toBe(true);
        expect(coerceBool('no')).toBe(false);
        expect(coerceBool('')).toBe(false);
    });
    it('null/undefined → false', () => {
        expect(coerceBool(null)).toBe(false);
        expect(coerceBool(undefined)).toBe(false);
    });
});

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

    it('falls back to content/md/text when the model mislabels the body arg', async () => {
        // Some models (e.g. Xiaomi MiMo) emit the body under `content` (matching
        // write_file) instead of the schema's `markdown` — must not yield empty.
        const viaContent = await runPresent({ kind: 'markdown', content: '## Table', summary: null });
        expect(viaContent.captured.payload).toEqual({ md: '## Table' });

        const viaMd = await runPresent({ kind: 'markdown', md: '## Md', summary: null });
        expect(viaMd.captured.payload).toEqual({ md: '## Md' });

        // markdown wins when several are present.
        const both = await runPresent({ kind: 'markdown', markdown: 'win', content: 'lose' });
        expect(both.captured.payload).toEqual({ md: 'win' });
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

describe('handleAskUser — pause-for-clarification exit', () => {
    function makeCtx() {
        const events = [];
        return {
            _awaitingUser: false,
            _userQuestion: '',
            onToolEvent: (event, data) => events.push({ event, data }),
            events,
        };
    }

    it('sets the awaiting-user flag and stores the question', async () => {
        const ctx = makeCtx();
        const msg = await handleAskUser(ctx, { question: 'Which design phase?', context: null }, () => {});
        expect(ctx._awaitingUser).toBe(true);
        expect(ctx._userQuestion).toBe('Which design phase?');
        expect(msg).toContain('pause');
        expect(ctx.events.find(e => e.event === 'ask_user')).toBeTruthy();
    });

    it('appends context to the stored question when provided', async () => {
        const ctx = makeCtx();
        await handleAskUser(ctx, { question: 'Proceed?', context: 'I already read main.js.' }, () => {});
        expect(ctx._userQuestion).toBe('Proceed?\n\nI already read main.js.');
    });

    it('rejects an empty question without pausing the run', async () => {
        const ctx = makeCtx();
        const msg = await handleAskUser(ctx, { question: '   ', context: null }, () => {});
        expect(ctx._awaitingUser).toBe(false);
        expect(msg).toMatch(/^Error:/);
    });

    it('surfaces options given as a real array', async () => {
        const ctx = makeCtx();
        await handleAskUser(ctx, { question: 'Which?', context: null, options: ['A', 'B'], multi_select: false }, () => {});
        expect(ctx._userQuestionOptions).toEqual(['A', 'B']);
        expect(ctx._userQuestionMulti).toBe(false);
        expect(ctx.events.find(e => e.event === 'ask_user').data.options).toEqual(['A', 'B']);
    });

    // Regression: the model sent options as a JSON STRING and multi_select as
    // "False"; the old strict checks dropped both, so the UI showed a plain
    // free-text ask instead of the choices ("Ask内容がTaskViewに表示されない").
    it('surfaces options given as a JSON string, and "False" stays false', async () => {
        const ctx = makeCtx();
        await handleAskUser(ctx, {
            question: 'どの案で対応しますか？',
            context: null,
            options: '["案1: F6トグル切替", "案2: ZoomItスタイル", "案3: ツールバー専用ウィンドウ"]',
            multi_select: 'False',
        }, () => {});
        expect(ctx._userQuestionOptions).toEqual(['案1: F6トグル切替', '案2: ZoomItスタイル', '案3: ツールバー専用ウィンドウ']);
        expect(ctx._userQuestionMulti).toBe(false);
        expect(ctx.events.find(e => e.event === 'ask_user').data.options).toHaveLength(3);
    });

    it('multi_select "True" with options enables multi-select', async () => {
        const ctx = makeCtx();
        await handleAskUser(ctx, { question: 'Pick', context: null, options: '["A","B"]', multi_select: 'True' }, () => {});
        expect(ctx._userQuestionMulti).toBe(true);
    });

    it('multi_select without options stays false (nothing to multi-pick)', async () => {
        const ctx = makeCtx();
        await handleAskUser(ctx, { question: 'Pick', context: null, options: null, multi_select: 'True' }, () => {});
        expect(ctx._userQuestionOptions).toEqual([]);
        expect(ctx._userQuestionMulti).toBe(false);
    });
});
