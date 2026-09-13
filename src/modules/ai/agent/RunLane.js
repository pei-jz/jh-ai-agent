// RunLane — what a run is, decided on two axes and nowhere else.
//
// Before this, a run's tools and prompt were the product of five inputs read in
// five places: the caller's NAME, the agent-mode preset, `behavior.intent`,
// `interaction`, and whether `system_prompt` was present. Each was individually
// reasonable and together they produced runs nobody had designed — the one that
// prompted this module was a JHEditor chat set to "selection only" that read the
// whole jh-editor tree (736k tokens), while the selection it had been sent was
// silently dropped because a caller-supplied `system_prompt` bypassed the prompt
// builder that would have included it.
// docs/scratch/Report_20260913.md.
//
// Two axes:
//
//   shape — what the run DOES
//     transform  one round trip, no tools, no history (a commit message, a
//                translation, an inline rewrite)
//     ask        a conversation that can only look
//     build      work: edits and a shell
//
//   reach — what the run may TOUCH
//     none       nothing but the model and the web
//     app        the calling application's own MCP tools — no file system, no
//                project context
//     workspace  one named folder, and the project context that belongs to it
//
// Five combinations are meaningful (L1–L5 in the report). `build` without a
// workspace is refused: work needs somewhere to happen, and the old fallback to
// the process's current directory is how a scheduled run could edit whatever
// folder the app happened to be started from.
//
// The server decides this, not the client. A client that forgets to narrow its
// reach gets the narrow default; it does not get the file system.

import { isExternalCaller } from './taskCaller.js';
import { WEB_TOOLS } from '../tools/toolSets.js';

export const TRANSFORM = 'transform';
export const ASK = 'ask';
export const BUILD = 'build';

export const NONE = 'none';
export const APP = 'app';
export const WORKSPACE = 'workspace';

const SHAPES = new Set([TRANSFORM, ASK, BUILD]);
const REACHES = new Set([NONE, APP, WORKSPACE]);

/**
 * A step ceiling for a conversation. `ask` has no plan and no deliverable file,
 * so a run that is still going after this many steps is searching, not
 * answering — the review that started this used 10 minutes and 736k tokens.
 */
export const ASK_MAX_STEPS = 12;

/**
 * Resolve the lane for a run.
 *
 * Explicit `shape` / `reach` win. Otherwise the legacy fields are read, so every
 * caller that exists today keeps a defined meaning:
 *   mode: 'single_shot'        → transform
 *   interaction: 'ask'|'build' → that shape
 *   nothing                    → build for this app's own callers, ask for anyone else
 *
 * An EXTERNAL caller that says nothing gets `ask × app` — the narrowest lane that
 * still does something. Reaching a workspace, or doing work, has to be asked for.
 *
 * @param {object} [behavior]
 * @param {{caller?: string|null, isSubagent?: boolean}} [who]
 * @returns {{shape: string, reach: string, external: boolean, error: string|null}}
 */
export function resolveLane(behavior = {}, { caller = null, isSubagent = false } = {}) {
    const b = behavior || {};
    const external = !isSubagent && isExternalCaller(caller);

    let shape = SHAPES.has(b.shape) ? b.shape : null;
    if (!shape) {
        if (b.mode === 'single_shot') shape = TRANSFORM;
        else if (b.interaction === ASK || b.interaction === BUILD) shape = b.interaction;
        else shape = external ? ASK : BUILD;
    }

    let reach;
    if (shape === TRANSFORM) {
        // A transform has no tools, so there is nothing for a reach to govern.
        reach = NONE;
    } else if (REACHES.has(b.reach)) {
        reach = b.reach;
    } else {
        reach = external ? APP : WORKSPACE;
    }

    const error = shape === BUILD && reach !== WORKSPACE
        ? `A "build" run needs reach "workspace" (got "${reach}"). Work has to happen somewhere the user chose.`
        : null;

    return { shape, reach, external, error };
}

/**
 * The MCP servers that count as "the calling application".
 *
 * An explicit `mcp_servers` list wins — JHEditor sends ['jheditor'], the name it
 * registers on /mcp/ws under. Without one, the caller name lower-cased is the
 * best available guess, and it is only a guess: it matches the apps that exist,
 * and an app that does not match simply gets no MCP tools rather than someone
 * else's.
 */
export function appServers(behavior = {}, caller = null) {
    if (Array.isArray(behavior?.mcp_servers)) return [...behavior.mcp_servers];
    return caller ? [String(caller).toLowerCase()] : [];
}

/**
 * The tool configuration a lane implies.
 *
 * Returned as data so AgentController applies it and a test can read it without
 * a run. `transform` never reaches here — TaskBridge sends it to the one-shot
 * path before an agent loop exists.
 *
 * `mcpBypassesAllowlist` is true wherever the SERVER filter is the thing that
 * scopes MCP tools. The allowlist names built-in tools; an app's `get_buffer` is
 * never going to be on it, and filtering it out by name is what used to remove
 * the one set of tools that honours the editor's privacy setting.
 *
 * @param {{shape:string, reach:string, external:boolean}} lane
 * @param {object} o
 * @param {string[]|null} o.askTools   the ask allowlist (ASK_TOOLS ∩ mode)
 * @param {string[]|null} o.modeTools  behavior.enabled_tools (null = all)
 * @param {object}        o.behavior
 * @param {string|null}   o.caller
 */
export function laneTools(lane, { askTools = null, modeTools = null, behavior = {}, caller = null } = {}) {
    const selected = Array.isArray(behavior?.mcp_servers) ? [...behavior.mcp_servers] : null;

    if (lane.reach === NONE) {
        return {
            enabledTools: [...WEB_TOOLS],
            mcpServerFilter: [],
            mcpBypassesAllowlist: false,
            excludeExternalAppMcp: true,
        };
    }
    if (lane.reach === APP) {
        return {
            enabledTools: [...WEB_TOOLS],
            mcpServerFilter: appServers(behavior, caller),
            mcpBypassesAllowlist: true,
            excludeExternalAppMcp: false,
        };
    }
    // workspace
    const mcpServerFilter = selected ?? (lane.external ? appServers(behavior, caller) : null);
    if (lane.shape === ASK) {
        return {
            enabledTools: askTools ? [...askTools] : [],
            mcpServerFilter,
            mcpBypassesAllowlist: true,
            excludeExternalAppMcp: !lane.external,
        };
    }
    return {
        enabledTools: Array.isArray(modeTools) ? [...modeTools] : null,
        mcpServerFilter,
        // Unchanged for build: a restricted mode that names its tools keeps MCP
        // tools out unless it names them too.
        mcpBypassesAllowlist: false,
        excludeExternalAppMcp: !lane.external,
    };
}

/** Does this lane read project context (summary, instructions, memory)? */
export function usesProjectContext(lane) {
    return lane?.reach === WORKSPACE;
}

/** "ask × app" — for status lines and logs. */
export function laneLabel(lane) {
    return lane ? `${lane.shape} × ${lane.reach}` : '';
}
