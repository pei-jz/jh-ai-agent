// resourceHandlers — reading documents that connected apps expose (MCP resources).
//
// Tools let the agent act on an app; resources let it see what that app has open
// right now — the buffer being edited, today's board, the last query result.
// Without these the only way to get that content into a task was for the user to
// save it to disk first, so the agent was always looking at a stale copy.

import { mcpManager } from '../../McpManager.js';

/** list_resources — what the connected apps are currently offering. */
export async function handleListResources(ctx, args, onAgentStatus) {
    const all = mcpManager.listResources();
    if (!all.length) {
        return 'No app resources are available. (No connected app publishes documents, or no app is connected.)';
    }
    const filter = String(args?.app || '').trim().toLowerCase();
    const rows = filter ? all.filter(r => r.app.toLowerCase() === filter) : all;
    if (!rows.length) return `No resources published by app "${args.app}".`;

    onAgentStatus?.(`Listing app resources (${rows.length})...`);
    const lines = rows.map(r => {
        const label = r.name ? ` — ${r.name}` : '';
        const type = r.mimeType ? ` [${r.mimeType}]` : '';
        const desc = r.description ? `\n    ${r.description}` : '';
        // The key is what read_resource wants: unambiguous even across apps.
        return `- ${r.key}${label}${type}${desc}`;
    });
    return `Available app resources (${rows.length}):\n${lines.join('\n')}\n\nRead one with read_resource using the full "app::uri" reference above.`;
}

/** read_resource — fetch one live document from the app that owns it. */
export async function handleReadResource(ctx, args, onAgentStatus) {
    const ref = String(args?.uri || '').trim();
    if (!ref) return "Error: read_resource requires a 'uri' parameter (use list_resources to see them).";

    onAgentStatus?.(`Reading app resource: ${ref}...`);
    try {
        const doc = await mcpManager.readResource(ref);
        ctx.onToolEvent?.('read_resource', { uri: doc.uri, app: doc.app });
        if (!doc.text) return `(${doc.app}) ${doc.uri} — the app returned no readable content.`;
        const type = doc.mimeType ? ` [${doc.mimeType}]` : '';
        return `# ${doc.app}::${doc.uri}${type}\n${doc.text}`;
    } catch (e) {
        // Ambiguity and disconnection both arrive here with actionable messages.
        return `Error: read_resource failed — ${e?.message || e}`;
    }
}
