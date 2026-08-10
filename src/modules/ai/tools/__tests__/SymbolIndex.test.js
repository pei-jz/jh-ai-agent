import { describe, it, expect } from 'vitest';
import { languageOf, extractSymbols, matchSymbols, formatSymbols } from '../SymbolIndex.js';

describe('languageOf', () => {
    it('maps JS/TS family to js', () => {
        for (const p of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.ts', 'a.tsx']) {
            expect(languageOf(p)).toBe('js');
        }
    });
    it('maps rust and python', () => {
        expect(languageOf('lib.rs')).toBe('rust');
        expect(languageOf('main.py')).toBe('python');
    });
    it('returns empty for unsupported / missing', () => {
        expect(languageOf('README.md')).toBe('');
        expect(languageOf('')).toBe('');
        expect(languageOf(null)).toBe('');
    });
});

describe('extractSymbols — JavaScript', () => {
    const src = [
        'import x from "y";',
        'export function alpha(a, b) {',
        '    return a + b;',
        '}',
        'async function beta() {}',
        'export default class Gamma extends Base {',
        '    constructor() { super(); }',
        '    async fetchData(id) {',
        '        return id;',
        '    }',
        '    static helper() {}',
        '}',
        'export const delta = (x) => x * 2;',
        'const epsilon = async function () {};',
        'let zeta = y => y;',
    ].join('\n');

    const syms = extractSymbols('src/a.js', src);
    const byName = (n) => syms.find(s => s.name === n);

    it('finds function declarations with 1-based lines', () => {
        expect(byName('alpha')).toMatchObject({ kind: 'function', line: 2, exported: true });
        expect(byName('beta')).toMatchObject({ kind: 'function', exported: false });
    });
    it('finds classes and their methods', () => {
        expect(byName('Gamma').kind).toBe('class');
        expect(byName('fetchData').kind).toBe('method');
        expect(byName('helper').kind).toBe('method');
    });
    it('finds arrow / function-expression consts', () => {
        expect(byName('delta')).toMatchObject({ kind: 'function', exported: true });
        expect(byName('epsilon').kind).toBe('function');
        expect(byName('zeta').kind).toBe('function');
    });
    it('records the source line as the signature', () => {
        expect(byName('alpha').signature).toBe('export function alpha(a, b) {');
    });
    it('does NOT treat control keywords as methods', () => {
        const s = extractSymbols('a.js', '  if (x) {\n  for (;;) {\n  while (a) {\n  catch (e) {');
        expect(s).toHaveLength(0);
    });
    it('does NOT index call sites', () => {
        const s = extractSymbols('a.js', 'doSomething(1, 2);\nconst v = other(3);');
        expect(s.map(x => x.name)).not.toContain('doSomething');
    });
});

describe('extractSymbols — comments are skipped', () => {
    it('ignores line comments', () => {
        expect(extractSymbols('a.js', '// export function ghost() {}')).toHaveLength(0);
    });
    it('ignores block comments (multi-line)', () => {
        const src = '/*\nexport function ghost() {}\n*/\nexport function real() {}';
        const names = extractSymbols('a.js', src).map(s => s.name);
        expect(names).toEqual(['real']);
    });
    it('ignores single-line block comments', () => {
        expect(extractSymbols('a.js', '/* function ghost() {} */')).toHaveLength(0);
    });
    it('ignores python comments', () => {
        expect(extractSymbols('a.py', '# def ghost(): pass')).toHaveLength(0);
    });
});

describe('extractSymbols — Rust', () => {
    const src = [
        'pub struct Config { a: u8 }',
        'pub(crate) enum Mode { A, B }',
        'pub trait Runner { fn go(&self); }',
        'impl Runner for Config {',
        '    pub async fn execute(&self) -> Result<(), String> { Ok(()) }',
        '}',
        'fn helper(x: u32) -> u32 { x }',
        'pub type Alias = Vec<u8>;',
    ].join('\n');
    const syms = extractSymbols('src/lib.rs', src);
    const kind = (n) => syms.find(s => s.name === n)?.kind;

    it('finds structs / enums / traits / impls / types', () => {
        expect(kind('Config')).toBe('struct');
        expect(kind('Mode')).toBe('enum');
        expect(kind('Runner')).toBe('trait');
        expect(kind('Alias')).toBe('type');
        expect(syms.some(s => s.kind === 'impl')).toBe(true);
    });
    it('finds functions including pub/async', () => {
        expect(kind('execute')).toBe('function');
        expect(kind('helper')).toBe('function');
    });
    it('marks pub items as exported', () => {
        expect(syms.find(s => s.name === 'Config').exported).toBe(true);
        expect(syms.find(s => s.name === 'helper').exported).toBe(false);
    });
});

describe('extractSymbols — Python', () => {
    const src = 'class Widget:\n    def __init__(self):\n        pass\n    async def load(self, x):\n        return x\ndef free_fn():\n    pass';
    const syms = extractSymbols('a.py', src);
    it('finds classes and defs (incl. async)', () => {
        expect(syms.find(s => s.name === 'Widget').kind).toBe('class');
        expect(syms.map(s => s.name)).toContain('load');
        expect(syms.map(s => s.name)).toContain('free_fn');
    });
});

describe('extractSymbols — edge cases', () => {
    it('returns [] for unsupported languages and empty input', () => {
        expect(extractSymbols('a.md', '# Title')).toEqual([]);
        expect(extractSymbols('a.js', '')).toEqual([]);
        expect(extractSymbols('a.js', null)).toEqual([]);
    });
    it('records at most one symbol per line', () => {
        const s = extractSymbols('a.js', 'export function a() { function b() {} }');
        expect(s).toHaveLength(1);
    });
});

describe('matchSymbols', () => {
    const syms = [
        { name: 'run', kind: 'function', line: 1, path: 'a.js', signature: '', exported: false },
        { name: 'runTask', kind: 'function', line: 2, path: 'a.js', signature: '', exported: true },
        { name: 'preRunHook', kind: 'method', line: 3, path: 'b.js', signature: '', exported: false },
        { name: 'other', kind: 'class', line: 4, path: 'c.js', signature: '', exported: false },
    ];

    it('ranks exact > prefix > substring', () => {
        const names = matchSymbols(syms, 'run').map(s => s.name);
        expect(names).toEqual(['run', 'runTask', 'preRunHook']);
    });
    it('is case-insensitive', () => {
        expect(matchSymbols(syms, 'RUNTASK').map(s => s.name)).toEqual(['runTask']);
    });
    it('filters by kind', () => {
        expect(matchSymbols(syms, 'run', { kind: 'method' }).map(s => s.name)).toEqual(['preRunHook']);
    });
    it('respects the limit', () => {
        expect(matchSymbols(syms, 'run', { limit: 1 })).toHaveLength(1);
    });
    it('returns [] for an empty query or no match', () => {
        expect(matchSymbols(syms, '')).toEqual([]);
        expect(matchSymbols(syms, 'zzz')).toEqual([]);
        expect(matchSymbols(null, 'run')).toEqual([]);
    });
    it('an exported symbol outranks a private one of equal quality', () => {
        const pair = [
            { name: 'go', kind: 'function', line: 9, path: 'z.js', signature: '', exported: false },
            { name: 'go', kind: 'function', line: 1, path: 'a.js', signature: '', exported: true },
        ];
        expect(matchSymbols(pair, 'go')[0].path).toBe('a.js');
    });
});

describe('formatSymbols', () => {
    const m = [{ name: 'run', kind: 'function', line: 12, path: 'src/a.js', signature: 'export function run() {', exported: true }];
    it('renders path:line, kind, name and signature', () => {
        const out = formatSymbols(m, { query: 'run' });
        expect(out).toContain('src/a.js:12');
        expect(out).toContain('[function] run');
        expect(out).toContain('(exported)');
        expect(out).toContain('export function run() {');
    });
    it('notes truncation when more matched than shown', () => {
        expect(formatSymbols(m, { query: 'run', total: 9 })).toContain('1 of 9');
    });
    it('has a clear empty message', () => {
        expect(formatSymbols([], { query: 'nope' })).toMatch(/No symbol definitions matching "nope"/);
    });
});

describe('extractSymbols — TypeScript type-level declarations', () => {
    const src = [
        'export interface Config { a: string }',
        'export type Alias = { b: number };',
        'export enum Mode { A, B }',
        'declare interface Ambient { x: 1 }',
        'export const enum Flags { On }',
        'type Generic<T> = T[];',
    ].join('\n');
    const syms = extractSymbols('a.ts', src);
    const kind = (n) => syms.find(s => s.name === n)?.kind;

    it('finds interface / type / enum', () => {
        expect(kind('Config')).toBe('interface');
        expect(kind('Alias')).toBe('type');
        expect(kind('Mode')).toBe('enum');
    });
    it('handles declare / const enum / generic type params', () => {
        expect(kind('Ambient')).toBe('interface');
        expect(kind('Flags')).toBe('enum');
        expect(kind('Generic')).toBe('type');
    });
    it('does not mistake a variable named "type" for a type alias', () => {
        expect(extractSymbols('a.ts', 'const type = 1;')).toHaveLength(0);
    });
});

describe('extractSymbols — object-literal members', () => {
    const src = [
        'export const api = {',
        '  fetchUser(id) { return id; },',
        '  save: async (x) => x,',
        '  legacy: function () {},',
        '  plain: 42,',
        '};',
    ].join('\n');
    const names = extractSymbols('a.js', src).map(s => s.name);

    it('finds shorthand, arrow and function-expression members', () => {
        expect(names).toContain('fetchUser');
        expect(names).toContain('save');
        expect(names).toContain('legacy');
    });
    it('ignores non-callable properties', () => {
        expect(names).not.toContain('plain');
    });
});

describe('extractSymbols — template literals are DATA, not code', () => {
    it('does not index a definition written inside a multi-line template', () => {
        const src = 'const sql = `\n  function ghost() {}\n  class Phantom {}\n`;\nconst real = () => 1;';
        expect(extractSymbols('a.js', src).map(s => s.name)).toEqual(['real']);
    });
    it('resumes indexing after the template closes', () => {
        const src = 'const t = `\nfunction ghost() {}\n`;\nexport function after() {}';
        expect(extractSymbols('a.js', src).map(s => s.name)).toEqual(['after']);
    });
    it('a single-line template does not swallow the rest of the file', () => {
        const src = 'const t = `inline`;\nexport function after() {}';
        expect(extractSymbols('a.js', src).map(s => s.name)).toEqual(['after']);
    });
    it('an escaped backtick does not flip template state', () => {
        // Source under test is:  const s = "\`";   (backslash + backtick)
        const src = ['const s = "\\`";', 'export function after() {}'].join('\n');
        expect(extractSymbols('a.js', src).map(s => s.name)).toContain('after');
    });

    it('an UNescaped backtick does open a template (guards the case above)', () => {
        const src = ['const s = `open', 'function ghost() {}'].join('\n');
        expect(extractSymbols('a.js', src).map(s => s.name)).toEqual([]);
    });
});
