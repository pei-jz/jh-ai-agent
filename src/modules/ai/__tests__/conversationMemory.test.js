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
    beforeEach(() => {
        conversationMemory.loaded = true;
        conversationMemory.factsLoaded = true;
        conversationMemory.facts = [];
        conversationMemory._episodeInjectionStats = [];
        conversationMemory._episodePolicy = {
            enabled: true, minRelevance: 0.08, maxSessions: 3, tokenBudget: 1200,
        };
    });

    it('returns a string even with no memory loaded', () => {
        expect(typeof conversationMemory.getPromptContext('anything')).toBe('string');
    });

    it('injects only sessions that clear the relevance floor', () => {
        conversationMemory.entries = [
            { topic: 'websocket reconnect', summary: 'fixed it', timestamp: 1 },
            { topic: 'release notes', summary: 'wrote them', timestamp: 2 },
        ];
        const out = conversationMemory.getPromptContext('websocket reconnect');
        expect(out).toContain('websocket reconnect');
        expect(out).not.toContain('release notes');
    });

    it('records injection stats for A/B comparison', () => {
        conversationMemory.entries = [
            { topic: 'websocket reconnect', summary: 'fixed it', timestamp: 1 },
            { topic: 'release notes', summary: 'wrote them', timestamp: 2 },
        ];
        conversationMemory.getPromptContext('websocket reconnect');
        const s = conversationMemory.getEpisodeInjectionStats();
        expect(s.count).toBe(1);
        expect(s.filtered).toBe(1);   // one candidate dropped by relevance
        expect(s.avgSessions).toBe(1); // one session injected
        expect(s.avgTokens).toBeGreaterThan(0);
    });

    it('respects maxSessions knob (A/B variant B: more sessions)', () => {
        conversationMemory.setEpisodeInjectionConfig({ maxSessions: 5 });
        conversationMemory.entries = [
            { topic: 'websocket reconnect', summary: 'fixed it', timestamp: 1 },
            { topic: 'websocket', summary: 'more', timestamp: 2 },
            { topic: 'websocket2', summary: 'more2', timestamp: 3 },
            { topic: 'websocket3', summary: 'more3', timestamp: 4 },
            { topic: 'unrelated', summary: 'no', timestamp: 5 },
        ];
        const out = conversationMemory.getPromptContext('websocket reconnect');
        // 4 of 5 entries clear the floor; the knob allows 5 → all 4 injected.
        expect(out.match(/Outcome summary/g)).toHaveLength(4);
    });

    it('enabled:false drops the episodic section entirely (A/B baseline)', () => {
        conversationMemory.setEpisodeInjectionConfig({ enabled: false });
        conversationMemory.entries = [
            { topic: 'websocket reconnect', summary: 'fixed it', timestamp: 1 },
        ];
        const out = conversationMemory.getPromptContext('websocket reconnect');
        expect(out).not.toContain('Past Conversation Memory');
    });

    it('stats survive policy switches and cap at the buffer limit', () => {
        conversationMemory.entries = [{ topic: 'x', summary: 'y', timestamp: 1 }];
        for (let i = 0; i < 3; i++) conversationMemory.getPromptContext('x');
        conversationMemory.setEpisodeInjectionConfig({ maxSessions: 2 });
        for (let i = 0; i < 2; i++) conversationMemory.getPromptContext('x');
        const s = conversationMemory.getEpisodeInjectionStats();
        expect(s.count).toBe(5);
    });
});

// addEntry is called WITHOUT await now (it runs after the run's result has been
// delivered), so two tasks finishing close together can overlap. Its writes are
// read-modify-write, which makes that a data-loss bug rather than a race that
// merely reorders lines.
describe('addEntry write serialization', () => {
    beforeEach(() => {
        conversationMemory.loaded = true;
        conversationMemory.factsLoaded = true;
        conversationMemory.entries = [];
        conversationMemory.facts = [];
        conversationMemory._writeQueue = Promise.resolve();
        conversationMemory._consolidating = false;
    });

    it('runs overlapping calls one at a time', async () => {
        let active = 0;
        let overlapped = false;
        const spy = vi.spyOn(conversationMemory, '_generateStructuredSummary')
            .mockImplementation(async () => {
                active += 1;
                if (active > 1) overlapped = true;
                await new Promise(r => setTimeout(r, 10));
                active -= 1;
                return { timestamp: Date.now(), date: '2026-08-11', topic: 't', summary: 's', facts: [] };
            });

        await Promise.all([
            conversationMemory.addEntry('q1', 'a1', 's1', '/ws'),
            conversationMemory.addEntry('q2', 'a2', 's2', '/ws'),
            conversationMemory.addEntry('q3', 'a3', 's3', '/ws'),
        ]);

        expect(overlapped).toBe(false);
        expect(conversationMemory.entries).toHaveLength(3);
        spy.mockRestore();
    });

    it('a failed entry does not block the next one', async () => {
        const spy = vi.spyOn(conversationMemory, '_generateStructuredSummary')
            .mockRejectedValueOnce(new Error('provider down'))
            .mockResolvedValue({ timestamp: Date.now(), date: '2026-08-11', topic: 'ok', summary: 's', facts: [] });

        // The first falls back to a synthesized entry rather than throwing.
        await conversationMemory.addEntry('q1', 'a1', 's1', '/ws');
        await conversationMemory.addEntry('q2', 'a2', 's2', '/ws');

        expect(conversationMemory.entries).toHaveLength(2);
        expect(conversationMemory.entries[1].topic).toBe('ok');
        spy.mockRestore();
    });
});

// Consolidation rewrites the whole facts store with its own LLM call. Chaining
// it onto addEntry made every Nth completed task pay for a store-wide cleanup.
describe('maybeConsolidate', () => {
    beforeEach(() => {
        conversationMemory.facts = [];
        conversationMemory._writeQueue = Promise.resolve();
        conversationMemory._consolidating = false;
    });

    const fill = (n) => Array.from({ length: n }, (_, i) => ({ fact: `f${i}`, hits: 1 }));

    it('does nothing while the store is below the threshold', () => {
        conversationMemory.facts = fill(10);
        const spy = vi.spyOn(conversationMemory, 'consolidateFacts');
        conversationMemory.maybeConsolidate('/ws');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('returns before the pass runs — it must not block the caller', async () => {
        conversationMemory.facts = fill(conversationMemory.maxFacts);
        let ran = false;
        const spy = vi.spyOn(conversationMemory, 'consolidateFacts')
            .mockImplementation(async () => { ran = true; return false; });

        conversationMemory.maybeConsolidate('/ws');
        expect(ran).toBe(false);          // detached, not awaited

        await conversationMemory._writeQueue;
        expect(ran).toBe(true);
        spy.mockRestore();
    });

    it('never starts a second pass while one is in flight', async () => {
        conversationMemory.facts = fill(conversationMemory.maxFacts);
        const spy = vi.spyOn(conversationMemory, 'consolidateFacts')
            .mockImplementation(async () => { await new Promise(r => setTimeout(r, 10)); return false; });

        conversationMemory.maybeConsolidate('/ws');
        conversationMemory.maybeConsolidate('/ws');
        conversationMemory.maybeConsolidate('/ws');
        await conversationMemory._writeQueue;

        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
