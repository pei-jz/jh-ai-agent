// errorReporter — the channel an async failure takes to reach a person.
//
// There was none. `src/` had no `unhandledrejection` and no `window.onerror`,
// and a release build has no devtools — so a rejected promise inside a Svelte
// effect, a socket handler or a tool path simply vanished. The failure mode was
// visible in testing: running the frontend outside Tauri produced a window with
// a title bar and nothing else, and no message anywhere.
//
// Two outputs, because they answer different questions:
//
//   • a toast — "something failed just now", so the user knows the blank panel
//     is a fault and not a slow request;
//   • a rotating file — so a bug report can carry the stack instead of a
//     description of a stack.
//
// Deliberately NOT a modal: most of these are recoverable and the user is in
// the middle of something. Deliberately not silent either, which is what an
// app with neither has chosen without saying so.
//
// Report_20260829.md §1 proposal 8.

/** How many entries the in-memory ring keeps, for the "copy" action. */
const RING = 50;
/** Identical errors inside this window are counted, not repeated. */
const DEDUPE_MS = 3000;

const recent = [];
let lastKey = '';
let lastAt = 0;
let installed = false;

/** A stable-ish identity for an error, so a loop does not produce 400 toasts. */
function keyOf(message, source) {
    return `${source}::${String(message).slice(0, 160)}`;
}

export function describeError(err) {
    if (err == null) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
    // A rejected promise can carry anything — a Tauri command rejects with a
    // plain string, an HTTP layer with a response object.
    try { return JSON.stringify(err); } catch (_) { return String(err); }
}

/** Everything captured this session, newest last. Used by "copy diagnostics". */
export function recentErrors() {
    return recent.slice();
}

/**
 * Record one failure.
 *
 * @param {unknown} err
 * @param {string} source where it came from ('unhandledrejection', 'window.onerror', …)
 * @param {object} deps injected for tests: {toast, write, now}
 * @returns {boolean} false when it was suppressed as a duplicate
 */
export function report(err, source = 'error', {
    toast = null, write = null, now = () => Date.now(),
} = {}) {
    const text = describeError(err);
    const at = now();
    const key = keyOf(text, source);

    // A failing interval or a retry loop can raise the same error many times a
    // second. Reporting each one buries everything else that happened.
    if (key === lastKey && at - lastAt < DEDUPE_MS) return false;
    lastKey = key;
    lastAt = at;

    const entry = { at: new Date(at).toISOString(), source, text };
    recent.push(entry);
    if (recent.length > RING) recent.shift();

    // Always the console first: it is the one output that cannot itself fail.
    console.error(`[${source}]`, err);
    try { toast?.(text.split('\n')[0]); } catch (_) { /* a broken toast must not throw here */ }
    try { write?.(entry); } catch (_) { /* nor a failing log write */ }
    return true;
}

/**
 * Attach to the two events that carry what nothing else catches.
 *
 * Idempotent: main.js may run twice in a window (the spotlight bundle is the
 * same file), and two handlers would double every report.
 *
 * @returns {() => void} detach, for tests.
 */
export function install({ target = globalThis, toast = null, write = null } = {}) {
    if (installed) return () => {};
    installed = true;

    const onRejection = (e) => report(e?.reason, 'unhandledrejection', { toast, write });
    const onError = (e) => report(e?.error ?? e?.message, 'window.onerror', { toast, write });

    target.addEventListener?.('unhandledrejection', onRejection);
    target.addEventListener?.('error', onError);

    return () => {
        target.removeEventListener?.('unhandledrejection', onRejection);
        target.removeEventListener?.('error', onError);
        installed = false;
    };
}

/** Test seam — the module keeps state so it can dedupe and stay idempotent. */
export function _reset() {
    recent.length = 0;
    lastKey = '';
    lastAt = 0;
    installed = false;
}
