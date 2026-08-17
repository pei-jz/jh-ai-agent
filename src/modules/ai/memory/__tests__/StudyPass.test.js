// StudyPass — learning a workspace's structure without running a task.
//
// The property that matters most here is what this pass does NOT do: it records
// facts about the tree (a symbol is declared at file:line) and never an opinion
// about what code means. That is what lets its output sit beside experience
// instead of needing a confidence discount.

import { describe, it, expect, vi } from 'vitest';
import {
    isLandmark, symbolCards, staleStudyCards, applyStudy, coverageByDir,
    runStudyPass, STUDY_FILE_CAP, STUDY_GLOB_MAX, SYMBOLS_PER_FILE, targetPath, indexSpreadsheets, dropStudyCards,
    fileStamp, STUDY_SHEET_GLOB,
    fairShare, dirOf,
} from '../StudyPass.js';
import { cardKey } from '../CardStore.js';

const sym = (name, over = {}) => ({ name, kind: 'function', line: 12, path: 'src/a.js', exported: true, ...over });

describe('isLandmark', () => {
    it('keeps names another task would plausibly search for', () => {
        expect(isLandmark(sym('createNewFileOfType'))).toBe(true);
        expect(isLandmark(sym('licenseState'))).toBe(true);
    });

    it('drops names that match everywhere and mean nothing', () => {
        // `fmt` exists in fifty files; as a landmark it is worse than nothing.
        for (const n of ['fmt', 'get', 'set', 'run', 'init', 'main', 'default', 'constructor']) {
            expect(isLandmark(sym(n)), n).toBe(false);
        }
        expect(isLandmark(sym('x'.repeat(80)))).toBe(false);
        expect(isLandmark(null)).toBe(false);
    });
});

describe('symbolCards', () => {
    const meta = { date: '2026-08-12', commit: 'abc1234' };

    it('records where a symbol IS, not what it means', () => {
        const [c] = symbolCards([sym('createNewFileOfType', { path: 'src/core/Editor.js', line: 412 })], meta);
        expect(c.q).toBe('createNewFileOfType');
        expect(c.target).toBe('src/core/Editor.js:412');
        expect(c.kind).toBe('locator');
        // Nothing resembling a summary or an opinion is stored.
        expect(Object.keys(c)).not.toContain('summary');
        expect(Object.keys(c)).not.toContain('hypothesis');
    });

    it('marks its origin so a human can review or drop the lot', () => {
        expect(symbolCards([sym('licenseState')], meta)[0].origin).toBe('study');
    });

    it('records the commit it was read at, for later staleness', () => {
        expect(symbolCards([sym('licenseState')], meta)[0].evidence).toEqual(['commit:abc1234']);
    });

    it('produces the same identity an experience-learned locator would', () => {
        // Same q + target ⇒ same key, so a study card and a verified one merge
        // instead of coexisting as duplicates.
        const studied = symbolCards([sym('licenseState', { path: 'src/license.js', line: 3 })], meta)[0];
        expect(cardKey(studied)).toBe('insight|locator|licenseState|src/license.js:3');
    });

    it('does not record the same name twice from one file', () => {
        const cards = symbolCards([sym('licenseState'), sym('licenseState', { line: 99 })], meta);
        expect(cards).toHaveLength(1);
    });

    it('skips junk without throwing', () => {
        expect(symbolCards(null, meta)).toEqual([]);
        expect(symbolCards([sym('fmt')], meta)).toEqual([]);
    });
});

// Structural knowledge rots — the symbol moves, the file is deleted. A study
// card is a claim about the PRESENT, so a claim about a file that is gone is
// simply wrong and must not keep being injected.
describe('staleStudyCards', () => {
    const study = (target) => ({ origin: 'study', q: 'x', target });
    const lived = (target) => ({ origin: 'experience', q: 'x', target });

    it('retires a study card whose file no longer exists', () => {
        const { stale, fresh } = staleStudyCards(
            [study('src/gone.js:1'), study('src/here.js:2')], ['src/here.js']);
        expect(stale.map(c => c.target)).toEqual(['src/gone.js:1']);
        expect(fresh.map(c => c.target)).toEqual(['src/here.js:2']);
    });

    it('NEVER retires an experience card — that happened, and still did', () => {
        // A locator the agent actually used records history. The file moving
        // does not make the history false, and dropping it would erase it.
        const { stale, fresh } = staleStudyCards([lived('src/gone.js:1')], []);
        expect(stale).toEqual([]);
        expect(fresh).toHaveLength(1);
    });

    it('survives an empty store', () => {
        expect(staleStudyCards(null, [])).toEqual({ stale: [], fresh: [] });
    });
});

describe('applyStudy', () => {
    const card = (q, target, over = {}) => ({ origin: 'study', q, target, last_recurrence: '2026-08-01', ...over });

    it('drops what the tree lost and keeps what it kept', () => {
        const out = applyStudy(
            [card('a', 'src/gone.js:1'), card('b', 'src/here.js:2')],
            [],
            ['src/here.js'],
        );
        expect(out.map(c => c.q)).toEqual(['b']);
    });

    it('refreshes a card the new pass saw again, without duplicating it', () => {
        const out = applyStudy(
            [card('a', 'src/a.js:1')],
            [card('a', 'src/a.js:1', { last_recurrence: '2026-08-12', evidence: ['commit:new'] })],
            ['src/a.js'],
        );
        expect(out).toHaveLength(1);
        expect(out[0].last_recurrence).toBe('2026-08-12');
        expect(out[0].evidence).toEqual(['commit:new']);
    });

    it('keeps experience cards untouched through a study', () => {
        const exp = { origin: 'experience', q: 'z', target: 'src/gone.js:9' };
        expect(applyStudy([exp], [], []).map(c => c.q)).toEqual(['z']);
    });
});

describe('coverageByDir', () => {
    it('counts what is known per directory, busiest first', () => {
        const rows = coverageByDir([
            { target: 'src/modules/ai/a.js:1' },
            { target: 'src/modules/ai/b.js:1' },
            { target: 'src/dashboard/c.js:1' },
        ]);
        expect(rows[0]).toEqual({ dir: 'src/modules', count: 2 });
        expect(rows[1]).toEqual({ dir: 'src/dashboard', count: 1 });
    });

    it('normalises Windows separators', () => {
        expect(coverageByDir([{ target: 'src\\a\\b.js:1' }])[0].dir).toBe('src/a');
    });
});

// A cap that always spends itself on the busiest directory never reaches the
// places the agent has not looked. fairShare spreads the budget round-robin.
describe('fairShare', () => {
    it('keeps everything when the tree fits in the cap', () => {
        const files = ['src/a/a.js', 'src/b/b.js'];
        expect(fairShare(files, 10)).toEqual({ selected: files, omitted: 0 });
    });

    it('spreads the budget across directories instead of one alphabetical prefix', () => {
        // 6 files in src/a, 4 in src/b. A cap of 4 must take from BOTH, not the
        // first four of src/a.
        const files = [
            'src/a/f1.js', 'src/a/f2.js', 'src/a/f3.js', 'src/a/f4.js',
            'src/a/f5.js', 'src/a/f6.js', 'src/b/g1.js', 'src/b/g2.js',
            'src/b/g3.js', 'src/b/g4.js',
        ];
        const { selected, omitted } = fairShare(files, 4);
        expect(selected).toEqual(['src/a/f1.js', 'src/b/g1.js', 'src/a/f2.js', 'src/b/g2.js']);
        expect(omitted).toBe(6);
    });

    it('gives a small directory a voice even against a giant one', () => {
        // 10 files in src/a, 1 in src/b. The lone src/b file MUST be selected.
        const files = Array.from({ length: 10 }, (_, i) => `src/a/f${i}.js`);
        files.push('src/b/only.js');
        const { selected } = fairShare(files, 5);
        expect(selected).toContain('src/b/only.js');
    });

    it('returns selected paths in stable input order per directory', () => {
        const files = ['src/a/z.js', 'src/a/a.js', 'src/b/b.js'];
        const { selected } = fairShare(files, 2);
        expect(selected).toEqual(['src/a/z.js', 'src/b/b.js']);
    });

    it('reports how many were skipped, so the UI can say so', () => {
        const files = Array.from({ length: 7 }, (_, i) => `src/x/f${i}.js`);
        expect(fairShare(files, 3).omitted).toBe(4);
    });

    it('survives junk', () => {
        expect(fairShare(null, 5)).toEqual({ selected: [], omitted: 0 });
        expect(fairShare([], 5)).toEqual({ selected: [], omitted: 0 });
    });
});

describe('dirOf', () => {
    it('buckets at the configured depth', () => {
        expect(dirOf('src/modules/ai/a.js')).toBe('src/modules');
    });

    it('never lets the filename become the directory', () => {
        expect(dirOf('lib/z.js')).toBe('lib');
    });

    it('normalises Windows separators and drops the drive letter', () => {
        // The drive letter is not a directory, and every path in one workspace
        // shares it — keeping it would merge nothing but would clutter the bucket.
        expect(dirOf('C:\\ws\\src\\a\\b.js')).toBe('ws/src');
    });

    it('labels a root-level file as (root)', () => {
        expect(dirOf('a.js')).toBe('(root)');
    });
});

describe('runStudyPass', () => {
    /** One exported symbol, so a parse either finds `alpha` or found nothing. */
    const SRC = 'export function alpha() {}\n';

    /**
     * A backend that answers glob/read and records what was indexed.
     *
     * The two globs are answered separately: the pass asks for source and then
     * for workbooks, and a mock that returns the same list to both would index
     * every source file twice.
     */
    const backend = (files, bodies = {}, sheets = []) => {
        const put = [];
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') {
                const isSheets = String(args.pattern || '').includes('xlsx');
                return { files: isSheets ? sheets : files, truncated: false };
            }
            if (cmd === 'read_file') return bodies[args.path] ?? SRC;
            if (cmd === 'index_hashes') return [];
            if (cmd === 'index_put_files') { put.push(...args.files); return args.files.length; }
            if (cmd === 'index_prune') return 0;
            return null;
        });
        return { invoke, put };
    };

    it('writes symbols to the INDEX, not to cards', async () => {
        // Symbols are a lookup, and a lookup belongs behind a query. The first
        // version wrote one card per symbol and produced 716 unreadable rows.
        const { invoke, put } = backend(['src/a.js']);
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.cards).toBeUndefined();
        expect(put).toHaveLength(1);
        expect(put[0].symbols.map(s => s.name)).toContain('alpha');
        expect(put[0].lang).toBe('js');
    });

    it('records the import graph alongside the symbols', async () => {
        const { invoke, put } = backend(['src/a.js'], {
            'src/a.js': `import { b } from './b.js';\n${SRC}`,
        });
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(put[0].deps).toEqual([['src/b.js', 'imports']]);
    });

    it('re-parses only what changed since the last pass', async () => {
        // The whole point of the content hash: a second pass over an untouched
        // tree costs the reads and nothing else.
        const body = SRC;
        const { contentHash } = await import('../CodeIndex.js');
        const put = [];
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') {
                return { files: String(args.pattern).includes('xlsx') ? [] : ['src/a.js', 'src/b.js'] };
            }
            if (cmd === 'read_file') return body;
            if (cmd === 'index_hashes') return [['src/a.js', contentHash(body)]];
            if (cmd === 'index_put_files') { put.push(...args.files); return args.files.length; }
            return 0;
        });
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(put.map(f => f.path)).toEqual(['src/b.js']);
    });

    it('retires files the tree no longer has', async () => {
        const { invoke } = backend(['src/a.js']);
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        const prune = invoke.mock.calls.find(c => c[0] === 'index_prune');
        expect(prune[1].livePaths).toEqual(['src/a.js']);
    });

    it('does NOT retire anything when the glob was truncated — the list is partial', async () => {
        // A truncated glob means the pass saw only part of the tree. Pruning
        // against a partial list would delete files that still exist.
        const put = [];
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') {
                const isSheets = String(args.pattern || '').includes('xlsx');
                return { files: isSheets ? [] : ['src/a.js'], truncated: true };
            }
            if (cmd === 'read_file') return SRC;
            if (cmd === 'index_hashes') return [];
            if (cmd === 'index_put_files') { put.push(...args.files); return args.files.length; }
            if (cmd === 'index_prune') { prunedArgs = args; return 0; }
            return null;
        });
        let prunedArgs = null;
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(prunedArgs.truncated).toBe(true);
        expect(r.truncated).toBe(true);
    });

    it('reports how many files were omitted when the tree exceeds the cap', async () => {
        const { invoke } = backend(Array.from({ length: 20 }, (_, i) => `src/d${i}/f.js`));
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke, fileCap: 5 });
        expect(r.files).toBe(5);
        expect(r.total).toBe(20);
        expect(r.omitted).toBe(15);
    });

    it('reports progress so a long pass is not a frozen dialog', async () => {
        const { invoke } = backend(Array.from({ length: 25 }, (_, i) => `src/f${i}.js`));
        const onProgress = vi.fn();
        await runStudyPass({ workspacePath: 'C:/ws', invoke, onProgress });
        expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ read: 25, total: 25 });
    });

    it('stops at the cap rather than walking a monorepo forever', async () => {
        const { invoke } = backend(Array.from({ length: 50 }, (_, i) => `src/f${i}.js`));
        expect((await runStudyPass({ workspacePath: 'C:/ws', invoke, fileCap: 10 })).files).toBe(10);
    });

    it('carries on past a file it cannot read', async () => {
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') {
                return { files: String(args.pattern).includes('xlsx') ? [] : ['src/ok.js', 'src/bad.js'] };
            }
            if (cmd === 'read_file' && args.path === 'src/bad.js') throw new Error('EACCES');
            if (cmd === 'read_file') return SRC;
            if (cmd === 'index_hashes') return [];
            return 0;
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.files).toBe(2);
        expect(r.symbols).toBeGreaterThan(0);
    });

    it('returns empty rather than throwing when the glob fails', async () => {
        const invoke = vi.fn(async () => { throw new Error('no such command'); });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.symbols).toBe(0);
        expect(r.error).toContain('no such command');
    });

    it('does nothing without a workspace', async () => {
        expect((await runStudyPass({ invoke: vi.fn() })).files).toBe(0);
    });

    it('caps how much it takes from one FILE, but not how many files', () => {
        expect(SYMBOLS_PER_FILE).toBeLessThan(50);
        // 0 = index the whole tree. A cap bought its time by indexing part of
        // the project permanently: fairShare is deterministic, so re-running
        // Study re-indexed the same subset and never reached the rest.
        expect(STUDY_FILE_CAP).toBe(0);
        // The listing ceiling is a different limit (paths, not reads) and must
        // stay well above any real tree — `truncated` is what stops prune.
        expect(STUDY_GLOB_MAX).toBeGreaterThanOrEqual(100000);
    });

    it('indexes the WHOLE tree by default — no second press needed', async () => {
        const files = Array.from({ length: 120 }, (_, i) => `C:/ws/dir${i % 7}/f${i}.js`);
        const invoke = vi.fn(async (cmd, a) => {
            if (cmd === 'glob_files') {
                if (a?.pattern === STUDY_SHEET_GLOB) return { files: [] };
                return { files, truncated: false };
            }
            if (cmd === 'index_hashes') return [];
            if (cmd === 'read_file') return 'export function alphaBeta() {}';
            return null;
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.omitted).toBe(0);
        expect(r.parsed).toBe(files.length);
        expect(r.paths).toHaveLength(files.length);
    });

    it('reads files concurrently rather than one round-trip at a time', async () => {
        // The sequential read loop was the only reason the file cap had to be
        // small: every file cost an IPC round-trip of pure waiting.
        let inFlight = 0;
        let peak = 0;
        const files = Array.from({ length: 40 }, (_, i) => `C:/ws/f${i}.js`);
        const invoke = vi.fn(async (cmd) => {
            if (cmd === 'glob_files') return { files, truncated: false };
            if (cmd === 'read_file') {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise(r => setTimeout(r, 1));
                inFlight--;
                return 'export function alpha() {}';
            }
            if (cmd === 'index_hashes') return [];
            return null;
        });
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(peak).toBeGreaterThan(1);
    });

    it('parses the whole tree when the cap is lifted (fileCap: 0)', async () => {
        const files = Array.from({ length: 30 }, (_, i) => `C:/ws/f${i}.js`);
        const invoke = vi.fn(async (cmd) => {
            if (cmd === 'glob_files') return { files, truncated: false };
            if (cmd === 'read_file') return 'export function alphaBeta() {}';
            if (cmd === 'index_hashes') return [];
            return null;
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke, fileCap: 0 });
        expect(r.omitted).toBe(0);
        expect(r.parsed).toBe(30);
    });
});

describe('targetPath', () => {
    it('strips only the trailing line number', () => {
        expect(targetPath('src/a.js:412')).toBe('src/a.js');
        expect(targetPath('C:/ws/src/a.js:412')).toBe('C:/ws/src/a.js');
        expect(targetPath('C:\ws\src\a.js:412')).toBe('C:\ws\src\a.js');
    });

    it('leaves a path with no line number alone', () => {
        expect(targetPath('C:/ws/src/a.js')).toBe('C:/ws/src/a.js');
    });

    it('survives junk', () => {
        expect(targetPath(null)).toBe('');
        expect(targetPath('')).toBe('');
    });
});

describe('staleness with Windows paths', () => {
    it('does not retire a card whose absolute path still exists', () => {
        const cards = [{ origin: 'study', q: 'x', target: 'C:/ws/src/a.js:12' }];
        const { stale, fresh } = staleStudyCards(cards, ['C:/ws/src/a.js']);
        expect(stale).toEqual([]);
        expect(fresh).toHaveLength(1);
    });
});

// A cross-sheet formula is an explicit dependency, so it lands in the same edge
// table as an import and `code_deps` answers over both. In a lot of enterprise
// work the real system knowledge is in the workbook, not the code.
describe('indexSpreadsheets', () => {
    const stubIndex = () => {
        const put = [];
        return { put, putFiles: async (files) => { put.push(...files); return files.length; } };
    };

    it('records sheet-to-sheet references as edges', async () => {
        const index = stubIndex();
        const invoke = vi.fn(async (cmd) => {
            if (cmd === 'glob_files') return { files: ['book.xlsx'] };
            if (cmd === 'spreadsheet_refs') return [
                { from_sheet: 'Summary', to_sheet: 'Data', example: '=SUM(Data!B:B)' },
            ];
            return null;
        });
        const r = await indexSpreadsheets({ workspacePath: 'C:/ws', invoke, index });
        expect(r.edges).toBe(1);
        expect(index.put[0]).toMatchObject({
            path: 'book.xlsx#Summary', lang: 'excel',
            deps: [['book.xlsx#Data', 'references']],
        });
    });

    it('addresses a sheet the way a file is addressed', async () => {
        // `workbook#Sheet` means one node type serves both, so the dependency
        // question does not need a second tool for spreadsheets.
        const index = stubIndex();
        const invoke = vi.fn(async (cmd) => {
            if (cmd === 'glob_files') return { files: ['C:/ws/plan.xlsx'] };
            if (cmd === 'spreadsheet_refs') return [{ from_sheet: 'A', to_sheet: 'B', example: '=B!A1' }];
            return null;
        });
        await indexSpreadsheets({ workspacePath: 'C:/ws', invoke, index });
        expect(index.put[0].path).toBe('C:/ws/plan.xlsx#A');
    });

    it('groups every reference a sheet makes into one entry', async () => {
        const index = stubIndex();
        const invoke = vi.fn(async (cmd) => {
            if (cmd === 'glob_files') return { files: ['b.xlsx'] };
            if (cmd === 'spreadsheet_refs') return [
                { from_sheet: 'S', to_sheet: 'X', example: '' },
                { from_sheet: 'S', to_sheet: 'Y', example: '' },
            ];
            return null;
        });
        await indexSpreadsheets({ workspacePath: 'C:/ws', invoke, index });
        expect(index.put).toHaveLength(1);
        expect(index.put[0].deps).toHaveLength(2);
    });

    it('skips a workbook it cannot open, without losing the rest', async () => {
        const index = stubIndex();
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') return { files: ['bad.xlsx', 'good.xlsx'] };
            if (cmd === 'spreadsheet_refs' && args.path === 'bad.xlsx') throw new Error('corrupt');
            if (cmd === 'spreadsheet_refs') return [{ from_sheet: 'A', to_sheet: 'B', example: '' }];
            return null;
        });
        const r = await indexSpreadsheets({ workspacePath: 'C:/ws', invoke, index });
        expect(r.files).toBe(2);
        expect(index.put[0].path).toBe('good.xlsx#A');
    });

    it('does nothing, quietly, when the backend has no such command', async () => {
        const index = stubIndex();
        const invoke = vi.fn(async () => { throw new Error('no such command'); });
        expect(await indexSpreadsheets({ workspacePath: 'C:/ws', invoke, index }))
            .toEqual({ files: 0, edges: 0, paths: [] });
    });
});

// The first study pass wrote a card per symbol into cards.jsonl. Those moved to
// the index, so the rows are now residue in a panel whose purpose is review.
describe('dropStudyCards', () => {
    it('removes study-written cards', () => {
        const { kept, dropped } = dropStudyCards([
            { origin: 'study', q: 'setSel' },
            { origin: 'study', q: 'onKey' },
        ]);
        expect(kept).toEqual([]);
        expect(dropped).toBe(2);
    });

    it('KEEPS experience cards — nothing else holds what happened', () => {
        const lesson = { type: 'lesson', signature: 'write_file|edit_mismatch|.svelte' };
        const learned = { origin: 'experience', q: 'licenseState' };
        const { kept, dropped } = dropStudyCards([lesson, { origin: 'study', q: 'x' }, learned]);
        expect(kept).toEqual([lesson, learned]);
        expect(dropped).toBe(1);
    });

    it('survives junk', () => {
        expect(dropStudyCards(null)).toEqual({ kept: [], dropped: 0 });
    });
});

// A repeat pass used to cost exactly as much as the first: change detection
// hashed CONTENT, so deciding a file had not changed required reading it.
describe('runStudyPass — mtime/size change detection', () => {
    const stampFor = (path, mtime = 111, size = 22) => ({ path, mtime_ms: mtime, size });

    const harness = ({ known = [], files, stamps }) => {
        const reads = [];
        const invoke = vi.fn(async (cmd, a) => {
            if (cmd === 'glob_files') {
                if (a?.pattern === STUDY_SHEET_GLOB) return { files: [] };
                return { files, truncated: false, stamps };
            }
            if (cmd === 'index_hashes') return known;
            if (cmd === 'read_file') { reads.push(a.path); return 'export function alphaBeta() {}'; }
            return null;
        });
        return { invoke, reads };
    };

    it('does not read a file whose stamp still matches the index', async () => {
        const files = ['C:/ws/a.js', 'C:/ws/b.js'];
        const stamps = [stampFor('C:/ws/a.js'), stampFor('C:/ws/b.js', 999, 33)];
        // a.js is recorded with its CURRENT stamp; b.js is not.
        const { invoke, reads } = harness({
            files, stamps, known: [['C:/ws/a.js', fileStamp(stamps[0])]],
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(reads).toEqual(['C:/ws/b.js']);
        expect(r.skipped).toBe(1);
    });

    it('still counts a skipped file as live, so prune does not delete it', async () => {
        const files = ['C:/ws/a.js'];
        const stamps = [stampFor('C:/ws/a.js')];
        const { invoke } = harness({ files, stamps, known: [['C:/ws/a.js', fileStamp(stamps[0])]] });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.paths).toContain('C:/ws/a.js');
    });

    it('re-reads everything when force is set', async () => {
        const files = ['C:/ws/a.js'];
        const stamps = [stampFor('C:/ws/a.js')];
        const { invoke, reads } = harness({ files, stamps, known: [['C:/ws/a.js', fileStamp(stamps[0])]] });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke, force: true });
        expect(reads).toEqual(['C:/ws/a.js']);
        expect(r.skipped).toBe(0);
    });

    it('falls back to content hashing when the backend returns no stamps', async () => {
        // An older backend has no `stamps` field: every file must still be read.
        const files = ['C:/ws/a.js', 'C:/ws/b.js'];
        const { invoke, reads } = harness({ files, stamps: undefined, known: [] });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(reads).toHaveLength(2);
        expect(r.skipped).toBe(0);
    });

    it('stores the stamp so the NEXT pass can skip the file', async () => {
        const files = ['C:/ws/a.js'];
        const stamps = [stampFor('C:/ws/a.js')];
        const put = [];
        const invoke = vi.fn(async (cmd, a) => {
            if (cmd === 'glob_files') {
                if (a?.pattern === STUDY_SHEET_GLOB) return { files: [] };
                return { files, truncated: false, stamps };
            }
            if (cmd === 'index_hashes') return [];
            if (cmd === 'read_file') return 'export function alphaBeta() {}';
            if (cmd === 'index_put_files') { put.push(...a.files); return a.files.length; }
            return null;
        });
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(put[0].hash).toBe(fileStamp(stamps[0]));
        expect(put[0].hash.startsWith('m:')).toBe(true);
    });

    it('asks the backend for stamps', async () => {
        const { invoke } = harness({ files: [], stamps: [] });
        await runStudyPass({ workspacePath: 'C:/ws', invoke });
        const globCall = invoke.mock.calls.find(c => c[0] === 'glob_files');
        expect(globCall[1].withStamps).toBe(true);
    });
});

describe('fileStamp', () => {
    it('is stable for the same metadata and distinct from a content hash', () => {
        expect(fileStamp({ mtime_ms: 5, size: 9 })).toBe(fileStamp({ mtime_ms: 5, size: 9 }));
        expect(fileStamp({ mtime_ms: 5, size: 9 })).not.toBe(fileStamp({ mtime_ms: 6, size: 9 }));
        expect(fileStamp({ mtime_ms: 5, size: 9 })).not.toBe(fileStamp({ mtime_ms: 5, size: 10 }));
        expect(fileStamp({ mtime_ms: 5, size: 9 }).startsWith('m:')).toBe(true);
    });

    it('is empty when there is no usable metadata', () => {
        expect(fileStamp(null)).toBe('');
        expect(fileStamp({})).toBe('');
        expect(fileStamp({ mtime_ms: 0, size: 0 })).toBe('');
    });
});
