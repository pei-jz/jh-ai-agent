// hubStrip — the connected apps, made visible.
//
// The AI-Hub is the thing this agent has that a terminal-scoped one cannot:
// JHEditor / Task / ER connect over MCP and offer their tools, their named
// actions (intents) and the documents they currently have open (resources).
// All of that was reachable only by the model, or buried in Settings — so the
// product's one structural advantage was invisible in the UI.
//
// This module is pure: it turns the manager's client list into a strip, and
// turns a click on an intent or a resource into the text to put in the input
// box. Composing the request and leaving the user to send it keeps the action
// honest — nothing is dispatched behind their back.

/**
 * Normalize the MCP client map into what the strip shows.
 * @param {Map<string, {name:string, intents?:Array, resources?:Array}>|Iterable} clients
 */
export function hubApps(clients) {
    const list = clients?.values ? [...clients.values()] : (Array.isArray(clients) ? clients : []);
    return list
        .filter(c => c && c.name)
        .map(c => ({
            name: String(c.name),
            intents: (Array.isArray(c.intents) ? c.intents : [])
                .filter(i => i && i.id)
                .map(i => ({ id: String(i.id), title: String(i.title || i.id) })),
            resources: (Array.isArray(c.resources) ? c.resources : [])
                .filter(r => r && r.uri)
                .map(r => ({ uri: String(r.uri), name: String(r.name || r.uri) })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The instruction to drop into the steering box.
 * @param {'intent'|'resource'} kind
 * @param {string} app
 * @param {{id?:string, uri?:string, title?:string, name?:string}} item
 */
export function hubActionText(kind, app, item) {
    if (!app || !item) return '';
    if (kind === 'resource' && item.uri) {
        // The qualified reference is what read_resource wants; naming the app in
        // prose too keeps it readable when the user edits the line.
        return `Read "${item.name || item.uri}" currently open in ${app} (${app}::${item.uri}) with read_resource, then `;
    }
    if (kind === 'intent' && item.id) {
        return `Run ${app}'s "${item.title || item.id}" (intent: ${item.id}), then `;
    }
    return '';
}

// NOTE: hubStripHtml is gone — the markup is svelte/monitor/HubStrip.svelte. What
// remains here is the part with decisions in it: normalising the client map, and
// composing the instruction a click drops into the input box.
