// run_command's argument guard.
//
// A tool call that is cut off mid-generation — the model hits the output-token
// cap — arrives with its arguments incomplete. Without a guard the missing
// command flowed straight into the approval dialog, which asked the user to
// approve "AI wants to run this terminal command: undefined" over an empty code
// block, and there was nothing they could usefully do with it.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { handleRunCommand } = await import('../fsShellHandlers.js');

/** A ToolExecutor stand-in: only what handleRunCommand reads. */
const ctx = () => ({
    workspacePath: 'C:/ws',
    resolvePath: (p) => p,
    _isCommandApproved: () => false,
    _rememberApprovedCommand: vi.fn(),
    onToolEvent: vi.fn(),
});

describe('a call with no command', () => {
    it('fails instead of asking the user to approve nothing', async () => {
        const onConfirm = vi.fn(async () => true);
        const out = await handleRunCommand(ctx(), {}, onConfirm, vi.fn());
        expect(out).toMatch(/^Error/);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('treats an empty or whitespace command the same way', async () => {
        const onConfirm = vi.fn(async () => true);
        for (const command of ['', '   ', '\n']) {
            expect(await handleRunCommand(ctx(), { command }, onConfirm, vi.fn())).toMatch(/^Error/);
        }
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('survives a call with no args object at all', async () => {
        await expect(handleRunCommand(ctx(), undefined, vi.fn(), vi.fn())).resolves.toMatch(/^Error/);
    });

    // The model can only recover by retrying smaller. "Denied" would send it
    // looking for a permission problem it does not have.
    it('names truncation as the cause and says what to do instead', async () => {
        const out = await handleRunCommand(ctx(), {}, vi.fn(), vi.fn());
        expect(out).toMatch(/truncat/i);
        expect(out).toMatch(/write_file/);
        expect(out).not.toMatch(/denied/i);
    });

    // The guard runs BEFORE the approval channel is checked, so a missing
    // command fails the same way with or without one.
    it('fails the same way when there is no approval channel', async () => {
        expect(await handleRunCommand(ctx(), {}, null, vi.fn())).toMatch(/truncat/i);
    });
});

describe('a call with a real command', () => {
    it('still goes to the approval dialog', async () => {
        const onConfirm = vi.fn(async () => false);
        await handleRunCommand(ctx(), { command: 'npm test' }, onConfirm, vi.fn());
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
            type: 'command_confirm', command: 'npm test',
        }));
    });

    it('reports the denial when the user rejects it', async () => {
        const out = await handleRunCommand(ctx(), { command: 'npm test' }, async () => false, vi.fn());
        expect(out).toMatch(/User Denied/i);
    });
});
