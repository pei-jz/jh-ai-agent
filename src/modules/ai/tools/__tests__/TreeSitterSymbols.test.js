// Exercises the REAL tree-sitter WASM backend (no mocking of the parser) plus
// the fallback contract that keeps symbol_search working when it can't load.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { configureTreeSitter, parseSymbols, isUnavailable } from '../TreeSitterSymbols.js';
import { extractSymbolsBest } from '../SymbolIndex.js';

const require = createRequire(import.meta.url);

/** Point the backend at the installed grammars, loading the runtime via CJS. */
function useRealParser() {
    const wasmBase = require
        .resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')
        .replace(/tree-sitter-javascript\.wasm$/, '');
    configureTreeSitter({
        wasmBase,
        loadRuntime: async () => require('web-tree-sitter'),
    });
}

const JS = [
    'class Alpha {',
    '  run() { return 1; }',
    '}',
    'class Beta {',
    '  run() { return 2; }',
    '}',
    'const sql = `',
    '  function ghost() {}',
    '`;',
    'export function multi(',
    '  a,',
    '  b',
    ') {}',
].join('\n');

describe('TreeSitterSymbols — real WASM parse', () => {
    beforeAll(() => useRealParser());

    it('parses JavaScript and reports the enclosing class (regex cannot)', async () => {
        const syms = await parseSymbols('a.js', JS, 'js');
        expect(Array.isArray(syms)).toBe(true);
        const runs = syms.filter(s => s.name === 'run');
        expect(runs).toHaveLength(2);
        expect(runs.map(r => r.parent).sort()).toEqual(['Alpha', 'Beta']);
    });

    it('captures a MULTI-LINE signature whole', async () => {
        const syms = await parseSymbols('a.js', JS, 'js');
        const multi = syms.find(s => s.name === 'multi');
        expect(multi.signature).toContain('a');
        expect(multi.signature).toContain('b');
        expect(multi.line).toBe(10);
    });

    it('never indexes code inside a template literal (it is DATA in the tree)', async () => {
        const syms = await parseSymbols('a.js', JS, 'js');
        expect(syms.map(s => s.name)).not.toContain('ghost');
    });

    it('marks exported declarations', async () => {
        const syms = await parseSymbols('a.js', JS, 'js');
        expect(syms.find(s => s.name === 'multi').exported).toBe(true);
        expect(syms.find(s => s.name === 'Alpha').exported).toBe(false);
    });

    it('parses Rust, attributing methods to their impl block', async () => {
        const rs = [
            'pub struct Config { a: u8 }',
            'impl Config {',
            '    pub fn build(&self) -> u8 { self.a }',
            '}',
            'fn helper() {}',
        ].join('\n');
        const syms = await parseSymbols('lib.rs', rs, 'rust');
        const build = syms.find(s => s.name === 'build');
        expect(build.parent).toBe('Config');
        expect(build.exported).toBe(true);
        expect(syms.find(s => s.name === 'helper').exported).toBe(false);
    });

    it('parses Python, attributing methods to their class', async () => {
        const py = 'class Widget:\n    def load(self):\n        pass\ndef free_fn():\n    pass';
        const syms = await parseSymbols('a.py', py, 'python');
        expect(syms.find(s => s.name === 'load').parent).toBe('Widget');
        expect(syms.find(s => s.name === 'free_fn').parent).toBe(null);
    });

    it('returns null for an unsupported language instead of throwing', async () => {
        expect(await parseSymbols('a.md', '# hi', '')).toBe(null);
    });

    it('returns null for empty content', async () => {
        expect(await parseSymbols('a.js', '', 'js')).toBe(null);
    });
});

describe('TreeSitterSymbols — unavailable backend must not break callers', () => {
    // The wasm runtime initialises once per PROCESS (web-tree-sitter's init() is
    // global), so a runtime-load failure can only be observed on a module
    // instance that has never initialised it — hence the isolated import.
    it('returns null and marks itself unavailable when the runtime fails to load', async () => {
        vi.resetModules();
        const fresh = await import('../TreeSitterSymbols.js');
        fresh.configureTreeSitter({
            wasmBase: '/nonexistent/',
            loadRuntime: async () => { throw new Error('no runtime'); },
        });
        expect(await fresh.parseSymbols('a.js', 'function x(){}', 'js')).toBe(null);
        expect(fresh.isUnavailable()).toBe(true);
    });

    it('still returns null when only the GRAMMAR is missing (runtime fine)', async () => {
        useRealParser();                       // runtime loads…
        configureTreeSitter({                  // …but point at a bogus wasm dir
            wasmBase: '/nonexistent/',
            loadRuntime: async () => require('web-tree-sitter'),
        });
        expect(await parseSymbols('a.js', 'function x(){}', 'js')).toBe(null);
    });

    it('returns null when the grammar file is missing (runtime OK)', async () => {
        configureTreeSitter({
            wasmBase: '/nonexistent/',
            loadRuntime: async () => require('web-tree-sitter'),
        });
        expect(await parseSymbols('a.js', 'function x(){}', 'js')).toBe(null);
    });

    it('is inert until configured', async () => {
        configureTreeSitter({ wasmBase: null, loadRuntime: null });
        expect(await parseSymbols('a.js', 'function x(){}', 'js')).toBe(null);
    });
});

describe('extractSymbolsBest — backend selection', () => {
    it('uses tree-sitter when it is available', async () => {
        useRealParser();
        const { symbols, backend } = await extractSymbolsBest('a.js', JS);
        expect(backend).toBe('tree-sitter');
        expect(symbols.find(s => s.name === 'run').parent).toBeTruthy();
    });

    it('falls back to the regex extractor when tree-sitter cannot load', async () => {
        configureTreeSitter({ wasmBase: null, loadRuntime: null });
        const { symbols, backend } = await extractSymbolsBest('a.js', JS);
        expect(backend).toBe('regex');
        // The regex path still finds the definitions (without `parent`).
        expect(symbols.map(s => s.name)).toContain('multi');
        expect(symbols.map(s => s.name)).not.toContain('ghost');
    });

    it('falls back for a language tree-sitter has no grammar for', async () => {
        useRealParser();
        const { backend } = await extractSymbolsBest('a.md', '# not code');
        expect(backend).toBe('regex');
    });
});
