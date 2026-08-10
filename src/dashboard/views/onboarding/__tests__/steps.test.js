// When first-run setup should be offered, and where it should resume.
//
// The two decisions worth pinning are both easy to get wrong invisibly: asking about
// the REAL config rather than a has-run flag, and remembering a skip but not a
// completion.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    SKIP_KEY, readSetupState, shouldShowOnboarding, initialStep, canAdvance,
    rememberSkip, clearSkip, STEPS,
} from '../steps.js';

/** A minimal Storage stand-in, plus one that throws like private mode. */
const makeStorage = () => {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        _map: map,
    };
};
const hostileStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
};

const keyless = (id) => id === 'ollama';
let store;
beforeEach(() => { store = makeStorage(); });

describe('readSetupState', () => {
    it('counts a complete connection', () => {
        const s = readSetupState({
            llm_instances: [{ provider: 'openai', model: 'gpt-4o', api_key: 'sk-x' }],
        }, keyless, store);
        expect(s.hasConnection).toBe(true);
    });

    it('does NOT count a half-filled connection', () => {
        // Counting one would send the user straight into a failing agent run, which
        // is a worse first experience than the wizard.
        for (const inst of [
            { provider: 'openai', model: 'gpt-4o' },              // no key
            { provider: 'openai', api_key: 'sk-x' },              // no model
            { model: 'gpt-4o', api_key: 'sk-x' },                 // no provider
            { provider: 'openai', model: '  ', api_key: 'sk-x' }, // blank model
        ]) {
            expect(readSetupState({ llm_instances: [inst] }, keyless, store).hasConnection,
                JSON.stringify(inst)).toBe(false);
        }
    });

    it('counts a KEYLESS provider with no key', () => {
        const s = readSetupState({
            llm_instances: [{ provider: 'ollama', model: 'qwen3.5:9b' }],
        }, keyless, store);
        expect(s.hasConnection).toBe(true);
    });

    it('counts a workspace only when it is a real path', () => {
        expect(readSetupState({ approved_projects: ['C:/proj'] }, keyless, store).hasWorkspace).toBe(true);
        expect(readSetupState({ approved_projects: ['  ', ''] }, keyless, store).hasWorkspace).toBe(false);
        expect(readSetupState({}, keyless, store).hasWorkspace).toBe(false);
    });

    it('reads a remembered skip', () => {
        store.setItem(SKIP_KEY, '1');
        expect(readSetupState({}, keyless, store).skipped).toBe(true);
    });

    it('survives a missing or hostile storage', () => {
        expect(readSetupState({}, keyless, null).skipped).toBe(false);
        expect(readSetupState({}, keyless, hostileStorage).skipped).toBe(false);
    });

    it('survives an empty config', () => {
        const s = readSetupState(null, keyless, store);
        expect(s).toEqual({ hasConnection: false, hasWorkspace: false, skipped: false });
    });
});

describe('shouldShowOnboarding', () => {
    it('opens when there is no usable connection', () => {
        expect(shouldShowOnboarding({ hasConnection: false, hasWorkspace: false, skipped: false })).toBe(true);
    });

    it('stays away once a connection exists', () => {
        // Someone who configured everything by hand must never see it.
        expect(shouldShowOnboarding({ hasConnection: true, hasWorkspace: false, skipped: false })).toBe(false);
    });

    it('does NOT open for a missing workspace alone', () => {
        // Chat, research and document work need no project folder; interrupting for
        // one would be nagging about something optional.
        expect(shouldShowOnboarding({ hasConnection: true, hasWorkspace: false, skipped: false })).toBe(false);
    });

    it('respects a remembered skip', () => {
        expect(shouldShowOnboarding({ hasConnection: false, hasWorkspace: false, skipped: true })).toBe(false);
    });

    it('re-opens for a user whose connection was deleted', () => {
        // Reality, not history: they are a new user again.
        expect(shouldShowOnboarding({ hasConnection: false, hasWorkspace: true, skipped: false })).toBe(true);
    });

    it('is false for no state at all', () => {
        expect(shouldShowOnboarding(null)).toBe(false);
    });
});

describe('initialStep', () => {
    it('starts at the connection step when there is none', () => {
        expect(initialStep({ hasConnection: false, hasWorkspace: false })).toBe(0);
    });

    it('RESUMES at the workspace step when the connection is done', () => {
        // Walking someone through a step they already finished is why "resume" exists.
        expect(initialStep({ hasConnection: true, hasWorkspace: false })).toBe(1);
    });

    it('lands on the summary when everything is set', () => {
        expect(initialStep({ hasConnection: true, hasWorkspace: true })).toBe(STEPS.length - 1);
    });

    it('never resumes onto the summary for an unfinished setup', () => {
        // Landing there would say "done" to someone who is not.
        expect(initialStep({ hasConnection: false, hasWorkspace: true })).toBe(0);
    });
});

describe('canAdvance', () => {
    it('gates the first step on the connection', () => {
        // Without it nothing downstream works, so advancing only postpones the dead end.
        expect(canAdvance(0, { hasConnection: false })).toBe(false);
        expect(canAdvance(0, { hasConnection: true })).toBe(true);
    });

    it('leaves the optional steps open', () => {
        expect(canAdvance(1, { hasConnection: true, hasWorkspace: false })).toBe(true);
    });
});

describe('rememberSkip / clearSkip', () => {
    it('round-trips through storage', () => {
        rememberSkip(store);
        expect(readSetupState({}, keyless, store).skipped).toBe(true);
        clearSkip(store);
        expect(readSetupState({}, keyless, store).skipped).toBe(false);
    });

    it('does not throw on a hostile storage', () => {
        expect(() => rememberSkip(hostileStorage)).not.toThrow();
        expect(() => clearSkip(null)).not.toThrow();
    });
});

describe('STEPS', () => {
    it('describes three steps, each with a title and a reason', () => {
        expect(STEPS).toHaveLength(3);
        for (const s of STEPS) {
            expect(s.id).toBeTruthy();
            expect(s.title).toBeTruthy();
            expect(s.blurb).toBeTruthy();
        }
    });

    it('leads with the connection — the one thing nothing works without', () => {
        expect(STEPS[0].id).toBe('connect');
    });
});
