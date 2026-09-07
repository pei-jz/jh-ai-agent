// The watchdog around a tool call — specifically the phase AFTER an approval.
//
// A `write_xlsx` that never returned looked exactly like one nobody had
// approved yet: the feed said 承認済み and then nothing, for 83 minutes, with no
// error and no status and nothing in the task log. The write tools were exempt
// from the watchdog because they wait for a person — true of the wait, not of
// the work that follows it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('../McpManager.js', () => ({
    mcpManager: { getAllTools: () => [], callTool: async () => ({ content: [] }), clients: new Map() },
}));

const { ToolExecutor } = await import('../ToolExecutor.js');

let ex;
beforeEach(() => {
    ex = new ToolExecutor();
    vi.useFakeTimers();
});

const never = () => new Promise(() => {});

describe('the wait for a person is unbounded; the work after it is not', () => {
    it('does not start the clock while the approval is still on screen', async () => {
        const result = ex._withToolTimeout('write_xlsx', never());
        let settled = false;
        result.then(() => { settled = true; });

        // Far past the tool's own budget. Nobody has clicked yet, so there is
        // nothing to call a hang — the card IS the reason for the wait.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(settled).toBe(false);
    });

    it('starts it when the approval clears, and reports rather than hanging', async () => {
        const result = ex._withToolTimeout('write_xlsx', never());
        // What _confirmUnsafe does the moment the user approves.
        ex._armPostApproval();

        await vi.advanceTimersByTimeAsync(179000);
        let text = await Promise.race([result, Promise.resolve('still-waiting')]);
        expect(text).toBe('still-waiting');

        await vi.advanceTimersByTimeAsync(2000);
        text = await result;
        // Names the tool, says it was abandoned, and says the work may still be
        // running — the three things needed to decide what to do next.
        expect(text).toMatch(/write_xlsx/);
        expect(text).toMatch(/did not return after 180s/);
        expect(text).toMatch(/still be running/);
    });

    it('an approved tool that finishes in time returns its own value', async () => {
        const result = ex._withToolTimeout('write_xlsx', Promise.resolve('Wrote 15 sheets'));
        ex._armPostApproval();
        await expect(result).resolves.toBe('Wrote 15 sheets');
    });

    // _confirmUnsafe is the ONE place the arming happens, so no handler has to
    // remember to do it.
    it('_confirmUnsafe arms on approval and stays quiet on refusal', async () => {
        let armed = 0;
        ex._postApprovalArm = () => { armed++; };
        await ex._confirmUnsafe(false, async () => true, {});
        expect(armed).toBe(1);

        ex._postApprovalArm = () => { armed++; };
        await ex._confirmUnsafe(false, async () => false, {});
        expect(armed, 'a refusal ends the call; there is no work to time').toBe(1);
    });

    // run_command is deliberately still exempt: a build or a test run is
    // legitimately long, and it carries its own timeout.
    it('leaves run_command alone', async () => {
        const p = never();
        expect(ex._withToolTimeout('run_command', p)).toBe(p);
    });

    // The investigation tools keep the old behaviour: they cannot prompt, so
    // their clock starts immediately.
    it('still times an investigation tool from the start', async () => {
        const result = ex._withToolTimeout('grep_search', never());
        await vi.advanceTimersByTimeAsync(61000);
        await expect(result).resolves.toMatch(/grep_search timed out after 60s/);
    });
});
