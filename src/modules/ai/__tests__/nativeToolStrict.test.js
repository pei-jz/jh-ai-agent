// Native tool advertisement — the `_strict_ok` hint sent to the Rust layer.
//
// Regression guard for the Azure "requests arrive with no tools" bug: every
// built-in was advertised as `_strict_ok: true`, so the Rust layer set
// function.strict = true on schemas that are NOT expressible in OpenAI
// Structured Outputs (write_xlsx's open-ended `styles`/`col_widths` maps, an
// untyped `items: {}`, a `minimum` constraint). Azure rejects the WHOLE request
// for one such tool, and the agent loop's fallback then re-sent the turn with no
// tools at all — which is all the user could see.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('../McpManager.js', () => ({
    mcpManager: {
        getAllTools: () => [],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        clients: new Map(),
    },
}));

const { ToolExecutor } = await import('../ToolExecutor.js');
const { isStrictCompliant } = await import('../strictSchema.js');

let ex;
beforeEach(() => {
    ex = new ToolExecutor();
    ex.workspacePath = 'C:/work/proj';
    try { globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; } catch (_) {}
});

describe('_strict_ok on built-in tools', () => {
    it('never claims strict for a schema that is not strict-compliant', () => {
        const wrong = ex.getToolsForNativeAPI()
            .filter(t => t._strict_ok && !isStrictCompliant(t.function.parameters))
            .map(t => t.function.name);
        expect(wrong).toEqual([]);
    });

    it('still claims strict for the plainly-compliant tools', () => {
        const byName = new Map(ex.getToolsForNativeAPI().map(t => [t.function.name, t]));
        expect(byName.get('read_file')?._strict_ok).toBe(true);
        expect(byName.get('list_files')?._strict_ok).toBe(true);
    });

    it('drops strict for the open-ended xlsx schemas', () => {
        const byName = new Map(ex.getToolsForNativeAPI().map(t => [t.function.name, t]));
        // These two are only present when their tool group is advertised; skip
        // rather than fail if a future gate hides them.
        for (const name of ['write_xlsx', 'update_xlsx']) {
            const t = byName.get(name);
            if (t) expect(t._strict_ok).toBe(false);
        }
    });

    it('marks every advertised tool with an explicit boolean hint', () => {
        for (const t of ex.getToolsForNativeAPI()) {
            expect(typeof t._strict_ok).toBe('boolean');
        }
    });
});
