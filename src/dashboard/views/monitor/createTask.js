// createTask — the one place a task is actually created.
//
// There are now two entries: the composer at the top of the list (the common
// case) and NewTaskModal (mode, MCP selection, attachments). LaunchPanel's file
// comment already named the hazard a second entry creates —
//
//   "a second creation path here would be the weaker of the two and would drift"
//
// — so the entries share this function rather than each assembling their own
// POST. What goes IN the body is still newTaskRequest.js.
//
// MCP servers are NOT started here any more. Every registered server is
// started at app launch (McpManager.autoStart), and the per-task selection
// only decides which servers' tools are sent to the model — it never starts
// or stops anything.
//
// Everything external is injected so the rules can be tested without a server
// or a DOM.
//
// docs/design/information-architecture.md §7 step 1.

import { taskPayload } from './newTaskRequest.js';

/**
 * Create a task and return its id.
 *
 * @param {object}   o
 * @param {string}   o.prompt        already expanded ("/" templates) and with
 *                                   attachment blocks appended, if any
 * @param {string}   o.workspace
 * @param {string}   o.modeId
 * @param {string[]} [o.selectedMcp] whose tools are sent; passed through
 *                                   EXPLICITLY, empty included — see
 *                                   taskBehavior for why that matters
 * @param {string[]} [o.images]      data URLs
 * @param {string}   [o.caller]      shows in the task list
 * @param {string}   [o.interaction] 'ask' | 'build' — see agent/InteractionMode.js
 * @param {boolean}  [o.recorded]    the exchange already happened — write it
 *                                   down instead of running it (Spotlight's
 *                                   Expand). No MCP, no workspace, no tools.
 * @param {object}   o.client        apiClient
 * @returns {Promise<string>} the new task id
 */
export async function createTask({
    prompt, workspace, modeId, selectedMcp = [],
    images = [], caller = 'NewTask', interaction = 'build',
    chatContext = [], recorded = false,
    client,
}) {
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
            recorded,
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
    //
    // "Running somewhere IS approving it" is the whole argument, so a recorded
    // exchange — which runs nowhere — approves nothing. This is what filled the
    // workspace picker with folders a Spotlight search had merely been sitting
    // next to.
    if (!recorded) rememberWorkspace(workspace, client).catch(() => {});

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
