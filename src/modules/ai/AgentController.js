import { planApprovalQuestion, isPlanRevision } from './agent/PlanFirstApproval.js';
import llmService from './LLMService.js';
import { skillManager } from './SkillManager.js';
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
import { CompressionMetrics, fetchKey, factRetention } from './agent/CompressionMetrics.js';
import { intentRegistry, resolveIntent } from './agent/IntentRegistry.js';
import { normalizeSafetyLimits, resolveRecallArm } from './agent/SafetyLimits.js';
// One definition of "is this multi-step change work" — see _looksComplex below
// for why a second, laxer copy used to live in this file.
import { looksComplex } from './agent/TaskComplexity.js';
// The run's mutable counters, named so the phases below can take one argument
// instead of closing over twenty free variables — see agent/RunState.js.
import { RunState } from './agent/RunState.js';
// The run's own narration. It was hard-coded Japanese, which made the agent's
// live status the largest untranslatable surface in the app: switching the UI to
// English relabelled the buttons and left every "why did it do that" in Japanese.
// Each call passes the original literal as its fallback, so a missing key prints
// what it always printed rather than a key name.
import { t } from '../../i18n/index.js';
import { initialPhase, advancePhase, modelForPhase, phaseLabel, PLAN_PHASE_MAX_STEPS } from './agent/ModelPhaseRouter.js';
import {
    isInvestigation, evidenceCheck, frontierCheck, buildAuditBrief,
} from './agent/InvestigationGate.js';
import { renderQuestions } from './agent/OpenQuestions.js';
import { buildRecoveryHint } from './agent/RecoveryHints.js';
import {
    resolveRole, composeSubtaskPrompt, buildReviewBrief, parseReviewVerdict, clipText, childTokenBudget,
    scopesOverlap, WRITE_ENFORCED_TOOLS, TESTER_WRITE_PATTERNS,
    SUBTASK_MAX_PARALLEL, SUBTASK_MAX_PER_RUN, SUBTASK_REPORT_MAX_CHARS, SUBTASK_MAX_STEPS_CAP,
    summarizeReview
} from './agent/SubagentRoles.js';
import { stopReason, stopNotice, stopStatusMessage } from './agent/stopReason.js';
// P3 monolith split: pure prompt/history assembly, safety guards, tool
// dispatch and LLM-turn formatting live in their own modules; this file
// keeps the run loop, state and orchestration.
import {
    applyDescriptions, envelopeHasContent, toolArgHint,
    historyChars, historyText, droppedContentHashes,
    pushAssistantToolTurn, pushToolResultsTurn, compressToolResultsInHistory,
} from './agent/PromptAssembler.js';
import {
    classifyToolCalls, planFirstGate,
    isPlanGatedTool, evaluateWallClock, evaluateTokenBudget,
    evaluateIdenticalCalls, hasIdenticalTail, findCycle, isNoProgressWindow,
    iterationMadeProgress, phaseSignalForToolCalls,
    noProgressCheckMessage, identicalCallWarning, tailLoopWarning, cycleWarning,
} from './agent/SafetyGuards.js';
import { executeOneCall, countToolUsage, isErrorResult, summarizeForStatus, routeProducedImages } from './agent/ToolDispatch.js';
import { formatNativeToolCalls, looksLikeToolTextCall, stripThoughtWrapper } from './agent/LLMTurn.js';
// P5: parallel tool-call conflict detection — two calls mutating the same file
// must not race inside Promise.all; the loop serializes the flagged ones.
import { partitionParallelCalls, serializationNotice } from './agent/ConflictDetector.js';
// Step 0 of the memory plan: record what each tool call did, with a normalized
// failure signature. Recording only — nothing here changes what the agent does.
import { TraceRecorder } from './memory/TraceRecorder.js';
// Step 1: lessons (what went wrong) and insights (what worked / where things
// are), minted from the trace and recalled at the moment they apply.
import { CardStore, renderBrief, renderCard, cardSummary, summarizeMinted, INJECTION_VARIANT } from './memory/CardStore.js';
import { targetOf } from './memory/FailureSignature.js';
import { sessionMetrics, appendSessionMetrics, EDIT_TOOLS } from './memory/SessionMetrics.js';

/** Step 4b: dependants listed after an edit. Bounded — a 40-name list is not read. */
const IMPACT_MAX_FILES = 8;

// Tools blocked by the Plan-First gate until the user approves the plan —
// anything that mutates the workspace or runs shell commands. Investigation
// tools (read_file / grep_search / glob / list_files), present_result, ask_user
// and finish_task are intentionally NOT gated: the agent needs them to build and
// deliver the plan and to pause for approval.
/**
 * How much prose counts as "the agent actually delivered something".
 *
 * This used to be 80 here and 400 in the deliverable nudge, so a run could be
 * judged to HAVE a deliverable by one and NOT have one by the other. One number,
 * used by both.
 */
const DELIVERABLE_MIN_CHARS = 400;

// NOTE: applyDescriptions / PLAN_GATED_TOOLS / envelopeHasContent / MUTATING_TOOLS
// now live in agent/PromptAssembler.js + agent/SafetyGuards.js (P3 split) and
// are imported at the top of this file.

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
        // Images tools produced, waiting to ride on the next LLM request.
        this._pendingToolImages = [];
    }

    addSteeringMessage(msg) {
        this.steeringQueue.push(msg);
    }

    /**
     * Run one agent task to completion.
     *
     * Three phases. `_prepareRun` resolves everything the loop needs and must not
     * be reordered into it: it re-reads the LLM connection, decides the plan-first
     * gate, the model tier and the tool allowlist, and loads memory — all of which
     * the first iteration already depends on. The loop is the state machine
     * documented in `_prepareRun`. `_finishRun` turns whatever the loop left behind
     * into the caller's result.
     *
     * The signature stays positional because TaskBridge, ChatView, the schedule
     * runner and _runSubtask all call it, and an options object would be a change
     * to every one of them for no behavioural gain.
     */
    async run(prompt, workspacePath, onUpdate, onAgentStatus, onConfirm, clientContext = null, chatContext = [], onLog = null, abortSignal = null, kisContext = '', images = []) {
        const prep = await this._prepareRun({
            prompt, workspacePath, onAgentStatus, chatContext, kisContext, images,
        });
        const st = prep.state;
        const safety = prep.safety;
        const isExternalCaller = prep.isExternalCaller;
        const tierModels = prep.tierModels;
        const isFreshTurn = prep.isFreshTurn;
        const IMAGE_ATTACH_MAX_STEPS = prep.IMAGE_ATTACH_MAX_STEPS;
        kisContext = prep.kisContext;

        // ── Run-scoped facts live on `st`; the loop's own counters do not ──
        //
        // `st` (agent/RunState.js) owns what CROSSES a phase boundary — the step
        // ceiling, the start time, the conversation — and supplies the loop's
        // derived predicates. The counters below stay local on purpose: they are
        // read and written on nearly every line of the loop, and moving 200-odd
        // references onto `st.` buys nothing until the loop body itself is
        // extracted into `_stepOnce(st)`. Doing the rename first would be a large
        // diff through the agent's core loop for no change in what anyone can
        // read or test. That extraction is the remaining step; this is the
        // groundwork it needs, not a half-finished version of it.
        const isUnlimited = st.isUnlimited;
        const taskStartMs = st.startedAt;
        let history = st.history;
        let iteration = 0;
        let finalResponse = '';
        let lastToolCallSignature = '';
        let repeatCount = 0;
        let jsonParseRetryCount = 0;
        let consecutiveErrorCount = 0;
        let textOnlyCount = 0;
        let toolCallHistory = [];
        let usedToolTypes = new Set();
        const toolUsageCounts = {};
        let cumulativeTokens = 0;
        let tokenBudgetWarned = false;
        let wallClockWarned = false;
        let stoppedBy = null;
        let identicalWarned = false;
        let cycleWarned = false;
        let noProgressWarned = false;
        const progressHistory = [];

        while (st.hasStepsLeft()) {
            if (abortSignal?.aborted) {
                onAgentStatus?.({ event: 'status', status: 'aborted', message: 'Process aborted by user.' });
                break;
            }

            // The step counter lives on `st` because the loop condition
            // (`st.hasStepsLeft()`) reads it; `iteration` mirrors it for the
            // ~40 places in the body that report or record the step number.
            iteration = st.nextIteration();

            // Unlimited runs have no real ratio, so RunState.progress() gives a
            // soft asymptotic curve that creeps forward without ever claiming
            // completion — 0.5 at step 50, ~0.8 at 200.
            const progress = st.progress();
            onAgentStatus?.({ event: 'status', status: 'running', progress, message: `Thinking... (step ${iteration})` });

            // ── Wall-clock budget enforcement ──────────────────────────
            // Hard stop at 100% of budget. Soft reminder once at 80%.
            {
                const elapsedMs = st.elapsedMs();
                const wallClock = evaluateWallClock({
                    elapsedMs,
                    budgetMinutes: safety.wallClockMinutes,
                    pctWarned: wallClockWarned,
                });
                if (wallClock.stop) {
                    stoppedBy = stopReason('wall_clock', { limit: safety.wallClockMinutes });
                    onAgentStatus?.({ event: 'status', status: 'running', message: stopStatusMessage(stoppedBy) });
                    finalResponse = (finalResponse || '') + stopNotice(stoppedBy);
                    break;
                }
                if (wallClock.warn) {
                    wallClockWarned = true;
                    history.push({
                        role: 'user',
                        content: `[System Notice] You've been running for ${Math.round(elapsedMs / 60000)} minutes — 80% of the ${safety.wallClockMinutes}-minute budget. Please wrap up: call \`finish_task\` if the goal is achieved, or summarize progress and report blockers to the user.`
                    });
                }
            }

            // ── Phase routing: the plan phase releases the deep model on its
            //    step cap (ModelPhaseRouter.PLAN_PHASE_MAX_STEPS) ──
            this._phaseEvent('step', {
                iteration,
                planFirstPending: this._planFirstActive && !this._planApproved,
            }, onAgentStatus);

            // ── Auto-escalate fast→deep tier for long-running tasks ──
            //
            // Under phase routing this is not a one-way pin to deep: it records
            // that the cheap tier is struggling on THIS run, which promotes the
            // EXECUTE phase only. Plan and review are deep already, and the run
            // must still be able to fall back to fast if it re-enters execute —
            // otherwise one long task silently spends the rest of itself on the
            // expensive model, which is the cost leak this feature exists to close.
            if (this._phaseRouting) {
                if (this._escalateAtStep > 0 && !this._phaseEscalated && iteration >= this._escalateAtStep) {
                    this._phaseEscalated = true;
                    onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.escalate.phase', { step: iteration }, `🧠 実装フェーズを上位モデル(deep)に昇格 — step ${iteration} 到達`) });
                    this._phaseEvent('step', { iteration }, onAgentStatus);
                }
            } else if (this._escalateAtStep > 0 && this._deepModelId && this._modelOverride !== this._deepModelId
                && iteration >= this._escalateAtStep) {
                this._modelOverride = this._deepModelId;
                onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.escalate.tier', { step: iteration }, `🧠 上位モデル(deep)に切替 — step ${iteration} 到達`) });
            }

            // ── Token budget enforcement (cumulativeTokens updated below per LLM call) ──
            // Sub-agent consumption (_subtaskTokens) counts toward the same cap —
            // delegation must not be a budget bypass.
            {
                const spent = cumulativeTokens + this._subtaskTokens;
                const budget = evaluateTokenBudget({
                    spent,
                    budgetTokens: safety.tokenBudget,
                    warned: tokenBudgetWarned,
                });
                if (budget.stop) {
                    stoppedBy = stopReason('token_budget', { limit: safety.tokenBudget, used: spent });
                    onAgentStatus?.({ event: 'status', status: 'running', message: stopStatusMessage(stoppedBy) });
                    finalResponse = (finalResponse || '') + stopNotice(stoppedBy);
                    break;
                }
                if (budget.warn) {
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
                
                history.push(steeringMsg);

                // Images ride the SAME channel as the run's own attachments —
                // `_pendingToolImages`, drained into the next call's `stepImages`.
                //
                // They used to be hand-built into the message as OpenAI-shaped
                // `image_url` parts, which (a) is the wrong wire shape for the
                // other providers and (b) skipped the vision check entirely, so on
                // a model that cannot read images the picture was dropped in
                // silence and the user was told nothing. Symptom reported: an
                // image attached to a follow-up, and the agent answering
                // "画像は確認できませんが…".
                if (allImages.length > 0) this._attachUserImages(allImages, onAgentStatus);
                
                // Emit a dedicated event so the UI can show a visible acknowledgment.
                const preview = steeringText.split('\n')[0].substring(0, 80);
                onAgentStatus?.({ event: 'steering_received', message: `📌 Steering received: "${preview}"` });
                onAgentStatus?.({ event: 'status', status: 'running', message: `📌 Steering applied: "${preview}"` });
            }

            // Opening brief: the highest-scoring lessons AND insights this
            // workspace has produced. Recall BEFORE acting is the whole point — a
            // memory consulted only after the mistake is a log, not a memory.
            // Deliberately outside the planning if/else below: it is orthogonal
            // to which planning mode the run is in.
            //
            // The SELECTION runs in both arms; only the injection is withheld in
            // the control arm. Without that, "did the agent follow the advice?"
            // has no baseline: a recipe like read_file → write_file is a common
            // ordering that happens anyway, so a bare 32% follow-through cannot
            // be told apart from the rate at which the agent would have done it
            // unprompted. Scoring the same cards against a run that never saw
            // them is what supplies the "anyway" number.
            if (iteration === 1) {
                const shadow = !this._recallOn;
                // The task prompt ranks WITHIN each kind's budget: an insight about
                // the area being worked on beats a higher-scoring one from an
                // unrelated corner of the project.
                const cards = this._cards?.recallBrief(prompt, undefined, { shadow }) || [];
                const brief = renderBrief(cards);
                if (brief) {
                    this._noteCardsShown(cards, iteration, brief, shadow);
                    if (!shadow) {
                        history.push({ role: 'user', content: brief });
                        this._emitRecall(onAgentStatus, cards, iteration, 'brief');
                        onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.memory.recalled', null, '🧠 過去セッションの学習を参照') });
                    }
                }
                const pb = await this._recallPlaybook(prompt, workspacePath);
                if (pb && !shadow) {
                    history.push({ role: 'user', content: pb });
                    this._memoryChars = (this._memoryChars || 0) + pb.length;
                    onAgentStatus?.({ event: 'status', status: 'running', message: `📘 ${pb.split('\n')[0]}` });
                }
            }

            // First-iteration planning injection.
            if (iteration === 1 && this._planFirstActive) {
                const pa = planApprovalQuestion();
                const revisionNote = (this._planRevisionText && this._planRevisionText.length > 0)
                    ? `\nThe user asked you to REVISE the plan. Their requested changes:\n${this._planRevisionText}\n` +
                      'Revise the plan to incorporate these changes and re-present it for approval. Do NOT edit any files yet.'
                    : '';
                // Plan-First: deliver a concrete plan + get approval BEFORE editing.
                history.push({
                    role: 'user',
                    content: '[Plan-First — approval required]\n' +
                        'This is a complex task. Editing files and running commands are BLOCKED by the system until the user approves your plan.\n' +
                        (this._planRevisionText
                            ? 'You previously presented a plan that the user wants revised. Incorporate their changes and re-present the revised plan.\n'
                            : '') +
                        'Do this now:\n' +
                        '1. Investigate as needed with READ-ONLY tools (read_file / grep_search / glob / list_files) to make the plan concrete and correct.\n' +
                        '2. Deliver the plan with `present_result(kind:"markdown", ...)` using EXACTLY these sections:\n' +
                        '   ## ゴール\n   ## 変更対象ファイル (list each file + what changes)\n   ## アプローチ\n   ## リスク・確認事項\n   ## テスト方法\n' +
                        '3. Then call `ask_user(question:' + JSON.stringify(pa.question) + ', context:<one-line plan gist>, options:' + JSON.stringify(pa.options) + ', multi_select:false)` and STOP.\n' +
                        revisionNote + '\n' +
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
                            this._compressionMetrics.noteCompression('compression');
                        }
                    } catch (_) {
                        // Estimation unavailable — fall back to always-compress so
                        // we never risk overflowing the context window.
                        this._compressToolResultsInHistory(history);
                        this._efficiency.compressions++;
                        this._compressionMetrics.noteCompression('compression');
                    }
                    const _histCharsBefore = this._historyChars(history);
                    const _histTextBefore = this._historyText(history);
                    let compactedHistory = await conversationMemory.compactHistory(history, currentModel, this.toolExecutor.getFileCache(), onLog);
                    const _histCharsAfter = this._historyChars(compactedHistory);
                    if (_histCharsAfter < _histCharsBefore) {
                        this._efficiency.compactions++;
                        this._efficiency.compactionCharsSaved += (_histCharsBefore - _histCharsAfter);
                        // Stage 3/4: tell the metrics WHAT was discarded (so a later
                        // re-fetch is confirmed rather than merely suspected) and how
                        // much concrete detail the summary preserved.
                        this._compressionMetrics.noteCompression(
                            'compaction',
                            _histCharsBefore - _histCharsAfter,
                            {
                                droppedHashes: this._droppedContentHashes(history, compactedHistory),
                                retention: factRetention(_histTextBefore, this._historyText(compactedHistory)),
                            },
                        );
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
                        systemPrompt = await contextBuilder.getSystemPrompt(workspacePath, this.toolExecutor, clientContext, editContext, kisContext, prompt, this._modelOverride || llmService.getCurrentModel(),
                            // An explicit tier wins over inference: a general-purpose
                            // task can say so even when it happens to hold editing tools.
                            this.behaviorOverrides?.persona_tier || null);
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
                    // Images a tool produced last step (an Office diagram, say) ride
                    // along ONCE. They are not subject to IMAGE_ATTACH_MAX_STEPS —
                    // that budget is about re-sending the user's own attachments,
                    // whereas these have never been shown.
                    const toolImages = this._pendingToolImages.splice(0);
                    const stepImages = [
                        ...((iteration <= IMAGE_ATTACH_MAX_STEPS) ? images : []),
                        ...toolImages.map(i => i.data),
                    ];
                    if (toolImages.length) {
                        onAgentStatus?.({ event: 'status', status: 'running', message: `🖼 ツール由来の画像 ${toolImages.length}枚をLLMに添付します（${toolImages.map(i => i.source).join(', ')}）。` });
                    }
                    genResult = await this._generateWithHistory(compactedHistory, systemPrompt, abortSignal, kisContext, stepImages, onUpdate, onAgentStatus);
                    
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
                        // Redacted in ai.rs and carried on the error, so a FAILED
                        // call can be inspected — that is exactly when the url and
                        // the auth scheme are what you need. The guesswork this
                        // replaces produced a hardcoded string per provider and
                        // never set the headers at all.
                        const url = err?.sentRequest?.url || undefined;
                        const headers = err?.sentRequest?.headers || undefined;

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
            this._recordPhaseTokens(genResult.usage);

            onAgentStatus?.({
                event: 'token_usage',
                // Which model actually produced these tokens. Recorded on the task
                // so cost can be priced with THAT model's rates instead of whatever
                // model happens to be active later (mixed-model history).
                model: this._modelOverride || llmService.getCurrentModel?.() || '',
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
                // The url and headers the request ACTUALLY went out with, redacted
                // in ai.rs where the credential lives.
                //
                // This used to GUESS them from the provider name — a hardcoded
                // string per provider, two of them ending in "..." — and never set
                // `headers` at all, which is why the modal's Headers tab could
                // never appear. A guessed URL is worse than none: it hides a
                // misconfigured base_url, which is the thing you open this panel
                // to find.
                const sent = genResult.sentRequest || null;
                const url = sent?.url || undefined;
                const headers = sent?.headers || undefined;

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
                        sent_request: genResult.sentRequest?.body ?? genResult.sentRequest ?? null,
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
                toolCall.tool_calls.forEach(tc => usedToolTypes.add(tc.name));
                countToolUsage(toolCall.tool_calls, toolUsageCounts);

                // (Removed legacy hack that silently bumped maxIterations to a
                // hardcoded 20 when ≥5 tool types were used — it overrode the user's
                // configured step cap. We now always honor the configured limit;
                // raise Settings → General → Max Steps if more headroom is needed.)

                // Two-stage escalation (thresholds in SafetyGuards.evaluateIdenticalCalls):
                //   stage 1 (warn): at `identicalCallThreshold` (default 5) → inject a system
                //                   message, reset the counter, let the LLM try again
                //   stage 2 (stop): at 3× the threshold (default 15) → genuine hard stop
                // The original behavior was a hard stop at literally 3 identical calls in a
                // row, which was too aggressive — many legitimate retry/poll patterns hit it
                // and the user had no way to override. Both thresholds are configurable
                // (Settings → General → Identical Call Threshold), and 0 disables both.
                const identical = evaluateIdenticalCalls({
                    signature: currentSignature,
                    lastSignature: lastToolCallSignature,
                    repeatCount,
                    warnAt: safety.identicalCallThreshold,
                });
                repeatCount = identical.repeatCount;
                if (identical.isRepeat) {
                    if (identical.warn && !identicalWarned) {
                        identicalWarned = true;
                        onAgentStatus?.({
                            event: 'status',
                            status: 'running',
                            message: `Same call repeated ×${repeatCount} — injecting hint.`
                        });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: identicalCallWarning(toolCall.tool_calls[0]?.name, repeatCount),
                        });
                        repeatCount = 0;
                        toolCallHistory = [];
                        continue;
                    }

                    if (identical.stop) {
                        onAgentStatus?.({ event: 'error', error: `Loop detected (${repeatCount}× identical calls, warning ignored). Stopping.` });
                        finalResponse = (finalResponse || '') +
                            `\n\n(注意: 同一ツール呼び出しを ${repeatCount} 回繰り返し、警告も無視されたため自動停止しました。Settings → General → Identical Call Threshold で調整できます。)`;
                        break;
                    }
                } else {
                    lastToolCallSignature = currentSignature;
                    identicalWarned = false; // reset so next streak can re-warn
                }

                // Phase 4: Pattern loop detection (5x identical tool+args)
                if (hasIdenticalTail(toolCallHistory, 5)) {
                    onAgentStatus?.({ event: 'status', status: 'running', message: "Pattern loop detected (identical tool call 5x). Injecting guidance." });
                    history.push({ role: 'assistant', content: response });
                    history.push({
                        role: 'user',
                        content: tailLoopWarning(toolCallHistory[toolCallHistory.length - 1]?.name),
                    });
                    toolCallHistory = [];
                    continue;
                }

                // ── Oscillation cycle detection (ABAB / ABCABC patterns) ──
                // Catches the case where the agent isn't repeating one call exactly
                // but is bouncing between 2–3 calls in a fixed cycle. Threshold
                // (number of full repeats before warning) is configurable via
                // Settings → General → Cycle Detection Min Repeats. 0 disables it.
                // `cycleWarned` guards against re-firing on every iteration in case
                // the LLM ignores the warning and keeps cycling — second escalation
                // happens via identical-call counter or no-progress detector instead.
                if (!cycleWarned) {
                    const cycle = findCycle(toolCallHistory, safety.cycleDetectionMinRepeats);
                    if (cycle) {
                        cycleWarned = true;
                        onAgentStatus?.({
                            event: 'status',
                            status: 'running',
                            message: `Cycle detected (${cycle.pattern} ×${cycle.repeats}). Injecting guidance.`
                        });
                        history.push({ role: 'assistant', content: response });
                        history.push({ role: 'user', content: cycleWarning(cycle) });
                        toolCallHistory = [];
                        continue;
                    }
                }

                // ── Plan-First gate: block edits/commands until the plan is
                //    approved. The agent must present a plan + ask_user first;
                //    read/investigation tools, present_result and ask_user pass.
                if (this._planFirstActive && !this._planApproved) {
                    // isPlanGatedTool lets READ-ONLY (safe-classified) shell commands
                    // run during planning — `dir` / `git status` / `git log` can't
                    // mutate the workspace, so investigation isn't blocked. Anything
                    // that writes/deletes (normal/dangerous) stays gated.
                    const gated = toolCall.tool_calls.filter(tc => isPlanGatedTool(tc.name, tc.args));
                    if (gated.length > 0) {
                        const names = [...new Set(gated.map(g => g.name))].join(', ');
                        const pa = planApprovalQuestion();
                        onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.planFirst.blocked', { tools: names }, `📋 計画承認待ち — 編集/コマンドをブロック中 (${names})`) });
                        history.push({ role: 'assistant', content: response });
                        history.push({
                            role: 'user',
                            content: `[Plan-First — blocked] The tool(s) ${names} are disabled until the user approves your plan. Do NOT retry them now.\n` +
                                `First outline what you intend to do with present_result(kind:"markdown"), then call ask_user(question:${JSON.stringify(pa.question)}, context:<one-line gist>, options:${JSON.stringify(pa.options)}, multi_select:false) and STOP.
` +
                                `Keep the outline SHORT and proportional to the task — a few lines for a small change. Cover what you will change and how; add scope, risks or a test approach ONLY if they genuinely matter here. Do not pad it with empty headings.
` +
                                `Edits are unblocked once the user approves (your next turn).`
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
                const { safeCalls, dangerousCalls, deniedCalls } = classifyToolCalls(
                    toolCall.tool_calls,
                    this.toolExecutor.getPermissionLevel?.bind(this.toolExecutor),
                );
                const results = [];
                let hasErrors = false;

                // Handle Denied Calls immediately
                for (const call of deniedCalls) {
                    const errorMsg = `Error: Execution blocked by user permission settings (Deny).`;
                    results.push({ tool_call_name: call.name, result: errorMsg, id: callIdOf.get(call) });
                    hasErrors = true;
                    // Recorded, but flagged: a user refusal is not a defect to learn
                    // a fix for. Step 1 excludes `denied` rows from card minting.
                    this._trace?.record({ iteration, tool: call.name, args: call.args, result: errorMsg, isError: true, ms: 0, denied: true });
                    onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args, status: 'denied' });
                }

                // Execute safe calls in parallel — but never two calls that
                // mutate the SAME file (P5 conflict detection). The loop has no
                // cross-call locking; a second write racing the first silently
                // wins/loses. partitionParallelCalls keeps the first writer in
                // the parallel batch and pulls conflicting later ones into
                // `serial`, run after the batch in their original order.
                if (safeCalls.length > 0) {
                    const { parallel, serial } = partitionParallelCalls(safeCalls);
                    if (serial.length > 0) {
                        onAgentStatus?.({ event: 'status', status: 'running', message: serializationNotice(serial) });
                    }

                    const runOne = (call) => {
                        // The tool_call event is what the Monitor timeline draws a
                        // row from — a serialized call that skipped it was invisible
                        // there even though it ran.
                        onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args });
                        return executeOneCall({
                            call,
                            executor: this.toolExecutor,
                            onStatus: (msg) => onAgentStatus?.({ event: 'status', status: 'running', message: msg }),
                            onConfirm,
                        });
                    };

                    const safeResults = await Promise.all(parallel.map(runOne));

                    // Conflicting (same-file) calls run one-at-a-time AFTER the
                    // batch — each sees the previous call's write.
                    for (const call of serial) {
                        safeResults.push(await runOne(call));
                    }

                    for (const { call, result, duration } of safeResults) {
                        const isError = isErrorResult(result);
                        if (isError) hasErrors = true;
                        this._trackReadEfficiency(call, result, isError);
                        this._trace?.record({ iteration, tool: call.name, args: call.args, result, isError, ms: duration });
                        if (onLog) this._logToolTelemetry(onLog, iteration, call, result, duration, isError);
                        results.push({ tool_call_name: call.name, result: await this._recallMemory(call, result, onAgentStatus, iteration), id: callIdOf.get(call) });
                    }
                }

                // Execute dangerous calls sequentially (with user confirmation)
                for (const call of dangerousCalls) {
                    onAgentStatus?.({ event: 'tool_call', name: call.name, args: call.args });
                    const { result, duration: toolDuration } = await executeOneCall({
                        call,
                        executor: this.toolExecutor,
                        onStatus: (msg) => onAgentStatus?.({ event: 'status', status: 'running', message: msg }),
                        onConfirm,
                    });
                    const isError = isErrorResult(result);

                    this._trackReadEfficiency(call, result, isError);
                    this._trace?.record({ iteration, tool: call.name, args: call.args, result, isError, ms: toolDuration });
                    if (onLog) this._logToolTelemetry(onLog, iteration, call, result, toolDuration, isError);
                    results.push({ tool_call_name: call.name, result: await this._recallMemory(call, result, onAgentStatus, iteration), id: callIdOf.get(call) });

                    if (isError) {
                        hasErrors = true;
                        onAgentStatus?.({ event: 'status', status: 'running', message: `❌ ${call.name} failed: ${result}` });
                    } else {
                        onAgentStatus?.({ event: 'status', status: 'running', message: `✅ ${call.name} finished: ${summarizeForStatus(result)}` });
                    }
                }

                if (hasErrors) {
                    consecutiveErrorCount++;
                } else {
                    consecutiveErrorCount = 0;
                }

                // ── Phase routing: planning is over once the run acts ──
                // Registering the subtask list (task_progress) or touching a file
                // both mean the same thing regardless of what the model called it,
                // so the deep tier is released here rather than waiting for the
                // step cap. `planFirstPending` keeps a BLOCKED edit from counting:
                // under the plan-first gate that call never ran.
                if (this._phaseRouting && this._phase === 'plan') {
                    const signal = phaseSignalForToolCalls(toolCall.tool_calls.map(tc => tc.name));
                    if (signal) {
                        this._phaseEvent(signal, {
                            planFirstPending: this._planFirstActive && !this._planApproved,
                        }, onAgentStatus);
                    }
                }

                // Collect any images the tools produced. They cannot travel inside
                // a tool result (text-only on every provider), so the next request
                // carries them instead — see the stepImages assembly above.
                const producedImages = this.toolExecutor.drainImages();
                const activeModel = this._modelOverride || llmService.getCurrentModel();
                // Dropping them silently would leave the model reasoning about
                // pictures it never received, so the notice rides into the prompt.
                const imageRoute = routeProducedImages({
                    producedImages,
                    activeModel,
                    modelSupportsVision: (m) => llmService.modelSupportsVision?.(m) === true,
                });
                const imageNotice = imageRoute.notice;
                if (imageRoute.attached) {
                    this._pendingToolImages.push(...producedImages);
                } else if (imageNotice) {
                    onAgentStatus?.({ event: 'status', status: 'running', message: `⚠️ 抽出した画像${producedImages.length}枚は、モデル(${activeModel || '未設定'})がビジョン非対応のため渡せませんでした。` });
                }

                // Recovery hints by error type → ./agent/RecoveryHints.js (unit-tested).
                let recoveryHint = (hasErrors ? buildRecoveryHint(results) : '') + imageNotice;

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
                const iterHadProgress = iterationMadeProgress(iterTools);
                progressHistory.push(iterHadProgress);

                // When real progress resumes, reset detection booleans so the
                // agent gets a fresh cycle/no-progress window rather than being
                // permanently flagged from a single brief plateau.
                if (iterHadProgress) {
                    cycleWarned = false;
                    noProgressWarned = false;
                }

                if (!noProgressWarned && isNoProgressWindow(progressHistory, safety.noProgressWindow)) {
                    noProgressWarned = true;
                    onAgentStatus?.({
                        event: 'status',
                        status: 'running',
                        message: `No file changes in ${safety.noProgressWindow} steps — checking in with the agent.`
                    });
                    history.push({
                        role: 'user',
                        content: noProgressCheckMessage(safety.noProgressWindow),
                    });
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

                    // ── Phase routing: everything from here is verification ──
                    // The review gate below, the deliverable nudge and the fixes
                    // they send back are the steps that decide whether the run was
                    // actually correct, so they get the deep tier even though the
                    // bulk of the work ran cheap. This is the half of the trade
                    // that makes the cheap execution safe to accept.
                    this._phaseEvent('finish', {}, onAgentStatus);

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
                        || deliverableLen >= DELIVERABLE_MIN_CHARS;
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
                    // Report-only deliverable (a research/evaluation task that only
                    // wrote .md/.txt docs) doesn't need a CODE review — skip so the
                    // reviewer sub-agent isn't forced on it. Review runs only when at
                    // least one changed file is actual code/config.
                    const modifiedForReview = this.toolExecutor.getModifiedFiles() || [];
                    const hasReviewableChanges = modifiedForReview.some(f => !this._isReportOnlyFile(f.path));
                    if (!this._isSubagent && !this._reviewDone && safety.subagentReview === 'on'
                        && modelReliableForReview
                        && hasReviewableChanges) {
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
                        // Always surface the reviewer's ACTUAL report in the log (both
                        // pass and fail), condensed to a couple of lines so the user
                        // can see WHAT the reviewer said, not just the verdict. The
                        // full text still goes to the model (fail: as the bounce
                        // message; pass: findings are informational).
                        const reviewSummary = summarizeReview(verdict, findings);
                        if (onLog) { try { onLog({ method: 'REVIEW', status: 200, stepLabel: '🔎 Review Verdict', response: { verdict, reason, findings: String(findings).slice(0, 2000), summary: reviewSummary } }); } catch (_) {} }
                        if (verdict === 'fail') {
                            this.toolExecutor.resetTaskCompleted?.();
                            onAgentStatus?.({ event: 'status', status: 'running', message: `🔎 レビュー指摘あり — 修正のため差し戻し / Review FAIL — sent back for fixes\n${reviewSummary}` });
                            // Applying the reviewer's findings is execution, not
                            // review: back to the fast tier so a bounced task does
                            // not finish the rest of its run on the deep model.
                            this._phaseEvent('reopen', {}, onAgentStatus);
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
                    } else if (!this._isSubagent && !this._reviewDone && safety.subagentReview === 'on'
                        && !modelReliableForReview && hasReviewableChanges) {
                        // Review is ON and there ARE code changes, but the model is in
                        // JSON-tool (weak) mode → skip with a one-line note so it's
                        // clear WHY no review ran.
                        this._reviewDone = true;
                        onAgentStatus?.({ event: 'status', status: 'running', message: 'ℹ レビューをスキップ（このモデルはJSONツールモード）/ Review skipped — model in JSON-tool mode' });
                    }

                    // ── Investigation gate (read-only runs) ────────────────────
                    //
                    // The code review above is conditioned on hasReviewableChanges,
                    // so a run that only READ files skipped every check except
                    // "did you produce text". An investigation's deliverable IS
                    // its claim, and nothing was in a position to ask whether the
                    // claim was supported, or whether the trace stopped at a layer
                    // boundary — which is exactly how an answer about a screen gets
                    // delivered without the backend state that actually governs it.
                    //
                    // Three checks, cheapest first: two deterministic ones that
                    // cost no tokens, then one auditor sub-agent. All soft and
                    // one-shot, matching the deliverable nudge above — the model is
                    // told once and then trusted, because hard-blocking would
                    // deadlock a run whose model cannot satisfy the check.
                    const investigationText = [ftSummaryArg, richThought,
                        this._extractEnvelopeAnswer(this._lastResultEnvelope) || '']
                        .filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
                    const isInvestigationRun = !hasReviewableChanges
                        && isInvestigation({
                            hasReviewableChanges,
                            deliverable: investigationText,
                            inspections: this.toolExecutor.inspectionCount || 0,
                        });

                    if (isInvestigationRun) {
                        // (a+b) One bounce, not two. Both checks say the same
                        // thing — the answer is not showing its working — and
                        // splitting them cost a second round trip to deliver the
                        // second half of one message.
                        const evidence = evidenceCheck(investigationText);
                        const frontier = frontierCheck(
                            this.toolExecutor.openQuestions?.snapshot() || [], investigationText);
                        if ((evidence.needed || frontier.needed) && !this._investigationNudged) {
                            this._investigationNudged = true;
                            this.toolExecutor.resetTaskCompleted?.();
                            const parts = [];
                            if (evidence.needed) {
                                parts.push('**Sources.** Your answer describes how the system behaves but cites '
                                    + (evidence.citations.length
                                        ? `only ${evidence.citations.length} source (${evidence.citations.join(', ')})`
                                        : 'no sources at all')
                                    + '. A reader cannot tell which parts you verified and which you inferred. '
                                    + 'Revise it so every claim about what the system DOES carries the file that shows it, with a line number where you have one — `path/to/file.ext:123`. '
                                    + 'Where you did not verify something, say so in that sentence rather than leaving it in the same voice as the rest. '
                                    + 'If a claim turns out to have nothing behind it, go and read the file now rather than softening the wording.');
                            }
                            if (frontier.needed) {
                                parts.push('**Open questions.** You recorded these as things the answer depends on, and you are finishing without either answering them or mentioning them:\n\n'
                                    + renderQuestions(frontier.open, { heading: 'Still open' })
                                    + '\n\nFor each: either investigate it now and close it with `open_question` action:"resolve", folding what you found into the answer — or, if it genuinely does not change the conclusion, say plainly IN the answer that it is unverified and why that is acceptable.');
                            }
                            const label = evidence.needed && frontier.needed
                                ? '🔍 根拠と未解決の論点 — 追記を促しています'
                                : (evidence.needed ? '🔍 根拠が未提示 — 出典の付与を促しています' : `❓ 未解決の論点が ${frontier.open.length} 件残っています`);
                            onAgentStatus?.({ event: 'status', status: 'running', message: label });
                            this._pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
                            if (callIdOf.size > 0) this._pushToolResultsTurn(history, results, true, null);
                            history.push({
                                role: 'user',
                                content: '[Investigation Incomplete] Before this answer is accepted:\n\n'
                                    + parts.join('\n\n')
                                    + '\n\nRe-state the COMPLETE answer when you are done — the revised version replaces the previous one, so anything you leave out is lost. Then call finish_task again.'
                            });
                            continue;
                        }

                        // (c) Independent audit. Same config switch as the code
                        // review (subagent_review) and the same weak-model skip:
                        // this is that feature applied to the other half of the
                        // work, not a second policy with its own settings.
                        if (!this._isSubagent && !this._auditDone && safety.subagentReview === 'on'
                            && modelReliableForReview) {
                            this._auditDone = true;
                            onAgentStatus?.({ event: 'status', status: 'running', message: '🔎 調査内容を独立監査中… / Independent audit of the investigation…' });
                            const auditBrief = buildAuditBrief({
                                goal: prompt,
                                report: investigationText,
                                openQuestions: this.toolExecutor.openQuestions?.snapshot() || [],
                                filesRead: this._filesReadThisRun(),
                            });
                            const auditText = await this._runSubtask(
                                { role: 'auditor', brief: auditBrief },
                                { workspacePath, onAgentStatus, onConfirm, onLog, abortSignal, safety }
                            );
                            const { verdict, findings, reason } = parseReviewVerdict(String(auditText || ''));
                            const auditSummary = summarizeReview(verdict, findings);
                            if (onLog) { try { onLog({ method: 'AUDIT', status: 200, stepLabel: '🔎 Audit Verdict', response: { verdict, reason, findings: String(findings).slice(0, 2000), summary: auditSummary } }); } catch (_) {} }
                            if (verdict === 'fail') {
                                this.toolExecutor.resetTaskCompleted?.();
                                onAgentStatus?.({ event: 'status', status: 'running', message: `🔎 監査で指摘あり — 調査を継続 / Audit FAIL — investigating further\n${auditSummary}` });
                                this._phaseEvent('reopen', {}, onAgentStatus);
                                this._pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
                                if (callIdOf.size > 0) this._pushToolResultsTurn(history, results, true, null);
                                history.push({
                                    role: 'user',
                                    content: `[Audit — FAIL] An independent auditor checked your answer against the codebase and found it incomplete or unsupported. Address ONLY the [CRITERIA-VIOLATION] and [BUG] findings ([STYLE] is informational). Where a finding says the trace stopped short, go and read the layer it names — do not simply reword the answer. Then call finish_task again.\n\n${clipText(findings, 6000)}`
                                });
                                continue;
                            }
                            onAgentStatus?.({ event: 'status', status: 'running', message: verdict === 'pass' ? '🔎 監査PASS ✅' : '🔎 監査結果を取得できず（空レポート）— 完了を続行' });
                        }
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

        return this._finishRun({
            prompt, workspacePath, onAgentStatus, onLog,
            iteration, finalResponse, stoppedBy, isUnlimited,
            toolUsageCounts, taskStartMs, cumulativeTokens,
        });
    }


    /**
     * Turn whatever the loop left behind into the caller's result.
     *
     * Extracted from the tail of `run()`. The order here is load-bearing: the
     * step-limit verdict is decided before the summary is built (it appends to
     * finalResponse), the session artifacts are captured before `endSession()`
     * nulls the workspace path, and long-term memory is fired WITHOUT await on
     * purpose - see the note at that call.
     *
     * Takes the loop's final values explicitly rather than reading them off a
     * state object: the loop still works in local variables, and passing what it
     * actually ended with is honest about that.
     */
    async _finishRun({
        prompt, workspacePath, onAgentStatus, onLog,
        iteration, finalResponse, stoppedBy, isUnlimited,
        toolUsageCounts, taskStartMs, cumulativeTokens,
    }) {
        if (!isUnlimited && iteration >= this.maxIterations) {
            // Previously this appended a one-line parenthetical and completed
            // silently — no status event at all — so the run simply appeared to halt.
            stoppedBy = stopReason('step_limit', { limit: this.maxIterations, used: iteration });
            onAgentStatus?.({ event: 'status', status: 'running', message: stopStatusMessage(stoppedBy) });
            finalResponse = (finalResponse || '') + stopNotice(stoppedBy);
        }

        // Flush the failure trace. Best-effort by construction (flush never
        // throws) — the trace is diagnostics, not part of the task's result.
        await this._trace?.flush();

        // Capture session artifacts BEFORE endSession (which nulls workspacePath).
        const modifiedFiles = this.toolExecutor.getModifiedFiles();
        const sessionId = this.toolExecutor.getCurrentSessionId();
        const wsPath = workspacePath || this.toolExecutor.workspacePath;

        // Learn from this run: lessons from what failed, insights from what
        // verifiably worked. Derived from the trace, so nothing is written on the
        // strength of the model's own account of the session.
        try {
            if (this._cards?.enabled && this._trace?.events.length) {
                const failures = this._trace.summary();
                const minted = this._cards.learn({
                    rows: failures,
                    events: this._trace.events,
                    sessionId,
                    date: new Date().toISOString().split('T')[0],
                });
                if (minted.length) {
                    await this._cards.save();
                    // `phase: 'teardown'` — this fires AFTER the loop has broken, so
                    // the UI must not read it as "a new run is progressing" (that
                    // closed the ask_user question the run had just paused on).
                    onAgentStatus?.({
                        event: 'status', status: 'running', phase: 'teardown',
                        message: `🧠 学習を記録: ${minted.length} 件 — ${summarizeMinted(minted)}`,
                    });
                    // The full list goes to the log channel, where it renders as an
                    // expandable block: "7 件" alone says nothing about WHAT was
                    // learned, and an unreviewable memory is one nobody can correct.
                    onLog?.({
                        method: 'METRICS', status: 200,
                        stepLabel: '🧠 Learned this run',
                        response: {
                            count: minted.length,
                            cards: minted.map(c => {
                                const s = cardSummary(c);
                                return {
                                    kind: s.badge,
                                    what: s.headline,
                                    detail: s.detail,
                                    cost_steps: c.costSteps ?? null,
                                    id: c.id,
                                };
                            }),
                        },
                    });
                }

                // One measurement row per run. Written for BOTH arms — a
                // recall-off session is the control, not a wasted session.
                await appendSessionMetrics({
                    workspacePath: wsPath, invoke,
                    row: sessionMetrics({
                        events: this._trace.events,
                        shownLog: this._cardsShownLog,
                        failures,
                        iterations: iteration,
                        recall: this._recallOn ? 'on' : 'off',
                        injectionVariant: INJECTION_VARIANT,
                        memoryChars: this._memoryChars,
                        sessionId,
                    }),
                });
            }
        } catch (e) {
            console.warn('AgentController: card learning failed:', e);
        }

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
        }, onAgentStatus);

        // Long-term memory: record this completed session to the durable journal +
        // facts store. (Previously addEntry existed but was never called — LTM was
        // effectively dormant.)
        //
        // DELIBERATELY NOT AWAITED. addEntry runs an LLM summarisation (and, when
        // the facts store is near its cap, a second consolidation call) — several
        // seconds that contribute NOTHING to `resultSummary`. Awaiting it here is
        // what made the app sit silent after finish_task had already succeeded:
        // the caller only emits `complete` once run() returns. Memory is
        // bookkeeping, so it settles in the background; ConversationMemory
        // serialises its own writes, so overlapping runs cannot interleave.
        conversationMemory.addEntry(prompt, finalResponse, sessionId, wsPath, onLog, this._auxModel())
            .catch(e => console.warn('AgentController: LTM addEntry failed:', e));

        this.toolExecutor.endSession();

        // 📊 Continuous efficiency measurement (step-reduction regression watch).
        this._emitEfficiencyReport(onLog, iteration);

        return {
            response: finalResponse,
            modifiedFiles,
            resultSummary,
            // null on a normal finish_task; a stopReason when a limit cut the run short.
            stopReason: stoppedBy,
        };
    }

    /**
     * Build a structured result summary for the post-run "Result" view.
     * @param {string} finalResponse - the agent's final summary text (markdown-ish)
     * @param {Array}  modifiedFiles - [{ path, original, current }] from ToolExecutor
     * @returns {Promise<{summary:string, files:Array<{path,action,description}>}>}
     */
    /**
     * Everything that must be true before the first LLM call.
     *
     * Extracted from the top of `run()`, where it was 516 lines of setup sharing
     * scope with the 1,100-line loop that followed — the reason neither could be
     * read or changed on its own. Behaviour is unchanged: this is the same code in
     * the same order, returning what the loop used to close over.
     *
     * Order matters and is not arbitrary — the connection must be re-read before
     * the tier is resolved, the tier before the vision check, the caller class
     * before the tool allowlist, and the session must be started before the trace
     * and card store name their files.
     *
     * ── Agent Loop State Machine ──────────────────────────────────
     *
     *  RUNNING  ──[tool call]──► RUNNING   (execute tools, continue)
     *           ──[finish_task]─► DONE      (immediate exit)
     *           ──[text only, 1st time]──► RUNNING (re-prompt once)
     *           ──[text only, 3× in row]──► DONE   (model stuck)
     *           ──[3× errors]──► DONE
     *           ──[max iterations / budget / abort]──► DONE
     *
     *  Exit is ONLY via finish_task, safety limits, or the stuck-detector.
     *  Text-only replies are never treated as completion on their own.
     * ─────────────────────────────────────────────────────────────
     *
     * @returns {Promise<object>} the loop's starting context
     */
    async _prepareRun({ prompt, workspacePath, onAgentStatus, chatContext, kisContext, images }) {
        chatContext = chatContext || [];
        images = images || [];
        // A previous run must not leak its images into this one.
        this._pendingToolImages = [];
        this.toolExecutor.drainImages();
        // Report a native tool-calling failure once per run (see _generateWithHistory).
        this._nativeToolFailureNotified = false;
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
        // ── Investigation gate per-run state (see agent/InvestigationGate.js) ──
        // A run that only READS never reaches the code-review gate below, so
        // until these existed nothing checked an investigation at all. All three
        // are one-shot and soft, like the deliverable nudge.
        this._investigationNudged = false;
        this._auditDone = false;
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
        // QUALITY of compression (not just volume): attributes each re-read to
        // whether it crossed a compression boundary, so a policy that discards
        // still-needed content shows up as a negative net saving.
        this._compressionMetrics = new CompressionMetrics();
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
        // ── Phase routing state (agent/ModelPhaseRouter.js) ──
        this._phase = 'execute';        // plan → execute → review
        this._phaseRouting = false;     // config gate; off ⇒ nothing below applies
        this._phaseEscalated = false;   // long-run escalation promoted EXECUTE to deep
        this._phaseTokens = { plan: 0, execute: 0, review: 0 };  // for the cost report
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
        // Episodic (past-session) injection. `setEpisodeInjectionConfig` existed
        // with no caller at all outside tests — the knob was built and never
        // connected, so the layer's cost was not adjustable by anyone. Now the
        // setting drives it; the default is off (agent-memory-layers.md §7).
        conversationMemory.setEpisodeInjectionConfig({ enabled: safety.episodeInjection === 'on' });
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
        //
        // NOTE: behavior.mcp_servers is deliberately NOT a marker of an external
        // caller. JHAI's own UI (Schedule / NewTask) lets the user pick MCP servers
        // for a run, and those runs are still interactive JHAI tasks that keep the
        // full built-in toolset. External callers are identified by their caller
        // name (REST API) or by behavior.intent (an external app's intent).
        const INTERACTIVE_CALLERS = ['DirectChat', 'Schedule', 'NewTask'];
        // A SUB-AGENT is never external. It is JHAI's own work, one level down —
        // but it satisfied BOTH of the tests below (caller 'Subagent' is not in
        // the interactive list, and _runSubtask passes `intent: {tier}` for model
        // routing), so it was classified as an external app. Two consequences,
        // both contradicting the documented intent in ToolExecutor.setExcludeExternalAppMcpTools:
        //   • it was offered the connected app's live-editor MCP tools
        //     (JHEditor get_buffer / list_workspace_files), which mean nothing
        //     to a scoped sub-task;
        //   • MCP relevance pruning was skipped, so every child received EVERY
        //     MCP tool with full schemas on every step. With a 58-tool server
        //     connected, delegating cost more context than doing the work inline
        //     — inverting the reason run_subtask exists.
        const isExternalCaller = !this._isSubagent
            && ((this.caller && !INTERACTIVE_CALLERS.includes(this.caller))
                || !!(this.behaviorOverrides && this.behaviorOverrides.intent));
        this._isExternalCaller = isExternalCaller;

        // JHAI's OWN tasks (NewTask / Schedule / DirectChat / sub-agents) must NOT
        // be offered MCP tools that a connected external app provides over its
        // WebSocket link (JHEditor get_buffer / list_workspace_files / …). Those
        // tools read the app's LIVE editor state — meaningless for a plain
        // workspace task, and a common way the model burns steps. External callers
        // keep them: that workspace access is the whole point of their task.
        this.toolExecutor.setExcludeExternalAppMcpTools(!isExternalCaller);

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
        // A continuation whose latest message is a plan-revision request (the
        // user picked the ✏️ "Request changes" option on the approval card and typed
        // what they want changed) must RE-OPEN the plan-first gate: the run should
        // revise the plan and re-present it — NOT dive straight into editing.
        // Without this, any continuation (chatContext present) silently proceeds to
        // implement, which is exactly the reported "修正したいでも実装される".
        // NOTE: the revision text arrives as the new `prompt` (continue_task passes
        // the user's reply as prompt and rebuilds chatContext from PAST completes),
        // so it is looked for in `prompt`, with a fallback to the last user turn
        // of chatContext for callers that attach the reply there instead.
        const lastUserMsg = isFreshTurn ? '' : String([...chatContext].reverse().find(m => m?.role === 'user' && m?.content)?.content || '');
        const isPlanRevisionTurn = !isFreshTurn && (isPlanRevision(String(prompt || '')) || isPlanRevision(lastUserMsg));
        // The gate decision itself (caller allowlist, bypass phrase, complexity
        // scoring) lives in SafetyGuards.planFirstGate — see its unit tests. The
        // revision text it returns is what the user typed, stripped of markers.
        const gate = planFirstGate({
            prompt,
            caller: this.caller,
            isSubagent: this._isSubagent,
            isFreshTurn,
            isPlanRevisionTurn,
            planMode,
            lastUserMsg,
        });
        this._planRevisionText = gate.revisionText;
        this._planFirstActive = gate.active;
        this._planApproved = gate.approved;
        if (this._planFirstActive) {
            onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.planFirst.on', null, '📋 計画優先モード — まず計画を提示し承認を得ます') });
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
        // Kept for the run's AUXILIARY calls (result summary, file descriptions,
        // memory extraction). Those are JSON/boilerplate generators — running them
        // on the active deep model costs seconds of post-run latency for nothing.
        this._fastModelId = tierModels.fast || null;
        // 0 ⇒ never promote on step count alone. See SAFETY_DEFAULTS.escalateAtStep
        // for why the old expression promoted every run at step 15.
        this._escalateAtStep = safety.escalateAtStep > 0 ? safety.escalateAtStep : 0;

        // ── Phase routing ────────────────────────────────────────────────
        // Same tier ids, but re-decided as the run moves plan → execute →
        // review instead of once at the start. Requires BOTH tiers: with only
        // one configured every phase resolves to the same model, so the run
        // would pay the switching complexity for no saving.
        this._phaseRouting = safety.phaseRouting === 'on'
            && !userPicksModel
            && !this._isSubagent          // a sub-agent is ONE phase of the parent
            && !!tierModels.fast && !!tierModels.deep;
        if (this._phaseRouting) {
            this._phase = initialPhase({
                enabled: true,
                freshTurn: isFreshTurn,
                planFirst: this._planFirstActive,
                complex: this._looksComplex(prompt),
            });
            const m = modelForPhase(this._phase, tierModels, { enabled: true });
            if (m) this._modelOverride = m;
            // The opening phase, structured — without this the Dashboard's rail
            // would not know which phase a run is in until the FIRST switch.
            onAgentStatus?.({
                event: 'phase',
                phase: this._phase,
                model: this._modelOverride,
                from: null,
                escalated: false,
                reason: this._phase === 'plan'
                    ? (this._planFirstActive
                        ? t('agent.phaseRouting.reason.planFirst', null, 'plan-first 承認ゲート → 計画は deep で実施')
                        : t('agent.phaseRouting.reason.complex', null, 'タスクが複雑と判定 → 計画は deep で実施'))
                    : (isFreshTurn
                        ? t('agent.phaseRouting.reason.fresh', null, '単発タスク → 実行フェーズを fast で開始')
                        : t('agent.phaseRouting.reason.continued', null, '継続ターン(計画済み) → 実行フェーズで開始')),
                tokens: { ...this._phaseTokens },
            });
            onAgentStatus?.({
                event: 'status', status: 'running',
                message: t('agent.phaseRouting.on', { phase: phaseLabel(this._phase), model: this._modelOverride },
                    `🧭 フェーズ別ルーティング ON — ${phaseLabel(this._phase)}: ${this._modelOverride}`),
            });
        } else if (this._modelOverride) {
            onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.model', { model: this._modelOverride }, `🧭 モデル: ${this._modelOverride}`) });
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
                    onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.vision.switched', { model: visionModel }, `🖼 画像入力のためビジョン対応モデルに切替: ${visionModel}`) });
                } else {
                    onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.vision.unsupported', { count: images.length, model: chosen || '未設定' }, `⚠️ ${images.length}枚の画像が添付されていますが、設定中のモデル(${chosen || '未設定'})はビジョン非対応です。画像は無視されます。`) });
                }
            } else {
                onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.vision.received', { count: images.length, model: chosen }, `🖼 ${images.length}枚の画像を受信（モデル ${chosen} はビジョン対応）。`) });
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
        // Non-null when a LIMIT ended the run rather than the agent deciding it was
        // done. Returned to the caller so a capped run cannot masquerade as a clean
        // completion — see agent/stopReason.js.
        let stoppedBy = null;
        let identicalWarned = false;
        let cycleWarned = false;
        let noProgressWarned = false;
        // bool[] — one entry per iteration: true if any mutating tool was called.
        const progressHistory = [];
        // Tools that count as "real progress" for the no-progress detector.
        // Anything not in this list (read_file/grep_search/list_files/open_file)
        // is exploratory and does NOT count. MUTATING_TOOLS is imported from
        // agent/SafetyGuards.js (P3 split).

        await this.toolExecutor.startSession(workspacePath);

        // RE-APPLY the external-app (WS) MCP exclusion AFTER startSession. The
        // session reset wipes every per-run flag (ToolExecutor.startSession resets
        // _excludeExternalAppMcpTools to false), and the call above at the top of
        // run() is therefore clobbered — leaving JHAI's OWN tasks (NewTask /
        // Schedule / DirectChat) offering the connected external app's WS MCP
        // tools (JHEditor read_workspace_file / list_workspace_files / …) to the
        // LLM every run. Re-applying here, alongside the other per-run MCP
        // settings (server filter / context / relevance query), keeps the flag in
        // step with the session that is actually about to run.
        this.toolExecutor.setExcludeExternalAppMcpTools(!isExternalCaller);

        // Failure trace for this session. Created after startSession because the
        // session id names the file. Disables itself when there is no workspace.
        this._trace = new TraceRecorder({
            workspacePath,
            sessionId: this.toolExecutor.getCurrentSessionId(),
            invoke,
        });

        // What earlier sessions in this workspace learned. Loaded once; recall is
        // then in-memory, so a hit costs no I/O and no LLM call.
        this._cards = new CardStore({ workspacePath, invoke });
        await this._cards.load();
        // Which arm this run belongs to. Under 'auto' it is drawn at random, so
        // the control group forms itself instead of depending on someone
        // remembering to flip a switch. Learning runs in both arms.
        this._recallOn = resolveRecallArm(safety.memoryRecall);
        /**
         * Step 6. Off unless asked for: its own precondition (a positive
         * follow-through lift) is unmet, and switching it on mid-measurement
         * would make the v2 injection rework unattributable.
         */
        this._playbookOn = safety.playbook === 'on';
        /** [{ id, at, recipe }] — what was surfaced, and when. Feeds followThrough. */
        this._cardsShownLog = [];
        this._memoryChars = 0;

        // Invalidate ContextBuilder's static cache so the new session gets a
        // fresh build (picks up any persona/config changes since last run).
        contextBuilder.invalidateStaticCache();

        // Non-blocking cleanup of old session directories (>30 days).
        // Runs in the background — failures are silently ignored.
        this._cleanupOldSessions(workspacePath).catch(() => {});

        // Determine tool allowlist behavior. (isExternalCaller computed above.)
        // NOTE: for interactive callers that picked MCP servers (Schedule/NewTask),
        // mcp_servers is NOT external — so the built-in toolset is preserved and
        // the selected servers' tools are surfaced through the normal MCP filter.
        let enabledTools = this.behaviorOverrides?.enabled_tools;

        if (isExternalCaller && (enabledTools === null || enabledTools === undefined)) {
            // External callers default to restricting native tools to only finish/meta tools,
            // while bypassing allowlist checks for MCP tools (provided by the workspace side).
            enabledTools = [];
            this.toolExecutor._mcpBypassesAllowlist = true;
        } else if (isExternalCaller && Array.isArray(enabledTools)) {
            // An EXPLICIT enabled_tools list from an external caller scopes BOTH built-in
            // AND MCP tools — otherwise workspace-side MCP tools (list_workspace_files,
            // read_workspace_file, …) are all advertised and the LLM calls tools that are
            // not actually enabled for the task. Only the unspecified case above bypasses.
            this.toolExecutor._mcpBypassesAllowlist = false;
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
                    || envelopeHasContent(incoming)
                    || !envelopeHasContent(this._lastResultEnvelope)) {
                    this._lastResultEnvelope = incoming;
                }
            }
            onAgentStatus?.({ event, ...data });
        };

        // Phase 4: what procedures this run can consult.
        //
        // The SKILLS half is a CATALOGUE — one line per skill, name and
        // description — and the agent loads a body with `read_skill` when one
        // applies. That is the difference between offering a skill and paying
        // for it: a ten-page procedure costs one line until it is needed.
        //
        // It used to read `.agent/skills.json`: a per-project store of
        // name/description pairs with NO bodies to load, which the Skills tab
        // could not edit and `/…` could not see. A skill the user wrote was
        // therefore invisible to a running agent. That JSON is still read as
        // project knowledge — a workspace can have conventions that are not
        // skills — but the skills themselves now come from one place.
        if (!kisContext) {
            try {
                const parts = [];
                try {
                    await skillManager.refresh();
                    const catalogue = skillManager.catalogue();
                    if (catalogue) parts.push(catalogue);
                } catch (e) {
                    console.warn('Failed to load skills:', e);
                }

                const root = workspacePath;
                if (root) {
                    for (const [file, label] of [['skills.json', 'PROJECT NOTES'], ['workflows.json', 'WORKFLOWS']]) {
                        try {
                            const data = await invoke('read_file', { path: `${root}/.agent/${file}` });
                            if (data) parts.push(`--- ${label} ---\n${data}`);
                        } catch (e) { /* the file is optional */ }
                    }
                }

                if (parts.length) {
                    kisContext = parts.join('\n\n');
                    onAgentStatus?.({ event: 'status', status: 'running', message: 'Loaded skills and project knowledge.' });
                }
            } catch (e) {
                console.warn('Failed to load KIs:', e);
            }
        }


        const state = new RunState({ maxIterations: this.maxIterations, startedAt: taskStartMs });
        state.history = history;
        return {
            state, safety, isExternalCaller, tierModels, isFreshTurn,
            kisContext, IMAGE_ATTACH_MAX_STEPS,
        };
    }

    async _buildResultSummary(finalResponse, modifiedFiles, onLog = null, meta = {}, onAgentStatus = null) {
        // action is derived deterministically: a null/empty `original` means the
        // file did not exist before this session → "created"; otherwise "modified".
        const files = (modifiedFiles || []).map(f => ({
            path: f.path,
            action: (f.original === null || f.original === undefined || f.original === '')
                ? 'created' : 'modified',
            description: ''
        }));

        // Per-file descriptions are DECORATION on the file table — the answer does
        // not depend on them. So the call is STARTED here and never awaited on the
        // critical path: it either lands while the report below is generating (free),
        // or it arrives after completion as a `result_update` patch. It used to be
        // awaited first, which meant every run with a modified file paid an LLM
        // round-trip before the user could see anything.
        let descriptions = null;
        let descriptionsDone = false;
        const descriptionsPromise = (files.length > 0 && files.length <= 30)
            ? this._describeFiles(files, finalResponse, onLog)
                .then((d) => { descriptions = d; descriptionsDone = true; return d; })
            : null;

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
        // A report WRITTEN TO A FILE is a deliverable too. Without this the
        // common shape — write report.md, then finish with "作成しました" — fell
        // through every branch: the deliverable nudge does not fire once files
        // changed, and this check saw only a short finalResponse. The result view
        // then showed a synthesized "依頼/実施/結果" instead of the report itself.
        const fileReport = (presented || fr.length >= DELIVERABLE_MIN_CHARS)
            ? ''
            : await this._readReportDeliverable(files);
        const deliverable = presented || (fr.length >= DELIVERABLE_MIN_CHARS ? fr : '') || fileReport;

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
        // Descriptions may already have landed — the report branch above awaits an
        // LLM call, which is plenty of time, and `_readReportDeliverable` reads
        // files. Applying them here keeps the common case a SINGLE `complete` with
        // a fully-populated table; only a genuinely slow description call falls
        // through to the patch path below.
        if (descriptionsPromise && descriptionsDone) {
            applyDescriptions(files, descriptions);
        } else if (descriptionsPromise) {
            descriptionsPromise.then((d) => {
                if (!applyDescriptions(files, d)) return;
                // The run already completed; patch the table in place rather than
                // emitting a second completion (which would duplicate the run).
                //
                // setTimeout, not a bare call: `complete` is emitted by the caller
                // resuming from `await run()`, i.e. on the MICROTASK queue. If the
                // descriptions happened to resolve in the same tick that run()
                // returned, emitting synchronously here would put the patch AHEAD
                // of the completion it patches — and a patch with no run to attach
                // to is silently dropped. A macrotask is always behind them.
                setTimeout(() => {
                    try { onAgentStatus?.({ event: 'result_update', files }); } catch (_) { /* decoration only */ }
                }, 0);
            }).catch(() => { /* decoration only */ });
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
     * One cheap LLM call producing a one-line description per modified file.
     * Resolves to the raw [{path, description}] array, or null on any failure —
     * descriptions are decoration, so nothing here is allowed to throw.
     */
    async _describeFiles(files, finalResponse, onLog = null) {
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
            const gen = await llmService.generate(prompt, sumSys, (chunk) => { raw += chunk; },
                null, this._auxModel());
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
            const m = String(raw || '').match(/\[[\s\S]*\]/);
            if (!m) return null;
            const arr = JSON.parse(m[0]);
            return Array.isArray(arr) ? arr : null;
        } catch (e) {
            console.warn('AgentController: file description generation failed:', e);
            return null;
        }
    }

    /**
     * Model id for the run's auxiliary (non-reasoning) calls. The Fast tier when
     * one is configured, else null = keep the active model.
     */
    _auxModel() {
        return this._fastModelId || null;
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
            const gen = await llmService.generate(reportPrompt, sys, (c) => { raw += c; },
                null, this._auxModel());
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

    async _generateWithHistory(history, systemPrompt, abortSignal, kisContext = '', images = [], onUpdate = null, onAgentStatus = null) {
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
                        // NOTE: this used to be a local const of the same name,
                        // which SHADOWED the imported helper — the module version
                        // was dead while an inline copy ran.
                        const toolNames = (this.toolExecutor.toolDefinitions || []).map(td => td.name);
                        if (!txt || looksLikeToolTextCall(txt, toolNames)) {
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
                        const toolCallsFormatted = formatNativeToolCalls(
                            result.toolCalls,
                            (s) => this._safeParseJSON(s),
                        );
                        // Every entry was malformed → treat as a native failure and
                        // fall back to JSON mode rather than proceeding with nothing.
                        if (toolCallsFormatted.length === 0) {
                            nativeFailed = true;
                            break;
                        }
                        
                        // Strip <thought>…</thought> XML wrapper that the model may output
                        // (per protocol instruction), keeping only the inner OBSERVE/PLAN/CALL text.
                        const rawThought = (result.content || '').trim();
                        const thought = stripThoughtWrapper(rawThought) || rawThought;

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
                    // The user cancelled — do NOT degrade to a JSON-mode call.
                    // chat() would attach its abort listener to an ALREADY-aborted
                    // signal (which never fires again), so the fallback request
                    // would go out uncancellable after a stop.
                    if (abortSignal?.aborted || /AbortError/i.test(String(e?.message || ''))) throw e;
                    console.warn('Native tool use failed, falling back to JSON mode:', e);
                    // Make the degradation VISIBLE. A provider-side rejection of the
                    // tools payload (e.g. Azure 400 on a strict-schema violation)
                    // otherwise looked like "the request simply has no tools": the
                    // failed native request is discarded and only the tool-less
                    // fallback shows up in the Monitor. Once per run — a persistent
                    // cause repeats on every step.
                    if (!this._nativeToolFailureNotified) {
                        this._nativeToolFailureNotified = true;
                        const detail = String(e?.message || e || '').slice(0, 400);
                        onAgentStatus?.({
                            event: 'status', status: 'running',
                            message: `⚠️ ネイティブtool callingが失敗したためJSONモードにフォールバックします（以降のリクエストにtoolsは載りません）: ${detail}`,
                        });
                    }
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

    /**
     * Prepend the matching lesson / insight to a tool result, so the agent reads
     * what this workspace already knows about this call at the moment it is
     * judging the outcome.
     *
     * The card goes BEFORE the result, and the raw `result` is left untouched for
     * every other consumer (error detection, telemetry, the trace) — recall must
     * not be able to change what was recorded as having happened.
     *
     * At most one card per call, and never the same card twice in a run
     * (CardStore tracks that), so this cannot grow into a wall of reminders.
     */
    /**
     * Queue images the user attached MID-RUN (a steering message / a follow-up)
     * for the next LLM call, and say what happened.
     *
     * Deliberately does NOT switch models the way the run-start routing does: a
     * model change mid-run discards the prompt cache for every remaining step,
     * which is a worse trade than telling the user their image cannot be read.
     * @returns {boolean} whether the images will actually be sent
     */
    _attachUserImages(images, onAgentStatus) {
        const list = Array.isArray(images) ? images.filter(Boolean) : [];
        if (list.length === 0) return false;
        const model = this._modelOverride || llmService.getCurrentModel();
        if (!llmService.modelSupportsVision?.(model)) {
            onAgentStatus?.({
                event: 'status', status: 'running',
                message: `⚠️ 画像${list.length}枚を受け取りましたが、モデル(${model || '未設定'})はビジョン非対応のため送信できません。`
                    + ' Settings → LLM Connections の接続設定で「This model accepts images」を確認してください。',
            });
            return false;
        }
        for (const data of list) this._pendingToolImages.push({ data, source: 'ユーザー添付' });
        onAgentStatus?.({ event: 'status', status: 'running', message: `🖼 画像${list.length}枚を次のステップでLLMに添付します。` });
        return true;
    }

    /**
     * Step 4b — the knowledge graph, injected at the moment it is actionable.
     *
     * Deliberately NOT a prompt prefix. Two things argued against that: a
     * neighbourhood depends on the task, so putting it in the cached system
     * prefix would break the prefix cache for every run; and the 89-run
     * measurement of the card brief showed that advice delivered up front and
     * then buried under twenty steps of history does not change behaviour. This
     * fires straight after a successful edit, when "what else imports this" is
     * a question the agent is about to need rather than one it has to remember.
     *
     * Under the A/B this is an INJECTION, so it belongs to the recall arm and is
     * withheld from the control arm like everything else being tested.
     */
    /**
     * Step 6 — the procedure this KIND of file has followed here, if there is one.
     *
     * Matched on an extension named in the PROMPT rather than guessed: at
     * iteration 1 nothing has been edited yet, and a playbook delivered after the
     * first edit is too late to shape the approach it describes. No extension in
     * the request means no playbook, which is the honest answer rather than a
     * default one.
     */
    async _recallPlaybook(prompt, workspacePath) {
        if (!this._playbookOn || !this._recallOn) return '';
        const ext = (String(prompt || '').match(/\.[a-z0-9]{1,6}\b/gi) || [])
            .map(s => s.toLowerCase())
            .find(s => s.length >= 3);
        if (!ext) return '';
        try {
            const { extractFromTraces, playbookFor, renderPlaybook } = await import('./memory/Playbook.js');
            const ws = workspacePath || this.toolExecutor?.workspacePath;
            const pbs = await extractFromTraces({ workspacePath: ws, invoke });
            return renderPlaybook(playbookFor(pbs, ext));
        } catch (_) {
            return '';   // extraction is an extra; a run must not fail over it
        }
    }

    async _recallImpact(call, result, iteration = 0) {
        if (!EDIT_TOOLS.has(call.name) || isErrorResult(result)) return '';
        if (!this._recallOn) return '';           // control arm: inject nothing
        const target = targetOf(call.args);
        if (!target) return '';
        this._impactSeen = this._impactSeen || new Set();
        // Once per file per run. An edit-heavy run touches the same file five
        // times, and repeating its dependants each time is the "more injection"
        // reflex this whole step is supposed to avoid.
        if (this._impactSeen.has(target)) return '';
        this._impactSeen.add(target);

        try {
            const { CodeIndexClient } = await import('./memory/CodeIndex.js');
            // The run's workspace lives on the executor — `run()` takes it as a
            // parameter and never stores it on the controller.
            const ws = this.toolExecutor?.workspacePath;
            const idx = new CodeIndexClient({ workspacePath: ws, invoke });
            if (!idx.enabled) return '';
            const hits = await idx.deps(target, { direction: 'in', limit: IMPACT_MAX_FILES, depth: 1 });
            if (!hits.length) return '';
            const names = hits.map(h => h.path).join(', ');
            const note = `[Impact — ${hits.length} file(s) import ${target}]\n  ${names}\n`
                + '  DO: if you changed an export or its signature, check these before finishing.';
            this._memoryChars = (this._memoryChars || 0) + note.length;
            return note;
        } catch (_) {
            return '';   // no index, or none built yet — this is an extra, not a step
        }
    }

    async _recallMemory(call, result, onAgentStatus, iteration = 0) {
        if (typeof result !== 'string') return result;
        const impact = await this._recallImpact(call, result, iteration);
        if (impact) {
            onAgentStatus?.({ event: 'status', status: 'running', message: `🕸 ${impact.split('\n')[0]}` });
            result = `${impact}\n${result}`;
        }
        try {
            // Control arm: pick the card, log it, return the result untouched.
            // The card's recipe is still scored against what the agent does from
            // here on, which is the base rate the recall arm has to beat.
            const shadow = !this._recallOn;
            const card = this._cards?.recallForTool(call.name, targetOf(call.args), { shadow });
            if (!card) return result;
            const note = renderCard(card);
            this._noteCardsShown([card], iteration, note, shadow);
            if (shadow) return result;
            // Structured, so the Dashboard can show WHICH memory fired and WHEN.
            // That is the pairing that makes a useless lesson visible: you see it
            // fire at step 12 and the same failure happen at step 13.
            this._emitRecall(onAgentStatus, [card], iteration, 'tool');
            onAgentStatus?.({ event: 'status', status: 'running', message: `🧠 ${note.substring(0, 90)}` });
            return `${note}\n${result}`;
        } catch (_) {
            return result; // recall is an optimisation; never fail a tool over it
        }
    }

    /**
     * Record what was surfaced and when, so the run can be scored afterwards:
     * did the agent actually do what the card recommended? The recipe is the
     * card's own claim (`fix` for a lesson, `what` for an insight); a card that
     * makes no tool-order claim is logged but not counted against follow-through.
     *
     * `shadow` entries were selected but never injected (control arm). They are
     * logged because they are the baseline; they add no `memoryChars`, because
     * no memory reached the prompt.
     */
    _noteCardsShown(cards, iteration, text = '', shadow = false) {
        if (!shadow) this._memoryChars = (this._memoryChars || 0) + String(text || '').length;
        for (const c of cards || []) {
            const row = { id: c.id, at: iteration, recipe: c.fix || c.what || '' };
            if (shadow) row.shadow = true;
            this._cardsShownLog.push(row);
        }
    }

    /**
     * Announce that memory was surfaced into the run.
     *
     * A `memory_recall` event rather than a parsed status line: the Dashboard's
     * "memory in play" strip needs the card ID to line the entry up with the
     * memory panel's toggle, and an id cannot be recovered from "🧠 <text>".
     * `source` distinguishes the opening brief from a mid-run tool nudge.
     */
    _emitRecall(onAgentStatus, cards, iteration, source) {
        if (typeof onAgentStatus !== 'function') return;
        const list = (cards || []).filter(Boolean).map(c => ({
            id: c.id,
            type: c.type || 'insight',
            headline: cardSummary(c).headline,
            recipe: c.fix || c.what || '',
        }));
        if (!list.length) return;
        onAgentStatus({ event: 'memory_recall', at: iteration, source, cards: list });
    }

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

    // NOTE: _toolArgHint / _historyChars / _historyText / _droppedContentHashes
    // now live in agent/PromptAssembler.js (P3 split) — thin wrappers keep the
    // existing this._method(...) call sites working.
    _toolArgHint(name, args) { return toolArgHint(name, args); }

    /** Total character weight of a history array (cheap proxy for token size). */
    _historyChars(history) { return historyChars(history); }

    /** All history text as one blob — for measuring what a summary preserved. */
    _historyText(history) { return historyText(history); }

    /**
     * Content hashes present BEFORE compaction but gone after — i.e. what the
     * compressor actually discarded. Lets CompressionMetrics upgrade a re-fetch
     * from "a compression happened in between" (correlation) to "this exact
     * content was dropped" (causation).
     */
    _droppedContentHashes(before, after) { return droppedContentHashes(before, after); }

    /**
     * Efficiency instrumentation — count read_file RE-READS (a file fetched more
     * than once), the dominant avoidable token sink on long tasks. First read of
     * a path is expected; every subsequent successful read on the same path is a
     * re-read whose bytes are (usually) redundant context. Measurement only.
     */
    _trackReadEfficiency(call, result, isError) {
        try {
            if (isError || !call) return;
            // ── Compression quality: ALL pure-retrieval tools ──────────────
            // Compression can drop a grep/glob/list result just as easily as a
            // file body; re-running any of them after a compression is the same
            // wasted context. run_command is deliberately excluded (re-running
            // a build/test is usually intentional, not compression's fault).
            const fetchSig = fetchKey(call.name, call.args);
            if (fetchSig) {
                this._compressionMetrics.noteFetch(
                    fetchSig,
                    typeof result === 'string' ? result.length : 0,
                    call.name,
                    typeof result === 'string' ? result : null,   // enables CAUSAL attribution
                );
            }

            // The legacy per-FILE re-read counters below stay read_file-only so
            // the existing report fields keep their meaning.
            if (call.name !== 'read_file') return;
            // A batch read is N reads for this counter's purposes: charging the
            // whole call to one path would let re-reading five files look like
            // re-reading one, and re-read volume is the number the efficiency
            // report exists to show.
            const batch = Array.isArray(call.args?.paths)
                ? call.args.paths.filter(p => typeof p === 'string' && p.trim())
                : [];
            const targets = batch.length > 0
                ? batch
                : [call.args?.path ?? call.args?.file ?? ''].filter(Boolean);
            if (targets.length === 0) return;
            // Chars are only known for the call as a whole, so split them evenly
            // rather than attributing the whole payload to each path.
            const charsEach = (typeof result === 'string' ? result.length : 0) / targets.length;
            for (const raw of targets) {
                const key = String(raw).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                const prev = this._readCounts.get(key) || 0;
                this._readCounts.set(key, prev + 1);
                if (prev >= 1) {
                    this._efficiency.reReads++;
                    this._efficiency.reReadChars += Math.round(charsEach);
                }
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
                    // QUALITY (not just volume): how much of the compression's
                    // "saving" the agent had to pay back by re-reading. A negative
                    // net_chars_saved means compression is counter-productive.
                    compression_quality: this._compressionMetrics.report(),
                    // Where the tokens went when phase routing was on. The feature
                    // claims the token MASS sits in the cheap phase; this is how
                    // that claim is checked on a real run instead of assumed.
                    phase_routing: this._phaseRouting ? {
                        tokens_by_phase: { ...this._phaseTokens },
                        fast_model: this._fastModelId,
                        deep_model: this._deepModelId,
                        execute_escalated: this._phaseEscalated,
                        cheap_share_pct: (() => {
                            const t = this._phaseTokens;
                            const total = t.plan + t.execute + t.review;
                            if (!total) return null;
                            return Math.round((this._phaseEscalated ? 0 : t.execute) / total * 100);
                        })(),
                    } : 'off',
                },
            });
        } catch (_) { /* logging only */ }
    }

    // ─── Phase 3: History Compression (JHEditor detailed version) ───

    // NOTE: _resultGroupHasReadContent / _pushAssistantToolTurn /
    // _pushToolResultsTurn / _compressToolResultsInHistory now live in
    // agent/PromptAssembler.js (P3 split) — thin wrappers keep the existing
    // this._method(...) call sites working.
    _resultGroupHasReadContent(content, budget) { return resultGroupHasReadContent(content, budget); }

    _pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf) {
        return pushAssistantToolTurn(history, response, toolCall, genResult, callIdOf);
    }

    _pushToolResultsTurn(history, results, native, tailText) {
        return pushToolResultsTurn(history, results, native, tailText);
    }

    _compressToolResultsInHistory(history) {
        return compressToolResultsInHistory(history);
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


    // ─── Phase 4: Full _cleanFinalResponse with thought extraction + multi-language (from JHEditor) ───

    _cleanFinalResponse(text) { return cleanFinalResponse(text); }

    /**
     * True if a modified file is a pure documentation/report deliverable (not
     * code/config). Used to skip the pre-finish CODE review for research/report
     * tasks that only wrote a markdown/text report. Conservative: only clear
     * doc/data-text formats count as report-only; anything else (source, config,
     * html/json that could be code) is treated as reviewable.
     */
    /**
     * Read back a report file this run produced, to use as the answer.
     *
     * Only doc formats, only files this run created/modified, largest first (a
     * run can also touch a small README). Best-effort: any failure just leaves
     * the caller to fall back to the synthesized report.
     *
     * @param {Array<{path:string, action:string}>} files
     * @returns {Promise<string>} the report body, or ''
     */
    async _readReportDeliverable(files) {
        const candidates = (files || []).filter(f => this._isReportOnlyFile(f.path));
        if (!candidates.length) return '';
        let best = '';
        for (const f of candidates.slice(0, 5)) {
            try {
                const text = String(await invoke('read_file', { path: f.path }) || '').trim();
                // Too short to be the deliverable — probably a stub or a heading.
                if (text.length >= DELIVERABLE_MIN_CHARS && text.length > best.length) best = text;
            } catch (_) { /* unreadable → not a deliverable */ }
        }
        if (!best) return '';
        // Cap: the result view renders this inline, and a 500 KB dump helps nobody.
        return best.length > 40000 ? `${best.slice(0, 40000)}

…（以下省略）` : best;
    }

    /**
     * Paths this run READ, workspace-relative where possible.
     *
     * Handed to the auditor so it can see the SHAPE of the investigation, not
     * just its conclusion. An answer about screen behaviour whose entire read
     * list is templates has stopped at a layer boundary, and that is visible
     * here even when every individual statement in the answer is true.
     */
    _filesReadThisRun() {
        const root = String(this.toolExecutor?.workspacePath || '').replace(/\\/g, '/');
        const out = [];
        for (const raw of (this.toolExecutor?.readFiles || [])) {
            const p = String(raw).replace(/\\/g, '/');
            out.push(root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
        }
        return out;
    }

    _isReportOnlyFile(path) {
        const ext = String(path || '').toLowerCase().split('.').pop();
        return ['md', 'markdown', 'txt', 'text', 'rst', 'adoc', 'csv', 'tsv'].includes(ext);
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

    /**
     * Feed a phase event to the router and, if it moved the run to a different
     * tier, swap the model for the calls that follow.
     *
     * Cheap and idempotent — call it freely from the loop. When phase routing is
     * off it returns immediately, so no caller needs to guard.
     *
     * @param {'step'|'mutation'|'plan-done'|'finish'|'reopen'} event
     * @param {{iteration?: number, planFirstPending?: boolean}} [ctx]
     * @param {Function} [onAgentStatus]
     */
    _phaseEvent(event, ctx = {}, onAgentStatus = null) {
        if (!this._phaseRouting) return;
        const next = advancePhase(this._phase, event, ctx);
        const tiers = { fast: this._fastModelId, deep: this._deepModelId };
        const model = modelForPhase(next, tiers, {
            enabled: true,
            escalated: this._phaseEscalated,
        });
        const moved = next !== this._phase;
        const swapped = !!model && model !== this._modelOverride;
        this._phase = next;
        if (!swapped) return;
        const from = this._modelOverride;
        this._modelOverride = model;
        // WHY this switch happened. The event names alone say nothing a person
        // can act on; these strings are the trigger spelled out. `step` is
        // overloaded: it both releases the deep model at the plan cap and (when
        // escalation is on) promotes a struggling execute to deep, so the reason
        // has to distinguish the two.
        const reason = this._phaseEscalated && next === 'execute'
            ? `step ${ctx.iteration ?? 0} 到達 — 長い実行で fast が苦戦、execute を deep に昇格`
            : {
                step: `plan の step 上限 (${PLAN_PHASE_MAX_STEPS}+) を超過 → execute へ`,
                mutation: 'ファイル変更ツールが実行された → execute へ',
                'plan-done': '計画が登録/承認された → execute へ',
                finish: 'finish_task — 検収(review)に入るため deep へ',
                reopen: 'レビュー差し戻し — 修正は実行フェーズ(実行は fast)へ',
            }[event] || String(event);
        // A STRUCTURED event as well as the human line. The Dashboard draws a
        // phase rail from this; parsing it back out of a Japanese status string
        // would break the first time anyone reworded the message.
        onAgentStatus?.({
            event: 'phase',
            phase: next,
            model,
            from: from || null,
            escalated: this._phaseEscalated,
            reason,
            tokens: { ...this._phaseTokens },
        });
        // Announce only a real model change: the phase names alone would be noise
        // in the status feed, and what the user is paying for is the model.
        onAgentStatus?.({
            event: 'status', status: 'running',
            message: moved
                ? `🧭 ${phaseLabel(next)} へ — モデル切替: ${from || '(active)'} → ${model}`
                : `🧭 モデル切替: ${from || '(active)'} → ${model}`,
        });
    }

    /**
     * Attribute one call's tokens to the phase that spent them, so the end-of-run
     * report can show WHERE the money went rather than one blended total. The
     * point of phase routing is a cost claim, and a cost claim needs evidence.
     */
    _recordPhaseTokens(usage) {
        if (!this._phaseRouting || !usage) return;
        const n = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        if (n > 0) this._phaseTokens[this._phase] = (this._phaseTokens[this._phase] || 0) + n;
    }

    _applyIntent() {
        const b = this.behaviorOverrides;
        if (!b || !b.intent) return;
        // A string is an id declared by the calling app when it connected; an
        // object is an ad-hoc definition. Both expand the same way from here.
        const { intent, source } = resolveIntent(b.intent, intentRegistry);
        if (!intent) {
            if (source === 'unknown') {
                console.warn(`AI: behavior.intent "${b.intent}" is not registered — running without it.`);
            }
            return;
        }

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
        // Tier: an explicit args.model wins, then the role preset. EXCEPT the
        // reviewer under phase routing — the independent review IS the review
        // phase, and the whole trade is "cheap execution, expensive checking".
        // Reviewing a cheap model's work with the same cheap model would give up
        // the safety half of the bargain while keeping all of its risk.
        const tier = (args?.model === 'deep' || args?.model === 'fast')
            ? args.model
            : ((this._phaseRouting && roleDef.id === 'reviewer') ? 'deep' : roleDef.tier);

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
        onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.subtask.start', { label, brief: brief.slice(0, 100).replace(/\s+/g, ' ') }, `🤖 [${label}] 起動: ${brief.slice(0, 100).replace(/\s+/g, ' ')}…`) });

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
                onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.subtask.serialized', { label }, `🤖 [${label}] ⏳ 書き込み範囲が他のサブタスクと重複 — 先行の完了を待機 (serialized)`) });
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
            onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.subtask.done', { label }, `🤖 [${label}] 完了 ✅`) });
            return `[Sub-agent report — role: ${roleDef.id}]\n${report}` +
                (files.length ? `\n\nFiles modified by the sub-agent:\n${files.map(p => '- ' + p).join('\n')}` : '');
        } catch (e) {
            onAgentStatus?.({ event: 'status', status: 'running', message: t('agent.subtask.failed', { label, error: e?.message || e }, `🤖 [${label}] 失敗: ${e?.message || e}`) });
            return `Error: sub-task (${roleDef.id}) failed: ${e?.message || e}`;
        } finally {
            this._subtaskActive--;
            this._writeClaims.delete(label);   // release the write-ownership claim
        }
    }

    /**
     * Is this request genuinely multi-step change work?
     *
     * One definition, in agent/TaskComplexity.js. There used to be a second copy
     * here, kept as "@deprecated … for callers/tests" — but no test referenced it
     * and THREE production decisions still ran on it (phase routing's opening
     * model, `includeTaskTools`, the step-1 planning injection), while only the
     * plan-first gate had moved to the new one.
     *
     * That mattered because the copy here was the OLD heuristic, whose failure
     * mode TaskComplexity.js was written to fix: it fired on any Japanese request
     * over 60 characters containing a common verb (対応/修正/確認), i.e. on almost
     * every ordinary request in this product's primary language. Under phase
     * routing that meant a polite two-sentence ask STARTED on the deep tier —
     * exactly inverting the feature that exists to move work onto the cheap one.
     */
    _looksComplex(prompt) {
        return looksComplex(prompt);
    }
}
