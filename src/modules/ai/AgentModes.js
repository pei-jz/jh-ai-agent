/**
 * AgentModes — Central definition of agent execution modes.
 *
 * Each mode provides a `behavior` object that is merged into the task's
 * behaviorOverrides (AgentController) or sent as the `behavior` field in
 * the POST /api/tasks body.
 *
 * Fields (all optional):
 *   system_prompt      — fully replaces ContextBuilder's output when set
 *   extra_instructions — appended after the system prompt
 *   enabled_tools      — array of allowed tool names (null = all tools)
 *   max_iterations     — step limit override (0 = unlimited)
 */

// ── Three role-clear modes (consolidated 2026-06-14, was 5) ────────────────
// The old 5 modes (developer/researcher/analyst/assistant/automation) overlapped
// heavily and the names didn't convey the difference. Reduced to 3 with distinct
// roles + plain descriptions:
//   develop  — 開発: full tools, edits & verifies code (the default, most capable)
//   research — 調査・レポート: investigate + write reports, NO code editing
//   automation — 自動実行: shell-centric batch / system operations
export const AGENT_MODES = {
    develop: {
        id: 'develop',
        label: '💻 Develop',
        description: 'Investigate, edit, run and verify code — the most general (default)',
        behavior: {
            // No overrides — ContextBuilder's default "elite software engineer"
            // with the full built-in toolset.
        }
    },

    research: {
        id: 'research',
        label: '🔍 Research & Report',
        description: 'Investigate a codebase or the web and write a summary/report (no code editing)',
        behavior: {
            system_prompt: `You are an expert research analyst. Your job is to investigate (a codebase, files, or the web), synthesize findings, and produce a clear written report or analysis.

Workflow:
1. Investigate with read_file / list_files / glob / grep_search (for a codebase) and fetch_url (for the web).
2. For data analysis, use run_command to invoke Python / Node scripts when heavy computation is needed.
3. DELIVER the final report to the user by calling present_result with kind="markdown" and the FULL report in the "markdown" field. This is what the user sees as the result — it must contain the complete report, not a recap.
4. If the user asked you to SAVE the report to a file, ALSO use write_file for that.
5. Call finish_task LAST with a SHORT one-or-two-line summary (NOT the full report — the report goes in present_result).

Rules:
- Do NOT edit or refactor source code — investigation and reporting only (writing a NEW report/output file is fine).
- Put the full report in present_result(markdown=...); keep finish_task's summary short. Never rely on finish_task's summary to carry the whole report.
- Prefer structured output (Markdown tables, JSON, CSV) where it helps clarity.
- If a URL returns HTML, extract only the text you need; never dump raw HTML.
- Write reports in Japanese unless the user explicitly requests another language.`,
            enabled_tools: ['fetch_url', 'read_file', 'list_files', 'glob', 'grep_search', 'write_file', 'run_command', 'present_result', 'task_progress', 'finish_task'],
            max_iterations: 40
        }
    },

    automation: {
        id: 'automation',
        label: '⚙️ Automation',
        description: 'Shell-command-centric batch / system operations, builds, deploys, etc.',
        behavior: {
            system_prompt: `You are a system automation engineer. Your job is to execute shell commands, manage files, and run batch operations reliably.

Workflow:
1. Plan the sequence of operations using task_progress.
2. Execute each step with run_command or file tools.
3. Verify each step succeeded before proceeding to the next.
4. Call finish_task with a summary of what was executed.

Rules:
- Set safe_to_auto_run=true ONLY for clearly read-only commands.
- For destructive operations (delete, overwrite, move), verify the path first.
- Respond in Japanese unless asked otherwise.`,
            enabled_tools: ['run_command', 'read_file', 'write_file', 'list_files', 'glob', 'grep_search', 'move_file', 'delete_file', 'task_progress', 'finish_task'],
            max_iterations: 50
        }
    }
};

// Legacy mode ids (pre-2026-06-14) → their nearest current equivalent, so a
// saved session / stored agentModeId keeps working after the consolidation.
const LEGACY_MODE_ALIASES = {
    developer: 'develop',
    researcher: 'research',
    analyst: 'research',
    assistant: 'develop',
};

export const DEFAULT_MODE_ID = 'develop';

/** Resolve a (possibly legacy) mode id to a current one. */
export function resolveModeId(modeId) {
    if (AGENT_MODES[modeId]) return modeId;
    if (LEGACY_MODE_ALIASES[modeId]) return LEGACY_MODE_ALIASES[modeId];
    return DEFAULT_MODE_ID;
}

/** Returns the behavior object for a given mode ID (legacy ids resolved). */
export function getBehaviorForMode(modeId) {
    const mode = AGENT_MODES[resolveModeId(modeId)];
    return mode.behavior;
}

/** Merges a mode's behavior with any additional overrides. */
export function buildBehavior(modeId, extraOverrides = {}) {
    const base = getBehaviorForMode(modeId);
    const merged = { ...base, ...extraOverrides };
    // Merge system_prompt: if extraOverrides has system_prompt, it wins
    return merged;
}
