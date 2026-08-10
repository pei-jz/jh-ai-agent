// Pure calculations behind the metadata column.
//
// The RENDERING moved to Svelte and is covered by
// dashboard/svelte/monitor/__tests__/Inspector.test.js. What stays here is the
// part worth checking with a table of inputs rather than a mounted component:
// cache accounting, cost splitting, and the shaping of a flat path list into a
// tree. That split is the point — these never needed a DOM to be verified.

import { describe, it, expect } from 'vitest';
import {
    cacheInsideInput, freshInput, costOf, fmtCost, fmtTokens, buildFileTree,
} from '../inspector.js';

describe('buildFileTree', () => {
    const paths = (files, ws) => buildFileTree(files, ws);

    it('nests files under their directories', () => {
        const t = paths([
            { path: 'C:/p/src/a.js' },
            { path: 'C:/p/src/b.js' },
            { path: 'C:/p/docs/r.md' },
        ], 'C:/p');
        expect([...t.dirs.keys()].sort()).toEqual(['docs', 'src']);
        expect(t.dirs.get('src').files.map(f => f.name).sort()).toEqual(['a.js', 'b.js']);
        expect(t.dirs.get('docs').files.map(f => f.name)).toEqual(['r.md']);
        expect(t.files).toEqual([]);            // nothing loose at the root
    });

    it('collapses a single-child directory chain into one row', () => {
        // Without this a Java- or Rust-shaped tree spends its whole width on
        // indentation before it reaches a filename.
        const t = paths([{ path: 'C:/p/src/dashboard/views/monitor/x.js' }], 'C:/p');
        expect([...t.dirs.keys()]).toEqual(['src/dashboard/views/monitor']);
        expect(t.dirs.get('src/dashboard/views/monitor').files.map(f => f.name)).toEqual(['x.js']);
    });

    it('stops collapsing where the tree actually branches', () => {
        const t = paths([
            { path: 'C:/p/src/a/one.js' },
            { path: 'C:/p/src/b/two.js' },
        ], 'C:/p');
        expect([...t.dirs.keys()]).toEqual(['src']);
        expect([...t.dirs.get('src').dirs.keys()].sort()).toEqual(['a', 'b']);
    });

    it('makes paths workspace-relative, and leaves outsiders absolute', () => {
        const t = paths([
            { path: 'C:/p/src/in.js' },
            { path: 'D:/other/out.js' },
        ], 'C:/p');
        expect([...t.dirs.keys()].sort()).toEqual(['D:/other', 'src']);
    });

    it('normalises backslashes and is case-insensitive about the workspace', () => {
        // Windows hands back both separators and either case for the drive.
        const t = paths([{ path: 'c:\\p\\src\\a.js' }], 'C:/p');
        expect([...t.dirs.keys()]).toEqual(['src']);
    });

    it('keeps the REAL path on the leaf, not the display name', () => {
        // The row shows a basename but has to open the actual file, so the full
        // path must survive the relativisation.
        const t = paths([{ path: 'C:/p/src/a.js', action: 'modified' }], 'C:/p');
        const leaf = t.dirs.get('src').files[0];
        expect(leaf.path).toBe('C:/p/src/a.js');
        expect(leaf.name).toBe('a.js');
        expect(leaf.action).toBe('modified');
    });

    it('yields an empty root for an empty list', () => {
        const t = paths([], 'C:/p');
        expect(t.dirs.size).toBe(0);
        expect(t.files).toEqual([]);
        expect(buildFileTree(null).files).toEqual([]);
    });

    it('survives entries with no usable path', () => {
        const t = paths([{ path: '' }, {}, null, { path: 'a.js' }], '');
        expect(t.files.map(f => f.name)).toEqual(['a.js']);
    });
});

describe('cacheInsideInput — asking the data, not the vendor', () => {
    it('sees an OpenAI-style report, where the input already contains the cache', () => {
        // total = prompt + completion → the cache is inside prompt_tokens.
        expect(cacheInsideInput({ prompt_tokens: 17554, completion_tokens: 699, cache_read_input_tokens: 15689, total_tokens: 18253 })).toBe(true);
    });

    it('sees an Anthropic-style report, where the buckets are separate', () => {
        expect(cacheInsideInput({ prompt_tokens: 900, completion_tokens: 300, cache_read_input_tokens: 12000, total_tokens: 13200 })).toBe(false);
    });

    it('falls back on relative size when no total was reported', () => {
        expect(cacheInsideInput({ prompt_tokens: 5000, cache_read_input_tokens: 4000 })).toBe(true);
        expect(cacheInsideInput({ prompt_tokens: 400, cache_read_input_tokens: 4000 })).toBe(false);
    });

    it('is irrelevant with no caching at all', () => {
        expect(cacheInsideInput({ prompt_tokens: 500 })).toBe(false);
        expect(cacheInsideInput()).toBe(false);
    });
});

describe('costOf', () => {
    const rates = { input_per_1m: 3, cache_read_per_1m: 0.3, output_per_1m: 15 };

    it('prices only the input the cache MISSED', () => {
        // 1M prompt tokens of which 900k were cache reads: 100k at $3/M plus
        // 900k at $0.30/M — not 1M at full price.
        const c = costOf({ prompt_tokens: 1_000_000, cache_read_input_tokens: 900_000, completion_tokens: 100_000, total_tokens: 1_100_000 }, rates);
        expect(c.in).toBeCloseTo(0.3, 5);
        expect(c.cache).toBeCloseTo(0.27, 5);
        expect(c.out).toBeCloseTo(1.5, 5);
        expect(c.total).toBeCloseTo(2.07, 5);
    });

    it('bills separate buckets at face value', () => {
        const c = costOf({ prompt_tokens: 100_000, cache_read_input_tokens: 900_000, completion_tokens: 0, total_tokens: 1_000_000 }, rates);
        expect(c.in).toBeCloseTo(0.3, 5);
    });

    it('says nothing when pricing is not configured', () => {
        expect(costOf({ prompt_tokens: 100 }, null)).toBe(null);
        expect(costOf({ prompt_tokens: 100 }, { input_per_1m: 0, cache_read_per_1m: 0, output_per_1m: 0 })).toBe(null);
    });
});

describe('fmtCost', () => {
    it('keeps enough digits for a run that cost fractions of a cent', () => {
        expect(fmtCost(0.0023)).toBe('$0.0023');
        expect(fmtCost(0.184)).toBe('$0.184');
        expect(fmtCost(12.3456)).toBe('$12.35');
    });

    it('shows a plain zero rather than nothing', () => {
        expect(fmtCost(0)).toBe('$0.00');
        expect(fmtCost(NaN)).toBe('$0.00');
    });
});
