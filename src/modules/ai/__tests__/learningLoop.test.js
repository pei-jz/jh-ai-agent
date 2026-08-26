// The learning loop, end to end: one session's experience changes the next one.
//
// This is the only test that can fail the premise of Step 1. The unit tests say
// the cards are minted and selected correctly; this one says a SECOND run
// actually sees what the FIRST run learned — from failures and from successes.

import { describe, it, expect } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

const CARDS = 'C:/ws/.agent/memory/cards.jsonl';

/** The cards.jsonl the run wrote, parsed. */
function cardsWritten(h) {
    const write = [...h.invokeCalls].reverse().find(c => c.cmd === 'write_file' && c.args?.path === CARDS);
    return write ? write.args.content.trim().split('\n').map(l => JSON.parse(l)) : [];
}

/** A run that fails an edit, reads the file, then succeeds. */
// Every test below that is ABOUT recall pins the arm explicitly. Left on the
// 'auto' default these were coin flips — they passed only because the control
// share used to be 10%, and raising it to 50% turned a rarely-flaky suite into
// a reliably-failing one. The arm assignment has its own tests; a test of what
// recall does should not also be a test of which arm it landed in.
const RECALL_ON = { memory_recall: 'on' };

function recoveryRun(extra = {}) {
    let attempt = 0;
    return makeHarness({
        config: RECALL_ON,
        script: [
            toolStep('write_file', { path: 'a.svelte', content: 'x' }),
            toolStep('read_file', { path: 'a.svelte' }),
            toolStep('write_file', { path: 'a.svelte', content: 'y' }),
            finishStep('done'),
        ],
        toolResults: {
            write_file: () => (++attempt === 1 ? 'Error: anchor does not match' : 'Success: wrote a.svelte'),
            read_file: () => 'file body',
        },
        ...extra,
    });
}

describe('learning from a session', () => {
    it('writes both a lesson and the insight that resolved it', async () => {
        const h = recoveryRun();
        await h.run('edit the component', { workspacePath: 'C:/ws' });

        const cards = cardsWritten(h);
        const lesson = cards.find(c => c.type === 'lesson');
        const insight = cards.find(c => c.type === 'insight');

        expect(lesson.signature).toBe('write_file|edit_mismatch|.svelte');
        expect(lesson.fix).toBe('read_file → write_file');
        expect(insight.what).toBe('read_file → write_file');
    });

    it('learns from a run that never failed — a used search is a discovery', async () => {
        const h = makeHarness({
            script: [
                toolStep('grep_search', { pattern: 'licenseState' }),
                toolStep('read_file', { path: 'src/license.js' }),
                toolStep('write_file', { path: 'src/license.js', content: 'x' }),
                finishStep('done'),
            ],
            toolResults: { grep_search: () => 'src/license.js:12: ...', read_file: () => 'body', write_file: () => 'Success' },
        });
        await h.run('find the licence state', { workspacePath: 'C:/ws' });

        const loc = cardsWritten(h).find(c => c.kind === 'locator');
        expect(loc.q).toBe('licenseState');
        expect(loc.target).toBe('src/license.js');
    });

    it('reports what it learned', async () => {
        const h = recoveryRun();
        await h.run('edit the component', { workspacePath: 'C:/ws' });
        expect(h.sawMessage(/🧠 学習を記録/)).toBe(true);
    });
});

/**
 * Did ANY memory reach the prompt this run?
 *
 * Checks both injection paths — the opening brief's header and the `DO:` line a
 * mid-run tool nudge carries — because a negative assertion that watches only
 * one of them passes while the other fires. Matching a single literal marker was
 * also what made these tests pass vacuously the moment the brief was reworded.
 */
const memoryInjected = (h) => h.state.histories.flat()
    .some(m => /\[Verified from earlier runs|\n {2}DO: /.test(String(m.content)));

/** Cards on disk, as the previous run would have left them. */
const stored = (over = {}) => JSON.stringify({
    id: 'L-1', type: 'lesson', signature: 'write_file|edit_mismatch|.svelte',
    trigger: { tool: 'write_file', ext: '.svelte', argShape: 'content,path', scope: 'workspace' },
    symptom: 'anchor does not match', fix: 'read_file → write_file', verified: true,
    costSteps: 7, attempts: 2, hits: 2, confidence: 0.8,
    first_seen: '2026-08-01', last_recurrence: '2026-08-11', stale: false, disabled: false,
    evidence: ['session:prev'], ...over,
});

describe('recall in a later session', () => {
    const runWith = (jsonl, opts = {}) => {
        const h = makeHarness({
            config: RECALL_ON,
            script: [toolStep('write_file', { path: 'b.svelte', content: 'x' }), finishStep('done')],
            toolResults: { write_file: () => 'Success: wrote b.svelte' },
            invokeResults: { read_file: (args) => (args?.path === CARDS ? jsonl : null) },
            ...opts,
        });
        return h.run('edit another component', { workspacePath: 'C:/ws' }).then(() => h);
    };

    it('briefs the agent before it acts', async () => {
        const h = await runWith(stored());
        const briefed = memoryInjected(h);
        expect(briefed).toBe(true);
        expect(h.sawMessage(/過去セッションの学習を参照/)).toBe(true);
    });

    it('surfaces the verified fix, phrased as an action', async () => {
        const h = await runWith(stored());
        const brief = h.state.histories.flat().map(m => String(m.content)).find(c => c.includes('[Verified from earlier runs'));
        // On its own line behind DO:, not buried in a sentence — see the
        // rendering tests in CardStore.test.js for why the prose form was dropped.
        expect(brief).toContain('\n  DO: read_file → write_file');
        expect(brief).toContain('cost 7 steps');
    });

    it('stays silent when the user disabled the card', async () => {
        // Step 2's UI writes this flag; the recall path has to honour it now, or
        // "delete the wrong lesson" would not actually stop it coming back.
        const h = await runWith(stored({ disabled: true }));
        const briefed = memoryInjected(h);
        expect(briefed).toBe(false);
    });

    it('stays silent when there is nothing learned yet', async () => {
        const h = await runWith('');
        expect(memoryInjected(h)).toBe(false);
    });

    it('does not change what the agent does', async () => {
        const h = await runWith(stored());
        expect(h.toolCalls.map(c => c.name)).toEqual(['write_file', 'finish_task']);
    });

    it('recalls nothing when the control arm is selected', async () => {
        // memory_recall: 'off' is the A/B control. Learning must continue — a
        // control session still has to produce data, or the arms are not
        // comparable on anything except the thing being withheld.
        // A run that both HAS cards on disk (so recall could fire) and produces
        // one (so learning can be observed).
        const h = recoveryRun({
            config: { memory_recall: 'off' },
            invokeResults: { read_file: (args) => (args?.path === CARDS ? stored() : null) },
        });
        await h.run('edit the component', { workspacePath: 'C:/ws' });

        expect(memoryInjected(h)).toBe(false);
        expect(h.invokeCalls.some(c => c.cmd === 'write_file' && c.args?.path === CARDS)).toBe(true);
    });
});

// Step 4b — the knowledge graph, delivered when it is actionable.
//
// Not a prompt prefix: a neighbourhood depends on the task, so a prefix would
// break the cached system prompt for every run, and the 89-run measurement
// showed that advice delivered up front and then buried does not change
// behaviour. This lands right after the edit, when "what else imports this" is
// the next question rather than a thing to have remembered.
describe('impact of an edit (Step 4b)', () => {
    const editRun = (extra = {}) => makeHarness({
        config: RECALL_ON,
        script: [toolStep('write_file', { path: 'src/a.js', content: 'x' }), finishStep('done')],
        toolResults: { write_file: () => 'Success: wrote src/a.js' },
        invokeResults: {
            index_deps: () => [{ path: 'src/b.js', kind: 'imports' }, { path: 'src/c.js', kind: 'imports' }],
        },
        ...extra,
    });

    const toolResultText = (h) => h.state.histories.flat().map(m => JSON.stringify(m.content)).join('\n');

    it('lists what imports the file that was just changed', async () => {
        const h = editRun();
        await h.run('edit a', { workspacePath: 'C:/ws' });
        const seen = toolResultText(h);
        expect(seen).toContain('src/b.js');
        expect(seen).toContain('Impact');
    });

    it('withholds it from the control arm, like every other injection', async () => {
        // It is injected text under the same A/B. Exempting it would make the
        // control arm a control for only part of what is being tested.
        const h = editRun({ config: { memory_recall: 'off' } });
        await h.run('edit a', { workspacePath: 'C:/ws' });
        expect(toolResultText(h)).not.toContain('Impact');
    });

    it('says nothing when the index knows of no dependants', async () => {
        const h = editRun({ invokeResults: { index_deps: () => [] } });
        await h.run('edit a', { workspacePath: 'C:/ws' });
        expect(toolResultText(h)).not.toContain('Impact');
    });

    it('never fails the edit when the index is unavailable', async () => {
        // The note is an extra, not a step. An unbuilt index must cost nothing.
        const h = editRun({ invokeResults: { index_deps: () => { throw new Error('no such table'); } } });
        await h.run('edit a', { workspacePath: 'C:/ws' });
        expect(h.toolCalls.map(c => c.name)).toEqual(['write_file', 'finish_task']);
    });
});

// Step 6. The gate is the point of these tests: the playbook is finished, and it
// is off, because its own precondition (a positive follow-through lift) is unmet
// and switching it on mid-measurement would make the v2 rework unattributable.
describe('playbook (Step 6)', () => {
    const TRACE = 'C:/ws/.agent/trace';
    const rsSession = JSON.stringify({ i: 1, tool: 'read_file', target: 'a.rs', ok: true }) + '\n'
        + JSON.stringify({ i: 2, tool: 'write_file', target: 'a.rs', ok: true }) + '\n'
        + JSON.stringify({ i: 3, tool: 'run_command', target: '', ok: true });
    const jsSession = JSON.stringify({ i: 1, tool: 'read_file', target: 'a.js', ok: true }) + '\n'
        + JSON.stringify({ i: 2, tool: 'write_file', target: 'a.js', ok: true });

    const withTraces = (config) => makeHarness({
        config,
        script: [toolStep('write_file', { path: 'x.rs', content: 'x' }), finishStep('done')],
        toolResults: { write_file: () => 'Success' },
        invokeResults: {
            read_dir: () => [1, 2, 3, 4, 5, 6].map(n => ({ name: `sess_${n}.jsonl` })),
            read_file: (args) => {
                const p = String(args?.path || '');
                if (!p.startsWith(TRACE)) return null;
                return /sess_[123]\./.test(p) ? rsSession : jsSession;
            },
        },
    });

    const prompted = (h) => h.state.histories.flat().map(m => String(m.content)).join('\n');

    it('stays out of the prompt while the flag is off — the default', async () => {
        const h = withTraces(RECALL_ON);
        await h.run('update the .rs module', { workspacePath: 'C:/ws' });
        expect(prompted(h)).not.toContain('Playbook');
    });

    it('injects the procedure for that file kind once enabled', async () => {
        const h = withTraces({ ...RECALL_ON, playbook: 'on' });
        await h.run('update the .rs module', { workspacePath: 'C:/ws' });
        const seen = prompted(h);
        expect(seen).toContain('Playbook');
        expect(seen).toContain('run_command');
    });

    it('says nothing when the request names no file kind to match on', async () => {
        // Guessing an extension would be inventing the one fact that decides
        // which procedure gets shown.
        const h = withTraces({ ...RECALL_ON, playbook: 'on' });
        await h.run('clean things up', { workspacePath: 'C:/ws' });
        expect(prompted(h)).not.toContain('Playbook');
    });

    it('is withheld from the control arm like every other injection', async () => {
        const h = withTraces({ memory_recall: 'off', playbook: 'on' });
        await h.run('update the .rs module', { workspacePath: 'C:/ws' });
        expect(prompted(h)).not.toContain('Playbook');
    });
});

describe('measurement', () => {
    const metricsOf = (h) => {
        const w = [...h.invokeCalls].reverse().find(
            c => c.cmd === 'write_file' && String(c.args?.path || '').endsWith('metrics.jsonl'));
        return w ? JSON.parse(w.args.content.trim().split('\n').pop()) : null;
    };

    it('writes one measurement row per run, tagged with its arm', async () => {
        const h = recoveryRun();
        await h.run('edit the component', { workspacePath: 'C:/ws' });
        const row = metricsOf(h);
        expect(row.recall).toBe('on');
        expect(row.iterations).toBeGreaterThan(0);
        expect(row.toolCalls).toBeGreaterThan(0);
    });

    it('measures the control arm too', async () => {
        const h = recoveryRun({ config: { memory_recall: 'off' } });
        await h.run('edit the component', { workspacePath: 'C:/ws' });
        expect(metricsOf(h).recall).toBe('off');
    });

    // The control arm's reason for existing. A card whose recipe is
    // "read_file → write_file" describes an ordering the agent produces
    // constantly on its own, so the recall arm's follow-through rate says
    // nothing until it can be set against how often that happened with no card
    // in the prompt. Scoring the same cards against a run that never saw them
    // is where that number comes from — so a control run has to select cards
    // (followChecked > 0) while showing none (cardsShown === 0).
    it('scores cards against the control arm without showing them', async () => {
        const h = recoveryRun({
            config: { memory_recall: 'off' },
            invokeResults: { read_file: (args) => (args?.path === CARDS ? stored() : null) },
        });
        await h.run('edit the component', { workspacePath: 'C:/ws' });
        const row = metricsOf(h);

        expect(row.cardsShown).toBe(0);
        expect(row.cardsSelected).toBeGreaterThan(0);
        expect(row.followChecked).toBeGreaterThan(0);
        // Nothing reached the prompt, so nothing was spent on it.
        expect(row.memoryChars).toBe(0);
        expect(memoryInjected(h)).toBe(false);
    });

    it('records how much looking around preceded the first edit', async () => {
        const h = makeHarness({
            script: [
                toolStep('grep_search', { pattern: 'licenseState' }),
                toolStep('read_file', { path: 'src/license.js' }),
                toolStep('write_file', { path: 'src/license.js', content: 'x' }),
                finishStep('done'),
            ],
            toolResults: { grep_search: () => 'hit', read_file: () => 'body', write_file: () => 'Success' },
        });
        await h.run('find and fix', { workspacePath: 'C:/ws' });
        expect(metricsOf(h).explorationCost).toBe(2);
    });
});

// The read-batching nudge. Measured over 93 real traces: 930 single reads
// against 58 batched, with 52% of the single reads inside a burst one batched
// call could have replaced. It is OFF by default — not because it is unready,
// but because it would be a fourth injected text and would make the v2
// injection experiment unattributable.
describe('read-batching nudge', () => {
    const threeReads = (config) => makeHarness({
        config,
        script: [
            toolStep('read_file', { path: 'src/a.js' }),
            toolStep('read_file', { path: 'src/b.js' }),
            toolStep('read_file', { path: 'src/c.js' }),
            finishStep('done'),
        ],
        toolResults: { read_file: () => 'file body' },
    });
    const prompted = (h) => h.state.histories.flat().map(m => JSON.stringify(m.content)).join('\n');

    it('stays out of the prompt while the flag is off — the default', async () => {
        const h = threeReads(RECALL_ON);
        await h.run('look around', { workspacePath: 'C:/ws' });
        expect(prompted(h)).not.toContain('Efficiency');
    });

    it('points out the burst once enabled', async () => {
        const h = threeReads({ ...RECALL_ON, read_batch_hint: 'on' });
        await h.run('look around', { workspacePath: 'C:/ws' });
        const seen = prompted(h);
        expect(seen).toContain('Efficiency');
        expect(seen).toContain('paths');
    });

    it('says it once, however long the run goes on', async () => {
        const h = makeHarness({
            config: { ...RECALL_ON, read_batch_hint: 'on' },
            script: [
                ...['a', 'b', 'c', 'd', 'e'].map(n => toolStep('read_file', { path: `src/${n}.js` })),
                finishStep('done'),
            ],
            toolResults: { read_file: () => 'body' },
        });
        await h.run('look around', { workspacePath: 'C:/ws' });
        // The LAST snapshot only. `histories` holds the conversation as it stood
        // at each LLM call, so a single note appears in every snapshot taken
        // after it — counting across all of them measures the number of calls,
        // not the number of notes.
        const final = h.state.histories[h.state.histories.length - 1];
        const hits = final.map(m => JSON.stringify(m.content)).join('\n').split('[Efficiency]').length - 1;
        expect(hits).toBe(1);
    });

    it('stays quiet when the agent batched its reads', async () => {
        const h = makeHarness({
            config: { ...RECALL_ON, read_batch_hint: 'on' },
            script: [
                toolStep('read_file', { paths: ['src/a.js', 'src/b.js', 'src/c.js'] }),
                finishStep('done'),
            ],
            toolResults: { read_file: () => 'body' },
        });
        await h.run('look around', { workspacePath: 'C:/ws' });
        expect(prompted(h)).not.toContain('Efficiency');
    });
});

// A sub-agent is not a run. It is one phase of its parent — short (its step cap
// is 8), often read-only, and it drew its OWN A/B arm, so a parent in the recall
// arm could spawn a child in the control arm inside the same task. Averaging
// those rows in changes the unit the comparison is over and makes the arms
// non-independent.
describe('sub-agents do not write measurement rows', () => {
    const metricsWrites = (h) => h.invokeCalls.filter(
        c => c.cmd === 'write_file' && String(c.args?.path || '').endsWith('metrics.jsonl'));

    it('writes one row for a normal run', async () => {
        const h = recoveryRun();
        await h.run('edit the component', { workspacePath: 'C:/ws' });
        expect(metricsWrites(h).length).toBeGreaterThan(0);
    });

    /** The parent sets this flag on the child before calling child.run(). */
    const runAsSubagent = async (h) => {
        const agent = await h.build();
        agent._isSubagent = true;
        await agent.run('edit the component', 'C:/ws', () => {}, () => {}, async () => true);
        return h;
    };

    it('writes none when the controller is a sub-agent', async () => {
        expect(metricsWrites(await runAsSubagent(recoveryRun()))).toHaveLength(0);
    });

    it('still LEARNS from a sub-agent run — only the row is withheld', async () => {
        // What the child found is real knowledge; it is the measurement UNIT that
        // was wrong, not the learning.
        const h = await runAsSubagent(recoveryRun());
        expect(h.invokeCalls.some(c => c.cmd === 'write_file' && c.args?.path === CARDS)).toBe(true);
    });
});
