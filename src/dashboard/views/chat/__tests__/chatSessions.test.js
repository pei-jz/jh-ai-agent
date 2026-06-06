import { describe, it, expect } from 'vitest';
import { parseSessions, pruneSessions, MAX_SESSIONS, STORAGE_KEY } from '../chatSessions.js';

describe('parseSessions', () => {
    it('returns empty store for null/empty input', () => {
        expect(parseSessions(null)).toEqual({ activeSessionId: null, sessions: {} });
        expect(parseSessions('')).toEqual({ activeSessionId: null, sessions: {} });
    });

    it('parses valid JSON', () => {
        const blob = JSON.stringify({ activeSessionId: 'a', sessions: { a: { id: 'a' } } });
        expect(parseSessions(blob)).toEqual({ activeSessionId: 'a', sessions: { a: { id: 'a' } } });
    });

    it('falls back to empty store on malformed JSON', () => {
        expect(parseSessions('{not json')).toEqual({ activeSessionId: null, sessions: {} });
    });

    it('exposes the storage key constant', () => {
        expect(STORAGE_KEY).toBe('direct_ai_sessions');
    });
});

describe('pruneSessions', () => {
    const makeStore = (n, activeId = null) => {
        const sessions = {};
        for (let i = 0; i < n; i++) {
            const id = `s${i}`;
            sessions[id] = { id, timestamp: i }; // older = smaller timestamp
        }
        return { activeSessionId: activeId, sessions };
    };

    it('leaves a store at/under the cap untouched', () => {
        const data = makeStore(MAX_SESSIONS, 's3');
        const before = JSON.stringify(data);
        pruneSessions(data);
        expect(JSON.stringify(data)).toBe(before);
        expect(Object.keys(data.sessions)).toHaveLength(MAX_SESSIONS);
    });

    it('drops the oldest sessions beyond the cap', () => {
        const data = makeStore(MAX_SESSIONS + 5, 's25');
        pruneSessions(data);
        expect(Object.keys(data.sessions)).toHaveLength(MAX_SESSIONS);
        // The 5 oldest (s0..s4) should be gone; s25 (active) survives.
        expect(data.sessions.s0).toBeUndefined();
        expect(data.sessions.s4).toBeUndefined();
        expect(data.sessions.s5).toBeDefined();
        expect(data.activeSessionId).toBe('s25');
    });

    it('re-points active to the newest survivor when the active session is pruned', () => {
        // active is the OLDEST (s0), which will be dropped.
        const data = makeStore(MAX_SESSIONS + 3, 's0');
        pruneSessions(data);
        expect(data.sessions.s0).toBeUndefined();
        // newest survivor = highest timestamp = s(n-1)
        const newestId = `s${MAX_SESSIONS + 3 - 1}`;
        expect(data.activeSessionId).toBe(newestId);
    });

    it('respects a custom max', () => {
        const data = makeStore(10, 's9');
        pruneSessions(data, 3);
        expect(Object.keys(data.sessions)).toHaveLength(3);
        expect(data.activeSessionId).toBe('s9');
    });

    it('tolerates a missing sessions object', () => {
        const data = { activeSessionId: null };
        expect(() => pruneSessions(data)).not.toThrow();
    });
});
