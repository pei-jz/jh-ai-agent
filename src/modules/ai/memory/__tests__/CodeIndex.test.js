// CodeIndex — what counts as an edge, what counts as changed, and how a query
// answer is rendered.
//
// The rendering tests matter as much as the extraction ones: the reason to have
// an index instead of reading files is that its answers are SMALL, and a verbose
// renderer gives that saving straight back.

import { describe, it, expect, vi } from 'vitest';
import {
    contentHash, langOf, importEdges, resolveRelative, changedFiles,
    renderSymbolHits, renderDeps, CodeIndexClient, coverage,
} from '../CodeIndex.js';

describe('contentHash', () => {
    it('is stable and distinguishes content', () => {
        expect(contentHash('abc')).toBe(contentHash('abc'));
        expect(contentHash('abc')).not.toBe(contentHash('abd'));
    });

    it('distinguishes texts of different length that would otherwise collide', () => {
        expect(contentHash('a')).not.toBe(contentHash('aa'));
    });

    it('survives junk', () => {
        expect(typeof contentHash(null)).toBe('string');
    });
});

describe('importEdges', () => {
    const at = (src) => importEdges('src/modules/ai/AgentController.js', src);

    it('records a relative import, resolved against the importing file', () => {
        expect(at("import { CardStore } from './memory/CardStore.js';"))
            .toEqual(['src/modules/ai/memory/CardStore.js']);
    });

    it('walks up a parent path', () => {
        expect(at("import { icon } from '../../dashboard/utils/icons.js';"))
            .toEqual(['src/dashboard/utils/icons.js']);
    });

    it('handles export-from, side-effect imports, require and dynamic import', () => {
        expect(at("export { x } from './a.js';")).toEqual(['src/modules/ai/a.js']);
        expect(at("import './b.js';")).toEqual(['src/modules/ai/b.js']);
        expect(at("const c = require('./c.js');")).toEqual(['src/modules/ai/c.js']);
        expect(at("const d = await import('./d.js');")).toEqual(['src/modules/ai/d.js']);
    });

    it('DROPS package imports — they describe the ecosystem, not this project', () => {
        // Keeping them would bury the edges that answer "what in OUR code breaks".
        expect(at("import { invoke } from '@tauri-apps/api/core';")).toEqual([]);
        expect(at("import fs from 'fs';")).toEqual([]);
    });

    it('records one edge however many times a file is imported', () => {
        expect(at("import a from './x.js';\nimport b from './x.js';"))
            .toEqual(['src/modules/ai/x.js']);
    });

    it('skips absurdly long lines — that is a bundle, not source', () => {
        expect(at(`import x from './y.js'; ${'z'.repeat(500)}`)).toEqual([]);
    });

    it('survives junk', () => {
        expect(importEdges(null, null)).toEqual([]);
        expect(importEdges('a.js', '')).toEqual([]);
    });
});

describe('resolveRelative', () => {
    it.each([
        ['src/a', './b.js', 'src/a/b.js'],
        ['src/a', '../b.js', 'src/b.js'],
        ['src/a/b', '../../c.js', 'src/c.js'],
        ['', './a.js', 'a.js'],
    ])('%s + %s → %s', (dir, spec, want) => {
        expect(resolveRelative(dir, spec)).toBe(want);
    });
});

describe('changedFiles', () => {
    it('returns only what the index has not seen at this hash', () => {
        const current = [{ path: 'a.js', hash: 'h1' }, { path: 'b.js', hash: 'h2' }];
        const known = [['a.js', 'h1'], ['b.js', 'OLD']];
        expect(changedFiles(current, known).map(f => f.path)).toEqual(['b.js']);
    });

    it('treats an unknown file as changed', () => {
        expect(changedFiles([{ path: 'new.js', hash: 'h' }], []).map(f => f.path)).toEqual(['new.js']);
    });

    it('survives junk', () => {
        expect(changedFiles(null, null)).toEqual([]);
    });
});

describe('rendering', () => {
    it('answers with path and line, and nothing else', () => {
        const out = renderSymbolHits(
            [{ name: 'licenseState', kind: 'function', path: 'src/license.js', line: 12, exported: true }],
            'licenseState');
        expect(out).toContain('src/license.js:12');
        expect(out).toContain('[exported]');
        // A tool result is charged to the context: no bodies, no previews.
        expect(out.length).toBeLessThan(200);
    });

    it('tells the agent what to do instead when it finds nothing', () => {
        const out = renderSymbolHits([], 'nope');
        expect(out).toContain('grep_search');
    });

    it('names the direction of a dependency answer', () => {
        expect(renderDeps([{ path: 'a.js', kind: 'imports' }], 'core.js', 'in'))
            .toContain('Files that depend on core.js');
        expect(renderDeps([{ path: 'b.js', kind: 'imports' }], 'core.js', 'out'))
            .toContain('Files core.js depends on');
    });

    it('says WHY an empty dependency answer may be empty', () => {
        // "none" would otherwise read as "nothing depends on this", which is a
        // very different claim from "nothing has been indexed yet".
        const out = renderDeps([], 'core.js', 'in');
        expect(out).toContain('Only relative imports');
        expect(out).toContain('study pass');
    });

    it('marks a non-import edge kind', () => {
        expect(renderDeps([{ path: 'book.xlsx#Sheet2', kind: 'references' }], 'book.xlsx#Sheet1', 'out'))
            .toContain('[references]');
    });
});

describe('CodeIndexClient', () => {
    it('is inert without a workspace, rather than throwing', async () => {
        const c = new CodeIndexClient({ invoke: vi.fn() });
        expect(c.enabled).toBe(false);
        expect(await c.findSymbol('x')).toEqual([]);
        expect(await c.deps('a.js')).toEqual([]);
        expect(await c.knownHashes()).toEqual([]);
        expect((await c.stats()).files).toBe(0);
    });

    it('passes the query through to the backend', async () => {
        const invoke = vi.fn(async () => [{ name: 'x', path: 'a.js', line: 1 }]);
        const c = new CodeIndexClient({ workspacePath: 'C:/ws', invoke });
        await c.findSymbol('x', { kind: 'function', limit: 5 });
        expect(invoke).toHaveBeenCalledWith('index_find_symbol', {
            workspace: 'C:/ws', query: 'x', kind: 'function', limit: 5,
        });
    });

    it('does not call the backend with an empty batch', async () => {
        const invoke = vi.fn(async () => 0);
        const c = new CodeIndexClient({ workspacePath: 'C:/ws', invoke });
        expect(await c.putFiles([])).toBe(0);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('degrades quietly when the backend is older than the feature', async () => {
        // A reader that throws would take the whole study pass down with it.
        const invoke = vi.fn(async () => { throw new Error('no such command'); });
        const c = new CodeIndexClient({ workspacePath: 'C:/ws', invoke });
        expect(await c.knownHashes()).toEqual([]);
        expect(await c.prune([])).toBe(0);
        expect((await c.stats()).files).toBe(0);
    });
});

describe('CodeIndexClient.knownHashes robustness', () => {
    it('ignores a non-array answer instead of feeding it to new Map()', async () => {
        // An older backend returns something else entirely; `new Map("text")`
        // iterates characters and throws, taking the study pass with it.
        const invoke = vi.fn(async () => 'unexpected string');
        const c = new CodeIndexClient({ workspacePath: 'C:/ws', invoke });
        expect(await c.knownHashes()).toEqual([]);
    });

    it('drops malformed rows and keeps the good ones', async () => {
        const invoke = vi.fn(async () => [['a.js', 'h1'], 'junk', ['b.js', 'h2'], []]);
        const c = new CodeIndexClient({ workspacePath: 'C:/ws', invoke });
        expect(await c.knownHashes()).toEqual([['a.js', 'h1'], ['b.js', 'h2']]);
    });
});

// The one question nobody's tooling answers: not what the agent knows, but what
// it does NOT. An area with no rows is one where every answer is a guess.
describe('coverage', () => {
    it('counts indexed files per area, busiest first', () => {
        const rows = coverage(['src/a/x.js', 'src/a/y.js', 'src/b/z.js']);
        expect(rows).toEqual([{ dir: 'src/a', files: 2 }, { dir: 'src/b', files: 1 }]);
    });

    it('never turns a FILENAME into an area', () => {
        // `lib/z.js` at depth 2 is the area `lib`, not the area `lib/z.js`.
        expect(coverage(['lib/z.js'])).toEqual([{ dir: 'lib', files: 1 }]);
    });

    it('makes paths relative to the workspace', () => {
        expect(coverage(['C:/ws/src/a/x.js'], { root: 'C:/ws' })).toEqual([{ dir: 'src/a', files: 1 }]);
    });

    it('files a workbook sheet under its workbook folder', () => {
        expect(coverage(['docs/plan.xlsx#Summary'])).toEqual([{ dir: 'docs', files: 1 }]);
    });

    it('names a top-level file rather than dropping it', () => {
        expect(coverage(['README.js'])).toEqual([{ dir: '(root)', files: 1 }]);
    });

    it('normalises Windows separators and caps the list', () => {
        expect(coverage(['src\\a\\x.js'])).toEqual([{ dir: 'src/a', files: 1 }]);
        expect(coverage(Array.from({ length: 30 }, (_, i) => `d${i}/f.js`), { limit: 5 })).toHaveLength(5);
    });

    it('survives junk', () => {
        expect(coverage(null)).toEqual([]);
        expect(coverage([''])).toEqual([]);
    });
});
