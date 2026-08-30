// pendingLaunch — the Dashboard → Work handoff, held in memory for one read.
//
// This replaces `localStorage['jh_open_new_task']`. That key existed because the
// launcher and the list it launches into were two different VIEWS, and there was
// no other channel between them — but they are two regions of one process, and
// writing to disk to cross a function-call-sized gap had costs:
//
//   • it survived a crash, so a task the user abandoned could re-open the
//     composer on the next launch (the reader had to defend against a stale
//     value, and against a bare '1' written by an older build);
//   • it put the user's prompt on disk, where nothing else about a draft goes;
//   • it made the handoff invisible to tests unless they stubbed storage.
//
// The handoff is deliberately SINGLE-READ: `take` clears it. A launch that was
// consumed must not fire again when the user navigates back to Work, and making
// that a property of the channel means no caller has to remember to clear it.
//
// docs/design/information-architecture.md §7 step 1.

/** @typedef {{ prompt: string, ws: string }} Launch */

/** @type {Launch|null} */
let pending = null;

/**
 * Queue a launch for whoever mounts Work next.
 *
 * Copied rather than stored by reference: the caller's object is usually its own
 * component state, and it keeps mutating after this returns.
 */
export function setPendingLaunch(launch) {
    if (!launch) { pending = null; return; }
    pending = {
        prompt: String(launch.prompt || ''),
        ws: String(launch.ws || ''),
    };
}

/**
 * Consume the queued launch, if any.
 * @returns {Launch|null} — and afterwards there is nothing queued.
 */
export function takePendingLaunch() {
    const p = pending;
    pending = null;
    return p;
}

/** Whether a launch is waiting. Exposed for tests; production code uses `take`. */
export function hasPendingLaunch() {
    return pending !== null;
}
