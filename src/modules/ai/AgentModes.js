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
 *
 * IMPORTANT: build `enabled_tools` from tools/toolSets.js, never by typing
 * names here. These lists were hand-written and silently went stale as tools
 * were added — an agent in research mode had `run_command` but not
 * `read_office`, so it tried to parse spreadsheets through the shell.
 */

import { READ_TOOLS, EDIT_TOOLS, WEB_TOOLS, OUTPUT_TOOLS, TASK_TOOLS, toolsOf } from './tools/toolSets.js';

// ── Four role-clear modes ──────────────────────────────────────────────────
// Consolidated from 5 overlapping ones in 2026-06-14; `general` added 2026-08-09
// when the product's default stopped being a code agent.
//   general    — 汎用: read documents, analyse, produce a deliverable (THE DEFAULT)
//   develop    — 開発: edits and verifies source
//   research   — 調査・レポート: investigate + write reports, NO code editing
//   automation — 自動実行: shell-centric batch / system operations
//
// `persona_tier` selects which agent the system prompt describes — see
// agent/personaTier.js. Leaving it unset lets ContextBuilder infer it from the
// allowlist, which is what `develop` relies on.
export const AGENT_MODES = {
    // The DEFAULT. General work, not only code: read the material, reason over it,
    // and deliver a concrete artefact. It gets the full toolset minus run_command —
    // a general task should not need a shell, and withholding it is what selects the
    // `general` persona tier (see agent/personaTier.js) rather than the code-focused
    // one. `develop` remains for work that edits and verifies source.
    general: {
        id: 'general',
        label: '🧰 General',
        description: 'Everyday work — read documents, analyse, and produce a deliverable (the default)',
        behavior: {
            enabled_tools: toolsOf(
                READ_TOOLS, EDIT_TOOLS, WEB_TOOLS, OUTPUT_TOOLS, TASK_TOOLS,
                ['present_result', 'ask_user', 'create_artifact', 'update_artifact', 'write_docx'],
            ),
            persona_tier: 'general',
            max_iterations: 40,
        }
    },

    develop: {
        id: 'develop',
        label: '💻 Develop',
        description: 'Investigate, edit, run and verify code',
        behavior: {
            // No overrides — the full built-in toolset, and the `develop` tier
            // inferred from it (editing + run_command).
        }
    },

    research: {
        id: 'research',
        label: '🔍 Research & Report',
        description: 'Investigate a codebase or the web and write a summary/report (no code editing)',
        behavior: {
            system_prompt: `You are an expert research analyst. Your job is to investigate (a codebase, files, or the web), synthesize findings, and produce a clear written report or analysis.

Workflow:
1. Investigate with read_file / list_files / glob / grep_search / symbol_search (for a codebase) and fetch_url (for the web).
2. For Office documents (.xlsx/.xls/.ods/.docx/.pptx) ALWAYS use read_office — never try to parse them through run_command. For a workbook, read the sheet index first, then request the sheet you need with sheet="…". Reach for run_command + Python/Node only when the computation genuinely exceeds what you can do from the extracted text.
3. To DELIVER a spreadsheet (not just describe one), use write_xlsx.
4. DELIVER the final report to the user by calling present_result with kind="markdown" and the FULL report in the "markdown" field. This is what the user sees as the result — it must contain the complete report, not a recap.
5. If the user asked you to SAVE the report to a file, ALSO use write_file for that.
6. Call finish_task LAST with a SHORT one-or-two-line summary (NOT the full report — the report goes in present_result).

Rules:
- Do NOT edit or refactor source code — investigation and reporting only (writing a NEW report/output file is fine).
- Put the full report in present_result(markdown=...); keep finish_task's summary short. Never rely on finish_task's summary to carry the whole report.
- Prefer structured output (Markdown tables, JSON, CSV) where it helps clarity.
- If a URL returns HTML, extract only the text you need; never dump raw HTML.
- Write reports in Japanese unless the user explicitly requests another language.`,
            // Built from the shared groups so a newly added read tool reaches
            // this mode automatically. `write_file` is the report file; source
            // editing stays out (the persona forbids it and EDIT_TOOLS is not
            // included).
            enabled_tools: toolsOf(READ_TOOLS, WEB_TOOLS, OUTPUT_TOOLS, TASK_TOOLS, ['write_file', 'present_result', 'write_docx']),
            persona_tier: 'general',
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
            enabled_tools: toolsOf(READ_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS, TASK_TOOLS, ['run_command']),
            persona_tier: 'develop',
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
    assistant: 'general',
};

// GENERAL is the default. The product is a general-purpose agent; making the
// code-focused mode the default told every non-code task it was in the wrong place.
export const DEFAULT_MODE_ID = 'general';

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
