// officeHandlers — Office documents as first-class agent material.
//
// Thin wrappers over the Rust office commands. Real projects keep their specs
// and data in .xlsx/.docx/.pptx; read_file returns binary garbage for those, so
// without these the agent is blind to most of a project's actual content.

import { invoke } from '@tauri-apps/api/core';

/** read_office — .xlsx/.xls/.ods/.docx/.pptx → Markdown the model can read. */
export async function handleReadOffice(ctx, args, onAgentStatus, resolvedPath) {
    const path = resolvedPath || (ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path);
    if (!path) return "Error: read_office requires a 'path' parameter.";
    const sheet = typeof args?.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : null;
    const wantImages = args?.include_images === true;
    const wantFormat = args?.with_format === true;
    onAgentStatus?.(`Reading Office document: ${path}${sheet ? ` [${sheet}]` : ''}...`);
    try {
        const doc = await invoke('read_office_document', {
            path,
            maxChars: Number.isFinite(args?.max_chars) ? args.max_chars : null,
            sheet,
            includeImages: wantImages,
            withFormat: wantFormat,
        });
        ctx.onToolEvent?.('read_office', { path, kind: doc.kind, sheet });

        const header = `# ${path}${sheet ? ` — sheet "${sheet}"` : ''}\n(${doc.kind}${doc.parts?.length ? ' — ' + doc.parts.join(', ') : ''})\n`;
        const note = doc.truncated
            ? `\n\n[!] 長いため途中で打ち切りました。sheet="名前" で1シートずつ読むか、max_chars を上げてください。`
            : '';

        // Images can't ride back inside a tool result — park them for the agent
        // loop to attach to the next request.
        let imageNote = '';
        const images = Array.isArray(doc.images) ? doc.images : [];
        if (images.length) {
            for (const img of images) {
                ctx.pendingImages?.push({
                    data: `data:${img.mime};base64,${img.data}`,
                    source: `${path}:${img.name}`,
                });
            }
            imageNote = `\n\n[${images.length} image(s) extracted: ${images.map(i => i.name).join(', ')}. `
                + `They are attached to the NEXT message — describe what they show before relying on them.]`;
        } else if (wantImages) {
            imageNote = `\n\n[No usable embedded images found. Vector art (EMF/WMF) and icons below the size floor are skipped.]`;
        }

        // The formatting summary goes AFTER the values: the data is what was
        // asked for, and the format is context for changing it.
        const formatNote = doc.format
            ? '\n\n## 書式\n\n' + doc.format
            : '';
        return header + doc.text + note + formatNote + imageNote;
    } catch (e) {
        return `Error: read_office failed — ${e?.message || e}`;
    }
}

/**
 * append_xlsx_row — one more line on a table, formatted like the line above.
 *
 * Separate from update_xlsx because the row number is not something the caller
 * can know: it is wherever the sheet currently ends. `{row}` in a formula is
 * substituted on the Rust side once that number is known.
 */
export async function handleAppendXlsxRow(ctx, args, onConfirm, onAgentStatus) {
    const path = ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path;
    if (!path) return "Error: append_xlsx_row requires a 'path' parameter.";
    const values = args?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
        return 'Error: append_xlsx_row requires "values": an object keyed by column letter, e.g. {"A": "ワッシャー", "B": 50, "D": "=B{row}*C{row}"}.';
    }
    const sheet = typeof args?.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : null;

    const ok = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: `append_xlsx_row ${path}`,
        message: `AI wants to append a row to:\n\n${path}${sheet ? ` [${sheet}]` : ''}\n` + Object.entries(values).map(([k, v]) => `  ${k}: ${v}`).join('\n'),
    });
    if (!ok) return 'Error: append_xlsx_row denied by user.';

    onAgentStatus?.(`Appending a row to: ${path}...`);
    try {
        const msg = await invoke('append_xlsx_row', { path, sheet, values });
        ctx._recordModification?.(path, null, '(xlsx append)');
        ctx.onToolEvent?.('file_modified', { path, action: 'modify', diff: `~ ${msg}` });
        return msg;
    } catch (e) {
        return `Error: append_xlsx_row failed — ${e?.message || e}`;
    }
}

/**
 * Accept the shapes a model actually produces, not only the documented one.
 *
 * Three arrive often enough to be worth meeting, and every one of them was
 * costing a run several steps of guesswork:
 *
 *   sheets as a STRING — the XML tool-call form carries every parameter as
 *     text, so a JSON array reaches us as its source. Array.isArray said no and
 *     the caller was told `sheets` was missing while looking at a request that
 *     plainly contained it.
 *
 *   overwrite as "True" — Python spelling, and `=== true` is false for it.
 *
 *   rows keyed by COLUMN LETTER — [{ "A": …, "B": … }] instead of [[…, …]].
 *     Unambiguous, arguably nicer for a sparse row, and rejected outright. The
 *     model corrected itself to the array form and then produced the object
 *     form again on the next call, which is what "繰り返し失敗" looks like.
 *
 * Normalising is not leniency for its own sake: each of these has exactly one
 * reading, so refusing them buys nothing and costs a round trip.
 */
export function normalizeSheetsArg(raw) {
    let sheets = raw;
    if (typeof sheets === 'string') {
        try {
            sheets = JSON.parse(sheets);
        } catch (_) {
            return null;
        }
    }
    if (!Array.isArray(sheets) || sheets.length === 0) return null;

    return sheets.map((sheet) => {
        if (!sheet || typeof sheet !== 'object') return sheet;
        let rows = sheet.rows;
        if (typeof rows === 'string') {
            try { rows = JSON.parse(rows); } catch (_) { return sheet; }
        }
        if (!Array.isArray(rows)) return { ...sheet, rows };

        // Column-letter rows → positional. Widened to the longest row so a
        // sparse one does not shift the columns after it.
        const looksKeyed = rows.some(r => r && !Array.isArray(r) && typeof r === 'object');
        if (!looksKeyed) return { ...sheet, rows };

        const index = (letters) => {
            let n = 0;
            for (const ch of String(letters).toUpperCase()) {
                if (ch < 'A' || ch > 'Z') return -1;
                n = n * 26 + (ch.charCodeAt(0) - 64);
            }
            return n - 1;
        };
        const converted = rows.map((r) => {
            if (Array.isArray(r)) return r;
            if (!r || typeof r !== 'object') return [r];
            const out = [];
            for (const [k, v] of Object.entries(r)) {
                const i = index(k);
                if (i < 0) continue;              // not a column letter — drop it
                while (out.length < i) out.push(null);
                out[i] = v;
            }
            return out;
        });
        return { ...sheet, rows: converted };
    });
}

/** "True" / "1" / true → true. Anything else → false. */
export function truthyArg(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') return /^(true|1|yes)$/i.test(v.trim());
    return false;
}

/** write_xlsx — produce a spreadsheet deliverable. */
export async function handleWriteXlsx(ctx, args, onConfirm, onAgentStatus) {
    const path = ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path;
    if (!path) return "Error: write_xlsx requires a 'path' parameter.";
    const sheets = normalizeSheetsArg(args?.sheets);
    if (!sheets) {
        // Say what ARRIVED. "requires sheets" while the request visibly contains
        // sheets reads as the tool being broken, and sends the model looking for
        // a mistake somewhere else entirely.
        const got = args?.sheets === undefined
            ? 'nothing'
            : `${typeof args.sheets}: ${JSON.stringify(args.sheets).slice(0, 200)}`;
        return 'Error: write_xlsx could not read "sheets". Got ' + got + '.' + '\n'
            + 'Expected: [{ name?, rows: [["A1","B1"], ["A2","B2"]], design?, styles? }]. '
            + 'Rows may also be keyed by column letter — [{"A": "A1", "B": "B1"}] — and the '
            + 'whole array may arrive as a JSON string; both are accepted. What is not '
            + 'accepted is an empty array or JSON that does not parse.';
    }
    // Guard against malformed sheet structures before spending a confirmation.
    const badSheet = sheets.findIndex(s => !s || !Array.isArray(s.rows) || s.rows.length === 0);
    if (badSheet >= 0) {
        return `Error: write_xlsx sheet ${badSheet} has no "rows" array (each sheet needs at least one row). Got ${JSON.stringify(sheets[badSheet])}`;
    }
    // Writing a file is a mutation — same confirmation path as write_file.
    const ok = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: `write_xlsx ${path}`,
        message: `AI wants to write a spreadsheet:\n\n${path}\nSheets: ${sheets.map(s => s.name || '(unnamed)').join(', ')}`,
    });
    if (!ok) return 'Error: write_xlsx denied by user.';

    onAgentStatus?.(`Writing spreadsheet: ${path}...`);
    try {
        const msg = await invoke('write_xlsx', {
            path, sheets,
            overwrite: truthyArg(args?.overwrite),
            preset: typeof args?.preset === 'string' ? args.preset : null,
        });
        // An explicit overwrite is the user's intent coming through, so an
        // earlier refusal on this path no longer stands.
        if (truthyArg(args?.overwrite)) ctx._clearRefusedReplace?.(path);
        ctx._recordModification?.(path, null, '(xlsx)');
        ctx.onToolEvent?.('file_modified', { path, action: 'create', diff: `+ ${msg}` });
        return msg;
    } catch (e) {
        const text = String(e?.message || e);
        // The overwrite guard declined. Remember it: the refusal protects the
        // FILE, not this one call, and the obvious way round it is to delete the
        // file and start again. docs/design/tool-failure-policy.md §2 C.
        if (/already exists/.test(text)) {
            ctx._noteRefusedReplace?.(path, 'write_xlsx refused to replace it');
        }
        return `Error: write_xlsx failed — ${text}`;
    }
}

/**
 * write_docx — produce a Word document.
 *
 * The point of this tool is that "here is some Markdown, convert it yourself" is not
 * a deliverable in the environments this product targets.
 */
export async function handleWriteDocx(ctx, args, onConfirm, onAgentStatus) {
    const path = ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path;
    if (!path) return "Error: write_docx requires a 'path' parameter.";
    const markdown = typeof args?.markdown === 'string' ? args.markdown : '';
    if (!markdown.trim()) {
        return 'Error: write_docx requires "markdown" — the document body as light Markdown (# headings, - lists, **bold**).';
    }
    // Writing a file is a mutation — same confirmation path as write_file.
    const ok = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: `write_docx ${path}`,
        message: `AI wants to write a Word document:\n\n${path}\n${markdown.length} characters`,
    });
    if (!ok) return 'Error: write_docx denied by user.';

    onAgentStatus?.(`Writing document: ${path}...`);
    try {
        const msg = await invoke('write_docx', { path, markdown });
        ctx._recordModification?.(path, null, '(docx)');
        ctx.onToolEvent?.('file_modified', { path, action: 'create', diff: `+ ${msg}` });
        return msg;
    } catch (e) {
        return `Error: write_docx failed — ${e?.message || e}`;
    }
}

/**
 * update_xlsx — edit an existing workbook in place.
 *
 * Distinct from write_xlsx on purpose. Rebuilding a workbook to change one cell
 * discards its formulas, its formatting and every sheet the agent did not write —
 * for a ledger or a form, that is data loss presented as an edit. The confirmation
 * names the cells, because "AI wants to modify your workbook" is not enough for the
 * user to judge.
 */
export async function handleUpdateXlsx(ctx, args, onConfirm, onAgentStatus) {
    const path = ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path;
    if (!path) return "Error: update_xlsx requires a 'path' parameter.";
    const edits = Array.isArray(args?.edits) ? args.edits : null;
    if (!edits || edits.length === 0) {
        return 'Error: update_xlsx requires "edits": [{ sheet?, cell: "D14", value?, style? }]. Use read_office first — it prints the column letters and row numbers.';
    }
    const bad = edits.findIndex(e => !e || typeof e.cell !== 'string' || !/^[A-Za-z]+[0-9]+$/.test(e.cell.trim()));
    if (bad >= 0) {
        return `Error: update_xlsx edit ${bad} has no valid A1 cell address (got ${JSON.stringify(edits[bad]?.cell)}). Addresses look like "D14".`;
    }
    const empty = edits.findIndex(e => e.value === undefined && !e.style);
    if (empty >= 0) {
        return `Error: update_xlsx edit ${empty} changes nothing — give it a "value" or a "style" (got ${JSON.stringify(edits[empty])}).`;
    }

    const preview = edits.slice(0, 8)
        .map(e => {
            const where = `${e.sheet ? `${e.sheet}!` : ''}${e.cell}`;
            const bits = [];
            if (e.value !== undefined) bits.push(`= ${JSON.stringify(e.value)}`);
            if (e.style) bits.push(`style ${JSON.stringify(e.style)}`);
            return `${where} ${bits.join(' ')}`;
        })
        .join('\n');
    const more = edits.length > 8 ? `\n… and ${edits.length - 8} more` : '';
    const ok = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: `update_xlsx ${path}`,
        message: `AI wants to edit ${edits.length} cell(s) in an existing workbook:\n\n${path}\n\n${preview}${more}`,
    });
    if (!ok) return 'Error: update_xlsx denied by user.';

    onAgentStatus?.(`Updating workbook: ${path}...`);
    try {
        const msg = await invoke('update_xlsx', { path, edits });
        ctx._recordModification?.(path, null, '(xlsx edit)');
        ctx.onToolEvent?.('file_modified', { path, action: 'modify', diff: `~ ${msg}` });
        return msg;
    } catch (e) {
        return `Error: update_xlsx failed — ${e?.message || e}`;
    }
}
