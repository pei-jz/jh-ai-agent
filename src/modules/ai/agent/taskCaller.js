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

export const INTERACTIVE_CALLERS = ['DirectChat', 'Schedule', 'NewTask'];

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
