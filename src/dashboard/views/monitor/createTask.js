// createTask — the one place a task is actually created.
//
// There are now two entries: the composer at the top of the list (the common
// case) and NewTaskModal (mode, MCP selection, attachments). LaunchPanel's file
// comment already named the hazard a second entry creates —
//
//   "a second creation path here would be the weaker of the two and would drift"
//
// — so the entries share this function rather than each assembling their own
// POST. What goes IN the body is still newTaskRequest.js; what this adds is the
// part with an ordering rule in it: checked MCP servers have to be running
// before the task starts, or its first turn sees a shorter tool list than the
// one the user selected.
//
// Everything external is injected so the rules can be tested without a server,
// an MCP manager or a DOM.
//
// docs/design/information-architecture.md §7 step 1.

import { mcpManager as defaultMcpManager } from '../../../modules/ai/McpManager.js';
import { taskPayload } from './newTaskRequest.js';

/**
 * Bring up every selected MCP server that is not already running.
 *
 * Best-effort by design: a server that refuses to start must not block the task.
 * The agent will simply run without that server's tools, which is the same
 * situation as the user not having selected it — whereas failing the create
 * loses the prompt they just typed.
 *
 * @returns {Promise<string[]>} the names that failed, for the caller to report.
 */
export async function startSelectedMcp(selectedMcp = [], servers = {}, mcp = defaultMcpManager) {
    const failed = [];
    for (const name of selectedMcp) {
        if (mcp.clients?.has?.(name)) continue;
        try {
            await mcp.startClient(name, servers[name]);
        } catch (e) {
            console.warn(`MCP start failed for ${name}:`, e);
            failed.push(name);
        }
    }
    return failed;
}

/**
 * Create a task and return its id.
 *
 * @param {object}   o
 * @param {string}   o.prompt        already expanded ("/" templates) and with
 *                                   attachment blocks appended, if any
 * @param {string}   o.workspace
 * @param {string}   o.modeId
 * @param {string[]} [o.selectedMcp] passed through EXPLICITLY, empty included —
 *                                   see taskBehavior for why that matters
 * @param {object}   [o.mcpServers]  config, only used to start what is selected
 * @param {string[]} [o.images]      data URLs
 * @param {string}   [o.caller]      shows in the task list
 * @param {string}   [o.interaction] 'ask' | 'build' — see agent/InteractionMode.js
 * @param {object}   o.client        apiClient
 * @param {object}   [o.mcp]         injectable McpManager
 * @returns {Promise<string>} the new task id
 */
export async function createTask({
    prompt, workspace, modeId, selectedMcp = [], mcpServers = {},
    images = [], caller = 'NewTask', interaction = 'build',
    chatContext = [],
    client, mcp = defaultMcpManager,
}) {
    await startSelectedMcp(selectedMcp, mcpServers, mcp);

    const res = await client.request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskPayload({
            prompt,
            workspace: String(workspace || '').trim(),
            modeId,
            selectedMcp,
            images,
            caller,
            interaction,
            chatContext,
        })),
    });
    // Remember the workspace we just ran in.
    //
    // The picker offers `approved_projects`, and that list only ever grew from
    // the folder picker in Settings and the first-run wizard. A workspace used
    // for an actual task — typed in, carried over from a template, handed in by
    // another app — was not on it, so the list stayed short while the task
    // history filled with workspaces that were not in it. Running somewhere IS
    // approving it, which is what the backend already has to believe to do the
    // work.
    //
    // Best-effort: the task is created either way, and failing to remember a
    // path must not fail the run.
    rememberWorkspace(workspace, client).catch(() => {});

    return res.task_id;
}

/** Append `ws` to approved_projects if it is not already there. */
export async function rememberWorkspace(ws, client) {
    const path = String(ws || '').trim();
    if (!path || !client?.getConfig || !client?.updateConfig) return false;

    const config = (await client.getConfig()) || {};
    const projects = Array.isArray(config.approved_projects) ? config.approved_projects : [];
    // Windows paths differ only by separator and case far too often for an
    // exact match to be the right test.
    const norm = (p) => String(p)
        .replace(/[\\/]+$/, '')          // trailing separators
        .replace(/\\/g, '/')             // backslashes
        .toLowerCase();                 // Windows is case-insensitive
    const same = (a, b) => norm(a) === norm(b);
    if (projects.some(p => same(p, path))) return false;

    await client.updateConfig({ approved_projects: [...projects, path] });
    return true;
}
