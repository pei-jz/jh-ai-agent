// ConversationMemory — history compaction and memory recall.
//
// compactHistory is the one place that decides what the model FORGETS. Two of
// its rules are load-bearing and easy to break silently: the original request
// must survive every compaction, and the kept window must never begin with an
// orphaned role:"tool" message (providers reject a tool result whose
// assistant(tool_calls) turn was summarized away).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn(async (cmd) => (cmd === 'get_ai_config' ? {} : null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
// Summarization must not call a provider in tests.
vi.mock('../LLMService.js', () => ({
    default: {
        generate: vi.fn(async () => 'SUMMARY'),
        getCurrentModel: () => 'openai:gpt-4o',
        getEffectiveModelLimit: () => 1000,
    },
}));

const { conversationMemory } = await import('../ConversationMemory.js');

/** Build a history long enough to force compaction under a small budget. */
function bigHistory(turns = 40, chars = 400) {
    const out = [{ role: 'user', content: 'ORIGINAL-REQUEST-MARKER' }];
    for (let i = 0; i < turns; i++) {
        out.push({ role: 'assistant', content: `assistant ${i} ` + 'x'.repeat(chars) });
        out.push({ role: 'user', content: `Tool Execution Results:\nresult ${i} ` + 'y'.repeat(chars) });
    }
    return out;
}

beforeEach(() => {
    invoke.mockClear();
    conversationMemory.setBudgetConfig({});
});

describe('compactHistory', () => {
    it('leaves a short history untouched', async () => {
        const h = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        const out = await conversationMemory.compactHistory(h, 'openai:gpt-4o');
        expect(out).toEqual(h);
    });

    it('shrinks an oversized history', async () => {
        const h = bigHistory();
        const out = await conversationMemory.compactHistory(h, 'openai:gpt-4o');
        expect(out.length).toBeLessThan(h.length);
    });

    it('always keeps the ORIGINAL request — it is the task definition', async () => {
        const out = await conversationMemory.compactHistory(bigHistory(), 'openai:gpt-4o');
        expect(JSON.stringify(out)).toContain('ORIGINAL-REQUEST-MARKER');
    });

    it('keeps the most RECENT turns (that is where self-correction happens)', async () => {
        const h = bigHistory();
        h[h.length - 1].content = 'NEWEST-TURN-MARKER';
        const out = await conversationMemory.compactHistory(h, 'openai:gpt-4o');
        expect(JSON.stringify(out)).toContain('NEWEST-TURN-MARKER');
    });

    it('never leaves an ORPHANED tool result at the start of the kept window', async () => {
        // Native-format history: role:"tool" messages must stay paired with the
        // assistant(tool_calls) turn that produced them.
        const h = [{ role: 'user', content: 'ORIGINAL-REQUEST-MARKER' }];
        for (let i = 0; i < 30; i++) {
            h.push({
                role: 'assistant',
                content: 'x'.repeat(400),
                tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
            });
            h.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: 'y'.repeat(400) });
        }
        const out = await conversationMemory.compactHistory(h, 'openai:gpt-4o');

        // Every kept tool message must be preceded (somewhere earlier) by an
        // assistant turn — i.e. the window can't OPEN on a tool result.
        const firstTool = out.findIndex(m => m.role === 'tool');
        if (firstTool !== -1) {
            const before = out.slice(0, firstTool);
            expect(before.some(m => m.role === 'assistant')).toBe(true);
        }
    });

    it('tolerates an empty / malformed history without throwing', async () => {
        await expect(conversationMemory.compactHistory([], 'openai:gpt-4o')).resolves.toBeDefined();
        await expect(conversationMemory.compactHistory(null, 'openai:gpt-4o')).resolves.toBeDefined();
    });
});

describe('setBudgetConfig', () => {
    it('accepts an override and survives junk values', () => {
        expect(() => conversationMemory.setBudgetConfig({ historyBudgetRatio: 0.3 })).not.toThrow();
        expect(() => conversationMemory.setBudgetConfig({ historyBudgetRatio: 'nonsense' })).not.toThrow();
        expect(() => conversationMemory.setBudgetConfig(null)).not.toThrow();
    });
});

describe('memory recall relevance', () => {
    // A stored memory is a STRUCTURED summary: scoring reads topic / summary /
    // actions / keyFiles — not the raw turn text.
    const entry = (over = {}) => ({ topic: '', summary: '', actions: [], keyFiles: [], ...over });

    it('scores an entry that shares terms with the query above one that does not', () => {
        const hit = conversationMemory._relevanceScore(
            entry({ topic: 'websocket reconnect', summary: 'fixed the reconnect bug' }), 'websocket reconnect');
        const miss = conversationMemory._relevanceScore(
            entry({ topic: 'release notes', summary: 'wrote the notes' }), 'websocket reconnect');
        expect(hit).toBeGreaterThan(miss);
        expect(miss).toBe(0);
    });

    it('matches on keyFiles too, so "which session touched X" recalls', () => {
        const s = conversationMemory._relevanceScore(
            entry({ keyFiles: ['src/modules/ai/AgentController.js'] }), 'agentcontroller');
        expect(s).toBeGreaterThan(0);
    });

    it('returns a bounded score', () => {
        const s = conversationMemory._relevanceScore(entry({ topic: 'a b c' }), 'a b c');
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
    });

    it('an empty query is neutral (0.5), not zero — nothing to rank against', () => {
        expect(conversationMemory._relevanceScore(entry({ topic: 'x' }), '')).toBe(0.5);
    });
});

describe('getPromptContext', () => {
    it('returns a string even with no memory loaded', () => {
        expect(typeof conversationMemory.getPromptContext('anything')).toBe('string');
    });
});
