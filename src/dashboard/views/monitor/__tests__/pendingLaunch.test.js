// The Dashboard → Work handoff. What matters is that it is SINGLE-READ and that
// it never touches storage — both are the reasons it replaced
// localStorage['jh_open_new_task'] (docs/design/information-architecture.md §7).

import { describe, it, expect, beforeEach } from 'vitest';
import { setPendingLaunch, takePendingLaunch, hasPendingLaunch } from '../pendingLaunch.js';

describe('pendingLaunch', () => {
    beforeEach(() => setPendingLaunch(null));

    it('hands the queued launch to the first reader', () => {
        setPendingLaunch({ prompt: 'ship it', ws: 'C:/proj' });
        expect(takePendingLaunch()).toEqual({ prompt: 'ship it', ws: 'C:/proj' });
    });

    it('is empty for the SECOND reader — a consumed launch must not re-fire', () => {
        setPendingLaunch({ prompt: 'ship it', ws: 'C:/proj' });
        takePendingLaunch();
        expect(takePendingLaunch()).toBeNull();
        expect(hasPendingLaunch()).toBe(false);
    });

    it('returns null when nothing was queued', () => {
        expect(takePendingLaunch()).toBeNull();
    });

    it('copies, so the caller mutating its own state cannot change what is queued', () => {
        const live = { prompt: 'first', ws: 'C:/a' };
        setPendingLaunch(live);
        live.prompt = 'second';
        expect(takePendingLaunch().prompt).toBe('first');
    });

    it('coerces missing fields rather than handing on undefined', () => {
        setPendingLaunch({ prompt: 'only a prompt' });
        expect(takePendingLaunch()).toEqual({ prompt: 'only a prompt', ws: '' });
    });

    it('setPendingLaunch(null) clears a queued launch', () => {
        setPendingLaunch({ prompt: 'x', ws: 'y' });
        setPendingLaunch(null);
        expect(hasPendingLaunch()).toBe(false);
    });

    // This file runs WITHOUT jsdom, so there is no `localStorage` global at all.
    // That a round trip works here is the assertion: the handoff cannot be
    // touching storage, and it cannot throw where storage is unavailable —
    // which is the failure mode the old localStorage channel had to guard.
    it('works with no storage in the environment at all', () => {
        expect(typeof localStorage).toBe('undefined');
        setPendingLaunch({ prompt: 'secret plan', ws: 'C:/proj' });
        expect(takePendingLaunch().prompt).toBe('secret plan');
    });
});
