// playwrightState — whether the optional browser stack is usable, as a value
// the UI can show and the user can reset.
//
// The browser tools need Playwright installed in the project; without it they
// can only fail. So a failed call latches `jhai_playwright_unavailable` and
// tools/toolGroups.js stops advertising the group — no wasted turns, no prompt
// bloat. That much worked.
//
// What did NOT work was getting back. The flag was cleared in exactly one
// place: a SUCCESSFUL browser call. But once the flag is set the tools are
// hidden from the model, so no browser call is ever made, so no call ever
// succeeds — a latch with no reset. Installing Playwright afterwards changed
// nothing, and since nothing was ever displayed, there was no way to find that
// out either. This module is that missing half: the reason and the timestamp
// the UI needs, plus an explicit clear.
//
// The '1' flag keeps its old key and old shape — toolGroups.readToolGroupState
// still reads it directly, and this module must not break that contract. The
// diagnosis rides alongside in a second key rather than reshaping the first.

/** Latched by a failed call; read by tools/toolGroups.js. Values: '1' or absent. */
export const UNAVAILABLE_KEY = 'jhai_playwright_unavailable';
/** Why and when — for display only. JSON: { reason, checkedAt }. */
export const PROBE_KEY = 'jhai_playwright_probe';

/** The install line. One definition: the UI shows it and the worker echoes it. */
export const INSTALL_COMMAND = 'npm i -D playwright && npx playwright install chromium';

/** localStorage is absent in the headless runtime and in unit tests. */
function store(storage) {
    if (storage) return storage;
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (_) {
        return null;   // some embeddings throw on access rather than returning undefined
    }
}

/**
 * @typedef {{state:'unknown'|'ok'|'unavailable', reason:string, checkedAt:number|null}} BrowserState
 *
 * `unknown` is a real third state, not a synonym for `ok`: nothing has been
 * tried yet. The UI must not claim the feature works on that basis — it has no
 * evidence either way — and saying "利用可" when the first call may still fail
 * is the kind of small lie that costs a support conversation.
 */

/** @returns {BrowserState} */
export function readBrowserState(storage = null) {
    const s = store(storage);
    const out = { state: 'unknown', reason: '', checkedAt: null };
    if (!s) return out;
    let probe = {};
    try {
        const raw = s.getItem(PROBE_KEY);
        if (raw) probe = JSON.parse(raw) || {};
    } catch (_) { /* corrupt entry reads as no probe */ }
    if (typeof probe.reason === 'string') out.reason = probe.reason;
    if (Number.isFinite(probe.checkedAt)) out.checkedAt = probe.checkedAt;
    try {
        if (s.getItem(UNAVAILABLE_KEY) === '1') out.state = 'unavailable';
        else if (probe.ok === true) out.state = 'ok';
    } catch (_) { /* leave unknown */ }
    return out;
}

/** Record a failure: latch the flag AND keep the message that explains it. */
export function markBrowserUnavailable(reason, storage = null, now = Date.now()) {
    const s = store(storage);
    if (!s) return;
    try {
        s.setItem(UNAVAILABLE_KEY, '1');
        s.setItem(PROBE_KEY, JSON.stringify({ ok: false, reason: String(reason || ''), checkedAt: now }));
    } catch (_) { /* storage full or blocked — the gate just stays where it was */ }
}

/** Record a success: drop the latch so the tools are advertised again. */
export function markBrowserAvailable(storage = null, now = Date.now()) {
    const s = store(storage);
    if (!s) return;
    try {
        s.removeItem(UNAVAILABLE_KEY);
        s.setItem(PROBE_KEY, JSON.stringify({ ok: true, reason: '', checkedAt: now }));
    } catch (_) { /* as above */ }
}

/**
 * Forget everything we think we know, returning the feature to `unknown`.
 *
 * The escape hatch for the case the latch cannot handle on its own: the user
 * installed Playwright after a failure. Re-probing is better, but this must
 * work even when the probe itself cannot run (no Node on PATH, say), so it
 * stays a plain clear rather than anything conditional.
 */
export function clearBrowserProbe(storage = null) {
    const s = store(storage);
    if (!s) return;
    try {
        s.removeItem(UNAVAILABLE_KEY);
        s.removeItem(PROBE_KEY);
    } catch (_) { /* nothing to do */ }
}

/**
 * Does this error message mean "Playwright isn't there" rather than "that page
 * timed out"? Only the former should latch the gate — hiding the tools because
 * one selector was wrong would be a much worse bug than the one this fixes.
 */
export function isMissingPlaywright(message) {
    return /not installed|not resolvable/i.test(String(message || ''));
}
