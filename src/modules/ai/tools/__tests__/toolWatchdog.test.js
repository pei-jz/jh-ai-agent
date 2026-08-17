// The tool watchdog — nothing above ToolExecutor bounds a tool call.
//
// The agent loop evaluates its wall-clock and token budgets at the TOP of an
// iteration, and the LLM client has no read timeout, so one stuck await inside
// a tool freezes the whole run with no error and no way out but restarting the
// app. These tests pin that an investigation tool can no longer do that, and
// that the tools which legitimately block (approval prompts, long commands)
// are NOT cut off.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('../../McpManager.js', () => ({
    mcpManager: { getAllTools: () => [], callTool: async () => ({ content: [] }), clients: new Map() },
}));

const { ToolExecutor } = await import('../../ToolExecutor.js');

let ex;
beforeEach(() => {
    vi.useFakeTimers();
    ex = new ToolExecutor();
    ex.workspacePath = 'C:/work/proj';
    try { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; } catch (_) {}
});

describe('_withToolTimeout', () => {
    it('abandons a hung investigation tool with an actionable error', async () => {
        const never = new Promise(() => {});          // the wasm-init failure mode
        const p = ex._withToolTimeout('symbol_search', never);
        await vi.advanceTimersByTimeAsync(61000);
        const result = await p;
        expect(result).toContain('symbol_search timed out');
        expect(result).toContain('Narrow the request');
    });

    it('returns the real value when the tool finishes in time', async () => {
        const p = ex._withToolTimeout('grep_search', Promise.resolve('3 matches'));
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe('3 matches');
    });

    it('converts a rejection into a tool-error string, not a thrown run', async () => {
        const p = ex._withToolTimeout('read_file', Promise.reject(new Error('os error 3')));
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toContain('Error executing read_file: os error 3');
    });

    it('leaves user-blocking and long-running tools unbounded', async () => {
        // run_command has its own timeout; write_file can sit on an approval
        // dialog for as long as the human takes.
        for (const name of ['run_command', 'run_subtask', 'write_file', 'multi_replace_file_content']) {
            let settled = false;
            const p = ex._withToolTimeout(name, new Promise(() => {}));
            p.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            expect(settled).toBe(false);
        }
    });
});
