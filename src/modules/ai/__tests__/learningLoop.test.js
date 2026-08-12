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
function recoveryRun(extra = {}) {
    let attempt = 0;
    return makeHarness({
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

describe('recall in a later session', () => {
    /** Cards on disk, as the previous run would have left them. */
    const stored = (over = {}) => JSON.stringify({
        id: 'L-1', type: 'lesson', signature: 'write_file|edit_mismatch|.svelte',
        trigger: { tool: 'write_file', ext: '.svelte', argShape: 'content,path', scope: 'workspace' },
        symptom: 'anchor does not match', fix: 'read_file → write_file', verified: true,
        costSteps: 7, attempts: 2, hits: 2, confidence: 0.8,
        first_seen: '2026-08-01', last_recurrence: '2026-08-11', stale: false, disabled: false,
        evidence: ['session:prev'], ...over,
    });

    const runWith = (jsonl, opts = {}) => {
        const h = makeHarness({
            script: [toolStep('write_file', { path: 'b.svelte', content: 'x' }), finishStep('done')],
            toolResults: { write_file: () => 'Success: wrote b.svelte' },
            invokeResults: { read_file: (args) => (args?.path === CARDS ? jsonl : null) },
            ...opts,
        });
        return h.run('edit another component', { workspacePath: 'C:/ws' }).then(() => h);
    };

    it('briefs the agent before it acts', async () => {
        const h = await runWith(stored());
        const briefed = h.state.histories.flat().some(m => String(m.content).includes('[Memory from earlier sessions'));
        expect(briefed).toBe(true);
        expect(h.sawMessage(/過去セッションの学習を参照/)).toBe(true);
    });

    it('surfaces the verified fix, phrased as an action', async () => {
        const h = await runWith(stored());
        const brief = h.state.histories.flat().map(m => String(m.content)).find(c => c.includes('[Memory from earlier'));
        expect(brief).toContain('What worked: read_file → write_file');
        expect(brief).toContain('Do that first');
    });

    it('stays silent when the user disabled the card', async () => {
        // Step 2's UI writes this flag; the recall path has to honour it now, or
        // "delete the wrong lesson" would not actually stop it coming back.
        const h = await runWith(stored({ disabled: true }));
        const briefed = h.state.histories.flat().some(m => String(m.content).includes('[Memory from earlier sessions'));
        expect(briefed).toBe(false);
    });

    it('stays silent when there is nothing learned yet', async () => {
        const h = await runWith('');
        expect(h.state.histories.flat().some(m => String(m.content).includes('[Memory'))).toBe(false);
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

        expect(h.state.histories.flat().some(m => String(m.content).includes('[Memory'))).toBe(false);
        expect(h.invokeCalls.some(c => c.cmd === 'write_file' && c.args?.path === CARDS)).toBe(true);
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
