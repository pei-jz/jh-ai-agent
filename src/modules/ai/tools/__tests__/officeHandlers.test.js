// The agent-facing half of Office support: what the model gets back, and how an
// extracted image reaches the vision path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { handleReadOffice, handleWriteXlsx } = await import('../handlers/officeHandlers.js');

const ctx = () => ({
    resolvePath: (p) => p,
    onToolEvent: vi.fn(),
    pendingImages: [],
    _recordModification: vi.fn(),
    _confirmUnsafe: vi.fn(async () => true),
});

const doc = (over = {}) => ({
    text: 'BODY', kind: 'xlsx', parts: ['Sheet1'], truncated: false, images: [], ...over,
});

beforeEach(() => invoke.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('read_office — arguments', () => {
    it('requires a path', async () => {
        expect(await handleReadOffice(ctx(), {})).toContain("requires a 'path'");
        expect(invoke).not.toHaveBeenCalled();
    });

    it('passes sheet and include_images through to the backend', async () => {
        invoke.mockResolvedValue(doc());
        await handleReadOffice(ctx(), { path: 'a.xlsx', sheet: 'Summary', include_images: true, max_chars: 500 });
        expect(invoke).toHaveBeenCalledWith('read_office_document', {
            path: 'a.xlsx', maxChars: 500, sheet: 'Summary', includeImages: true,
        });
    });

    it('normalizes an absent or blank sheet to null rather than an empty string', async () => {
        invoke.mockResolvedValue(doc());
        await handleReadOffice(ctx(), { path: 'a.xlsx', sheet: '   ' });
        expect(invoke.mock.calls[0][1].sheet).toBe(null);

        invoke.mockClear();
        await handleReadOffice(ctx(), { path: 'a.xlsx' });
        expect(invoke.mock.calls[0][1]).toMatchObject({ sheet: null, includeImages: false, maxChars: null });
    });

    it('names the sheet in the header so the result is self-describing', async () => {
        invoke.mockResolvedValue(doc());
        const out = await handleReadOffice(ctx(), { path: 'a.xlsx', sheet: 'Summary' });
        expect(out).toContain('# a.xlsx — sheet "Summary"');
        expect(out).toContain('(xlsx — Sheet1)');
    });

    it('points at per-sheet reads when the document was cut short', async () => {
        invoke.mockResolvedValue(doc({ truncated: true }));
        const out = await handleReadOffice(ctx(), { path: 'a.xlsx' });
        expect(out).toContain('sheet=');
    });

    it('reports a backend failure instead of throwing into the loop', async () => {
        invoke.mockRejectedValue(new Error('No sheet named "X". Available sheets: A, B'));
        const out = await handleReadOffice(ctx(), { path: 'a.xlsx', sheet: 'X' });
        expect(out).toContain('Error: read_office failed');
        expect(out).toContain('Available sheets: A, B');
    });
});

describe('read_office — images', () => {
    it('queues extracted images for the loop to attach, as data URLs', async () => {
        invoke.mockResolvedValue(doc({
            images: [{ name: 'xl/media/image1.png', mime: 'image/png', data: 'AAAA' }],
        }));
        const c = ctx();
        const out = await handleReadOffice(c, { path: 'a.xlsx', include_images: true });

        expect(c.pendingImages).toEqual([{
            data: 'data:image/png;base64,AAAA',
            source: 'a.xlsx:xl/media/image1.png',
        }]);
        // The model must know they are coming on the NEXT turn, not this one.
        expect(out).toContain('1 image(s) extracted');
        expect(out).toContain('NEXT message');
    });

    it('queues nothing when images were not requested', async () => {
        invoke.mockResolvedValue(doc());
        const c = ctx();
        const out = await handleReadOffice(c, { path: 'a.xlsx' });
        expect(c.pendingImages).toEqual([]);
        expect(out).not.toContain('image(s) extracted');
    });

    it('explains an empty result when images WERE requested', async () => {
        invoke.mockResolvedValue(doc());
        const out = await handleReadOffice(ctx(), { path: 'a.pptx', include_images: true });
        expect(out).toContain('No usable embedded images');
    });
});

describe('write_xlsx', () => {
    it('rejects a call with no sheets, explaining the shape', async () => {
        const out = await handleWriteXlsx(ctx(), { path: 'o.xlsx', sheets: [] });
        expect(out).toContain('rows');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('does not write when the user declines', async () => {
        const c = ctx();
        c._confirmUnsafe = vi.fn(async () => false);
        const out = await handleWriteXlsx(c, { path: 'o.xlsx', sheets: [{ rows: [['a']] }] });
        expect(out).toContain('denied by user');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('writes and records the file as modified after confirmation', async () => {
        invoke.mockResolvedValue('Wrote o.xlsx (1 sheet(s), 1 rows)');
        const c = ctx();
        const out = await handleWriteXlsx(c, { path: 'o.xlsx', sheets: [{ name: 'S', rows: [['a']] }] });
        expect(out).toContain('Wrote o.xlsx');
        expect(c._recordModification).toHaveBeenCalledWith('o.xlsx', null, '(xlsx)');
    });
});
