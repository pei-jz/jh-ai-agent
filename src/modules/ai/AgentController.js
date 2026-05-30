import llmService from './LLMService.js';
import { workflowManager, WorkflowPhases } from './WorkflowManager.js';
import { toolExecutor } from './ToolExecutor.js';
import { contextBuilder, ContextBuilder } from './ContextBuilder.js';
import { conversationMemory } from './ConversationMemory.js';
import { jsonrepair } from 'jsonrepair';
import { invoke } from '@tauri-apps/api/core';

export class AgentController {
    constructor() {
        this.baseMaxIterations = 100;
        this.maxIterations = this.baseMaxIterations;
        this.steeringQueue = [];
        // Optional per-task overrides set by the caller (e.g. TaskBridge from a
        // REST API call). Honored at .run() time. Fields are the same shape as
        // the Rust AgentBehavior struct: { system_prompt, enabled_tools,
        // max_iterations, extra_instructions, response_format }.
        this.behaviorOverrides = null;
    }

    addSteeringMessage(msg) {
        this.steeringQueue.push(msg);
    }

    async run(prompt, workspacePath, onUpdate, onAgentStatus, onConfirm, clientContext = null, chatContext = [], onLog = null, abortSignal = null, kisContext = '', images = []) {
        chatContext = chatContext || [];
        images = images || [];

        // Re-resolve the active LLM connection from settings every run so
        // edits in Settings → LLM Connections take effect without a restart.
        // (If the user removed the previously-active instance, this re-picks the first available one.)
        await llmService.initFromConfig();

        workflowManager.setPhase(WorkflowPhases.RESEARCH);
        
        // Phase 2: Goal-pinning — original user goal is always the first message
        let history = [];
        if (chatContext.length > 0) {
            history.push(...chatContext);
        }
        history.push({ role: 'user', content: `[Original Goal] ${prompt}` });
        
        // ── Agent Loop State Machine ──────────────────────────────────
        //
        //  RUNNING  ──[tool call]──► RUNNING   (execute tools, continue)
        //           ──[finish_task]─► DONE      (immediate exit)
        //           ──[text only, 1st time]──► RUNNING (re-prompt once)
        //           ──[text only, 3× in row]──► DONE   (model stuck)
        //           ──[3× errors]──► DONE
        //           ──[max iterations / budget / abort]──► DONE
        //
        //  Exit is ONLY via finish_task, safety limits, or the stuck-detector.
        //  Text-only replies are never treated as completion on their own.
        // ─────────────────────────────────────────────────────────────
        let iteration = 0;
        let finalResponse = '';
        let lastToolCallSignature = '';
        let repeatCount = 0;
        let jsonParseRetryCount = 0;
        let consecutiveErrorCount = 0;
        let textOnlyCount = 0;   // consecutive text-only responses (no tool call, no finish_task)
        let toolCallHistory = [];
        let usedToolTypes = new Set();

        // ── Load all Agent Safety Limits from config ─────────────────
        // For each field: 0 / null / undefined / non-numeric is treated as
        // "disabled / unlimited". Any positive integer is the hard threshold.
        const safety = await this._loadSafetyLimits();
        // Apply the configurable history-budget ratio to the compaction logic.
        conversationMemory.setBudgetConfig({ ratio: safety.historyBudgetRatio });
        this.baseMaxIterations = safety.maxSteps;
        // Per-task override from behavior (e.g. REST API caller). 0 stays unlimited.
        if (this.behaviorOverrides && Number.isFinite(this.behaviorOverrides.max_iterations)) {
            this.baseMaxIterations = Math.max(0, this.behaviorOverrides.max_iterations);
        }
        this.maxIterations = this.baseMaxIterations;

        // Convenience flag for the loop-exit / progress-reporting sites.
        const isUnlimited = this.maxIterations <= 0;

        // ── Per-run safety trackers (reset each run) ─────────────────
        const taskStartMs = Date.now();
        let cumulativeTokens = 0;
        let tokenBudgetWarned = false;
        let wallClockWarned = false;
        let identicalWarned = false;
        let cycleWarned = false;
        let noProgressWarned = false;
        // bool[] — one entry per iteration: true if any mutating tool was called.
        const progressHistory = [];
        // Tools that count as "real progress" for the no-progress detector.
        // Anything not in this list (read_file/grep_search/list_files/open_file)
        // is exploratory and does NOT count.
        const MUTATING_TOOLS = new Set([
            'write_file', 'write_to_file',
            'multi_replace_file_content',
            'create_artifact', 'update_artifact',
            'run_command',     // count as progress — conservative (avoids false stops)
            'delete_file', 'move_file',
            'finish_task',     // terminal — also counts as "progress" (will end loop)
        ]);

        await toolExecutor.startSession(workspacePath);

        // Invalidate ContextBuilder's static cache so the new session gets a
        // fresh build (picks up any persona/config changes since last run).
        contextBuilder.invalidateStaticCache();

        // Non-blocking cleanup of old session directories (>30 days).
        // Runs in the background — failures are silently ignored.
        this._cleanupOldSessions(workspacePath).catch(() => {});

        // Apply behavior's enabled_tools allowlist (if any). null/undefined means
        // unrestricted (default); an empty array disables all tools except finish_task.
        if (this.behaviorOverrides && Array.isArray(this.behaviorOverrides.enabled_tools)) {
            toolExecutor.setToolAllowlist(this.behaviorOverrides.enabled_tools);
        }
        // Apply MCP server filter (if any) — restricts which MCP servers contribute tools.
        if (this.behaviorOverrides && Array.isArray(this.behaviorOverrides.mcp_servers)) {
            toolExecutor.setMcpServerFilter(this.behaviorOverrides.mcp_servers);
        } else {
            toolExecutor.setMcpServerFilter(null);
        }

        // Bind tool executor event forwarding
        toolExecutor.onToolEvent = (event, data) => {
            onAgentStatus?.({ event, ...data });
        };

        // Phase 4: Load KIs (Skills & Workflows) if not provided
        if (!kisContext) {
            try {
                const root = workspacePath;
                if (root) {
                    let loadedKis = [];
                    try {
                        const skillsData = await invoke('read_file', { path: `${root}/.agent/skills.json` });
                        if (skillsData) loadedKis.push('--- SKILLS ---\n' + skillsData);
                    } catch (e) { /* ignore */ }
                    
                    try {
                        const workflowsData = await invoke('read_file', { path: `${root}/.agent/workflows.json` });
                        if (workflowsData) loadedKis.push('--- WORKFLOWS ---\n' + workflowsData);
                    } catch (e) { /* ignore */ }

                    if (loadedKis.length > 0) {
                        kisContext = loadedKis.join('\n\n');
                        onAgentStatus?.({ event: 'status', status: 'running', message: 'Loaded project knowledge items.' });
                    }
                }
            } catch (e) {
                console.warn('Failed to load KIs:', e);
            }
        }

        while (isUnlimited || iteration < this.maxIterations) {
            if (abortSignal?.aborted) {
                onAgentStatus?.({ event: 'status', status: 'aborted', message: 'Process aborted by user.' });
                break;
            }

            // Sync task_plan.md check
            try {
                const path = `${toolExecutor.getSessionArtifactDir(workspacePath)}/task_plan.md`;
                const fileData = await invoke('read_file', { path });
                if (fileData) {
                    onAgentStatus?.({ event: 'task_plan_sync', content: fileData });
                }
            } catch (e) { }

            iteration++;

            // For unlimited mode, progress can't be a real ratio — use a soft
            // asymptotic curve so the UI bar still creeps forward without ever
            // reaching 100% prematurely. (1 - 50/(iteration+50) gives 0.5 at
            // step 50, ~0.66 at 100, ~0.8 at 200, ~0.95 at 950.)
            const progress = isUnlimited
                ? (1 - 50 / (iteration + 50))
                : iteration / this.maxIterations;
            onAgentStatus?.({ event: 'status', status: 'running', progress, message: `Thinking... (step ${iteration})` });

            // ── Wall-clock budget enforcement ──────────────────────────
            // Hard stop at 100% of budget. Soft reminder once at 80%.
            if (safety.wallClockMinutes > 0) {
                const elapsedMs = Date.now() - taskStartMs;
                const budgetMs = safety.wallClockMinutes * 60 * 1000;
                if (elapsedMs >= budgetMs) {
                    onAgentStatus?.({ event: 'status', status: 'running', message: `Wall-clock budget (${safety.wallClockMinutes} min) reached — auto-stopping.` });
                    finalResponse = (finalResponse || '') +
                        `\n\n(注意: 実行時間が予算 ${safety.wallClockMinutes} 分に到達したため、自動停止しました。Settings → General → Wall-clock Timeout で調整できます。)`;
                    break;
                }
                if (elapsedMs >= budgetMs * 0.8 && !wallClockWarned) {
                    wallClockWarned = true;
                    history.push({
                        role: 'user',
                        content: `[System Notice] You've been running for ${Math.round(elapsedMs / 60000)} minutes — 80% of the ${safety.wallClockMinutes}-minute budget. Please wrap up: call \`finish_task\` if the goal is achieved, or summarize progress and report blockers to the user.`
                    });
                }
            }

            // ── Token budget enforcement (cumulativeTokens updated below per LLM call) ──
            if (safety.tokenBudget > 0) {
                if (cumulativeTokens >= safety.tokenBudget) {
                    onAgentStatus?.({ event: 'status', status: 'running', message: `Token budget (${safety.tokenBudget.toLocaleString()}) reached — auto-stopping.` });
                    finalResponse = (finalResponse || '') +
                        `\n\n(注意: 累積トークン数が予算 ${safety.tokenBudget.toLocaleString()} に到達したため、自動停止しました。Settings → General → Token Budget で調整できます。)`;
                    break;
                }
                if (cumulativeTokens >= safety.tokenBudget * 0.8 && !tokenBudgetWarned) {
                    tokenBudgetWarned = true;
                    history.push({
                        role: 'user',
                        content: `[System Notice] You've consumed ${cumulativeTokens.toLocaleString()} of ${safety.tokenBudget.toLocaleString()} budgeted tokens (80%). Please prioritize: call \`finish_task\` if the goal is essentially achieved, otherwise summarize progress so the user can extend the budget if needed.`
                    });
                }
            }

            // Apply steering
            if (this.steeringQueue && this.steeringQueue.length > 0) {
                const messages = this.steeringQueue.splice(0, this.steeringQueue.length);
                const steeringText = messages.join('\n\n');
                history.push({
                    role: 'user',
                    content: `[Steering Instruction / Course Correction]\nReceived the following instruction from the user during execution. Please reflect it in your plan and approach immediately:\n${steeringText}`
                });
                // Emit a dedicated event so the UI can show a visible acknowledgment.
                const preview = steeringText.split('\n')[0].substring(0, 80);
                onAgentStatus?.({ event: 'steering_received', message: `📌 Steering received: "${preview}"` });
                onAgentStatus?.({ event: 'status', status: 'running', message: `📌 Steering applied: "${preview}"` });
            }

            // On the first iteration, force the agent to register subtasks when
            // the prompt looks like a multi-step task. This runtime injection is
            // more salient than a static rule and reduces "lost progress on compaction".
            if (iteration === 1 && this._looksComplex(prompt)) {
                history.push({
                    role: 'user',
                    content: '[Planning Required] This task has multiple steps. Your VERY FIRST tool call MUST be `task_progress(action="set", items=[...])` — list every subtask before touching any file or running any command. After registering, proceed immediately with execution without waiting for confirmation.'
                });
            }

            const startTime = Date.now();
            let genResult;
            let retryCount = 0;
            const maxRetries = 3;
            let systemPrompt = '';

            while (retryCount <= maxRetries) {
                try {
                    const currentModel = llmService.getCurrentModel() || '';
                    this._compressToolResultsInHistory(history);
                    let compactedHistory = await conversationMemory.compactHistory(history, currentModel, toolExecutor.getFileCache());

                    // ── Apply caller's behavior overrides ──────────────────
                    // If the task was started via REST API with a `behavior` field
                    // (e.g. JHEditor passing a custom persona), honor it. Order:
                    //   1. behavior.system_prompt → fully replaces ContextBuilder output
                    //   2. behavior.extra_instructions → appended to whatever we end up with
                    //   3. behavior.enabled_tools → handled in _generateWithHistory / tool exec
                    //   4. behavior.max_iterations → applied once, before loop (see below)
                    if (this.behaviorOverrides && typeof this.behaviorOverrides.system_prompt === 'string'
                        && this.behaviorOverrides.system_prompt.trim().length > 0) {
                        systemPrompt = this.behaviorOverrides.system_prompt;
                    } else {
                        systemPrompt = await contextBuilder.getSystemPrompt(workspacePath, clientContext, null, kisContext, prompt);
                    }
                    if (this.behaviorOverrides && this.behaviorOverrides.extra_instructions) {
                        systemPrompt += '\n\n' + this.behaviorOverrides.extra_instructions;
                    }

                    // ── Context-budget-based dynamic history trim ──────────
                    // If systemPrompt + history is pushing against the model limit
                    // (>90%), aggressively drop middle messages to prevent API errors.
                    // We keep the original goal message and the most recent exchanges.
                    try {
                        const modelLimit = llmService.getEffectiveModelLimit();
                        const sysTokens = tokenEstimator.estimateTokens(systemPrompt);
                        const histTokens = tokenEstimator.estimateConversation(compactedHistory, '').totalTokens;
                        const totalEst = sysTokens + histTokens;
                        const hardLimit = Math.floor(modelLimit * 0.90);
                        if (totalEst > hardLimit && compactedHistory.length > 4) {
                            // Keep first message (original goal) + last 3 messages
                            const trimmed = [
                                compactedHistory[0],
                                { role: 'user', content: '[System: Middle history trimmed to stay within context budget. The original goal above remains your primary objective.]' },
                                { role: 'assistant', content: 'Understood — context trimmed, continuing from original goal.' },
                                ...compactedHistory.slice(-3)
                            ];
                            compactedHistory = trimmed;
                            onAgentStatus?.({ event: 'status', status: 'running', message: `⚠️ Context near limit (${Math.round(totalEst / 1000)}k/${Math.round(modelLimit / 1000)}k tokens) — trimmed history to prevent API error.` });
                        }
                    } catch (_) { /* token estimation is non-critical */ }

                    // Phase 4: Use _generateWithHistory which tries native tools first
                    genResult = await this._generateWithHistory(compactedHistory, systemPrompt, abortSignal, kisContext, images, onUpdate);
                    
                    if (compactedHistory.length < history.length) {
                        history = compactedHistory;
                    }
                    
                    const genContent = String(genResult?.content || '');
                    if (genContent.trim().length === 0 && retryCount < maxRetries) {
                        retryCount++;
                        onAgentStatus?.({ event: 'status', status: 'running', message: `Empty response received, retrying (${retryCount}/${maxRetries})...` });
                        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                        continue;
                    }
                    break;
                } catch (err) {
                    const isTransient = err.message?.includes('high demand') ||
                        err.message?.includes('429') ||
                        err.message?.includes('503') ||
                        err.message?.includes('overloaded');

                    if (isTransient && retryCount < maxRetries) {
                        retryCount++;
                        const delay = Math.pow(2, retryCount) * 1000;
                        onAgentStatus?.({ event: 'status', status: 'running', message: `Model busy, retrying in ${delay / 1000}s... (attempt ${retryCount}/${maxRetries})` });
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    console.error("Agent generate error:", err);
                    const duration = Date.now() - startTime;
                    if (onLog) {
                        let url = undefined;
                        let headers = undefined;
                        try {
                            const currentModel = llmService.getCurrentModel() || '';
                            const [providerName] = currentModel.split(':');
                            const config = await invoke('get_ai_config');
                            if (providerName === 'openai') {
                                url = 'https://api.openai.com/v1/chat/completions';
                            } else if (providerName === 'anthropic') {
                                url = 'https://api.anthropic.com/v1/messages';
                            } else if (providerName === 'gemini') {
                                url = 'https://generativelanguage.googleapis.com/v1beta/models/...';
                            } else if (providerName === 'ollama') {
                                url = 'http://localhost:11434/api/chat';
                            } else if (providerName === 'azure') {
                                url = `${config.azure_endpoint}/openai/deployments/...`;
                            }
                        } catch (e) {}

                        onLog({
                            method: 'CHAT',
                            status: 500,
                            duration: duration,
                            stepLabel: `Step ${iteration}`,
                            url: url,
                            headers: headers,
                            request: { url, headers, system_prompt: systemPrompt, history: history },
                            error: err.message || err,
                            response: null
                        });
                    }

                    if (abortSignal?.aborted || err.name === 'AbortError' || err.message?.includes('aborted')) {
                        onAgentStatus?.({ event: 'status', status: 'aborted', message: 'Process aborted by user.' });
                    } else {
                        onAgentStatus?.({ event: 'error', error: `Error in AI generation: ${err.message || err}` });
                        finalResponse = (finalResponse || '') + `\n\n[Error: ${err.message || err}]`;
                    }
                    break;
                }
            }

            if (!genResult) {
                // Graceful recovery: if this was a transient failure, give agent a chance
                // to self-correct with error context instead of breaking immediately
                if (consecutiveErrorCount < 3) {
                    consecutiveErrorCount++;
                    history.push({
                        role: 'user',
                        content: `[System] The previous AI generation call failed. Please try a different approach or simplify your response.`
                    });
                    onAgentStatus?.({ event: 'status', status: 'running', message: `Generation failed, attempting recovery (${consecutiveErrorCount}/3)...` });
                    continue;
                }
                break;
            }

            const duration = Date.now() - startTime;
            const content = String(genResult.content || '');

            // Accumulate token usage for the per-run budget check (enforced at
            // the top of the next iteration). We add prompt + completion of THIS
            // call; the budget warning fires at 80% and the hard stop at 100%.
            cumulativeTokens +=
                (genResult.usage?.prompt_tokens || 0) +
                (genResult.usage?.completion_tokens || 0);

            onAgentStatus?.({
                event: 'token_usage',
                prompt_tokens: genResult.usage?.prompt_tokens || 0,
                completion_tokens: genResult.usage?.completion_tokens || 0,
                total_tokens: genResult.usage?.total_tokens || 0
            });

            if (onLog) {
                let url = undefined;
                let headers = undefined;
                try {
                    const currentModel = llmService.getCurrentModel() || '';
                    const [providerName] = currentModel.split(':');
                    const config = await invoke('get_ai_config');
                    if (providerName === 'openai') {
                        url = 'https://api.openai.com/v1/chat/completions';
                    } else if (providerName === 'anthropic') {
                        url = 'https://api.anthropic.com/v1/messages';
                    } else if (providerName === 'gemini') {
                        url = 'https://generativelanguage.googleapis.com/v1beta/models/...';
                    } else if (providerName === 'ollama') {
                        url = 'http://localhost:11434/api/chat';
                    } else if (providerName === 'azure') {
                        url = `${config.azure_endpoint}/openai/deployments/...`;
                    }
                } catch (e) {}

                onLog({
                    method: 'CHAT',
                    status: 200,
                    duration: duration,
                    stepLabel: `Step ${iteration}`,
                    usage: genResult.usage,
                    url: url,
                    headers: headers,
                    request: {
                        url: url,
                        headers: headers,
                        system_prompt: systemPrompt,
                        history: history
                    },
                    response: content
                });
            }

            const response = content;
            const toolCall = this._extractToolCall(response);

            if (toolCall && toolCall.thought) {
                const thoughtText = typeof toolCall.thought === 'string' 
                    ? toolCall.thought 
                    : (toolCall.thought.current_task || JSON.stringify(toolCall.thought));

                // Phase 4: Dynamic phase detection based on thought content
                if (thoughtText.toLowerCase().includes('エラー') || thoughtText.toLowerCase().includes('error')) {
                    workflowManager.setPhase(WorkflowPhases.DEBUGGING);
                }
                
                // Emit a status update with abbreviated label, then the full thought once.
                // (Using 'status' for the label avoids creating a duplicate step in ChatView.)
                const phaseName = workflowManager.getStageInfo().name;
                const taskName = typeof toolCall.thought === 'string'
                    ? (toolCall.thought.substring(0, 60) + (toolCall.thought.length > 60 ? '...' : ''))
                    : (toolCall.thought.current_task || 'Thinking...');

                onAgentStatus?.({ event: 'status', status: 'running', message: `[${phaseName}] ${taskName} (step ${iteration})` });
                onAgentStatus?.({ event: 'thought', text: thoughtText });
            }

            if (toolCall && toolCall.tool_calls && toolCall.tool_calls.length > 0) {
                jsonParseRetryCount = 0;

                const currentSignature = JSON.stringify(toolCall.tool_calls);
                const currentToolCalls = toolCall.tool_calls.map(tc => ({
                    name: tc.name,
                    argsStr: JSON.stringify(tc.args || {})
                }));
                toolCallHistory.push(...currentToolCalls);
                toolCall.tool_calls.forEach(tc => usedToolTypes.add(tc.name));

                // Phase 4: legacy "expand maxIterations when many tools used" hack —
                // only meaningful when there is a hard step cap. In unlimited mode
                // (this.maxIterations === 0) we skip it entirely.
                if (this.maxIterations > 0 && usedToolTypes.size >= 5 && this.maxIterations < 20) {
                    this.maxIterations = 20;
                }

                if (currentSignature === lastToolCallSignature) {
                    repeatCount++;
                    // Two-stage escalation:
                    //   stage 1 (warn): at `identicalCallThreshold` (default 5) → inject a system
                    //                   message, reset the counter, let the LLM try again
                    //   stage 2 (stop): at 3× the threshold (default 15) → genuine hard stop
                    // The previous behavior was a hard stop at literally 3 identical calls in a
                    // row, which was too aggressive — many legitimate retry/poll patterns hit it
                    // and the user had no way to override. Both thresholds are now configurable
                    // (Settings → General → Identical Call Threshold), and 0 disables both.
                    const warnAt = safety.identicalCallThreshold;
                    const stopAt = warnAt > 0 ? warnAt * 3 : 0;

                    if (warnAt > 0 && repeatCount >= warnAt && !identicalWarned) {
                        identicalWarned = true;
                        onAgentStatus?.({
                            event: 'status',
                            status: 'running',
                            message: `Same call repeated ×${repeatCount} — injecting hint.`
                        });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: `[System Warning] You have invoked "${toolCall.tool_calls[0]?.name || 'a tool'}" with identical arguments ${repeatCount} times in a row. This rarely makes sense — please try a different approach, or call \`finish_task\` if the goal is already complete.`
                        });
                        repeatCount = 0;
                        toolCallHistory = [];
                        continue;
                    }

                    if (stopAt > 0 && repeatCount >= stopAt) {
                        onAgentStatus?.({ event: 'error', error: `Loop detected (${repeatCount}× identical calls, warning ignored). Stopping.` });
                        finalResponse = (finalResponse || '') +
                            `\n\n(注意: 同一ツール呼び出しを ${repeatCount} 回繰り返し、警告も無視されたため自動停止しました。Settings → General → Identical Call Threshold で調整できます。)`;
                        break;
                    }
                } else {
                    lastToolCallSignature = currentSignature;
                    repeatCount = 0;
                    identicalWarned = false; // reset so next streak can re-warn
                }

                // Phase 4: Pattern loop detection (5x identical tool+args)
                if (toolCallHistory.length >= 5) {
                    const lastFive = toolCallHistory.slice(-5);
                    const isIdenticalCall = lastFive.every(c =>
                        c.name === lastFive[0].name && c.argsStr === lastFive[0].argsStr
                    );
                    if (isIdenticalCall) {
                        onAgentStatus?.({ event: 'status', status: 'running', message: "Pattern loop detected (identical tool call 5x). Injecting guidance." });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: `[System Warning] You have invoked the tool "${lastFive[0].name}" with identical arguments 5 times in a row. To prevent infinite loops, consider a different approach or report the status to the user.`
                        });
                        toolCallHistory = [];
                        continue;
                    }
                }

                // ── Oscillation cycle detection (ABAB / ABCABC patterns) ──
                // Catches the case where the agent isn't repeating one call exactly
                // but is bouncing between 2–3 calls in a fixed cycle. Threshold
                // (number of full repeats before warning) is configurable via
                // Settings → General → Cycle Detection Min Repeats. 0 disables it.
                // `cycleWarned` guards against re-firing on every iteration in case
                // the LLM ignores the warning and keeps cycling — second escalation
                // happens via identical-call counter or no-progress detector instead.
                if (!cycleWarned && safety.cycleDetectionMinRepeats > 0) {
                    const cycle = this._detectCycle(toolCallHistory, safety.cycleDetectionMinRepeats);
                    if (cycle) {
                        cycleWarned = true;
                        onAgentStatus?.({
                            event: 'status',
                            status: 'running',
                            message: `Cycle detected (${cycle.pattern} ×${cycle.repeats}). Injecting guidance.`
                        });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: `[System Warning] You're oscillating between the same actions (${cycle.pattern}) — repeated ${cycle.repeats} times with no progress. Pick a fundamentally different approach, call \`finish_task\` if the goal is already achieved, or ask the user for guidance. Do NOT repeat the same cycle.`
                        });
                        toolCallHistory = [];
                        continue;
                    }
                }

                // Phase 4: Permission-based tool classification + parallel execution
                const safeCalls = [];
                const dangerousCalls = [];
                const deniedCalls = [];
                const results = [];
                let hasErrors = false;

                for (const tc of toolCall.tool_calls) {
                    const level = toolExecutor.getPermissionLevel 
                        ? toolExecutor.getPermissionLevel(tc.name, tc.args) 
                        : "Allow";
                    if (level === "Allow") safeCalls.push(tc);
                    else if (level === "Deny") deniedCalls.push(tc);
                    else dangerousCalls.push(tc); // "Ask"
                }

                // Handle Denied Calls immediately
                for (const call of deniedCalls) {
                    const errorMsg = `Error: Execution blocked by user permission settings (Deny).`;
                    results.push({ tool_call_name: call.name, result: errorMsg });
                    hasErrors = true;
                    onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args, status: 'denied' });
                }

                // Execute safe calls in parallel
                if (safeCalls.length > 0) {
                    const safeResults = await Promise.all(safeCalls.map(async (call) => {
                        onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args });
                        const toolStartTime = Date.now();
                        const result = await toolExecutor.executeTool(call, (statusMsg) => {
                            onAgentStatus?.({ event: 'status', status: 'running', message: statusMsg });
                        }, onConfirm);
                        const toolDuration = Date.now() - toolStartTime;
                        return { call, result, duration: toolDuration };
                    }));

                    for (const { call, result, duration } of safeResults) {
                        const isError = typeof result === 'string' && result.startsWith('Error');
                        if (isError) hasErrors = true;
                        if (onLog) this._logToolTelemetry(onLog, iteration, call, result, duration, isError);
                        results.push({ tool_call_name: call.name, result });
                    }
                }

                // Execute dangerous calls sequentially (with user confirmation)
                for (const call of dangerousCalls) {
                    onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args });
                    const toolStartTime = Date.now();
                    const result = await toolExecutor.executeTool(call, (statusMsg) => {
                        onAgentStatus?.({ event: 'status', status: 'running', message: statusMsg });
                    }, onConfirm);
                    const toolDuration = Date.now() - toolStartTime;
                    const isError = typeof result === 'string' && result.startsWith('Error');
                    
                    if (onLog) this._logToolTelemetry(onLog, iteration, call, result, toolDuration, isError);
                    results.push({ tool_call_name: call.name, result });

                    if (isError) {
                        hasErrors = true;
                        onAgentStatus?.({ event: 'status', status: 'running', message: `❌ ${call.name} failed: ${result}` });
                    } else {
                        let summary = result;
                        if (typeof result === 'string' && result.length > 300) {
                            summary = result.substring(0, 300) + '...';
                        }
                        onAgentStatus?.({ event: 'status', status: 'running', message: `✅ ${call.name} finished: ${summary}` });
                    }
                }

                if (hasErrors) {
                    consecutiveErrorCount++;
                    workflowManager.setPhase(WorkflowPhases.DEBUGGING);
                } else {
                    consecutiveErrorCount = 0;
                }

                // Phase 4: Detailed recovery hints based on error type (from JHEditor)
                let recoveryHint = '';
                if (hasErrors) {
                    const errorResults = results.filter(r => typeof r.result === 'string' && r.result.startsWith('Error'));
                    for (const er of errorResults) {
                        const errMsg = er.result.toLowerCase();
                        if (errMsg.includes('user denied') || errMsg.includes('rejected') || errMsg.includes('blocked')) {
                            recoveryHint += `\n[Important] The user denied command/tool execution. DO NOT attempt the identical operation again. Pivot to an alternative approach or report to the user.`;
                        } else if (errMsg.includes('not found') || errMsg.includes('no such file')) {
                            recoveryHint += `\n[Self-Correction Hint] File not found. Verify paths using list_files or grep_search.`;
                        } else if (errMsg.includes('invalid line range') || errMsg.includes('does not match')) {
                            recoveryHint += `\n[Self-Correction Hint] Line range does not match. Re-read the file using read_file to check current contents.`;
                        } else {
                            recoveryHint += `\n[Self-Correction Hint] Run verification checks after edits. If errors occur, update your plan and retry. Please bundle verifications after major changes rather than running tests after every single line edit.\n`;
                        }
                    }
                }

                if (consecutiveErrorCount >= 3) {
                    recoveryHint += `\n[Critical Warning] Encountered ${consecutiveErrorCount} consecutive errors. Re-evaluate your approach or report status to the user.`;
                    workflowManager.setPhase(WorkflowPhases.PLANNING);
                }

                // ── Post-edit verify_syntax reminder ─────────────────────────
                // If the agent just edited a .js/.ts/.json file, gently remind it
                // to run verify_syntax. This is the system-prompt rule made operative
                // at the most relevant moment (immediately after the edit returns).
                const editedFileExts = toolCall.tool_calls
                    .filter(tc => tc.name === 'write_file' || tc.name === 'multi_replace_file_content')
                    .map(tc => {
                        const p = String(tc.args?.path || '').toLowerCase();
                        const m = p.match(/\.([a-z0-9]+)$/);
                        return m ? m[1] : '';
                    })
                    .filter(Boolean);
                const verifiableEdit = editedFileExts.some(ext =>
                    ['js', 'jsx', 'ts', 'tsx', 'json', 'mjs', 'cjs'].includes(ext)
                );
                if (verifiableEdit && !hasErrors) {
                    recoveryHint += `\n[Verify Reminder] You just edited a .js/.ts/.json file. Call verify_syntax on it next to confirm the edit didn't introduce syntax errors. Do NOT call finish_task before verifying.`;
                }

                // ── No-progress detector ──────────────────────────────────────
                // Record whether THIS iteration produced any "real" progress
                // (a mutating tool call), then check if the recent window is all
                // exploration. If so, nudge the LLM to either wrap up or escalate
                // to the user. This is the main replacement for the old fixed
                // milestone reminders — it only fires when the agent is actually
                // spinning without producing artifacts, not just because N steps
                // have elapsed.
                const iterTools = toolCall.tool_calls.map(tc => tc.name);
                const iterHadProgress = iterTools.some(n => MUTATING_TOOLS.has(n));
                progressHistory.push(iterHadProgress);

                // When real progress resumes, reset detection booleans so the
                // agent gets a fresh cycle/no-progress window rather than being
                // permanently flagged from a single brief plateau.
                if (iterHadProgress) {
                    cycleWarned = false;
                    noProgressWarned = false;
                }

                if (safety.noProgressWindow > 0 &&
                    progressHistory.length >= safety.noProgressWindow &&
                    !noProgressWarned) {
                    const recent = progressHistory.slice(-safety.noProgressWindow);
                    const anyProgress = recent.some(p => p);
                    if (!anyProgress) {
                        noProgressWarned = true;
                        onAgentStatus?.({
                            event: 'status',
                            status: 'running',
                            message: `No file changes in ${safety.noProgressWindow} steps — checking in with the agent.`
                        });
                        history.push({
                            role: 'user',
                            content: `[System Check] You've executed ${safety.noProgressWindow} consecutive steps without modifying any files (read_file / grep_search / list_files only). Two options:\n1. If the user's goal is fully achieved — call \`finish_task\` now with a summary.\n2. If you are still working — call your next tool immediately (do NOT reply with text only).`
                        });
                    }
                }

                // If finish_task was just executed, break immediately with its summary.
                // This avoids an extra LLM round-trip just to confirm termination.
                if (toolExecutor.isTaskCompleted && toolExecutor.isTaskCompleted()) {
                    const ftResult = results.find(r => r.tool_call_name === 'finish_task');
                    finalResponse = ftResult?.result || response;
                    onAgentStatus?.({ event: 'status', status: 'completed', message: 'Task finished. ✅' });
                    break;
                }

                // Reset text-only counter: we just made at least one tool call.
                textOnlyCount = 0;

                history.push({ role: 'assistant', content: response });
                history.push({
                    role: 'user',
                    content: `Tool Execution Results:\n${JSON.stringify(results, null, 2)}${recoveryHint}\n\nBefore your next action, explicitly reflect on the results above:\nOBSERVE: What do these results tell you? (What was found, confirmed, or is still missing?)\nPLAN: What will you do next based on what you just observed, and why?\nThen make your next tool call — or call finish_task if the user's goal is fully achieved.`
                });
            } else {
                const looksLikeToolAttempt = response.includes('tool_calls') || (response.includes('"name"') && response.includes('"args"'));
                if (looksLikeToolAttempt && jsonParseRetryCount < 3) {
                    jsonParseRetryCount++;

                    // Try to auto-repair with jsonrepair before giving up
                    let autoRepaired = null;
                    try {
                        const repaired = jsonrepair(response.trim());
                        const parsed = JSON.parse(repaired);
                        if (parsed && (parsed.tool_calls || parsed.thought)) {
                            autoRepaired = parsed;
                        }
                    } catch (_) {}

                    if (autoRepaired) {
                        // jsonrepair succeeded — inject repaired content and retry parse
                        onAgentStatus?.({ event: 'status', status: 'running', message: `⚠️ Auto-repaired malformed JSON (attempt ${jsonParseRetryCount}/3)` });
                        const syntheticResult = this._extractToolCall(JSON.stringify(autoRepaired));
                        if (syntheticResult && syntheticResult.tool_calls && syntheticResult.tool_calls.length > 0) {
                            // Use the repaired tool calls — re-enter the tool execution block
                            const currentSignature = JSON.stringify(syntheticResult.tool_calls);
                            if (syntheticResult.thought) {
                                onAgentStatus?.({ event: 'thought', text: typeof syntheticResult.thought === 'string' ? syntheticResult.thought : JSON.stringify(syntheticResult.thought) });
                            }
                            // Rebuild genResult with repaired content and fall through
                            genResult = { content: JSON.stringify(autoRepaired), usage: genResult?.usage };
                            iteration--; // Don't count this as a new step
                            continue;
                        }
                    }

                    // Extract the specific parse error for better LLM guidance
                    let parseErrorDetail = '';
                    let snippetForLlm = response.substring(0, 600);
                    try {
                        const jsonStart = response.indexOf('{');
                        const jsonEnd = response.lastIndexOf('}');
                        if (jsonStart !== -1 && jsonEnd !== -1) {
                            const extracted = response.substring(jsonStart, jsonEnd + 1);
                            try { JSON.parse(extracted); } catch (e) { parseErrorDetail = e.message; }
                        }
                    } catch (_) {}

                    const errorMsg = `[System Error] Failed to parse tool calling JSON (attempt ${jsonParseRetryCount}/3).
${parseErrorDetail ? `Parse error: "${parseErrorDetail}"\n` : ''}
Your response (first 600 chars):
\`\`\`
${snippetForLlm}
\`\`\`

Common causes:
- Trailing commas before } or ]
- Unescaped backslashes or quotes in string values
- Missing closing brackets/braces
- Single quotes instead of double quotes

Please output ONLY valid JSON matching the required tool call format. Do not add any explanation text outside the JSON.`;

                    onAgentStatus?.({ event: 'status', status: 'running', message: `⚠️ JSON parse failed, retrying (${jsonParseRetryCount}/3)...` });
                    history.push({ role: 'assistant', content: response });
                    history.push({ role: 'user', content: errorMsg });
                    continue;
                }

                if (toolExecutor.isTaskCompleted && toolExecutor.isTaskCompleted()) {
                    // finish_task was called in a previous iteration — model is now wrapping up
                    // with a final summary text. This is the expected exit path.
                    onAgentStatus?.({ event: 'status', status: 'completed', message: 'Task finished. ✅' });
                    finalResponse = this._cleanFinalResponse(response);
                    break;
                }

                // Model replied with text only but did NOT call finish_task.
                // Per system prompt: "text only = progress report, not completion."
                // Push back and ask the model to continue rather than exiting silently.
                textOnlyCount++;
                if (textOnlyCount >= 3) {
                    // Three consecutive text-only responses — model appears stuck.
                    // Accept this as the final response to avoid an infinite loop.
                    onAgentStatus?.({ event: 'status', status: 'waiting', message: 'Agent stopped (no tool call after 3 attempts).' });
                    finalResponse = this._cleanFinalResponse(response);
                    break;
                }

                // Log the text as a thought/status so the user can see the reasoning.
                const progressText = this._cleanFinalResponse(response);
                if (progressText) {
                    onAgentStatus?.({ event: 'thought', text: progressText });
                }

                history.push({ role: 'assistant', content: response });
                history.push({
                    role: 'user',
                    content: `[System] You responded with text but no tool call. Remember: text-only replies are progress reports, not completion. If the task is fully done, call finish_task explicitly with a summary. If you still have work to do, invoke your next tool now.`
                });
                continue;
            }
        }

        if (!isUnlimited && iteration >= this.maxIterations) {
            finalResponse = (finalResponse || '') + "\n\n(注意: 最大ステップ数に達したため、処理を中断しました。)";
        }

        toolExecutor.endSession();

        return {
            response: finalResponse,
            modifiedFiles: toolExecutor.getModifiedFiles()
        };
    }

    // ─── Phase 4: _generateWithHistory — tries native tool calling first, falls back to JSON mode ───

    async _generateWithHistory(history, systemPrompt, abortSignal, kisContext = '', images = [], onUpdate = null) {
        // Use the single source-of-truth from LLMService.
        // ContextBuilder has already built systemPrompt using the same flag, so the
        // protocol section in the prompt always matches the API call we make here.
        const useNativeTools = llmService.supportsNativeTools() && typeof llmService.chatWithTools === 'function';

        let nativeFailed = false;
        if (useNativeTools) {
            let retryCount = 0;
            const maxNativeRetries = 2;
            let currentHistory = [...history];

            // systemPrompt already contains the native-mode OBSERVE/PLAN protocol
            // (built by ContextBuilder).  Do NOT append more instructions here —
            // that would duplicate the protocol and confuse the model.

            while (retryCount <= maxNativeRetries) {
                try {
                    const tools = toolExecutor.getToolsForNativeAPI ? toolExecutor.getToolsForNativeAPI() : [];
                    if (tools.length === 0) break; // No tools registered, skip native

                    const result = await llmService.chatWithTools(currentHistory, systemPrompt, tools, abortSignal, images);

                    // Fallback to JSON mode when native tool calling doesn't work:
                    // Case 1: both content and toolCalls are empty → model gave nothing useful
                    // Case 2: content has text but toolCalls is empty AND the text contains
                    //         "CALL:" or a known tool-name pattern → model tried to invoke a
                    //         tool via text instead of the function-call API (e.g. DeepSeek).
                    //         In this case we must NOT return the text as a final response.
                    const hasNoToolCalls = !result?.toolCalls || result.toolCalls.length === 0;
                    if (hasNoToolCalls) {
                        const txt = (result?.content || '').trim();
                        const looksLikeToolTextCall = /\bCALL:\s*\w/i.test(txt) ||
                            toolExecutor.toolDefinitions?.some(td => new RegExp(`\\b${td.name}\\b`).test(txt) && /PLAN:/i.test(txt));
                        if (!txt || looksLikeToolTextCall) {
                            nativeFailed = true;
                            break;
                        }
                        // Plain text with no tool-invocation attempt → accept as final response text
                    }

                    if (result && result.toolCalls && result.toolCalls.length > 0) {
                        // Format tool calls, throwing syntax error if argument parse fails even after repair
                        const toolCallsFormatted = result.toolCalls.map(tc => {
                            let args = tc.function.arguments;
                            if (typeof args === 'string') {
                                try {
                                    args = this._safeParseJSON(args);
                                } catch (parseErr) {
                                    throw new SyntaxError(`JSON parsing failed for tool '${tc.function.name}': ${parseErr.message}`);
                                }
                            }
                            return {
                                name: tc.function.name,
                                args: args
                            };
                        });
                        
                        // Strip <thought>…</thought> XML wrapper that the model may output
                        // (per protocol instruction), keeping only the inner OBSERVE/PLAN/CALL text.
                        const rawThought = (result.content || '').trim();
                        const thoughtInner = rawThought
                            ? rawThought.replace(/^[\s\S]*?<thought>([\s\S]*?)<\/thought>[\s\S]*$/, '$1').trim()
                            : '';
                        const thought = thoughtInner || rawThought;

                        const content = JSON.stringify({
                            thought,
                            tool_calls: toolCallsFormatted
                        });

                        return { content, usage: result.usage };
                    }
                    
                    return { content: result.content || '', usage: result.usage };
                } catch (e) {
                    // If it's a JSON parsing error, and we have retries left, let the model try to correct its JSON
                    if (e instanceof SyntaxError && retryCount < maxNativeRetries) {
                        retryCount++;
                        
                        currentHistory.push({
                            role: 'assistant',
                            content: `An error occurred during tool call generation.`
                        });
                        currentHistory.push({
                            role: 'user',
                            content: `[Automatic Error Correction Request] Failed to parse tool call arguments JSON. Error: "${e.message}"\nPlease correct the JSON formatting (especially matching quotes/braces) and retry the tool call.`
                        });
                        continue;
                    }
                    console.warn('Native tool use failed, falling back to JSON mode:', e);
                    nativeFailed = true;
                    break;
                }
            }
        }

        // ── JSON-mode fallback ────────────────────────────────────────────
        // We reach here either because the model has no native tool support, OR
        // because native calling failed at runtime (nativeFailed). In the latter
        // case the systemPrompt was built for NATIVE mode (it tells the model to
        // use the function-call API and has NO JSON-envelope instructions), but
        // the agent loop parses the response expecting a {thought, tool_calls}
        // JSON envelope. Without re-instructing the model the fallback silently
        // produces unparseable output. So when native failed, append the JSON
        // protocol with an explicit override note.
        let fallbackSystemPrompt = systemPrompt;
        if (nativeFailed) {
            fallbackSystemPrompt = systemPrompt +
                `\n\n<protocol_override>\n` +
                `The function-calling API is unavailable for this turn. IGNORE any earlier instruction ` +
                `to invoke tools via the function-call mechanism. Instead, you MUST respond using the ` +
                `JSON envelope format described below.\n` +
                ContextBuilder.getJsonModeProtocol() +
                `</protocol_override>\n`;
        }
        return await llmService.chat(history, fallbackSystemPrompt, onUpdate, abortSignal, images);
    }

    // ─── Telemetry ───

    _logToolTelemetry(onLog, iteration, call, result, toolDuration, isError) {
        try {
            let logResponse = result;
            if (typeof result === 'string' && result.length > 20000) {
                logResponse = result.substring(0, 20000) + "... [Truncated]";
            } else if (result && typeof result === 'object' && !result.error) {
                try {
                    const str = JSON.stringify(result);
                    if (str.length > 20000) logResponse = str.substring(0, 20000) + "... [Truncated]";
                } catch (e) { logResponse = "[Object Truncated]"; }
            }

            onLog({
                method: 'TOOL',
                name: call.name,
                status: isError ? 500 : 200,
                duration: toolDuration,
                stepLabel: `Step ${iteration} (Tool)`,
                usage: { prompt_tokens: 0, completion_tokens: 0, request_size: JSON.stringify(call.args || {}).length, response_size: (typeof result === 'string' ? result.length : (result ? JSON.stringify(result).length : 0)) },
                request: call.args,
                response: logResponse
            });
        } catch (e) { }
    }

    // ─── Phase 3: History Compression (JHEditor detailed version) ───

    _compressToolResultsInHistory(history) {
        // ── Compression policy (revised) ─────────────────────────────────
        //   • Keep the 3 most-recent tool result groups VERBATIM. This is the
        //     window inside which self-correction usually happens, and the
        //     full content (especially error diagnostics like "Closest matching
        //     region" diffs) is what enables the LLM to recover.
        //   • For older groups, summarize success results (name + "Completed")
        //     but keep error results with up to 2 KB of detail — errors are the
        //     only past content that consistently helps the LLM avoid repeating
        //     the same mistake.
        //   • Also scrub the *assistant* message immediately before any
        //     summarized error result: it contains the failed tool-call args
        //     (often a huge multiline old_text full of typos) which add noise
        //     and tempt the LLM to copy the bad version.
        const KEEP_RECENT_RESULTS = 3;
        const ERROR_KEEP_CHARS    = 2000;

        // Pass 1: find indices of tool-result messages and classify each as error/success.
        const toolResultIndices = [];
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === 'user' && typeof m.content === 'string' &&
                m.content.startsWith('Tool Execution Results:')) {
                toolResultIndices.push(i);
            }
        }
        // toolResultIndices is newest-first; the first KEEP_RECENT_RESULTS are exempt.
        const toCompress = toolResultIndices.slice(KEEP_RECENT_RESULTS);
        if (toCompress.length === 0) return;

        for (const i of toCompress) {
            const original = history[i].content;
            let summary = '[System: Past tool execution results have been summarized.]';
            let hadError = false;

            try {
                const jsonStartIndex = original.indexOf('Tool Execution Results:\n');
                if (jsonStartIndex !== -1) {
                    const rawJson = original.substring(jsonStartIndex + 'Tool Execution Results:\n'.length).trim();
                    const jsonEnd = rawJson.indexOf('\n[');
                    const jsonStr = jsonEnd !== -1 ? rawJson.substring(0, jsonEnd) : rawJson;
                    try {
                        const results = JSON.parse(jsonStr);
                        if (Array.isArray(results)) {
                            const toolSummaries = results.map(r => {
                                const name = r.tool_call_name || 'unknown';
                                const resStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result || '');
                                const isError = resStr.startsWith('Error');
                                if (isError) {
                                    hadError = true;
                                    // ── Bug 2 fix: preserve up to ERROR_KEEP_CHARS of error detail ──
                                    // so the LLM can still see the closest-region diff / fresh content
                                    // from auto-recovery, instead of just "Error: ...(truncated)".
                                    const errKept = resStr.length > ERROR_KEEP_CHARS
                                        ? resStr.substring(0, ERROR_KEEP_CHARS) + '… [truncated]'
                                        : resStr;
                                    return `${name} →\n${errKept}`;
                                }
                                return `${name} (Completed)`;
                            });
                            summary = `[System: Past tool results — older entries summarized]\n${toolSummaries.join('\n\n')}`;
                        }
                    } catch (_) { /* fall through to generic summary */ }
                }
            } catch (_) { /* fall through */ }

            history[i].content = summary;

            // ── Bug 5 fix: scrub the assistant message that came right before ──
            // If the previous turn was an assistant emitting tool_calls and the
            // result was an error, the args almost certainly contained the
            // typo-ridden old_text/new_text. Replace it with a thought-only stub
            // so the bad code doesn't pollute future context.
            if (hadError && i > 0 && history[i - 1].role === 'assistant') {
                const prev = history[i - 1];
                try {
                    const parsed = typeof prev.content === 'string'
                        ? JSON.parse(prev.content)
                        : prev.content;
                    if (parsed && (parsed.tool_calls || parsed.thought)) {
                        const names = Array.isArray(parsed.tool_calls)
                            ? parsed.tool_calls.map(tc => tc?.name || 'unknown').join(', ')
                            : 'unknown';
                        const thoughtKept = typeof parsed.thought === 'string'
                            ? (parsed.thought.length > 300 ? parsed.thought.slice(0, 300) + '…' : parsed.thought)
                            : '';
                        history[i - 1].content = JSON.stringify({
                            thought: thoughtKept,
                            tool_calls: `[scrubbed: prior call to ${names} failed — see next message for the error detail. Original args removed to keep context clean.]`
                        });
                    }
                } catch (_) { /* not JSON or unexpected shape — leave as-is */ }
            }
        }
    }

    // ─── Phase 4: Robust JSON parsing with jsonrepair and multi-fallback (from JHEditor) ───

    _safeParseJSON(str) {
        if (typeof str !== 'string') return str;
        let trimmed = str.trim();

        try {
            return JSON.parse(trimmed);
        } catch (e) {
            let repaired = trimmed;

            // Handle markdown code blocks
            if (repaired.startsWith('```')) {
                const lines = repaired.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines[lines.length - 1].startsWith('```')) lines.pop();
                repaired = lines.join('\n').trim();
            }

            try {
                // First try standard parse after stripping markdown
                return JSON.parse(repaired);
            } catch (e2) {}

            // ── Pre-repair: fix unescaped Windows backslashes ──
            // LLMs frequently emit `"path": "C:\Users\foo"` where `\U` and `\f`
            // are invalid JSON escapes. We rewrite single backslashes that
            // aren't followed by a valid escape character into doubled ones.
            // This is safe because no JSON string can contain a literal
            // single backslash anyway (it would already be a parse error).
            try {
                const winEscapeFixed = repaired.replace(
                    /\\(?!["\\/bfnrtu])/g,
                    '\\\\'
                );
                if (winEscapeFixed !== repaired) {
                    return JSON.parse(winEscapeFixed);
                }
            } catch (e2b) {}

            try {
                // Use jsonrepair to forcefully fix missing quotes, colons, etc.
                const highlyRepaired = jsonrepair(repaired);
                return JSON.parse(highlyRepaired);
            } catch (e3) {
                // Find outermost JSON structures as a last resort before repairing
                const start = repaired.indexOf('{');
                const end = repaired.lastIndexOf('}');
                if (start !== -1 && end !== -1 && end > start) {
                    const extracted = repaired.substring(start, end + 1);
                    try {
                        const highlyRepairedExtracted = jsonrepair(extracted);
                        return JSON.parse(highlyRepairedExtracted);
                    } catch (e4) {
                        // Final attempt: combine win-escape fix + jsonrepair
                        try {
                            const both = jsonrepair(
                                extracted.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
                            );
                            return JSON.parse(both);
                        } catch (_) {
                            throw e3;
                        }
                    }
                }
                throw e3;
            }
        }
    }

    // ─── Phase 4: Full _extractToolCall with XML tags + multi-JSON parsing (from JHEditor) ───

    _extractToolCall(text) {
        if (!text) return null;
        const results = { thought: null, tool_calls: [] };

        // 1. Try to extract from <thought> and <tool_calls> tags (XML-like format)
        const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/);
        if (thoughtMatch) {
            results.thought = thoughtMatch[1].trim();
        }

        const toolCallsMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
        if (toolCallsMatch) {
            const innerContent = toolCallsMatch[1];
            const toolCallRegex = /<tool_call\s+name="([^"]+)"\s+args=({[\s\S]*?}|"[^"]*")\s*\/>/g;
            let tcMatch;
            while ((tcMatch = toolCallRegex.exec(innerContent)) !== null) {
                try {
                    let argsStr = tcMatch[2].trim();
                    if (argsStr.startsWith('"') && argsStr.endsWith('"')) {
                        argsStr = argsStr.substring(1, argsStr.length - 1);
                    }
                    const args = this._safeParseJSON(argsStr);
                    results.tool_calls.push({ name: tcMatch[1], args });
                } catch (e) {
                    console.warn("Failed to parse args in <tool_call> tag:", tcMatch[2], e);
                }
            }
        }

        // If we already found tool calls via tags, we can stop here
        if (results.tool_calls.length > 0) return results;

        let foundValidJson = false;

        // 2. Try JSON code blocks
        const blockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
        let match;
        while ((match = blockRegex.exec(text)) !== null) {
            const rawContent = match[1].trim();
            try {
                const data = this._safeParseJSON(rawContent);
                foundValidJson = true;
                if (data.thought) {
                    if (!results.thought) results.thought = data.thought;
                    else if (typeof results.thought === 'object' && typeof data.thought === 'object') Object.assign(results.thought, data.thought);
                }
                if (data.tool_calls) {
                    if (Array.isArray(data.tool_calls)) {
                        results.tool_calls.push(...data.tool_calls);
                    } else if (typeof data.tool_calls === 'object' && data.tool_calls.name) {
                        results.tool_calls.push(data.tool_calls);
                    }
                }
            } catch (e) {
                // Try extracting tool calls from the malformed code block
                const fallbackCalls = this._extractAllPossibleToolCalls(rawContent);
                if (fallbackCalls.length > 0) {
                    results.tool_calls.push(...fallbackCalls);
                }
            }
        }

        // 3. Try raw JSON string
        if (results.tool_calls.length === 0) {
            const rawStr = text.trim();
            let parsedWhole = false;
            if (rawStr.startsWith('{') && rawStr.endsWith('}')) {
                try {
                    const data = this._safeParseJSON(rawStr);
                    if (data && (data.thought || data.tool_calls)) {
                        parsedWhole = true;
                        if (data.thought) {
                            results.thought = data.thought;
                        }
                        if (data.tool_calls) {
                            if (Array.isArray(data.tool_calls)) {
                                results.tool_calls.push(...data.tool_calls);
                            } else if (typeof data.tool_calls === 'object' && data.tool_calls.name) {
                                results.tool_calls.push(data.tool_calls);
                            }
                        }
                    }
                } catch (e) { }
            }

            if (!parsedWhole) {
                // Last resort: find outermost { ... }
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start !== -1 && end !== -1 && end > start) {
                    try {
                        const data = this._safeParseJSON(text.substring(start, end + 1));
                        if (data && (data.thought || data.tool_calls)) {
                            parsedWhole = true;
                            if (data.thought) {
                                results.thought = data.thought;
                            }
                            if (data.tool_calls) {
                                if (Array.isArray(data.tool_calls)) {
                                    results.tool_calls.push(...data.tool_calls);
                                } else if (typeof data.tool_calls === 'object' && data.tool_calls.name) {
                                    results.tool_calls.push(data.tool_calls);
                                }
                            }
                        }
                    } catch (e) { }
                }
            }

            // If we still don't have tool calls, run the brace-matching fallback extraction on the whole text!
            if (results.tool_calls.length === 0) {
                const fallbackCalls = this._extractAllPossibleToolCalls(text);
                if (fallbackCalls.length > 0) {
                    results.tool_calls.push(...fallbackCalls);
                }
            }
        }

        // Try extracting thought if still empty and JSON parsing failed
        if (!results.thought) {
            results.thought = this._extractThoughtFromMalformedText(text);
        }

        if (results.tool_calls.length > 0 || results.thought) return results;
        return null;
    }

    _extractAllPossibleToolCalls(text) {
        const toolCalls = [];
        let startPositions = [];
        let inString = false;
        let escape = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (escape) {
                escape = false;
                continue;
            }
            if (char === '\\') {
                escape = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;

            if (char === '{') {
                startPositions.push(i);
            } else if (char === '}') {
                const startIdx = startPositions.pop();
                if (startIdx !== undefined) {
                    const candidate = text.substring(startIdx, i + 1);
                    // Check if candidate looks like a tool call: {"name": ..., "args": ...}
                    if (candidate.includes('"name"') && candidate.includes('"args"')) {
                        try {
                            const parsed = this._safeParseJSON(candidate);
                            if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.args && !parsed.tool_calls) {
                                const isDuplicate = toolCalls.some(tc => tc.name === parsed.name && JSON.stringify(tc.args) === JSON.stringify(parsed.args));
                                if (!isDuplicate) {
                                    toolCalls.push(parsed);
                                }
                            }
                        } catch (e) {
                            try {
                                const repaired = jsonrepair(candidate);
                                const parsed = JSON.parse(repaired);
                                if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.args && !parsed.tool_calls) {
                                    const isDuplicate = toolCalls.some(tc => tc.name === parsed.name && JSON.stringify(tc.args) === JSON.stringify(parsed.args));
                                    if (!isDuplicate) {
                                        toolCalls.push(parsed);
                                    }
                                }
                            } catch (err) {}
                        }
                    }
                }
            }
        }
        return toolCalls;
    }

    _extractThoughtFromMalformedText(text) {
        // 1. Try to extract string thought: "thought": "..."
        const stringRegex = /"thought"\s*:\s*"([^"]+)"/i;
        const match = text.match(stringRegex);
        if (match) return match[1];

        // 2. Try to extract object thought: "thought": { ... }
        const objectStartIdx = text.search(/"thought"\s*:\s*\{/i);
        if (objectStartIdx !== -1) {
            const startBraceIdx = text.indexOf('{', objectStartIdx);
            if (startBraceIdx !== -1) {
                let braceCount = 0;
                let inString = false;
                let escape = false;
                for (let i = startBraceIdx; i < text.length; i++) {
                    const char = text[i];
                    if (escape) { escape = false; continue; }
                    if (char === '\\') { escape = true; continue; }
                    if (char === '"') { inString = !inString; continue; }
                    if (inString) continue;

                    if (char === '{') braceCount++;
                    else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            const objStr = text.substring(startBraceIdx, i + 1);
                            try {
                                return this._safeParseJSON(objStr);
                            } catch (e) {
                                try {
                                    return JSON.parse(jsonrepair(objStr));
                                } catch (err) {}
                            }
                            break;
                        }
                    }
                }
            }
        }
        return null;
    }

    /**
     * Read the persistent Agent Safety Limits from saved config and normalize them.
     *
     * Every field uses the same convention:
     *   null / undefined / '' / 0 / non-numeric  →  the limit is DISABLED (treated as ∞)
     *   any positive integer                     →  hard threshold
     *
     * Returns an object with sanitized numeric fields so the run loop can compare
     * directly without re-doing the null-checks every iteration.
     */
    async _loadSafetyLimits() {
        const defaults = {
            maxSteps: 0,
            tokenBudget: 0,
            wallClockMinutes: 0,
            noProgressWindow: 15,                // sensible default — most people want this on
            identicalCallThreshold: 5,           // soft warn at 5×, hard stop at 15×
            cycleDetectionMinRepeats: 3,         // soft warn after ABAB×3 or ABCABC×3
            historyBudgetRatio: 0.7,             // fraction of context window history may use
        };

        let cfg = {};
        try { cfg = await invoke('get_ai_config'); } catch (_) { /* keep defaults */ }

        const num = (v, fallback) => {
            if (v === null || v === undefined || v === '') return fallback;
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 0) return fallback;
            return n;
        };

        // Ratio is a float in (0, 1]; parsed separately from the integer fields.
        const ratioRaw = Number(cfg.history_budget_ratio);
        const historyBudgetRatio = (Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1)
            ? ratioRaw
            : defaults.historyBudgetRatio;

        return {
            maxSteps:                 num(cfg.max_steps,                   defaults.maxSteps),
            tokenBudget:              num(cfg.token_budget,                defaults.tokenBudget),
            wallClockMinutes:         num(cfg.wall_clock_minutes,          defaults.wallClockMinutes),
            noProgressWindow:         num(cfg.no_progress_window,          defaults.noProgressWindow),
            identicalCallThreshold:   num(cfg.identical_call_threshold,    defaults.identicalCallThreshold),
            cycleDetectionMinRepeats: num(cfg.cycle_detection_min_repeats, defaults.cycleDetectionMinRepeats),
            historyBudgetRatio,
        };
    }

    /**
     * Detect a repeating cycle of length 2 or 3 in the recent tool-call history.
     *
     * Catches the "ABAB…" / "ABCABC…" oscillation pattern, where the agent
     * isn't repeating *one* call enough to trigger the identical-call stop
     * but IS spinning between a small fixed set of calls without making progress.
     *
     * @param {Array}  history     The full toolCallHistory array.
     * @param {number} minRepeats  Required number of consecutive repeats for a
     *                             pattern to count as a cycle. 0 ⇒ detection disabled.
     *                             Tune higher to be more permissive (fewer false stops),
     *                             lower to catch loops sooner.
     *
     * Returns null if no cycle, or { pattern, length, repeats }.
     *
     * Length 2 needs `2 * minRepeats` matching tail calls (e.g. minRepeats=3 → last 6 = ABABAB).
     * Length 3 needs `3 * minRepeats` matching tail calls (e.g. minRepeats=3 → last 9 = ABCABCABC).
     */
    _detectCycle(history, minRepeats = 3) {
        if (!Array.isArray(history)) return null;
        if (!Number.isFinite(minRepeats) || minRepeats <= 0) return null; // disabled
        // 3-cycles need at least 2 repetitions to be meaningful (ABCABC < that
        // is just 3 distinct calls in a row).
        const min3 = Math.max(2, minRepeats);

        const sig = c => `${c.name}(${c.argsStr})`;

        // ── 2-cycle (ABAB…): need 2 * minRepeats consecutive matching calls ──
        const need2 = 2 * minRepeats;
        if (history.length >= need2) {
            const tail = history.slice(-need2).map(sig);
            const a = tail[0], b = tail[1];
            if (a !== b) {
                let ok = true;
                for (let i = 0; i < tail.length; i++) {
                    if (tail[i] !== (i % 2 === 0 ? a : b)) { ok = false; break; }
                }
                if (ok) {
                    const calls = history.slice(-need2);
                    return {
                        pattern: `${calls[0].name}→${calls[1].name}`,
                        length: 2,
                        repeats: minRepeats
                    };
                }
            }
        }

        // ── 3-cycle (ABCABC…): need 3 * min3 consecutive matching calls ──
        const need3 = 3 * min3;
        if (history.length >= need3) {
            const tail = history.slice(-need3).map(sig);
            const a = tail[0], b = tail[1], c = tail[2];
            if (new Set([a, b, c]).size === 3) {
                let ok = true;
                for (let i = 0; i < tail.length; i++) {
                    const expected = i % 3 === 0 ? a : i % 3 === 1 ? b : c;
                    if (tail[i] !== expected) { ok = false; break; }
                }
                if (ok) {
                    const calls = history.slice(-need3);
                    return {
                        pattern: `${calls[0].name}→${calls[1].name}→${calls[2].name}`,
                        length: 3,
                        repeats: min3
                    };
                }
            }
        }

        return null;
    }

    // ─── Phase 4: Full _cleanFinalResponse with thought extraction + multi-language (from JHEditor) ───

    _cleanFinalResponse(text) {
        if (!text) return '';
        try {
            let thoughtPart = '';
            let remainingText = text;

            // 1. Handle <thought> and <tool_calls> tags
            const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/);
            if (thoughtMatch) {
                thoughtPart = `> ${thoughtMatch[1].trim().replace(/\n/g, '\n> ')}`;
                remainingText = remainingText.replace(thoughtMatch[0], '').trim();
            }

            const toolCallsMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
            if (toolCallsMatch) {
                remainingText = remainingText.replace(toolCallsMatch[0], '').trim();
            }

            // 2. Handle JSON blocks (existing logic)
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            
            if (jsonMatch) {
                remainingText = remainingText.replace(jsonMatch[0], '').trim();
                try {
                    const parsed = this._safeParseJSON(jsonMatch[1].trim());
                    const thought = parsed.thought || parsed;
                    if (typeof thought === 'object') {
                        const subThought = Object.entries(thought)
                            .map(([k, v]) => `> **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                            .join('\n');
                        thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + subThought;
                    } else {
                        thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + `> ${thought}`;
                    }
                } catch (e) { }
            } else {
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start !== -1 && end !== -1 && end > start) {
                    const possibleJson = text.substring(start, end + 1);
                    try {
                        const parsed = this._safeParseJSON(possibleJson);
                        if (parsed.thought || parsed.tool_calls) {
                            remainingText = remainingText.replace(possibleJson, '').trim();
                            const thought = parsed.thought || parsed;
                            if (typeof thought === 'object') {
                                const subThought = Object.entries(thought)
                                    .map(([k, v]) => `> **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                                    .join('\n');
                                thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + subThought;
                            } else {
                                thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + `> ${thought}`;
                            }
                        }
                    } catch (e) { }
                }
            }

            const cleanedThought = thoughtPart.replace(/[>\s\.]/g, '').trim();
            const isThoughtPlaceholder = cleanedThought.length === 0 || cleanedThought.toLowerCase() === 'reasoning' || cleanedThought.toLowerCase() === 'analyzing';

            const cleanedRemainingText = remainingText.trim();
            const isRemainingPlaceholder = cleanedRemainingText.replace(/[\s\.]/g, '').trim().length === 0;

            if (cleanedRemainingText.length > 5 && !isRemainingPlaceholder) {
                return remainingText;
            }

            if (thoughtPart && !isThoughtPlaceholder) {
                return `### 🧠 Reasoning Process\n${thoughtPart}`;
            }

            // If everything is blank or placeholder, return a friendly message
            return 'すべてのタスクが正常に完了しました。';
        } catch (e) { }
        return String(text);
    }

    /**
     * Delete session directories older than 30 days to prevent disk bloat.
     * Session IDs are in the format `sess_<unix_ms>`, so age can be derived
     * directly from the directory name without any extra metadata read.
     * Non-critical — errors are swallowed by the caller.
     */
    async _cleanupOldSessions(workspacePath) {
        if (!workspacePath) return;
        const sessionsDir = `${workspacePath}/.agent/sessions`;
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - THIRTY_DAYS_MS;
        try {
            const entries = await invoke('read_dir', { path: sessionsDir });
            for (const entry of (entries || [])) {
                if (!entry.name || !entry.name.startsWith('sess_')) continue;
                const tsStr = entry.name.slice('sess_'.length);
                const ts = parseInt(tsStr, 10);
                if (!isNaN(ts) && ts < cutoff) {
                    try {
                        await invoke('delete_dir', { path: `${sessionsDir}/${entry.name}` });
                        console.log(`[Session Cleanup] Removed old session: ${entry.name}`);
                    } catch (_) { /* skip undeletable entries */ }
                }
            }
        } catch (_) { /* sessions dir may not exist yet — ignore */ }
    }

    /**
     * Heuristic check: does this prompt look like a multi-step task that requires
     * upfront subtask registration via task_progress?
     *
     * Returns true when ANY of these signals are detected:
     *   • Numbered list (e.g. "1.", "2." or "①②")
     *   • 3+ distinct file paths mentioned
     *   • Complexity verbs + prompt > 100 chars
     *   • Word count > 60
     */
    _looksComplex(prompt) {
        if (!prompt || typeof prompt !== 'string') return false;
        const p = prompt.trim();

        // Numbered list items → almost certainly multi-step
        if (/(?:^|\n)\s*[1-9]\d*[.)]/m.test(p)) return true;
        // Japanese-style numbered items
        if (/[①②③④⑤⑥⑦⑧⑨]/.test(p)) return true;

        // 3+ distinct source-file mentions (.js .ts .py .rs .go .java .vue .svelte …)
        const fileMentions = p.match(/\b\w[\w/-]*\.(?:js|ts|jsx|tsx|py|rs|go|java|vue|svelte|css|scss|html|json|md|rb|php|kt)\b/gi) || [];
        const uniqueFiles = new Set(fileMentions.map(f => f.toLowerCase()));
        if (uniqueFiles.size >= 3) return true;

        // Complexity verbs + non-trivial length
        if (p.length > 100 && /\b(implement|add|create|refactor|update|modify|change|fix|migrate|convert|integrate)\b/i.test(p)) return true;

        // Word count > 60 — probably a detailed instruction
        if (p.split(/\s+/).length > 60) return true;

        return false;
    }
}
