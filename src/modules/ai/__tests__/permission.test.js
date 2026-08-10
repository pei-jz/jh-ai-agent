import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Tauri bridge and sibling managers so importing ToolExecutor does not
// pull in the native layer. We only exercise pure logic (path resolution +
// permission classification), none of which calls invoke().
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../McpManager.js', () => ({ mcpManager: { getAllTools: () => [] } }));

const { ToolExecutor } = await import('../ToolExecutor.js');
const { invoke } = await import('@tauri-apps/api/core');
let toolExecutor;
const WS = 'C:/work/proj';

describe('ToolExecutor.resolvePath', () => {
  beforeEach(() => {
    toolExecutor = new ToolExecutor();
    toolExecutor.workspacePath = WS;
    toolExecutor._writeAllowedPaths = [];
    toolExecutor._toolAllowlist = null;
  });

  it('resolves a relative path against the workspace', () => {
    expect(toolExecutor.resolvePath('src/a.js')).toBe('C:/work/proj/src/a.js');
  });

  it('normalizes backslashes and ./ prefixes', () => {
    expect(toolExecutor.resolvePath('.\\src\\a.js')).toBe('C:/work/proj/src/a.js');
  });

  it('returns an absolute Windows path unchanged', () => {
    expect(toolExecutor.resolvePath('D:/other/x.txt')).toBe('D:/other/x.txt');
  });
});

describe('ToolExecutor._isInsideWorkspace / _isWriteAllowed', () => {
  beforeEach(() => {
    toolExecutor = new ToolExecutor();
    toolExecutor.workspacePath = WS;
    toolExecutor._writeAllowedPaths = ['C:/allowed/extra'];
    toolExecutor._toolAllowlist = null;
  });

  it('treats the workspace root and nested paths as inside', () => {
    expect(toolExecutor._isInsideWorkspace('C:/work/proj')).toBe(true);
    expect(toolExecutor._isInsideWorkspace('C:/work/proj/src/a.js')).toBe(true);
  });

  it('rejects sibling-prefix paths', () => {
    expect(toolExecutor._isInsideWorkspace('C:/work/proj-evil/x')).toBe(false);
  });

  it('honors the extra write-allowed list', () => {
    expect(toolExecutor._isWriteAllowed('C:/allowed/extra/file.txt')).toBe(true);
    expect(toolExecutor._isWriteAllowed('C:/elsewhere/file.txt')).toBe(false);
  });
});

describe('ToolExecutor.getPermissionLevel', () => {
  beforeEach(() => {
    toolExecutor.workspacePath = WS;
    toolExecutor._writeAllowedPaths = [];
    toolExecutor._toolAllowlist = null;
  });

  it('classifies read-only tools as Allow', () => {
    expect(toolExecutor.getPermissionLevel('read_file', { path: 'a.js' })).toBe('Allow');
    expect(toolExecutor.getPermissionLevel('list_files', { path: '.' })).toBe('Allow');
  });

  it('always gates run_command as Ask', () => {
    expect(toolExecutor.getPermissionLevel('run_command', { command: 'ls' })).toBe('Ask');
  });

  it('allows in-workspace writes but asks for out-of-workspace writes', () => {
    expect(toolExecutor.getPermissionLevel('write_file', { path: 'src/a.js' })).toBe('Allow');
    expect(toolExecutor.getPermissionLevel('write_file', { path: 'C:/other/a.js' })).toBe('Ask');
  });

  it('asks before deleting/moving outside the workspace', () => {
    expect(toolExecutor.getPermissionLevel('delete_file', { path: 'src/a.js' })).toBe('Allow');
    expect(toolExecutor.getPermissionLevel('delete_file', { path: 'C:/other/a.js' })).toBe('Ask');
    expect(toolExecutor.getPermissionLevel('move_file', { from: 'a.js', to: 'b.js' })).toBe('Allow');
    expect(toolExecutor.getPermissionLevel('move_file', { from: 'a.js', to: 'C:/other/b.js' })).toBe('Ask');
  });

  it('denies tools disabled by the per-session allowlist, except finish_task', () => {
    toolExecutor._toolAllowlist = new Set(['read_file']);
    expect(toolExecutor.getPermissionLevel('write_file', { path: 'src/a.js' })).toBe('Deny');
    expect(toolExecutor.getPermissionLevel('read_file', { path: 'a.js' })).toBe('Allow');
    expect(toolExecutor.getPermissionLevel('finish_task', {})).toBe('Allow');
  });

  it('allows MCP/external tools to bypass the allowlist check and always return Allow', async () => {
    toolExecutor._toolAllowlist = new Set(['finish_task']);
    toolExecutor._mcpBypassesAllowlist = false;
    
    expect(toolExecutor.getPermissionLevel('custom_mcp_tool', {})).toBe('Allow');
    
    const res = await toolExecutor.executeTool({ name: 'custom_mcp_tool' }, () => {}, () => {});
    expect(res).not.toContain('is not enabled for this task');
    expect(res).toContain('Tool "custom_mcp_tool" not found');
  });
});

describe('ToolExecutor._confirmUnsafe (fail-closed gate)', () => {
  beforeEach(() => {
    toolExecutor.workspacePath = WS;
  });

  it('allows safe ops without prompting', async () => {
    await expect(toolExecutor._confirmUnsafe(true, undefined, {})).resolves.toBe(true);
  });

  it('denies unsafe ops when no approval channel exists', async () => {
    await expect(toolExecutor._confirmUnsafe(false, undefined, {})).resolves.toBe(false);
  });

  it('defers to the approval channel for unsafe ops', async () => {
    await expect(toolExecutor._confirmUnsafe(false, async () => true, {})).resolves.toBe(true);
    await expect(toolExecutor._confirmUnsafe(false, async () => false, {})).resolves.toBe(false);
  });
});

describe('ToolExecutor._autoSyntaxGate (post-edit diff-verification)', () => {
  beforeEach(() => {
    toolExecutor = new ToolExecutor();
    toolExecutor.workspacePath = WS;
    invoke.mockReset();
  });

  it('passes valid JSON silently', async () => {
    const out = await toolExecutor._autoSyntaxGate('a.json', '{"x":1}', '{"x":2}');
    expect(out).toBe('');
  });

  it('flags JSON the edit BROKE (was valid → now invalid)', async () => {
    const out = await toolExecutor._autoSyntaxGate('a.json', '{"x":1}', '{"x":2');
    expect(out).toContain('SYNTAX GATE');
    expect(out).toContain('BROKE');
  });

  it('notes JSON that was already invalid before the edit', async () => {
    const out = await toolExecutor._autoSyntaxGate('a.json', '{bad', '{still bad');
    expect(out).toContain('already invalid');
  });

  it('runs node --check for .js and passes on exit 0', async () => {
    invoke.mockResolvedValueOnce('');
    const out = await toolExecutor._autoSyntaxGate('src/a.js', 'const a=1;', 'const a=2;');
    expect(out).toBe('');
    expect(toolExecutor._nodeAvailable).toBe(true);
    expect(invoke).toHaveBeenCalledWith('run_command', expect.objectContaining({ command: expect.stringContaining('node --check') }));
  });

  it('flags a .js SyntaxError from node --check', async () => {
    invoke.mockRejectedValueOnce(new Error('a.js:1\nconst a=(\n\nSyntaxError: Unexpected end of input'));
    const out = await toolExecutor._autoSyntaxGate('src/a.js', 'const a=1;', 'const a=(');
    expect(out).toContain('SYNTAX GATE');
    expect(out).toContain('node --check');
  });

  it('skips (and remembers) when node is not installed', async () => {
    invoke.mockRejectedValueOnce(new Error("'node' is not recognized as an internal or external command"));
    const out = await toolExecutor._autoSyntaxGate('src/a.js', 'const a=1;', 'const a=2;');
    expect(out).toBe('');
    expect(toolExecutor._nodeAvailable).toBe(false);
    // A second call must NOT re-probe node.
    invoke.mockClear();
    const out2 = await toolExecutor._autoSyntaxGate('src/b.js', 'x', 'y');
    expect(out2).toBe('');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips non-code files (.tsx)', async () => {
    const out = await toolExecutor._autoSyntaxGate('src/a.tsx', '<App/>', '<App2/>');
    expect(out).toBe('');
    expect(invoke).not.toHaveBeenCalled();
  });
});
