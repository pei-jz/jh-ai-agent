// fsShellHandlers — filesystem-mutating + shell tool handlers extracted from
// ToolExecutor (Part A refactor): delete_file / move_file / run_command.
//
// Each takes the ToolExecutor instance as `ctx` and uses its helpers/fields
// verbatim (_isInsideWorkspace, _confirmUnsafe, _allowApprovedPath, _fileCache,
// resolvePath, workspacePath, onToolEvent). Behavior is identical to the inline
// switch bodies — only `this` → `ctx`. I/O glue (excluded from coverage gate).

import { invoke } from '@tauri-apps/api/core';

/** delete_file — single-file delete, confirmation required outside workspace. */
export async function handleDeleteFile(ctx, args, onConfirm, onAgentStatus, resolvedPath) {
    const isSafeRootDel = ctx._isInsideWorkspace(resolvedPath);
    const okDel = await ctx._confirmUnsafe(isSafeRootDel, onConfirm, {
        type: 'command_confirm',
        command: `delete_file ${resolvedPath}`,
        message: `AI wants to delete this file (outside workspace):\n${resolvedPath}`
    });
    if (!okDel) return 'Error: File deletion denied — target is outside the workspace and was not approved.';
    if (!isSafeRootDel) await ctx._allowApprovedPath(resolvedPath);
    onAgentStatus?.(`Deleting file: ${resolvedPath}...`);
    try {
        await invoke('delete_file', { path: resolvedPath });
        // Evict from session cache so a subsequent read doesn't silently
        // serve stale content.
        if (ctx._fileCache) {
            ctx._fileCache.delete(resolvedPath.replace(/\\/g, '/'));
        }
        ctx.onToolEvent?.('file_modified', { path: resolvedPath, action: 'delete', diff: '- deleted' });
        return `Success: Deleted ${resolvedPath}.`;
    } catch (e) {
        return `Error: delete_file failed — ${e?.message || e}`;
    }
}

/** move_file — rename/move, confirmation required when crossing the ws boundary. */
export async function handleMoveFile(ctx, args, onConfirm, onAgentStatus) {
    if (!args.from || !args.to) {
        return `Error: move_file requires both 'from' and 'to' parameters.`;
    }
    const fromPath = ctx.resolvePath(args.from);
    const toPath   = ctx.resolvePath(args.to);
    const bothInsideWs = ctx._isInsideWorkspace(fromPath) && ctx._isInsideWorkspace(toPath);
    const okMove = await ctx._confirmUnsafe(bothInsideWs, onConfirm, {
        type: 'command_confirm',
        command: `move_file ${fromPath} → ${toPath}`,
        message: `AI wants to move/rename a file crossing the workspace boundary:\nFrom: ${fromPath}\nTo:   ${toPath}`
    });
    if (!okMove) return 'Error: File move denied — crosses the workspace boundary and was not approved.';
    if (!bothInsideWs) await ctx._allowApprovedPath(fromPath, toPath);
    onAgentStatus?.(`Moving: ${fromPath} → ${toPath}...`);
    try {
        await invoke('move_file', {
            from: fromPath,
            to: toPath,
            overwrite: !!args.overwrite
        });
        // Migrate cache entry to the new key.
        if (ctx._fileCache) {
            const fromKey = fromPath.replace(/\\/g, '/');
            const toKey   = toPath.replace(/\\/g, '/');
            const existing = ctx._fileCache.get(fromKey);
            if (existing) {
                ctx._fileCache.delete(fromKey);
                ctx._fileCache.set(toKey, existing);
            }
        }
        ctx.onToolEvent?.('file_modified', { path: toPath, action: 'move', diff: `- ${fromPath}\n+ ${toPath}` });
        return `Success: Moved ${fromPath} → ${toPath}.`;
    } catch (e) {
        return `Error: move_file failed — ${e?.message || e}`;
    }
}

/** run_command — always-gated shell execution with live streaming + timeout. */
export async function handleRunCommand(ctx, args, onConfirm, onAgentStatus) {
    // Arbitrary shell execution is ALWAYS gated. Fail-closed: if
    // no approval channel is wired (e.g. a headless caller), the
    // command is denied rather than executed unconditionally.
    const approvedCmd = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: args.command,
        message: `AI wants to run this terminal command:\n${args.command}`
    });
    if (!approvedCmd) {
        return onConfirm
            ? "Error: User Denied command execution."
            : "Error: Command execution denied — no approval channel is available to authorize shell commands.";
    }
    onAgentStatus?.(`Running command: ${args.command}...`);

    // Default 60-second timeout prevents infinite hangs.
    // Agent can pass timeout_ms to override (e.g. long builds).
    const timeoutMs = (Number.isFinite(args.timeout_ms) && args.timeout_ms > 0)
        ? args.timeout_ms
        : 60_000;

    // ── Streaming setup ────────────────────────────────────
    // Generate a per-call id so live stdout/stderr chunks emitted by the
    // Rust side ("command-chunk" event) can be associated with this call.
    // We forward each chunk through onToolEvent so MonitorView shows the
    // command's output live instead of waiting until completion.
    const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let unlisten = null;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('command-chunk', (event) => {
            const p = event?.payload;
            if (!p || p.command_id !== cmdId) return;
            ctx.onToolEvent?.('command_chunk', {
                command_id: cmdId,
                command: args.command,
                stream: p.stream,
                line: p.line
            });
        });
    } catch (e) {
        // Listener attach failure shouldn't abort the command — just lose streaming.
        console.warn('run_command: failed to attach streaming listener:', e);
    }

    const commandPromise = invoke('run_command', {
        command: args.command,
        cwd: ctx.workspacePath,
        commandId: cmdId
    });
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
            () => reject(new Error(`run_command timed out after ${timeoutMs / 1000}s`)),
            timeoutMs
        )
    );

    let result;
    try {
        result = await Promise.race([commandPromise, timeoutPromise]);
    } catch (e) {
        if (e.message?.includes('timed out')) {
            return `Error: Command timed out after ${timeoutMs / 1000} seconds. ` +
                `The process may still be running in the background. ` +
                `If this command needs more time, retry with a larger timeout_ms value.`;
        }
        throw e;
    } finally {
        // Always detach the streaming listener so we don't leak event subscriptions.
        if (unlisten) { try { unlisten(); } catch (_) {} }
    }

    ctx.onToolEvent?.('command_run', { command: args.command, result });
    return result;
}
