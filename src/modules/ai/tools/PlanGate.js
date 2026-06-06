// PlanGate — PURE helpers for the "investigate → plan → approve → execute"
// workflow. When a plan is REQUIRED but not yet approved, mutating tools are
// blocked so the agent can't start changing things before the user signs off.
// Investigation/read tools (and propose_plan itself) are always allowed.

/** Tools that change state on disk or run commands — gated until plan approval. */
export const MUTATING_TOOLS = new Set([
    'write_file',
    'write_to_file',
    'multi_replace_file_content',
    'replace_lines',
    'run_command',
    'delete_file',
    'move_file',
    'create_dir',
]);

/** True if `name` is a state-changing tool subject to the plan gate. */
export function isMutatingTool(name) {
    return MUTATING_TOOLS.has(name);
}

/**
 * Decide whether a tool call should be blocked by the plan gate.
 * @param {string} name           tool being called
 * @param {boolean} planRequired  is a plan required for this task?
 * @param {boolean} planApproved  has the user approved a plan yet?
 * @returns {boolean} true ⇒ block this call
 */
export function shouldBlock(name, planRequired, planApproved) {
    return !!planRequired && !planApproved && isMutatingTool(name);
}

/** The error returned to the model when a mutating tool is blocked pre-approval. */
export function planGateMessage(name) {
    return `Error: "${name}" is blocked — this task requires an APPROVED plan first. ` +
        `Investigate as needed (read_file / grep_search / list_files), then call ` +
        `propose_plan with the work broken into phases and WAIT for the user to approve. ` +
        `Do NOT edit files or run commands until the plan is approved.`;
}
