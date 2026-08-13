// toolSets — the semantic groups that mode presets and sub-agent roles build
// their allowlists from.
//
// These lists used to be duplicated: once in AgentModes.js and once in
// SubagentRoles.js. Every tool added since — symbol_search, read_office,
// write_xlsx, the resource tools — was wired into the dispatcher and the
// schemas but never into either list. The visible symptom was an agent trying
// to parse a spreadsheet through `run_command` (PowerShell/python) because
// `read_office` was not among the tools it had been given, while `run_command`
// was. Defining the groups once removes the second place to forget.
//
// A name here is a REQUEST, not a guarantee: the executor still applies the
// permission model and the group gates (browser/git/resources), so listing
// `read_resource` costs nothing when no app publishes resources.

/** Inspection only — nothing here can change a file. */
export const READ_TOOLS = [
    'read_file',
    'list_files',
    'grep_search',
    'glob',
    'symbol_search',
    // "What depends on this file" — reads the studied index, changes nothing.
    'code_deps',
    // Office documents are unreadable via read_file (binary), so an agent
    // without this one has no choice but to shell out.
    'read_office',
    // Live documents published by a connected app; hidden by the group gate
    // when there are none.
    'list_resources',
    'read_resource',
    'verify_syntax',
    // Included on purpose: the command policy auto-approves read-only commands
    // (git diff, ls) and prompts for the rest.
    'run_command',
];

/** Mutating file tools — subject to write-scope enforcement. */
export const EDIT_TOOLS = [
    'write_file',
    'multi_replace_file_content',
    'replace_lines',
    'delete_file',
    'move_file',
];

/**
 * Produces a document rather than editing source.
 *
 * `update_xlsx` sits here too: it edits an existing workbook, but the thing it
 * produces is a deliverable, not project source — and a general (non-code) task has
 * to be able to update a ledger without being handed the code-editing toolset.
 */
export const OUTPUT_TOOLS = ['write_xlsx', 'write_docx', 'update_xlsx'];

export const WEB_TOOLS = ['fetch_url', 'web_search'];

/** Loop control every preset needs. */
export const TASK_TOOLS = ['task_progress', 'finish_task'];

/** De-duplicated union, order preserved. */
export function toolsOf(...groups) {
    return [...new Set(groups.flat())];
}
