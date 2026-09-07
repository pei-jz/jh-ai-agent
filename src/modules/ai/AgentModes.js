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

import {
    READ_TOOLS, EDIT_TOOLS, WEB_TOOLS, OUTPUT_TOOLS,
    TASK_TOOLS, CONTROL_TOOLS, DELEGATION_TOOLS, toolsOf,
} from './tools/toolSets.js';

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
    // and deliver a concrete artefact.
    //
    // It gets everything except the browser group and `git_commit`. This comment
    // used to claim "the full toolset minus run_command — a general task should
    // not need a shell, and withholding it is what selects the `general` persona
    // tier", and both halves were untrue: READ_TOOLS has always contained
    // `run_command`, and the tier is pinned explicitly below rather than inferred.
    // Running a one-off script to compute something for a report is ordinary
    // general work, so the shell stays — the command policy is what gates it.
    general: {
        id: 'general',
        label: '🧰 General',
        description: 'Everyday work — read documents, analyse, and produce a deliverable (the default)',
        behavior: {
            enabled_tools: toolsOf(
                READ_TOOLS, EDIT_TOOLS, WEB_TOOLS, OUTPUT_TOOLS,
                TASK_TOOLS, CONTROL_TOOLS,
                // Without this the sub-agent engine (roles, write-scope ownership,
                // budget slicing, the reviewer gate) was unreachable in the mode
                // most users never leave.
                DELEGATION_TOOLS,
            ),
            persona_tier: 'general',
            // 300, not 40. The old ceiling was low enough that ordinary work hit it —
            // and hitting it looked like the agent had simply stopped for no reason.
            // Steps are a poor proxy for cost anyway: the real safeguards are the token
            // budget, the wall-clock timeout and the loop detectors, all configurable in
            // Settings. This is a backstop against a runaway loop, not a work budget.
            max_iterations: 300,
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
            enabled_tools: toolsOf(
                READ_TOOLS, WEB_TOOLS, OUTPUT_TOOLS, TASK_TOOLS, CONTROL_TOOLS,
                // Several independent investigations in parallel is the case
                // delegation was built for, and research is where it pays best.
                DELEGATION_TOOLS,
                ['write_file'],
            ),
            persona_tier: 'general',
            max_iterations: 300   // see the note on `general`
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
            // `run_command` is not listed separately — it is part of READ_TOOLS.
            enabled_tools: toolsOf(
                READ_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS, TASK_TOOLS, CONTROL_TOOLS,
                DELEGATION_TOOLS,
            ),
            persona_tier: 'develop',
            max_iterations: 300   // see the note on `general`
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
/**
 * Mode id → the SVG icon that stands for it (icons.js names).
 *
 * Lives beside `modeName` because they answer one question between them: how
 * is this mode shown. It existed twice — in ModeDropdown and in
 * newTaskRequest — with identical contents, which is the state right before
 * someone adds a mode to one of them.
 */
export const MODE_ICON = { develop: 'code', research: 'search', automation: 'gear' };

/**
 * A mode's name without the leading emoji its `label` carries.
 *
 * The emoji is a decoration for surfaces that can draw one; ModeDropdown
 * already stripped it and rendered an SVG icon in its place. Every OTHER
 * surface is a native <select>, which cannot draw an SVG and so showed the raw
 * emoji instead — the same list looking like two different products depending
 * on which screen it was on. Exported so there is one answer to "what is this
 * mode called", rather than a regex copied per view.
 */
export function modeName(mode) {
    return String(mode?.label || mode?.id || '').replace(/^\S+\s+/, '');
}

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
