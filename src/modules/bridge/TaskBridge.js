import { listen, emit } from '@tauri-apps/api/event';
import { AgentController } from '../ai/AgentController.js';
import { projectContext } from '../ai/ProjectContext.js';
import llmService from '../ai/LLMService.js';

class TaskBridge {
    constructor() {
        this.activeAgents = new Map(); // taskId -> { controller, abortController }
        this.activeSingleShots = new Map(); // taskId -> AbortController
        this.pendingConfirmations = new Map(); // confirmId -> { resolve, reject }
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

            if (mode === 'single_shot') {
                await this.runSingleShot(taskId, prompt, behavior, context);
            } else {
                // Existing path. behavior (if any) is forwarded so AgentController
                // can honor system_prompt / enabled_tools / max_iterations overrides.
                await this.startAgentTask(
                    taskId, prompt, workspacePath,
                    clientContext || context, chatContext, behavior, images || [], caller
                );
            }
        });

        // 2. Listen for confirmation responses (approved or denied) from Client or Dashboard
        await listen('confirm-response', (event) => {
            const { confirmId, approved, modifiedContent } = event.payload;
            console.log("TaskBridge: Received confirm-response event:", confirmId, approved);

            const promise = this.pendingConfirmations.get(confirmId);
            if (promise) {
                this.pendingConfirmations.delete(confirmId);
                if (approved) {
                    // Use != null (loose) so both null and undefined fall back to true.
                    // MonitorView sends modifiedContent: null for plan/command approvals
                    // (only diff_review carries actual string content), so a null here
                    // must NOT be treated as falsy rejection.
                    promise.resolve(modifiedContent != null ? modifiedContent : true);
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
                    prompt_tokens: genResult.usage.prompt_tokens || 0,
                    completion_tokens: genResult.usage.completion_tokens || 0,
                    total_tokens: genResult.usage.total_tokens || 0,
                    cache_read_input_tokens: genResult.usage.cache_read_input_tokens || 0,
                    cache_creation_input_tokens: genResult.usage.cache_creation_input_tokens || 0
                });
            }

            this.emitTaskEvent(taskId, 'complete', {
                message: fullResponse,
                modifiedFiles: [],
                resultSummary: { summary: fullResponse, files: [] }
            });
        } catch (err) {
            console.error('TaskBridge: single_shot error:', err);
            this.emitTaskEvent(taskId, 'error', {
                error: err.message || String(err)
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

        // Apply behavior overrides to the controller before run.
        // (controller.run reads these at the top of its loop.)
        if (behavior) {
            controller.behaviorOverrides = behavior;
        }
        controller.caller = caller;

        this.activeAgents.set(taskId, { controller, abortController });

        // Scan project context first
        try {
            await projectContext.scanProject(workspacePath);
        } catch (e) {
            console.error("TaskBridge: Project scan failed:", e);
        }

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
                        this.pendingConfirmations.set(confirmId, { resolve, reject });
                        
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
                modifiedFiles: result.modifiedFiles,
                resultSummary: result.resultSummary
            });

        } catch (err) {
            console.error("TaskBridge: Agent run error:", err);
            this.emitTaskEvent(taskId, 'error', {
                error: err.message || String(err)
            });
        } finally {
            this.activeAgents.delete(taskId);
        }
    }

    abortAgentTask(taskId) {
        // Try iterative-agent path first
        const agent = this.activeAgents.get(taskId);
        if (agent) {
            agent.abortController.abort();
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
