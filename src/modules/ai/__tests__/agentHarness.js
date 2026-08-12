// agentHarness — drives the REAL AgentController.run() loop against a scripted
// mock LLM, so the agent's decision logic can be tested without a provider, a
// workspace, or Tauri.
//
// Why this exists: the pure helpers (LoopDetector / SafetyLimits / ResponseParser
// / SubagentRoles) are well covered, but the ~1,300-line loop that USES them —
// plan-first gating, the review gate, budget exhaustion, compression, resume —
// had no test at all. That is exactly where behaviour regressions hide.
//
// Usage:
//   const h = makeHarness({ script: [ toolStep('read_file', {path:'a'}), finishStep('done') ] });
//   const res = await h.run('do the thing');
//   expect(h.toolCalls.map(c => c.name)).toEqual(['read_file', 'finish_task']);
//
// The mock LLM is a SCRIPT: an ordered list of turns. Each turn is either a
// canned tool-call envelope or plain text. When the script runs out, the agent
// is told to finish, so a mis-scripted test terminates instead of spinning.

import { vi } from 'vitest';

// ── Script builders ────────────────────────────────────────────────────────

/** One assistant turn that calls `name` with `args` (optionally several). */
export function toolStep(name, args = {}, thought = '') {
    return { thought, tool_calls: [{ name, args }] };
}

/** One assistant turn issuing several tool calls at once (parallel step). */
export function multiToolStep(calls, thought = '') {
    return { thought, tool_calls: calls.map(([name, args = {}]) => ({ name, args })) };
}

/** The finishing turn. */
export function finishStep(summary = 'done') {
    return toolStep('finish_task', { summary });
}

/** A text-only turn (no tool call) — the agent pushes back on these. */
export function textStep(text) {
    return { __text: text };
}

// ── Harness ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   script          array of turns (see builders above)
 *   toolResults     name → (args) => string | { result, isError }
 *   permissions     name → 'Allow' | 'Ask' | 'Deny'   (default Allow)
 *   config          object returned by the mocked `get_ai_config` invoke
 *   caller          e.g. 'NewTask' (plan-first only applies to interactive callers)
 *   nativeTools     whether the model claims native tool-calling (default true)
 *   invokeResults   cmd → value | (args) => value, for the loop's OWN Tauri calls
 *                   (memory files, artifacts) as opposed to tool results
 */
export function makeHarness(opts = {}) {
    const {
        script = [finishStep()],
        toolResults = {},
        permissions = {},
        config = {},
        caller = 'Test',
        nativeTools = true,
        vision = false,
        /** cmd → value | (args) => value, for the loop's own Tauri calls. */
        invokeResults = {},
    } = opts;

    const state = {
        /** Every tool the agent actually executed, in order. */
        toolCalls: [],
        /** Every onAgentStatus event the loop emitted. */
        events: [],
        /** Every Tauri `invoke` the loop made: { cmd, args }. */
        invokeCalls: [],
        /** System prompts handed to the LLM, one per call. */
        prompts: [],
        /** The history array as seen by each LLM call. */
        histories: [],
        /** The `images` argument of each LLM call, one entry per call. */
        imagesPerCall: [],
        /** The model OVERRIDE passed to each LLM call — null = the active model.
            This is what tier / phase routing actually moves, so it is the only
            way to assert that a run switched models mid-task. */
        modelsPerCall: [],
        /** How many times the mock LLM was asked for a turn. */
        llmCalls: 0,
        /** Files the fake ToolExecutor recorded as modified. */
        modifiedFiles: [],
        /** Set when the agent asks the user something (ask_user). */
        awaitingUser: false,
        userQuestion: '',
    };

    let cursor = 0;
    const nextTurn = () => {
        state.llmCalls++;
        // Script exhausted → tell the agent to wrap up (prevents runaway loops
        // in a mis-written test).
        if (cursor >= script.length) return finishStep('script exhausted');
        return script[cursor++];
    };

    /** Render a scripted turn into the JSON envelope the loop parses. */
    const renderTurn = (turn) => {
        if (turn && turn.__text !== undefined) return turn.__text;
        return JSON.stringify({ thought: turn.thought || '', tool_calls: turn.tool_calls || [] });
    };

    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    // ── mock conversationMemory ────────────────────────────────────────
    // Exposed on the harness so a test can make `addEntry` hang: the run must
    // finish without it, since long-term memory is recorded off the result path.
    const conversationMemory = {
        loadMemory: vi.fn(async () => {}),
        addEntry: vi.fn(async () => {}),
        setBudgetConfig: vi.fn(),
        // Identity compaction — the loop's own compression still runs.
        compactHistory: vi.fn(async (history) => history),
    };

    // ── mock llmService ────────────────────────────────────────────────
    const llmService = {
        initFromConfig: vi.fn(async () => {}),
        supportsNativeTools: vi.fn(() => nativeTools),
        getCurrentProvider: vi.fn(() => 'mock'),
        getCurrentModel: vi.fn(() => 'mock-model'),
        getCurrentTemperature: vi.fn(() => 0.2),
        getEffectiveModelLimit: vi.fn(() => 128000),
        modelSupportsVision: vi.fn(() => vision),
        currentMaxOutputTokens: 4096,
        generate: vi.fn(async () => 'generated'),
        // JSON-protocol path: returns the envelope as text.
        chat: vi.fn(async (history, systemPrompt, _onStream, _signal, images = [], _temp = null, model = null) => {
            state.prompts.push(systemPrompt);
            state.histories.push(JSON.parse(JSON.stringify(history)));
            state.imagesPerCall.push([...(images || [])]);
            state.modelsPerCall.push(model || null);
            return { content: renderTurn(nextTurn()), usage };
        }),
        // Native path: returns structured toolCalls.
        chatWithTools: vi.fn(async (history, systemPrompt, _tools, _signal, images = [], _temp = null, model = null) => {
            state.prompts.push(systemPrompt);
            state.histories.push(JSON.parse(JSON.stringify(history)));
            state.imagesPerCall.push([...(images || [])]);
            state.modelsPerCall.push(model || null);
            const turn = nextTurn();
            if (turn && turn.__text !== undefined) {
                return { content: turn.__text, toolCalls: null, usage };
            }
            return {
                content: turn.thought || '',
                toolCalls: (turn.tool_calls || []).map((c, i) => ({
                    id: `call_${state.llmCalls}_${i}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                })),
                usage,
            };
        }),
    };

    // ── fake ToolExecutor ──────────────────────────────────────────────
    // Same public surface the loop touches; records calls and returns canned
    // results. finish_task / ask_user drive the loop's exit paths.
    let taskCompleted = false;
    const toolExecutor = {
        workspacePath: '.',
        toolDefinitions: [
            { name: 'read_file' }, { name: 'write_file' }, { name: 'run_command' },
            { name: 'grep_search' }, { name: 'glob' }, { name: 'list_files' },
            { name: 'present_result' }, { name: 'ask_user' }, { name: 'finish_task' },
            { name: 'task_progress' },
        ],
        _mcpBypassesAllowlist: false,
        startSession: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        getCurrentSessionId: () => 'sess_test',
        getSessionArtifactDir: () => '.agent/artifacts',
        getFileCache: () => new Map(),
        getToolsForNativeAPI: () => [],
        setToolAllowlist: vi.fn(),
        setMcpServerFilter: vi.fn(),
        setMcpContext: vi.fn(),
        setMcpRelevanceQuery: vi.fn(),
        setSubtaskRunner: vi.fn(),
        setWriteScope: vi.fn(),
        onToolEvent: null,
        // Images a tool produced. Tests push onto `pendingImages` (as a handler
        // would) to exercise the attach path; the loop drains it each step.
        pendingImages: [],
        drainImages() {
            const out = this.pendingImages;
            this.pendingImages = [];
            return out;
        },
        _recordModification: vi.fn(),
        getPermissionLevel: (name) => permissions[name] || 'Allow',
        getModifiedFiles: () => state.modifiedFiles,
        isTaskCompleted: () => taskCompleted,
        resetTaskCompleted: () => { taskCompleted = false; },
        isAwaitingUser: () => state.awaitingUser,
        getUserQuestion: () => state.userQuestion,
        getUserQuestionOptions: () => [],
        getUserQuestionMulti: () => false,
        executeTool: vi.fn(async (call) => {
            state.toolCalls.push({ name: call.name, args: call.args });
            if (call.name === 'finish_task') {
                taskCompleted = true;
                return `Task marked complete: ${call.args?.summary || ''}`;
            }
            if (call.name === 'ask_user') {
                state.awaitingUser = true;
                state.userQuestion = call.args?.question || '';
                return 'Paused for user input.';
            }
            if (call.name === 'write_file') {
                state.modifiedFiles.push({ path: call.args?.path || 'out.txt', original: null });
            }
            const canned = toolResults[call.name];
            if (typeof canned === 'function') return canned(call.args || {});
            if (typeof canned === 'string') return canned;
            return `${call.name} ok`;
        }),
    };

    /** Build the AgentController with all singletons mocked out. */
    async function build() {
        vi.resetModules();

        vi.doMock('@tauri-apps/api/core', () => ({
            invoke: vi.fn(async (cmd, args) => {
                // Recorded so a test can assert on the loop's own side effects
                // (e.g. the session failure trace) and not just on tool calls.
                state.invokeCalls.push({ cmd, args });
                if (cmd === 'get_ai_config') return config;
                const canned = invokeResults[cmd];
                if (canned !== undefined) return typeof canned === 'function' ? canned(args) : canned;
                return null;
            }),
        }));
        vi.doMock('../LLMService.js', () => ({ default: llmService }));
        vi.doMock('../ContextBuilder.js', () => ({
            contextBuilder: {
                getSystemPrompt: vi.fn(async () => 'SYSTEM PROMPT'),
                invalidateStaticCache: vi.fn(),
            },
            ContextBuilder: { getJsonModeProtocol: () => 'JSON PROTOCOL' },
        }));
        vi.doMock('../ConversationMemory.js', () => ({ conversationMemory }));
        vi.doMock('../TokenEstimator.js', () => ({
            tokenEstimator: {
                estimateTokens: () => 100,
                estimateConversation: () => ({ totalTokens: 100 }),
                getModelLimit: () => 128000,
            },
        }));

        const { AgentController } = await import('../AgentController.js');
        const agent = new AgentController();
        agent.toolExecutor = toolExecutor;   // replace the real (Tauri-backed) one
        agent.caller = caller;
        return agent;
    }

    /**
     * Run the loop. Extra `runOpts` are merged over the positional defaults:
     *   { chatContext, onConfirm, abortSignal, images, clientContext }
     */
    async function run(prompt = 'test task', runOpts = {}) {
        const agent = await build();
        state.agent = agent;
        const onAgentStatus = (e) => state.events.push(e);
        const result = await agent.run(
            prompt,
            runOpts.workspacePath ?? '.',
            runOpts.onUpdate ?? (() => {}),
            onAgentStatus,
            runOpts.onConfirm ?? (async () => true),
            runOpts.clientContext ?? null,
            runOpts.chatContext ?? [],
            runOpts.onLog ?? ((l) => state.events.push({ event: 'log', log: l })),
            runOpts.abortSignal ?? null,
            runOpts.kisContext ?? '',
            runOpts.images ?? [],
        );
        return result;
    }

    return {
        run,
        build,
        state,
        llmService,
        conversationMemory,
        toolExecutor,
        get toolCalls() { return state.toolCalls; },
        get events() { return state.events; },
        get invokeCalls() { return state.invokeCalls; },
        /** The model override used for each LLM call, in order. */
        get modelsPerCall() { return state.modelsPerCall; },
        /** Status messages only — handy for asserting gates fired. */
        messages() { return state.events.map(e => e.message).filter(Boolean); },
        /** True if any status message matches. */
        sawMessage(re) { return this.messages().some(m => re.test(m)); },
    };
}

// ── Stage 5: A/B comparison of compression policies ────────────────────────
// The harness makes a task REPRODUCIBLE (same script, same tool results), so the
// same run can be replayed under different settings and the cost compared. This
// is what turns "compression feels wasteful" into a number.

/**
 * Run one scripted task and return the numbers that matter for policy tuning.
 * @param {object} opts makeHarness options (script / toolResults / config / …)
 * @returns {Promise<{llmCalls:number, toolCalls:number, promptTokens:number,
 *                    efficiency:object|null, compression:object|null}>}
 */
export async function measureRun(opts = {}) {
    const h = makeHarness(opts);
    await h.run(opts.prompt || 'measured task');
    const report = h.events
        .map(e => e.log)
        .find(l => l && l.stepLabel === '📊 Efficiency Report');
    const eff = report?.response || null;
    return {
        llmCalls: h.state.llmCalls,
        toolCalls: h.state.toolCalls.length,
        promptTokens: eff?.prompt_tokens ?? 0,
        efficiency: eff,
        compression: eff?.compression_quality ?? null,
        messages: h.messages(),
    };
}

/**
 * Run the SAME task under two configs and diff the outcome.
 * @param {object} base   makeHarness options shared by both arms
 * @param {object} configA extra `config` for arm A
 * @param {object} configB extra `config` for arm B
 */
export async function compareRuns(base, configA, configB) {
    const a = await measureRun({ ...base, config: { ...(base.config || {}), ...configA } });
    const b = await measureRun({ ...base, config: { ...(base.config || {}), ...configB } });
    return {
        a, b,
        deltaLlmCalls: b.llmCalls - a.llmCalls,
        deltaToolCalls: b.toolCalls - a.toolCalls,
        deltaInduced: (b.compression?.compression_induced_re_reads ?? 0)
                    - (a.compression?.compression_induced_re_reads ?? 0),
        deltaNetCharsSaved: (b.compression?.net_chars_saved ?? 0)
                          - (a.compression?.net_chars_saved ?? 0),
    };
}
