// RecoveryHints — PURE mapping from tool-execution errors to self-correction
// hints injected back into the agent. Extracted from AgentController (Phase 1).
// Note: these are *guidance* hints (not control flow) and always have a generic
// fallback, so loose substring matching here is acceptable.

/**
 * Hint for a single (already lowercased) error message.
 * @param {string} errMsgLower
 * @returns {string} a hint line (leading "\n")
 */
export function hintForError(errMsgLower) {
    const m = String(errMsgLower || '');
    if (m.includes('user denied') || m.includes('rejected') || m.includes('blocked')) {
        return `\n[Important] The user denied command/tool execution. DO NOT attempt the identical operation again. Pivot to an alternative approach or report to the user.`;
    }
    if (m.includes('not found') || m.includes('no such file')) {
        return `\n[Self-Correction Hint] File not found. Verify paths using list_files or grep_search.`;
    }
    if (m.includes('invalid line range') || m.includes('does not match') || m.includes('anchor mismatch') || m.includes('stale')) {
        return `\n[Self-Correction Hint] Line range / anchor does not match. Re-read the file using read_file to check current contents, then retry with exact text.`;
    }
    return `\n[Self-Correction Hint] Run verification checks after edits. If errors occur, update your plan and retry. Please bundle verifications after major changes rather than running tests after every single line edit.\n`;
}

/**
 * Build the combined recovery hint for a set of tool results.
 * @param {Array<{result?: any}>} results
 * @returns {string} concatenated hints ('' when no errors)
 */
export function buildRecoveryHint(results) {
    if (!Array.isArray(results)) return '';
    const errorResults = results.filter(r => typeof r?.result === 'string' && r.result.startsWith('Error'));
    let hint = '';
    for (const er of errorResults) {
        hint += hintForError(er.result.toLowerCase());
    }
    return hint;
}
