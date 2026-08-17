// SafetyGuards — pure safety/loop guards for the agent loop (P3 monolith
// split from AgentController.js). Each guard is a function of its inputs and
// returns a decision/verdict object; the loop applies the side effects
// (history injection, status events). This keeps every guard unit-testable
// without driving a whole run.

import { detectCycle } from './LoopDetector.js';
import { classifyCommand } from '../tools/commandPolicy.js';
import { shouldPlanFirst } from './TaskComplexity.js';
import { isPlanRevision, stripPlanRevisionMarker } from './PlanFirstApproval.js';

/** Tools blocked by the Plan-First gate until the user approves the plan. */
export const PLAN_GATED_TOOLS = new Set([
    'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'delete_file', 'move_file', 'run_command',
]);

/** Tools that count as "real progress" for the no-progress detector. */
export const MUTATING_TOOLS = new Set([
    'write_file', 'write_to_file',
    'multi_replace_file_content',
    'write_xlsx',      // producing a spreadsheet IS the deliverable
    'run_command',     // count as progress — conservative (avoids false stops)
    'delete_file', 'move_file',
    'finish_task',     // terminal — also counts as "progress" (will end loop)
]);

/**
 * Classify a tool-call batch into safe / dangerous / denied by permission
 * level. Pure — no executor access.
 *
 * @param {Array<{name:string,args:object}>} toolCalls
 * @param {(name:string,args:object)=>'Allow'|'Ask'|'Deny'} getPermissionLevel
 * @returns {{safeCalls:Array, dangerousCalls:Array, deniedCalls:Array}}
 */
export function classifyToolCalls(toolCalls, getPermissionLevel) {
    const safeCalls = [];
    const dangerousCalls = [];
    const deniedCalls = [];
    for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
        const level = typeof getPermissionLevel === 'function'
            ? getPermissionLevel(tc.name, tc.args)
            : 'Allow';
        if (level === 'Allow') safeCalls.push(tc);
        else if (level === 'Deny') deniedCalls.push(tc);
        else dangerousCalls.push(tc); // "Ask"
    }
    return { safeCalls, dangerousCalls, deniedCalls };
}

/**
 * Compute whether a run's plan-first gate is active for this turn.
 *
 * @param {object} opts
 * @param {string} opts.prompt the (new) user prompt
 * @param {string} [opts.caller] 'DirectChat' | 'NewTask' | …
 * @param {boolean} [opts.isSubagent]
 * @param {boolean} [opts.isFreshTurn] true when there is no chatContext
 * @param {boolean} [opts.isPlanRevisionTurn] continuation asking for a plan change
 * @param {string} [opts.planMode] 'off' | 'auto' | 'always'
 * @param {string} [opts.lastUserMsg] last user content of chatContext
 * @returns {{active:boolean, approved:boolean, revisionText:string}}
 */
export function planFirstGate({
    prompt = '', caller = '', isSubagent = false, isFreshTurn = true,
    isPlanRevisionTurn = false, planMode = 'auto', lastUserMsg = '',
}) {
    const planBypass = /計画(は)?(不要|いらない|なし)|そのまま実装|プラン不要|no\s*plan|skip\s*plan|just\s*implement/i.test(String(prompt || ''));
    // Only callers with a HUMAN watching in real time can approve a plan.
    // 'Schedule' runs unattended, so it must NOT plan-gate.
    const PLAN_FIRST_CALLERS = new Set(['DirectChat', 'NewTask']);
    // A plan-revision turn ALWAYS re-opens the gate regardless of complexity.
    const revisionText = isPlanRevisionTurn
        ? stripPlanRevisionMarker(String(prompt || ''))
            || stripPlanRevisionMarker(String(lastUserMsg || ''))
        : '';
    const active = planMode !== 'off'
        && PLAN_FIRST_CALLERS.has(caller)
        && !isSubagent
        && (isFreshTurn || isPlanRevisionTurn)
        && !planBypass
        && (planMode === 'always' || isPlanRevisionTurn || shouldPlanFirst(prompt));
    return { active, approved: !active, revisionText };
}

/**
 * Is a tool call gated by plan-first (blocked until approval)? run_command is
 * gated only when the command is NOT safe-classified — read-only shell
 * investigation (`dir` / `git status`) stays allowed during planning.
 */
export function isPlanGatedTool(name, args) {
    if (!PLAN_GATED_TOOLS.has(name)) return false;
    if (name === 'run_command') {
        return classifyCommand(String(args?.command || '')) !== 'safe';
    }
    return true;
}

/**
 * Evaluate the wall-clock budget for one iteration.
 *
 * @param {object} opts
 * @param {number} opts.elapsedMs
 * @param {number} opts.budgetMinutes (0 = disabled)
 * @param {number} opts.pctWarned (1-100; null = not yet)
 * @returns {{stop:boolean, warn:boolean, reason:null|{kind:'wall_clock',limit:number,used:number}}}
 */
export function evaluateWallClock({ elapsedMs = 0, budgetMinutes = 0, pctWarned = null }) {
    if (budgetMinutes <= 0) return { stop: false, warn: false, reason: null };
    const budgetMs = budgetMinutes * 60 * 1000;
    if (elapsedMs >= budgetMs) {
        return {
            stop: true,
            warn: false,
            reason: { kind: 'wall_clock', limit: budgetMinutes, used: Math.round(elapsedMs / 1000) },
        };
    }
    const warn = elapsedMs >= budgetMs * 0.8 && pctWarned !== true;
    return { stop: false, warn, reason: null };
}

/**
 * Evaluate the per-run token budget for one iteration (sub-agent spend included).
 *
 * @param {object} opts
 * @param {number} opts.spent cumulative prompt+completion tokens
 * @param {number} opts.budgetTokens (0 = disabled)
 * @param {boolean} [opts.warned]
 * @returns {{stop:boolean, warn:boolean, reason:null|{kind:'token_budget',limit:number,used:number}}}
 */
export function evaluateTokenBudget({ spent = 0, budgetTokens = 0, warned = false }) {
    if (budgetTokens <= 0) return { stop: false, warn: false, reason: null };
    if (spent >= budgetTokens) {
        return {
            stop: true,
            warn: false,
            reason: { kind: 'token_budget', limit: budgetTokens, used: spent },
        };
    }
    const warn = spent >= budgetTokens * 0.8 && !warned;
    return { stop: false, warn, reason: null };
}

/**
 * Identical-call detection (same tool + args repeated).
 *
 * @param {object} opts
 * @param {string} opts.signature JSON of the current tool_calls
 * @param {string} opts.lastSignature previous signature ('' on first call)
 * @param {number} opts.repeatCount consecutive repeats so far
 * @param {number} opts.warnAt threshold for the warn stage (0 disables)
 * @returns {{isRepeat:boolean, warn:boolean, stop:boolean}}
 */
export function evaluateIdenticalCalls({ signature = '', lastSignature = '', repeatCount = 0, warnAt = 0 }) {
    const stopAt = warnAt > 0 ? warnAt * 3 : 0;
    if (signature && signature === lastSignature) {
        const repeats = repeatCount + 1;
        if (stopAt > 0 && repeats >= stopAt) return { isRepeat: true, warn: false, stop: true, repeatCount: repeats };
        if (warnAt > 0 && repeats >= warnAt) return { isRepeat: true, warn: true, stop: false, repeatCount: repeats };
        return { isRepeat: true, warn: false, stop: false, repeatCount: repeats };
    }
    return { isRepeat: false, warn: false, stop: false, repeatCount: 0 };
}

/**
 * Pattern loop detection: the last N calls are identical in tool+args.
 * @returns {boolean}
 */
export function hasIdenticalTail(toolCallHistory, n = 5) {
    if (!Array.isArray(toolCallHistory) || toolCallHistory.length < n) return false;
    const last = toolCallHistory.slice(-n);
    return last.every(c => c.name === last[0].name && c.argsStr === last[0].argsStr);
}

/**
 * Oscillation cycle detection (ABAB / ABCABC). Pure wrapper over LoopDetector.
 * @returns {null|{pattern:string,length:number,repeats:number}}
 */
export function findCycle(toolCallHistory, minRepeats = 0) {
    if (!minRepeats || minRepeats <= 0) return null;
    return detectCycle(Array.isArray(toolCallHistory) ? toolCallHistory : [], minRepeats);
}

/**
 * No-progress check: has any of the last `window` iterations done real work?
 * @returns {boolean} true when the window contains NO mutating tool call
 */
export function isNoProgressWindow(progressHistory, windowSize) {
    if (!windowSize || windowSize <= 0) return false;
    if (!Array.isArray(progressHistory) || progressHistory.length < windowSize) return false;
    const recent = progressHistory.slice(-windowSize);
    return !recent.some(p => p);
}

/**
 * Whether this iteration made "real progress" (any mutating tool called).
 */
export function iterationMadeProgress(toolNames, mutatingTools = MUTATING_TOOLS) {
    return (Array.isArray(toolNames) ? toolNames : []).some(n => mutatingTools.has(n));
}

/**
 * Phase-routing signal: does this tool batch release the plan phase?
 * 'mutation' when a plan-gated (mutating) tool ran, 'plan-done' when
 * task_progress registered the plan, null otherwise.
 */
export function phaseSignalForToolCalls(toolNames) {
    if (!Array.isArray(toolNames)) return null;
    if (toolNames.some(n => PLAN_GATED_TOOLS.has(n))) return 'mutation';
    if (toolNames.includes('task_progress')) return 'plan-done';
    return null;
}

/**
 * The system check-in message pushed when a no-progress window is detected.
 * Pure so the wording is testable.
 */
export function noProgressCheckMessage(windowSize) {
    return `[System Check] You've executed ${windowSize} consecutive steps without modifying any files (read_file / grep_search / list_files only). Two options:\n1. If the user's goal is fully achieved — call \`finish_task\` now with a summary.\n2. If you are still working — call your next tool immediately (do NOT reply with text only).`;
}

/**
 * The system warning message for an identical repeated call.
 */
export function identicalCallWarning(name, repeatCount) {
    return `[System Warning] You have invoked "${name || 'a tool'}" with identical arguments ${repeatCount} times in a row. This rarely makes sense — please try a different approach, or call \`finish_task\` if the goal is already complete.`;
}

/**
 * The system warning message for an identical 5× tail.
 */
export function tailLoopWarning(name) {
    return `[System Warning] You have invoked the tool "${name || 'a tool'}" with identical arguments 5 times in a row. To prevent infinite loops, consider a different approach or report the status to the user.`;
}

/**
 * The system warning message for an oscillation cycle.
 */
export function cycleWarning(cycle) {
    return `[System Warning] You're oscillating between the same actions (${cycle?.pattern || '?'}) — repeated ${cycle?.repeats ?? '?'} times with no progress. Pick a fundamentally different approach, call \`finish_task\` if the goal is already achieved, or ask the user for guidance. Do NOT repeat the same cycle.`;
}
