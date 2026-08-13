// StudyPass — learning a workspace's structure without running a task.
//
// The property that matters most here is what this pass does NOT do: it records
// facts about the tree (a symbol is declared at file:line) and never an opinion
// about what code means. That is what lets its output sit beside experience
// instead of needing a confidence discount.

import { describe, it, expect, vi } from 'vitest';
import {
    isLandmark, symbolCards, staleStudyCards, applyStudy, coverageByDir,
    runStudyPass, STUDY_FILE_CAP, SYMBOLS_PER_FILE, targetPath,
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

describe('runStudyPass', () => {
    const FILE = 'export function licenseState() {}\nexport class ConfigView {}\n';
    const mkInvoke = (files) => vi.fn(async (cmd) => {
        if (cmd === 'glob_files') return { files, truncated: false };
        if (cmd === 'read_file') return FILE;
        return null;
    });

    it('reads the tree and reports what it found', async () => {
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') return { files: ['src/license.js', 'src/ConfigView.js'] };
            return args.path === 'src/license.js'
                ? 'export function licenseState() {}\n'
                : 'export class ConfigView {}\n';
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.files).toBe(2);
        expect(r.cards.map(c => c.q).sort()).toEqual(['ConfigView', 'licenseState']);
        expect(r.cards.map(c => c.target).sort())
            .toEqual(['src/ConfigView.js:1', 'src/license.js:1']);
    });

    it('records the same name in two files as two places', () => {
        // Not a duplicate: `handle` in two modules is two landmarks, and
        // collapsing them would point every future search at whichever won.
        const cards = symbolCards([
            sym('processQueue', { path: 'src/a.js' }),
            sym('processQueue', { path: 'src/b.js' }),
        ], { date: '2026-08-12' });
        expect(cards).toHaveLength(2);
    });

    it('reports progress so a long pass is not a frozen dialog', async () => {
        const invoke = mkInvoke(Array.from({ length: 25 }, (_, i) => `src/f${i}.js`));
        const onProgress = vi.fn();
        await runStudyPass({ workspacePath: 'C:/ws', invoke, onProgress });
        expect(onProgress).toHaveBeenCalled();
        expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ read: 25, total: 25 });
    });

    it('stops at the cap rather than walking a monorepo forever', async () => {
        const invoke = mkInvoke(Array.from({ length: 50 }, (_, i) => `src/f${i}.js`));
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke, fileCap: 10 });
        expect(r.files).toBe(10);
    });

    it('carries on past a file it cannot read', async () => {
        const invoke = vi.fn(async (cmd, args) => {
            if (cmd === 'glob_files') return { files: ['src/ok.js', 'src/bad.js'] };
            if (args?.path === 'src/bad.js') throw new Error('EACCES');
            return FILE;
        });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.files).toBe(2);
        expect(r.cards.length).toBeGreaterThan(0);
    });

    it('returns empty rather than throwing when the glob fails', async () => {
        const invoke = vi.fn(async () => { throw new Error('no such command'); });
        const r = await runStudyPass({ workspacePath: 'C:/ws', invoke });
        expect(r.cards).toEqual([]);
        expect(r.error).toContain('no such command');
    });

    it('does nothing without a workspace', async () => {
        expect((await runStudyPass({ invoke: vi.fn() })).cards).toEqual([]);
    });

    it('caps how much it takes from one file', () => {
        expect(SYMBOLS_PER_FILE).toBeLessThan(50);
        expect(STUDY_FILE_CAP).toBeLessThanOrEqual(1000);
    });
});

// Windows absolute paths start `C:\…`, so splitting a `path:line` target on the
// first colon returns the drive letter. Every path comparison downstream —
// staleness, coverage, the overview digest — then silently fails, and this app
// stores absolute paths.
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
