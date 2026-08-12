// workspaceMemory — reading and writing `<workspace>/.agent/`.
//
// Extracted from ConfigView when the Dashboard grew a memory panel. The
// alternative was copying four path strings and three parsers into a second
// view, which is precisely the "one meaning, two supply sources" pattern that
// has already produced three bugs in this codebase (live-vs-replay timelines,
// the document card markup, the inspector's zeroed tokens). Two readers of
// cards.jsonl would have drifted the same way.
//
// The file layout is not symmetrical and that is deliberate, so it is written
// down here rather than rediscovered:
//
//   long_term/facts.json   a JSON ARRAY, rewritten whole
//   memory.json            a JSON ARRAY, rewritten whole
//   memory/cards.jsonl     JSON LINES — the agent APPENDS to it per session, so
//                          it must stay one-object-per-line and end with a
//                          newline. Writing it as a JSON array would corrupt the
//                          next append.

/** Absolute paths for one workspace's memory files. */
export function memoryPaths(workspace) {
    const root = String(workspace || '').replace(/[\\/]+$/, '');
    return {
        dir: `${root}/.agent`,
        facts: `${root}/.agent/long_term/facts.json`,
        episodes: `${root}/.agent/memory.json`,
        cards: `${root}/.agent/memory/cards.jsonl`,
    };
}

/** Parse a cards.jsonl body. A corrupt line is dropped, never fatal. */
export function parseCardsJsonl(raw) {
    return String(raw || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
}

/** Serialize cards back to JSON Lines, with the trailing newline appends need. */
export function serializeCardsJsonl(cards) {
    const body = (Array.isArray(cards) ? cards : []).map(c => JSON.stringify(c)).join('\n');
    return body ? `${body}\n` : '';
}

/**
 * Read all three stores. Each is independent: a missing or corrupt file yields
 * an empty list rather than failing the other two, because a workspace the agent
 * has only chatted in legitimately has facts and no cards.
 *
 * @param {string} workspace
 * @param {(cmd: string, args: object) => Promise<any>} invoke
 * @returns {Promise<{facts: object[], episodes: object[], cards: object[]}>}
 */
export async function readWorkspaceMemory(workspace, invoke) {
    const empty = { facts: [], episodes: [], cards: [] };
    if (!workspace || typeof invoke !== 'function') return empty;
    const p = memoryPaths(workspace);

    const readJsonArray = async (path) => {
        try {
            const raw = await invoke('read_file', { path });
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
    };

    const [facts, episodes] = await Promise.all([
        readJsonArray(p.facts),
        readJsonArray(p.episodes),
    ]);
    let cards = [];
    try {
        cards = parseCardsJsonl(await invoke('read_file', { path: p.cards }));
    } catch (_) { cards = []; }

    return { facts, episodes, cards };
}

/**
 * Register `<workspace>/.agent` with the path guard before writing to it.
 *
 * Reads are ungated, writes are not, and the guard only knows workspaces an
 * AGENT SESSION has opened — so editing the memory of a project the agent has
 * not run in this app session failed outright ("outside all allowed roots").
 * Editing here IS the approval; the grant is scoped to `.agent`, never the
 * whole workspace.
 *
 * Never throws: an older backend without the command may still permit the write
 * if the root is already registered, and turning that into a hard failure would
 * break saving for no reason.
 */
export async function allowMemoryDir(workspace, invoke) {
    try {
        await invoke('set_allowed_roots', { roots: [memoryPaths(workspace).dir] });
    } catch (e) {
        console.warn('Failed to register the memory directory as a path-guard root:', e);
    }
}

/** Write cards.jsonl, registering the directory first. */
export async function writeCards(workspace, cards, invoke) {
    await allowMemoryDir(workspace, invoke);
    await invoke('write_file', {
        path: memoryPaths(workspace).cards,
        content: serializeCardsJsonl(cards),
    });
}

/** Write facts.json, registering the directory first. */
export async function writeFacts(workspace, facts, invoke) {
    await allowMemoryDir(workspace, invoke);
    await invoke('write_file', {
        path: memoryPaths(workspace).facts,
        content: JSON.stringify(facts || [], null, 2),
    });
}

/** Write memory.json (episodes), registering the directory first. */
export async function writeEpisodes(workspace, episodes, invoke) {
    await allowMemoryDir(workspace, invoke);
    await invoke('write_file', {
        path: memoryPaths(workspace).episodes,
        content: JSON.stringify(episodes || [], null, 2),
    });
}
