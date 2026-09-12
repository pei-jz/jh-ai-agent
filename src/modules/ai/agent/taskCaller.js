// taskCaller — the caller-name classification shared by the agent loop and the
// OS-notification gate. A task's `caller` (REST POST /tasks) says who asked for
// it: JHAI's own interactive UI (NewTask / Schedule / DirectChat) or an external
// tool (JHEditor / JHER / …).
//
// External tools confirm completion on their own side (they hold the task WS /
// poll the result), so JHAI must not ALSO fire an OS "Task completed" toast for
// them — that is the double notification this module's caller gates against.
// Keeping the predicate here (rather than in main.js) lets the agent loop and
// the notification gate share one definition instead of drifting apart.

/**
 * Every caller that is THIS APP asking for work.
 *
 * The list had three names and the app has six, so the three that were added
 * later — the composer on the Work screen, a scheduled job, a watcher trigger —
 * counted as EXTERNAL tools. That is not a labelling detail: an external caller
 * with no explicit tool list is cut down to finish/present/ask (three tools,
 * AgentController's allowlist step), because a tool that JHAI does not know the
 * caller can drive is a tool it should not advertise.
 *
 * The visible result was a run from the composer's own box that could not read
 * a file. Anything this app starts belongs here; the name of a new entry point
 * has to be added on the day it is invented.
 */
export const INTERACTIVE_CALLERS = [
    'DirectChat', 'Schedule', 'NewTask', 'Composer', 'Job', 'Trigger',
];

/**
 * True when `caller` names something OTHER than JHAI's own interactive UI —
 * i.e. an external tool invoked the task via the REST API.
 *
 * A missing/empty caller is treated as internal (fail-safe): we cannot prove it
 * is external, so we keep the current behavior and notify.
 * @param {string|null|undefined} caller
 * @returns {boolean}
 */
export function isExternalCaller(caller) {
    return !!caller && !INTERACTIVE_CALLERS.includes(caller);
}
