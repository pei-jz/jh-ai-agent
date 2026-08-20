// chatAttachments — the file → attachment path, without a view.
//
// Extracted from ChatView.handleFileAttachment, where the three-way decision
// (image / spreadsheet / text) was nested inside a FileReader callback and pushed
// straight onto the view's array, so none of it could be exercised without a DOM.

import { describe, it, expect, vi } from 'vitest';
import { attachmentKind, readAttachment, filesPreamble, MAX_ATTACHMENT_BYTES } from '../chatAttachments.js';

/** A File stand-in: only the fields the module actually reads. */
const fileOf = (name, type = '', size = 10) => ({ name, type, size });

/** A FileReader stand-in that resolves with whatever it was primed with. */
function readerOf(result, { fail = false } = {}) {
    const calls = [];
    const reader = {
        result: null, error: fail ? new Error('read failed') : null,
        onload: null, onerror: null,
        _fire() {
            queueMicrotask(() => {
                if (fail) { reader.onerror?.(); return; }
                reader.result = result;
                reader.onload?.();
            });
        },
        readAsDataURL() { calls.push('dataURL'); reader._fire(); },
        readAsArrayBuffer() { calls.push('arrayBuffer'); reader._fire(); },
        readAsText() { calls.push('text'); reader._fire(); },
    };
    reader.calls = calls;
    return reader;
}

describe('attachmentKind', () => {
    it('routes by MIME for images and by extension for spreadsheets', () => {
        expect(attachmentKind(fileOf('shot.png', 'image/png'))).toBe('image');
        expect(attachmentKind(fileOf('book.xlsx'))).toBe('excel');
        expect(attachmentKind(fileOf('book.XLS'))).toBe('excel');
        expect(attachmentKind(fileOf('sheet.ods'))).toBe('excel');
        expect(attachmentKind(fileOf('notes.md', 'text/markdown'))).toBe('text');
        expect(attachmentKind(null)).toBe('none');
    });

    // A .xlsx carries a MIME type that is neither image/* nor text/*, so extension
    // is the only reliable signal — and a file NAMED like a spreadsheet but sent as
    // an image is still an image.
    it('prefers the image MIME over a misleading name', () => {
        expect(attachmentKind(fileOf('chart.xlsx.png', 'image/png'))).toBe('image');
    });
});

describe('readAttachment', () => {
    it('refuses a file over the cap rather than reading it', async () => {
        const reader = readerOf('x');
        const res = await readAttachment(fileOf('big.bin', '', MAX_ATTACHMENT_BYTES + 1), {
            invoke: vi.fn(), readerFor: () => reader,
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/too large/i);
        expect(reader.calls).toEqual([]);
    });

    it('splits an image into a data URL and its base64 payload', async () => {
        const res = await readAttachment(fileOf('a.png', 'image/png', 4), {
            invoke: vi.fn(),
            readerFor: () => readerOf('data:image/png;base64,QUJD'),
            newId: () => 'id1',
        });
        expect(res.ok).toBe(true);
        expect(res.attachment).toMatchObject({
            id: 'id1', type: 'image', dataUrl: 'data:image/png;base64,QUJD', base64: 'QUJD',
        });
    });

    it('sends a spreadsheet to Rust and keeps the HTML it returns', async () => {
        const invoke = vi.fn(async () => '<table><tr><td>1</td></tr></table>');
        const res = await readAttachment(fileOf('b.xlsx', '', 8), {
            invoke, readerFor: () => readerOf(new Uint8Array([1, 2, 3]).buffer),
        });
        expect(res.ok).toBe(true);
        expect(res.attachment.type).toBe('file');
        expect(res.attachment.content).toContain('<table>');
        expect(invoke).toHaveBeenCalledWith('parse_excel_to_html', { bytes: [1, 2, 3], ext: 'xlsx' });
    });

    it('reports a spreadsheet the backend could not parse', async () => {
        const res = await readAttachment(fileOf('b.xlsx', '', 8), {
            invoke: vi.fn(async () => { throw new Error('corrupt zip'); }),
            readerFor: () => readerOf(new Uint8Array([1]).buffer),
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/corrupt zip/);
    });

    it('keeps anything else as text', async () => {
        const res = await readAttachment(fileOf('log.txt', 'text/plain', 3), {
            invoke: vi.fn(), readerFor: () => readerOf('hello'),
        });
        expect(res.attachment).toMatchObject({ type: 'file', content: 'hello', dataUrl: null });
    });

    it('reports a read failure instead of attaching an empty file', async () => {
        const res = await readAttachment(fileOf('log.txt', 'text/plain', 3), {
            invoke: vi.fn(), readerFor: () => readerOf(null, { fail: true }),
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/read failed/);
    });
});

describe('filesPreamble', () => {
    it('is empty when nothing is attached', () => {
        expect(filesPreamble([])).toBe('');
        expect(filesPreamble(undefined)).toBe('');
    });

    it('fences each file under its name', () => {
        const out = filesPreamble([{ name: 'a.txt', content: 'one' }, { name: 'b.txt', content: 'two' }]);
        expect(out).toContain('[Attached File: a.txt]');
        expect(out).toContain('[Attached File: b.txt]');
        expect(out).toContain('one');
        expect(out).toContain('two');
        expect((out.match(/```/g) || []).length).toBe(4);
    });
});
