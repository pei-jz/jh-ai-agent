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
        await agent.run('do the thing');
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

    it('keeps the external-caller markers: intent (an app intent) still counts as external', async () => {
        // behavior.intent comes from an EXTERNAL app (JHEditor/JHProjectManager
        // via the REST API). It must remain an external-caller marker.
        const h = makeHarness({
            caller: 'JHEditor',
            script: [finishStep('done')],
        });
        const agent = await h.build();
        agent.behaviorOverrides = { intent: { tools: ['read_file'] }, mcp_servers: ['backlog'] };
        await agent.run('do the thing');
        const calls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        // External caller → WS-app tools stay ADVERTISED (last call = false).
        expect(calls[calls.length - 1][0]).toBe(false);
    });

    it('behavior.intent forces the external path even with an interactive caller name', async () => {
        // intent is set by an EXTERNAL app; it stays a hard external marker.
        // The caller NAME alone is not enough to override it.
        const h = makeHarness({
            caller: 'DirectChat',
            script: [finishStep('done')],
        });
        const agent = await h.build();
        agent.behaviorOverrides = { intent: { tools: ['read_file'] } };
        await agent.run('do the thing');
        const calls = h.toolExecutor.setExcludeExternalAppMcpTools.mock.calls;
        expect(calls[calls.length - 1][0]).toBe(false);
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

describe('intent by id (AI-Hub)', () => {
    // An app declares its named actions once on connect; a task then references
    // one by id. Before the registry existed, a string id was silently dropped
    // and the task ran with default prompt/tools.
    async function withRegisteredIntent(intent, behaviorIntent, script) {
        const h = makeHarness({ script });
        // build() resets the module graph, so the registry must be populated
        // AFTER it — otherwise we'd be filling a discarded singleton.
        const agent = await h.build();
        const { intentRegistry } = await import('../agent/IntentRegistry.js');
        intentRegistry.setForApp('jheditor', [intent]);
        agent.behaviorOverrides = { intent: behaviorIntent };
        return { h, agent, intentRegistry };
    }

    it('expands a REGISTERED id into prompt and tool allowlist', async () => {
        const { h, agent } = await withRegisteredIntent(
            { id: 'impact', systemPrompt: 'INTENT-PROMPT-MARKER', tools: ['read_file', 'grep_search'] },
            'impact',
            [finishStep('結論: '.padEnd(500, '詳細'))],
        );
        agent._applyIntent();
        expect(agent.behaviorOverrides.system_prompt).toBe('INTENT-PROMPT-MARKER');
        expect(agent.behaviorOverrides.enabled_tools).toEqual(['read_file', 'grep_search']);
        expect(h).toBeTruthy();
    });

    it('still accepts an inline object (unchanged behaviour)', async () => {
        const { agent } = await withRegisteredIntent(
            { id: 'unused' },
            { systemPrompt: 'INLINE-MARKER', tools: ['glob'] },
            [finishStep()],
        );
        agent._applyIntent();
        expect(agent.behaviorOverrides.system_prompt).toBe('INLINE-MARKER');
        expect(agent.behaviorOverrides.enabled_tools).toEqual(['glob']);
    });

    it('an unknown id runs with defaults instead of failing the task', async () => {
        const { agent } = await withRegisteredIntent(
            { id: 'known' },
            'never-declared',
            [finishStep()],
        );
        expect(() => agent._applyIntent()).not.toThrow();
        expect(agent.behaviorOverrides.system_prompt).toBeUndefined();
    });

    it('a registered resultKind adds the present_result guidance', async () => {
        const { agent } = await withRegisteredIntent(
            { id: 'report', resultKind: 'markdown' },
            'report',
            [finishStep()],
        );
        agent._applyIntent();
        expect(agent.behaviorOverrides.extra_instructions || '').toContain('present_result');
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
