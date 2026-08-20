// chatLoop — one chat turn, without a DOM.
//
// The loop used to live inside a 410-line method that drew its own bubbles, and
// two of its bugs came straight from that: a global getElementById on a repeated
// id meant a tool loop's second pass wrote into the first pass's bubble, and the
// final answer was appended twice on the success path. Both are pinned here.

import { describe, it, expect, vi } from 'vitest';
import {
    runChatTurn, toApiMessages, buildSystemPrompt, looksLikeToolCall,
    isAbort, abortMessage, MAX_TOOL_LOOPS, MAX_HISTORY_MESSAGES,
} from '../chatLoop.js';

/** An llm stub that replies with the given strings, one per call. */
function llmOf(...replies) {
    let i = 0;
    return {
        calls: [],
        async chat(apiMessages, system, onChunk, signal, images) {
            this.calls.push({ apiMessages, system, images });
            const content = replies[Math.min(i++, replies.length - 1)];
            for (const ch of String(content).match(/.{1,8}/g) || []) onChunk(ch);
            return { content };
        },
    };
}

const toolsOf = (impl = async () => 'ok') => ({
    getToolsForNativeAPI: () => [
        { function: { name: 'web_search', description: 'search', parameters: { type: 'object' } } },
    ],
    executeTool: vi.fn(impl),
    endSession: vi.fn(),
});

/** The real extractor's contract, without importing the parser. */
const extract = (text) => {
    const m = String(text).match(/```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
};

function harness(overrides = {}) {
    const messages = [{ role: 'user', content: 'hello' }];
    const events = [];
    const deps = {
        messages,
        push: (m) => { messages.push(m); events.push({ push: m }); },
        llm: llmOf('Hi there.'),
        tools: toolsOf(),
        extractToolCall: extract,
        systemPrompt: 'You are helpful.',
        onThinking: (on) => events.push({ thinking: on }),
        onStatus: (s) => events.push({ status: s }),
        onStreamStart: () => events.push({ streamStart: true }),
        onStreamDelta: (full) => events.push({ delta: full }),
        onStreamEnd: (kept) => events.push({ streamEnd: kept }),
        ...overrides,
    };
    return { deps, messages, events, run: () => runChatTurn(deps) };
}

describe('a plain answer', () => {
    it('streams, then pushes exactly ONE assistant message', async () => {
        const h = harness();
        await h.run();
        const pushed = h.messages.filter(m => m.role === 'assistant');
        expect(pushed).toHaveLength(1);
        expect(pushed[0].content).toBe('Hi there.');
    });

    // The success path used to append the answer a second time, because the
    // error handler's "render what I just pushed" ran unconditionally.
    it('marks the answer as already-streamed so the view does not draw it twice', async () => {
        const h = harness();
        await h.run();
        expect(h.messages.at(-1).streamed).toBe(true);
        expect(h.events.filter(e => e.streamEnd !== undefined)).toEqual([{ streamEnd: true }]);
    });

    it('reports thinking on, then off once the first chunk lands', async () => {
        const h = harness();
        await h.run();
        const thinking = h.events.filter(e => 'thinking' in e).map(e => e.thinking);
        expect(thinking[0]).toBe(true);
        expect(thinking).toContain(false);
    });

    it('delivers the ACCUMULATED text on each delta, not the chunk', async () => {
        const h = harness();
        await h.run();
        const deltas = h.events.filter(e => e.delta !== undefined).map(e => e.delta);
        expect(deltas.at(-1)).toBe('Hi there.');
        for (let i = 1; i < deltas.length; i++) {
            expect(deltas[i].startsWith(deltas[i - 1])).toBe(true);
        }
    });

    it('always ends the tool session', async () => {
        const h = harness();
        await h.run();
        expect(h.deps.tools.endSession).toHaveBeenCalled();
    });
});

describe('tool calls', () => {
    const callJson = (name) => '```json\n' + JSON.stringify({ thought: 't', tool_calls: [{ name, args: {} }] }) + '\n```';

    it('runs the tool, records the result, then answers', async () => {
        const h = harness({ llm: llmOf(callJson('web_search'), 'Found it.') });
        await h.run();
        expect(h.deps.tools.executeTool).toHaveBeenCalledTimes(1);
        const kinds = h.messages.map(m => (m.isToolCall && 'call') || (m.isToolResult && 'result') || m.role);
        expect(kinds).toEqual(['user', 'call', 'result', 'assistant']);
        expect(h.messages.at(-1).content).toBe('Found it.');
    });

    // The streamed bubble held only the placeholder / raw JSON; keeping it would
    // leave the JSON in the transcript next to the tool entry that replaced it.
    it('DISCARDS the streamed bubble when the reply turned out to be a tool call', async () => {
        const h = harness({ llm: llmOf(callJson('web_search'), 'Done.') });
        await h.run();
        const ends = h.events.filter(e => e.streamEnd !== undefined).map(e => e.streamEnd);
        expect(ends[0]).toBe(false);   // the tool-call pass
        expect(ends.at(-1)).toBe(true); // the answer
    });

    it('sends images only on the FIRST pass', async () => {
        const h = harness({ llm: llmOf(callJson('web_search'), 'Done.'), images: ['data:image/png;base64,x'] });
        await h.run();
        expect(h.deps.llm.calls[0].images).toHaveLength(1);
        expect(h.deps.llm.calls[1].images).toEqual([]);
    });

    it('forwards tool progress as status', async () => {
        const h = harness({
            llm: llmOf(callJson('web_search'), 'Done.'),
            tools: toolsOf(async (_call, onStatus) => { onStatus('Searching…'); return 'ok'; }),
        });
        await h.run();
        expect(h.events.some(e => e.status === 'Searching…')).toBe(true);
    });

    it('stops when finish_task is called', async () => {
        const h = harness({ llm: llmOf(callJson('finish_task')) });
        await h.run();
        expect(h.deps.tools.executeTool).toHaveBeenCalledTimes(1);
    });

    it('gives up after MAX_TOOL_LOOPS rather than spinning', async () => {
        const h = harness({ llm: llmOf(callJson('web_search')) });
        await h.run();
        expect(h.deps.tools.executeTool).toHaveBeenCalledTimes(MAX_TOOL_LOOPS);
    });

    // A thought with no calls is planning, not an answer.
    it('asks for the answer when the model emits JSON with no calls', async () => {
        const empty = '```json\n' + JSON.stringify({ thought: 'planning', tool_calls: [] }) + '\n```';
        const h = harness({ llm: llmOf(empty, 'Here it is.') });
        await h.run();
        expect(h.messages.some(m => /provide your final response/.test(String(m.content)))).toBe(true);
        expect(h.messages.at(-1).content).toBe('Here it is.');
    });
});

describe('failure and abort', () => {
    it('reports a failure as a message rather than throwing', async () => {
        const h = harness({ llm: { chat: async () => { throw new Error('502 upstream'); } } });
        await expect(h.run()).resolves.toBeUndefined();
        expect(h.messages.at(-1).isError).toBe(true);
        expect(h.messages.at(-1).content).toContain('502 upstream');
    });

    it('says the generation was stopped, not that it failed', async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        const h = harness({ llm: { chat: async () => { throw err; } } });
        await h.run();
        expect(h.messages.at(-1).content).toBe('*(Generation stopped by user)*');
        expect(h.messages.at(-1).isError).toBeUndefined();
    });

    it('distinguishes a stop DURING a tool loop', async () => {
        const messages = [
            { role: 'user', content: 'x' },
            { role: 'user', content: 'Tool Execution Results:\n[]', isToolResult: true },
        ];
        expect(abortMessage(messages)).toBe('*(Tool execution loop stopped by user)*');
    });

    it('ends the tool session even when the model threw', async () => {
        const h = harness({ llm: { chat: async () => { throw new Error('x'); } } });
        await h.run();
        expect(h.deps.tools.endSession).toHaveBeenCalled();
    });

    it('does nothing when the signal is already aborted', async () => {
        const c = new AbortController();
        c.abort();
        const h = harness({ signal: c.signal });
        await h.run();
        expect(h.messages).toHaveLength(1);
    });
});

describe('toApiMessages', () => {
    it('re-roles tool entries so the API sees a plain exchange', () => {
        expect(toApiMessages([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'j', isToolCall: true },
            { role: 'user', content: 'r', isToolResult: true },
        ])).toEqual([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'j' },
            { role: 'user', content: 'r' },
        ]);
    });

    it('keeps only the most recent window', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: String(i) }));
        const out = toApiMessages(many);
        expect(out).toHaveLength(MAX_HISTORY_MESSAGES);
        expect(out.at(-1).content).toBe('29');
    });

    it('drops the view-only fields', () => {
        const [m] = toApiMessages([{ role: 'user', content: 'a', displayContent: 'b', images: ['x'] }]);
        expect(m).toEqual({ role: 'user', content: 'a' });
    });
});

describe('looksLikeToolCall', () => {
    it('recognises an envelope from its first characters', () => {
        expect(looksLikeToolCall('```json\n{')).toBe(true);
        expect(looksLikeToolCall('  {"thought"')).toBe(true);
        expect(looksLikeToolCall('{ "thought"')).toBe(true);
    });

    it('leaves ordinary prose alone', () => {
        expect(looksLikeToolCall('Sure, here is what I found.')).toBe(false);
        expect(looksLikeToolCall('')).toBe(false);
    });
});

describe('buildSystemPrompt', () => {
    it('keeps the user prompt and lists the tools', () => {
        const p = buildSystemPrompt('BASE', [
            { function: { name: 'web_search', description: 'd', parameters: {} } },
        ], 'English');
        expect(p).toContain('BASE');
        expect(p).toContain('<tool name="web_search">');
        expect(p).toContain('MUST be in English');
    });

    // Offering finish_task made the model spend its turn "finishing" and the user
    // got a tool trace instead of an answer.
    it('tells the model there is no finish_task in chat', () => {
        expect(buildSystemPrompt('B', [], 'Japanese')).toMatch(/no \`finish_task\` to call/);
    });
});

describe('isAbort', () => {
    it('recognises the shapes providers actually throw', () => {
        const named = new Error('x'); named.name = 'AbortError';
        expect(isAbort(named)).toBe(true);
        expect(isAbort(new Error('request aborted'))).toBe(true);
        expect(isAbort(new Error('cancelled by user'))).toBe(true);
        expect(isAbort(new Error('500 server error'))).toBe(false);
    });
});
