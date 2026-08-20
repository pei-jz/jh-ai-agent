// paneLayout — the resizable columns, without a pointer.

import { describe, it, expect, vi } from 'vitest';
import {
    PANE_W_MIN, PANE_W_MAX, LEFT_KEY, LEFT_VAR, INSP_VAR,
    isValidWidth, readWidth, writeWidth, dragWidth, applyWidths, isAtBottom,
} from '../paneLayout.js';

/** A localStorage stand-in, optionally one that throws (private mode / quota). */
function storageOf(seed = {}, { throws = false } = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (k) => { if (throws) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
        setItem: (k, v) => { if (throws) throw new Error('quota'); map.set(k, v); },
        _map: map,
    };
}

describe('isValidWidth', () => {
    it('accepts the bounds and everything between', () => {
        expect(isValidWidth(PANE_W_MIN)).toBe(true);
        expect(isValidWidth(PANE_W_MAX)).toBe(true);
        expect(isValidWidth(300)).toBe(true);
    });

    it('rejects anything outside them, and anything that is not a number', () => {
        expect(isValidWidth(PANE_W_MIN - 1)).toBe(false);
        expect(isValidWidth(PANE_W_MAX + 1)).toBe(false);
        expect(isValidWidth(NaN)).toBe(false);
        expect(isValidWidth(Infinity)).toBe(false);
        expect(isValidWidth(undefined)).toBe(false);
    });
});

describe('readWidth', () => {
    it('returns what was stored', () => {
        expect(readWidth(LEFT_KEY, 240, storageOf({ [LEFT_KEY]: '320' }))).toBe(320);
    });

    it('falls back when nothing was stored', () => {
        expect(readWidth(LEFT_KEY, 240, storageOf())).toBe(240);
    });

    // Out of range means the bounds changed since it was written; the default is
    // a better guess than an edge of the new range.
    it('ignores an out-of-range value rather than clamping it', () => {
        expect(readWidth(LEFT_KEY, 240, storageOf({ [LEFT_KEY]: '9999' }))).toBe(240);
        expect(readWidth(LEFT_KEY, 240, storageOf({ [LEFT_KEY]: '10' }))).toBe(240);
    });

    it('falls back on junk and on unavailable storage', () => {
        expect(readWidth(LEFT_KEY, 240, storageOf({ [LEFT_KEY]: 'wide' }))).toBe(240);
        expect(readWidth(LEFT_KEY, 240, storageOf({}, { throws: true }))).toBe(240);
        expect(readWidth(LEFT_KEY, 240, undefined)).toBe(240);
    });
});

describe('writeWidth', () => {
    it('stores the width as a string', () => {
        const s = storageOf();
        writeWidth(LEFT_KEY, 300, s);
        expect(s._map.get(LEFT_KEY)).toBe('300');
    });

    it('does not throw when storage refuses', () => {
        expect(() => writeWidth(LEFT_KEY, 300, storageOf({}, { throws: true }))).not.toThrow();
        expect(() => writeWidth(LEFT_KEY, 300, undefined)).not.toThrow();
    });
});

describe('dragWidth', () => {
    // Adding dx to the LIVE width double-counted it, so the pane ran ahead of
    // the cursor and snapped between positions instead of sliding.
    it('measures from the width the drag STARTED at', () => {
        expect(dragWidth(240, 40, 'left')).toBe(280);
        expect(dragWidth(240, 80, 'left')).toBe(320);   // same base, bigger delta
    });

    // Dragging the right edge leftwards makes the inspector wider.
    it('inverts the delta on the right edge', () => {
        expect(dragWidth(264, -40, 'right')).toBe(304);
        expect(dragWidth(264, 40, 'right')).toBe(224);
    });

    it('refuses a move that would leave the allowed range', () => {
        expect(dragWidth(PANE_W_MIN, -1, 'left')).toBeNull();
        expect(dragWidth(PANE_W_MAX, 1, 'left')).toBeNull();
        expect(dragWidth(PANE_W_MIN, 1, 'right')).toBeNull();
    });

    it('allows a move that lands exactly on a bound', () => {
        expect(dragWidth(PANE_W_MIN + 10, -10, 'left')).toBe(PANE_W_MIN);
        expect(dragWidth(PANE_W_MAX - 10, 10, 'left')).toBe(PANE_W_MAX);
    });

    it('treats an unnamed edge as the left one', () => {
        expect(dragWidth(240, 20)).toBe(260);
    });
});

describe('applyWidths', () => {
    // The panes read these variables. An inline `width` looks right until the
    // next re-render, when the variable wins again and the pane snaps back.
    it('writes both custom properties on the layout root', () => {
        const set = vi.fn();
        applyWidths({ style: { setProperty: set } }, { left: 300, insp: 280 });
        expect(set).toHaveBeenCalledWith(LEFT_VAR, '300px');
        expect(set).toHaveBeenCalledWith(INSP_VAR, '280px');
    });

    it('writes only the width it was given', () => {
        const set = vi.fn();
        applyWidths({ style: { setProperty: set } }, { left: 300 });
        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith(LEFT_VAR, '300px');
    });

    it('does nothing without a layout root', () => {
        expect(() => applyWidths(null, { left: 300 })).not.toThrow();
    });
});

describe('isAtBottom', () => {
    const el = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });

    it('is true at the bottom and within the slack above it', () => {
        expect(isAtBottom(el(1000, 500, 500))).toBe(true);
        expect(isAtBottom(el(1000, 400, 500))).toBe(true);    // 100px up, inside 120
    });

    it('is false once the reader has scrolled meaningfully up', () => {
        expect(isAtBottom(el(1000, 200, 500))).toBe(false);
    });

    it('takes the slack as a parameter', () => {
        expect(isAtBottom(el(1000, 400, 500), 50)).toBe(false);
    });

    // No element means nothing has scrolled away, so following is correct.
    it('is true when there is no element', () => {
        expect(isAtBottom(null)).toBe(true);
    });
});
