// mcpSelection — which MCP servers a new task uses by default.
//
// The default used to be "whatever is running": a server registered in
// Settings → MCP but not yet started was unchecked, so whether a task got its
// tools depended on something the user could not see — had Chat, or an
// earlier task, happened to start it? Registered now means used.
//
// What the user turns OFF is remembered (per server name, across sends and
// restarts), so "default on" never forces a server back on that they chose to
// leave out. A server added later is not in that list, so it starts on.
//
// A config entry with `"disabled": true` is the persistent, config-level way
// to keep one registered but unused — the same key other MCP hosts use.

const OFF_KEY = 'jhai_mcp_off';

/** Names the user has turned off. Empty when storage is unavailable. */
export function loadMcpOff() {
    try {
        const v = JSON.parse(localStorage.getItem(OFF_KEY) || '[]');
        return Array.isArray(v) ? v.filter(n => typeof n === 'string') : [];
    } catch (_) { return []; }
}

export function saveMcpOff(names) {
    try { localStorage.setItem(OFF_KEY, JSON.stringify([...new Set(names)])); }
    catch (_) { /* private mode */ }
}

/** Registered servers that are not disabled in config. */
export function availableMcp(servers = {}) {
    return Object.entries(servers || {})
        .filter(([, cfg]) => !(cfg && cfg.disabled === true))
        .map(([name]) => name);
}

/** The default selection: every available server the user has not turned off. */
export function defaultMcpSelection(servers = {}, off = loadMcpOff()) {
    const offSet = new Set(off);
    return availableMcp(servers).filter(n => !offSet.has(n));
}

/**
 * Record one toggle and return the new selection.
 *
 * The off-list is updated rather than the on-list, so a server registered
 * after this call still defaults to on.
 */
export function toggleMcpSelection(selected, name, on) {
    const next = on ? [...new Set([...selected, name])] : selected.filter(n => n !== name);
    const off = new Set(loadMcpOff());
    if (on) off.delete(name); else off.add(name);
    saveMcpOff([...off]);
    return next;
}
