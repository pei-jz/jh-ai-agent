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
// Grouping alone did NOT stop the leak: `run_subtask` was later added to the
// schemas and the dispatcher and belonged to no group, so the whole sub-agent
// engine was invisible in `general` — the product's DEFAULT mode — and worked
// only if the user happened to pick `develop`. So every built-in must now
// belong to some group here, and `toolSets.test.js` fails the build when one
// does not. A group is not required to be USED by a preset (browser is not);
// it is required to EXIST, so adding a tool forces the question "who gets this?"
//
// A name here is a REQUEST, not a guarantee: the executor still applies the
// permission model and the group gates (browser/git/resources), so listing
// `read_resource` costs nothing when no app publishes resources.

/**
 * Inspection only — nothing here can change a file OR run a command.
 *
 * Separate from READ_TOOLS because "read-only" is a claim the sub-agent roles
 * make to the orchestrating model ("reviewer = read-only, never fixes"), and
 * `run_command` makes that claim false: a shell can write files. Roles that
 * advertise themselves as read-only build from THIS list.
 */
export const READ_ONLY_TOOLS = [
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
    // A skill is READ, never executed: running what one bundles goes through
    // run_command like any other shell call. So these belong with the readers,
    // and every role that can look at anything can consult a procedure.
    'read_skill',
    'read_skill_file',
    // Live documents published by a connected app; hidden by the group gate
    // when there are none.
    'list_resources',
    'read_resource',
    'verify_syntax',
    // Read-only VCS. Not in any preset before, so a `research` agent could not
    // answer "what changed" without shelling out to git through run_command —
    // and the reviewer role's own persona tells it to use `git diff`.
    'git_status',
    'git_diff',
    'git_log',
];

/**
 * Inspection, plus a shell.
 *
 * `run_command` is here rather than in READ_ONLY_TOOLS on purpose: the command
 * policy auto-approves genuinely read-only commands (git diff, ls) and prompts
 * for the rest, so an investigating agent is not blocked — but it CAN write, and
 * a group named "read-only" must not contain it.
 */
export const READ_TOOLS = [...READ_ONLY_TOOLS, 'run_command'];

/** Mutating file tools — subject to write-scope enforcement. */
export const EDIT_TOOLS = [
    'write_file',
    'multi_replace_file_content',
    'replace_lines',
    'apply_patch',
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
export const OUTPUT_TOOLS = ['write_xlsx', 'write_docx', 'update_xlsx', 'append_xlsx_row'];

export const WEB_TOOLS = ['fetch_url', 'web_search'];

/**
 * Loop control every preset needs.
 *
 * `open_question` is bookkeeping in the same sense `task_progress` is — it
 * records state about the RUN rather than touching the workspace — and it has to
 * reach every preset: the investigation it exists to deepen can happen in any of
 * them, not only in a mode called "research".
 */
export const TASK_TOOLS = ['task_progress', 'finish_task', 'open_question'];

/**
 * Termination / delivery / clarification. `setToolAllowlist` adds these
 * implicitly whenever `agentControl` is on, so a preset does not have to list
 * them — but they must belong to a group so the coverage test can see them.
 */
export const CONTROL_TOOLS = ['finish_task', 'present_result', 'ask_user'];

/** Spawning an isolated sub-agent. Parent runs only (no recursion). */
export const DELEGATION_TOOLS = ['run_subtask'];

/** The one MUTATING git tool — never bundled with the read-only three. */
export const VCS_WRITE_TOOLS = ['git_commit'];

/**
 * Headless-browser automation. Deliberately in NO preset: the group is gated on
 * Playwright actually being installed (tools/toolGroups.js), so advertising it
 * by default would offer tools that cannot run. Listed here so the coverage
 * test passes and so a preset CAN opt in.
 */
export const BROWSER_TOOLS = [
    'browser_navigate', 'browser_content', 'browser_click', 'browser_type',
    'browser_eval', 'browser_screenshot', 'browser_close',
];

/**
 * Every group, for the coverage test. A built-in that appears in none of these
 * is unreachable from every preset — which is how `run_subtask` went missing.
 */
export const ALL_GROUPS = [
    READ_ONLY_TOOLS, READ_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS,
    WEB_TOOLS, TASK_TOOLS, CONTROL_TOOLS, DELEGATION_TOOLS, VCS_WRITE_TOOLS,
    BROWSER_TOOLS,
];

/** De-duplicated union, order preserved. */
export function toolsOf(...groups) {
    return [...new Set(groups.flat())];
}
