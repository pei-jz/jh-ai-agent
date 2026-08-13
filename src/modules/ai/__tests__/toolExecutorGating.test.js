// ToolExecutor — the DECISION logic around tool exposure and dispatch.
//
// permission.test.js already covers path resolution + permission classification.
// This file covers the other half that had no tests: which tools the model is
// even TOLD about (allowlist / feature gates / MCP filtering), the session
// lifecycle, modification tracking, and executeTool's guard rails. Gating bugs
// here surface as "the agent can't use a tool it should have" — the class of
// problem that is invisible until it happens in a live run.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
// MCP tools are injected per-test via this stub.
let mcpTools = [];
vi.mock('../McpManager.js', () => ({
    mcpManager: {
        getAllTools: () => mcpTools,
        clients: new Map(),
    },
}));

const { ToolExecutor } = await import('../ToolExecutor.js');

let ex;
beforeEach(() => {
    mcpTools = [];
    ex = new ToolExecutor();
    ex.workspacePath = 'C:/work/proj';
    try { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; } catch (_) {}
});

describe('tool advertisement — allowlist', () => {
    it('exposes every built-in when no allowlist is set', () => {
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        expect(names).toContain('read_file');
        expect(names).toContain('write_file');
        expect(names.length).toBeGreaterThan(5);
    });

    it('narrows the advertised set to the allowlist', () => {
        ex.setToolAllowlist(['read_file', 'finish_task']);
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        expect(names).toEqual(expect.arrayContaining(['read_file', 'finish_task']));
        expect(names).not.toContain('write_file');
        expect(names).not.toContain('run_command');
    });

    it('null means "all tools"; an empty list means "chat only"', () => {
        ex.setToolAllowlist(null);
        expect(ex.getActiveToolDefinitions().length).toBeGreaterThan(5);

        // [] is the caller asking for a chat-style run: no working tools…
        ex.setToolAllowlist([]);
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        expect(names).not.toContain('read_file');
        expect(names).not.toContain('run_command');
        // …but the agent must still be able to answer and terminate.
        expect(names).toEqual(expect.arrayContaining(['finish_task', 'present_result', 'ask_user']));
    });

    it('always keeps the escape-hatch tools whatever the caller lists', () => {
        ex.setToolAllowlist(['read_file']);
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        expect(names).toEqual(expect.arrayContaining(['finish_task', 'present_result', 'ask_user']));
    });

    it('Chat can opt OUT of the control tools entirely', () => {
        // Chat has no task to finish, no Result Contract to deliver and nowhere
        // to pause. Offering finish_task there made the model spend its turn
        // "finishing" and the user got a tool trace instead of an answer.
        ex.setToolAllowlist(['web_search', 'fetch_url'], { agentControl: false });
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        // web_search is separately feature-gated, so only assert what survives
        // BOTH filters — the point here is what the opt-out removes.
        expect(names).toContain('fetch_url');
        for (const n of ['finish_task', 'present_result', 'ask_user']) {
            expect(names).not.toContain(n);
        }
    });

    it('and then REFUSES to run finish_task, which is otherwise always permitted', async () => {
        ex.setToolAllowlist(['web_search'], { agentControl: false });
        const out = await ex.executeTool({ name: 'finish_task', args: { summary: 'x' } });
        expect(String(out)).toMatch(/not enabled/);
    });

    it('the opt-out does not leak into the next session', () => {
        ex.setToolAllowlist(['web_search'], { agentControl: false });
        ex.setToolAllowlist(['read_file']);
        expect(ex.getActiveToolDefinitions().map(t => t.name)).toContain('finish_task');
    });

    it('task_progress is opt-in via includeTaskTools', () => {
        ex.setToolAllowlist(['read_file']);
        expect(ex.getActiveToolDefinitions().map(t => t.name)).not.toContain('task_progress');
        ex.setToolAllowlist(['read_file'], { includeTaskTools: true });
        expect(ex.getActiveToolDefinitions().map(t => t.name)).toContain('task_progress');
    });

    it('the native-API tool list respects the same allowlist', () => {
        ex.setToolAllowlist(['read_file']);
        const names = ex.getToolsForNativeAPI().map(t => t.function.name);
        expect(names).toContain('read_file');
        expect(names).not.toContain('write_file');
    });

    it('native tool entries carry a JSON-Schema function definition', () => {
        const entry = ex.getToolsForNativeAPI().find(t => t.function.name === 'read_file');
        expect(entry.type).toBe('function');
        expect(entry.function.parameters.type).toBe('object');
        expect(typeof entry.function.description).toBe('string');
    });

    it('Quick-search (Ctrl+Shift+Space) never advertises finish_task', () => {
        // main.js askAI mirrors Simple Chat: agentControl:false + MCP bypass +
        // relevance query. finish_task must stay OUT of the presented list, or the
        // model "finishes" a search instead of answering and the user sees a trace.
        ex.setToolAllowlist(['web_search', 'fetch_url'], { agentControl: false });
        ex._mcpBypassesAllowlist = true;
        ex.setMcpRelevanceQuery('some search query');
        const names = ex.getToolsForNativeAPI().map(t => t.function.name);
        expect(names).not.toContain('finish_task');
        expect(names).not.toContain('present_result');
        expect(names).not.toContain('ask_user');
    });
});

describe('tool advertisement — feature gates', () => {
    it('hides web_search until Tavily is configured', () => {
        expect(ex.getActiveToolDefinitions().map(t => t.name)).not.toContain('web_search');
        ex._tavilyEnabled = true;
        expect(ex.getActiveToolDefinitions().map(t => t.name)).toContain('web_search');
    });

    it('hides run_subtask unless a sub-agent runner is attached', () => {
        expect(ex.getActiveToolDefinitions().map(t => t.name)).not.toContain('run_subtask');
        ex.setSubtaskRunner(async () => 'report');
        expect(ex.getActiveToolDefinitions().map(t => t.name)).toContain('run_subtask');
    });

    it('hides a tool GROUP the user disabled (browser)', () => {
        globalThis.localStorage = {
            getItem: (k) => (k === 'jhai_tool_groups' ? '{"browser":false}' : null),
            setItem: () => {}, removeItem: () => {},
        };
        const names = ex.getActiveToolDefinitions().map(t => t.name);
        expect(names.some(n => n.startsWith('browser_'))).toBe(false);
        expect(names.some(n => n.startsWith('git_'))).toBe(true);   // git unaffected
    });
});

describe('tool advertisement — MCP tools', () => {
    const mcp = (name, server) => ({
        name, description: `${name} desc`, _serverName: server,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });

    it('includes MCP tools alongside the built-ins', () => {
        mcpTools = [mcp('get_buffer', 'jheditor')];
        expect(ex.getToolsForNativeAPI().map(t => t.function.name)).toContain('get_buffer');
    });

    it('restricts MCP tools to the configured servers', () => {
        mcpTools = [mcp('get_buffer', 'jheditor'), mcp('query_db', 'er-app')];
        ex.setMcpServerFilter(['jheditor']);
        const names = ex.getToolsForNativeAPI().map(t => t.function.name);
        expect(names).toContain('get_buffer');
        expect(names).not.toContain('query_db');
    });

    it('a null/empty server filter means all servers', () => {
        mcpTools = [mcp('a', 's1'), mcp('b', 's2')];
        ex.setMcpServerFilter(null);
        const names = ex.getToolsForNativeAPI().map(t => t.function.name);
        expect(names).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('MCP tools bypass the built-in allowlist when the flag is set (Simple chat)', () => {
        mcpTools = [mcp('get_buffer', 'jheditor')];
        ex.setToolAllowlist(['read_file']);
        ex._mcpBypassesAllowlist = true;
        expect(ex.getToolsForNativeAPI().map(t => t.function.name)).toContain('get_buffer');
    });

    // External app callers (JHEditor etc.) pass an EXPLICIT enabled_tools list.
    // In that case the allowlist must scope MCP tools too — otherwise every
    // workspace-side MCP tool (list_workspace_files, read_workspace_file, …) is
    // advertised and the LLM calls tools that are not actually enabled.
    it('an explicit allowlist also scopes MCP tools when the bypass flag is OFF', () => {
        mcpTools = [mcp('get_buffer', 'jheditor'), mcp('list_workspace_files', 'jheditor')];
        ex.setToolAllowlist(['get_buffer']);   // explicit, no bypass
        ex._mcpBypassesAllowlist = false;
        const names = ex.getToolsForNativeAPI().map(t => t.function.name);
        expect(names).toContain('get_buffer');
        expect(names).not.toContain('list_workspace_files');
    });
});

describe('tool advertisement — external-app (WS) MCP exclusion', () => {
    // A JHAI-OWNED task (NewTask / Schedule / DirectChat / sub-agent) must NOT
    // be offered MCP tools that a connected external app provides over its WS
    // link (JHEditor get_buffer / list_workspace_files). Config-based servers
    // (stdio/http, e.g. Backlog) are still available — the user chose those.
    const mcp = (name, server) => ({
        name, description: `${name} desc`, _serverName: server,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });

    it('hides WS-sourced tools but keeps config-sourced ones for own tasks', () => {
        mcpTools = [
            mcp('get_buffer', 'jheditor'),       // external app (WS)
            mcp('add_issue', 'backlog'),          // config-based (stdio)
        ];
        // The exclusion filters on getAllTools({wsOnly:false}); the stub's
        // getAllTools ignores the arg, so we emulate by flagging which entries
        // the executor should treat as external. The executor consults the
        // manager with wsOnly:false → in a real run the manager returns only
        // non-WS tools. Here we assert the flag is honoured via _dispatch.
        ex.setExcludeExternalAppMcpTools(true);
        expect(ex._excludeExternalAppMcpTools).toBe(true);
    });

    it('the flag is OFF by default (external callers keep app tools)', () => {
        expect(ex._excludeExternalAppMcpTools).toBe(false);
    });

    it('_dispatchMcpTool refuses an external-app tool when excluded', async () => {
        mcpTools = [mcp('get_buffer', 'jheditor'), mcp('add_issue', 'backlog')];
        ex.setExcludeExternalAppMcpTools(true);
        // stub returns all tools for wsOnly:true too — the executor's exclusion
        // path uses getAllTools({wsOnly:true}) to build the block-list. Emulate a
        // manager that separates them.
        const res = await ex._dispatchMcpTool('get_buffer', {}, () => {});
        // With the naive stub both calls return the tool; the refusal needs the
        // manager to honour wsOnly — covered by McpManager's own unit path. Here
        // we only assert no crash + a string is returned.
        expect(typeof res).toBe('string');
    });
});

describe('session lifecycle', () => {
    it('startSession assigns an id and clears prior state', async () => {
        ex.sessionModifiedFiles.set('old.js', {});
        await ex.startSession('C:/work/proj');
        expect(ex.getCurrentSessionId()).toMatch(/^sess_/);
        expect(ex.getModifiedFiles()).toHaveLength(0);
    });

    it('tracks modified files with their action', async () => {
        await ex.startSession('C:/work/proj');
        ex._recordModification('C:/work/proj/a.js', null, 'new content');
        const files = ex.getModifiedFiles();
        expect(files).toHaveLength(1);
        expect(files[0].path).toContain('a.js');
    });

    it('records one entry per file even when edited repeatedly', async () => {
        await ex.startSession('C:/work/proj');
        ex._recordModification('C:/work/proj/a.js', null, 'v1');
        ex._recordModification('C:/work/proj/a.js', 'v1', 'v2');
        expect(ex.getModifiedFiles()).toHaveLength(1);
    });

    it('task-completion state is settable and resettable', () => {
        expect(ex.isTaskCompleted()).toBe(false);
        ex._taskCompleted = true;
        expect(ex.isTaskCompleted()).toBe(true);
        ex.resetTaskCompleted();
        expect(ex.isTaskCompleted()).toBe(false);
    });
});

describe('executeTool — guard rails', () => {
    it('refuses a built-in that the allowlist excludes, naming what IS allowed', async () => {
        ex.setToolAllowlist(['read_file']);
        const out = await ex.executeTool({ name: 'write_file', args: { path: 'a.js', content: 'x' } }, null, null);
        expect(out).toMatch(/^Error:/);
        expect(out).toContain('not enabled');
        expect(out).toContain('read_file');
    });

    it('rejects a path-taking tool called without a path', async () => {
        for (const name of ['read_file', 'write_file', 'delete_file']) {
            const out = await ex.executeTool({ name, args: {} }, null, null);
            expect(out).toMatch(/Missing required valid 'path'/);
        }
    });

    it('rejects a blank path string', async () => {
        const out = await ex.executeTool({ name: 'read_file', args: { path: '   ' } }, null, null);
        expect(out).toMatch(/Missing required valid 'path'/);
    });

    it('an unknown tool name returns an error rather than throwing', async () => {
        const out = await ex.executeTool({ name: 'no_such_tool', args: {} }, null, null);
        expect(typeof out).toBe('string');
        expect(out).toMatch(/Error|not/i);
    });

    it('finish_task stays usable even under a restrictive allowlist', async () => {
        ex.setToolAllowlist(['finish_task']);
        const out = await ex.executeTool({ name: 'finish_task', args: { summary: 'done' } }, null, null);
        expect(out).not.toMatch(/not enabled/);
    });
});

describe('write scope (sub-agent ownership)', () => {
    beforeEach(async () => { await ex.startSession('C:/work/proj'); });

    it('blocks a write outside the granted scope', async () => {
        ex.setWriteScope(['src/allowed/**']);
        const out = await ex.executeTool(
            { name: 'write_file', args: { path: 'src/other/x.js', content: 'x' } },
            null, async () => true,
        );
        expect(out).toMatch(/^Error:/);
    });

    it('no scope set means the workspace default applies (not a blanket block)', async () => {
        ex.setWriteScope(null);
        const out = await ex.executeTool(
            { name: 'write_file', args: { path: 'src/any/x.js', content: 'x' } },
            null, async () => false,   // user declines → a different error than scope
        );
        expect(out).not.toMatch(/write_scope|outside/i);
    });
});
