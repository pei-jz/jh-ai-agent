// Integration tests for the investigation gate inside the REAL AgentController
// loop. The unit tests in agent/__tests__/investigationGate.test.js prove the
// checks decide correctly; these prove they are actually WIRED — that a
// read-only run reaches them, that a code-changing run does not, and that the
// audit sub-agent's verdict can send an investigation back.
//
// Worth testing separately because the failure being closed was itself a wiring
// gap: every piece of review machinery existed and simply never ran on a run
// that changed no files.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

const REVIEW_ON = { subagent_review: 'on' };

/** Clears ANALYSIS_MIN_CHARS with room to spare, and cites nothing. */
const UNCITED = '結論: この画面は入力値を検証してから送信します。'.padEnd(1100, '詳細を述べます。');
/** Same length, but shows where it looked. */
const CITED = ('結論: 表示は web/order/list.jsp:42 が描画し、'
    + 'WEB-INF/web.xml:31 のフラグで切り替わります。').padEnd(1100, '詳細を述べます。');

/** Four inspections — the floor at which an answer counts as a trace. */
const FOUR_READS = [
    toolStep('read_file', { path: 'a.jsp' }),
    toolStep('read_file', { path: 'b.jsp' }),
    toolStep('grep_search', { query: 'flag' }),
    toolStep('glob', { pattern: '**/*.xml' }),
];

/** Drive the loop and hand back the harness state. */
async function run(h, { audit } = {}) {
    const agent = await h.build();
    agent._runSubtask = vi.fn(async () => audit
        ?? 'I checked the answer against the codebase. FINDINGS: none.');
    await agent.run('この画面の挙動を教えて', '.', null,
        (e) => h.state.events.push(e), null, null, [],
        (l) => h.state.events.push({ event: 'log', log: l }));
    return { agent, state: h.state };
}

describe('investigation gate — wiring', () => {
    it('bounces a traced answer that cites nothing, then accepts the revision', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(UNCITED), finishStep(CITED)],
        });
        const { state } = await run(h);
        // Two finish_task calls: the first was pushed back.
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(2);
        expect(h.sawMessage(/根拠/)).toBe(true);
        const bounce = state.histories.at(-1)
            .filter(m => m.role === 'user')
            .find(m => String(m.content).includes('[Investigation Incomplete]'));
        expect(bounce).toBeTruthy();
        expect(bounce.content).toContain('no sources at all');
    });

    it('does not bounce an answer that shows its sources', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(CITED)],
        });
        const { state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
    });

    it('leaves a run that never looked anything up alone', async () => {
        // A long answer written from context is not a trace. Auditing it spends
        // a sub-agent to confirm nobody read a file.
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [toolStep('read_file', { path: 'a.jsp' }), finishStep(UNCITED)],
        });
        const { agent, state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
        expect(agent._runSubtask).not.toHaveBeenCalled();
    });

    it('audits an investigation, and logs the verdict', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(CITED)],
        });
        const { agent, state } = await run(h, {
            audit: 'FINDINGS:\n- [STYLE] the trace reaches the servlet and the config; wording could be tighter.',
        });
        // The auditor role, not the code reviewer — they judge different things,
        // and handing an investigation to the code criteria produced "no changes
        // to review, PASS", which is how this gap stayed invisible.
        expect(agent._runSubtask).toHaveBeenCalled();
        expect(agent._runSubtask.mock.calls[0][0].role).toBe('auditor');
        const log = state.events.map(e => e.log).find(l => l && l.method === 'AUDIT');
        expect(log).toBeTruthy();
        // STYLE alone must never block — same rule the code review follows.
        expect(log.response.verdict).toBe('pass');
        expect(log.response.summary).toContain('servlet');
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
    });

    it('sends the investigation back when the audit FAILs', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(CITED), finishStep(CITED)],
        });
        const { state } = await run(h, {
            audit: 'VERDICT: FAIL\nFINDINGS:\n- [CRITERIA-VIOLATION] the trace stops at the JSP; '
                + 'WEB-INF/web.xml:31 reads the flag but nothing shows where it is SET.',
        });
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(2);
        const bounce = state.histories.at(-1)
            .filter(m => m.role === 'user')
            .find(m => String(m.content).includes('[Audit — FAIL]'));
        expect(bounce).toBeTruthy();
        expect(bounce.content).toContain('trace stops at the JSP');
        // The instruction has to say "go and read", or the model just rewords.
        expect(bounce.content).toMatch(/do not simply reword/i);
    });

    it('never runs on a code change — that run belongs to the reviewer', async () => {
        // The two gates are complements. If both could fire, a code change would
        // be reviewed twice and pay for two sub-agents.
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                ...FOUR_READS,
                toolStep('write_file', { path: 'src/a.js', content: 'x' }),
                finishStep(UNCITED),
            ],
        });
        const { agent, state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
        expect(agent._runSubtask.mock.calls[0][0].role).toBe('reviewer');
        expect(state.events.map(e => e.log).find(l => l && l.method === 'AUDIT')).toBeUndefined();
    });

    it('bounces once and only once, so a stubborn model cannot deadlock', async () => {
        // The existing deliverable nudge is one-shot by design: if the model
        // ignores it, the next finish goes through. This follows that policy
        // rather than inventing a stricter one.
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(UNCITED), finishStep(UNCITED)],
        });
        const { state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(2);
    });

    it('skips the audit when independent review is switched off', async () => {
        const h = makeHarness({
            config: { subagent_review: 'off' },
            caller: 'NewTask',
            script: [...FOUR_READS, finishStep(CITED)],
        });
        const { agent } = await run(h);
        expect(agent._runSubtask).not.toHaveBeenCalled();
    });
});

describe('investigation gate — the frontier', () => {
    it('bounces a run that drops a question it recorded itself', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                ...FOUR_READS,
                toolStep('open_question', { action: 'add', question: 'where is the flag SET?' }),
                finishStep(CITED),
                finishStep(CITED + ' なお、フラグの設定元は未確認です。'),
            ],
        });
        const { state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(2);
        const bounce = state.histories.at(-1)
            .filter(m => m.role === 'user')
            .find(m => String(m.content).includes('[Investigation Incomplete]'));
        expect(bounce.content).toContain('where is the flag SET?');
        expect(bounce.content).toContain('Open questions');
    });

    it('accepts the run once the answer declares what it could not verify', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                ...FOUR_READS,
                toolStep('open_question', { action: 'add', question: 'where is the flag SET?' }),
                finishStep(CITED + ' なお、フラグの設定元は未確認です。'),
            ],
        });
        const { state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
    });

    it('accepts the run once the question is resolved with evidence', async () => {
        const h = makeHarness({
            config: REVIEW_ON,
            caller: 'NewTask',
            script: [
                ...FOUR_READS,
                toolStep('open_question', { action: 'add', question: 'where is the flag SET?' }),
                toolStep('open_question', { action: 'resolve', id: 'q1', answer: 'WEB-INF/web.xml:31' }),
                finishStep(CITED),
            ],
        });
        const { state } = await run(h);
        expect(state.toolCalls.filter(c => c.name === 'finish_task')).toHaveLength(1);
    });
});
