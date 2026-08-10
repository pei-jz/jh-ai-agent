// TaskBridge — the seam between the Rust REST/WS layer and the JS agent.
//
// It decides which execution mode a task runs in and shapes every event the
// Monitor and external SDK clients consume. Both are contracts: a wrong mode
// silently runs the wrong engine, and a malformed event breaks consumers that
// cannot be fixed from this side.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the Tauri event plumbing so we can drive `run-task` and inspect
// everything the bridge emits.
const listeners = new Map();
const emitted = [];
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); }),
    emit: vi.fn((name, payload) => { emitted.push({ name, payload }); }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));

const agentRuns = [];
vi.mock('../../ai/AgentController.js', () => ({
    AgentController: class {
        constructor() { this.toolExecutor = { onToolEvent: null }; }
        async run(prompt, workspacePath, onUpdate, onAgentStatus) {
            agentRuns.push({ prompt, workspacePath });
            onAgentStatus?.({ event: 'status', status: 'running', message: 'working' });
            // run() resolves with the structured result the bridge unpacks.
            return {
                response: 'agent answer',
                modifiedFiles: [{ path: 'src/a.js' }],
                resultSummary: { summary: 'agent answer', files: [] },
            };
        }
        addSteeringMessage() {}
    },
}));

vi.mock('../../ai/ProjectContext.js', () => ({
    projectContext: { scanProject: vi.fn(async () => {}) },
}));

const singleShotCalls = [];
vi.mock('../../ai/LLMService.js', () => ({
    default: {
        getCurrentModel: () => 'openai:gpt-4o',
        chat: vi.fn(async (messages, systemPrompt) => {
            singleShotCalls.push({ messages, systemPrompt });
            return { content: 'single shot answer', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
        }),
    },
}));

const { taskBridge } = await import('../TaskBridge.js');

/** Fire the `run-task` event the Rust side would send. */
const runTask = (payload) => listeners.get('run-task')({ payload });

beforeEach(async () => {
    emitted.length = 0;
    agentRuns.length = 0;
    singleShotCalls.length = 0;
    if (!listeners.has('run-task')) await taskBridge.init();
});

describe('mode dispatch', () => {
    it('defaults to the full agent loop when no behavior is given', async () => {
        await runTask({ taskId: 't1', prompt: 'do it', workspacePath: 'C:/w' });
        expect(agentRuns).toHaveLength(1);
        expect(singleShotCalls).toHaveLength(0);
    });

    it('routes an explicit iterative_agent to the same loop', async () => {
        await runTask({ taskId: 't2', prompt: 'do it', workspacePath: 'C:/w', behavior: { mode: 'iterative_agent' } });
        expect(agentRuns).toHaveLength(1);
    });

    it('routes single_shot to one LLM call with NO agent loop', async () => {
        await runTask({ taskId: 't3', prompt: 'summarize', behavior: { mode: 'single_shot' } });
        expect(singleShotCalls).toHaveLength(1);
        expect(agentRuns).toHaveLength(0);
    });

    it('passes the workspace through to the agent', async () => {
        await runTask({ taskId: 't4', prompt: 'x', workspacePath: 'C:/proj' });
        expect(agentRuns[0].workspacePath).toBe('C:/proj');
    });
});

describe('emitted task events', () => {
    const eventsFor = (taskId) => emitted
        .filter(e => e.name === 'task-event-bridge' && e.payload.taskId === taskId)
        .map(e => e.payload);

    it('every event carries taskId, event, data and a timestamp', async () => {
        await runTask({ taskId: 't5', prompt: 'x', workspacePath: 'C:/w' });
        const evs = eventsFor('t5');
        expect(evs.length).toBeGreaterThan(0);
        for (const e of evs) {
            expect(e).toHaveProperty('event');
            expect(e).toHaveProperty('data');
            expect(typeof e.timestamp).toBe('string');
            expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
        }
    });

    it('marks terminal events high priority so clients can filter', async () => {
        await runTask({ taskId: 't6', prompt: 'x', workspacePath: 'C:/w' });
        const complete = eventsFor('t6').find(e => e.event === 'complete');
        expect(complete?.priority).toBe('high');
    });

    it('ends an agent run with a complete event carrying the answer', async () => {
        await runTask({ taskId: 't7', prompt: 'x', workspacePath: 'C:/w' });
        const complete = eventsFor('t7').find(e => e.event === 'complete');
        expect(complete).toBeTruthy();
        expect(JSON.stringify(complete.data)).toContain('agent answer');
    });

    it('reports single_shot token usage WITH the model that produced it', async () => {
        await runTask({ taskId: 't8', prompt: 'x', behavior: { mode: 'single_shot' } });
        const usage = eventsFor('t8').find(e => e.event === 'token_usage');
        expect(usage).toBeTruthy();
        expect(usage.data.model).toBe('openai:gpt-4o');   // per-model cost attribution
        expect(usage.data.total_tokens).toBe(10);
    });

    it('forwards agent status events to the client', async () => {
        await runTask({ taskId: 't9', prompt: 'x', workspacePath: 'C:/w' });
        expect(eventsFor('t9').some(e => e.event === 'status')).toBe(true);
    });
});
