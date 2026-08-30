// newTaskRequest — what "Create & Run" actually sends.
//
// Extracted from MonitorView._openNewTaskModal, where the request body was
// assembled inline in a 60-line `send` closure that also disabled buttons,
// started MCP servers, navigated and handled errors. The assembly is the part
// with rules in it, and one of them is load-bearing in a way that is invisible
// from the call site — see `mcp_servers` below.

import { buildBehavior } from '../../../modules/ai/AgentModes.js';
import { BUILD, ASK, normalizeInteraction } from '../../../modules/ai/agent/InteractionMode.js';

/** The block appended to the prompt for each non-image attachment. */
export function attachmentBlocks(files) {
    if (!files?.length) return '';
    return '\n\n' + files
        .map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\`\n`)
        .join('\n');
}

/**
 * Can this be sent, and if not, why?
 *
 * A workspace is required for a `build` run because an agent task with nowhere
 * to work cannot do anything — the server accepts the task and the run fails on
 * its first tool.
 *
 * It is NOT required for `ask`. "What does this error mean", "where do I get the
 * Java LSP" — a question answered from the model's own knowledge or from the web
 * has no files to touch, and an `ask` run cannot touch any regardless (its
 * allowlist is read-only, see agent/InteractionMode.js). Demanding a folder
 * before answering a general question is asking for something that will not be
 * used. A workspace is still HONOURED when there is one: that is what makes
 * "what does auth_middleware let through" work.
 */
export function validateNewTask({ hasContent, workspace, interaction = BUILD }) {
    if (!hasContent) return { ok: false, field: 'prompt' };
    if (normalizeInteraction(interaction) === BUILD && !String(workspace || '').trim()) {
        return { ok: false, field: 'workspace', reason: 'Please specify a workspace (required for agent tasks).' };
    }
    return { ok: true };
}

/**
 * The behavior block for a new task.
 *
 * `mcp_servers` is passed EXPLICITLY, including as an empty array, and that is
 * the whole point: AgentController's server filter reads an empty list as "no
 * MCP tools at all", while an OMITTED list means "every server". With it
 * omitted, a server that connects MID-task — Chat starts its configured servers
 * asynchronously — would leak its tools into this task's later turns.
 */
export function taskBehavior(modeId, selectedMcp = [], interaction = BUILD) {
    return {
        mode: 'iterative_agent',
        ...buildBehavior(modeId),
        mcp_servers: [...selectedMcp],
        // The SECOND axis — "asked" vs "given a job" — orthogonal to modeId.
        // Always sent, never inferred server-side: what the user picked in the
        // composer is the answer, and an omitted field would have the run guess.
        interaction: normalizeInteraction(interaction),
    };
}

/**
 * The POST body for /tasks.
 *
 * `images` is omitted rather than sent empty, because the server distinguishes
 * "no images" from "an empty image list" when choosing a vision-capable model.
 */
export function taskPayload({ prompt, workspace, modeId, selectedMcp = [], images = [], caller = 'NewTask', interaction = BUILD }) {
    return {
        prompt,
        workspace_path: workspace,
        caller,
        behavior: taskBehavior(modeId, selectedMcp, interaction),
        images: images.length > 0 ? images : undefined,
    };
}

/** Mode id → the icon name used for its button (mirrors ModeDropdown). */
export const MODE_ICON = { develop: 'code', research: 'search', automation: 'gear' };

/** A mode's label without its leading emoji — an SVG icon is drawn instead. */
export function modeName(mode) {
    return String(mode?.label || mode?.id || '').replace(/^\S+\s+/, '');
}
