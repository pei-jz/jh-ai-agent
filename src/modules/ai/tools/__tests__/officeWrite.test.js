// write_docx / update_xlsx — the tool layer.
//
// The Rust side is unit-tested next to the implementation (docx XML shape, cell
// addresses, merged ranges). What matters here is the guard rails the agent hits
// FIRST: a refusal that says which argument is wrong, and a confirmation dialog that
// tells the user what is about to change.
//
// update_xlsx especially: it writes into a file the user already has. "AI wants to
// modify your workbook" is not enough for them to judge, so the prompt names cells.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async () => 'ok');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { handleWriteDocx, handleUpdateXlsx } = await import('../handlers/officeHandlers.js');

/** A tool context that approves by default and records what it was asked. */
const makeCtx = (approve = true) => {
    const confirms = [];
    return {
        confirms,
        resolvePath: (p) => p,
        _confirmUnsafe: async (_safe, _onConfirm, req) => { confirms.push(req); return approve; },
        _recordModification: vi.fn(),
        onToolEvent: vi.fn(),
    };
};

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async () => 'ok');
});

describe('write_docx', () => {
    it('writes the document and records the modification', async () => {
        const ctx = makeCtx();
        invoke.mockResolvedValue('Wrote C:/r.docx (5 paragraphs)');
        const out = await handleWriteDocx(ctx, { path: 'C:/r.docx', markdown: '# Report\n\nBody' });
        expect(invoke).toHaveBeenCalledWith('write_docx', { path: 'C:/r.docx', markdown: '# Report\n\nBody' });
        expect(out).toContain('5 paragraphs');
        expect(ctx._recordModification).toHaveBeenCalled();
        expect(ctx.onToolEvent).toHaveBeenCalledWith('file_modified', expect.objectContaining({ action: 'create' }));
    });

    it('names the missing argument rather than failing vaguely', async () => {
        expect(await handleWriteDocx(makeCtx(), { markdown: 'x' })).toContain("'path'");
        expect(await handleWriteDocx(makeCtx(), { path: 'C:/r.docx' })).toContain('markdown');
        expect(await handleWriteDocx(makeCtx(), { path: 'C:/r.docx', markdown: '   ' })).toContain('markdown');
    });

    it('does not write when the user declines', async () => {
        const out = await handleWriteDocx(makeCtx(false), { path: 'C:/r.docx', markdown: '# x' });
        expect(invoke).not.toHaveBeenCalled();
        expect(out).toContain('denied');
    });

    it('surfaces a backend failure instead of claiming success', async () => {
        invoke.mockRejectedValue(new Error('disk full'));
        const out = await handleWriteDocx(makeCtx(), { path: 'C:/r.docx', markdown: '# x' });
        expect(out).toContain('disk full');
        expect(out.startsWith('Error')).toBe(true);
    });
});

describe('update_xlsx', () => {
    const edits = [{ sheet: 'Data', cell: 'D14', value: 42 }];

    it('applies the edits', async () => {
        invoke.mockResolvedValue('Updated C:/b.xlsx (1 cell(s))');
        const out = await handleUpdateXlsx(makeCtx(), { path: 'C:/b.xlsx', edits });
        expect(invoke).toHaveBeenCalledWith('update_xlsx', { path: 'C:/b.xlsx', edits });
        expect(out).toContain('1 cell(s)');
    });

    it('marks the file MODIFIED, not created', async () => {
        const ctx = makeCtx();
        await handleUpdateXlsx(ctx, { path: 'C:/b.xlsx', edits });
        expect(ctx.onToolEvent).toHaveBeenCalledWith('file_modified', expect.objectContaining({ action: 'modify' }));
    });

    it('rejects a cell that is not an A1 address, saying which edit', async () => {
        // The agent gets one clear correction instead of a backend error per attempt.
        for (const bad of ['14D', 'D', '14', 'D 14', '', null]) {
            const out = await handleUpdateXlsx(makeCtx(), {
                path: 'C:/b.xlsx', edits: [{ cell: 'A1', value: 1 }, { cell: bad, value: 2 }],
            });
            expect(out, String(bad)).toContain('edit 1');
            expect(out, String(bad)).toContain('A1 cell address');
        }
        expect(invoke).not.toHaveBeenCalled();
    });

    it('accepts a multi-letter column and a lowercase address', async () => {
        await handleUpdateXlsx(makeCtx(), { path: 'C:/b.xlsx', edits: [{ cell: 'aa10', value: 1 }] });
        expect(invoke).toHaveBeenCalled();
    });

    it('points at read_office when no edits were given', async () => {
        const out = await handleUpdateXlsx(makeCtx(), { path: 'C:/b.xlsx', edits: [] });
        expect(out).toContain('read_office');
        expect(out).toContain('D14');
    });

    it('NAMES the cells in the confirmation — the user has to be able to judge', async () => {
        const ctx = makeCtx();
        await handleUpdateXlsx(ctx, {
            path: 'C:/b.xlsx',
            edits: [{ sheet: 'Data', cell: 'D14', value: 42 }, { cell: 'E1', value: '=SUM(A1:A9)' }],
        });
        const msg = ctx.confirms[0].message;
        expect(msg).toContain('C:/b.xlsx');
        expect(msg).toContain('Data!D14 = 42');
        expect(msg).toContain('E1 = "=SUM(A1:A9)"');
        expect(msg).toContain('2 cell(s)');
    });

    it('caps the preview but says how many more', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ cell: `A${i + 1}`, value: i }));
        const ctx = makeCtx();
        await handleUpdateXlsx(ctx, { path: 'C:/b.xlsx', edits: many });
        const msg = ctx.confirms[0].message;
        expect(msg).toContain('… and 4 more');
        expect(msg).toContain('12 cell(s)');
    });

    it('does not write when the user declines', async () => {
        const out = await handleUpdateXlsx(makeCtx(false), { path: 'C:/b.xlsx', edits });
        expect(invoke).not.toHaveBeenCalled();
        expect(out).toContain('denied');
    });

    it('surfaces a backend failure', async () => {
        invoke.mockRejectedValue(new Error('file is locked'));
        const out = await handleUpdateXlsx(makeCtx(), { path: 'C:/b.xlsx', edits });
        expect(out).toContain('file is locked');
    });
});
