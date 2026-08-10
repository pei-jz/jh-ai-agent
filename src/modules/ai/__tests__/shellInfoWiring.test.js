// The wiring half of shell awareness: ToolExecutor must learn the real shell
// from the backend BEFORE the first LLM call, and advertise it consistently on
// every path that hands tools to a model.

import { describe, it, expect, vi, beforeAll } from 'vitest';

const SHELL = {
    os: 'windows',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
    display: 'Windows PowerShell 5.1 (powershell.exe)',
};

const invoke = vi.fn(async (cmd) => (cmd === 'get_shell_info' ? SHELL : null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('../McpManager.js', () => ({
    mcpManager: { getAllTools: () => [], clients: new Map() },
}));

const { ToolExecutor } = await import('../ToolExecutor.js');

const runCommandDesc = (defs) => defs.find(t => t.name === 'run_command')?.description || '';

beforeAll(() => {
    try { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; } catch (_) {}
});

describe('run_command description ← backend shell info', () => {
    it('is generic before the session starts (nothing known yet)', () => {
        const ex = new ToolExecutor();
        expect(runCommandDesc(ex.getActiveToolDefinitions())).not.toContain('PowerShell');
    });

    it('startSession fetches the shell, so step 1 already has it', async () => {
        const ex = new ToolExecutor();
        await ex.startSession('C:/work/proj');
        expect(invoke).toHaveBeenCalledWith('get_shell_info');

        const desc = runCommandDesc(ex.getActiveToolDefinitions());
        expect(desc).toContain('Windows PowerShell 5.1');
        expect(desc).toContain('do not assume bash');
    });

    it('the NATIVE tool payload carries the same text as the JSON-mode list', async () => {
        const ex = new ToolExecutor();
        await ex.startSession('C:/work/proj');

        const native = ex.getToolsForNativeAPI().find(t => t.function?.name === 'run_command');
        expect(native.function.description).toBe(runCommandDesc(ex.getActiveToolDefinitions()));
    });

    it('is fetched ONCE per process — a description that changed mid-run would break prompt caching', async () => {
        invoke.mockClear();
        const a = new ToolExecutor();
        const b = new ToolExecutor();
        await a.startSession('C:/work/proj');
        await b.startSession('C:/work/proj');
        expect(invoke.mock.calls.filter(c => c[0] === 'get_shell_info')).toHaveLength(0);
    });

    it('a second ToolExecutor inherits it without its own fetch', () => {
        const fresh = new ToolExecutor();
        expect(runCommandDesc(fresh.getActiveToolDefinitions())).toContain('PowerShell');
    });

    it('stays a single copy after repeated reads', () => {
        const ex = new ToolExecutor();
        const first = runCommandDesc(ex.getActiveToolDefinitions());
        const second = runCommandDesc(ex.getActiveToolDefinitions());
        expect(second).toBe(first);
        expect(first.match(/SHELL: commands run on/g)).toHaveLength(1);
    });

    it('does not appear on tools other than run_command', async () => {
        const ex = new ToolExecutor();
        await ex.startSession('C:/work/proj');
        const others = ex.getActiveToolDefinitions().filter(t => t.name !== 'run_command');
        expect(others.some(t => (t.description || '').includes('SHELL: commands run on'))).toBe(false);
    });
});
