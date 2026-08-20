// chatAttachments — turning a dropped or pasted file into something sendable.
//
// Extracted from ChatView.handleFileAttachment, which nested the decision (image
// / spreadsheet / text) inside a FileReader callback and pushed straight onto the
// view's array, so the branching could only be exercised by driving the DOM.

/** Anything larger than this is refused rather than sent. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const EXCEL_RE = /\.(xlsx|xlsm|xls|ods)$/i;

/** Which of the three paths a file takes. */
export function attachmentKind(file) {
    if (!file) return 'none';
    if (String(file.type || '').startsWith('image/')) return 'image';
    if (EXCEL_RE.test(String(file.name || ''))) return 'excel';
    return 'text';
}

/**
 * Read one file into an attachment.
 *
 * @param {File} file
 * @param {object} deps
 * @param {Function} deps.invoke        Tauri bridge (spreadsheets are parsed in Rust)
 * @param {Function} [deps.readerFor]   injectable FileReader factory, for tests
 * @param {Function} [deps.newId]
 * @returns {Promise<{ok:true, attachment:object}|{ok:false, reason:string}>}
 */
export async function readAttachment(file, { invoke, readerFor = () => new FileReader(), newId } = {}) {
    if (!file) return { ok: false, reason: 'No file.' };
    if (file.size > MAX_ATTACHMENT_BYTES) {
        return { ok: false, reason: 'File is too large (max 10MB).' };
    }

    const kind = attachmentKind(file);
    const raw = await new Promise((resolve, reject) => {
        const reader = readerFor();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        if (kind === 'image') reader.readAsDataURL(file);
        else if (kind === 'excel') reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
    }).catch(e => ({ __error: e }));

    if (raw && raw.__error) return { ok: false, reason: String(raw.__error.message || raw.__error) };

    const id = newId ? newId() : Math.random().toString(36).substring(7);
    const base = { id, name: file.name, size: file.size, dataUrl: null, base64: null, content: null };

    if (kind === 'image') {
        const dataUrl = String(raw);
        return { ok: true, attachment: { ...base, type: 'image', dataUrl, base64: dataUrl.split(',')[1] } };
    }

    if (kind === 'excel') {
        // A spreadsheet is unreadable as text; the Rust side turns it into HTML
        // the model can actually use.
        const ext = String(file.name).split('.').pop() || '';
        try {
            const content = await invoke('parse_excel_to_html', {
                bytes: Array.from(new Uint8Array(raw)), ext,
            });
            return { ok: true, attachment: { ...base, type: 'file', content } };
        } catch (err) {
            return { ok: false, reason: `Failed to parse Excel file: ${err.message || err}` };
        }
    }

    return { ok: true, attachment: { ...base, type: 'file', content: String(raw ?? '') } };
}

/** The block appended to the outgoing message for each non-image attachment. */
export function filesPreamble(files) {
    if (!files?.length) return '';
    return '\n\n' + files
        .map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\`\n`)
        .join('\n');
}
