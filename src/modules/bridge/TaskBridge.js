import { listen, emit } from '@tauri-apps/api/event';
import { AgentController } from '../ai/AgentController.js';
import { projectContext } from '../ai/ProjectContext.js';
import llmService from '../ai/LLMService.js';
import { resolveLane, usesProjectContext } from '../ai/agent/RunLane.js';

// How many finished tasks keep their file cache for a possible continuation.
// Continuations happen within minutes of a task finishing, so a handful covers
// the real usage; the cap is what stops a long session accumulating file
// contents for every task it has ever run.
const CACHED_TASKS = 8;

class TaskBridge {
    constructor() {
        this.activeAgents = new Map(); // taskId -> { controller, abortController }
        this.activeSingleShots = new Map(); // taskId -> AbortController
        this.pendingConfirmations = new Map(); // confirmId -> { resolve, reject }
        // taskId -> the finished run's ToolExecutor file cache, so CONTINUING a
        // task does not start blind. Every run builds a fresh AgentController
        // (and therefore a fresh ToolExecutor), which is why this has to live
        // out here rather than on the controller. Bounded two ways: each cache
        // is trimmed on adoption (ToolExecutor.adoptFileCache) and only the most
        // recent CACHED_TASKS tasks are kept.
        this.taskFileCaches = new Map();
    }

    async init() {
        console.log("TaskBridge: Initializing task bridge listeners...");

        // 1. Listen for new tasks from Rust backend (REST API triggers this).
        //
        // payload: { taskId, prompt, workspacePath, context?, behavior?, clientContext?, chatContext? }
        //
        // behavior dispatches the execution mode:
        //   - undefined / "iterative_agent" → full AgentController loop (existing path)
        //   - "single_shot"                  → one LLM call, no tools, no iteration
        //   - "record"                       → NO call at all; an exchange that
        //                                      already happened, written down
        await listen('run-task', async (event) => {
            const payload = event.payload;
            console.log("TaskBridge: Received run-task event:", payload);

            const {
                taskId,
                prompt,
                workspacePath,
                context,
                behavior,
                clientContext,
                chatContext,
                images,
                caller,
            } = payload;

            const mode = behavior?.mode || 'iterative_agent';
            // The lane decides the engine (agent/RunLane.js). A transform is the
            // one-shot path; ask and build are the agent loop.
            const lane = resolveLane(behavior || {}, { caller });

            if (mode === 'record') {
                this.recordExchange(taskId, chatContext);
            } else if (lane.error) {
                this.emitTaskEvent(taskId, 'error', { error: lane.error, terminal: true });
            } else if (lane.shape === 'transform') {
                await this.runSingleShot(taskId, prompt, behavior, context);
            } else {
                // A run without a workspace lane does not get the path the caller
                // sent — not even to scan. AgentController enforces the same thing;
                // doing it here too keeps the project scanner from indexing a
                // folder the run may not read.
                await this.startAgentTask(
                    taskId, prompt, usesProjectContext(lane) ? workspacePath : null,
                    clientContext || context, chatContext, behavior, images || [], caller
                );
            }
        });

        // 2. Listen for confirmation responses (approved or denied) from Client or Dashboard
        await listen('confirm-response', (event) => {
            const { confirmId, approved, modifiedContent, always } = event.payload;
            console.log("TaskBridge: Received confirm-response event:", confirmId, approved, always ? '(always)' : '');

            const promise = this.pendingConfirmations.get(confirmId);
            if (!promise) {
                // Answering something already settled. Not an error — a stale
                // approval card is easy to click twice — but it must not be
                // swallowed in silence: the card that produced this click looked
                // live, and the user is owed the knowledge that it was not.
                console.warn('TaskBridge: confirm-response for an unknown or already-settled confirmation:', confirmId);
                // And a console line is not "the user is owed the knowledge".
                //
                // If some OTHER task is still parked on a question, this answer
                // was meant for it and did not arrive: the card in the feed says
                // 承認済み (the client marks it optimistically the moment the
                // packet leaves the browser) while the run waits for an answer
                // that will never come — no error, no status, nothing in the
                // log, for as long as the app stays open.
                //
                // Say it where the person is looking. It cannot repair the
                // mismatch, but "your approval did not reach the run" is the
                // difference between pressing Stop now and waiting an hour.
                for (const [, waiting] of this.pendingConfirmations) {
                    this.emitTaskEvent(waiting.taskId, 'status', {
                        status: 'running',
                        message: '⚠️ 承認の応答が実行中の確認と一致しませんでした（この画面のカードは古い可能性があります）。'
                            + 'この実行はまだ承認を待っています — もう一度承認するか、中止してください。',
                    });
                }
                return;
            }
            if (promise) {
                this.pendingConfirmations.delete(confirmId);
                // Tell every view the question is closed. Without this the only
                // evidence was circumstantial — "did work happen afterwards?" —
                // which the Story guessed at and the Raw Log never checked, so an
                // approved card stayed clickable there for the life of the task.
                this.emitTaskEvent(promise.taskId, 'confirm_resolved', { confirmId, approved: !!approved });
                if (approved) {
                    // "Always allow" → resolve with an object carrying the flag so the
                    // run_command handler can persist the command to the whitelist.
                    // (Still truthy, so _confirmUnsafe-based callers treat it as approved.)
                    if (always) {
                        promise.resolve({ always: true });
                    } else {
                        // Use != null (loose) so both null and undefined fall back to true.
                        // MonitorView sends modifiedContent: null for plan/command approvals
                        // (only diff_review carries actual string content), so a null here
                        // must NOT be treated as falsy rejection.
                        promise.resolve(modifiedContent != null ? modifiedContent : true);
                    }
                } else {
                    promise.resolve(false);
                }
            }
        });

        // 3. Listen for abort tasks
        await listen('abort-task', (event) => {
            const { taskId } = event.payload;
            console.log("TaskBridge: Received abort-task event for:", taskId);
            this.abortAgentTask(taskId);
        });

        // 4. Listen for mid-flight steering
        await listen('steering-task', (event) => {
            const { taskId, message, images } = event.payload;
            console.log("TaskBridge: Received steering-task event for:", taskId);
            const agent = this.activeAgents.get(taskId);
            if (agent && agent.controller) {
                agent.controller.addSteeringMessage({ message, images: images || [] });
            }
        });
    }

    /**
     * Write down an exchange that ALREADY HAPPENED. No LLM call.
     *
     * Spotlight answers in its own window, off its own loop, and keeps nothing
     * (docs/design/information-architecture.md §5). "Expand" is how an answer
     * crosses into Work — and it used to cross by handing the question to
     * `createTask`, which RAN IT AGAIN: a second call, a second wait and a
     * second bill for text already on the user's screen. `chatContext` was
     * passed along, so the run knew the previous answer and dutifully produced
     * another one; the measured cost of expanding one search was 22 seconds and
     * 9.9k tokens.
     *
     * Two more symptoms came from the same decision. Running needs somewhere to
     * run, so the promote invented a workspace out of `jhai_last_ws` — which
     * `rememberWorkspace` then added to approved_projects, filling the picker
     * with folders the search had nothing to do with. And running as
     * `interaction: 'ask'` handed the turn eighteen read-only tools to work a
     * workspace the user never chose.
     *
     * Recording removes all three: nothing runs, so there is nothing to give a
     * workspace or tools to. What lands in Work is the exchange itself, already
     * complete, and `/tasks/:id/continue` is there for when the user does want
     * it to become work — at which point they pick the workspace themselves.
     *
     * The answer arrives in `chatContext` rather than in a new behavior field on
     * purpose: `chat_context` is already carried end to end (CreateTaskRequest →
     * RunTaskPayload → here) as an untyped array, whereas serde silently DROPS
     * a behavior key that has no matching struct field in router.rs — the exact
     * failure the `interaction` field's own comment records.
     *
     * @param {string} taskId
     * @param {Array}  chatContext [{role, content}, …] — the last assistant
     *                             message is the answer being recorded.
     */
    recordExchange(taskId, chatContext) {
        const turns = Array.isArray(chatContext) ? chatContext : [];
        const answer = [...turns].reverse()
            .find(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content);

        if (!answer) {
            // Nothing to write down. An empty completed task would be worse than
            // an error: it looks like the answer was lost rather than never sent.
            this.emitTaskEvent(taskId, 'error', {
                error: 'Nothing to record: the exchange carried no answer.',
                terminal: true,
            });
            return;
        }

        // No token_usage event. The cost was paid by whoever produced the
        // answer, and reporting it again here would double it in the dashboard.
        this.emitTaskEvent(taskId, 'complete', {
            message: answer.content,
            answer: answer.content,
            modifiedFiles: [],
            resultSummary: { summary: answer.content, answer: answer.content, files: [] },
        });
    }

    /**
     * Single-shot execution: one LLM call, no tools, no iteration.
     *
     * For lightweight callers like JHER ("generate this SQL", "suggest these FKs")
     * where the full agent loop is overkill. Streams chunks back via the same
     * task-event-bridge mechanism so the existing UI can render progress.
     *
     * behavior fields used:
     *   - system_prompt        (required for useful results)
     *   - extra_instructions   (appended after system_prompt)
     *   - response_format      (passed as hint; "json" requests structured output)
     */
    async runSingleShot(taskId, prompt, behavior, context) {
        const abortController = new AbortController();
        this.activeSingleShots.set(taskId, abortController);

        try {
            // Compose final system prompt from behavior (no ContextBuilder for single-shot).
            let systemPrompt = behavior?.system_prompt || 'You are a helpful AI assistant.';
            if (behavior?.extra_instructions) {
                systemPrompt += '\n\n' + behavior.extra_instructions;
            }

            // If caller supplied structured context, surface it to the model as a
            // system-attached <context> block. This keeps the user `prompt` clean.
            if (context !== undefined && context !== null) {
                const contextStr = typeof context === 'string'
                    ? context
                    : JSON.stringify(context, null, 2);
                systemPrompt += `\n\n<context>\n${contextStr}\n</context>`;
            }

            // For response_format=json, prepend a strict format hint. (Full
            // response_format parameter passing to the LLM API would need
            // Rust-side support; this prompt-level hint is the portable version.)
            if (behavior?.response_format === 'json') {
                systemPrompt += '\n\nIMPORTANT: Respond with ONLY valid JSON. No prose, no markdown fences.';
            } else if (behavior?.response_format === 'code') {
                systemPrompt += '\n\nIMPORTANT: Respond with ONLY the code wrapped in a single markdown code block. No prose explanation.';
            }

            let fullResponse = '';

            this.emitTaskEvent(taskId, 'status', {
                status: 'running',
                message: 'Single-shot generation…',
                progress: 0.1
            });

            const genResult = await llmService.chat(
                [{ role: 'user', content: prompt }],
                systemPrompt,
                (chunk) => {
                    fullResponse += chunk;
                    this.emitTaskEvent(taskId, 'stream', { chunk });
                },
                abortController.signal,
                []
            );

            // Report token usage so the monitor/analytics aren't stuck at 0 for
            // single-shot tasks (e.g. QuickSearch). chat() returns real usage
            // (or an estimate fallback).
            if (genResult?.usage) {
                this.emitTaskEvent(taskId, 'token_usage', {
                    model: llmService.getCurrentModel?.() || '',
                    prompt_tokens: genResult.usage.prompt_tokens || 0,
                    completion_tokens: genResult.usage.completion_tokens || 0,
                    total_tokens: genResult.usage.total_tokens || 0,
                    cache_read_input_tokens: genResult.usage.cache_read_input_tokens || 0,
                    cache_creation_input_tokens: genResult.usage.cache_creation_input_tokens || 0
                });
            }

            // The text as it streamed — or, from a provider that returned it whole
            // without streaming, as it came back. Streamed chunks alone left such a
            // run "complete" with an empty answer.
            const text = fullResponse || String(genResult?.content || '');
            this.emitTaskEvent(taskId, 'complete', {
                message: text,
                answer: text,
                modifiedFiles: [],
                resultSummary: { summary: text, answer: text, files: [] }
            });
        } catch (err) {
            console.error('TaskBridge: single_shot error:', err);
            this.emitTaskEvent(taskId, 'error', {
                error: err.message || String(err),
                terminal: true
            });
        } finally {
            this.activeSingleShots.delete(taskId);
        }
    }

    async startAgentTask(taskId, prompt, workspacePath, clientContext, chatContext = [], behavior = null, images = [], caller = null) {
        // Prevent duplicate tasks
        if (this.activeAgents.has(taskId)) {
            console.warn("TaskBridge: Task already running:", taskId);
            return;
        }

        const controller = new AgentController();
        const abortController = new AbortController();

        // A CONTINUATION picks up where the previous run of this task left off.
        // Only for a continuation (chatContext present): a task id being reused
        // for unrelated work should not inherit a stale map of the workspace.
        if (Array.isArray(chatContext) && chatContext.length > 0) {
            const prior = this.taskFileCaches.get(taskId);
            if (prior) controller.toolExecutor.adoptFileCache?.(prior);
        }

        // Apply behavior overrides to the controller before run.
        // (controller.run reads these at the top of its loop.)
        if (behavior) {
            controller.behaviorOverrides = behavior;
        }
        controller.caller = caller;

        this.activeAgents.set(taskId, { controller, abortController });

        // Scan project context — WITHOUT blocking the task start. The scanner is a
        // process-wide singleton (ProjectContext): with two tasks starting close
        // together, the first scan sets `isScanning` and the second call returns
        // immediately (skipped), so awaiting it delays nothing anyway — but it DID
        // serialize the two starts (task B waited for task A's scan on the same
        // thread and, under a slow disk, looked frozen). Kicking it off without
        // await lets every task start immediately; the scan result is best-effort
        // context for the system prompt, and ContextBuilder reads it per-step, so
        // a task that starts before the scan lands simply gets the last good state.
        projectContext.scanProject(workspacePath).catch(e => {
            console.error("TaskBridge: Project scan failed:", e);
        });

        // Run the agent loop
        try {
            const result = await controller.run(
                prompt,
                workspacePath,
                // onUpdate: stream response chunks
                (chunk) => {
                    this.emitTaskEvent(taskId, 'stream', { chunk });
                },
                // onAgentStatus: progress logs, tool calls, thoughts, errors
                (statusPayload) => {
                    const { event, ...data } = statusPayload;
                    this.emitTaskEvent(taskId, event, data);
                },
                // onConfirm: prompt for user approval
                async (confirmData) => {
                    return new Promise((resolve, reject) => {
                        const confirmId = `conf_${Date.now()}_${Math.random().toString(36).substring(4)}`;
                        // taskId is kept so aborting a run can settle whatever it
                        // was parked on — see abortAgentTask.
                        this.pendingConfirmations.set(confirmId, { resolve, reject, taskId });
                        
                        this.emitTaskEvent(taskId, 'confirm_request', {
                            confirmId,
                            ...confirmData
                        });
                    });
                },
                clientContext,
                chatContext,
                (logData) => {
                    this.emitTaskEvent(taskId, 'log', logData);
                },
                abortController.signal,
                '',
                images
            );

            // Emit completion
            this.emitTaskEvent(taskId, 'complete', {
                message: result.response,
                // The deliverable — what present_result carried, or the long
                // answer. `message` is finish_task's one-line summary, and a
                // client that showed it (the JHEditor chat did) showed a summary
                // of an answer the user never got to read.
                answer: result.resultSummary?.answer || result.response || '',
                modifiedFiles: result.modifiedFiles,
                resultSummary: result.resultSummary,
                // Set when a safety limit cut the run short instead of the agent
                // finishing. The task still completes — the work so far is real and
                // resumable — but the UI must not present it as a clean finish.
                stopReason: result.stopReason || null,
            });

        } catch (err) {
            console.error("TaskBridge: Agent run error:", err);
            // terminal:true = the RUN IS OVER. AgentController also emits 'error'
            // events mid-run for RECOVERABLE failures (generation retry etc.) —
            // those lack this flag, and the UI/notifications must not treat them
            // as "task failed" (the run continues).
            this.emitTaskEvent(taskId, 'error', {
                error: err.message || String(err),
                terminal: true
            });
        } finally {
            // A run can also end while an approval is outstanding — an abort
            // signal caught elsewhere in the loop, or a throw. Leaving the entry
            // behind would keep a dead task's dialog live in the registry.
            this._settlePendingConfirmations(taskId);
            this.activeAgents.delete(taskId);
            // What this run learned about the files it touched, kept for the
            // continuation that may follow. In `finally` deliberately: a run that
            // was stopped or threw is the one most likely to be continued, and
            // its reading is no less valid for having ended badly.
            this._rememberFileCache(taskId, controller);
            // A run started BY a trigger holds that trigger's concurrency slot.
            // Released here rather than on the success path: a run that threw
            // still ended, and a slot never given back means the trigger goes
            // quiet for ever with no error to explain it.
            this._releaseTrigger(behavior, taskId);
        }
    }


    /**
     * Keep a finished run's file cache for a possible continuation of that task.
     *
     * The map is capped at CACHED_TASKS entries, evicting the least recently
     * finished: a long session can run dozens of tasks, and each cache holds file
     * contents. Re-inserting moves a task back to the end, so the ones being
     * actively continued are the ones that survive.
     */
    _rememberFileCache(taskId, controller) {
        const cache = controller?.toolExecutor?.getFileCache?.();
        if (!(cache instanceof Map) || cache.size === 0) return;
        this.taskFileCaches.delete(taskId);
        this.taskFileCaches.set(taskId, cache);
        while (this.taskFileCaches.size > CACHED_TASKS) {
            const oldest = this.taskFileCaches.keys().next().value;
            this.taskFileCaches.delete(oldest);
        }
    }

    /**
     * Hand a triggered run's concurrency slot back.
     *
     * The trigger that started this run is carried in the behavior it was
     * created with (TriggerManager._fire), so nothing has to be looked up.
     * Imported lazily: the bridge should not depend on the autonomy layer at
     * module load, and a build with no triggers configured still works.
     */
    async _releaseTrigger(behavior, taskId) {
        const jobId = behavior?.mcp_context?.job?.id;
        if (!jobId) return;
        try {
            const { jobManager } = await import('../ai/jobs/JobManager.js');
            // What it cost, recorded at the moment it is knowable. `reconcile`
            // exists for the case where the app was closed in between; a total
            // that quietly under-reports is worse than no total.
            let usage = null;
            let cost = 0;
            try {
                const task = await globalThis.window?.apiClient?.getTask?.(taskId);
                usage = task?.token_usage || null;
                // Priced here, from the task's per-model breakdown: the token
                // report has no cost field of its own.
                cost = await jobManager._priceTask(task);
            } catch (_) { /* reconcile will pick it up later */ }
            jobManager.noteUsage(jobId, taskId, usage, cost);
        } catch (_) { /* nothing to release if the module is absent */ }
    }

    /**
     * Settle anything this task is parked on, so Stop actually stops it.
     *
     * A pending approval is a bare Promise with no timeout and no abort wiring:
     * the only thing that ever settles it is a `confirm-response` carrying its
     * exact confirmId. So a run waiting on "may I run this command?" was sitting
     * inside `await onConfirm(...)`, never reaching the loop's next abort check
     * — Stop marked the task aborted in the UI while the agent stayed stuck on
     * the question forever, and the entry leaked.
     *
     * Resolved false rather than rejected: every handler already reads false as
     * "the user said no" and returns a clean `Error: User Denied`, which lets the
     * loop unwind normally and see the abort signal. A rejection would surface as
     * a tool crash for something the user deliberately did.
     */
    _settlePendingConfirmations(taskId) {
        for (const [id, entry] of [...this.pendingConfirmations]) {
            if (entry?.taskId !== taskId) continue;
            this.pendingConfirmations.delete(id);
            this.emitTaskEvent(taskId, 'confirm_resolved', { confirmId: id, approved: false });
            try { entry.resolve(false); } catch (_) { /* already settled */ }
        }
    }

    abortAgentTask(taskId) {
        // Try iterative-agent path first
        const agent = this.activeAgents.get(taskId);
        if (agent) {
            agent.abortController.abort();
            this._settlePendingConfirmations(taskId);
            this.activeAgents.delete(taskId);
            this.emitTaskEvent(taskId, 'status', { status: 'aborted', message: 'Task aborted by user.' });
            return;
        }
        // Try single-shot path
        const singleAbort = this.activeSingleShots.get(taskId);
        if (singleAbort) {
            singleAbort.abort();
            this.activeSingleShots.delete(taskId);
            this.emitTaskEvent(taskId, 'status', { status: 'aborted', message: 'Single-shot aborted by user.' });
        }
    }

    emitTaskEvent(taskId, eventType, data) {
        // Classify event priority for client-side filtering
        const HIGH_PRIORITY_EVENTS = ['confirm_request', 'complete', 'error'];
        const priority = HIGH_PRIORITY_EVENTS.includes(eventType) ? 'high' : 'low';

        // Broadcast task event to Tauri backend so it can pipe it to WebSocket clients
        emit('task-event-bridge', {
            taskId,
            event: eventType,
            data,
            priority,
            timestamp: new Date().toISOString()
        });
    }
}

export const taskBridge = new TaskBridge();
