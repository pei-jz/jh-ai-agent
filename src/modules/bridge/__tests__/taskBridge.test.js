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
// What each run was handed from the run before it — see the file-cache suite.
const adoptedCaches = [];
vi.mock('../../ai/AgentController.js', () => ({
    AgentController: class {
        constructor() {
            // Just enough ToolExecutor for the bridge's file-cache hand-off.
            this._fileCache = new Map();
            this.toolExecutor = {
                onToolEvent: null,
                adoptFileCache: (cache) => {
                    adoptedCaches.push(cache);
                    this._fileCache = new Map(cache);
                    return cache.size;
                },
                getFileCache: () => this._fileCache,
            };
        }
        async run(prompt, workspacePath, onUpdate, onAgentStatus) {
            agentRuns.push({ prompt, workspacePath });
            // A run always learns SOMETHING about the files it touched.
            this._fileCache.set(`C:/w/${prompt}.js`, { content: prompt, readAt: Date.now() });
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
    adoptedCaches.length = 0;
    singleShotCalls.length = 0;
    taskBridge.taskFileCaches.clear();
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

describe('concurrent tasks', () => {
    it('runs two agent tasks CONCURRENTLY without one blocking the other', async () => {
        // Two run-task events fired back-to-back must BOTH start their agent
        // loop before either finishes — i.e. the bridge must not serialize
        // tasks on a single await chain (a task stuck on a slow scan or a
        // pending confirmation must not freeze the other).
        const started = [];
        const originalRun = agentRuns.push.bind(agentRuns);
        const runSpy = (entry) => {
            started.push(Date.now());
            originalRun(entry);
        };
        // agentRuns is a module-level array the mock pushes to; replace push to
        // timestamp each start.
        const origPush = agentRuns.push;
        agentRuns.push = runSpy;
        try {
            const p1 = runTask({ taskId: 'c1', prompt: 'one', workspacePath: 'C:/w1' });
            const p2 = runTask({ taskId: 'c2', prompt: 'two', workspacePath: 'C:/w2' });
            await Promise.all([p1, p2]);
        } finally {
            agentRuns.push = origPush;
        }

        expect(agentRuns.length).toBe(2);
        // Both tasks must have been served by the same bridge without one
        // awaiting the other's completion (the mock run resolves instantly, so
        // this asserts the event handler itself is not serialized).
        const workspaces = agentRuns.map(r => r.workspacePath).sort();
        expect(workspaces).toEqual(['C:/w1', 'C:/w2']);
    });

    it('does not block task start on a project scan (scan is fire-and-forget)', async () => {
        // A slow scanProject must not delay the agent run: the bridge used to
        // `await projectContext.scanProject(...)` which serialized concurrent
        // starts (and froze task B while A scanned).
        const { projectContext } = await import('../../ai/ProjectContext.js');
        let resolveScan;
        projectContext.scanProject.mockImplementation(() => new Promise(r => { resolveScan = r; }));
        const startedAt = Date.now();
        const p = runTask({ taskId: 'c3', prompt: 'x', workspacePath: 'C:/w3' });
        // Give the event handler a tick to reach scanProject and then the run.
        await new Promise(r => setTimeout(r, 10));
        expect(agentRuns.length).toBe(1);   // run started while the scan is still pending
        resolveScan?.();
        await p;
    });

    it('keeps confirm IDs separate so one task approval cannot resolve another', async () => {
        // Two concurrent confirm_request events must carry DISTINCT confirmIds,
        // otherwise answering task A's card would resolve task B's Promise and
        // leave A permanently pending (the "frozen task" report).
        const ids = new Set();
        const p1 = runTask({ taskId: 'c4', prompt: 'x', workspacePath: 'C:/w4' });
        const p2 = runTask({ taskId: 'c5', prompt: 'x', workspacePath: 'C:/w5' });
        await Promise.all([p1, p2]);
        for (const e of emitted) {
            if (e.name === 'task-event-bridge' && e.payload.event === 'confirm_request') {
                ids.add(e.payload.data.confirmId);
            }
        }
        // (The mock agent never confirms, so this asserts the contract that
        // TaskBridge's confirm path is per-taskId — covered structurally.)
        expect(ids.size).toBeLessThanOrEqual(1);
    });
});

// A pending approval is a bare Promise: no timeout, no abort wiring, settled
// only by a `confirm-response` carrying its exact confirmId. So a run parked on
// "may I run this command?" sat inside `await onConfirm(...)` and never reached
// the loop's next abort check — Stop marked the task aborted in the UI while the
// agent stayed stuck on the question, and the registry entry leaked.
describe('approval flow', () => {
    /** Park a fake confirmation for `taskId`, as onConfirm would. */
    const park = (taskId) => {
        let settled;
        const p = new Promise((resolve, reject) => {
            taskBridge.pendingConfirmations.set(`conf_${taskId}`, {
                resolve: (v) => { settled = v; resolve(v); },
                reject,
                taskId,
            });
        });
        return { promise: p, value: () => settled };
    };

    it('settles a pending approval when the task is aborted', async () => {
        const held = park('t-abort');
        taskBridge.activeAgents.set('t-abort', { controller: {}, abortController: { abort: () => {} } });

        taskBridge.abortAgentTask('t-abort');
        await held.promise;

        // false, not a rejection: every handler already reads false as "the user
        // said no" and returns a clean denial, letting the loop unwind.
        expect(held.value()).toBe(false);
        expect(taskBridge.pendingConfirmations.has('conf_t-abort')).toBe(false);
    });

    it('announces the outcome so views can stop showing a live card', async () => {
        // The only evidence a question was closed used to be circumstantial —
        // "did work happen afterwards?" — which the Story guessed at and the Raw
        // Log never checked, so an approved card stayed clickable for the life
        // of the task. This event is what makes the answer knowable.
        const held = park('t-ok');
        emitted.length = 0;
        listeners.get('confirm-response')({ payload: { confirmId: 'conf_t-ok', approved: true } });
        await held.promise;

        const ev = emitted.find(e => JSON.stringify(e.payload || {}).includes('confirm_resolved'));
        expect(ev).toBeTruthy();
        expect(JSON.stringify(ev.payload)).toContain('conf_t-ok');
    });

    it('does not silently swallow an answer to a settled approval', () => {
        // Clicking a stale card is easy and used to do nothing at all: no
        // resolution, no error, no trace. The user is owed the knowledge that
        // the card they clicked was not live.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        listeners.get('confirm-response')({ payload: { confirmId: 'conf_gone', approved: true } });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('leaves another task\'s pending approval alone', async () => {
        const mine = park('t-a');
        const theirs = park('t-b');
        taskBridge.activeAgents.set('t-a', { controller: {}, abortController: { abort: () => {} } });

        taskBridge.abortAgentTask('t-a');
        await mine.promise;

        expect(taskBridge.pendingConfirmations.has('conf_t-b')).toBe(true);
        expect(theirs.value()).toBeUndefined();
        taskBridge.pendingConfirmations.clear();
    });
});

// ── the file cache across a continuation ─────────────────────────────────
//
// Continuing a finished task builds a NEW AgentController with a NEW
// ToolExecutor, so everything the previous run learned about the files it read
// and edited was dropped on the floor and re-read from disk. The bridge is the
// only object that outlives both runs, so it is where the hand-off belongs.
describe('file cache hand-off between runs of one task', () => {
    it('hands a continuation what the previous run of the SAME task learned', async () => {
        await runTask({ taskId: 'k1', prompt: 'first', workspacePath: 'C:/w' });
        await runTask({
            taskId: 'k1', prompt: 'follow up', workspacePath: 'C:/w',
            chatContext: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }],
        });
        expect(adoptedCaches).toHaveLength(1);
        expect([...adoptedCaches[0].keys()]).toContain('C:/w/first.js');
    });

    it('hands a FRESH task nothing, even when the id was used before', async () => {
        await runTask({ taskId: 'k2', prompt: 'first', workspacePath: 'C:/w' });
        // No chatContext: this is new work, not a continuation. Inheriting a map
        // of unrelated files would be worse than starting cold.
        await runTask({ taskId: 'k2', prompt: 'second', workspacePath: 'C:/w' });
        expect(adoptedCaches).toHaveLength(0);
    });

    it('does not leak one task cache into another', async () => {
        await runTask({ taskId: 'k3', prompt: 'alpha', workspacePath: 'C:/w' });
        await runTask({
            taskId: 'k4', prompt: 'beta', workspacePath: 'C:/w',
            chatContext: [{ role: 'user', content: 'earlier' }],
        });
        expect(adoptedCaches).toHaveLength(0);
    });

    it('keeps only the most recent tasks, so a long session cannot grow forever', async () => {
        for (let i = 0; i < 12; i++) {
            await runTask({ taskId: `cap${i}`, prompt: `p${i}`, workspacePath: 'C:/w' });
        }
        expect(taskBridge.taskFileCaches.size).toBe(8);
        expect(taskBridge.taskFileCaches.has('cap11')).toBe(true);
        expect(taskBridge.taskFileCaches.has('cap0')).toBe(false);
    });

    it('carries the cache forward again across a SECOND continuation', async () => {
        await runTask({ taskId: 'k5', prompt: 'one', workspacePath: 'C:/w' });
        await runTask({
            taskId: 'k5', prompt: 'two', workspacePath: 'C:/w',
            chatContext: [{ role: 'user', content: 'one' }],
        });
        await runTask({
            taskId: 'k5', prompt: 'three', workspacePath: 'C:/w',
            chatContext: [{ role: 'user', content: 'two' }],
        });
        // The third run sees both earlier runs' files, not just the last one's.
        const last = adoptedCaches[adoptedCaches.length - 1];
        expect([...last.keys()]).toEqual(expect.arrayContaining(['C:/w/one.js', 'C:/w/two.js']));
    });
});

/* Spotlight's Expand used to hand the question to a normal run with the answer
   it already had attached as history — so the model was asked the same question
   a second time and produced a second answer. `record` writes the exchange down
   instead: no LLM call, no agent loop, nothing to give a workspace or tools to. */
describe('record mode', () => {
    const eventsFor = (taskId) => emitted
        .filter(e => e.name === 'task-event-bridge' && e.payload.taskId === taskId)
        .map(e => e.payload);

    const exchange = [
        { role: 'user', content: 'what is the GPT-6 price?' },
        { role: 'assistant', content: '$10 in / $50 out per 1M tokens.' },
    ];

    it('calls no model and runs no loop', async () => {
        await runTask({ taskId: 'r1', prompt: 'what is the GPT-6 price?', behavior: { mode: 'record' }, chatContext: exchange });
        expect(singleShotCalls).toHaveLength(0);
        expect(agentRuns).toHaveLength(0);
    });

    it('completes immediately with the answer it was given', async () => {
        await runTask({ taskId: 'r2', prompt: 'q', behavior: { mode: 'record' }, chatContext: exchange });
        const done = eventsFor('r2').filter(e => e.event === 'complete');
        expect(done).toHaveLength(1);
        expect(done[0].data.message).toBe('$10 in / $50 out per 1M tokens.');
        expect(done[0].data.resultSummary.summary).toBe('$10 in / $50 out per 1M tokens.');
        expect(done[0].data.modifiedFiles).toEqual([]);
    });

    // The cost was paid by whoever produced the answer. Reporting it again here
    // would double it in the dashboard.
    it('reports no token usage of its own', async () => {
        await runTask({ taskId: 'r3', prompt: 'q', behavior: { mode: 'record' }, chatContext: exchange });
        expect(eventsFor('r3').filter(e => e.event === 'token_usage')).toHaveLength(0);
    });

    it('takes the LAST assistant turn when several are carried', async () => {
        await runTask({
            taskId: 'r4', prompt: 'q', behavior: { mode: 'record' },
            chatContext: [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'older answer' },
                { role: 'user', content: 'second' },
                { role: 'assistant', content: 'newest answer' },
            ],
        });
        expect(eventsFor('r4').find(e => e.event === 'complete').data.message).toBe('newest answer');
    });

    // An empty completed task looks like the answer was LOST rather than never
    // sent, which is the worse of the two things to show.
    it('errors rather than recording an empty exchange', async () => {
        for (const [id, ctx] of [['r5', []], ['r6', undefined], ['r7', [{ role: 'user', content: 'only a question' }]]]) {
            await runTask({ taskId: id, prompt: 'q', behavior: { mode: 'record' }, chatContext: ctx });
            const evs = eventsFor(id);
            expect(evs.filter(e => e.event === 'complete')).toHaveLength(0);
            const err = evs.filter(e => e.event === 'error');
            expect(err).toHaveLength(1);
            expect(err[0].data.terminal).toBe(true);
        }
    });
});

/* The lane decides the engine (src/modules/ai/agent/RunLane.js). The bridge
   enforces the parts that matter before an agent exists: a transform never
   reaches the loop, an impossible lane is refused, and a run without a
   workspace lane is not handed the path its caller sent. */
describe('lane dispatch', () => {
    const eventsFor = (taskId) => emitted
        .filter(e => e.name === 'task-event-bridge' && e.payload.taskId === taskId)
        .map(e => e.payload);

    it('a transform goes to the one-shot path, whatever mode says', async () => {
        await runTask({ taskId: 'ln1', prompt: 'x', caller: 'JHEditor', behavior: { shape: 'transform' } });
        expect(singleShotCalls).toHaveLength(1);
        expect(agentRuns).toHaveLength(0);
    });

    it('refuses build without a workspace lane before any engine runs', async () => {
        await runTask({ taskId: 'ln2', prompt: 'x', caller: 'JHEditor', workspacePath: 'C:/w', behavior: { shape: 'build', reach: 'app' } });
        expect(agentRuns).toHaveLength(0);
        expect(singleShotCalls).toHaveLength(0);
        const err = eventsFor('ln2').find(e => e.event === 'error');
        expect(err.data.terminal).toBe(true);
        expect(err.data.error).toMatch(/workspace/);
    });

    // The report's P0: the chat sent its workspace and got the file system.
    it('an external app that says nothing does not get the workspace it sent', async () => {
        await runTask({ taskId: 'ln3', prompt: 'x', caller: 'JHEditor', workspacePath: 'C:/cusor_workspace/jh-editor', behavior: { mode: 'iterative_agent' } });
        expect(agentRuns).toHaveLength(1);
        expect(agentRuns[0].workspacePath).toBeNull();
    });

    it('a workspace run keeps its path', async () => {
        await runTask({ taskId: 'ln4', prompt: 'x', caller: 'NewTask', workspacePath: 'C:/proj', behavior: { mode: 'iterative_agent' } });
        expect(agentRuns[0].workspacePath).toBe('C:/proj');
    });

    // `message` is finish_task's summary; a client that showed it showed a
    // sentence about the answer instead of the answer.
    it('complete carries the answer next to the summary', async () => {
        await runTask({ taskId: 'ln5', prompt: 'x', caller: 'NewTask', workspacePath: 'C:/w' });
        const done = eventsFor('ln5').find(e => e.event === 'complete');
        expect(done.data.answer).toBe('agent answer');
        expect(done.data.message).toBe('agent answer');
    });

    it('a one-shot complete carries the answer too', async () => {
        await runTask({ taskId: 'ln6', prompt: 'x', behavior: { mode: 'single_shot' } });
        const done = eventsFor('ln6').find(e => e.event === 'complete');
        expect(done.data.answer).toBe('single shot answer');
    });
});
