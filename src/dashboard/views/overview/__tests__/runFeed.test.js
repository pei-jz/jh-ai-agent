// runFeed — the Dashboard's reduction of a running task's log stream.
//
// The thing most worth protecting here is that the step TEXT is Monitor's, not
// a second copy: the first test asserts the exact string Monitor's toolLineText
// produces, so a divergence fails rather than quietly drifting.

import { describe, it, expect } from 'vitest';
import { reduceRun, phaseRail, runCost, affectsRun, RUN_EVENTS, FEED_LIMIT, PHASES } from '../runFeed.js';
import { toolLineText } from '../../monitor/toolLine.js';

const log = (event, data, ts = '2026-08-12T10:00:00Z') => ({ event, data, timestamp: ts });
const tool = (name, request, over = {}) => log('log', { method: 'TOOL', name, request, ...over });
const status = (message, over = {}) => log('status', { status: 'running', message, ...over });

describe('steps come from Monitor’s formatter, not a second one', () => {
    it('renders a tool line exactly as Monitor would', () => {
        const req = { path: 'src/modules/auth/TokenStore.js' };
        const run = reduceRun([tool('read_file', req)]);
        expect(run.steps[0].text).toBe(toolLineText('read_file', req));
    });

    it('keeps the file path so the row can link to it', () => {
        const run = reduceRun([tool('write_file', { path: 'a/b.js', content: 'x' })]);
        expect(run.steps[0].target).toBe('a/b.js');
    });

    it('records which files a run has written', () => {
        const run = reduceRun([
            tool('write_file', { path: 'a.js' }),
            tool('read_file', { path: 'b.js' }),
        ]);
        expect([...run.files]).toEqual(['a.js']);
    });

    it('marks a failed tool call', () => {
        expect(reduceRun([tool('run_command', { command: 'x' }, { isError: true })]).steps[0].kind).toBe('error');
    });
});

describe('status lines', () => {
    it('tracks the agent’s own step number', () => {
        expect(reduceRun([status('Thinking... (step 14)')]).step).toBe(14);
    });

    // "Thinking… (step 12)" is bookkeeping. Showing it would fill a six-line
    // feed with the word Thinking.
    it('advances the counter without adding a row for it', () => {
        const run = reduceRun([status('Thinking... (step 3)'), status('Reading the config')]);
        expect(run.step).toBe(3);
        expect(run.steps).toHaveLength(1);
    });

    it('classifies a line the same way Monitor replays it', () => {
        expect(reduceRun([status('⚠ something failed')]).steps[0].kind).toBe('error');
        expect(reduceRun([status('✓ read_file: a.js')]).steps[0].kind).toBe('tool');
        expect(reduceRun([status('I will start by reading the store')]).steps[0].kind).toBe('thought');
    });
});

describe('the feed is a tail, not a head', () => {
    // A run 40 steps in should show step 40, not step 1.
    it('keeps the newest lines when there are more than fit', () => {
        const many = Array.from({ length: 20 }, (_, i) => status(`line ${i}`));
        const run = reduceRun(many);
        expect(run.steps).toHaveLength(FEED_LIMIT);
        expect(run.steps.at(-1).text).toBe('line 19');
    });
});

describe('the phase rail', () => {
    const phase = (p, model, tokens = {}) => log('phase', { phase: p, model, tokens, escalated: false });

    it('is empty until the run says which phase it is in', () => {
        expect(phaseRail(reduceRun([status('x')]))).toEqual([]);
    });

    // A rail that grows a cell at a time cannot show where the run IS in a
    // sequence, which is the only reason to draw a rail.
    it('always shows all three phases, marking the current one', () => {
        const rail = phaseRail(reduceRun([phase('execute', 'i1:flash', { plan: 4000 })]));
        expect(rail.map(r => r.phase)).toEqual(PHASES);
        expect(rail.map(r => r.state)).toEqual(['done', 'now', 'todo']);
    });

    it('remembers the model each phase ran on', () => {
        const run = reduceRun([
            phase('plan', 'i2:kimi', { plan: 0 }),
            phase('execute', 'i1:flash', { plan: 42000, execute: 1000 }),
        ]);
        const rail = phaseRail(run);
        expect(rail[0].model).toBe('i2:kimi');
        expect(rail[0].tokens).toBe(42000);
        expect(rail[1].model).toBe('i1:flash');
    });

    it('carries the escalation flag', () => {
        const run = reduceRun([log('phase', { phase: 'execute', model: 'i2:kimi', escalated: true })]);
        expect(run.escalated).toBe(true);
    });
});

describe('memory in play', () => {
    const recall = (cards, at, source) => log('memory_recall', { cards, at, source });

    it('collects the cards a run recalled, with the step each fired at', () => {
        const run = reduceRun([
            recall([{ id: 'I-1', type: 'insight', headline: 'read then grep' }], 1, 'brief'),
            status('Thinking... (step 12)'),
            recall([{ id: 'L-2', type: 'lesson', headline: 'no line numbers' }], 12, 'tool'),
        ]);
        expect(run.recalls.map(r => r.id)).toEqual(['I-1', 'L-2']);
        expect(run.recalls[1].at).toBe(12);
        expect(run.recalls[0].source).toBe('brief');
    });

    it('falls back to the current step when the event omits one', () => {
        const run = reduceRun([status('Thinking... (step 7)'), recall([{ id: 'X' }], 0, 'tool')]);
        expect(run.recalls[0].at).toBe(7);
    });

    it('has nothing to show when memory recall is off', () => {
        expect(reduceRun([status('x')]).recalls).toEqual([]);
    });
});

describe('tokens and cost', () => {
    const usage = (model, p, c, cr = 0) => log('token_usage', {
        model, prompt_tokens: p, completion_tokens: c, cache_read_input_tokens: cr,
    });

    it('accumulates across calls and attributes them per model', () => {
        const run = reduceRun([usage('i2:kimi', 1000, 100), usage('i1:flash', 500, 50)]);
        expect(run.tokens.prompt).toBe(1500);
        expect(run.byModel['i2:kimi'].prompt).toBe(1000);
    });

    const rates = {
        'i1:flash': { input: 0.3, cacheRead: 0.03, output: 1.2, label: 'Flash' },
        'i2:kimi': { input: 3, cacheRead: 0.3, output: 15, label: 'Kimi' },
    };

    it('prices each model with its own rates', () => {
        const run = reduceRun([usage('i2:kimi', 1e6, 0), usage('i1:flash', 1e6, 0)]);
        expect(runCost(run, rates)).toBeCloseTo(3.3, 4);
    });

    it('discounts the cached share', () => {
        const run = reduceRun([usage('i2:kimi', 1e6, 0, 1e6)]);
        expect(runCost(run, rates)).toBeCloseTo(0.3, 4);
    });

    it('matches a bare model name as well as an id:model composite', () => {
        expect(runCost(reduceRun([usage('kimi', 1e6, 0)]), rates)).toBeCloseTo(3, 4);
    });

    // Better no figure than a confident $0.00 for a run that certainly cost
    // something.
    it('returns null when nothing can be priced', () => {
        expect(runCost(reduceRun([usage('unknown-model', 1e6, 0)]), rates)).toBeNull();
        expect(runCost(reduceRun([]), rates)).toBeNull();
        expect(runCost(reduceRun([usage('i2:kimi', 1, 0)]), null)).toBeNull();
    });
});

describe('terminal and blocked states', () => {
    it('notices a finish', () => {
        expect(reduceRun([log('complete', {})]).finished).toBe(true);
        expect(reduceRun([log('error', {})]).finished).toBe(true);
        expect(reduceRun([status('done', { status: 'aborted' })]).finished).toBe(true);
    });

    it('notices a question and keeps it', () => {
        const run = reduceRun([log('ask_user', { question: 'この計画で進めますか？' })]);
        expect(run.awaiting).toBe(true);
        expect(run.question).toContain('計画');
    });

    it('survives junk in the log array', () => {
        expect(() => reduceRun([null, 'nope', {}, log('unknown', {})])).not.toThrow();
        expect(reduceRun(undefined).steps).toEqual([]);
    });
});

// The Run pane used to be rebuilt for EVERY packet on the socket. `stream`
// arrives once per token and `command_chunk` once per line of stdout, so a
// generating task rebuilt the whole run object and re-rendered dozens of times a
// second — which is what made the tab flicker — and, because every rebuild walks
// the entire log array, the cost was quadratic in the length of the run.
describe('affectsRun', () => {
    it('accepts every event the reducer has a case for', () => {
        for (const event of ['log', 'status', 'phase', 'memory_recall', 'token_usage',
                             'confirm', 'ask_user', 'complete', 'error']) {
            expect(affectsRun({ event })).toBe(true);
        }
    });

    // These are the high-volume ones, and the reducer ignores them entirely.
    it('rejects the per-token and per-line traffic', () => {
        for (const event of ['stream', 'command_chunk']) {
            expect(affectsRun({ event })).toBe(false);
        }
    });

    it('rejects the other events the reducer does not read', () => {
        for (const event of ['thought', 'tool_call', 'file_modified', 'result',
                             'result_update', 'task_progress', 'replay_done', 'confirm_resolved']) {
            expect(affectsRun({ event })).toBe(false);
        }
    });

    it('survives a malformed packet', () => {
        expect(affectsRun(null)).toBe(false);
        expect(affectsRun({})).toBe(false);
    });

    // The guard and the switch are two lists of the same thing, one file apart.
    // Dropping an event the reducer reads would make it silently stop arriving.
    it('names nothing the reducer cannot use, and nothing it can is missing', () => {
        const rejected = [...RUN_EVENTS].filter(e => !affectsRun({ event: e }));
        expect(rejected).toEqual([]);
        // A packet of each listed kind must actually reach the reducer's output.
        const before = reduceRun([]);
        const after = reduceRun([{ event: 'status', data: { message: 'Thinking... (step 2)' } }]);
        expect(after.step).not.toBe(before.step);
    });
});

describe('what the reducer ignores', () => {
    // Belt and braces: even if a stream packet did get through, it must not move
    // anything the pane shows.
    it('is unmoved by a burst of stream packets', () => {
        const base = reduceRun([{ event: 'status', data: { message: 'Thinking... (step 4)' } }]);
        const withNoise = reduceRun([
            { event: 'status', data: { message: 'Thinking... (step 4)' } },
            ...Array.from({ length: 200 }, () => ({ event: 'stream', data: { chunk: 'x' } })),
        ]);
        expect(withNoise.step).toBe(base.step);
        expect(withNoise.steps).toEqual(base.steps);
    });
});

// `finished` drives the Dashboard: it closes the socket, reloads, and clears the
// pane's tab. Getting it wrong on a CONTINUED task is what made every tab snap
// back to Run — the server replays the whole log on connect, an old `complete`
// set the flag, the reload found the task still running, the socket reopened,
// and the whole thing went round again about once a second.
describe('when a run counts as finished', () => {
    const step = (n) => ({ event: 'status', data: { status: 'running', message: `Thinking... (step ${n})` } });
    const done = { event: 'complete', data: {} };

    it('is finished when the last thing that happened was the end', () => {
        expect(reduceRun([step(1), done]).finished).toBe(true);
    });

    // The shape of a continued task: a previous turn ended, and a new one is
    // under way.
    it('is NOT finished when work resumed after an earlier completion', () => {
        expect(reduceRun([step(1), done, step(1), step(2)]).finished).toBe(false);
    });

    it('is finished again once the new turn also ends', () => {
        expect(reduceRun([step(1), done, step(1), done]).finished).toBe(true);
    });

    it('treats a phase event as work in progress too', () => {
        expect(reduceRun([done, { event: 'phase', data: { phase: 'execute', model: 'm' } }]).finished).toBe(false);
    });

    // These fire AFTER a completion while the result summary is assembled, so
    // they must not un-finish the run — the same trap Monitor hit with its
    // ask_user state.
    it('stays finished through the bookkeeping that follows a completion', () => {
        expect(reduceRun([step(1), done, { event: 'token_usage', data: { prompt_tokens: 10 } }]).finished).toBe(true);
        expect(reduceRun([step(1), done, { event: 'result_update', data: { files: [] } }]).finished).toBe(true);
    });

    it('an aborted or completed status ends it as well', () => {
        expect(reduceRun([step(1), { event: 'status', data: { status: 'aborted' } }]).finished).toBe(true);
        expect(reduceRun([step(1), { event: 'status', data: { status: 'completed' } }]).finished).toBe(true);
    });

    it('a run that never ended is not finished', () => {
        expect(reduceRun([step(1), step(2)]).finished).toBe(false);
        expect(reduceRun([]).finished).toBe(false);
    });

    // ask_user pauses a run and returns through `complete`. The pane needs both
    // facts: it ended, and it is waiting on an answer.
    it('keeps the awaiting flag alongside a completion', () => {
        const out = reduceRun([step(1), { event: 'ask_user', data: { question: 'which one?' } }, done]);
        expect(out.finished).toBe(true);
        expect(out.awaiting).toBe(true);
    });
});
