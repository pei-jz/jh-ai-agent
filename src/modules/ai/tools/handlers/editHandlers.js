// editHandlers — file-mutating tool handlers extracted from ToolExecutor
// (Part A refactor). write_file / multi_replace_file_content / replace_lines.
//
// These are the most state-coupled handlers: each takes the ToolExecutor
// instance as `ctx` and uses its helpers/fields verbatim (resolvePath,
// _readFileSmart, _finalizeEdit, _handleMultiReplaceFailure, _isWriteAllowed,
// _allowApprovedPath, _recordModification, _bumpFileEditCount, _fileCache,
// _multiReplaceFailCount, onToolEvent). Behavior is identical to when the
// bodies lived inline in the executeTool switch — only `this` → `ctx`.
//
// Pure edit primitives (line-ending detection, occurrence counting, closest-
// region diff) live in ../FileEdit.js and are unit-tested there. This module is
// I/O glue (excluded from the unit-coverage gate).

import { invoke } from '@tauri-apps/api/core';
import {
    detectLineEnding, normalizeLE, countOccurrences, replaceAllLiteral,
    findClosestRegion, visualizeWS
} from '../FileEdit.js';

/**
 * write_file — create or fully overwrite a file, with read-before-overwrite
 * and large-file-full-rewrite guards.
 */
export async function handleWriteFile(ctx, args, onConfirm, onAgentStatus, resolvedPath) {
    let finalContent = args.content ?? '';
    const encoding = args.encoding || null;
    const isSafeRoot = ctx._isWriteAllowed(resolvedPath);
    let oldContent = "";
    let preExisting = false;
    try {
        oldContent = await invoke('read_file', { path: resolvedPath });
        preExisting = true; // read succeeded ⇒ file already exists
    } catch (e) { /* file doesn't exist — fine, this is a create */ }

    // ── Read-before-overwrite guard ─────────────────────────
    // If the file already exists but the agent has NEVER read it (or written it)
    // in this session, REFUSE the write unless overwrite_unread=true.
    // This is the same safety Claude Code's Write tool provides — it stops the
    // agent from accidentally clobbering a file whose contents it doesn't know.
    if (preExisting && !args.overwrite_unread) {
        const normPath = resolvedPath.replace(/\\/g, '/');
        const cached = ctx._fileCache?.get(normPath);
        const seenThisSession = !!(cached && (cached.readAt || cached.editedAt));
        if (!seenThisSession) {
            return `Error: write_file BLOCKED — ${resolvedPath} already exists but you have not read it in this session. ` +
                `Overwriting it would destroy content you haven't seen.\n` +
                `Choose one:\n` +
                `  1. Call read_file first, then retry write_file (recommended).\n` +
                `  2. If you intend to make a partial edit, use multi_replace_file_content instead.\n` +
                `  3. If you genuinely want to discard the existing content unseen, retry with overwrite_unread: true.`;
        }
    }

    // ── Large-file full-rewrite guard ──────────────────────
    // Modifying (not creating) a LARGE existing file by full
    // overwrite is the #1 source of silent corruption: the model
    // regenerates the whole file and drops lines/blocks. Block it
    // and steer to multi_replace_file_content. `allow_full_overwrite`
    // is the explicit escape hatch for a genuine complete rewrite.
    if (preExisting && !args.allow_full_overwrite) {
        const oldLen   = oldContent.length;
        const oldLines = oldContent.split('\n').length;
        const LARGE_CHARS = 8000;   // ~2K tokens
        const LARGE_LINES = 200;
        if (oldLen >= LARGE_CHARS || oldLines >= LARGE_LINES) {
            const newLen = String(finalContent).length;
            const shrinkPct = oldLen > 0 ? Math.round((1 - newLen / oldLen) * 100) : 0;
            return `Error: write_file BLOCKED — ${resolvedPath} is a large existing file ` +
                `(${oldLines} lines / ${oldLen} chars)${shrinkPct > 0 ? `, and the new content is ${shrinkPct}% smaller` : ''}. ` +
                `Full rewrites of large files routinely drop content (truncation / 文字欠落).\n` +
                `Do this instead:\n` +
                `  1. Use multi_replace_file_content with SMALL, targeted edits — pick a short, unique anchor ` +
                `(one or two lines) per change rather than re-sending the whole file. This is the reliable path.\n` +
                `  2. If multi_replace keeps failing to match, call read_file to refresh your view, then retry ` +
                `with an exact anchor copied verbatim.\n` +
                `  3. ONLY if you truly intend to replace the ENTIRE file and have its complete correct content, ` +
                `retry write_file with allow_full_overwrite: true.`;
        }
    }

    if (!isSafeRoot) {
        // Fail-closed: an outside-workspace write with no approval
        // channel is denied rather than silently performed.
        if (!onConfirm) {
            return `Error: write_file denied — ${resolvedPath} is outside the workspace and allowed write paths, and no approval channel is available.`;
        }
        const result = await onConfirm({
            type: 'diff_review',
            path: resolvedPath,
            newContent: args.content,
            oldContent: oldContent,
            message: `AI wants to write to file outside workspace:\nPath: ${resolvedPath}`
        });

        if (result === false || result === null) return "Error: User Denied file write.";
        if (typeof result === 'string') finalContent = result;
        await ctx._allowApprovedPath(resolvedPath);
    }

    onAgentStatus?.(`Writing file: ${resolvedPath}...`);
    await invoke('write_file', { path: resolvedPath, content: finalContent, encoding });

    ctx._recordModification(resolvedPath, oldContent, finalContent);
    ctx.onToolEvent?.('file_modified', { path: resolvedPath, action: 'write', diff: `- original\n+ modified` });
    // Auto-open in editor tab — replaces the now-deprecated open_file tool
    // so the LLM doesn't have to spend a step requesting the UI to show the edit.
    ctx.onToolEvent?.('open_file', { path: resolvedPath });

    // ── Session file cache update ──────────────────────────
    if (ctx._fileCache) {
        const normPath = resolvedPath.replace(/\\/g, '/');
        const existing = ctx._fileCache.get(normPath);
        ctx._fileCache.set(normPath, {
            content: finalContent,
            readCount: existing?.readCount || 0,
            readAt: existing?.readAt || null,
            editedAt: Date.now()
        });
    }

    // Track edit count + size for the same anti-loop signal that
    // multi_replace_file_content uses.
    const wfEditCount = ctx._bumpFileEditCount(resolvedPath);
    const wfOldLines = oldContent ? oldContent.split('\n').length : 0;
    const wfNewLines = finalContent.split('\n').length;
    let wfWarning = '';
    if (wfEditCount >= 5) {
        wfWarning = `\n[Warning] ${wfEditCount} edits to ${resolvedPath} in this session — if you're still iterating, are you sure the approach is right?`;
    }

    return `Success: File saved to ${resolvedPath}. (${wfOldLines} → ${wfNewLines} lines)${wfWarning}`;
}

/**
 * multi_replace_file_content — content-anchored search/replace edits with
 * fuzzy path correction, "did you mean?" diffs, and post-edit sanity checks.
 */
export async function handleMultiReplace(ctx, args, onConfirm, onAgentStatus) {
    onAgentStatus?.(`Editing file: ${ctx.resolvePath(args.path)}...`);

    // Read with fuzzy path auto-correction (Side.tsx → Sidebar.tsx).
    const mrRead = await ctx._readFileSmart(ctx.resolvePath(args.path));
    if (!mrRead.ok) return mrRead.error;
    const editPath = mrRead.path;
    const normPath = editPath.replace(/\\/g, '/');
    const pathNote = mrRead.note || '';
    let currentContent = mrRead.content;

    if (!args.replacements || !Array.isArray(args.replacements) || args.replacements.length === 0) {
        return `Error: 'replacements' array is required and must not be empty.`;
    }

    // ── Line-ending detection (Fix A) ─────────────────────
    // Windows files commonly use CRLF, but LLMs almost always
    // produce LF in their old_text. Bytewise-strict matching
    // would fail on every CRLF file. So: normalize BOTH sides
    // to LF for search/replace, and restore the file's original
    // line ending when we write back.
    // Line-ending detection + edit primitives → ../FileEdit.js (unit-tested).
    const fileLineEnding = detectLineEnding(currentContent);
    let workingContent = normalizeLE(currentContent);
    let appliedCount = 0;

    // Build a verbose "not found" error with a "did you mean?" diff.
    const buildNotFoundError = (i, origOldText) => {
        const normOld = normalizeLE(origOldText);
        const closest = findClosestRegion(workingContent, normOld);
        let hint = '';
        if (closest) {
            const expectedVis = visualizeWS(normOld.split('\n').slice(0, 8).join('\n'));
            const actualVis   = visualizeWS(closest.content.split('\n').slice(0, 8).join('\n'));
            hint =
                `\n\nClosest matching region (lines ${closest.startLine}-${closest.endLine}, ` +
                `~${Math.round(closest.score * 100)}% line similarity):\n` +
                `--- Your old_text (whitespace visualized: · = space, → = tab) ---\n${expectedVis}\n` +
                `--- File ACTUALLY contains ---\n${actualVis}\n\n` +
                `=== File region as-is (copy this verbatim) ===\n` +
                `${closest.content}\n` +
                `=== end ===\n` +
                `\nFix (recommended): instead of re-sending the whole block, pick the ONE line above ` +
                `that contains a unique identifier and use just that line (plus minimal context) as your ` +
                `old_text. Short, exact anchors succeed far more often than large multi-line blocks. ` +
                `Copy it character-for-character from the "File region as-is" section.`;
        } else {
            hint = `\n(No close match found — the file likely does not contain anything similar to your old_text. ` +
                `Call read_file to refresh your view of the file.)`;
        }
        return `Error: replacement[${i}]: old_text not found in ${editPath}. ` +
            `Cause is usually one of: ` +
            `(a) the file has changed since you last read it, ` +
            `(b) your old_text has different whitespace (tabs vs spaces / trailing whitespace), or ` +
            `(c) you copied a "<lineno>\\t" prefix from read_file output by accident.${hint}`;
    };

    for (let i = 0; i < args.replacements.length; i++) {
        const rep = args.replacements[i];

        if (typeof rep !== 'object' || rep === null) {
            return await ctx._handleMultiReplaceFailure(editPath, normPath,
                `Error: replacement[${i}] is not an object. Each entry must be { old_text, new_text }.`);
        }
        if (typeof rep.old_text !== 'string' || rep.old_text.length === 0) {
            return await ctx._handleMultiReplaceFailure(editPath, normPath,
                `Error: replacement[${i}] is missing required 'old_text' (must be a non-empty string).`);
        }
        if (rep.new_text === undefined || rep.new_text === null) {
            return await ctx._handleMultiReplaceFailure(editPath, normPath,
                `Error: replacement[${i}] is missing required 'new_text'. Pass "" (empty string) to delete.`);
        }

        // Normalize both sides to LF for matching (Fix A).
        const oldText    = normalizeLE(rep.old_text);
        const newText    = normalizeLE(String(rep.new_text));
        const replaceAll = rep.replace_all === true;

        if (replaceAll) {
            const count = countOccurrences(workingContent, oldText);
            if (count === 0) {
                return await ctx._handleMultiReplaceFailure(editPath, normPath,
                    buildNotFoundError(i, rep.old_text));
            }
            workingContent = replaceAllLiteral(workingContent, oldText, newText);
            appliedCount += count;
            continue;
        }

        // Uniqueness mode (default)
        const count = countOccurrences(workingContent, oldText);
        if (count === 0) {
            return await ctx._handleMultiReplaceFailure(editPath, normPath,
                buildNotFoundError(i, rep.old_text));
        }
        if (count > 1) {
            return await ctx._handleMultiReplaceFailure(editPath, normPath,
                `Error: replacement[${i}]: old_text matches ${count} times in ${editPath}. ` +
                `Each replacement must be unique — include 3-5 more lines of surrounding context to disambiguate, ` +
                `or set "replace_all": true if you intend to update every occurrence.` +
                `\n--- old_text preview (first 200 chars) ---\n${rep.old_text.slice(0, 200)}${rep.old_text.length > 200 ? '…' : ''}`);
        }

        // Exactly one match — safe to replace.
        const matchIdx = workingContent.indexOf(oldText);
        workingContent =
            workingContent.slice(0, matchIdx) +
            newText +
            workingContent.slice(matchIdx + oldText.length);
        appliedCount += 1;
    }

    // ── Success — reset failure counter for this file ──────
    ctx._multiReplaceFailCount.delete(normPath);

    // ── Restore original line ending before writing back ──
    const finalEditedContent = fileLineEnding === '\r\n'
        ? workingContent.replace(/\n/g, '\r\n')
        : workingContent;
    const isSafeRootEdit = ctx._isWriteAllowed(editPath);

    if (!isSafeRootEdit) {
        // Fail-closed: outside-workspace edit with no approval channel is denied.
        if (!onConfirm) {
            return `Error: multi_replace_file_content denied — ${editPath} is outside the workspace and allowed write paths, and no approval channel is available.`;
        }
        const res = await onConfirm({
            type: 'diff_review',
            path: editPath,
            newContent: finalEditedContent,
            oldContent: currentContent,
            message: `AI wants to write to file outside workspace:\nPath: ${editPath}`
        });

        if (res === false || res === null) return "Error: User Denied file write.";
        await ctx._allowApprovedPath(editPath);
        if (typeof res === 'string') {
            await invoke('write_file', { path: editPath, content: res });
            return `Success: User modified and saved to ${editPath}`;
        }
    }

    await invoke('write_file', { path: editPath, content: finalEditedContent });

    ctx._recordModification(editPath, currentContent, finalEditedContent);
    ctx.onToolEvent?.('file_modified', { path: editPath, action: 'edit', diff: `- original\n+ modified` });
    // Auto-open in editor tab so user sees the edit without an explicit open_file call.
    ctx.onToolEvent?.('open_file', { path: editPath });

    // ── Auto read-back & sanity check ────────────────────
    // The #1 cause of "agent corrupts file then doesn't notice" is that
    // multi_replace_file_content reports success without showing the
    // resulting content. Read the file back and surface the new content
    // plus a quick structural sanity check (bracket balance, line delta).
    // This makes corruption *visible* to the LLM in the very next turn.
    let verifiedContent = finalEditedContent;
    try {
        verifiedContent = await invoke('read_file', { path: editPath });
    } catch (_) {
        // If we can't re-read, fall through to the basic content we wrote.
    }

    // ── Session file cache update (use verified/read-back content) ──
    if (ctx._fileCache) {
        const normPath2 = editPath.replace(/\\/g, '/');
        const existing = ctx._fileCache.get(normPath2);
        ctx._fileCache.set(normPath2, {
            content: verifiedContent,
            readCount: existing?.readCount || 0,
            readAt: existing?.readAt || null,
            editedAt: Date.now()
        });
    }

    const editCount = ctx._bumpFileEditCount(editPath);
    const oldLines = currentContent.split('\n').length;
    const newLines = verifiedContent.split('\n').length;
    const lineDelta = newLines - oldLines;

    // Quick "obvious break" detector: balance braces, brackets, parens.
    const balance = (txt) => {
        const counts = { '{': 0, '}': 0, '[': 0, ']': 0, '(': 0, ')': 0 };
        // Naive scan — false positives in strings/comments are fine
        // (we're looking for catastrophic imbalance, not 100% accuracy).
        for (const ch of txt) if (counts[ch] !== undefined) counts[ch]++;
        return {
            braces: counts['{'] - counts['}'],
            brackets: counts['['] - counts[']'],
            parens: counts['('] - counts[')'],
        };
    };
    const before = balance(currentContent);
    const after = balance(verifiedContent);
    const warnings = [];
    if (Math.abs(after.braces) > Math.abs(before.braces) + 1) {
        warnings.push(`brace imbalance worsened (was ${before.braces}, now ${after.braces})`);
    }
    if (Math.abs(after.brackets) > Math.abs(before.brackets) + 1) {
        warnings.push(`bracket imbalance worsened (was ${before.brackets}, now ${after.brackets})`);
    }
    if (Math.abs(after.parens) > Math.abs(before.parens) + 1) {
        warnings.push(`paren imbalance worsened (was ${before.parens}, now ${after.parens})`);
    }

    // Same-file edit-count warning. If the LLM has been hammering one
    // file, that's almost always a signal the approach is wrong.
    let editCountWarning = '';
    if (editCount === 5) {
        editCountWarning = `\n[Warning] This is the 5th edit to ${editPath} in this session. If the file is getting tangled, consider doing ONE final write_file with the complete intended content instead of more multi_replace_file_content calls.`;
    } else if (editCount >= 8) {
        editCountWarning = `\n[Warning] ${editCount} edits to ${editPath} so far — STOP using multi_replace. Read the file once, then write_file the entire correct version.`;
    }

    // Truncate the readback so the LLM context doesn't explode on
    // huge files. The first 400 lines is usually enough to spot
    // obvious damage; the LLM can read_file for the rest if needed.
    const PREVIEW_LINES = 400;
    const previewLines = verifiedContent.split('\n').slice(0, PREVIEW_LINES);
    const truncated = newLines > PREVIEW_LINES;
    const preview = previewLines.join('\n') + (truncated ? `\n... [${newLines - PREVIEW_LINES} more lines truncated; call read_file if you need the rest]` : '');

    const warnBlock = warnings.length > 0
        ? `\n[Structural Warning] ${warnings.join('; ')}. The edit may have corrupted the file — INSPECT the content below and fix immediately if broken. Also call verify_syntax for .js/.ts/.json files.`
        : '';

    const opLabel = appliedCount === args.replacements.length
        ? `${appliedCount} replacement(s)`
        : `${appliedCount} replacement(s) from ${args.replacements.length} entry/entries`;
    return pathNote + `Success: Applied ${opLabel} to ${editPath}. ` +
        `(${oldLines} → ${newLines} lines, delta ${lineDelta >= 0 ? '+' : ''}${lineDelta})` +
        warnBlock + editCountWarning +
        `\n\n=== File content after edit (first ${Math.min(newLines, PREVIEW_LINES)} lines) ===\n${preview}`;
}

/**
 * replace_lines — line-range replacement guarded by mandatory first/last-line
 * anchor verification (stale line numbers can never clobber the wrong region).
 */
export async function handleReplaceLines(ctx, args, onConfirm, onAgentStatus) {
    onAgentStatus?.(`Editing lines: ${ctx.resolvePath(args.path)}...`);

    // Read with fuzzy path auto-correction.
    const rlRead = await ctx._readFileSmart(ctx.resolvePath(args.path));
    if (!rlRead.ok) return rlRead.error;
    const editPath = rlRead.path;
    const rlPathNote = rlRead.note || '';
    const currentContent = rlRead.content;

    const start = Number(args.start_line);
    const end   = Number(args.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return `Error: replace_lines requires integer start_line >= 1 and end_line >= start_line. ` +
            `Got start_line=${args.start_line}, end_line=${args.end_line}.`;
    }
    if (typeof args.new_text !== 'string') {
        return `Error: replace_lines requires 'new_text' (a string; use "" to delete the range).`;
    }
    if (typeof args.expected_first_line !== 'string' || typeof args.expected_last_line !== 'string') {
        return `Error: replace_lines requires 'expected_first_line' and 'expected_last_line' (the exact current text of the range's first/last lines) for safety. ` +
            `Call read_file first and copy them (without the "<lineno>\\t" prefix).`;
    }

    // Line-ending detection (same approach as multi_replace_file_content).
    const crlfCount = (currentContent.match(/\r\n/g) || []).length;
    const lfCount   = (currentContent.match(/(?<!\r)\n/g) || []).length;
    const fileLineEnding = crlfCount > lfCount ? '\r\n' : '\n';
    const lines = currentContent.replace(/\r\n/g, '\n').split('\n');

    if (end > lines.length) {
        return `Error: end_line ${end} exceeds file length (${lines.length} lines) in ${editPath}. ` +
            `Call read_file to refresh the line numbers, then retry.`;
    }

    // ── Anchor verification — the safety guard that makes line-based
    //    editing safe to coexist with content-based multi_replace.
    //    Stale line numbers can NEVER clobber the wrong region: if the
    //    first/last lines don't match what the caller expected, we
    //    refuse and return the current numbered region instead.
    const normLine = (s) => String(s).replace(/\r$/, '').replace(/\s+$/, '');
    const actualFirst = normLine(lines[start - 1] ?? '');
    const actualLast  = normLine(lines[end - 1] ?? '');
    const expFirst = normLine(args.expected_first_line);
    const expLast  = normLine(args.expected_last_line);

    if (actualFirst !== expFirst || actualLast !== expLast) {
        const ctxStart = Math.max(1, start - 2);
        const ctxEnd   = Math.min(lines.length, end + 2);
        const numWidth = String(ctxEnd).length;
        const ctxLines = lines.slice(ctxStart - 1, ctxEnd)
            .map((l, i) => `${String(ctxStart + i).padStart(numWidth, ' ')}\t${l}`)
            .join('\n');
        return `Error: replace_lines anchor mismatch in ${editPath} — your line numbers are STALE. ` +
            `Nothing was written (safety).\n` +
            `  line ${start}: expected "${expFirst}"\n           actual "${actualFirst}"\n` +
            `  line ${end}: expected "${expLast}"\n           actual "${actualLast}"\n\n` +
            `=== Current lines ${ctxStart}-${ctxEnd} (copy fresh numbers from here) ===\n${ctxLines}\n\n` +
            `Re-read the file (read_file) to confirm the range, then retry replace_lines.`;
    }

    // Splice in the replacement (empty new_text deletes the range).
    const newText  = String(args.new_text).replace(/\r\n/g, '\n');
    const newSeg   = newText === '' ? [] : newText.split('\n');
    lines.splice(start - 1, end - start + 1, ...newSeg);
    const workingContent = lines.join('\n');
    const finalEditedContent = fileLineEnding === '\r\n'
        ? workingContent.replace(/\n/g, '\r\n')
        : workingContent;

    const removed = end - start + 1;
    const opSummary = newText === ''
        ? `Deleted lines ${start}-${end} (${removed} line(s))`
        : `Replaced lines ${start}-${end} (${removed} → ${newSeg.length} line(s))`;

    return rlPathNote + await ctx._finalizeEdit(editPath, currentContent, finalEditedContent, onConfirm, opSummary);
}
