// Playbook — Step 6.
//
// The rule under test is not "does LCS work". It is the one the 89-run
// measurement forced: a skeleton that merely restates what the agent does anyway
// must not be stored. Follow-through on tool-ordering advice was 53.8% against a
// 50.0% control base rate, which is what describing the base rate back to a
// model buys you.

import { describe, it, expect } from 'vitest';
import {
    lcs, sequenceOf, commonSkeleton, subjectExt, mintPlaybooks, renderPlaybook,
    MIN_RUNS, MIN_SKELETON, MAX_SKELETON, phases,
} from '../Playbook.js';

const e = (tool, target, ok = true) => ({ tool, target, ok });
/** A run whose common shape is specific to .rs, plus per-run noise. */
const rsRun = (noise) => ({
    events: [
        e('grep_search', null), e('read_file', 'a.rs'), ...noise,
        e('write_file', 'a.rs'), e('run_command', null), e('read_file', 'a.rs'),
    ],
});

describe('sequenceOf', () => {
    it('collapses consecutive repeats into one step', () => {
        // Three reads in a row are one "reading" step. Kept separate, a run that
        // happened to read a lot dominates the LCS with one tool repeated.
        expect(sequenceOf([e('read_file', 'a'), e('read_file', 'b'), e('write_file', 'a')]))
            .toEqual(['read_file', 'write_file']);
    });

    it('ignores failed calls — a playbook is built from what worked', () => {
        expect(sequenceOf([e('write_file', 'a', false), e('read_file', 'a')])).toEqual(['read_file']);
    });

    it('survives junk', () => {
        expect(sequenceOf(null)).toEqual([]);
        expect(sequenceOf([null, {}])).toEqual([]);
    });
});

describe('lcs', () => {
    it('finds the order two runs share, gaps allowed', () => {
        expect(lcs(['a', 'x', 'b', 'c'], ['a', 'b', 'y', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('is empty when nothing is shared', () => {
        expect(lcs(['a'], ['b'])).toEqual([]);
        expect(lcs([], ['a'])).toEqual([]);
    });
});

describe('commonSkeleton', () => {
    it('keeps only what EVERY run shares', () => {
        expect(commonSkeleton([
            ['read', 'edit', 'test'],
            ['read', 'grep', 'edit', 'test'],
            ['read', 'edit', 'lint', 'test'],
        ])).toEqual(['read', 'edit', 'test']);
    });

    it('collapses to nothing when one run breaks the pattern', () => {
        expect(commonSkeleton([['read', 'edit'], ['read', 'edit'], ['deploy']])).toEqual([]);
    });
});

describe('subjectExt', () => {
    it('reports the kind of file the run actually changed', () => {
        expect(subjectExt([e('read_file', 'a.js'), e('write_file', 'b.rs')])).toBe('.rs');
    });

    it('is empty for a run that changed nothing', () => {
        expect(subjectExt([e('read_file', 'a.js'), e('grep_search', null)])).toBe('');
    });
});

describe('mintPlaybooks', () => {
    /** Runs on another file kind, so ".rs" has something to be different FROM. */
    const jsRuns = () => [1, 2, 3].map(() => ({ events: [e('read_file', 'a.js'), e('write_file', 'a.js')] }));

    it('extracts the shape a kind of task takes', () => {
        const pbs = mintPlaybooks([
            rsRun([]), rsRun([e('glob', null)]), rsRun([e('list_files', null)]), ...jsRuns(),
        ]);
        expect(pbs).toHaveLength(1);
        expect(pbs[0].ext).toBe('.rs');
        expect(pbs[0].runs).toBe(3);
        // Phases, not a transcript: the trailing re-read is the same phase as the
        // first read, and repeating it would describe how much reading those runs
        // happened to need rather than what the procedure is.
        expect(pbs[0].steps).toEqual(['grep_search', 'read_file', 'write_file', 'run_command']);
    });

    // Not a limitation to work around — it is the rule. With one file kind in
    // the corpus, "the shape of .rs work" and "the shape of all work here" are
    // the same sequence, and nothing licenses calling it the former. The measured
    // cost of getting this wrong is a card that describes the base rate back to
    // the agent and is followed no more often than silence.
    it('stays silent when there is no contrast to attribute anything to', () => {
        expect(mintPlaybooks([rsRun([]), rsRun([]), rsRun([])])).toEqual([]);
    });

    // The rule this module exists to enforce.
    it('drops a skeleton that only restates what every task does', () => {
        // Every run here — .js and .rs alike — is read → write. The .js skeleton
        // is therefore exactly the global one and teaches nothing.
        const same = (p) => ({ events: [e('read_file', p), e('write_file', p)] });
        const pbs = mintPlaybooks([
            same('a.js'), same('b.js'), same('c.js'),
            same('a.rs'), same('b.rs'), same('c.rs'),
        ]);
        expect(pbs).toEqual([]);
    });

    it('keeps the kind that genuinely differs from the rest', () => {
        const plain = (p) => ({ events: [e('read_file', p), e('write_file', p)] });
        // .rs additionally always compiles and re-reads afterwards.
        const rs = (p) => ({ events: [e('read_file', p), e('write_file', p), e('run_command', null), e('read_file', p)] });
        const pbs = mintPlaybooks([plain('a.js'), plain('b.js'), plain('c.js'), rs('a.rs'), rs('b.rs'), rs('c.rs')]);
        expect(pbs.map(p => p.ext)).toEqual(['.rs']);
        expect(pbs[0].steps).toContain('run_command');
    });

    it('says nothing on too little evidence', () => {
        expect(mintPlaybooks([rsRun([]), rsRun([])])).toEqual([]);
        expect(mintPlaybooks([])).toEqual([]);
        expect(mintPlaybooks(null)).toEqual([]);
    });

    it('needs a backbone worth calling a procedure', () => {
        expect(MIN_SKELETON).toBeGreaterThanOrEqual(3);
        expect(MIN_RUNS).toBeGreaterThanOrEqual(3);
    });
});

// Both rules here came from running the extractor over this project's own 40
// real traces. The first pass returned a 14-step `.js` "procedure" that was
// `read_file → grep_search` five times over, and put `finish_task` in every
// skeleton — a step with 100% support and no information.
describe('phases', () => {
    it('reduces a repeated cycle to the distinct steps in order', () => {
        expect(phases(['read_file', 'grep_search', 'read_file', 'grep_search', 'write_file']))
            .toEqual(['read_file', 'grep_search', 'write_file']);
    });

    it('drops the calls that end or narrate a run rather than doing its work', () => {
        expect(phases(['read_file', 'write_file', 'finish_task', 'present_result']))
            .toEqual(['read_file', 'write_file']);
    });

    it('survives junk', () => {
        expect(phases(null)).toEqual([]);
    });
});

describe('overfitting guard', () => {
    it('drops a skeleton too long to be a procedure', () => {
        // Few, very similar runs share a long sequence. That length is the
        // evidence it will not generalise, not evidence that it will.
        const long = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const runs = [1, 2, 3].map(() => ({
            events: [...long.map(t => e(t, null)), e('write_file', 'x.rs')],
        }));
        const other = [1, 2, 3].map(() => ({ events: [e('read_file', 'a.js'), e('write_file', 'a.js')] }));
        expect(mintPlaybooks([...runs, ...other]).some(p => p.ext === '.rs')).toBe(false);
    });

    it('bounds every playbook it does emit', () => {
        expect(MAX_SKELETON).toBeGreaterThan(MIN_SKELETON);
        expect(MAX_SKELETON).toBeLessThanOrEqual(8);
    });
});

describe('renderPlaybook', () => {
    it('uses the same DO: shape as a card, for the same measured reason', () => {
        const text = renderPlaybook({ ext: '.rs', runs: 4, steps: ['read_file', 'write_file', 'run_command'] });
        expect(text).toContain('\n  DO: read_file → write_file → run_command');
        expect(text).toContain('4 successful runs');
    });

    it('renders nothing for an empty playbook', () => {
        expect(renderPlaybook(null)).toBe('');
        expect(renderPlaybook({ steps: [] })).toBe('');
    });
});
