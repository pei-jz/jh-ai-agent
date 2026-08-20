// paneLayout — the Monitor's three resizable columns, as arithmetic.
//
// Extracted from MonitorView._bindPaneDividers / _applyPaneWidths, where the
// clamping, the drag arithmetic and the localStorage round-trip were interleaved
// with pointer-event plumbing and `style.setProperty` calls, so none of it could
// be checked without a real pointer drag.
//
// Two rules here are the fixes for reported symptoms:
//
//   • a drag is ONE session. The base width is snapshotted on pointerdown and
//     every move applies `base + dx`. Adding dx to the LIVE width double-counted
//     it — the pane ran ahead of the cursor and snapped between positions
//     instead of sliding.
//   • the RIGHT edge moves the opposite way: dragging it left makes the
//     inspector WIDER, so its delta is subtracted.

/** Never let a pane collapse to nothing… */
export const PANE_W_MIN = 180;
/** …or eat the whole window. */
export const PANE_W_MAX = 640;

export const LEFT_KEY = 'jhai_monitor_left_width';
export const INSP_KEY = 'jhai_monitor_insp_width';
export const LEFT_DEFAULT = 240;
export const INSP_DEFAULT = 264;

/** The CSS custom properties the panes size themselves from. */
export const LEFT_VAR = '--mpane-left-w';
export const INSP_VAR = '--mpane-insp-w';

/** Is this a width we are willing to store or apply? */
export function isValidWidth(w) {
    return Number.isFinite(w) && w >= PANE_W_MIN && w <= PANE_W_MAX;
}

/**
 * The remembered width for an edge, or the fallback.
 *
 * A stored value outside the range is IGNORED rather than clamped: it means the
 * bounds changed since it was written, and the default is a better guess than
 * an edge of the new range.
 */
export function readWidth(key, fallback, storage = globalThis.localStorage) {
    try {
        const v = parseInt(storage?.getItem(key), 10);
        if (isValidWidth(v)) return v;
    } catch (_) { /* storage unavailable */ }
    return fallback;
}

export function writeWidth(key, width, storage = globalThis.localStorage) {
    try { storage?.setItem(key, String(width)); } catch (_) { /* quota / unavailable */ }
}

/**
 * Where an edge lands during a drag, or null when the move is out of bounds.
 *
 * @param {number} base   the width when the drag started — NOT the live width
 * @param {number} dx     cursor movement since then
 * @param {'left'|'right'} edge  which edge is being dragged
 */
export function dragWidth(base, dx, edge = 'left') {
    const w = edge === 'right' ? base - dx : base + dx;
    return isValidWidth(w) ? w : null;
}

/**
 * Push widths onto the layout root as custom properties.
 *
 * The panes size themselves from var(--mpane-left-w) / var(--mpane-insp-w) (see
 * MonitorView.styles.js and monitor/timelineStyles.js). Writing an inline
 * `width` instead looks right until the next re-render, when the variable wins
 * again and the pane snaps back.
 */
export function applyWidths(layoutEl, { left, insp }) {
    if (!layoutEl) return;
    if (Number.isFinite(left)) layoutEl.style.setProperty(LEFT_VAR, `${left}px`);
    if (Number.isFinite(insp)) layoutEl.style.setProperty(INSP_VAR, `${insp}px`);
}

/** Is the reader at the bottom, i.e. should new activity keep scrolling into view? */
export function isAtBottom(el, slack = 120) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}
