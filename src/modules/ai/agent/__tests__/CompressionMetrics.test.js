import { describe, it, expect } from 'vitest';
import {
    CompressionMetrics, normalizePath, fetchKey,
    hashContent, extractFacts, factRetention,
} from '../CompressionMetrics.js';

describe('normalizePath', () => {
    it('folds separators, leading ./, trailing / and case', () => {
        expect(normalizePath('.\\Src\\A.js')).toBe('src/a.js');
        expect(normalizePath('src/a.js')).toBe('src/a.js');
        expect(normalizePath('SRC/A.JS/')).toBe('src/a.js');
    });
    it('handles empty / nullish', () => {
        expect(normalizePath('')).toBe('');
        expect(normalizePath(null)).toBe('');
        expect(normalizePath(undefined)).toBe('');
    });
});

describe('CompressionMetrics — read classification', () => {
    it('first read of a file is not a re-read', () => {
        const m = new CompressionMetrics();
        expect(m.noteRead('a.js', 100)).toBe('first');
        expect(m.reReads).toBe(0);
        expect(m.reads).toBe(1);
    });

    it('re-read WITHOUT a compression in between is agent redundancy, not induced', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', 100);
        expect(m.noteRead('a.js', 100)).toBe('re-read');
        expect(m.reReads).toBe(1);
        expect(m.sameGenReReads).toBe(1);
        expect(m.inducedReReads).toBe(0);
    });

    it('re-read AFTER a compression is attributed to the compression', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', 500);
        m.noteCompression('compression');
        expect(m.noteRead('a.js', 500)).toBe('induced-re-read');
        expect(m.inducedReReads).toBe(1);
        expect(m.inducedReReadChars).toBe(500);
        expect(m.sameGenReReads).toBe(0);
    });

    it('only the FIRST re-read after a compression is induced; later ones in the same generation are not', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', 10);
        m.noteCompression('compaction', 1000);
        expect(m.noteRead('a.js', 10)).toBe('induced-re-read');
        expect(m.noteRead('a.js', 10)).toBe('re-read'); // same generation now
        expect(m.inducedReReads).toBe(1);
        expect(m.sameGenReReads).toBe(1);
    });

    it('treats differently-spelled paths as the same file', () => {
        const m = new CompressionMetrics();
        m.noteRead('./Src/A.js', 10);
        expect(m.noteRead('src\\a.js', 10)).toBe('re-read');
        expect(m.files.size).toBe(1);
    });

    it('ignores an empty path', () => {
        const m = new CompressionMetrics();
        expect(m.noteRead('', 10)).toBe('first');
        expect(m.reads).toBe(0);
        expect(m.files.size).toBe(0);
    });
});

describe('CompressionMetrics — net saving and verdict', () => {
    it('n/a when no compression ran', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', 100);
        m.noteRead('a.js', 100);   // redundancy, but nothing compressed
        expect(m.verdict()).toBe('n/a');
        expect(m.report().hint).toMatch(/No compression ran/);
    });

    it('good when compression caused no re-reads', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', 100);
        m.noteCompression('compaction', 5000);
        m.noteRead('b.js', 100);   // a different file — not a re-read
        expect(m.verdict()).toBe('good');
        expect(m.netCharsSaved()).toBe(5000);
    });

    it('poor when re-fetched chars exceed the chars saved (net negative)', () => {
        const m = new CompressionMetrics();
        m.noteRead('big.js', 9000);
        m.noteCompression('compaction', 1000);   // saved 1k…
        m.noteRead('big.js', 9000);              // …but re-fetched 9k
        expect(m.netCharsSaved()).toBe(-8000);
        expect(m.verdict()).toBe('poor');
        expect(m.report().hint).toMatch(/NET NEGATIVE/);
    });

    it('marginal when the net saving holds but a big share of re-readsは圧縮起因', () => {
        const m = new CompressionMetrics();
        // One same-generation re-read + one induced re-read → share = 0.5 (>0.34).
        m.noteRead('a.js', 10);
        m.noteRead('a.js', 10);                   // same-gen re-read
        m.noteCompression('compaction', 100000);  // large saving keeps net positive
        m.noteRead('a.js', 10);                   // induced
        expect(m.inducedShare()).toBeCloseTo(0.5);
        expect(m.netCharsSaved()).toBeGreaterThan(0);
        expect(m.verdict()).toBe('marginal');
    });

    it('induced share is 0 when there were no re-reads at all', () => {
        const m = new CompressionMetrics();
        m.noteCompression('compaction', 10);
        expect(m.inducedShare()).toBe(0);
    });
});

describe('CompressionMetrics — report', () => {
    it('counts compression kinds separately and totals them', () => {
        const m = new CompressionMetrics();
        m.noteCompression('compression');
        m.noteCompression('compression');
        m.noteCompression('compaction', 250);
        const r = m.report();
        expect(r.compressions).toBe(2);
        expect(r.compactions).toBe(1);
        expect(r.compression_events).toBe(3);
        expect(r.chars_saved).toBe(250);
    });

    it('ranks the retrievals most often re-run after a compression', () => {
        const m = new CompressionMetrics();
        m.noteRead('hot.js', 100);
        m.noteRead('cold.js', 50);
        m.noteCompression('compression');
        m.noteRead('hot.js', 100);
        m.noteCompression('compression');
        m.noteRead('hot.js', 100);
        m.noteCompression('compression');
        m.noteRead('cold.js', 50);
        const top = m.report().top_induced_files;
        expect(top[0]).toEqual({ key: 'read:hot.js', tool: 'read_file', induced_reads: 2, induced_chars: 200 });
        expect(top[1].key).toBe('read:cold.js');
    });

    it('ignores non-finite / negative sizes', () => {
        const m = new CompressionMetrics();
        m.noteRead('a.js', NaN);
        m.noteCompression('compaction', -5);
        m.noteRead('a.js', -10);
        expect(m.charsSaved).toBe(0);
        expect(m.inducedReReadChars).toBe(0);
        expect(m.inducedReReads).toBe(1);
    });
});

describe('fetchKey — which tools count as pure retrieval', () => {
    it('keys read_file by normalized path', () => {
        expect(fetchKey('read_file', { path: './Src/A.js' })).toBe('read:src/a.js');
        expect(fetchKey('read_file', { file: 'b.js' })).toBe('read:b.js');
    });
    it('keys grep/glob/list/symbol by their defining args', () => {
        expect(fetchKey('grep_search', { pattern: 'foo', path: 'src' })).toBe('grep:foo|src');
        expect(fetchKey('glob', { pattern: '**/*.js', path: '.' })).toBe('glob:**/*.js|');
        expect(fetchKey('list_files', { path: 'src/' })).toBe('list:src');
        expect(fetchKey('symbol_search', { query: 'runTask', path: '' })).toBe('symbol:runTask|');
    });
    it('EXCLUDES run_command — re-running a build/test is usually intentional', () => {
        expect(fetchKey('run_command', { command: 'npm test' })).toBe('');
    });
    it('excludes mutating and unknown tools', () => {
        expect(fetchKey('write_file', { path: 'a.js' })).toBe('');
        expect(fetchKey('finish_task', {})).toBe('');
        expect(fetchKey('anything_else')).toBe('');
    });
});

describe('CompressionMetrics — multi-tool retrieval tracking (⑤ extension)', () => {
    it('counts a re-run grep after a compression as induced', () => {
        const m = new CompressionMetrics();
        m.noteFetch(fetchKey('grep_search', { pattern: 'foo', path: 'src' }), 800, 'grep_search');
        m.noteCompression('compaction', 5000);
        const cls = m.noteFetch(fetchKey('grep_search', { pattern: 'foo', path: 'src' }), 800, 'grep_search');
        expect(cls).toBe('induced-re-read');
        expect(m.report().compression_induced_by_tool).toEqual({ grep_search: 1 });
    });

    it('different tools with different args do not collide', () => {
        const m = new CompressionMetrics();
        m.noteFetch(fetchKey('glob', { pattern: '**/*.js' }), 10, 'glob');
        m.noteFetch(fetchKey('glob', { pattern: '**/*.rs' }), 10, 'glob');
        m.noteFetch(fetchKey('list_files', { path: 'src' }), 10, 'list_files');
        expect(m.reReads).toBe(0);
        expect(m.files.size).toBe(3);
    });

    it('breaks the induced counts down per tool', () => {
        const m = new CompressionMetrics();
        m.noteFetch('read:a.js', 100, 'read_file');
        m.noteFetch('grep:x|', 100, 'grep_search');
        m.noteCompression('compaction', 10000);
        m.noteFetch('read:a.js', 100, 'read_file');
        m.noteFetch('grep:x|', 100, 'grep_search');
        expect(m.report().compression_induced_by_tool).toEqual({ read_file: 1, grep_search: 1 });
        expect(m.inducedReReads).toBe(2);
    });

    it('an empty key (non-retrieval tool) is ignored', () => {
        const m = new CompressionMetrics();
        expect(m.noteFetch('', 100, 'run_command')).toBe('first');
        expect(m.reads).toBe(0);
    });
});

// ── Stage 3: causal attribution ────────────────────────────────────────────
describe('CompressionMetrics — CONFIRMED vs SUSPECTED attribution (stage 3)', () => {
    it('confirms an induced re-fetch when the compressor dropped exactly that content', () => {
        const m = new CompressionMetrics();
        const body = 'file body v1';
        m.noteFetch('read:a.js', body.length, 'read_file', body);
        // The compressor reports the content it discarded.
        m.noteCompression('compression', 100, { droppedHashes: [hashContent(body)] });
        expect(m.noteFetch('read:a.js', body.length, 'read_file', body)).toBe('confirmed-induced-re-read');
        expect(m.confirmedInduced).toBe(1);
        expect(m.suspectedInduced).toBe(0);
    });

    it('only SUSPECTS when the compressor did not report dropping that content', () => {
        const m = new CompressionMetrics();
        m.noteFetch('read:a.js', 10, 'read_file', 'body');
        m.noteCompression('compression', 100);            // nothing reported
        expect(m.noteFetch('read:a.js', 10, 'read_file', 'body')).toBe('induced-re-read');
        expect(m.confirmedInduced).toBe(0);
        expect(m.suspectedInduced).toBe(1);
    });

    it('suspects (not confirms) when a DIFFERENT content was dropped', () => {
        const m = new CompressionMetrics();
        m.noteFetch('read:a.js', 10, 'read_file', 'body-A');
        m.noteCompression('compression', 100, { droppedHashes: [hashContent('body-B')] });
        expect(m.noteFetch('read:a.js', 10, 'read_file', 'body-A')).toBe('induced-re-read');
        expect(m.confirmedInduced).toBe(0);
    });

    it('reports both counters', () => {
        const m = new CompressionMetrics();
        m.noteFetch('read:a.js', 10, 'read_file', 'x');
        m.noteCompression('compression', 10, { droppedHashes: [hashContent('x')] });
        m.noteFetch('read:a.js', 10, 'read_file', 'x');
        const r = m.report();
        expect(r.confirmed_induced).toBe(1);
        expect(r.suspected_induced).toBe(0);
    });

    it('works without content (hash optional) — degrades to suspected', () => {
        const m = new CompressionMetrics();
        m.noteFetch('read:a.js', 10, 'read_file');
        m.noteCompression('compression', 10, { droppedHashes: ['whatever'] });
        expect(m.noteFetch('read:a.js', 10, 'read_file')).toBe('induced-re-read');
    });
});

// ── Stage 4: summary fidelity ──────────────────────────────────────────────
describe('extractFacts', () => {
    it('picks up file paths, call identifiers, codes and numbers', () => {
        const f = extractFacts('read src/modules/ai/AgentController.js then call runTask(1) — E404, MAX_STEPS=250');
        expect([...f]).toContain('src/modules/ai/agentcontroller.js');
        expect([...f]).toContain('runtask');
        expect([...f]).toContain('e404');
        expect([...f]).toContain('250');
    });
    it('returns an empty set for empty / nullish input', () => {
        expect(extractFacts('').size).toBe(0);
        expect(extractFacts(null).size).toBe(0);
    });
    it('ignores very short tokens', () => {
        expect([...extractFacts('a(1)')]).not.toContain('a');
    });
});

describe('factRetention', () => {
    it('is 1 when the summary keeps every concrete detail', () => {
        const before = 'edited src/a.js and called runTask(2)';
        const r = factRetention(before, before);
        expect(r.retention).toBe(1);
        expect(r.lost).toBe(0);
    });

    it('drops toward 0 as the summary loses details', () => {
        const before = 'src/a.js src/b.js src/c.js failed with E500 at line 42';
        const after = 'some files failed';
        const r = factRetention(before, after);
        expect(r.retention).toBeLessThan(0.3);
        expect(r.lostSamples.length).toBeGreaterThan(0);
        expect(r.total).toBeGreaterThan(r.kept);
    });

    it('counts a no-facts input as perfect retention (nothing to lose)', () => {
        expect(factRetention('hello there', 'hi').retention).toBe(1);
    });

    it('caps the reported samples at 10', () => {
        const before = Array.from({ length: 40 }, (_, i) => `file${i}.js`).join(' ');
        expect(factRetention(before, '').lostSamples).toHaveLength(10);
    });
});

describe('CompressionMetrics — retention tracking', () => {
    it('averages the retention samples the compressor reports', () => {
        const m = new CompressionMetrics();
        expect(m.meanRetention()).toBe(null);           // nothing measured yet
        m.noteCompression('compaction', 100, { retention: factRetention('src/a.js x(1)', 'src/a.js x(1)') });
        m.noteCompression('compaction', 100, { retention: factRetention('src/b.js y(2)', 'nothing') });
        const mean = m.meanRetention();
        expect(mean).toBeGreaterThan(0);
        expect(mean).toBeLessThan(1);
        expect(m.report().summary_retention_samples).toBe(2);
    });

    it('ignores a malformed retention payload', () => {
        const m = new CompressionMetrics();
        m.noteCompression('compaction', 10, { retention: { retention: 'oops' } });
        expect(m.meanRetention()).toBe(null);
    });
});

describe('hashContent', () => {
    it('is stable and content-sensitive', () => {
        expect(hashContent('abc')).toBe(hashContent('abc'));
        expect(hashContent('abc')).not.toBe(hashContent('abd'));
    });
    it('handles empty input', () => {
        expect(hashContent('')).toBe('0');
        expect(hashContent(null)).toBe('0');
    });
});
