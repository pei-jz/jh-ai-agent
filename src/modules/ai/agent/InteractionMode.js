// InteractionMode — "am I being asked, or being given a job?"
//
// This is a SECOND axis, orthogonal to the agent mode (general / develop /
// research / automation). Those pick a tool FAMILY; this picks whether the run
// is a conversation or a piece of work. Both `develop + ask` ("what does this
// middleware let through?") and `research + build` ("investigate and write the
// report to disk") are meaningful, which is why one could not be folded into the
// other.
//
// It exists because Chat and the Monitor's tasks were two engines, and the
// cheaper-looking door was the weaker one: Chat had no memory, no cost record,
// no safety guards. Deleting Chat means the short question has to be servable by
// the real engine WITHOUT feeling like a job — that is what `ask` configures.
//
// docs/design/information-architecture.md §3 / §4.

import {
    READ_ONLY_TOOLS, WEB_TOOLS, CONTROL_TOOLS, toolsOf,
} from '../tools/toolSets.js';

export const ASK = 'ask';
export const BUILD = 'build';

/**
 * What an `ask` run may call.
 *
 * READ_ONLY_TOOLS rather than READ_TOOLS: `run_command` can write, and a run the
 * user entered as a question must not be able to change the workspace — that is
 * the whole basis on which the approval friction is dropped.
 *
 * WEB_TOOLS is in because "look it up and tell me" is the same shape of request
 * as "look in the repo and tell me". CONTROL_TOOLS is in because a turn still
 * has to be able to END (finish_task) and to deliver (present_result) or ask
 * back (ask_user).
 *
 * NOT in, deliberately: `task_progress` (a plan is what `ask` is not),
 * `run_subtask` (delegation is a work shape), every EDIT/OUTPUT tool.
 */
export const ASK_TOOLS = toolsOf(READ_ONLY_TOOLS, WEB_TOOLS, CONTROL_TOOLS);

/** Anything unrecognised is `build` — the safer reading of an unknown value. */
export function normalizeInteraction(value) {
    return value === ASK ? ASK : BUILD;
}

/**
 * Read the axis off whatever carries it.
 *
 * Two shapes reach this: the BEHAVIOR block (what the agent runs from) and the
 * TASK row (what the list view draws from). The server copies the field onto
 * the task at creation precisely because the list response strips behavior, so
 * both are legitimate and neither caller should have to know which it holds.
 *
 * @param {object} src a behavior block or a task row.
 */
export function interactionOf(src) {
    return normalizeInteraction(src?.interaction);
}

export function isAsk(behavior) {
    return interactionOf(behavior) === ASK;
}

/**
 * Narrow an allowlist to what `ask` permits.
 *
 * INTERSECTS rather than replaces, so the agent mode still subtracts: a
 * `research + ask` run does not gain a tool because it was asked rather than
 * told. A null/empty allowlist means "everything the build would get", so the
 * ask list itself is the result.
 *
 * @param {string[]|null} enabled the agent mode's allowlist (null = all)
 * @returns {string[]}
 */
export function askAllowlist(enabled) {
    if (!Array.isArray(enabled) || enabled.length === 0) return [...ASK_TOOLS];
    const allowed = new Set(ASK_TOOLS);
    return enabled.filter(name => allowed.has(name));
}

/**
 * The run-shaping consequences of the interaction mode, in one place.
 *
 * Returned as data rather than applied here so AgentController stays the only
 * thing that touches its own state, and so the rules are testable without a run.
 *
 * @param {object} behavior
 * @returns {{
 *   interaction: string, isAsk: boolean,
 *   planFirst: boolean, includeTaskTools: boolean, allowDelegation: boolean,
 *   enabledTools: string[]|null, routePhases: boolean,
 * }}
 */
export function runShape(behavior = {}) {
    const ask = isAsk(behavior);
    const enabled = Array.isArray(behavior.enabled_tools) ? behavior.enabled_tools : null;
    return {
        interaction: ask ? ASK : BUILD,
        isAsk: ask,
        // A plan is the thing `ask` is defined by not having. Not "usually off":
        // off, so the answer starts arriving on the first turn.
        planFirst: !ask,
        // task_progress draws a checklist. In a conversation that is noise the
        // user then has to scroll past to reach the answer.
        includeTaskTools: !ask,
        allowDelegation: !ask,
        enabledTools: ask ? askAllowlist(enabled) : enabled,
        // Phase routing exists to move IMPLEMENTATION onto a cheaper model.
        // An ask run has no implementation phase, and swapping models mid-answer
        // would change voice halfway through a reply the user is reading.
        routePhases: !ask,
    };
}
