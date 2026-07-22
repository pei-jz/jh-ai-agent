import llmService from './LLMService.js';
import { ToolExecutor } from './ToolExecutor.js';
import { contextBuilder, ContextBuilder } from './ContextBuilder.js';
import { conversationMemory } from './ConversationMemory.js';
import { tokenEstimator } from './TokenEstimator.js';
import { jsonrepair } from 'jsonrepair';
import { invoke } from '@tauri-apps/api/core';
import {
    safeParseJSON, extractToolCall, extractAllPossibleToolCalls,
    extractThoughtFromMalformedText, cleanFinalResponse, stripReActPreamble
} from './agent/ResponseParser.js';
import { detectCycle } from './agent/LoopDetector.js';
import { normalizeSafetyLimits } from './agent/SafetyLimits.js';
import { buildRecoveryHint } from './agent/RecoveryHints.js';
import {
    resolveRole, composeSubtaskPrompt, buildReviewBrief, parseReviewVerdict, clipText, childTokenBudget,
    scopesOverlap, WRITE_ENFORCED_TOOLS, TESTER_WRITE_PATTERNS,
    SUBTASK_MAX_PARALLEL, SUBTASK_MAX_PER_RUN, SUBTASK_REPORT_MAX_CHARS, SUBTASK_MAX_STEPS_CAP
} from './agent/SubagentRoles.js';

// Tools blocked by the Plan-First gate until the user approves the plan —
// anything that mutates the workspace or runs shell commands. Investigation
// tools (read_file / grep_search / glob / list_files), present_result, ask_user
// and finish_task are intentionally NOT gated: the agent needs them to build and
// deliver the plan and to pause for approval.
const PLAN_GATED_TOOLS = new Set([
    'write_file', 'multi_replace_file_content', 'replace_lines',
    'delete_file', 'move_file', 'run_command',
]);

/**
 * True when a present_result envelope actually carries a deliverable. Used to
 * stop an empty follow-up present_result from clobbering a good earlier one.
 */
function _envelopeHasContent(env) {
    if (!env || typeof env !== 'object') return false;
    const p = env.payload || {};
    const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
    switch (env.kind) {
        case 'answer':    return nonEmptyStr(p.text) || nonEmptyStr(p.answer);
        case 'code-edit': return Array.isArray(p.edits) && p.edits.length > 0;
        case 'file-list': return Array.isArray(p.files) && p.files.length > 0;
        case 'markdown':
        case 'table':
        default:          return nonEmptyStr(p.md) || nonEmptyStr(p.markdown) || nonEmptyStr(p.text);
    }
}

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

        // Phase 2: Goal-pinning — the CURRENT goal is always an explicitly
        // labeled user message. On a CONTINUED task the chatContext carries the
        // previous request/answer exchanges: label those requests as COMPLETED
        // so the model never mistakes an old (already delivered) request for the
        // active goal — the new message is the goal now.
        let history = [];
        if (chatContext.length > 0) {
            history.push(...chatContext.map(m =>
                (m.role === 'user' && typeof m.content === 'string'
                    && !/^\[(Original Goal|Current Goal|Completed request)/.test(m.content))
                    ? { ...m, content: `[Completed request — already delivered, do NOT redo] ${m.content}` }
                    : m
            ));
            history.push({ role: 'user', content: `[Current Goal — NEW request; the completed requests above are context only] ${prompt}` });
        } else {
            history.push({ role: 'user', content: `[Original Goal] ${prompt}` });
        }
        
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
        // One-time soft nudge if finish_task is called with no deliverable (reset per run).
        this._deliverableNudged = false;
        // ── Sub-agent engine per-run state ────────────────────────────
        // _isSubagent is set by the PARENT before child.run() — children never
        // spawn further sub-agents and skip the review gate.
        this._reviewDone = false;
        this._subtaskCount = 0;
        this._subtaskActive = 0;
        // Tokens consumed by sub-agents (prompt+completion) — counted toward
        // the PARENT's per-run token budget so delegation can't bypass the cap.
        this._subtaskTokens = 0;
        // Mirror of cumulativeTokens (parent's own LLM spend) readable from
        // _runSubtask, for computing the remaining budget to hand to children.
        this._spentTokens = 0;
        // Write-ownership registry (Step 3): label → active write claim
        // (scope array). Children whose claims overlap are SERIALIZED.
        this._writeClaims = new Map();

        // ── Efficiency instrumentation (step-reduction measurement) ───────
        // Continuously measure the two dominant token sinks so a regression in
        // re-read suppression or history compaction is VISIBLE in the per-task
        // logs (📊 Efficiency Report at finish) instead of only surfacing as a
        // vague "this took too many steps". Measurement only — never steers.
        this._readCounts = new Map();   // normalized path → times read_file'd
        this._efficiency = {
            reReads: 0,                 // read_file calls on an already-read path
            reReadChars: 0,             // approx chars re-fetched (wasted context)
            compressions: 0,            // _compressToolResultsInHistory invocations
            compactions: 0,             // conversationMemory.compactHistory invocations
            compactionCharsSaved: 0,    // history chars removed by compaction
            promptTokens: 0,            // cumulative prompt (input) tokens
            completionTokens: 0,        // cumulative completion (output) tokens
        };

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
        // Per-run token-budget override (used by the sub-agent engine to hand a
        // child a SLICE of the parent's budget; also available to REST callers).
        if (this.behaviorOverrides && Number.isFinite(this.behaviorOverrides.token_budget)
            && this.behaviorOverrides.token_budget > 0) {
            safety.tokenBudget = Math.floor(this.behaviorOverrides.token_budget);
        }
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
        // NewTask = the Monitor "new task" modal (interactive, human-watched) →
        // must keep the FULL built-in toolset like DirectChat. Without it the
        // external-caller branch below strips tools to finish/present only, so a
        // NewTask agent couldn't even read_file its workspace.
        const INTERACTIVE_CALLERS = ['DirectChat', 'Schedule', 'NewTask'];
        const isExternalCaller = (this.caller && !INTERACTIVE_CALLERS.includes(this.caller))
            || !!(this.behaviorOverrides && (this.behaviorOverrides.mcp_servers || this.behaviorOverrides.intent));
        this._isExternalCaller = isExternalCaller;

        // ── Plan-First approval gate ─────────────────────────────────────
        // For a complex task, the agent must FIRST deliver a concrete plan and
        // get the user's approval before it may edit files or run commands.
        // Enforced in code (PLAN_GATED_TOOLS blocked until approved), not just
        // by prompt. Config: safety.planMode = 'off' | 'auto' (complex only) |
        // 'always'. ONLY interactive, human-watched runs (DirectChat/NewTask)
        // and only the FIRST turn of a task — a continuation (chatContext
        // present) is the approval reply itself, so it proceeds to implement.
        // Sub-agents and unattended/external callers never plan-gate (no human
        // to approve → would deadlock). A per-request bypass phrase skips it.
        const planMode = safety.planMode || 'auto';
        const isFreshTurn = !Array.isArray(chatContext) || chatContext.length === 0;
        const planBypass = /計画(は)?(不要|いらない|なし)|そのまま実装|プラン不要|no\s*plan|skip\s*plan|just\s*implement/i.test(String(prompt || ''));
        // Only callers with a HUMAN watching in real time can approve a plan.
        // 'Schedule' is in INTERACTIVE_CALLERS (full toolset) but runs UNATTENDED,
        // so it must NOT plan-gate (ask_user would pause forever).
        const PLAN_FIRST_CALLERS = new Set(['DirectChat', 'NewTask']);
        this._planFirstActive = planMode !== 'off'
            && PLAN_FIRST_CALLERS.has(this.caller)
            && !this._isSubagent
            && isFreshTurn
            && !planBypass
            && (planMode === 'always' || this._looksComplex(prompt));
        this._planApproved = !this._planFirstActive;
        if (this._planFirstActive) {
            onAgentStatus?.({ event: 'status', status: 'running', message: '📋 計画優先モード — まず計画を提示し承認を得ます / Plan-first: proposing a plan for approval' });
        }
        //
        // Model routing (fast/deep tiers) + auto-escalation. fast = default for
        // quick/app-intent tasks; deep = complex tasks and long-run escalation.
        //
        // EXCEPTION — interactive chat (DirectChat): the user explicitly picks a
        // model in the chat dropdown (→ llmService.getCurrentModel()). That choice
        // MUST win, so tier routing / auto-escalation is DISABLED here. Otherwise a
        // globally-configured Fast/Deep tier model silently overrides the selection
        // — the reported symptom: the UI shows "GEMINI" but DeepSeek (the Fast tier)
        // actually runs. Tier routing still applies to app-intent / external /
        // scheduled callers, which have no live model picker.
        const userPicksModel = this.caller === 'DirectChat';
        const tierModels = userPicksModel
            ? { fast: null, deep: null, initial: null }
            : await this._resolveTierModels();
        this._deepModelId = tierModels.deep;
        this._modelOverride = tierModels.initial || null;
        this._escalateAtStep = Math.max(6, Math.ceil((safety.maxIterations || 30) * 0.5));
        if (this._modelOverride) {
            onAgentStatus?.({ event: 'status', status: 'running', message: `🧭 モデル: ${this._modelOverride}` });
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
            'finish_task',     // terminal — also counts as "progress" (will end loop)
        ]);

        await this.toolExecutor.startSession(workspacePath);

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
            // Add task_progress only for complex tasks; single-shot app intents
            // stay minimal (finish_task + present_result) to avoid over-planning.
            this.toolExecutor.setToolAllowlist(enabledTools, {
                includeTaskTools: this._looksComplex(prompt),
            });
        }
        // Write scope (Step 3): hard-restrict file-mutating tools to the given
        // paths/globs. Set for sub-agents by _runSubtask; also honored for REST
        // callers that pass behavior.write_scope.
        if (Array.isArray(this.behaviorOverrides?.write_scope) && this.behaviorOverrides.write_scope.length > 0) {
            this.toolExecutor.setWriteScope(this.behaviorOverrides.write_scope);
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

        // ── MCP tool pruning (interactive callers only) ─────────────────
        // Big MCP servers (e.g. Backlog: 58 tools) used to ship EVERY schema to
        // the LLM each step. With the prompt as relevance query, only the top-5
        // most relevant MCP tools are sent; the rest are omitted for this run.
        // External app callers keep the old behavior — their tool set is already
        // scoped by the intent (enabled_tools / mcp_servers).
        this.toolExecutor.setMcpRelevanceQuery(isExternalCaller ? null : prompt);

        // ── run_subtask engine (docs/design/subagent-architecture.md) ──────
        // Inject the sub-agent runner so the generic run_subtask tool works.
        // Parent runs only: children must not recurse (their allowlists exclude
        // run_subtask AND no runner is attached, so the tool isn't even
        // presented to them).
        if (!this._isSubagent) {
            this.toolExecutor.setSubtaskRunner((args) =>
                this._runSubtask(args, { workspacePath, onAgentStatus, onConfirm, onLog, abortSignal, safety }));
        }

        // Bind tool executor event forwarding
        this.toolExecutor.onToolEvent = (event, data) => {
            // Capture the model's delivered answer (present_result) for the Result view.
            // Guard against a common misfire: some models call present_result twice —
            // a good one, then an empty follow-up (e.g. kind:"answer", text:"") — which
            // would otherwise clobber the real deliverable. Keep the earlier non-empty
            // envelope unless the new one actually carries content.
            if (event === 'result' && data?.envelope) {
                const incoming = data.envelope;
                if (!this._lastResultEnvelope
                    || _envelopeHasContent(incoming)
                    || !_envelopeHasContent(this._lastResultEnvelope)) {
                    this._lastResultEnvelope = incoming;
                }
            }
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
            // Sub-agent consumption (_subtaskTokens) counts toward the same cap —
            // delegation must not be a budget bypass.
            if (safety.tokenBudget > 0) {
                const spent = cumulativeTokens + this._subtaskTokens;
                if (spent >= safety.tokenBudget) {
                    onAgentStatus?.({ event: 'status', status: 'running', message: `Token budget (${safety.tokenBudget.toLocaleString()}) reached — auto-stopping.` });
                    finalResponse = (finalResponse || '') +
                        `\n\n(注意: 累積トークン数（サブエージェント分含む）が予算 ${safety.tokenBudget.toLocaleString()} に到達したため、自動停止しました。Settings → General → Token Budget で調整できます。)`;
                    break;
                }
                if (spent >= safety.tokenBudget * 0.8 && !tokenBudgetWarned) {
                    tokenBudgetWarned = true;
                    history.push({
                        role: 'user',
                        content: `[System Notice] You've consumed ${spent.toLocaleString()} of ${safety.tokenBudget.toLocaleString()} budgeted tokens (80%, sub-agents included). Please prioritize: call \`finish_task\` if the goal is essentially achieved, otherwise summarize progress so the user can extend the budget if needed.`
                    });
                }
            }

            // Apply steering
            if (this.steeringQueue && this.steeringQueue.length > 0) {
                const steers = this.steeringQueue.splice(0, this.steeringQueue.length);
                const steeringText = steers.map(s => typeof s === 'string' ? s : s.message).join('\n\n');
                
                const steeringMsg = {
                    role: 'user',
                    content: `[Steering Instruction / Course Correction]\nReceived the following instruction from the user during execution. Please reflect it in your plan and approach immediately:\n${steeringText}`
                };

                // Append any images from the steering payloads
                const allImages = [];
                for (const s of steers) {
                    if (s && typeof s === 'object' && s.images && Array.isArray(s.images)) {
                        allImages.push(...s.images);
                    }
                }
                
                if (allImages.length > 0) {
                    steeringMsg.content = [
                        { type: "text", text: steeringMsg.content },
                        ...allImages.map(img => ({
                            type: "image_url",
                            image_url: { url: img }
                        }))
                    ];
                }

                history.push(steeringMsg);
                
                // Emit a dedicated event so the UI can show a visible acknowledgment.
                const preview = steeringText.split('\n')[0].substring(0, 80);
                onAgentStatus?.({ event: 'steering_received', message: `📌 Steering received: "${preview}"` });
                onAgentStatus?.({ event: 'status', status: 'running', message: `📌 Steering applied: "${preview}"` });
            }

            // First-iteration planning injection.
            if (iteration === 1 && this._planFirstActive) {
                // Plan-First: deliver a concrete plan + get approval BEFORE editing.
                history.push({
                    role: 'user',
                    content: '[Plan-First — approval required]\n' +
                        'This is a complex task. Editing files and running commands are BLOCKED by the system until the user approves your plan.\n' +
                        'Do this now:\n' +
                        '1. Investigate as needed with READ-ONLY tools (read_file / grep_search / glob / list_files) to make the plan concrete and correct.\n' +
                        '2. Deliver the plan with `present_result(kind:"markdown", ...)` using EXACTLY these sections:\n' +
                        '   ## ゴール\n   ## 変更対象ファイル (list each file + what changes)\n   ## アプローチ\n   ## リスク・確認事項\n   ## テスト方法\n' +
                        '3. Then call `ask_user(question:"この計画で実装を進めてよろしいですか？修正があれば教えてください。", context:<one-line plan gist>, options:["はい、実装して","修正したい"], multi_select:false)` and STOP.\n' +
                        'The user\'s reply arrives as your next turn; after approval the edit/command tools are unblocked. Do NOT attempt any edit or command before then.'
                });
            } else if (iteration === 1 && this._looksComplex(prompt)) {
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
                    // ── Cache-aware compression gate ───────────────────────────
                    // Per-step compression of old tool results rewrites middle
                    // history messages, which BREAKS the LLM prompt cache (the
                    // cached prefix must be byte-identical). On read-heavy
                    // multi-step tasks this meant only the system prompt was ever
                    // cached. So only compress once history grows past
                    // `historyCompressRatio` of the window; below that, leave it
                    // byte-stable so the cache reuses it. compactHistory (heavier)
                    // still runs at its own higher threshold as the backstop.
                    try {
                        const compressLimit = (llmService.getEffectiveModelLimit?.() || tokenEstimator.getModelLimit(currentModel));
                        const histTokens = tokenEstimator.estimateConversation(history, '').totalTokens;
                        if (compressLimit > 0 && histTokens > compressLimit * safety.historyCompressRatio) {
                            this._compressToolResultsInHistory(history);
                            this._efficiency.compressions++;
                        }
                    } catch (_) {
                        // Estimation unavailable — fall back to always-compress so
                        // we never risk overflowing the context window.
                        this._compressToolResultsInHistory(history);
                        this._efficiency.compressions++;
                    }
                    const _histCharsBefore = this._historyChars(history);
                    let compactedHistory = await conversationMemory.compactHistory(history, currentModel, this.toolExecutor.getFileCache(), onLog);
                    const _histCharsAfter = this._historyChars(compactedHistory);
                    if (_histCharsAfter < _histCharsBefore) {
                        this._efficiency.compactions++;
                        this._efficiency.compactionCharsSaved += (_histCharsBefore - _histCharsAfter);
                    }

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
                        systemPrompt = await contextBuilder.getSystemPrompt(workspacePath, this.toolExecutor, clientContext, editContext, kisContext, prompt, this._modelOverride || llmService.getCurrentModel());
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
                            // Keep the CURRENT goal message + last 3 messages. On a
                            // continued task the goal is NOT history[0] (that's the
                            // old, already-completed request) — find the newest
                            // [Original Goal]/[Current Goal] user message instead.
                            let goalMsg = compactedHistory[0];
                            for (let gi = compactedHistory.length - 1; gi >= 0; gi--) {
                                const m = compactedHistory[gi];
                                if (m.role === 'user' && typeof m.content === 'string'
                                    && /^\[(Original Goal|Current Goal)/.test(m.content)) { goalMsg = m; break; }
                            }
                            const tail = compactedHistory.slice(-3).filter(m => m !== goalMsg);
                            const trimmed = [
                                goalMsg,
                                { role: 'user', content: '[System: Middle history trimmed to stay within context budget. The goal above remains your primary objective.]' },
                                { role: 'assistant', content: 'Understood — context trimmed, continuing toward the current goal.' },
                                ...tail
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
            this._spentTokens = cumulativeTokens;
            this._efficiency.promptTokens += (genResult.usage?.prompt_tokens || 0);
            this._efficiency.completionTokens += (genResult.usage?.completion_tokens || 0);

            onAgentStatus?.({
                event: 'token_usage',
                prompt_tokens: genResult.usage?.prompt_tokens || 0,
                completion_tokens: genResult.usage?.completion_tokens || 0,
                total_tokens: genResult.usage?.total_tokens || 0,
                cache_read_input_tokens: genResult.usage?.cache_read_input_tokens || 0,
                cache_creation_input_tokens: genResult.usage?.cache_creation_input_tokens || 0,
                // Context-occupancy snapshot for the Monitor's context gauge:
                // what THIS call actually sent as input (prompt + cached reads +
                // cache writes) vs the model's effective context window.
                context_used: (genResult.usage?.prompt_tokens || 0)
                    + (genResult.usage?.cache_read_input_tokens || 0)
                    + (genResult.usage?.cache_creation_input_tokens || 0),
                context_limit: (() => { try { return llmService.getEffectiveModelLimit?.() || 0; } catch (_) { return 0; } })()
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
                    // Decide the mode for the model actually sent (tier/override).
                    reqMode = llmService.supportsNativeTools?.(this._modelOverride || reqModel) ? 'native' : 'json-text';
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
                        // The EXACT assembled body sent to the provider (cache_control,
                        // system split, trailing volatile msg, messages in send order).
                        sent_request: genResult.sentRequest || null,
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

                // Emit a status update with abbreviated label, then the full thought once.
                // (Using 'status' for the label avoids creating a duplicate step in ChatView.)
                const taskName = typeof toolCall.thought === 'string'
                    ? (toolCall.thought.substring(0, 60) + (toolCall.thought.length > 60 ? '...' : ''))
                    : (toolCall.thought.current_task || 'Thinking...');

                onAgentStatus?.({ event: 'status', status: 'running', message: `${taskName} (step ${iteration})` });
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

                // ── Plan-First gate: block edits/commands until the plan is
                //    approved. The agent must present a plan + ask_user first;
                //    read/investigation tools, present_result and ask_user pass.
                if (this._planFirstActive && !this._planApproved) {
                    const gated = toolCall.tool_calls.filter(tc => PLAN_GATED_TOOLS.has(tc.name));
                    if (gated.length > 0) {
                        const names = [...new Set(gated.map(g => g.name))].join(', ');
                        onAgentStatus?.({ event: 'status', status: 'running', message: `📋 計画承認待ち — 編集/コマンドをブロック中 (${names})` });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: `[Plan-First — blocked] The tool(s) ${names} are disabled until the user approves your plan. Do NOT retry them now.\n` +
                                `First deliver a concrete plan with present_result(kind:"markdown") — sections: ## ゴール / ## 変更対象ファイル / ## アプローチ / ## リスク・確認事項 / ## テスト方法 — then call ask_user(question:"この計画で実装を進めてよろしいですか？修正があれば教えてください。", context:<one-line gist>, options:["はい、実装して","修正したい"], multi_select:false) and STOP. Edits are unblocked once the user approves (your next turn).`
                        });
                        continue;
                    }
                }

                // ── Standards-aligned (native) history bookkeeping ────────────
                // In a native session every tool call gets a provider id (or a
                // synthesized one), kept in an IDENTITY map so loop-detection
                // signatures (which stringify the call objects) stay unaffected.
                // The ids correlate the assistant.tool_calls entry with its
                // role:"tool" result message — the OpenAI/Anthropic/Gemini wire
                // contract. JSON-mode sessions keep the text protocol untouched.
                const nativeHistory = llmService.supportsNativeTools?.() === true;
                const nativeIds = genResult?.nativeTurn?.ids || null;
                const callIdOf = new Map();
                if (nativeHistory) {
                    toolCall.tool_calls.forEach((c, i) => {
                        callIdOf.set(c, (nativeIds && nativeIds[i]) || `call_syn_${iteration}_${i}`);
                    });
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
                    results.push({ tool_call_name: call.name, result: errorMsg, id: callIdOf.get(call) });
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
                        this._trackReadEfficiency(call, result, isError);
                        if (onLog) this._logToolTelemetry(onLog, iteration, call, result, duration, isError);
                        results.push({ tool_call_name: call.name, result, id: callIdOf.get(call) });
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

                    this._trackReadEfficiency(call, result, isError);
                    if (onLog) this._logToolTelemetry(onLog, iteration, call, result, toolDuration, isError);
                    results.push({ tool_call_name: call.name, result, id: callIdOf.get(call) });

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
                } else {
                    consecutiveErrorCount = 0;
                }

                // Recovery hints by error type → ./agent/RecoveryHints.js (unit-tested).
                let recoveryHint = hasErrors ? buildRecoveryHint(results) : '';

                if (consecutiveErrorCount >= 3) {
                    recoveryHint += `\n[Critical Warning] Encountered ${consecutiveErrorCount} consecutive errors. Re-evaluate your approach or report status to the user.`;
                }

                // (Post-edit verify reminder removed — the system prompt's
                // "verify after edit" rule covers it; a per-step injected reminder
                // was redundant noise. Errors still surface via recoveryHint below.)

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

                // If ask_user was just executed, the agent is BLOCKED on user input:
                // pause the run cleanly and return the question. This is the proper
                // exit for tasks that genuinely need clarification — without it the
                // model can only reply text-only (which we push back on) and grinds
                // until a safety limit. The user's reply arrives as the next turn's
                // prompt (chatContext carries this question forward).
                if (this.toolExecutor.isAwaitingUser && this.toolExecutor.isAwaitingUser()) {
                    const question = this.toolExecutor.getUserQuestion();
                    // Prefer the model's own richer phrasing (its `thought`) when present,
                    // otherwise fall back to the structured question from the tool args.
                    let richThought = '';
                    if (toolCall?.thought) {
                        richThought = typeof toolCall.thought === 'string'
                            ? toolCall.thought
                            : (toolCall.thought.current_task || '');
                    }
                    richThought = this._cleanFinalResponse(richThought || '').trim();
                    finalResponse = (richThought.length >= 40) ? richThought : (question || richThought || response);
                    // Surface the ACTUAL question in the status event so the UI can show
                    // a clear "answer this" prompt (not a generic "paused" line). The
                    // reply is sent as the next turn to resume the run.
                    const askMsg = (question && question.trim())
                        ? `❓ ${question.trim()}`
                        : '❓ ユーザーの回答待ち（確認のため一時停止）';
                    // Pass any multiple-choice options through so the UI can render
                    // clickable buttons / checkboxes instead of a free-text box.
                    const askOptions = this.toolExecutor.getUserQuestionOptions
                        ? this.toolExecutor.getUserQuestionOptions() : [];
                    const askMulti = this.toolExecutor.getUserQuestionMulti
                        ? this.toolExecutor.getUserQuestionMulti() : false;
                    onAgentStatus?.({
                        event: 'status', status: 'waiting', message: askMsg,
                        options: askOptions, multiSelect: askMulti
                    });
                    break;
                }

                // If finish_task was just executed, break immediately with its summary.
                // This avoids an extra LLM round-trip just to confirm termination.
                if (this.toolExecutor.isTaskCompleted && this.toolExecutor.isTaskCompleted()) {
                    // The DELIVERABLE is whatever substantive content the model
                    // produced. Agents place it in different spots: ideally via
                    // present_result (captured separately as _lastResultEnvelope),
                    // but often in finish_task's `summary` ARG (a full report), and
                    // sometimes only in the finishing `thought`. Pick the most
                    // substantial of {finish_task summary arg, cleaned thought} so a
                    // long report in finish_task's summary isn't lost behind a short
                    // "OBSERVE/PLAN/CALL" thought (the previous bug: the report was
                    // nowhere visible because the thought won the ≥40-char check).
                    let richThought = '';
                    if (toolCall?.thought) {
                        richThought = typeof toolCall.thought === 'string'
                            ? toolCall.thought
                            : (toolCall.thought.current_task || '');
                    }
                    // Strip the ReAct meta-preamble so a model that skipped
                    // present_result (e.g. MiMo: narrates "OBSERVE…PLAN…CALL:
                    // finish_task" instead of calling it) doesn't leak that
                    // meta-text as the deliverable. Real content placed after
                    // the preamble survives; a preamble-only thought collapses
                    // to '' → the no-deliverable report synthesis takes over.
                    richThought = stripReActPreamble(this._cleanFinalResponse(richThought || '')).trim();
                    const ftCall = toolCall.tool_calls.find(c => c.name === 'finish_task');
                    const ftSummaryArg = String(ftCall?.args?.summary || '').trim();

                    // ── Deliverable nudge (SOFT, one-time) ─────────────────────
                    // A common weak-model failure is finishing to ANNOUNCE completion
                    // ("I completed the analysis") without ever producing the thing
                    // the user asked for. If the run delivered no present_result,
                    // changed no files, and the finish summary/thought are both short
                    // (a meta-claim, not real content), nudge ONCE to deliver — then
                    // let the model decide. We never hard-block: if it ignores the
                    // nudge, the next finish_task goes straight through. This keeps the
                    // "trust the model" default while catching the empty-finish case.
                    const deliverableLen = Math.max(ftSummaryArg.length, richThought.length);
                    const hasDeliverable = !!this._lastResultEnvelope
                        || (this.toolExecutor.getModifiedFiles()?.length > 0)
                        || deliverableLen >= 400;
                    if (!hasDeliverable && !this._deliverableNudged) {
                        this._deliverableNudged = true;
                        this.toolExecutor.resetTaskCompleted?.();
                        onAgentStatus?.({ event: 'status', status: 'running', message: '📝 成果物が未提示 — 本文の出力を促しています' });
                        this._pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
                        // Native protocol: an assistant turn with tool_calls MUST be
                        // followed by its tool results before any other message.
                        if (callIdOf.size > 0) this._pushToolResultsTurn(history, results, true, null);
                        history.push({
                            role: 'user',
                            content: '[Deliverable Missing] You called finish_task but produced no deliverable: no present_result, no file changes, and only a brief "what I did" note. If the user asked for actual content (a report / analysis / answer / proposal), output the FULL content NOW — call present_result (kind:"markdown") with the complete text, or put the complete text in finish_task\'s summary. If the task genuinely needed no textual deliverable, just call finish_task again and it will complete.'
                        });
                        continue;
                    }

                    // ── Step-1 sub-agent review gate (config: subagent_review) ──
                    // ONE independent review of this run's file changes before the
                    // finish is accepted. The reviewer is an isolated read-only
                    // sub-agent; only [CRITERIA-VIOLATION]/[BUG] findings bounce the
                    // task back — [STYLE] never blocks. Single round (per design:
                    // bounded loops; the parent, not the reviewer, is the arbiter).
                    // Skip the gate for a WEAK model — one the user put in JSON tool
                    // mode because its native tool-calling misbehaves. A reviewer
                    // sub-agent on such a model burns its iterations on malformed
                    // calls and usually returns no VERDICT anyway (→ "unknown" →
                    // pass), so the review is pure cost + noise. supportsNativeTools()
                    // reflects the JSON-mode opt-out list.
                    const modelReliableForReview = llmService.supportsNativeTools?.() !== false;
                    if (!this._isSubagent && !this._reviewDone && safety.subagentReview === 'on'
                        && modelReliableForReview
                        && (this.toolExecutor.getModifiedFiles()?.length > 0)) {
                        this._reviewDone = true;
                        onAgentStatus?.({ event: 'status', status: 'running', message: '🔎 独立レビューを実行中… / Independent sub-agent review…' });
                        const reviewBrief = buildReviewBrief({
                            goal: prompt,
                            summary: ftSummaryArg || richThought,
                            files: this.toolExecutor.getModifiedFiles().map(f => f.path),
                        });
                        const reportText = await this._runSubtask(
                            { role: 'reviewer', brief: reviewBrief },
                            { workspacePath, onAgentStatus, onConfirm, onLog, abortSignal, safety }
                        );
                        const { verdict, findings, reason } = parseReviewVerdict(String(reportText || ''));
                        if (verdict === 'fail') {
                            this.toolExecutor.resetTaskCompleted?.();
                            onAgentStatus?.({ event: 'status', status: 'running', message: '🔎 レビュー指摘あり — 修正のため差し戻し / Review FAIL — sent back for fixes' });
                            this._pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
                            if (callIdOf.size > 0) this._pushToolResultsTurn(history, results, true, null);
                            history.push({
                                role: 'user',
                                content: `[Sub-agent Review — FAIL] An independent reviewer inspected your changes and found blocking issues. Fix ONLY the [CRITERIA-VIOLATION] and [BUG] findings below ([STYLE] items are informational — do not act on them), verify, then call finish_task again.\n\n${clipText(findings, 6000)}`
                            });
                            continue;
                        }
                        // verdict is now 'pass' for any substantive report with no
                        // blocking findings (parseReviewVerdict tiers) — 'unknown'
                        // only survives for an empty/garbage reviewer report.
                        const passMsg = reason === 'explicit-verdict' || reason === 'standalone-token'
                            ? '🔎 レビューPASS ✅'
                            : '🔎 レビューPASS ✅（VERDICT明記なし — 指摘なしと判定）';
                        onAgentStatus?.({ event: 'status', status: 'running', message: verdict === 'pass' ? passMsg : '🔎 レビュー結果を取得できず（空レポート）— 完了を続行' });
                        if (onLog) { try { onLog({ method: 'REVIEW', status: 200, stepLabel: '🔎 Review Verdict', response: { verdict, reason, findings: String(findings).slice(0, 2000) } }); } catch (_) {} }
                    } else if (!this._isSubagent && !this._reviewDone && safety.subagentReview === 'on'
                        && !modelReliableForReview && (this.toolExecutor.getModifiedFiles()?.length > 0)) {
                        // Review is ON and there ARE changes, but the model is in
                        // JSON-tool (weak) mode → skip with a one-line note so it's
                        // clear WHY no review ran.
                        this._reviewDone = true;
                        onAgentStatus?.({ event: 'status', status: 'running', message: 'ℹ レビューをスキップ（このモデルはJSONツールモード）/ Review skipped — model in JSON-tool mode' });
                    }

                    // Longest substantive candidate wins (reports are long; the
                    // OBSERVE/PLAN/CALL thought is short meta-text).
                    finalResponse = [ftSummaryArg, richThought]
                        .filter(Boolean)
                        .sort((a, b) => b.length - a.length)[0]
                        || stripReActPreamble(this._cleanFinalResponse(response || '')).trim();
                    onAgentStatus?.({ event: 'status', status: 'completed', message: 'Task finished. ✅' });
                    break;
                }

                // Reset text-only counter: we just made at least one tool call.
                textOnlyCount = 0;

                this._pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
                this._pushToolResultsTurn(history, results, callIdOf.size > 0,
                    `${recoveryHint}\n\nConsider what these results tell you, then make your next tool call — or call finish_task if the user's goal is fully achieved.`);
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

        // 📊 Continuous efficiency measurement (step-reduction regression watch).
        this._emitEfficiencyReport(onLog, iteration);

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

        // ── Result "answer" priority: DELIVERABLE first ──────────────────
        // The headline must be the agent's actual deliverable when it produced
        // one — i.e. a report/answer delivered via present_result, or a
        // substantial finalResponse (e.g. the report it put in finish_task's
        // summary). Only when there's NO real prose deliverable (e.g. a pure
        // code-edit task whose finalResponse is just "done") do we synthesize the
        // 依頼/実施/結果 process report via the LLM. This fixes the case where a
        // produced report was buried because the process-summary overrode it —
        // AND skips the extra LLM call when a deliverable already exists.
        const presented = String(meta.presentedAnswer || '').trim();
        const fr = String(finalResponse || '').trim();
        const deliverable = presented || (fr.length >= 80 ? fr : '');

        let answer, summary;
        if (deliverable) {
            answer = deliverable;
            summary = deliverable;
        } else {
            const deterministic = this._composeDetailedReport(finalResponse, files, meta);
            const llmReport = await this._generateLlmReport(finalResponse, files, meta, onLog);
            answer = llmReport || fr || deterministic;
            summary = llmReport || deterministic;
        }
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
     * Generate a concise LLM completion report (依頼内容 / 実施内容 / 結果) from the
     * run's artifacts. Best-effort: returns '' on any failure so callers fall back
     * to deterministic text. One cheap LLM call, inputs clipped to bound cost.
     */
    async _generateLlmReport(finalResponse, files = [], meta = {}, onLog = null) {
        const { prompt = '', approvedPlan = '', toolCounts = {}, presentedAnswer = '' } = meta;
        try {
            const toolList = Object.entries(toolCounts || {}).map(([n, c]) => `${n}×${c}`).join(', ') || 'なし';
            const fileList = (files || []).map(f => `- ${f.path} (${f.action})`).join('\n') || 'なし';
            const sys = 'You are a precise technical writer. Write a concise task completion report in the SAME LANGUAGE as the user request. Use short Markdown (## headings + bullet points). Be factual, no filler, no code fences wrapping the whole report.';
            const reportPrompt =
`Write a brief completion report for this AI task, with exactly these three sections:
## 依頼内容
## 実施内容
## 結果

Rules: same language as the request; concise; in 実施内容 state concretely what was done (tools/steps); in 結果 state the deliverable/outcome and explicitly list any missing data or required follow-ups.

[User Request]
${String(prompt).slice(0, 1500)}

[Approved Plan]
${String(approvedPlan).slice(0, 1000) || '（なし）'}

[Tools used]
${toolList}

[Files created/modified]
${fileList}

[Agent's delivered answer (present_result)]
${String(presentedAnswer || '').slice(0, 2000) || '（なし）'}

[Agent's final message]
${String(finalResponse || '').slice(0, 2000)}`;
            let raw = '';
            const t0 = Date.now();
            const gen = await llmService.generate(reportPrompt, sys, (c) => { raw += c; });
            if (onLog) {
                try {
                    onLog({
                        method: 'CHAT', status: 200, duration: Date.now() - t0,
                        stepLabel: '📋 Result Report',
                        usage: gen?.usage,
                        request: { purpose: 'result-report', system_prompt: sys, prompt: reportPrompt },
                        response: raw,
                    });
                } catch (_) { /* logging only */ }
            }
            const report = String(raw || gen?.content || '').trim();
            return report.length >= 20 ? report : '';
        } catch (e) {
            console.warn('AgentController: LLM report generation failed:', e);
            return '';
        }
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
        // Use the single source-of-truth from LLMService, evaluated for the model
        // we ACTUALLY send (tier/override), not the label in currentModel.
        // ContextBuilder has already built systemPrompt using the same effective
        // model, so the protocol section in the prompt matches the API call here.
        const effectiveModel = this._modelOverride || llmService.getCurrentModel();
        const useNativeTools = llmService.supportsNativeTools(effectiveModel) && typeof llmService.chatWithTools === 'function';

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

            // systemPrompt already contains the native-mode protocol (built by
            // ContextBuilder). Do NOT append more instructions here — that would
            // duplicate the protocol and confuse the model.

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
                        // The model emitted its tool call as TEXT in a non-native
                        // dialect (e.g. <function=X><parameter=Y>, common with
                        // DeepSeek/MiMo). Recover it right here instead of dumping the
                        // turn to a fresh JSON-mode round-trip (which often repeats the
                        // same text form and loses the payload → empty present_result).
                        if (txt && txt.includes('<function=')) {
                            const recovered = this._extractToolCall(txt);
                            if (recovered && recovered.tool_calls && recovered.tool_calls.length > 0) {
                                // Synthesize call ids so this recovered turn can still be
                                // written to history in native format (id-correlated).
                                const nativeTurn = {
                                    text: typeof recovered.thought === 'string' ? recovered.thought : '',
                                    ids: recovered.tool_calls.map((_, i) => `call_rec_${Date.now()}_${i}`),
                                };
                                return { content: JSON.stringify(recovered), usage: result.usage, sentRequest: result.sentRequest, nativeTurn };
                            }
                        }
                        const looksLikeToolTextCall = /\bCALL:\s*\w/i.test(txt) ||
                            /<function=|<tool_call>/.test(txt) ||
                            this.toolExecutor.toolDefinitions?.some(td => new RegExp(`\\b${td.name}\\b`).test(txt) && /PLAN:/i.test(txt));
                        if (!txt || looksLikeToolTextCall) {
                            nativeFailed = true;
                            break;
                        }
                        // Plain text with no tool-invocation attempt → accept as final response text
                    }

                    if (result && result.toolCalls && result.toolCalls.length > 0) {
                        // Format tool calls DEFENSIVELY — provider stream assembly can
                        // yield imperfect entries:
                        //   • entry without `function` (or name at top level)  → tolerate/drop
                        //   • arguments as EMPTY string (deltas lost / no-arg call) → {}
                        //     (the tool itself then returns a proper "missing param"
                        //     error the model can react to — far cheaper than dumping
                        //     the whole turn to JSON-mode fallback)
                        // Genuinely malformed JSON still raises SyntaxError → the
                        // self-correction retry below.
                        const toolCallsFormatted = result.toolCalls
                            .filter(tc => tc && (tc.function?.name || tc.name))
                            .map(tc => {
                                const fn = tc.function || tc;   // some providers flatten name/arguments
                                let args = fn.arguments ?? fn.args ?? {};
                                if (typeof args === 'string') {
                                    const s = args.trim();
                                    if (s === '') {
                                        args = {};
                                    } else {
                                        try {
                                            args = this._safeParseJSON(s);
                                        } catch (parseErr) {
                                            throw new SyntaxError(`JSON parsing failed for tool '${fn.name}': ${parseErr.message}`);
                                        }
                                    }
                                }
                                return {
                                    name: fn.name,
                                    args: args
                                };
                            });
                        // Every entry was malformed → treat as a native failure and
                        // fall back to JSON mode rather than proceeding with nothing.
                        if (toolCallsFormatted.length === 0) {
                            nativeFailed = true;
                            break;
                        }
                        
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

                        // nativeTurn: what run() needs to write STANDARDS-ALIGNED
                        // history — the assistant's prose + each call's provider id
                        // (kept parallel to toolCallsFormatted; synthesized when the
                        // provider didn't stream one, e.g. Gemini).
                        const nativeTurn = {
                            text: thought,
                            ids: result.toolCalls
                                .filter(tc => tc && (tc.function?.name || tc.name))
                                .map((tc, i) => tc.id || `call_syn_${Date.now()}_${i}`),
                        };
                        return { content, usage: result.usage, sentRequest: result.sentRequest, nativeTurn };
                    }

                    return { content: result.content || '', usage: result.usage, sentRequest: result.sentRequest };
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

    /**
     * A short, human-readable hint of what a tool call is acting on — the command
     * for run_command, the file basename for file tools, the query for searches.
     * Used to make progress lines (esp. sub-agent activity) describe the actual
     * work instead of just repeating a bare tool name. Returns '' when there's
     * nothing concise to show.
     */
    _toolArgHint(name, args) {
        try {
            const a = args || {};
            const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            switch (name) {
                case 'run_command':
                    return String(a.command || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                case 'read_file':
                case 'write_file':
                case 'replace_lines':
                case 'multi_replace_file_content':
                case 'delete_file':
                case 'verify_syntax':
                case 'create_artifact':
                    return base(a.path);
                case 'move_file':
                    return base(a.to || a.from);
                case 'grep_search':
                    return String(a.query || '').slice(0, 40);
                case 'list_files':
                case 'glob':
                    return String(a.path || a.pattern || '').slice(0, 40);
                case 'web_search':
                    return String(a.query || '').slice(0, 40);
                case 'run_subtask':
                    return String(a.role || 'generic');
                default:
                    return '';
            }
        } catch (_) { return ''; }
    }

    /** Total character weight of a history array (cheap proxy for token size). */
    _historyChars(history) {
        if (!Array.isArray(history)) return 0;
        let n = 0;
        for (const m of history) {
            const c = m && m.content;
            n += typeof c === 'string' ? c.length : (c ? JSON.stringify(c).length : 0);
        }
        return n;
    }

    /**
     * Efficiency instrumentation — count read_file RE-READS (a file fetched more
     * than once), the dominant avoidable token sink on long tasks. First read of
     * a path is expected; every subsequent successful read on the same path is a
     * re-read whose bytes are (usually) redundant context. Measurement only.
     */
    _trackReadEfficiency(call, result, isError) {
        try {
            if (isError || !call || call.name !== 'read_file') return;
            const raw = call.args?.path ?? call.args?.file ?? '';
            if (!raw) return;
            const key = String(raw).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            const prev = this._readCounts.get(key) || 0;
            this._readCounts.set(key, prev + 1);
            if (prev >= 1) {
                this._efficiency.reReads++;
                this._efficiency.reReadChars += (typeof result === 'string' ? result.length : 0);
            }
        } catch (_) { /* instrumentation only */ }
    }

    /**
     * Build the end-of-run 📊 Efficiency Report (logged to onLog). Surfaces the
     * two measured token sinks so a regression in re-read suppression or history
     * compaction is caught by inspecting the per-task log, not guessed at.
     */
    _emitEfficiencyReport(onLog, iterations) {
        if (!onLog) return;
        try {
            const e = this._efficiency;
            const topReReads = [...this._readCounts.entries()]
                .filter(([, n]) => n > 1)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([path, n]) => ({ path, reads: n }));
            onLog({
                method: 'METRICS',
                status: 200,
                stepLabel: '📊 Efficiency Report',
                response: {
                    steps: iterations,
                    prompt_tokens: e.promptTokens,
                    completion_tokens: e.completionTokens,
                    distinct_files_read: this._readCounts.size,
                    re_reads: e.reReads,
                    re_read_chars_approx: e.reReadChars,
                    compressions: e.compressions,
                    compactions: e.compactions,
                    compaction_chars_saved: e.compactionCharsSaved,
                    top_re_read_files: topReReads,
                    hint: e.reReads > 3
                        ? 'Elevated re-reads — check that read_file "UNCHANGED" suppression + read-content preservation in compression are working.'
                        : 'Re-read volume nominal.',
                },
            });
        } catch (_) { /* logging only */ }
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

    /**
     * Write the assistant turn to history. NATIVE sessions get the standards-
     * aligned form — prose `content` + `tool_calls` array with ids (what the
     * model was RL-trained on; replaying turns as a JSON text envelope taught
     * weak models to answer in text). JSON-mode sessions keep the legacy text
     * envelope so that protocol stays self-consistent end to end.
     */
    _pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf) {
        if (!callIdOf || callIdOf.size === 0 || !toolCall?.tool_calls?.length) {
            history.push({ role: 'assistant', content: response });
            return;
        }
        const thought = genResult?.nativeTurn?.text
            || (typeof toolCall.thought === 'string' ? toolCall.thought : (toolCall.thought?.current_task || ''))
            || '';
        history.push({
            role: 'assistant',
            content: thought,
            tool_calls: toolCall.tool_calls.map((c, i) => ({
                id: callIdOf.get(c) || `call_syn_x_${i}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
        });
    }

    /**
     * Write this iteration's tool results. Native → one role:"tool" message per
     * call (id-correlated; Rust converts per provider) + an optional trailing
     * user note; JSON-mode → the legacy single "Tool Execution Results:" user
     * message (byte-identical to the previous format).
     */
    _pushToolResultsTurn(history, results, native, tailText) {
        if (native) {
            for (const r of results) {
                history.push({
                    role: 'tool',
                    tool_call_id: r.id || 'call_unknown',
                    name: r.tool_call_name,
                    content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''),
                });
            }
            const tail = (tailText || '').trim();
            if (tail) history.push({ role: 'user', content: tail });
        } else {
            history.push({
                role: 'user',
                content: `Tool Execution Results:\n${JSON.stringify(results, null, 2)}${tailText || ''}`,
            });
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

        // Pass 1: collect result GROUPS newest-first. A group is either the
        // legacy single "Tool Execution Results:" user message (JSON mode) or a
        // consecutive run of role:"tool" messages (native standards-aligned
        // history) — one group per agent iteration in both protocols.
        const groups = [];
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === 'user' && typeof m.content === 'string' &&
                m.content.startsWith('Tool Execution Results:')) {
                groups.push({ kind: 'text', idx: i });
            } else if (m.role === 'tool') {
                let start = i;
                while (start - 1 >= 0 && history[start - 1].role === 'tool') start--;
                groups.push({ kind: 'native', start, end: i });
                i = start;   // skip past the whole run
            }
        }
        // groups is newest-first; the first KEEP_RECENT_RESULTS are exempt.
        const toCompress = groups.slice(KEEP_RECENT_RESULTS);
        if (toCompress.length === 0) return;

        // ── Re-read suppression: preserve the latest read_file SNAPSHOT verbatim ──
        // Stripping old read_file results to "(Completed)" discards the file's
        // content, so once a read ages out of the 3-recent window the agent has
        // nothing to work from and RE-READS the whole file — the dominant token
        // sink on long single-file edits. Keep the most-recent sizable read_file
        // result (one file, within a char budget) so the current snapshot stays
        // available and re-reads become unnecessary.
        const SNAPSHOT_CHAR_BUDGET = 40000;
        let preserveIdx = -1;         // legacy text-group message to keep verbatim
        let preserveNativeIdx = -1;   // native role:"tool" read_file message to keep
        for (const g of groups) { // newest-first
            if (g.kind === 'text') {
                if (this._resultGroupHasReadContent(history[g.idx]?.content, SNAPSHOT_CHAR_BUDGET)) {
                    preserveIdx = g.idx;
                    break;
                }
            } else {
                let found = -1;
                for (let j = g.end; j >= g.start; j--) {
                    const m = history[j];
                    if (m.name === 'read_file' && typeof m.content === 'string' &&
                        !m.content.startsWith('Error') &&
                        m.content.length > 500 && m.content.length <= SNAPSHOT_CHAR_BUDGET) {
                        found = j;
                        break;
                    }
                }
                if (found !== -1) { preserveNativeIdx = found; break; }
            }
        }

        for (const g of toCompress) {
            // ── Native group: per role:"tool" message compression ─────────
            if (g.kind === 'native') {
                let hadNativeError = false;
                for (let j = g.start; j <= g.end; j++) {
                    if (j === preserveNativeIdx) continue;   // latest file snapshot stays
                    const m = history[j];
                    if (typeof m.content !== 'string') continue;
                    if (m.content.startsWith('Error')) {
                        hadNativeError = true;
                        if (m.content.length > ERROR_KEEP_CHARS) {
                            m.content = m.content.substring(0, ERROR_KEEP_CHARS) + '… [truncated]';
                        }
                    } else if (m.content.length > 200) {
                        m.content = '(Completed — result summarized to save context)';
                    }
                }
                // Scrub the failed call's args from the preceding assistant turn —
                // same rationale as the legacy path: huge typo-ridden old_text noise.
                if (hadNativeError && g.start > 0) {
                    const prev = history[g.start - 1];
                    if (prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
                        for (const tc of prev.tool_calls) {
                            if (tc?.function) {
                                tc.function.arguments = '{"_scrubbed":"prior call failed — args removed to keep context clean"}';
                            }
                        }
                    }
                }
                continue;
            }

            const i = g.idx;
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
        //
        // This is intentionally forceful: weaker models (e.g. MiMo) otherwise
        // narrate the answer as text / "CALL: present_result" and call
        // finish_task WITHOUT ever invoking present_result, so the app receives
        // nothing usable. Each rule below names a concrete failure mode.
        const extra = [];
        if (typeof intent.resultKind === 'string' && intent.resultKind.trim()) {
            const k = intent.resultKind.trim();
            extra.push(
                `## Delivering the result (MANDATORY)\n` +
                `The calling app receives your result ONLY through the present_result tool call. ` +
                `Plain text in your reply, a fenced code block in your message, or writing "CALL: present_result" ` +
                `do NOT deliver anything — that content is discarded and the user sees an empty result.\n` +
                `1. Call \`present_result\` with kind="${k}". Put the COMPLETE deliverable ` +
                `(full code / full answer, not a summary) in the \`markdown\` argument. ` +
                `The parameter is literally named \`markdown\` — do NOT use \`content\`, \`text\`, or \`md\`.\n` +
                `2. Call \`present_result\` FIRST, then call \`finish_task\` with a SHORT one-line summary. ` +
                `Never skip present_result. Never put the actual result only in finish_task's summary.\n` +
                `3. Your "OBSERVE / PLAN" reasoning is internal — it is NOT the result. ` +
                `Never let that meta-text stand in for the deliverable.`
            );
        }
        if (extra.length > 0) {
            b.extra_instructions = [b.extra_instructions, ...extra]
                .filter(s => typeof s === 'string' && s.trim())
                .join('\n\n');
        }
    }

    /**
     * run_subtask engine — spawn an ISOLATED child AgentController and return
     * only its final report (string) to the parent's tool result.
     *
     * Token-explosion guards (design doc): the child gets ONLY the brief (no
     * parent history), returns only a clipped report, defaults to the FAST
     * model tier, and is bounded by max-steps + parallel/per-run caps.
     * Consistency guards: children can't recurse, can't ask_user (persona +
     * status filtering), and role tool-allowlists are enforced in code.
     */
    async _runSubtask(args, { workspacePath, onAgentStatus, onConfirm, onLog, abortSignal, safety }) {
        const brief = String(args?.brief || '').trim();
        if (!brief) {
            return 'Error: run_subtask requires a non-empty "brief" STRING (self-contained: goal, scope files/dirs, acceptance criteria, expected report format). ' +
                'One run_subtask call = ONE sub-agent; to launch several in parallel, make MULTIPLE run_subtask calls in the same response. ' +
                'Example args: {"brief":"Goal: document module X.\\nScope: read src/x/**, write docs/x.md only.\\nCriteria: covers every exported function.\\nOutput: the doc file + a short report.","role":"generic","tools":null,"max_steps":null,"model":null,"write_scope":["docs/x.md"]}';
        }
        if (this._subtaskCount >= SUBTASK_MAX_PER_RUN) {
            return `Error: sub-task limit reached (${SUBTASK_MAX_PER_RUN} per run). Do the remaining work yourself.`;
        }
        this._subtaskCount++;

        const roleDef = resolveRole(args?.role);
        // Tool allowlist: explicit args.tools > role preset > all built-ins.
        // run_subtask itself is ALWAYS stripped (no recursion), as is ask_user
        // (a sub-agent has no human to wait on; the allowlist re-adds it
        // implicitly for termination tools, so also strip at definition level
        // via the persona instruction — belt and suspenders is not needed here
        // because setToolAllowlist force-includes ask_user; the persona forbids
        // its use and the parent treats a 'waiting' child as a finished report).
        let tools = (Array.isArray(args?.tools) && args.tools.length > 0)
            ? args.tools.slice()
            : (roleDef.tools ? roleDef.tools.slice()
                : this.toolExecutor.toolDefinitions.map(t => t.name));
        tools = tools.filter(n => n !== 'run_subtask');

        const maxSteps = Math.max(1, Math.min(SUBTASK_MAX_STEPS_CAP,
            Number(args?.max_steps) > 0 ? Number(args.max_steps) : roleDef.maxIterations));
        const tier = (args?.model === 'deep' || args?.model === 'fast') ? args.model : roleDef.tier;

        // ── Write scope + ownership claim (Step 3) ─────────────────────────
        // Effective scope: explicit args.write_scope > tester's test-file default
        // > null (whole workspace). A child WITH edit tools always registers a
        // claim (unscoped = claims everything); children whose claims overlap
        // are serialized below, so parallel edits can never touch the same files.
        const hasEditTools = tools.some(n => WRITE_ENFORCED_TOOLS.has(n));
        const writeScope = (Array.isArray(args?.write_scope) && args.write_scope.length > 0)
            ? args.write_scope.map(String)
            : (roleDef.id === 'tester' ? TESTER_WRITE_PATTERNS.slice() : null);
        const claim = hasEditTools ? (writeScope || ['**']) : null;

        const label = `sub:${roleDef.id}#${this._subtaskCount}`;
        onAgentStatus?.({ event: 'status', status: 'running', message: `🤖 [${label}] 起動: ${brief.slice(0, 100).replace(/\s+/g, ' ')}…` });

        // Parallelism cap + write-ownership wait — cheap polling semaphore
        // (parallel calls arrive via Promise.all from the tool-execution step).
        // Overlapping write claims SERIALIZE: the child waits for the conflicting
        // sibling to finish instead of failing (children are step-capped, so the
        // wait always resolves).
        let waitNotified = false;
        const claimConflicts = () => claim
            && [...this._writeClaims.values()].some(c => scopesOverlap(claim, c));
        while (this._subtaskActive >= SUBTASK_MAX_PARALLEL || claimConflicts()) {
            if (abortSignal?.aborted) return 'Error: task aborted.';
            if (!waitNotified && claimConflicts()) {
                waitNotified = true;
                onAgentStatus?.({ event: 'status', status: 'running', message: `🤖 [${label}] ⏳ 書き込み範囲が他のサブタスクと重複 — 先行の完了を待機 (serialized)` });
            }
            await new Promise(r => setTimeout(r, 250));
        }
        this._subtaskActive++;
        if (claim) this._writeClaims.set(label, claim);

        // Budget slice: when the parent runs under a token budget, each child
        // gets a slice of it (childTokenBudget: 20%, floor 5000, capped by the
        // unspent remainder) — and child spend feeds back into the parent's cap
        // via _subtaskTokens. No parent budget → child inherits the global config.
        const budgetSlice = childTokenBudget(
            safety?.tokenBudget || 0,
            this._spentTokens + this._subtaskTokens
        );

        const child = new AgentController();
        child.caller = 'Subagent';
        child._isSubagent = true;
        child.behaviorOverrides = {
            enabled_tools: tools,
            max_iterations: maxSteps,
            extra_instructions: roleDef.persona
                + (writeScope
                    ? `\n\n## Write scope (ENFORCED)\nYou may only create/modify/delete files matching: ${writeScope.join(', ')}. Writes outside this scope are blocked by the system — do not attempt them.`
                    : ''),
            intent: { tier },                      // fast/deep model routing
            ...(budgetSlice > 0 ? { token_budget: budgetSlice } : {}),
            ...(writeScope ? { write_scope: writeScope } : {}),
        };

        try {
            const result = await child.run(
                composeSubtaskPrompt(brief, roleDef),
                workspacePath,
                () => {},   // child stream chunks are not surfaced to the parent UI
                (payload) => {
                    if (!payload) return;
                    // Cost accounting: forward token_usage so the task totals
                    // include the child — but strip the context gauge fields so
                    // the header keeps showing the PARENT's context occupancy.
                    if (payload.event === 'token_usage') {
                        // Count child spend toward the parent's token budget.
                        this._subtaskTokens += (payload.prompt_tokens || 0) + (payload.completion_tokens || 0);
                        const { context_used, context_limit, ...usage } = payload;
                        onAgentStatus?.(usage);
                        return;
                    }
                    // Compact progress lines: which tool the child is running AND
                    // what it's acting on (command / file), so the feed shows the
                    // actual work — e.g. "⚙ run_command: cargo build" — instead of
                    // a bare tool name repeated for every step.
                    if (payload.event === 'tool_call') {
                        const hint = this._toolArgHint(payload.name, payload.args);
                        onAgentStatus?.({ event: 'status', status: 'running', message: `🤖 [${label}] ⚙ ${payload.name}${hint ? ': ' + hint : ''}` });
                    }
                },
                onConfirm,      // approvals (e.g. non-safe commands) still reach the user
                null, [],       // context isolation: no clientContext, no chatContext
                onLog ? (entry) => onLog({ ...entry, stepLabel: `🤖[${label}] ${entry?.stepLabel || ''}` }) : null,
                abortSignal,
                '', []
            );
            const report = clipText(String(result?.response || '').trim() || '(the sub-agent produced no report)', SUBTASK_REPORT_MAX_CHARS);
            const files = (result?.modifiedFiles || []).map(f => f.path);
            // Merge child edits into the parent's session record so the Result
            // view's file list / review gate cover sub-agent changes too.
            for (const f of (result?.modifiedFiles || [])) {
                try { this.toolExecutor._recordModification?.(f.path, f.original, f.current); } catch (_) {}
            }
            onAgentStatus?.({ event: 'status', status: 'running', message: `🤖 [${label}] 完了 ✅` });
            return `[Sub-agent report — role: ${roleDef.id}]\n${report}` +
                (files.length ? `\n\nFiles modified by the sub-agent:\n${files.map(p => '- ' + p).join('\n')}` : '');
        } catch (e) {
            onAgentStatus?.({ event: 'status', status: 'running', message: `🤖 [${label}] 失敗: ${e?.message || e}` });
            return `Error: sub-task (${roleDef.id}) failed: ${e?.message || e}`;
        } finally {
            this._subtaskActive--;
            this._writeClaims.delete(label);   // release the write-ownership claim
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
