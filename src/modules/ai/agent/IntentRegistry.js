// IntentRegistry — named AI actions an app declares once and then invokes by id.
//
// An Intent bundles the things that otherwise have to be repeated on every
// request: the persona for this kind of job, the tools it may use, and the shape
// of the result the app knows how to render.
//
//   { id, title?, systemPrompt?, tools?[], resultKind?, tier? }
//
// Until now only the INLINE object form worked — `behavior.intent` as a string
// id was silently ignored (`// string id → future registry; skip`), so every
// caller had to resend the whole definition and two callers could drift apart.
// Apps now declare their intents when they connect (the MCP client asks for them
// during the handshake) and reference them by id thereafter.
//
// Pure: no Tauri, no transport. The manager owns the storage; this owns the
// rules for merging and looking up.

/** Normalize whatever an app declared into the shape the agent expands. */
export function normalizeIntent(raw, appName = '') {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const out = { id, app: appName || '' };
    if (typeof raw.title === 'string' && raw.title.trim()) out.title = raw.title.trim();
    if (typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()) out.systemPrompt = raw.systemPrompt.trim();
    if (Array.isArray(raw.tools)) {
        const tools = raw.tools.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
        if (tools.length) out.tools = tools;
    }
    if (typeof raw.resultKind === 'string' && raw.resultKind.trim()) out.resultKind = raw.resultKind.trim();
    if (typeof raw.tier === 'string' && raw.tier.trim()) out.tier = raw.tier.trim().toLowerCase();
    return out;
}

/**
 * Registry of intents, keyed by id and grouped by the app that declared them.
 * Reconnecting an app REPLACES its set, so a redeploy can't leave stale entries.
 */
export class IntentRegistry {
    constructor() {
        /** id → intent */
        this._byId = new Map();
        /** app name → Set<id> */
        this._byApp = new Map();
    }

    /**
     * Replace everything `appName` had declared with `intents`.
     * @returns {number} how many were accepted
     */
    setForApp(appName, intents) {
        const app = String(appName || '').trim();
        if (!app) return 0;
        this.clearApp(app);
        const ids = new Set();
        for (const raw of (Array.isArray(intents) ? intents : [])) {
            const intent = normalizeIntent(raw, app);
            if (!intent) continue;
            this._byId.set(intent.id, intent);
            ids.add(intent.id);
        }
        if (ids.size) this._byApp.set(app, ids);
        return ids.size;
    }

    /** Drop an app's intents (disconnect / redeploy). */
    clearApp(appName) {
        const app = String(appName || '').trim();
        const ids = this._byApp.get(app);
        if (!ids) return 0;
        for (const id of ids) {
            // Only remove entries still owned by this app.
            if (this._byId.get(id)?.app === app) this._byId.delete(id);
        }
        this._byApp.delete(app);
        return ids.size;
    }

    /** @returns {object|null} the intent, or null when the id is unknown. */
    get(id) {
        const key = String(id || '').trim();
        return key ? (this._byId.get(key) || null) : null;
    }

    /** All intents, optionally scoped to one app. */
    list(appName = null) {
        const all = [...this._byId.values()];
        if (!appName) return all;
        const app = String(appName).trim();
        return all.filter(i => i.app === app);
    }

    get size() { return this._byId.size; }
}

/**
 * Resolve `behavior.intent` into the concrete object the agent expands.
 * Accepts the inline object (unchanged behaviour) or a registered id.
 *
 * @param {object|string} intent value of behavior.intent
 * @param {IntentRegistry} registry
 * @returns {{intent: object|null, source: 'inline'|'registry'|'unknown'|'none'}}
 */
export function resolveIntent(intent, registry) {
    if (!intent) return { intent: null, source: 'none' };
    if (typeof intent === 'object') {
        // Inline definitions need no id — they are already the whole thing.
        return { intent, source: 'inline' };
    }
    if (typeof intent === 'string') {
        const found = registry?.get?.(intent) || null;
        return found
            ? { intent: found, source: 'registry' }
            : { intent: null, source: 'unknown' };
    }
    return { intent: null, source: 'none' };
}

/** Shared singleton — the manager fills it as apps connect. */
export const intentRegistry = new IntentRegistry();
