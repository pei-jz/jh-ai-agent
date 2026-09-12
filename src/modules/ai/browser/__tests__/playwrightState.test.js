// playwrightState — the gate that used to be a one-way door.

import { describe, it, expect } from 'vitest';
import {
    readBrowserState, markBrowserAvailable, markBrowserUnavailable,
    clearBrowserProbe, isMissingPlaywright, UNAVAILABLE_KEY, PROBE_KEY,
} from '../playwrightState.js';

/** A localStorage stand-in; the real one is absent in the headless runtime. */
const fakeStore = (seed = {}) => {
    const map = { ...seed };
    return {
        map,
        getItem: (k) => (k in map ? map[k] : null),
        setItem: (k, v) => { map[k] = String(v); },
        removeItem: (k) => { delete map[k]; },
    };
};

describe('readBrowserState', () => {
    // Not a synonym for "ok": nothing has been tried, so claiming the feature
    // works would be a guess the UI presents as fact.
    it('starts unknown, distinct from ok', () => {
        expect(readBrowserState(fakeStore())).toEqual({ state: 'unknown', reason: '', checkedAt: null });
    });

    it('reports a failure with the reason that caused it', () => {
        const s = fakeStore();
        markBrowserUnavailable('Playwright is not installed', s, 1700);
        expect(readBrowserState(s)).toEqual({
            state: 'unavailable', reason: 'Playwright is not installed', checkedAt: 1700,
        });
    });

    it('reports success', () => {
        const s = fakeStore();
        markBrowserAvailable(s, 1800);
        expect(readBrowserState(s)).toMatchObject({ state: 'ok', checkedAt: 1800 });
    });

    // The flag is the contract tools/toolGroups.js reads directly; a corrupt
    // diagnosis entry must not be able to unlatch the gate.
    it('still reports unavailable when the probe entry is corrupt', () => {
        const s = fakeStore({ [UNAVAILABLE_KEY]: '1', [PROBE_KEY]: '{not json' });
        expect(readBrowserState(s).state).toBe('unavailable');
    });

    it('survives having no storage at all (headless runtime)', () => {
        expect(readBrowserState({ getItem: () => { throw new Error('blocked'); } }).state).toBe('unknown');
        expect(() => markBrowserUnavailable('x', null)).not.toThrow();
    });
});

describe('the way back', () => {
    // The bug this module exists for: a failure hid the tools, hiding the tools
    // stopped any call being made, and only a call could clear the flag. An
    // install could not be noticed. Both of these are the escape.
    it('a later success clears the latch', () => {
        const s = fakeStore();
        markBrowserUnavailable('Playwright is not installed', s);
        markBrowserAvailable(s);
        expect(s.getItem(UNAVAILABLE_KEY)).toBe(null);
        expect(readBrowserState(s).state).toBe('ok');
    });

    it('an explicit clear returns the feature to unknown', () => {
        const s = fakeStore();
        markBrowserUnavailable('Playwright is not installed', s);
        clearBrowserProbe(s);
        expect(s.getItem(UNAVAILABLE_KEY)).toBe(null);
        expect(readBrowserState(s)).toEqual({ state: 'unknown', reason: '', checkedAt: null });
    });
});

describe('isMissingPlaywright', () => {
    it('matches the two messages the worker actually produces', () => {
        expect(isMissingPlaywright('Playwright is not installed (or not resolvable ...)')).toBe(true);
        expect(isMissingPlaywright('playwright not resolvable from the project')).toBe(true);
    });

    // Latching on these would hide the whole group over one bad selector.
    it('does not match ordinary browsing failures', () => {
        expect(isMissingPlaywright('browser request timed out (click)')).toBe(false);
        expect(isMissingPlaywright('Timeout 10000ms exceeded waiting for selector "#go"')).toBe(false);
        expect(isMissingPlaywright(undefined)).toBe(false);
    });
});
