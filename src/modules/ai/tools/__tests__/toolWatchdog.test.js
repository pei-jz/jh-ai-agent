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

// A call that hit the output limit must be REPORTED as that, not executed with
// whatever survived. The repair used to close the brackets and hand the tool an
// object that looked complete.
describe('a tool call that was cut off', () => {
    it('is refused, and the error names the cause and the way round it', async () => {
        const out = await ex.executeTool(
            { name: 'write_file', args: { __args_truncated__: '31000 characters, ending: …def main(' } });
        expect(out).toMatch(/CUT OFF/);
        expect(out).toMatch(/output limit/);
        expect(out).toMatch(/nothing was executed/i);
        expect(out).toMatch(/in pieces/);
    });

    // A prohibition is the wrong shape here: this is a recoverable failure, and
    // the reason does the work a rule cannot. An agent that understands WHY the
    // detour is pointless does not take it; one that is merely forbidden takes
    // it as soon as it is stuck. docs/design/tool-failure-policy.md §2 A.
    it('explains why another tool would not help, rather than forbidding it', async () => {
        const out = await ex.executeTool(
            { name: 'write_xlsx', args: { __args_truncated__: '52000 characters, ending: …rows' } });
        expect(out).toMatch(/not a problem with the tool/);
        expect(out).toMatch(/cut off at the same place/);
        expect(out).not.toMatch(/Do NOT switch/);
    });

    it('leaves an ordinary call alone', async () => {
        const out = await ex.executeTool({ name: 'write_file', args: { path: '', content: 'x' } });
        expect(out).not.toMatch(/CUT OFF/);
    });
});

// A guard protects the OUTCOME, not the call that was refused.
//
// Told "this file already exists", the agent deleted the file and created it
// again — the same loss by another road. No wording prevents that; the only
// place that sees both calls is the executor.
// docs/design/tool-failure-policy.md §2 C.
describe('walking around a refusal', () => {
    it('blocks deleting a file the run was refused permission to replace', async () => {
        ex._noteRefusedReplace('C:/work/proj/見積.xlsx', 'write_xlsx refused to replace it');
        const out = await ex.executeTool({ name: 'delete_file', args: { path: 'C:/work/proj/見積.xlsx' } });
        expect(out).toMatch(/refused permission to REPLACE/);
        expect(out).toMatch(/same outcome/);
        // And it says what IS allowed.
        expect(out).toMatch(/update_xlsx/);
        expect(out).toMatch(/ask_user/);
    });

    it('matches the path however it is spelled', async () => {
        ex._noteRefusedReplace('C:\\work\\proj\\a.xlsx', 'x');
        expect(ex._refusedReplaceReason('C:/WORK/proj/A.xlsx')).toBeTruthy();
    });

    it('is not a general block on deleting things', async () => {
        ex._noteRefusedReplace('C:/work/proj/a.xlsx', 'x');
        expect(ex._refusedReplaceReason('C:/work/proj/b.xlsx')).toBeNull();
    });

    it('lifts once the replacement is allowed explicitly', () => {
        ex._noteRefusedReplace('C:/work/proj/a.xlsx', 'x');
        ex._clearRefusedReplace('C:/work/proj/a.xlsx');
        expect(ex._refusedReplaceReason('C:/work/proj/a.xlsx')).toBeNull();
    });
});

// Leaving the specialised tools is a legitimate move when they genuinely cannot
// do the job. Doing it in silence is not: the user is still using an app whose
// promise is "it will not corrupt your workbook", and at that moment the promise
// has stopped applying. docs/design/tool-failure-policy.md 原則2.
describe('when the work leaves the tools that guarantee something', () => {
    const said = () => {
        const seen = [];
        return [seen, (s) => seen.push(typeof s === 'string' ? s : s?.message || '')];
    };

    it('says so when a shell command reaches for an Office library', () => {
        const [seen, onStatus] = said();
        ex._noticeOfficeBypass('python -c "import openpyxl; …"', onStatus);
        expect(seen.join(' ')).toMatch(/保証/);
    });

    it('says so for a script written through write_file too', () => {
        const [seen, onStatus] = said();
        ex._noticeOfficeBypass('from openpyxl import Workbook\nwb = Workbook()', onStatus);
        expect(seen.length).toBe(1);
    });

    it('says it once, not on every command afterwards', () => {
        const [seen, onStatus] = said();
        ex._noticeOfficeBypass('import openpyxl', onStatus);
        ex._noticeOfficeBypass('import openpyxl', onStatus);
        expect(seen.length).toBe(1);
    });

    it('stays quiet about ordinary commands', () => {
        const [seen, onStatus] = said();
        ex._noticeOfficeBypass('npm test', onStatus);
        ex._noticeOfficeBypass('git status', onStatus);
        expect(seen).toEqual([]);
    });
});

