// grep_search's answer has a ceiling. max_results bounds the number of matches,
// not their size — 200 matches inside a minified bundle were 3.6M characters.

import { describe, it, expect, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { handleGrepSearch, capGrepOutput, MAX_GREP_OUTPUT_CHARS } = await import('../readOnlyHandlers.js');

const ctx = { workspacePath: 'C:/proj', resolvePath: (p) => p, onToolEvent: () => {} };

describe('grep output cap', () => {
    it('caps what a search of a minified bundle returns, and says how to narrow it', async () => {
        const huge = 'var a="token";'.repeat(100_000);
        invoke.mockResolvedValueOnce({
            matches: Array.from({ length: 5 }, (_, i) => ({ file: 'C:/proj/public/lib/mermaid.min.js', line: i + 1, text: huge })),
            files_searched: 1, truncated: false,
        });
        const out = await handleGrepSearch(ctx, { pattern: 'token' }, () => {});
        expect(out.length).toBeLessThan(MAX_GREP_OUTPUT_CHARS + 500);
        expect(out).toMatch(/capped/);
        expect(out).toMatch(/include_glob/);
    });

    it('leaves an ordinary result untouched', async () => {
        invoke.mockResolvedValueOnce({
            matches: [{ file: 'C:/proj/a.js', line: 3, text: 'const token = 1;' }],
            files_searched: 4, truncated: false,
        });
        const out = await handleGrepSearch(ctx, { pattern: 'token' }, () => {});
        expect(out).toBe('Found 1 match(es) across 4 files for /token/:\nC:/proj/a.js:3: const token = 1;');
    });

    it('capGrepOutput is a no-op under the ceiling', () => {
        expect(capGrepOutput('abc')).toBe('abc');
    });
});
