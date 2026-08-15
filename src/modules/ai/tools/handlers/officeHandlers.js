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
    onAgentStatus?.(`Reading Office document: ${path}${sheet ? ` [${sheet}]` : ''}...`);
    try {
        const doc = await invoke('read_office_document', {
            path,
            maxChars: Number.isFinite(args?.max_chars) ? args.max_chars : null,
            sheet,
            includeImages: wantImages,
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

        return header + doc.text + note + imageNote;
    } catch (e) {
        return `Error: read_office failed — ${e?.message || e}`;
    }
}

/** write_xlsx — produce a spreadsheet deliverable. */
export async function handleWriteXlsx(ctx, args, onConfirm, onAgentStatus) {
    const path = ctx.resolvePath ? ctx.resolvePath(args?.path) : args?.path;
    if (!path) return "Error: write_xlsx requires a 'path' parameter.";
    const sheets = Array.isArray(args?.sheets) ? args.sheets : null;
    if (!sheets || sheets.length === 0) {
        return 'Error: write_xlsx requires "sheets": [{ name?, rows: [[cell, …], …], design?, styles? }]. The first row of each sheet is styled as a header by default.';
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
        const msg = await invoke('write_xlsx', { path, sheets });
        ctx._recordModification?.(path, null, '(xlsx)');
        ctx.onToolEvent?.('file_modified', { path, action: 'create', diff: `+ ${msg}` });
        return msg;
    } catch (e) {
        return `Error: write_xlsx failed — ${e?.message || e}`;
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
