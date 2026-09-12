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
    READ_ONLY_TOOLS, WEB_TOOLS, CREATE_TOOLS,
    TASK_TOOLS, CONTROL_TOOLS, DELEGATION_TOOLS, toolsOf,
} from './tools/toolSets.js';
// Only the two display helpers at the bottom need this. It is safe for the
// headless runtime (ScheduleManager, JobManager) to pull in: i18n/index.js
// touches localStorage and navigator inside functions, never at import time.
import { t } from '../../i18n/index.js';

// ── One axis: how much of the machine can this run touch? ──────────────────
//
// The previous set (general / develop / research / automation) named modes
// after the KIND OF PERSON doing the work, and that failed twice over.
//
// It was misleading: "Develop" reads as "only pick me if you are writing
// code", so every non-code task felt pushed onto a mode it did not belong in —
// when the mode is really just "no restrictions".
//
// And it was not even true. `general` was measured against `develop`: the only
// tool it actually withheld was `git_commit` (the other seven were browser
// tools, which are gated off unless Playwright is installed). So the product's
// DEFAULT mode was "everything except committing", sold as a different kind of
// agent. It restricted without buying anything.
//
// So modes are now named for what they CAN DO, and ordered on the single
// question a user can actually answer — how much should this run be allowed to
// change?
//
//   full       — everything: read, edit, shell, web, commit   (THE DEFAULT)
//   no_edit    — "No edits (new files OK)": reads, searches, and creates NEW
//                files; never changes or removes one that already exists
//   read_only  — reads and answers on screen; writes nothing at all
//
// The middle one's label carries "(new files OK)" because that clause is the
// ONLY thing separating it from read_only. "No edits" alone describes both.
//
// Each step down removes a capability and nothing else, so "when would I pick
// this?" is answerable from the name alone.
//
// `persona_tier` selects which agent the system prompt describes — see
// agent/personaTier.js. Those tier names ('develop' / 'general' / 'scoped') are
// a SEPARATE namespace from mode ids and deliberately unchanged here.
export const AGENT_MODES = {
    // THE DEFAULT. No overrides at all: every built-in tool, the `develop`
    // persona tier inferred from the allowlist, and the step ceiling left to
    // Settings (safety.maxSteps, 0 = unlimited) rather than a magic number
    // here. "Full access" is the honest description of that, and it is the
    // right default for an agent whose whole job is to get work done.
    full: {
        id: 'full',
        label: 'Full access',
        labelKey: 'mode.full',
        descKey: 'mode.full.desc',
        description: 'Read, edit, run commands, search the web, commit — no restrictions (the default)',
        behavior: {}
    },

    // One step down: it can still investigate anything and still DELIVER a
    // file — a NEW one. Anything already on disk stays exactly as it was.
    //
    // Three things make that true rather than merely intended, and each closed
    // a real hole:
    //   • no shell. The old `research` mode had `run_command` while its prompt
    //     promised not to edit code — a promise only the prompt kept, since a
    //     shell can write any file. (Cost: no Python one-liner to crunch
    //     numbers; that work belongs in `full`.)
    //   • only CREATE_TOOLS. The first cut used OUTPUT_TOOLS, which carries
    //     update_xlsx and append_xlsx_row — so a mode called "no edits" could
    //     edit any workbook in the workspace.
    //   • `create_only`. write_file replaces an existing path without
    //     complaint, so tool membership could never promise "new files only".
    //     ToolExecutor checks the file system and refuses a write to a path
    //     that exists.
    no_edit: {
        id: 'no_edit',
        label: 'No edits (new files OK)',
        labelKey: 'mode.noEdit',
        descKey: 'mode.noEdit.desc',
        description: 'Read, search the web and create NEW files (reports, workbooks) — existing files are never changed, and no shell',
        behavior: {
            system_prompt: `You are an expert research analyst. Your job is to investigate (a codebase, files, or the web), synthesize findings, and produce a clear written report or analysis.

Workflow:
1. Investigate with read_file / list_files / glob / grep_search / symbol_search (for a codebase) and fetch_url (for the web).
2. For Office documents (.xlsx/.xls/.ods/.docx/.pptx) ALWAYS use read_office. For a workbook, read the sheet index first, then request the sheet you need with sheet="…".
3. To DELIVER a spreadsheet (not just describe one), use write_xlsx.
4. DELIVER the final report to the user by calling present_result with kind="markdown" and the FULL report in the "markdown" field. This is what the user sees as the result — it must contain the complete report, not a recap.
5. If the user asked you to SAVE the report to a file, ALSO use write_file for that.
6. Call finish_task LAST with a SHORT one-or-two-line summary (NOT the full report — the report goes in present_result).

Rules:
- You have NO shell and you can NOT change any file that already exists — every write must target a NEW path, and the system refuses a write to an existing one. Do not plan around this; if a step genuinely requires running a command or changing an existing file, say so in the report and stop rather than looking for a way around it.
- write_file / write_xlsx / write_docx are for the deliverable, written to a new path. If the obvious name is taken, pick a new one (e.g. add a date suffix) rather than trying to overwrite.
- Put the full report in present_result(markdown=...); keep finish_task's summary short. Never rely on finish_task's summary to carry the whole report.
- Prefer structured output (Markdown tables, JSON, CSV) where it helps clarity.
- If a URL returns HTML, extract only the text you need; never dump raw HTML.
- Write reports in Japanese unless the user explicitly requests another language.`,
            // Built from the shared groups so a newly added read tool reaches
            // this mode automatically. READ_ONLY_TOOLS, not READ_TOOLS: the
            // difference between the two is exactly `run_command`.
            enabled_tools: toolsOf(
                READ_ONLY_TOOLS, WEB_TOOLS, CREATE_TOOLS, TASK_TOOLS, CONTROL_TOOLS,
                // Several independent investigations in parallel is the case
                // delegation was built for, and research is where it pays best.
                // Safe here: run_subtask clamps a child to this allowlist and
                // hands it `create_only` too (AgentController._runSubtask).
                DELEGATION_TOOLS,
            ),
            // Enforced by ToolExecutor against the file system — see above.
            create_only: true,
            persona_tier: 'general',
            // A backstop against a runaway loop, not a work budget — the real
            // safeguards are the token budget and the wall-clock timeout in
            // Settings. `full` leaves even this to Settings; a restricted mode
            // is the one likely to be pointed at untrusted input, so it keeps a
            // hard ceiling of its own.
            max_iterations: 300
        }
    },

    // The bottom of the ladder: it cannot change anything, anywhere. No editing
    // tools, no output tools, no shell — the answer comes back on screen via
    // present_result and nothing reaches disk.
    //
    // This is the mode to reach for when the PROMPT itself is not fully
    // trusted: a scheduled job triggered by an incoming mail, a webhook, an
    // app intent. "It can only look" is a guarantee worth having, and none of
    // the other modes can make it.
    read_only: {
        id: 'read_only',
        label: 'Read only',
        labelKey: 'mode.readOnly',
        descKey: 'mode.readOnly.desc',
        description: 'Reads and answers on screen — writes no files at all, and has no shell',
        behavior: {
            system_prompt: `You are an expert analyst working in READ-ONLY mode. You can inspect files, a codebase and the web, and you answer on screen. You cannot write, edit or delete anything, and you have no shell.

Workflow:
1. Investigate with read_file / list_files / glob / grep_search / symbol_search / code_deps, read_office for Office documents, and fetch_url / web_search for the web.
2. DELIVER your answer by calling present_result with kind="markdown" and the FULL answer in the "markdown" field. This is the only way the user sees your work — nothing you produce reaches a file.
3. Call finish_task LAST with a SHORT one-or-two-line summary.

Rules:
- You have NO way to write a file and NO shell. If the task genuinely requires changing something, say so plainly in your answer and stop — do not look for a workaround, and do not claim you made a change.
- Put the full answer in present_result(markdown=...); keep finish_task's summary short.
- Prefer structured output (Markdown tables) where it helps clarity.
- Answer in Japanese unless the user explicitly requests another language.`,
            enabled_tools: toolsOf(
                READ_ONLY_TOOLS, WEB_TOOLS, TASK_TOOLS, CONTROL_TOOLS,
            ),
            persona_tier: 'general',
            max_iterations: 300   // see the note on `no_edit`
        }
    }
};

// Old mode ids → their nearest current equivalent, so a saved session, a
// scheduled job or a stored agentModeId keeps working across every rename this
// file has been through.
//
// `develop`, `general` and `automation` all collapse into `full`: measured
// against each other they differed by `git_commit` and a web-tool toggle, which
// is not a distinction worth stranding someone's saved schedule over.
// `research` is the one with a real restriction, and it becomes `no_edit`.
const LEGACY_MODE_ALIASES = {
    // pre-2026-06-14
    developer: 'full',
    researcher: 'no_edit',
    analyst: 'no_edit',
    assistant: 'full',
    // 2026-06-14 → 2026-09-11
    general: 'full',
    develop: 'full',
    automation: 'full',
    research: 'no_edit',
};

/**
 * Mode id → the SVG icon that stands for it (icons.js names).
 *
 * Lives beside `modeName` because they answer one question between them: how
 * is this mode shown. It existed twice — in ModeDropdown and in
 * newTaskRequest — with identical contents, which is the state right before
 * someone adds a mode to one of them.
 */
export const MODE_ICON = { full: 'bolt', no_edit: 'report', read_only: 'search' };

/** Strip the decorative leading emoji a `label` may carry. */
const stripEmoji = (s) => String(s || '').replace(/^\p{Extended_Pictographic}️?\s+/u, '');

/**
 * A mode's display name, localised.
 *
 * The labels were English strings sitting in a Japanese UI — the one place the
 * app asks the user to make a capability decision was the one place it stopped
 * speaking their language. `label` remains as the fallback, so a surface that
 * renders before the locale loads still shows something meaningful.
 *
 * Exported so there is one answer to "what is this mode called", rather than a
 * regex copied per view.
 */
export function modeName(mode) {
    const fallback = stripEmoji(mode?.label) || String(mode?.id || '');
    return mode?.labelKey ? t(mode.labelKey, null, fallback) : fallback;
}

/** A mode's one-line description, localised. Pairs with `modeName`. */
export function modeDescription(mode) {
    const fallback = String(mode?.description || '');
    return mode?.descKey ? t(mode.descKey, null, fallback) : fallback;
}

// FULL is the default. The previous default restricted `git_commit` and nothing
// else while presenting itself as a different kind of agent; an agent whose job
// is to finish work should start with the tools to finish it, and the narrower
// modes are there for when the user wants to take some away.
export const DEFAULT_MODE_ID = 'full';

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
