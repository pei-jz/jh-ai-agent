// gitHandlers — dedicated Git tool handlers (Phase 3).
//
// Thin wrappers over the Rust git commands (commands/git.rs). Each takes the
// ToolExecutor instance as `ctx` (for resolvePath / workspacePath /
// onAgentStatus / onConfirm / onToolEvent). Read-only tools (status/diff/log)
// are Allow; git_commit is the only mutating one and is gated behind Ask in
// _getToolPermission. I/O glue (excluded from the unit-coverage gate).

import { invoke } from '@tauri-apps/api/core';
import { buildStagingPreview } from '../gitStatusParse.js';

/** Resolve the repo working dir: explicit args.cwd, else the session workspace. */
function repoCwd(ctx, args) {
    const raw = (typeof args?.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : ctx.workspacePath;
    return ctx.resolvePath ? ctx.resolvePath(raw) : raw;
}

/** git_status — porcelain v2 + branch info (stable, machine-readable). */
export async function handleGitStatus(ctx, args, onAgentStatus) {
    const cwd = repoCwd(ctx, args);
    onAgentStatus?.(`Reading git status (${cwd})...`);
    try {
        const out = await invoke('git_status', { cwd });
        return out && out.trim() ? out : '(clean working tree)';
    } catch (e) {
        return `Error: git_status failed — ${e?.message || e}`;
    }
}

/** git_diff — working-tree vs index, or staged (--cached) when args.staged. */
export async function handleGitDiff(ctx, args, onAgentStatus) {
    const cwd = repoCwd(ctx, args);
    const scope = args?.path ? ` [${args.path}]` : '';
    onAgentStatus?.(`Reading git diff${args?.staged ? ' (staged)' : ''}${scope}...`);
    try {
        const out = await invoke('git_diff', {
            cwd,
            staged: !!args?.staged,
            path: args?.path || null,
        });
        return out && out.trim() ? out : '(no diff)';
    } catch (e) {
        return `Error: git_diff failed — ${e?.message || e}`;
    }
}

/** git_log — recent commits, one per line. */
export async function handleGitLog(ctx, args, onAgentStatus) {
    const cwd = repoCwd(ctx, args);
    const n = Number.isFinite(args?.max_count) ? args.max_count : 20;
    onAgentStatus?.(`Reading git log (last ${n})...`);
    try {
        const out = await invoke('git_log', { cwd, maxCount: n });
        return out && out.trim() ? out : '(no commits)';
    } catch (e) {
        return `Error: git_log failed — ${e?.message || e}`;
    }
}

/** git_commit — stage (paths or all) + commit. Mutating → gated behind Ask. */
export async function handleGitCommit(ctx, args, onConfirm, onAgentStatus) {
    const cwd = repoCwd(ctx, args);
    const message = (args?.message || '').trim();
    if (!message) return 'Error: git_commit requires a non-empty message.';
    const paths = Array.isArray(args?.paths) && args.paths.length > 0 ? args.paths : null;

    // Show the ACTUAL files that will be staged so a user can't rubber-stamp a
    // blind `git add -A` that sweeps in .env / secrets / unrelated WIP. When no
    // explicit paths are given we read git_status and list its changed files.
    let stagingPreview;
    if (paths) {
        stagingPreview = buildStagingPreview(paths, '');
    } else {
        let statusOut = '';
        try { statusOut = await invoke('git_status', { cwd }); } catch (_) { /* preview best-effort */ }
        const files = buildStagingPreview(null, statusOut);
        stagingPreview = `(ALL changes — git add -A)\n${files}`;
    }

    // Mutating git operation → always confirm with the user (fail-closed).
    const ok = await ctx._confirmUnsafe(false, onConfirm, {
        type: 'command_confirm',
        command: `git commit -m "${message}"`,
        message: `AI wants to create a git commit in ${cwd}:\n\nMessage: ${message}\n\nStaging:\n${stagingPreview}`,
    });
    if (!ok) return 'Error: git_commit denied by user.';

    onAgentStatus?.(`Creating git commit: ${message}...`);
    try {
        const out = await invoke('git_commit', { cwd, message, paths });
        ctx.onToolEvent?.('command_run', { command: `git commit -m "${message}"`, result: out });
        return out && out.trim() ? out : 'Commit created.';
    } catch (e) {
        return `Error: git_commit failed — ${e?.message || e}`;
    }
}
