import llmService from './LLMService.js';
import { workflowManager, WorkflowPhases } from './WorkflowManager.js';
import { ToolExecutor } from './ToolExecutor.js';
import { contextBuilder, ContextBuilder } from './ContextBuilder.js';
import { conversationMemory } from './ConversationMemory.js';
import { jsonrepair } from 'jsonrepair';
import { invoke } from '@tauri-apps/api/core';
import {
    safeParseJSON, extractToolCall, extractAllPossibleToolCalls,
    extractThoughtFromMalformedText, cleanFinalResponse
} from './agent/ResponseParser.js';
import { detectCycle } from './agent/LoopDetector.js';
import { normalizeSafetyLimits } from './agent/SafetyLimits.js';
import { buildRecoveryHint } from './agent/RecoveryHints.js';

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
        this.toolExecutor = new ToolExecutor();
        this.caller = null;
    }

    addSteeringMessage(msg) {
        this.steeringQueue.push(msg);
    }

    async run(prompt, workspacePath, onUpdate, onAgentStatus, onConfirm, clientContext = null, chatContext = [], onLog = null, abortSignal = null, kisContext = '', images = []) {
        chatContext = chatContext || [];
        images = images || [];
        // How many leading steps re-attach the user's images to the LLM call. Covers
        // an investigate→plan→build flow where the image is only "used" after step 1,
        // while still bounding token cost on long tasks. (See use site below.)
        const IMAGE_ATTACH_MAX_STEPS = 10;

        // Re-resolve the active LLM connection from settings every run so
        // edits in Settings → LLM Connections take effect without a restart.
        // (If the user removed the previously-active instance, this re-picks the first available one.)
        await llmService.initFromConfig();

        // Surface the tool-calling mode once, so it's clear WHY argument typos
        // happen: in JSON-text mode the model hand-writes tool-call JSON (param
        // keys, commas, quotes) → structural typos. Native function-calling has
        // the API enforce the schema, eliminating that class of error.
        try {
            const nativeMode = llmService.supportsNativeTools?.();
            const provider = llmService.getCurrentProvider?.() || '?';
            onAgentStatus?.({
                event: 'status', status: 'running',
                message: nativeMode
                    ? `Tool calling: native function API (${provider}) — argument schema enforced.`
                    : `Tool calling: JSON-text mode (${provider} has no native function calls) — expect more argument typos. An OpenAI/Anthropic/Gemini/Azure connection enables schema-enforced calls.`
            });
        } catch (_) { /* non-critical */ }

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
        // Per-tool call counts (e.g. {read_file:3, write_file:1}) for the Result stats line.
        const toolUsageCounts = {};
        // The LAST present_result envelope the agent delivered — this is the model's
        // SUBSTANTIVE answer (markdown/table/etc.), distinct from the finish_task
        // wrap-up thought. Preferred as the Result's headline content.
        this._lastResultEnvelope = null;

        // ── Expand Intent/Recipe (behavior.intent) into behavior fields ──
        // A named AI action declared by the calling app. Inline-object form
        // { systemPrompt?, tools?[], resultKind? } is expanded here into the
        // existing enabled_tools / extra_instructions plumbing so the rest of
        // the loop needs no special-casing. (String-id resolution against a
        // per-app intent registry is a future step.)
        this._intentTier = null;   // reset per run (controller may be reused)
        this._modelOverride = null;
        this._deepModelId = null;
        this._applyIntent();

        // ── Load all Agent Safety Limits from config ─────────────────
        // For each field: 0 / null / undefined / non-numeric is treated as
        // "disabled / unlimited". Any positive integer is the hard threshold.
        const safety = await this._loadSafetyLimits();
        // Apply the configurable history-budget ratio to the compaction logic.
        conversationMemory.setBudgetConfig({ ratio: safety.historyBudgetRatio });
        // Low temperature for agent edits (fewer transcription typos). Applied only
        // when the active connection has no explicit temperature set (respects user config).
        this._agentTemperature = safety.agentTemperature;
        // External callers (apps invoking via the REST API, e.g. JHProjectManager)
        // run UNATTENDED — there is no human watching to review/approve a plan. The
        // plan-first gate's USER approval would therefore block forever (or be a
        // meaningless click). So plan-first applies ONLY to interactive callers
        // (JHAI's own chat = 'DirectChat', and scheduled runs). Computed once here
        // and reused below for the tool-allowlist decision.
        const isExternalCaller = (this.caller && !['DirectChat', 'Schedule'].includes(this.caller))
            || !!(this.behaviorOverrides && (this.behaviorOverrides.mcp_servers || this.behaviorOverrides.intent));
        this._isExternalCaller = isExternalCaller;
        // Plan-first gate: a complex task (or planMode='always') must propose a plan
        // and get USER approval before any mutating tool runs. Applied to the tool
        // executor AFTER startSession() (which resets the gate). 'off' disables it.
        // Skipped entirely for external callers (no human to approve).
        this._planRequired = !isExternalCaller
            && (safety.planMode === 'always'
                || (safety.planMode === 'auto' && this._looksComplex(prompt)));
        // Model routing (fast/deep tiers) + auto-escalation. fast = default for
        // quick/app-intent tasks; deep = complex/plan-first tasks and escalation.
        const tierModels = await this._resolveTierModels();
        this._deepModelId = tierModels.deep;
        this._modelOverride = this._planRequired
            ? (tierModels.deep || tierModels.fast || null)
            : (tierModels.initial || null);
        this._escalateAtStep = Math.max(6, Math.ceil((safety.maxIterations || 30) * 0.5));
        if (this._modelOverride) {
            onAgentStatus?.({ event: 'status', status: 'running', message: `🧭 モデル: ${this._modelOverride}${this._planRequired ? ' (deep / plan-first)' : ''}` });
        }

        // ── Vision routing ──────────────────────────────────────────────
        // If images are attached, the active/selected model MUST be vision-capable,
        // otherwise the Rust layer drops them with a note (symptom: "the current
        // model cannot read the image"). App tasks route to the FAST tier by
        // default, which is often a cheap text-only model — so auto-switch to any
        // configured vision-capable model, and if none exists, warn loudly instead
        // of silently ignoring the image.
        if (images.length > 0) {
            const chosen = this._modelOverride || llmService.getCurrentModel();
            const chosenOk = llmService.modelSupportsVision?.(chosen);
            if (!chosenOk) {
                const candidates = [
                    this.behaviorOverrides?.model,
                    tierModels.deep,
                    tierModels.fast,
                    llmService.getCurrentModel(),
                ].filter(Boolean);
                const visionModel = candidates.find(id => llmService.modelSupportsVision?.(id));
                if (visionModel) {
                    this._modelOverride = visionModel;
                    onAgentStatus?.({ event: 'status', status: 'running', message: `🖼 画像入力のためビジョン対応モデルに切替: ${visionModel}` });
                } else {
                    onAgentStatus?.({ event: 'status', status: 'running', message: `⚠️ ${images.length}枚の画像が添付されていますが、設定中のモデル(${chosen || '未設定'})はビジョン非対応です。画像は無視されます。Settings → LLM Connections で GPT-4o / Claude / Gemini などビジョン対応モデルを選択（またはFast/Deep tierに設定）してください。` });
                }
            } else {
                onAgentStatus?.({ event: 'status', status: 'running', message: `🖼 ${images.length}枚の画像を受信（モデル ${chosen} はビジョン対応）。` });
            }
        }
        // Load long-term memory (episodic summaries + durable facts) from disk so
        // ContextBuilder can inject relevant context into the system prompt. Cheap
        // and best-effort; getPromptContext degrades to '' if nothing is loaded.
        try {
            await conversationMemory.loadMemory(workspacePath);
        } catch (e) {
            console.warn('AgentController: loadMemory failed:', e);
        }
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
            'propose_plan',    // planning counts as progress (avoids no-progress stop while investigating)
            'finish_task',     // terminal — also counts as "progress" (will end loop)
        ]);

        await this.toolExecutor.startSession(workspacePath);
        // Arm the plan gate for this session (mutating tools blocked until approval).
        this.toolExecutor.setPlanGate(this._planRequired);

        // Invalidate ContextBuilder's static cache so the new session gets a
        // fresh build (picks up any persona/config changes since last run).
        contextBuilder.invalidateStaticCache();

        // Non-blocking cleanup of old session directories (>30 days).
        // Runs in the background — failures are silently ignored.
        this._cleanupOldSessions(workspacePath).catch(() => {});

        // Determine tool allowlist behavior. (isExternalCaller computed above.)
        let enabledTools = this.behaviorOverrides?.enabled_tools;

        if (isExternalCaller && (enabledTools === null || enabledTools === undefined)) {
            // External callers default to restricting native tools to only finish/meta tools,
            // while bypassing allowlist checks for MCP tools (provided by the workspace side).
            enabledTools = [];
            this.toolExecutor._mcpBypassesAllowlist = true;
        }

        if (Array.isArray(enabledTools)) {
            // Only add the planning/progress control tools when this task is
            // plan-required or complex; single-shot app intents stay minimal
            // (finish_task + present_result) to avoid needless over-planning.
            this.toolExecutor.setToolAllowlist(enabledTools, {
                includePlanTools: this._planRequired,
            });
        }
        // Apply MCP server filter (if any) — restricts which MCP servers contribute tools.
        if (this.behaviorOverrides && Array.isArray(this.behaviorOverrides.mcp_servers)) {
            this.toolExecutor.setMcpServerFilter(this.behaviorOverrides.mcp_servers);
        } else {
            this.toolExecutor.setMcpServerFilter(null);
        }

        // Apply per-task MCP context (e.g. {app,windowId,documentId}) — injected
        // into tools/call _meta.jhai so app-hosted MCP servers resolve live state.
        this.toolExecutor.setMcpContext(this.behaviorOverrides ? this.behaviorOverrides.mcp_context : null);

        // Bind tool executor event forwarding
        this.toolExecutor.onToolEvent = (event, data) => {
            // Capture the model's delivered answer (present_result) for the Result view.
            if (event === 'result' && data?.envelope) this._lastResultEnvelope = data.envelope;
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
                const path = `${this.toolExecutor.getSessionArtifactDir(workspacePath)}/task_plan.md`;
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

            // ── Auto-escalate fast→deep tier for long-running tasks ──
            if (this._deepModelId && this._modelOverride !== this._deepModelId
                && iteration >= this._escalateAtStep) {
                this._modelOverride = this._deepModelId;
                onAgentStatus?.({ event: 'status', status: 'running', message: `🧠 上位モデル(deep)に切替 — step ${iteration} 到達` });
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

            // First-iteration planning injection. With the plan gate ON (complex
            // task / planMode), enforce investigate → propose_plan → APPROVAL →
            // execute. Otherwise fall back to the lighter "register subtasks" nudge.
            if (iteration === 1) {
                if (this._planRequired) {
                    history.push({
                        role: 'user',
                        content: '[Plan-First Required] This is a complex task. Workflow you MUST follow:\n' +
                            '1. INVESTIGATE only (read_file / grep_search / list_files) until you understand the change and its impact across the codebase.\n' +
                            '2. Call `propose_plan` with the work split into ordered PHASES (e.g. Investigation → Implementation → Verification). The user reviews and may EDIT it.\n' +
                            '3. WAIT for approval. Editing files or running commands is BLOCKED until the plan is approved.\n' +
                            '4. After approval, execute PHASE BY PHASE, tracking progress with `task_progress`.\n' +
                            'Do NOT make any changes before the plan is approved.'
                    });
                } else if (this._looksComplex(prompt)) {
                    history.push({
                        role: 'user',
                        content: '[Planning Required] This task has multiple steps. Your VERY FIRST tool call MUST be `task_progress(action="set", items=[...])` — list every subtask before touching any file or running any command. After registering, proceed immediately with execution without waiting for confirmation.'
                    });
                }
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
                    let compactedHistory = await conversationMemory.compactHistory(history, currentModel, this.toolExecutor.getFileCache(), onLog);

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
                        const editContext = clientContext?.editContext || null;
                        systemPrompt = await contextBuilder.getSystemPrompt(workspacePath, this.toolExecutor, clientContext, editContext, kisContext, prompt);
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

                    // Phase 4: Use _generateWithHistory which tries native tools first.
                    // Send attached images for the FIRST FEW steps, not just step 1.
                    // Rationale: an investigate/plan-first flow often spends step 1 on a
                    // tool call (e.g. fetching current state) WITHOUT transcribing the
                    // image into text, so the actual output (e.g. building a WBS from a
                    // matrix screenshot) happens a few steps later. If images were sent
                    // only on step 1, the model would no longer "see" them when it matters
                    // — the exact symptom reported (matrix not in the message). Bounded to
                    // IMAGE_ATTACH_MAX_STEPS so we don't re-bill a large image on long tasks.
                    const stepImages = (iteration <= IMAGE_ATTACH_MAX_STEPS) ? images : [];
                    genResult = await this._generateWithHistory(compactedHistory, systemPrompt, abortSignal, kisContext, stepImages, onUpdate);
                    
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
                total_tokens: genResult.usage?.total_tokens || 0,
                cache_read_input_tokens: genResult.usage?.cache_read_input_tokens || 0,
                cache_creation_input_tokens: genResult.usage?.cache_creation_input_tokens || 0
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

                // Capture the FULL raw request payload for the per-task Monitor view
                // (replaces the old global Settings → API Logs). tools are only sent
                // as a native array when the provider supports function-calling;
                // in JSON-text mode they're embedded in system_prompt instead.
                let reqTools = [];
                let reqModel = '';
                let reqTemp = null;
                let reqMaxTokens = null;
                let reqMode = 'json-text';
                let imageDiag = { images_present: images.length, attached_this_step: false, vision_supported: false, images: [] };
                try {
                    reqModel = llmService.getCurrentModel?.() || '';
                    reqMode = llmService.supportsNativeTools?.() ? 'native' : 'json-text';
                    if (reqMode === 'native' && this.toolExecutor.getToolsForNativeAPI) {
                        reqTools = this.toolExecutor.getToolsForNativeAPI();
                    }
                    const ut = llmService.getCurrentTemperature?.();
                    reqTemp = (ut === null || ut === undefined) ? (this._agentTemperature ?? null) : ut;
                    reqMaxTokens = llmService.currentMaxOutputTokens ?? null;

                    // ── Image / vision diagnostics ─────────────────────────────
                    // Show, per step, EXACTLY whether the attached image(s) were sent
                    // to the LLM. The base64 blob itself is omitted (huge) but its
                    // mime + size is shown. `vision_supported` mirrors the Rust gate
                    // (model_supports_vision): if false, the Rust layer DROPS the
                    // image before the API call, so it never reaches the LLM.
                    const usedModelId = this._modelOverride || reqModel;
                    imageDiag.vision_supported = llmService.modelSupportsVision?.(usedModelId) || false;
                    const sentThisStep = (iteration <= IMAGE_ATTACH_MAX_STEPS) ? images : [];
                    imageDiag.attached_this_step = sentThisStep.length > 0 && imageDiag.vision_supported;
                    imageDiag.images = sentThisStep.map(s => {
                        const m = /^data:([^;]+);base64,/.exec(String(s));
                        return { mime: m ? m[1] : 'unknown(bare base64→image/png)', approx_bytes: String(s).length };
                    });
                } catch (_) { /* logging only — non-critical */ }

                onLog({
                    method: 'CHAT',
                    status: 200,
                    duration: duration,
                    stepLabel: `Step ${iteration}`,
                    usage: genResult.usage,
                    url: url,
                    headers: headers,
                    request: {
                        model: reqModel,
                        model_used: this._modelOverride || reqModel,
                        tool_calling: reqMode,
                        temperature: reqTemp,
                        max_tokens: reqMaxTokens,
                        vision_supported: imageDiag.vision_supported,
                        images_attached_to_llm: imageDiag.attached_this_step,
                        images: imageDiag.images,
                        system_prompt: systemPrompt,
                        history: history,
                        tools: reqTools,
                        url: url,
                        headers: headers
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
                toolCall.tool_calls.forEach(tc => {
                    usedToolTypes.add(tc.name);
                    toolUsageCounts[tc.name] = (toolUsageCounts[tc.name] || 0) + 1;
                });

                // (Removed legacy hack that silently bumped maxIterations to a
                // hardcoded 20 when ≥5 tool types were used — it overrode the user's
                // configured step cap. We now always honor the configured limit;
                // raise Settings → General → Max Steps if more headroom is needed.)

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
                    const level = this.toolExecutor.getPermissionLevel 
                        ? this.toolExecutor.getPermissionLevel(tc.name, tc.args) 
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
                        const result = await this.toolExecutor.executeTool(call, (statusMsg) => {
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
                    const result = await this.toolExecutor.executeTool(call, (statusMsg) => {
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

                // Recovery hints by error type → ./agent/RecoveryHints.js (unit-tested).
                let recoveryHint = hasErrors ? buildRecoveryHint(results) : '';

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
                if (this.toolExecutor.isTaskCompleted && this.toolExecutor.isTaskCompleted()) {
                    const ftResult = results.find(r => r.tool_call_name === 'finish_task');
                    // Prefer the model's FULL answer (its `thought` on the finishing turn,
                    // e.g. a rich markdown reply) over finish_task's one-line `summary`,
                    // so the Result tab shows the actual content, not just a recap.
                    let richThought = '';
                    if (toolCall?.thought) {
                        richThought = typeof toolCall.thought === 'string'
                            ? toolCall.thought
                            : (toolCall.thought.current_task || '');
                    }
                    richThought = this._cleanFinalResponse(richThought || '').trim();
                    const ftSummary = (ftResult?.result || '').trim();
                    finalResponse = (richThought.length >= 40) ? richThought : (ftSummary || richThought || response);
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

                if (this.toolExecutor.isTaskCompleted && this.toolExecutor.isTaskCompleted()) {
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

        // Capture session artifacts BEFORE endSession (which nulls workspacePath).
        const modifiedFiles = this.toolExecutor.getModifiedFiles();
        const sessionId = this.toolExecutor.getCurrentSessionId();
        const wsPath = workspacePath || this.toolExecutor.workspacePath;

        // Build the structured result summary (markdown + file table) consumed by
        // the "Result" tab (MonitorView) and the chat file list (ChatView), and
        // returned to REST API callers via the `complete` event. The meta lets the
        // summary be a DETAILED report (request → plan → actions → result) rather
        // than a bare one-liner.
        const resultSummary = await this._buildResultSummary(finalResponse, modifiedFiles, onLog, {
            prompt,
            approvedPlan: this.toolExecutor._approvedPlan || '',
            toolCounts: toolUsageCounts,
            iterations: iteration,
            durationMs: Date.now() - taskStartMs,
            tokens: cumulativeTokens,
            presentedAnswer: this._extractEnvelopeAnswer(this._lastResultEnvelope),
        });

        // Long-term memory: record this completed session to the durable journal +
        // facts store. (Previously addEntry existed but was never called — LTM was
        // effectively dormant.) Best-effort; never block completion on it.
        try {
            await conversationMemory.addEntry(prompt, finalResponse, sessionId, wsPath, onLog);
        } catch (e) {
            console.warn('AgentController: LTM addEntry failed:', e);
        }

        this.toolExecutor.endSession();

        return {
            response: finalResponse,
            modifiedFiles,
            resultSummary
        };
    }

    /**
     * Build a structured result summary for the post-run "Result" view.
     * @param {string} finalResponse - the agent's final summary text (markdown-ish)
     * @param {Array}  modifiedFiles - [{ path, original, current }] from ToolExecutor
     * @returns {Promise<{summary:string, files:Array<{path,action,description}>}>}
     */
    async _buildResultSummary(finalResponse, modifiedFiles, onLog = null, meta = {}) {
        // action is derived deterministically: a null/empty `original` means the
        // file did not exist before this session → "created"; otherwise "modified".
        const files = (modifiedFiles || []).map(f => ({
            path: f.path,
            action: (f.original === null || f.original === undefined || f.original === '')
                ? 'created' : 'modified',
            description: ''
        }));

        // Best-effort one-line description per file via a single cheap LLM call.
        // Wrapped so a failure (or no LLM) just leaves descriptions blank.
        if (files.length > 0 && files.length <= 30) {
            try {
                const list = files.map(f => `- ${f.path} (${f.action})`).join('\n');
                const prompt =
                    `Given the agent's final summary and the list of files it created/modified, ` +
                    `write a concise one-line description (max 80 chars, same language as the summary) ` +
                    `of each file's role/purpose. Output ONLY a raw JSON array of {"path","description"} — no markdown.\n\n` +
                    `[Final Summary]\n${String(finalResponse || '').substring(0, 1200)}\n\n[Files]\n${list}`;
                let raw = '';
                const sumSys = 'You are a JSON generator. Output ONLY a valid JSON array, nothing else.';
                const _t0 = Date.now();
                const gen = await llmService.generate(prompt, sumSys, (chunk) => { raw += chunk; });
                if (onLog) {
                    try {
                        onLog({
                            method: 'CHAT', status: 200, duration: Date.now() - _t0,
                            stepLabel: '📋 Result File Descriptions',
                            usage: gen?.usage,
                            request: { purpose: 'result-file-descriptions', system_prompt: sumSys, prompt },
                            response: raw
                        });
                    } catch (_) {}
                }
                const m = raw.match(/\[[\s\S]*\]/);
                if (m) {
                    const arr = JSON.parse(m[0]);
                    for (const item of (Array.isArray(arr) ? arr : [])) {
                        if (!item || !item.path) continue;
                        const norm = String(item.path).replace(/\\/g, '/');
                        const match = files.find(f =>
                            f.path === item.path ||
                            f.path.replace(/\\/g, '/') === norm ||
                            f.path.replace(/\\/g, '/').endsWith(norm));
                        if (match && item.description) {
                            match.description = String(item.description).substring(0, 200);
                        }
                    }
                }
            } catch (e) {
                console.warn('AgentController: file description generation failed:', e);
            }
        }

        // Assemble both a flat markdown `summary` (back-compat: API consumers, chat,
        // older renderers) AND structured fields for the sectioned Result UI
        // (answer / stats / request / plan / files rendered as distinct sections).
        const summary = this._composeDetailedReport(finalResponse, files, meta);
        const presented = String(meta.presentedAnswer || '').trim();
        const answer = (presented.length >= 1) ? presented : String(finalResponse || '');
        const stats = {
            steps: meta.iterations || 0,
            tools: meta.toolCounts || {},
            tokens: meta.tokens || 0,
            durationMs: meta.durationMs || 0,
            files: files.length,
        };
        return {
            summary,
            answer,
            stats,
            request: String(meta.prompt || ''),
            plan: String(meta.approvedPlan || ''),
            files,
        };
    }

    /**
     * Extract the model's substantive answer text from a present_result envelope.
     * Returns '' when there is no usable text payload (e.g. file-list/code-edit
     * kinds carry structured data, not prose — those fall back to finalResponse).
     */
    _extractEnvelopeAnswer(envelope) {
        if (!envelope || typeof envelope !== 'object') return '';
        const p = envelope.payload || {};
        return String(p.md || p.text || p.markdown || envelope.summary || '').trim();
    }

    /**
     * Compose the Result markdown. ANSWER-FIRST: the model's actual deliverable
     * (present_result content, else the final response) is the headline; run
     * statistics are a single compact line; the originating request / plan follow
     * as small, truncated context. Deterministic (no LLM).
     */
    _composeDetailedReport(finalResponse, files = [], meta = {}) {
        const {
            prompt = '', approvedPlan = '', toolCounts = {},
            iterations = 0, durationMs = 0, tokens = 0, presentedAnswer = '',
        } = meta;
        const clip = (s, n) => {
            const t = String(s || '').trim();
            return t.length > n ? t.slice(0, n) + `\n… (省略 ${t.length - n} 文字)` : t;
        };

        const sections = [];

        // 1. HEADLINE — the LLM's actual answer (present_result preferred).
        const answer = (presentedAnswer && presentedAnswer.length >= 1)
            ? presentedAnswer
            : String(finalResponse || '');
        sections.push(clip(answer, 8000) || '（回答なし）');

        // 2. Compact stats line (one row, secondary).
        const stat = [`ステップ ${iterations}`];
        const toolPairs = Object.entries(toolCounts || {});
        if (toolPairs.length) {
            stat.push('ツール ' + toolPairs.map(([n, c]) => `${n}×${c}`).join(', '));
        }
        if (tokens > 0) {
            stat.push(`トークン ${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens}`);
        }
        if (durationMs > 0) stat.push(`所要 ${Math.round(durationMs / 1000)}s`);
        if (Array.isArray(files) && files.length) stat.push(`ファイル ${files.length}件`);
        sections.push(`---\n\n> 📊 ${stat.join(' ・ ')}`);

        // 3. Small context tail: request + plan (truncated). Kept minor since the
        //    full request/history is already available in the other Monitor tabs.
        const tail = [];
        if (prompt && String(prompt).trim()) {
            tail.push(`**📥 ご依頼内容**\n\n${clip(prompt, 600)}`);
        }
        if (approvedPlan && String(approvedPlan).trim()) {
            tail.push(`**🗺 実行計画**\n\n${clip(approvedPlan, 1500)}`);
        }
        if (tail.length) sections.push(tail.join('\n\n'));

        return sections.join('\n\n');
    }

    // ─── Phase 4: _generateWithHistory — tries native tool calling first, falls back to JSON mode ───

    async _generateWithHistory(history, systemPrompt, abortSignal, kisContext = '', images = [], onUpdate = null) {
        // Use the single source-of-truth from LLMService.
        // ContextBuilder has already built systemPrompt using the same flag, so the
        // protocol section in the prompt always matches the API call we make here.
        const useNativeTools = llmService.supportsNativeTools() && typeof llmService.chatWithTools === 'function';

        // Resolve the agent temperature: only override when the connection has no
        // explicit temperature (so we never clobber a value the user deliberately set).
        const userTemp = llmService.getCurrentTemperature ? llmService.getCurrentTemperature() : undefined;
        const tempOverride = (userTemp === null || userTemp === undefined)
            ? (Number.isFinite(this._agentTemperature) ? this._agentTemperature : null)
            : null;

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
                    const tools = this.toolExecutor.getToolsForNativeAPI ? this.toolExecutor.getToolsForNativeAPI() : [];
                    if (tools.length === 0) break; // No tools registered, skip native

                    const result = await llmService.chatWithTools(currentHistory, systemPrompt, tools, abortSignal, images, tempOverride, this._modelOverride || null);

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
                            this.toolExecutor.toolDefinitions?.some(td => new RegExp(`\\b${td.name}\\b`).test(txt) && /PLAN:/i.test(txt));
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
        return await llmService.chat(history, fallbackSystemPrompt, onUpdate, abortSignal, images, tempOverride, this._modelOverride || null);
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

    /**
     * True if a "Tool Execution Results:" message contains a successful read_file
     * result whose content is substantial but within `budget` chars — i.e. a file
     * snapshot worth preserving verbatim through compression (re-read suppression).
     */
    _resultGroupHasReadContent(content, budget) {
        if (typeof content !== 'string') return false;
        try {
            const marker = 'Tool Execution Results:\n';
            const j = content.indexOf(marker);
            if (j === -1) return false;
            const raw = content.substring(j + marker.length).trim();
            const end = raw.indexOf('\n[');
            const jsonStr = end !== -1 ? raw.substring(0, end) : raw;
            const results = JSON.parse(jsonStr);
            if (!Array.isArray(results)) return false;
            return results.some(r =>
                r && r.tool_call_name === 'read_file' &&
                typeof r.result === 'string' &&
                !r.result.startsWith('Error') &&
                r.result.length > 200 && r.result.length <= budget);
        } catch (_) {
            return false;
        }
    }

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

        // ── Re-read suppression: preserve the latest read_file SNAPSHOT verbatim ──
        // Stripping old read_file results to "(Completed)" discards the file's
        // content, so once a read ages out of the 3-recent window the agent has
        // nothing to work from and RE-READS the whole file — the dominant token
        // sink on long single-file edits. Keep the most-recent sizable read_file
        // result (one file, within a char budget) so the current snapshot stays
        // available and re-reads become unnecessary.
        const SNAPSHOT_CHAR_BUDGET = 40000;
        let preserveIdx = -1;
        for (const idx of toolResultIndices) { // newest-first
            if (this._resultGroupHasReadContent(history[idx]?.content, SNAPSHOT_CHAR_BUDGET)) {
                preserveIdx = idx;
                break;
            }
        }

        for (const i of toCompress) {
            if (i === preserveIdx) continue; // keep the latest file snapshot intact
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

    // Pure parsing logic lives in ./agent/ResponseParser.js (Phase 1 refactor).
    // These thin wrappers preserve the existing `this._method(...)` call sites.
    _safeParseJSON(str) { return safeParseJSON(str); }

    // ─── Tool-call extraction → ./agent/ResponseParser.js (thin wrappers) ───
    _extractToolCall(text) { return extractToolCall(text); }
    _extractAllPossibleToolCalls(text) { return extractAllPossibleToolCalls(text); }
    _extractThoughtFromMalformedText(text) { return extractThoughtFromMalformedText(text); }

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
        let cfg = {};
        try { cfg = await invoke('get_ai_config'); } catch (_) { /* keep defaults */ }
        // Pure normalization lives in ./agent/SafetyLimits.js (unit-tested).
        return normalizeSafetyLimits(cfg);
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
    _detectCycle(history, minRepeats = 3) { return detectCycle(history, minRepeats); }

    // ─── Phase 4: Full _cleanFinalResponse with thought extraction + multi-language (from JHEditor) ───

    _cleanFinalResponse(text) { return cleanFinalResponse(text); }

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
    /**
     * Expand `behaviorOverrides.intent` (AI-Hub Intent/Recipe) into the existing
     * behavior fields, in place. Accepts an inline object
     * `{ systemPrompt?, tools?[], resultKind? }`. A bare string id is left for a
     * future per-app intent registry (no-op here). Does not override fields the
     * caller already set explicitly.
     */
    /**
     * Resolve fast/deep tier model ids from config + behavior. Returns
     * { fast, deep, initial }. `initial` honors an explicit behavior.model, else
     * the intent tier ('deep'→deep, else fast). All null ⇒ routing disabled
     * (the active model is used, i.e. no override).
     */
    async _resolveTierModels() {
        try {
            const cfg = await invoke('get_ai_config');
            const fast = cfg.fast_model_id || null;
            const deep = cfg.deep_model_id || null;
            if (!fast && !deep) return { fast: null, deep: null, initial: null };
            const explicit = (this.behaviorOverrides && this.behaviorOverrides.model) || null;
            const tier = this._intentTier || 'fast';
            const initial = explicit || (tier === 'deep' ? (deep || fast) : (fast || deep));
            return { fast, deep, initial };
        } catch (_) {
            return { fast: null, deep: null, initial: null };
        }
    }

    _applyIntent() {
        const b = this.behaviorOverrides;
        if (!b || !b.intent) return;
        const intent = b.intent;
        if (typeof intent !== 'object') return;   // string id → future registry; skip

        // tools → enabled_tools allowlist (don't clobber an explicit one).
        if (Array.isArray(intent.tools) && !Array.isArray(b.enabled_tools)) {
            b.enabled_tools = intent.tools.slice();
        }

        // tier ('fast' | 'deep') → model routing hint (resolved in run()).
        if (typeof intent.tier === 'string') {
            this._intentTier = intent.tier.trim().toLowerCase() || null;
        }

        // systemPrompt → replaces the default system prompt entirely
        if (typeof intent.systemPrompt === 'string' && intent.systemPrompt.trim()) {
            b.system_prompt = intent.systemPrompt.trim();
        }

        // resultKind → appended guidance via extra_instructions
        // (which the loop already merges into the system prompt).
        const extra = [];
        if (typeof intent.resultKind === 'string' && intent.resultKind.trim()) {
            extra.push(
                `When the task is complete, deliver the result to the calling app by calling ` +
                `present_result with kind="${intent.resultKind.trim()}" (then finish_task).`
            );
        }
        if (extra.length > 0) {
            b.extra_instructions = [b.extra_instructions, ...extra]
                .filter(s => typeof s === 'string' && s.trim())
                .join('\n\n');
        }
    }

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

        // Complexity verbs + non-trivial length (English)
        if (p.length > 100 && /\b(implement|add|create|refactor|update|modify|change|fix|migrate|convert|integrate)\b/i.test(p)) return true;

        // Complexity verbs (Japanese) + non-trivial length. Japanese has no word
        // spaces, so we gate on raw character count instead of word count.
        if (p.length > 60 && /(実装|追加|作成|リファクタ|修正|変更|対応|移行|統合|設計|置き換|分割|整理|導入)/.test(p)) return true;

        // Word count > 60 — probably a detailed instruction (space-delimited langs)
        if (p.split(/\s+/).length > 60) return true;

        // Long CJK instruction (no spaces) — > 120 chars is rarely a one-liner
        if (p.length > 120 && /[぀-ヿ一-龯]/.test(p)) return true;

        return false;
    }
}
