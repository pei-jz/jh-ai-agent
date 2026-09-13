// Integration tests for the REAL AgentController.run() loop, driven by a
// scripted mock LLM (see agentHarness.js). These are the first tests to cover
// the loop itself — gates, budgets, tool dispatch and termination.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, toolStep, multiToolStep, finishStep, textStep, compareRuns } from './agentHarness.js';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

describe('agent loop — basic execution', () => {
    it('runs the scripted tool calls in order and terminates on finish_task', async () => {
        const h = makeHarness({
            script: [
                toolStep('read_file', { path: 'a.js' }, 'reading'),
                toolStep('grep_search', { query: 'foo' }),
                // A SUBSTANTIVE summary counts as the deliverable, so the run ends
                // here (a thin one triggers the deliverable nudge — tested below).
                finishStep('結論: '.padEnd(500, '詳細')),
            ],
        });
        await h.run('do the thing');
        expect(h.toolCalls.map(c => c.name)).toEqual(['read_file', 'grep_search', 'finish_task']);
    });

    it('bounces a finish_task that produced NO deliverable, then accepts the retry', async () => {
        // Thin summary + no present_result + no file changes → the loop pushes
        // back once ("[Deliverable Missing]") instead of completing silently.
        const h = makeHarness({
            script: [finishStep('done'), finishStep('done again')],
        });
        await h.run();
        expect(h.toolCalls.map(c => c.name)).toEqual(['finish_task', 'finish_task']);
        expect(h.sawMessage(/成果物|deliverable/i)).toBe(true);
    });

    it('passes the tool result back so the next turn sees it in history', async () => {
        const h = makeHarness({
            script: [toolStep('read_file', { path: 'a.js' }), finishStep()],
            toolResults: { read_file: () => 'FILE-CONTENT-MARKER' },
        });
        await h.run();
        // The 2nd LLM call must have been given the first call's result.
        const secondCallHistory = JSON.stringify(h.state.histories[1] || []);
        expect(secondCallHistory).toContain('FILE-CONTENT-MARKER');
    });

    it('executes several tool calls issued in one turn', async () => {
        const h = makeHarness({
            script: [
                multiToolStep([['read_file', { path: 'a' }], ['read_file', { path: 'b' }]]),
                finishStep(),
            ],
        });
        await h.run();
        expect(h.toolCalls.filter(c => c.name === 'read_file')).toHaveLength(2);
    });

    it('serializes two same-file writes issued in one parallel turn (P5 conflict detection)', async () => {
        // Both calls are "Allow", so they would normally race in Promise.all.
        // The conflict detector must pull the SECOND write into the serial
        // phase — but both still execute, in order.
        const h = makeHarness({
            script: [
                multiToolStep([
                    ['write_file', { path: 'C:/a.js', content: 'v1' }],
                    ['write_file', { path: 'C:/a.js', content: 'v2' }],
                ]),
                finishStep(),
            ],
        });
        await h.run();
        const writes = h.toolCalls.filter(c => c.name === 'write_file' && c.args?.path === 'C:/a.js');
        expect(writes).toHaveLength(2);
        expect(writes[0].args.content).toBe('v1');
        expect(writes[1].args.content).toBe('v2');
        // The user was told WHY one call ran after the other.
        expect(h.events.some(e => e.message && e.message.includes('順次実行'))).toBe(true);
        // …and BOTH calls are visible in the timeline. The serialized one used to
        // skip its tool_call event, so it ran without ever appearing in Monitor.
        const callEvents = h.events.filter(e => e.event === 'tool_call' && e.name === 'write_file');
        expect(callEvents).toHaveLength(2);
    });

    it('keeps different-file writes in parallel (no serialization notice)', async () => {
        const h = makeHarness({
            script: [
                multiToolStep([
                    ['write_file', { path: 'C:/a.js' }],
                    ['write_file', { path: 'C:/b.js' }],
                ]),
                finishStep(),
            ],
        });
        await h.run();
        expect(h.events.some(e => e.message && e.message.includes('順次実行'))).toBe(false);
    });

    it('surfaces a tool error to the agent instead of throwing', async () => {
        const h = makeHarness({
            script: [toolStep('read_file', { path: 'missing' }), finishStep()],
            toolResults: { read_file: () => 'Error: file not found' },
        });
        await h.run();
        expect(JSON.stringify(h.state.histories[1] || [])).toContain('Error: file not found');
        expect(h.toolCalls.map(c => c.name)).toContain('finish_task');
    });

    it('stops without running tools when the task is aborted up front', async () => {
        const h = makeHarness({ script: [toolStep('read_file', { path: 'a' }), finishStep()] });
        const ac = new AbortController();
        ac.abort();
        await h.run('x', { abortSignal: ac.signal });
        expect(h.toolCalls).toHaveLength(0);
    });
});

describe('agent loop — permission model', () => {
    it('does NOT execute a tool the permission model denies', async () => {
        const h = makeHarness({
            script: [toolStep('run_command', { command: 'rm -rf /' }), finishStep()],
            permissions: { run_command: 'Deny' },
        });
        await h.run();
        expect(h.toolCalls.map(c => c.name)).not.toContain('run_command');
    });

    it('routes an "Ask" tool through the confirmation callback', async () => {
        const onConfirm = vi.fn(async () => true);
        const h = makeHarness({
            script: [toolStep('run_command', { command: 'npm test' }), finishStep()],
            permissions: { run_command: 'Ask' },
        });
        await h.run('x', { onConfirm });
        // The tool still ran (approved) and went through the dangerous-call path.
        expect(h.toolCalls.map(c => c.name)).toContain('run_command');
    });
});

// ONE definition of "complex", shared with the plan-first gate. There used to be
// a second, laxer copy on AgentController driving the step-1 planning injection,
// `includeTaskTools` and phase routing's opening model — so a polite Japanese
// request over 60 characters was "complex" for those three and "not complex" for
// the gate. These tests pin the two ends of that disagreement.
describe('agent loop — complexity heuristic is shared with TaskComplexity', () => {
    // The exact shape the old 60-char Japanese rule fired on.
    const ordinary = 'モニター画面のタスク一覧について、先頭以外はデフォルトで閉じた状態にする対応をお願いします';

    it('does NOT inject the planning instruction for an ordinary Japanese request', async () => {
        const h = makeHarness({ script: [finishStep('done'.padEnd(500, '.'))] });
        await h.run(ordinary);
        const firstCall = JSON.stringify(h.state.histories[0] || []);
        expect(firstCall).not.toContain('[Planning Required]');
    });

    it('still injects it for genuinely enumerated multi-step work', async () => {
        const h = makeHarness({ script: [finishStep('done'.padEnd(500, '.'))] });
        await h.run('1. 認証を実装\n2. テストを追加\n3. ドキュメント更新');
        const firstCall = JSON.stringify(h.state.histories[0] || []);
        expect(firstCall).toContain('[Planning Required]');
    });
});

// A sub-agent is JHAI's own work one level down, not an external app. It used to
// satisfy both halves of the external test (caller 'Subagent' is not in the
// interactive list, and _runSubtask passes `intent: {tier}` for model routing),
// which turned OFF the two things that keep a child's context small.
describe('agent loop — a sub-agent is not an external caller', () => {
    async function runAsSubagent(h) {
        const agent = await h.build();
        agent.caller = 'Subagent';
        agent._isSubagent = true;
        agent.behaviorOverrides = {
            enabled_tools: ['read_file', 'finish_task'],
            max_iterations: 5,
            intent: { tier: 'fast' },     // what made it look external
        };
        await agent.run('sub-task brief', '.', () => {}, () => {}, async () => true,
            null, [], null, null, '', []);
        return agent;
    }

    it('classifies itself as internal', async () => {
        const h = makeHarness({ script: [finishStep('report'.padEnd(500, '.'))] });
        const agent = await runAsSubagent(h);
        expect(agent._isExternalCaller).toBe(false);
    });

    it('hides the connected app\'s live-editor MCP tools', async () => {
        const h = makeHarness({ script: [finishStep('report'.padEnd(500, '.'))] });
        const agent = await runAsSubagent(h);
        const calls = agent.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(([on]) => on === true)).toBe(true);
    });

    it('keeps MCP relevance pruning on, so a big server cannot flood the child', async () => {
        const h = makeHarness({ script: [finishStep('report'.padEnd(500, '.'))] });
        const agent = await runAsSubagent(h);
        const [[query]] = agent.toolExecutor.setMcpRelevanceQuery.mock.calls;
        expect(query).toBe('sub-task brief');
    });
});

describe('agent loop — plan-first gate', () => {
    // Plan-first only engages for interactive callers on a fresh, complex turn.
    const complexPrompt = 'リファクタリングして、全体のアーキテクチャを見直し、テストも追加してください';

    it('blocks edits/commands until the plan is approved (interactive caller)', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [
                toolStep('write_file', { path: 'a.js', content: 'x' }),  // должен be blocked
                toolStep('present_result', { kind: 'markdown', markdown: '## ゴール' }),
                finishStep(),
            ],
        });
        await h.run(complexPrompt);
        expect(h.toolCalls.map(c => c.name)).not.toContain('write_file');
        expect(h.sawMessage(/計画承認待ち|Plan-first|計画優先/)).toBe(true);
    });

    it('allows READ-ONLY shell commands through while planning', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [toolStep('run_command', { command: 'git status' }), finishStep()],
        });
        await h.run(complexPrompt);
        expect(h.toolCalls.map(c => c.name)).toContain('run_command');
    });

    it('still blocks a MUTATING shell command while planning', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [toolStep('run_command', { command: 'npm install left-pad' }), finishStep()],
        });
        await h.run(complexPrompt);
        expect(h.toolCalls.map(c => c.name)).not.toContain('run_command');
    });

    it('does not gate a non-interactive caller (would deadlock — nobody to approve)', async () => {
        const h = makeHarness({
            caller: 'Schedule',
            config: { plan_mode: 'always' },
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run(complexPrompt);
        expect(h.toolCalls.map(c => c.name)).toContain('write_file');
    });

    it('a bypass phrase skips the gate', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run('計画不要、そのまま実装して: ' + complexPrompt);
        expect(h.toolCalls.map(c => c.name)).toContain('write_file');
    });

    it('a continuation turn (chatContext present) is the approval — edits proceed', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run('はい、実装して', { chatContext: [{ role: 'user', content: 'prior' }] });
        expect(h.toolCalls.map(c => c.name)).toContain('write_file');
    });

    it('a REVISION reply re-opens the gate — the plan is re-presented, not implemented', async () => {
        // The reported bug: picking "修正したい" (request changes) sent the option
        // text as the continuation, and because any continuation used to proceed
        // straight to editing, the agent started implementing instead of revising
        // the plan. A revision turn must BLOCK edits again until the revised plan
        // is approved.
        const h = makeHarness({
            caller: 'NewTask',
            config: { plan_mode: 'always' },
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run('✏️ 計画修正: 変更対象ファイルを絞ってください', { chatContext: [{ role: 'user', content: 'prior' }] });
        expect(h.toolCalls.map(c => c.name)).not.toContain('write_file');
        expect(h.sawMessage(/計画承認待ち|Plan-first|計画優先/)).toBe(true);
    });
});

describe('agent loop — external-app (WS) MCP tool exclusion', () => {
    it('re-applies the WS exclusion AFTER startSession for JHAI-OWNED tasks', async () => {
        // Regression: run() set `setExcludeExternalAppMcpTools(true)` for a
        // NewTask, but ToolExecutor.startSession() RESET the flag to false and
        // nothing re-set it — so every task offered the connected external
        // app's WS MCP tools (JHEditor read_workspace_file / …) to the LLM.
        const h = makeHarness({
            caller: 'NewTask',
            script: [finishStep('done')],
        });
        await h.run('do the thing');
        const calls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(2);  // pre + post startSession
        // The LAST call (post-startSession, the one that wins) must exclude.
        expect(calls[calls.length - 1][0]).toBe(true);
    });

    it('leaves the flag OFF for external callers (they need their own tools)', async () => {
        const h = makeHarness({
            caller: 'JHEditor',
            script: [finishStep('done')],
        });
        await h.run('do the thing');
        const calls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        // External callers keep app tools — the last (winning) call must be false.
        expect(calls[calls.length - 1][0]).toBe(false);
    });

    it('calls the exclusion AFTER startSession so the session reset cannot clobber it', async () => {
        const h = makeHarness({
            caller: 'NewTask',
            script: [finishStep('done')],
        });
        await h.run('do the thing');
        const startSessionCalls = h.toolExecutor.startSession.mock.invocationCallOrder;
        const exclCalls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.invocationCallOrder;
        expect(startSessionCalls.length).toBe(1);
        // Every setExclude call happens BEFORE startSession in code, but the
        // RE-APPLY must come AFTER it — assert the last one does.
        const lastExcl = exclCalls[exclCalls.length - 1];
        expect(lastExcl).toBeGreaterThan(startSessionCalls[0]);
    });

    it('does NOT treat behavior.mcp_servers as an external-caller marker (interactive pick)', async () => {
        // Regression: NewTask/Schedule pass the user's MCP-server selection via
        // behavior.mcp_servers. That used to flip isExternalCaller=true, which
        // stripped the built-in toolset AND kept the WS-app MCP tools advertised
        // (so get_space_activities & co kept leaking into the request).
        const h = makeHarness({
            caller: 'NewTask',
            script: [finishStep('done')],
        });
        const agent = await h.build();
        agent.behaviorOverrides = { mcp_servers: ['backlog'] };
        // A build needs a workspace now (RunLane); the test is about MCP scope.
        await agent.run('do the thing', 'C:/w');
        const calls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        // JHAI-owned task → exclusion ON (the winning last call must be true).
        expect(calls[calls.length - 1][0]).toBe(true);
        // The MCP server filter is still applied — the selection reaches the
        // tool executor through the normal path.
        const filterCalls = h.toolExecutor.setMcpServerFilter.mock.calls;
        expect(filterCalls.length).toBeGreaterThanOrEqual(1);
        expect(filterCalls[filterCalls.length - 1][0]).toEqual(['backlog']);
        // And the run itself completes.
        expect(h.toolCalls.map(c => c.name)).toContain('finish_task');
    });

    // behavior.intent used to force the external path. Intents are gone; the
    // caller name, through the lane, is the only thing that decides.
    it('an intent no longer makes a run external', async () => {
        const h = makeHarness({ caller: 'NewTask', script: [finishStep('done')] });
        const agent = await h.build();
        agent.behaviorOverrides = { intent: { tier: 'fast' } };
        await agent.run('do the thing', 'C:/w');
        expect(agent._isExternalCaller).toBe(false);
    });
});

describe('agent loop — ask_user pause', () => {
    it('pauses the run when the agent asks the user a question', async () => {
        const h = makeHarness({
            script: [toolStep('ask_user', { question: 'どちらにしますか？' }), finishStep()],
        });
        await h.run();
        // The loop exits on ask_user — finish_task is never reached.
        expect(h.toolCalls.map(c => c.name)).toEqual(['ask_user']);
        expect(h.state.awaitingUser).toBe(true);
    });
});

describe('agent loop — text-only pushback', () => {
    it('pushes back when the model replies without calling a tool', async () => {
        const h = makeHarness({
            script: [textStep('I think we should probably do X.'), finishStep()],
        });
        await h.run();
        // It recovered and still finished (the loop re-prompts rather than exiting).
        expect(h.toolCalls.map(c => c.name)).toContain('finish_task');
        expect(h.state.llmCalls).toBeGreaterThan(1);
    });
});

describe('agent loop — safety limits', () => {
    it('stops at the configured max step count', async () => {
        // Script never finishes: 30 read_file turns, but max_steps caps it.
        const script = Array.from({ length: 30 }, (_, i) => toolStep('read_file', { path: `f${i}.js` }));
        const h = makeHarness({ script, config: { max_steps: 3 } });
        await h.run();
        expect(h.state.llmCalls).toBeLessThanOrEqual(5);   // cap + a little slack
        expect(h.toolCalls.length).toBeLessThan(30);
    });

    it('stops when the token budget is exhausted', async () => {
        const script = Array.from({ length: 30 }, (_, i) => toolStep('read_file', { path: `f${i}.js` }));
        // Each mock call reports 15 tokens; a 20-token budget dies almost at once.
        const h = makeHarness({ script, config: { token_budget: 20 } });
        await h.run();
        expect(h.toolCalls.length).toBeLessThan(30);
        expect(h.sawMessage(/budget|予算|token/i)).toBe(true);
    });
});

describe('agent loop — model attribution (③)', () => {
    it('reports the model that produced each token_usage event', async () => {
        const h = makeHarness({ script: [toolStep('read_file', { path: 'a' }), finishStep()] });
        await h.run();
        const usage = h.events.filter(e => e.event === 'token_usage');
        expect(usage.length).toBeGreaterThan(0);
        expect(usage[0].model).toBe('mock-model');
    });
});

describe('agent loop — efficiency + compression quality (⑤)', () => {
    it('emits the efficiency report with the compression-quality block', async () => {
        const h = makeHarness({
            script: [
                toolStep('read_file', { path: 'a.js' }),
                toolStep('read_file', { path: 'a.js' }),   // re-read
                finishStep(),
            ],
            toolResults: { read_file: () => 'x'.repeat(500) },
        });
        await h.run();
        const report = h.events
            .map(e => e.log)
            .find(l => l && l.stepLabel === '📊 Efficiency Report');
        expect(report).toBeTruthy();
        expect(report.response.re_reads).toBe(1);
        expect(report.response.compression_quality).toBeTruthy();
        // No compression ran, so the re-read is the agent's own redundancy.
        expect(report.response.compression_quality.compression_induced_re_reads).toBe(0);
        expect(report.response.compression_quality.quality).toBe('n/a');
    });
});

// ── Stage 5: compression A/B (made possible by the mock-LLM harness) ───────
describe('compression policy A/B comparison', () => {
    // Same script, same tool results, two different compression settings —
    // the only thing that can differ is what the policy costs.
    const base = {
        script: [
            toolStep('read_file', { path: 'a.js' }),
            toolStep('read_file', { path: 'b.js' }),
            toolStep('read_file', { path: 'a.js' }),   // re-read
            finishStep('結論: '.padEnd(500, '詳細')),
        ],
        toolResults: { read_file: () => 'x'.repeat(2000) },
    };

    it('produces a comparable measurement for each arm', async () => {
        const { a, b } = await compareRuns(base, { history_compress_ratio: 0.9 }, { history_compress_ratio: 0.1 });
        for (const arm of [a, b]) {
            expect(arm.llmCalls).toBeGreaterThan(0);
            expect(arm.efficiency).toBeTruthy();
            expect(arm.compression).toBeTruthy();
            expect(typeof arm.compression.net_chars_saved).toBe('number');
        }
    });

    it('is deterministic — the same config twice gives the same numbers', async () => {
        const cfg = { history_compress_ratio: 0.5 };
        const r = await compareRuns(base, cfg, cfg);
        expect(r.deltaLlmCalls).toBe(0);
        expect(r.deltaToolCalls).toBe(0);
        expect(r.deltaInduced).toBe(0);
        expect(r.deltaNetCharsSaved).toBe(0);
    });

    it('surfaces the induced-re-read count so a policy can be judged', async () => {
        const { a } = await compareRuns(base, {}, {});
        expect(a.compression).toHaveProperty('compression_induced_re_reads');
        expect(a.compression).toHaveProperty('confirmed_induced');
        expect(a.compression).toHaveProperty('summary_retention_mean');
    });
});

describe('plan-first gate — proportionality', () => {
    // The gate exists for multi-step CHANGE work. Firing it on ordinary or
    // read-only requests is what made the agent feel like it plans everything.
    const planning = { caller: 'NewTask', config: { plan_mode: 'auto' } };

    it('does NOT plan for a polite one-line change request', async () => {
        const h = makeHarness({
            ...planning,
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep('結論: '.padEnd(500, '詳細'))],
        });
        await h.run('モニター画面のタスク一覧について、先頭以外はデフォルトで閉じた状態にする対応をお願いします');
        expect(h.toolCalls.map(c => c.name)).toContain('write_file');
        expect(h.sawMessage(/計画優先|計画承認待ち/)).toBe(false);
    });

    it('does NOT plan for a report request, even an itemised one', async () => {
        const h = makeHarness({
            ...planning,
            script: [toolStep('read_file', { path: 'a.js' }), finishStep('結論: '.padEnd(500, '詳細'))],
        });
        await h.run('1. 現状の構成を調べる\n2. 問題点を洗い出す\n3. レポートにまとめてください');
        expect(h.sawMessage(/計画優先|計画承認待ち/)).toBe(false);
    });

    it('DOES still plan for multi-step change work', async () => {
        const h = makeHarness({
            ...planning,
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run('1. 認証を実装してください\n2. テストを追加\n3. ドキュメントを更新');
        expect(h.toolCalls.map(c => c.name)).not.toContain('write_file');
        expect(h.sawMessage(/計画優先|計画承認待ち/)).toBe(true);
    });

    it('plan_mode:"always" still forces the gate for anything', async () => {
        const h = makeHarness({
            caller: 'NewTask', config: { plan_mode: 'always' },
            script: [toolStep('write_file', { path: 'a.js', content: 'x' }), finishStep()],
        });
        await h.run('タイポを直して');
        expect(h.toolCalls.map(c => c.name)).not.toContain('write_file');
    });
});

describe('images produced by a tool', () => {
    // A tool result is text on every provider, so an extracted Office diagram
    // can only reach the model by riding on the NEXT request's image slot.
    const IMG = 'data:image/png;base64,AAAA';

    /** Queue an image the way a handler does, when `tool` runs. */
    function harnessThatEmitsImage(vision) {
        const h = makeHarness({
            vision,
            script: [
                toolStep('read_file', { path: 'spec.xlsx' }),
                toolStep('grep_search', { query: 'x' }),
                finishStep('結論: '.padEnd(500, '詳細')),
            ],
            toolResults: {
                read_file: () => 'sheet text',
            },
        });
        const realExec = h.toolExecutor.executeTool;
        h.toolExecutor.executeTool = async (call) => {
            const out = await realExec(call);
            if (call.name === 'read_file') {
                h.toolExecutor.pendingImages.push({ data: IMG, source: 'spec.xlsx:xl/media/image1.png' });
            }
            return out;
        };
        return h;
    }

    it('attaches the image to the NEXT request, and only once', async () => {
        const h = harnessThatEmitsImage(true);
        await h.run('read the spec');

        // Call 1 produced the image, so it cannot have carried it.
        expect(h.state.imagesPerCall[0]).toEqual([]);
        expect(h.state.imagesPerCall[1]).toEqual([IMG]);
        // Not re-billed on every subsequent step.
        expect(h.state.imagesPerCall.slice(2).flat()).toEqual([]);
    });

    it('tells the user which images went to the model', async () => {
        const h = harnessThatEmitsImage(true);
        await h.run('read the spec');
        expect(h.sawMessage(/xl\/media\/image1\.png/)).toBe(true);
    });

    it('does NOT send images to a model without vision — and says so in-band', async () => {
        const h = harnessThatEmitsImage(false);
        await h.run('read the spec');

        expect(h.state.imagesPerCall.flat()).toEqual([]);
        // The model must learn the pictures are missing, or it will reason about
        // figures it never saw.
        const secondCall = JSON.stringify(h.state.histories[1] || []);
        expect(secondCall).toMatch(/no vision support/i);
        expect(h.sawMessage(/ビジョン非対応/)).toBe(true);
    });

    it('does not leak images from a previous run', async () => {
        const h = harnessThatEmitsImage(true);
        const agent = await h.build();
        agent.toolExecutor.pendingImages.push({ data: 'data:image/png;base64,STALE', source: 'old' });
        agent._pendingToolImages.push({ data: 'data:image/png;base64,OLDER', source: 'older' });

        await agent.run('fresh task', '.', null, () => {}, null);
        expect(h.state.imagesPerCall.flat()).not.toContain('data:image/png;base64,STALE');
        expect(h.state.imagesPerCall.flat()).not.toContain('data:image/png;base64,OLDER');
    });
});

// Report_20260913 §5 — shape × reach. These go through the REAL loop, because
// the failure being fixed was in how its pieces combined, not in any one of them.
describe('agent loop — the lane decides what a run may touch', () => {
    const answer = '答え'.padEnd(500, '。');

    it('refuses a build with no workspace instead of using the process cwd', async () => {
        const h = makeHarness({ caller: 'NewTask', script: [finishStep()] });
        const agent = await h.build();
        await expect(agent.run('do the thing', null, () => {}, () => {})).rejects.toThrow(/workspace/);
        expect(h.toolExecutor.startSession).not.toHaveBeenCalled();
    });

    it('an external app that says nothing gets web tools and its own server — and no workspace, even when it sends one', async () => {
        const h = makeHarness({ caller: 'JHEditor', script: [finishStep(answer)] });
        const agent = await h.build();
        agent.behaviorOverrides = { mode: 'iterative_agent' };
        await agent.run('review this', 'C:/cusor_workspace/jh-editor', () => {}, () => {});
        expect(h.toolExecutor.setToolAllowlist.mock.calls.at(-1)[0]).toEqual(['fetch_url', 'web_search']);
        expect(h.toolExecutor.setMcpServerFilter.mock.calls.at(-1)[0]).toEqual(['jheditor']);
        expect(h.toolExecutor.startSession.mock.calls.at(-1)[0]).toBeNull();
        // No project memory is read or written for a run with no project.
        expect(h.conversationMemory.loadMemory).not.toHaveBeenCalled();
        expect(h.conversationMemory.addEntry).not.toHaveBeenCalled();
    });

    it('an explicit build × app is refused', async () => {
        const h = makeHarness({ caller: 'JHEditor', script: [finishStep()] });
        const agent = await h.build();
        agent.behaviorOverrides = { shape: 'build', reach: 'app' };
        await expect(agent.run('do it', 'C:/w', () => {}, () => {})).rejects.toThrow(/workspace/);
    });

    // The P0: a caller system_prompt REPLACED the built prompt, and the built
    // prompt is the only place client context is rendered.
    it('appends a caller system_prompt instead of replacing the built prompt', async () => {
        const h = makeHarness({ caller: 'Composer', script: [finishStep(answer)] });
        const agent = await h.build();
        agent.behaviorOverrides = { interaction: 'ask', system_prompt: 'EDITOR-RULES-MARKER' };
        await agent.run('explain', 'C:/w', () => {}, () => {});
        const prompt = h.state.prompts[0];
        expect(prompt).toContain('SYSTEM PROMPT');
        expect(prompt).toContain('<caller_instructions>');
        expect(prompt).toContain('EDITOR-RULES-MARKER');
    });

    it('caps an ask run, unless the caller set its own ceiling', async () => {
        const { ASK_MAX_STEPS } = await import('../agent/RunLane.js');
        const h = makeHarness({ caller: 'Composer', config: { safety: { maxSteps: 0 } }, script: [finishStep(answer)] });
        const agent = await h.build();
        agent.behaviorOverrides = { interaction: 'ask' };
        await agent.run('explain', 'C:/w', () => {}, () => {});
        expect(agent.baseMaxIterations).toBe(ASK_MAX_STEPS);

        const h2 = makeHarness({ caller: 'Composer', script: [finishStep(answer)] });
        const agent2 = await h2.build();
        agent2.behaviorOverrides = { interaction: 'ask', max_iterations: 40 };
        await agent2.run('explain', 'C:/w', () => {}, () => {});
        expect(agent2.baseMaxIterations).toBe(40);
    });

    it('an ephemeral run writes no long-term memory', async () => {
        const h = makeHarness({ caller: 'Composer', script: [finishStep(answer)] });
        const agent = await h.build();
        agent.behaviorOverrides = { interaction: 'ask', ephemeral: true };
        await agent.run('explain', 'C:/w', () => {}, () => {});
        expect(h.conversationMemory.addEntry).not.toHaveBeenCalled();
    });
});

describe('behavior.intent carries only a model tier now', () => {
    it('reads the tier and nothing else', async () => {
        const h = makeHarness();
        const agent = await h.build();
        agent.behaviorOverrides = { intent: { tier: 'Deep', systemPrompt: 'X', tools: ['glob'], resultKind: 'markdown' } };
        agent._applyIntent();
        expect(agent._intentTier).toBe('deep');
        expect(agent.behaviorOverrides.system_prompt).toBeUndefined();
        expect(agent.behaviorOverrides.enabled_tools).toBeUndefined();
        expect(agent.behaviorOverrides.extra_instructions).toBeUndefined();
    });
});

describe('result deliverable resolution', () => {
    // The reported failure: the agent wrote its report to a file and finished
    // with a one-line note, so the Task view showed a synthesized
    // "依頼内容/実施内容/結果" instead of the report.
    const REPORT = '# シート比較レポート\n\n'.padEnd(900, '差分の詳細。');

    async function runWith({ files = [], readFile = null, finishSummary = 'レポートを作成しました' } = {}) {
        const h = makeHarness({
            script: [toolStep('write_file', { path: files[0]?.path || 'report.md', content: 'x' }), finishStep(finishSummary)],
        });
        const agent = await h.build();
        agent.toolExecutor.getModifiedFiles = () => files;
        if (readFile) {
            const { invoke } = await import('@tauri-apps/api/core');
            invoke.mockImplementation(async (cmd, args) => {
                if (cmd === 'read_file') return readFile(args?.path);
                if (cmd === 'get_ai_config') return {};
                return null;
            });
        }
        const res = await agent.run('シートを比較してレポートして', '.', null, () => {}, null);
        return res;
    }

    it('uses a report FILE as the answer when nothing else carries the deliverable', async () => {
        const res = await runWith({
            files: [{ path: 'docs/report.md', original: null }],
            readFile: (p) => (p === 'docs/report.md' ? REPORT : ''),
        });
        expect(res.resultSummary.answer).toContain('シート比較レポート');
    });

    it('ignores a report file that is only a stub', async () => {
        const res = await runWith({
            files: [{ path: 'docs/report.md', original: null }],
            readFile: () => '# TODO',
        });
        expect(res.resultSummary.answer).not.toBe('# TODO');
    });

    it('ignores non-report files — source code is not the deliverable', async () => {
        const res = await runWith({
            files: [{ path: 'src/app.js', original: 'old' }],
            readFile: () => REPORT,
        });
        expect(res.resultSummary.answer).not.toContain('シート比較レポート');
    });

    it('prefers a SUBSTANTIVE finish summary over reading files back', async () => {
        const res = await runWith({
            files: [{ path: 'docs/report.md', original: null }],
            readFile: () => REPORT,
            finishSummary: '結論: '.padEnd(600, '本文'),
        });
        expect(res.resultSummary.answer).toContain('結論:');
    });

    it('survives an unreadable report file', async () => {
        const res = await runWith({
            files: [{ path: 'docs/report.md', original: null }],
            readFile: () => { throw new Error('gone'); },
        });
        expect(typeof res.resultSummary.answer).toBe('string');
    });
});

describe('agent loop — sub-agent review gate (Step-1 review)', () => {
    // The review gate runs an isolated reviewer sub-agent on the run's file
    // changes before finish. Its verdict + the reviewer's ACTUAL words must be
    // surfaced in the log (REVIEW entry with summary), and a FAIL must bounce
    // the task back to the implementer.
    const REVIEW_ON = { subagent_review: 'on' };
    // A substantive finish summary counts as a deliverable so the run reaches
    // the review gate.
    const SUBSTANTIVE = '結論: '.padEnd(500, '詳細');

    it('logs the reviewer report summary on a PASS', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                toolStep('write_file', { path: 'src/a.js', content: 'x' }),
                finishStep(SUBSTANTIVE),
            ],
        });
        const agent = await h.build();
        // Reviewer returns a substantive PASS report (no VERDICT block → the
        // robustness tier still resolves to pass).
        agent._runSubtask = vi.fn(async () =>
            'I inspected the diff. FINDINGS: none — the change matches the criteria and has no bugs.');
        await agent.run('fix the bug', '.', null, (e) => h.state.events.push(e), null, null, [], (l) => h.state.events.push({ event: 'log', log: l }));
        const reviewLog = h.state.events.map(e => e.log).find(l => l && l.method === 'REVIEW');
        expect(reviewLog).toBeTruthy();
        expect(reviewLog.response.verdict).toBe('pass');
        // The reviewer's words (not just the verdict) reach the log.
        expect(reviewLog.response.summary).toContain('no bugs');
        expect(h.sawMessage(/レビューPASS/)).toBe(true);
    });

    it('bounces the task back with the findings on a FAIL', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                toolStep('write_file', { path: 'src/a.js', content: 'x' }),
                finishStep(SUBSTANTIVE),
                // After the bounce the implementer retries finish_task.
                finishStep(SUBSTANTIVE),
            ],
        });
        const agent = await h.build();
        agent._runSubtask = vi.fn(async () =>
            'VERDICT: FAIL\nFINDINGS:\n- [BUG] src/a.js:10 — off-by-one in the loop bound');
        await agent.run('fix the bug', '.', null, (e) => h.state.events.push(e), null, null, [], (l) => h.state.events.push({ event: 'log', log: l }));
        // The run went through the review gate twice: first FAIL (bounce), then
        // PASS on the retry.
        const reviewLogs = h.state.events.map(e => e.log).filter(l => l && l.method === 'REVIEW');
        expect(reviewLogs.length).toBeGreaterThanOrEqual(1);
        const firstFail = reviewLogs[0];
        expect(firstFail.response.verdict).toBe('fail');
        // The reviewer's actual finding text is in the log summary.
        expect(firstFail.response.summary).toContain('[BUG] src/a.js:10 — off-by-one');
        expect(h.sawMessage(/レビュー指摘あり/)).toBe(true);
        // And the agent was told to fix, not to finish: the FAIL findings went
        // into the next user turn.
        const bounced = h.state.histories.find(hist =>
            JSON.stringify(hist).includes('[Sub-agent Review — FAIL]'));
        expect(bounced).toBeTruthy();
        // The task ultimately completed (retry passed review).
        expect(h.toolCalls.filter(c => c.name === 'finish_task').length).toBeGreaterThanOrEqual(2);
    });
});

/* Task 1a1fcea7: a 400 "maximum context length" was treated as native tool
   calling failing — the run fell back to JSON mode, lost its tools for good,
   and resent the same oversized history. An overflow is recovered by shrinking
   the history, with tool calling left on. */
describe('agent loop — a context overflow is not a tool-calling failure', () => {
    it('keeps native tools, shrinks, and carries on', async () => {
        const h = makeHarness({ caller: 'NewTask', script: [finishStep('結論: '.padEnd(500, '詳細'))] });
        const agent = await h.build();
        // The native path is skipped when no tools are registered, and the
        // harness registers none by default — without one, this would test
        // the JSON path and prove nothing about the fallback.
        h.toolExecutor.getToolsForNativeAPI = () => [{
            type: 'function',
            function: { name: 'finish_task', description: 'finish', parameters: { type: 'object', properties: {} } },
        }];
        const original = h.llmService.chatWithTools.getMockImplementation();
        let failed = false;
        h.llmService.chatWithTools.mockImplementation(async (...args) => {
            if (!failed) {
                failed = true;
                throw new Error("API Error (openai): Status: 400 Response: This model's maximum context length is 1048576 tokens. However, you requested 1460042 tokens");
            }
            return original(...args);
        });
        const events = [];
        await agent.run('find it', 'C:/w', () => {}, (e) => events.push(e));
        const messages = events.map(e => e.message || e.error || '').join('\n');
        expect(messages).not.toMatch(/JSONモードにフォールバック/);
        expect(messages).toMatch(/context window/);
        expect(h.llmService.chat).not.toHaveBeenCalled();
    });
});

/* A short conversational reply is the answer. JHEditor's "こんにちは" was pushed
   back as "成果物が未提示" (an extra step) and then answered with a synthesized
   依頼内容/実施内容/結果 report, because both checks wanted 400+ characters. */
describe('agent loop — an ask reply has no minimum length', () => {
    const greeting = 'こんにちは！何をお手伝いしましょうか？';

    it('accepts a one-line reply without a deliverable nudge', async () => {
        const h = makeHarness({ caller: 'Composer', script: [finishStep(greeting), finishStep('should not be needed')] });
        const agent = await h.build();
        agent.behaviorOverrides = { interaction: 'ask' };
        const events = [];
        await agent.run('こんにちは', 'C:/w', () => {}, (e) => events.push(e));
        expect(h.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
        expect(events.some(e => /成果物が未提示/.test(e.message || ''))).toBe(false);
    });

    it('returns the reply itself as the answer, with no generated report', async () => {
        const h = makeHarness({ caller: 'Composer', script: [finishStep(greeting)] });
        const agent = await h.build();
        agent.behaviorOverrides = { interaction: 'ask' };
        const res = await agent.run('こんにちは', 'C:/w', () => {}, () => {});
        expect(res.resultSummary.answer).toBe(greeting);
        expect(res.resultSummary.answer).not.toMatch(/依頼内容|実施内容/);
        expect(h.llmService.generate).not.toHaveBeenCalled();
    });

    it('still nudges a WORK run that only announces completion', async () => {
        const h = makeHarness({ caller: 'NewTask', script: [finishStep('done'), finishStep('done again')] });
        await h.run('do the thing');
        expect(h.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(2);
    });
});
