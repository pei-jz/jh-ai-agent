// The agent-facing half of Office support: what the model gets back, and how an
// extracted image reaches the vision path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { handleReadOffice, handleWriteXlsx, handleUpdateXlsx,
        normalizeSheetsArg, truthyArg } = await import('../handlers/officeHandlers.js');

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
            path: 'a.xlsx', maxChars: 500, sheet: 'Summary', includeImages: true, withFormat: false,
        });
    });

    // Formatting is the context an edit needs to match what is already there;
    // without it the model is inventing a format for a sheet it has only seen
    // the values of.
    it('asks for the formatting summary, and shows it under its own heading', async () => {
        invoke.mockResolvedValue({ ...doc(), format: '### シート "明細"\n- 列書式: C（金額）: #,##0"円" 右寄せ\n' });
        const out = await handleReadOffice(ctx(), { path: 'a.xlsx', with_format: true });
        expect(invoke).toHaveBeenCalledWith('read_office_document',
            expect.objectContaining({ withFormat: true }));
        expect(out).toContain('## 書式');
        expect(out).toContain('#,##0"円"');
    });

    it('says nothing about formatting when it was not asked for', async () => {
        invoke.mockResolvedValue(doc());
        const out = await handleReadOffice(ctx(), { path: 'a.xlsx' });
        expect(out).not.toContain('## 書式');
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

    it('rejects a sheet missing its rows array', async () => {
        const out = await handleWriteXlsx(ctx(), { path: 'o.xlsx', sheets: [{ name: 'S' }] });
        expect(out).toContain('no "rows"');
        expect(out).toContain('sheet 0');
        expect(invoke).not.toHaveBeenCalled();
    });

    // write_xlsx builds a workbook from scratch, so pointing it at a file that
    // exists replaces it whole. The refusal lives in Rust; what matters here is
    // that the model's snake_case flag reaches Tauri's camelCase parameter —
    // silently dropping it would mean the escape hatch never works.
    it('forwards an explicit overwrite', async () => {
        invoke.mockResolvedValue('ok');
        await handleWriteXlsx(ctx(), { path: 'o.xlsx', sheets: [{ rows: [['a']] }], overwrite: true });
        expect(invoke).toHaveBeenCalledWith('write_xlsx',
            expect.objectContaining({ overwrite: true }));
    });

    it('passes design and styles through to the backend', async () => {
        invoke.mockResolvedValue('Wrote o.xlsx (1 sheet(s), 2 rows)');
        const c = ctx();
        const sheets = [{
            name: 'S',
            rows: [[{ v: 'Title', style: 'title' }, ''], ['a', 1]],
            design: { merges: [{ from: 'A1', to: 'B1' }], col_widths: { A: 20 } },
            styles: { title: { bold: true } },
        }];
        await handleWriteXlsx(c, { path: 'o.xlsx', sheets });
        expect(invoke).toHaveBeenCalledWith('write_xlsx', { path: 'o.xlsx', sheets, overwrite: false, preset: null });
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

// The shapes a model actually sends.
//
// Each of these arrived from a real run and was rejected, and each has exactly
// one reading — so refusing them bought nothing and cost a round trip. The model
// corrected itself to the documented form and then produced the same shape again
// on the next call, which is what "it keeps failing" looked like from outside.
describe('what write_xlsx will accept', () => {
    it('takes sheets as a JSON STRING — the XML tool-call form sends text', () => {
        const s = normalizeSheetsArg('[{"name":"S1","rows":[["a","b"]]}]');
        expect(s).toEqual([{ name: 'S1', rows: [['a', 'b']] }]);
    });

    it('takes rows keyed by column letter', () => {
        const s = normalizeSheetsArg([{ rows: [{ A: 'a', B: 'b' }, { A: 'c', B: 'd' }] }]);
        expect(s[0].rows).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('keeps a sparse keyed row in its columns', () => {
        // A value in C must land in the third column, not the first.
        const s = normalizeSheetsArg([{ rows: [{ C: 'third' }] }]);
        expect(s[0].rows).toEqual([[null, null, 'third']]);
    });

    it('handles a two-letter column', () => {
        const s = normalizeSheetsArg([{ rows: [{ AA: 'x' }] }]);
        expect(s[0].rows[0]).toHaveLength(27);
        expect(s[0].rows[0][26]).toBe('x');
    });

    it('leaves the documented form untouched', () => {
        const rows = [['a', 'b'], ['c', 'd']];
        expect(normalizeSheetsArg([{ rows }])[0].rows).toEqual(rows);
    });

    it('refuses what genuinely cannot be read', () => {
        expect(normalizeSheetsArg('not json')).toBeNull();
        expect(normalizeSheetsArg([])).toBeNull();
        expect(normalizeSheetsArg(undefined)).toBeNull();
    });

    // "requires sheets" while the request visibly CONTAINS sheets reads as the
    // tool being broken, and sends the model looking somewhere else entirely.
    it('says what arrived when it still cannot read them', async () => {
        const out = await handleWriteXlsx(ctx(), { path: 'o.xlsx', sheets: 'not json' });
        expect(out).toMatch(/could not read/);
        expect(out).toMatch(/Got string/);
        expect(out).toMatch(/not json/);
    });

    it('takes a Python-spelled boolean for overwrite', () => {
        expect(truthyArg('True')).toBe(true);
        expect(truthyArg('true')).toBe(true);
        expect(truthyArg(true)).toBe(true);
        expect(truthyArg('False')).toBe(false);
        expect(truthyArg(undefined)).toBe(false);
    });

    it('forwards the coerced overwrite', async () => {
        invoke.mockResolvedValue('ok');
        await handleWriteXlsx(ctx(), {
            path: 'o.xlsx', sheets: [{ rows: [['a']] }], overwrite: 'True',
        });
        expect(invoke).toHaveBeenCalledWith('write_xlsx', expect.objectContaining({ overwrite: true }));
    });
});
