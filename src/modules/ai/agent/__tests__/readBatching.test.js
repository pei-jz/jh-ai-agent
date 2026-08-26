// ReadBatching — noticing that a run is reading files one at a time.
//
// The numbers behind this, measured over 93 real traces in this workspace:
// 930 single reads against 58 batched ones, and 485 of the single reads (52%)
// sat inside a consecutive burst that ONE batched call could have replaced.
// The longest burst was 17. That waste lands on exploration cost and step
// count, which are the two primary metrics of the recall A/B.

import { describe, it, expect } from 'vitest';
import { readShape, foldRead, batchHint, BURST_THRESHOLD, NAMED_LIMIT } from '../ReadBatching.js';

const read = (path) => ({ name: 'read_file', args: { path } });
const readMany = (...paths) => ({ name: 'read_file', args: { paths } });
const other = (name) => ({ name, args: {} });

describe('readShape', () => {
    it('recognises a single read', () => {
        expect(readShape(read('src/a.js'))).toEqual({ single: 'src/a.js' });
    });

    it('recognises a batched read', () => {
        expect(readShape(readMany('a.js', 'b.js'))).toEqual({ batched: true });
    });

    it('counts a one-entry `paths` as the single read it actually is', () => {
        expect(readShape(readMany('a.js'))).toEqual({ single: 'a.js' });
    });

    it('ignores everything that is not a read', () => {
        expect(readShape(other('grep_search'))).toBeNull();
        expect(readShape(null)).toBeNull();
        expect(readShape({ name: 'read_file', args: {} })).toBeNull();
    });
});

describe('foldRead', () => {
    it('accumulates consecutive single reads', () => {
        let b = [];
        for (const p of ['a.js', 'b.js', 'c.js']) b = foldRead(b, read(p));
        expect(b).toEqual(['a.js', 'b.js', 'c.js']);
    });

    // Reading three files with a grep in between is investigation, not the
    // pattern this looks for. Nudging that would be nagging a run doing fine.
    it('is broken by any other tool', () => {
        let b = foldRead(foldRead([], read('a.js')), other('grep_search'));
        expect(b).toEqual([]);
    });

    // A batched call is the behaviour being encouraged, so it does not merely
    // fail to extend the burst — it clears it. Otherwise a run that alternated
    // would keep creeping toward a nudge it had earned the right not to get.
    it('is RESET by a batched read, not merely left alone', () => {
        let b = foldRead(foldRead([], read('a.js')), readMany('b.js', 'c.js'));
        expect(b).toEqual([]);
    });

    it('survives junk', () => {
        expect(foldRead(null, read('a.js'))).toEqual(['a.js']);
        expect(foldRead([], null)).toEqual([]);
    });
});

describe('batchHint', () => {
    const burst = (n) => Array.from({ length: n }, (_, i) => `src/f${i}.js`);

    it('says nothing below the threshold', () => {
        expect(batchHint(burst(BURST_THRESHOLD - 1))).toBe('');
        expect(batchHint([])).toBe('');
    });

    it('fires exactly at the threshold', () => {
        const note = batchHint(burst(BURST_THRESHOLD));
        expect(note).toContain('read_file takes `paths`');
        expect(note).toContain('DO:');
    });

    // Once per run. Repeating it on every later read would make it wallpaper,
    // and the run has already been told — a second telling carries nothing new.
    it('says nothing again once it has been said', () => {
        expect(batchHint(burst(BURST_THRESHOLD), { alreadySaid: true })).toBe('');
    });

    it('does not fire again as the burst keeps growing', () => {
        // Guarded by length equality, not >=, so the caller's "already said"
        // flag is a belt-and-braces second line rather than the only one.
        expect(batchHint(burst(BURST_THRESHOLD + 1))).toBe('');
    });

    it('names the files, by basename, and caps the list', () => {
        const note = batchHint(burst(BURST_THRESHOLD), { threshold: BURST_THRESHOLD });
        expect(note).toContain('f0.js');
        expect(note).not.toContain('src/');   // basenames only — the paths are long
        const many = batchHint(burst(NAMED_LIMIT + 3), { threshold: NAMED_LIMIT + 3 });
        expect(many.split(',').length).toBeLessThanOrEqual(NAMED_LIMIT + 1);
    });

    it('survives junk', () => {
        expect(batchHint(null)).toBe('');
        expect(batchHint([null, undefined])).toBe('');
    });
});
