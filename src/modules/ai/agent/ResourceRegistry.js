// ResourceRegistry — the documents an app exposes to the agent (MCP `resources`).
//
// Tools let the agent DO something in an app; resources let it READ what the app
// currently has open — the active JHEditor buffer, a Task board, a query result —
// without that content having to be pasted into the prompt or written to disk.
//
//   { uri, name?, description?, mimeType? }
//
// Two apps can easily pick the same URI ("doc://current"), so entries are keyed
// by "app::uri" and a bare URI only resolves when exactly one app offers it.
// Anything ambiguous is reported rather than guessed at — silently reading the
// wrong app's document is worse than an error the agent can act on.
//
// Pure: no Tauri, no transport. McpManager owns the clients; this owns the
// bookkeeping and the lookup rules.

const SEP = '::';

/** "app::uri" — the unambiguous way to name a resource. */
export function qualifyUri(app, uri) {
    return `${String(app || '').trim()}${SEP}${String(uri || '').trim()}`;
}

/** Split a qualified key back apart. Returns `{app:'', uri}` for a bare URI. */
export function splitRef(ref) {
    const s = String(ref || '').trim();
    const at = s.indexOf(SEP);
    // A scheme like "file://x" contains "//" but never "::" before its first
    // slash, so the first separator is unambiguous when the caller qualified it.
    if (at <= 0) return { app: '', uri: s };
    return { app: s.slice(0, at), uri: s.slice(at + SEP.length) };
}

/** Normalize whatever a server returned from resources/list. */
export function normalizeResource(raw, appName = '') {
    if (!raw || typeof raw !== 'object') return null;
    const uri = String(raw.uri || '').trim();
    if (!uri) return null;
    const out = { uri, app: String(appName || '').trim() };
    for (const f of ['name', 'description', 'mimeType']) {
        if (typeof raw[f] === 'string' && raw[f].trim()) out[f] = raw[f].trim();
    }
    out.key = qualifyUri(out.app, uri);
    return out;
}

export class ResourceRegistry {
    constructor() {
        /** "app::uri" → resource */
        this._byKey = new Map();
        /** app → Set<key> */
        this._byApp = new Map();
    }

    /** Replace everything `appName` had published. @returns {number} accepted */
    setForApp(appName, resources) {
        const app = String(appName || '').trim();
        if (!app) return 0;
        this.clearApp(app);
        const keys = new Set();
        for (const raw of (Array.isArray(resources) ? resources : [])) {
            const r = normalizeResource(raw, app);
            if (!r) continue;
            this._byKey.set(r.key, r);
            keys.add(r.key);
        }
        if (keys.size) this._byApp.set(app, keys);
        return keys.size;
    }

    /** Drop an app's resources (disconnect / redeploy). */
    clearApp(appName) {
        const app = String(appName || '').trim();
        const keys = this._byApp.get(app);
        if (!keys) return 0;
        for (const k of keys) this._byKey.delete(k);
        this._byApp.delete(app);
        return keys.size;
    }

    /** Every resource, optionally scoped to one app. */
    list(appName = null) {
        const all = [...this._byKey.values()];
        if (!appName) return all;
        const app = String(appName).trim();
        return all.filter(r => r.app === app);
    }

    /** All resources matching a bare URI, across apps. */
    findByUri(uri) {
        const u = String(uri || '').trim();
        return u ? [...this._byKey.values()].filter(r => r.uri === u) : [];
    }

    get size() { return this._byKey.size; }
}

/**
 * Resolve what the agent asked for into one concrete resource.
 *
 * @param {string} ref  "app::uri", or a bare "uri" when it is unique
 * @returns {{resource: object|null, error: ''|'not-found'|'ambiguous', candidates: object[]}}
 */
export function resolveResource(ref, registry) {
    const { app, uri } = splitRef(ref);
    if (!uri || !registry) return { resource: null, error: 'not-found', candidates: [] };

    if (app) {
        const hit = registry._byKey.get(qualifyUri(app, uri)) || null;
        return hit
            ? { resource: hit, error: '', candidates: [] }
            : { resource: null, error: 'not-found', candidates: [] };
    }

    const matches = registry.findByUri(uri);
    if (matches.length === 1) return { resource: matches[0], error: '', candidates: [] };
    if (matches.length > 1) return { resource: null, error: 'ambiguous', candidates: matches };
    return { resource: null, error: 'not-found', candidates: [] };
}

/** Flatten an MCP resources/read result into text the agent can consume. */
export function contentsToText(result, maxChars = 40_000) {
    const items = Array.isArray(result?.contents) ? result.contents : [];
    const parts = [];
    for (const c of items) {
        if (typeof c?.text === 'string') {
            parts.push(c.text);
        } else if (typeof c?.blob === 'string') {
            // Binary payloads are base64 in MCP; the agent cannot use those, so
            // say what was skipped instead of dumping the encoding.
            parts.push(`[binary content omitted: ${c.mimeType || 'unknown type'}, ${c.blob.length} base64 chars]`);
        }
    }
    const text = parts.join('\n\n');
    return text.length > maxChars
        ? `${text.slice(0, maxChars)}\n\n… [truncated at ${maxChars} chars]`
        : text;
}

/** Shared singleton — McpManager fills it as apps connect. */
export const resourceRegistry = new ResourceRegistry();
