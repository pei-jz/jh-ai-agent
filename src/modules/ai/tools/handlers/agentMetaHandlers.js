// agentMetaHandlers — artifact / lifecycle tool handlers extracted from
// ToolExecutor (Part A refactor): create_artifact & update_artifact,
// finish_task, verify_syntax, task_progress, present_result.
//
// Each takes the ToolExecutor instance as `ctx` and uses its helpers/fields
// verbatim (getSessionArtifactDir, sessionModifiedFiles, workspacePath,
// _loadTaskProgress, _saveTaskProgress, _renderTaskProgress, _taskProgressItems,
// onToolEvent, _taskCompleted). Behavior is identical to the inline switch
// bodies — only `this` → `ctx`. I/O glue (excluded from the unit-coverage gate).

import { invoke } from '@tauri-apps/api/core';

/**
 * present_result — deliver the FINAL structured result to the calling app
 * (AI-Hub Result Contract). Normalizes the flat strict-schema args into the
 * `{ kind, payload, actions[], summary }` envelope and emits it as a `result`
 * task event, which TaskBridge broadcasts over the task WS to the app.
 */
export async function handlePresentResult(ctx, args, onAgentStatus) {
    const kind = args.kind || 'answer';
    onAgentStatus?.(`Presenting result (${kind})`);

    // Resolve the markdown/text body. The schema names this `markdown`, but
    // models frequently emit it under `content` (matching write_file /
    // create_artifact) or `md`/`text`. Accept all so a mislabelled arg doesn't
    // silently produce an empty result envelope.
    const body = [args.markdown, args.content, args.md, args.text]
        .find(v => typeof v === 'string' && v.length > 0) || '';

    // Build the kind-specific payload from the flattened args.
    let payload;
    switch (kind) {
        case 'file-list':
            payload = { files: Array.isArray(args.files) ? args.files : [] };
            break;
        case 'code-edit':
            payload = { edits: Array.isArray(args.edits) ? args.edits : [] };
            break;
        case 'answer':
            payload = { text: body };
            break;
        case 'markdown':
        case 'table':
        default:
            payload = { md: body };
            break;
    }

    // Normalize apply-actions (drop incomplete ones; strip null fields).
    const actions = (Array.isArray(args.actions) ? args.actions : [])
        .filter(a => a && a.label && a.type)
        .map(a => {
            const apply = { type: a.type };
            if (a.path != null) apply.path = a.path;
            if (a.line != null) apply.line = a.line;
            if (a.text != null) apply.text = a.text;
            return { label: a.label, apply };
        });

    const envelope = { kind, payload, actions, summary: args.summary || '' };

    // → TaskBridge relays this as `{ event:'result', envelope }` over the task WS.
    ctx.onToolEvent?.('result', { envelope });

    return `Success: result presented to the calling app (kind=${kind}, ${actions.length} action(s)). ` +
        `If the goal is achieved, call finish_task next.`;
}

/** create_artifact / update_artifact — write a markdown artifact to the session dir. */
export async function handleArtifact(ctx, args, name, onAgentStatus) {
    const actionName = name === 'create_artifact' ? 'Creating' : 'Updating';
    const artifactName = args.name.endsWith('.md') ? args.name : `${args.name}.md`;
    onAgentStatus?.(`${actionName} artifact: ${artifactName}...`);

    const artifactDir = ctx.getSessionArtifactDir();
    const artifactPath = `${artifactDir}/${artifactName}`;

    // Snapshot the pre-write content on update so the modification record keeps
    // a real `original` (→ action "modified" instead of "created").
    let original = null;
    if (name === 'update_artifact') {
        try { original = await invoke('read_file', { path: artifactPath }); } catch (_) { /* new file */ }
    }

    await invoke('create_dir', { path: artifactDir });
    await invoke('write_file', { path: artifactPath, content: args.content });

    // Track the artifact (e.g. task_plan.md) as a session-modified file so it
    // shows up in the post-run Result file list (clickable → OS default app).
    ctx._recordModification?.(artifactPath, original, args.content);

    ctx.onToolEvent?.('artifact_modified', { name: artifactName, path: artifactPath, content: args.content });
    return `Success: Artifact ${artifactName} ${name === 'create_artifact' ? 'created' : 'updated'}.`;
}

/** finish_task — pre-finish real-parser syntax gate, then declare completion. */
export async function handleFinishTask(ctx, args, onAgentStatus) {
    // ── Pre-finish syntax gate (real-parser based) ────────
    // Sanity-check every modified file before accepting completion.
    //   .json          → JSON.parse  (in-process, fast, reliable)
    //   .js/.jsx/...   → node --check (real V8 parser)
    //   .ts/.tsx       → skipped (TS needs project tsc; we surface a soft reminder
    //                    in the success message instead of blocking).
    // Files we can't parse (no Node, unreadable) are skipped silently — the
    // gate's purpose is to catch broken edits, not to block on environment gaps.
    const jsonFiles = [];
    const jsFiles = [];
    const tsFiles = [];
    for (const [p] of ctx.sessionModifiedFiles) {
        if (/\.json$/i.test(p)) jsonFiles.push(p);
        else if (/\.(js|jsx|mjs|cjs)$/i.test(p)) jsFiles.push(p);
        else if (/\.(ts|tsx)$/i.test(p)) tsFiles.push(p);
    }

    const failures = [];

    // JSON files — in-process check
    for (const filePath of jsonFiles) {
        try {
            const src = await invoke('read_file', { path: filePath });
            try { JSON.parse(src); }
            catch (e) { failures.push(`${filePath} (JSON): ${e.message}`); }
        } catch (_) { /* unreadable — skip */ }
    }

    // JS files — node --check subprocess
    let nodeMissing = false;
    for (const filePath of jsFiles) {
        if (nodeMissing) break; // don't spam if node isn't installed
        const quoted = `"${filePath.replace(/"/g, '\\"')}"`;
        try {
            await invoke('run_command', {
                command: `node --check ${quoted}`,
                cwd: ctx.workspacePath
            });
        } catch (e) {
            const raw = String(e?.message || e || '');
            if (/is not recognized|command not found|ENOENT/i.test(raw) &&
                !/SyntaxError/i.test(raw)) {
                // Node isn't on PATH — skip rather than fail completion.
                nodeMissing = true;
                continue;
            }
            const lines = raw.split('\n').filter(l => l.trim().length > 0);
            const sig = lines.findIndex(l => /SyntaxError|Unexpected|Invalid/i.test(l));
            const slice = sig >= 0
                ? lines.slice(Math.max(0, sig - 1), sig + 2).join(' ')
                : lines.slice(0, 3).join(' ');
            failures.push(`${filePath} (node --check): ${slice}`);
        }
    }

    if (failures.length > 0) {
        return `Error: finish_task BLOCKED. The following file(s) you modified still have syntax errors. Fix them BEFORE calling finish_task again:\n\n` +
            failures.map(f => '  • ' + f).join('\n') +
            `\n\nUse verify_syntax to recheck after fixing.`;
    }

    onAgentStatus?.(`Task finished: ${args.summary}`);
    ctx._taskCompleted = true;
    // NOTE: use a DISTINCT event name ('finish_task'), NOT 'complete'.
    // The task-level 'complete' event (emitted by TaskBridge after run()
    // returns, carrying the full result.response as `message`) is what the
    // Chat UI renders as the final answer. If we also emit 'complete' here
    // it arrives FIRST with only `summary` (no `message`), so ChatView
    // resolves on it and shows the "(task complete)" placeholder instead of
    // the real summary. Keeping this event distinct avoids that collision.
    ctx.onToolEvent?.('finish_task', { summary: args.summary });

    // Soft reminder about TS files (not a block — just guidance).
    let tsNote = '';
    if (tsFiles.length > 0) {
        tsNote = `\n\n[Reminder] ${tsFiles.length} TypeScript file(s) were modified. ` +
            `If you haven't already, run the project's type checker ` +
            `(e.g. "npx tsc --noEmit") to catch type errors.`;
    }
    if (nodeMissing && jsFiles.length > 0) {
        tsNote += `\n[Note] 'node' was not on PATH, so JS files were not syntax-checked.`;
    }

    return `Success: Task completion declared. Summary: ${args.summary}${tsNote}`;
}

/**
 * ask_user — pause the run and ask the user a clarifying question. Unlike
 * finish_task (which declares the goal COMPLETE), this declares the agent
 * BLOCKED on user input: the loop reads ctx._awaitingUser and breaks cleanly,
 * returning the question as the turn's reply with a 'waiting' status. This is
 * the missing exit for tasks that genuinely need clarification — without it the
 * model can only reply text-only (which the loop pushes back on) and grinds
 * until a safety limit.
 */
export async function handleAskUser(ctx, args, onAgentStatus) {
    const question = String(args?.question || '').trim();
    if (!question) {
        return 'Error: ask_user requires a non-empty "question". State exactly what you need from the user and why you cannot proceed.';
    }
    const context = (args && typeof args.context === 'string') ? args.context.trim() : '';
    onAgentStatus?.(`Asking the user: ${question.slice(0, 80)}`);
    ctx._awaitingUser = true;
    ctx._userQuestion = context ? `${question}\n\n${context}` : question;
    ctx.onToolEvent?.('ask_user', { question, context });
    return `Acknowledged: question surfaced to the user. The run will now pause and wait for their reply. Do not call any further tools.`;
}

/** verify_syntax — JSON via JSON.parse, JS via `node --check`, TS skipped. */
export async function handleVerifySyntax(ctx, args, onAgentStatus, resolvedPath) {
    // Real-parser delegation strategy (industry standard):
    //   .json          → JSON.parse (in-process, reliable, instant)
    //   .js/.jsx/.mjs/.cjs → `node --check` (real V8 parser, ~100ms)
    //   .ts/.tsx       → skip with guidance (TS needs tsc, which is a project-level concern)
    //   other          → skip
    //
    // We deliberately do NOT do a hand-rolled regex+`new Function` check for
    // JS/TS anymore — it produced both false positives (rejecting valid modern
    // syntax) and false negatives (passing broken code that happened to look
    // JS-like after type-stripping). `node --check` is the real V8 parser and
    // gives the same answer Node itself would.
    onAgentStatus?.(`Verifying syntax: ${resolvedPath}...`);

    const lower = resolvedPath.toLowerCase();
    const isJson = lower.endsWith('.json');
    const isJs = /\.(js|jsx|mjs|cjs)$/.test(lower);
    const isTs = /\.(ts|tsx)$/.test(lower);

    if (isJson) {
        let src;
        try {
            src = await invoke('read_file', { path: resolvedPath });
        } catch (e) {
            return `Error: Cannot read file for syntax check: ${e.message || e}`;
        }
        try {
            JSON.parse(src);
            return `OK: ${resolvedPath} is valid JSON.`;
        } catch (e) {
            // Extract "at position N" → line/col for actionable feedback.
            const m = String(e.message).match(/position\s+(\d+)/i);
            let loc = '';
            if (m) {
                const pos = parseInt(m[1], 10);
                const before = src.slice(0, pos);
                const line = before.split('\n').length;
                const col = pos - before.lastIndexOf('\n');
                loc = ` (line ${line}, col ${col})`;
            }
            return `Error: JSON parse failure in ${resolvedPath}${loc} — ${e.message}`;
        }
    }

    if (isJs) {
        // Cross-platform path quoting for the shell.
        // PowerShell (Windows) and sh (Unix) both accept "double-quoted" paths,
        // and we escape any embedded double quotes.
        const quoted = `"${resolvedPath.replace(/"/g, '\\"')}"`;
        try {
            // node --check is silent on success (exit 0) and prints the SyntaxError
            // location to stderr on failure (exit 1). run_command throws on non-zero
            // exit, so a syntax error lands in the catch block below.
            await invoke('run_command', {
                command: `node --check ${quoted}`,
                cwd: ctx.workspacePath
            });
            return `OK: ${resolvedPath} parses without syntax errors (node --check).`;
        } catch (e) {
            const raw = String(e?.message || e || '');
            // Detect "node not found" so we can give a clearer message instead of
            // pretending the file is broken.
            if (/is not recognized|command not found|ENOENT/i.test(raw) &&
                !/SyntaxError/i.test(raw)) {
                return `Skipped: 'node' executable not found on PATH. ` +
                    `verify_syntax cannot check JavaScript files without Node installed. ` +
                    `Inspect the file manually or install Node.js.`;
            }
            // Surface only the most useful slice of node's output — the SyntaxError line
            // plus its caret pointer is usually all that's needed.
            const lines = raw.split('\n').filter(l => l.trim().length > 0);
            const sig = lines.findIndex(l => /SyntaxError|Unexpected|Invalid/i.test(l));
            const slice = sig >= 0
                ? lines.slice(Math.max(0, sig - 2), sig + 3).join('\n')
                : lines.slice(0, 8).join('\n');
            return `Error: Syntax error in ${resolvedPath} (node --check):\n${slice}\n\n` +
                `Fix this before doing anything else — the previous edit likely corrupted the file.`;
        }
    }

    if (isTs) {
        return `Skipped: verify_syntax does not directly check TypeScript. ` +
            `Catastrophic structural breakage (unbalanced braces/brackets) is already ` +
            `flagged automatically by multi_replace_file_content's auto read-back. ` +
            `For full type-checking, call: run_command("npx tsc --noEmit ${resolvedPath}") ` +
            `or run the project's type-check script.`;
    }

    return `Skipped: verify_syntax only checks .json / .js / .jsx / .mjs / .cjs. ` +
        `Got: ${resolvedPath}. For other languages, invoke the appropriate checker via run_command ` +
        `(e.g. "python -m py_compile <file>", "cargo check").`;
}

/** task_progress — set/update/get the persisted subtask checklist. */
export async function handleTaskProgress(ctx, args) {
    await ctx._loadTaskProgress();
    const action = (args.action || '').toLowerCase();

    if (action === 'get' || (!action && (!args.items || args.items.length === 0))) {
        return ctx._renderTaskProgress();
    }

    if (action === 'set') {
        const items = Array.isArray(args.items) ? args.items : [];
        ctx._taskProgressItems = items.map(it => ({
            id: String(it.id ?? ''),
            title: String(it.title ?? ''),
            status: ['pending', 'in_progress', 'completed', 'blocked'].includes(it.status)
                ? it.status : 'pending',
            note: it.note ? String(it.note).slice(0, 200) : ''
        })).filter(it => it.id);
        // A fresh `set` replaces the whole list → no longer a prior-session carryover.
        ctx._taskProgressCarriedOver = false;
        await ctx._saveTaskProgress();
        ctx.onToolEvent?.('task_progress', { items: ctx._taskProgressItems });
        return `Set ${ctx._taskProgressItems.length} subtask(s).\n${ctx._renderTaskProgress()}`;
    }

    if (action === 'update') {
        const patches = Array.isArray(args.items) ? args.items : [];
        let updated = 0;
        for (const patch of patches) {
            const id = String(patch.id ?? '');
            if (!id) continue;
            const target = ctx._taskProgressItems.find(it => it.id === id);
            if (!target) continue;
            // Strict schema sends null (not undefined) for fields left
            // unchanged on update — treat null as "leave as-is".
            if (patch.title != null) target.title = String(patch.title);
            if (patch.status != null &&
                ['pending', 'in_progress', 'completed', 'blocked'].includes(patch.status)) {
                target.status = patch.status;
            }
            if (patch.note != null) target.note = String(patch.note).slice(0, 200);
            updated++;
        }
        await ctx._saveTaskProgress();
        ctx.onToolEvent?.('task_progress', { items: ctx._taskProgressItems });
        return `Updated ${updated} subtask(s).\n${ctx._renderTaskProgress()}`;
    }

    return `Error: task_progress action must be one of "set" / "update" / "get". Got: ${args.action}`;
}
