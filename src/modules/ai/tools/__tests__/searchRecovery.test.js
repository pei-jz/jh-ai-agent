// The zero-result recovery path, through the real handlers.
//
// searchFallback.test.js covers the ladder's rungs in isolation; this covers
// what the MODEL actually receives, which is the thing that decides whether an
// investigation recovers or stalls. Two properties matter and are easy to break:
//   • a relaxed hit must be labelled as relaxed (a result the model mistakes for
//     its own query is worse than no result)
//   • a genuine miss must say what was already tried, so the next step is not a
//     re-run of the same search

import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

// The tree-sitter backend is not what is under test here, and in Node its wasm
// is not on disk — which reproduces the original hang exactly: emscripten calls
// abort(), the init promise it returns has no reject path, and the load only
// ends because TREE_SITTER_LOAD_TIMEOUT_MS fires 8 seconds later. Stub it out so
// these tests measure the fallback TEXT rather than that timeout.
vi.mock('../TreeSitterSymbols.js', () => ({
    configureTreeSitter: () => {},
    isUnavailable: () => true,
    parseSymbols: async () => null,   // ⇒ SymbolIndex uses its regex extractor
}));

const { handleGrepSearch, handleSymbolSearch } = await import('../handlers/readOnlyHandlers.js');

const ctx = {
    workspacePath: 'C:/ws',
    resolvePath: (p) => (p ? `C:/ws/${p}` : 'C:/ws'),
    onToolEvent: () => {},
};
const hit = (file, line, text) => ({ file, line, text });

beforeEach(() => { invoke.mockReset(); });

describe('grep_search — zero-result ladder', () => {
    it('retries case-insensitively and says the spelling differs', async () => {
        invoke.mockImplementation(async (cmd, a) => {
            if (cmd !== 'grep_search') return null;
            if (!a.caseInsensitive) return { matches: [], files_searched: 12 };
            return { matches: [hit('C:/ws/a.js', 7, 'supportsNativeTools()')], files_searched: 12 };
        });

        const out = await handleGrepSearch(ctx, { pattern: 'supportsnativetools' });
        expect(out).toContain('CASE-INSENSITIVELY');
        expect(out).toContain('C:/ws/a.js:7');
    });

    it('falls back to the distinctive word, labelled as NOT the original query', async () => {
        invoke.mockImplementation(async (cmd, a) => {
            if (cmd !== 'grep_search') return null;
            if (a.pattern === 'supports') {
                return { matches: [hit('C:/ws/b.js', 3, 'supportsVision()')], files_searched: 12 };
            }
            return { matches: [], files_searched: 12 };
        });

        const out = await handleGrepSearch(ctx, { pattern: 'supportsNativeTools' });
        expect(out).toContain('most distinctive word "supports"');
        expect(out).toContain('NOT matches for your original query');
        expect(out).toContain('C:/ws/b.js:3');
    });

    it('reports what it tried when everything misses', async () => {
        invoke.mockResolvedValue({ matches: [], files_searched: 12 });
        const out = await handleGrepSearch(ctx, { pattern: 'runStudyPass' });
        expect(out).toContain('Tried:');
        expect(out).toContain('case-insensitive');
        expect(out).toContain('do NOT repeat these same patterns');
    });

    it('does not re-run a case-insensitive search the caller already asked for', async () => {
        invoke.mockResolvedValue({ matches: [], files_searched: 3 });
        await handleGrepSearch(ctx, { pattern: 'alpha', case_insensitive: true });
        const patterns = invoke.mock.calls.filter(c => c[0] === 'grep_search').map(c => c[1].pattern);
        // 'alpha' is a single token, so there is no distinctive-word rung either.
        expect(patterns).toEqual(['alpha']);
    });

    it('leaves a real regex alone rather than taking it apart', async () => {
        invoke.mockResolvedValue({ matches: [], files_searched: 3 });
        await handleGrepSearch(ctx, { pattern: 'function\\s+runStudyPass' });
        const patterns = invoke.mock.calls.filter(c => c[0] === 'grep_search').map(c => c[1].pattern);
        // Case-insensitive retry is safe; splitting a pattern is not.
        expect(patterns).toEqual(['function\\s+runStudyPass', 'function\\s+runStudyPass']);
    });

    it('costs nothing extra when the first search succeeds', async () => {
        invoke.mockResolvedValue({ matches: [hit('C:/ws/a.js', 1, 'x')], files_searched: 1 });
        await handleGrepSearch(ctx, { pattern: 'alphaBetaGamma' });
        expect(invoke.mock.calls.filter(c => c[0] === 'grep_search')).toHaveLength(1);
    });
});

describe('symbol_search — did you mean', () => {
    it('already handles a truncated query without needing a suggestion', async () => {
        // matchSymbols is substring + case-insensitive, so "…Tool" finds
        // "…Tools" outright. The suggestion path is for queries that miss.
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'index_find_symbol') return [];
            if (cmd === 'glob_files') return { files: ['C:/ws/a.js'] };
            if (cmd === 'read_file') return 'export function supportsNativeTools() {}\n';
            return null;
        });
        const out = await handleSymbolSearch(ctx, { query: 'supportsNativeTool' });
        expect(out).toContain('C:/ws/a.js:1');
        expect(out).not.toContain('Closest names');
    });

    it('names the closest symbols that DO exist when the query is misspelled', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'index_find_symbol') return [];       // index knows nothing
            if (cmd === 'glob_files') return { files: ['C:/ws/a.js'] };
            if (cmd === 'read_file') return 'export function supportsNativeTools() {}\n';
            return null;
        });

        // A transposition: no substring of the real name, so nothing matches.
        const out = await handleSymbolSearch(ctx, { query: 'supportsNativeTolls' });
        expect(out).toContain('Closest names that DO exist');
        expect(out).toContain('supportsNativeTools');
        expect(out).toContain('C:/ws/a.js:1');
    });

    it('stays quiet when nothing is close', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'index_find_symbol') return [];
            if (cmd === 'glob_files') return { files: ['C:/ws/a.js'] };
            if (cmd === 'read_file') return 'export function alphaBeta() {}\n';
            return null;
        });

        const out = await handleSymbolSearch(ctx, { query: 'zzzQuuxFrobnicate' });
        expect(out).toContain('No symbol definitions matching');
        expect(out).not.toContain('Closest names');
    });
});
