// chatSessions — pure session-store helpers extracted from ChatView (Part A
// refactor). The localStorage / Tauri-file I/O stays in ChatView; these are the
// DOM-free data transforms (parse-with-fallback + the 20-session cap), so they
// unit-test directly without jsdom.

const STORAGE_KEY = 'direct_ai_sessions';
const MAX_SESSIONS = 20;

export { STORAGE_KEY, MAX_SESSIONS };

/** Parse the stored sessions blob, falling back to an empty store on bad JSON. */
export function parseSessions(raw) {
    try {
        return JSON.parse(raw || '{"activeSessionId": null, "sessions": {}}');
    } catch {
        return { activeSessionId: null, sessions: {} };
    }
}

/**
 * Cap the store to `max` sessions, dropping the oldest by timestamp. If the
 * active session was dropped, re-point activeSessionId at the newest survivor.
 * Mutates and returns `data` (matching the original ChatView.saveSessions).
 */
export function pruneSessions(data, max = MAX_SESSIONS) {
    const sessions = data.sessions || {};
    const sessionIds = Object.keys(sessions);

    if (sessionIds.length > max) {
        const sorted = Object.values(sessions).sort((a, b) => a.timestamp - b.timestamp);
        const toRemoveCount = sorted.length - max;
        for (let i = 0; i < toRemoveCount; i++) {
            const oldest = sorted[i];
            delete data.sessions[oldest.id];
            if (data.activeSessionId === oldest.id) {
                data.activeSessionId = null;
            }
        }
        if (!data.activeSessionId && Object.keys(data.sessions).length > 0) {
            const remaining = Object.values(data.sessions).sort((a, b) => b.timestamp - a.timestamp);
            data.activeSessionId = remaining[0].id;
        }
    }

    return data;
}
