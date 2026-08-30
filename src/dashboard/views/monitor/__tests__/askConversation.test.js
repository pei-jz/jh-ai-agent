// askConversation — a run's timeline, read as a conversation.
//
// The first implementation of §4 filtered the timeline but still handed the
// survivors to the TIMELINE renderer, so an `ask` answer arrived wearing step
// chrome. These pin the mapping that fixes it, and the property that made the
// old Chat readable: consecutive tool work collapses into ONE closed exchange,
// not one line per call.

import { describe, it, expect } from 'vitest';
import { askMessages, hasConversation } from '../askConversation.js';

const tool = (name, path = '') => ({ kind: 'activity', tool: name, path, text: `${name} ${path}` });
const say = (kind, text) => ({ kind, text });

describe('askMessages — the shape a conversation takes', () => {
    it('reads a request as the user speaking and a deliverable as the reply', () => {
        const out = askMessages([say('request', 'what does it do?'), say('deliverable', 'it does X')]);
        expect(out).toEqual([
            { role: 'user', content: 'what does it do?' },
            { role: 'assistant', content: 'it does X' },
        ]);
    });

    // The property the old Chat had: three lookups are ONE line saying "3", not
    // three lines to scroll past on the way to the answer.
    it('collapses a run of tool calls into one call + one result', () => {
        const out = askMessages([
            say('request', 'q'),
            tool('read_file', 'auth.rs'),
            tool('grep_search', 'middleware'),
            tool('web_search'),
            say('deliverable', 'a'),
        ]);
        expect(out.map(m => m.role || (m.isToolCall ? 'call' : 'result')))
            .toEqual(['user', 'call', 'result', 'assistant']);
        expect(out[1].toolCalls).toHaveLength(3);
        expect(out[2].results).toHaveLength(3);
    });

    it('starts a NEW exchange when prose interrupts the tools', () => {
        const out = askMessages([
            tool('read_file'), say('narration', 'looking…'), tool('grep_search'), say('deliverable', 'done'),
        ]);
        const kinds = out.map(m => m.role || (m.isToolCall ? 'call' : 'result'));
        expect(kinds).toEqual(['call', 'result', 'assistant', 'call', 'result', 'assistant']);
    });

    it('flushes tools that never got an answer, so nothing is swallowed', () => {
        const out = askMessages([say('request', 'q'), tool('read_file')]);
        expect(out.some(m => m.isToolCall)).toBe(true);
        expect(out.some(m => m.isToolResult)).toBe(true);
    });

    it('unwraps a group and keeps only its tool lines', () => {
        const out = askMessages([
            { kind: 'group', lines: [{ type: 'thought', text: 'thinking' }, { tool: 'read_file', text: 'x' }] },
            say('deliverable', 'a'),
        ]);
        expect(out[0].toolCalls).toEqual([{ name: 'read_file', args: { target: 'x' } }]);
    });

    it('names each tool on its result, so a folded row still says what ran', () => {
        const out = askMessages([tool('web_search', 'LSP')]);
        expect(out[1].results[0].tool_call_name).toBe('web_search');
    });

    it('keeps an error visible as its own turn', () => {
        const out = askMessages([say('error', 'ECONNREFUSED')]);
        expect(out).toEqual([{ role: 'assistant', isError: true, content: 'ECONNREFUSED' }]);
    });

    it('keeps the agent asking back', () => {
        const out = askMessages([{ kind: 'ask', text: 'which file?' }]);
        expect(out).toEqual([{ role: 'assistant', content: 'which file?' }]);
    });

    // Steps, turn markers, folds and checklists are the task view's furniture.
    it('drops the machinery entirely', () => {
        const out = askMessages([
            { kind: 'turn', n: 1 }, { kind: 'fold' }, { kind: 'task_progress' },
            { kind: 'run' }, { kind: 'activity', text: 'reasoning with no tool' },
        ]);
        expect(out).toEqual([]);
    });

    it('skips empty text rather than emitting a blank bubble', () => {
        expect(askMessages([say('request', '   '), say('deliverable', '')])).toEqual([]);
    });

    it('survives junk', () => {
        expect(askMessages(null)).toEqual([]);
        expect(askMessages([null, undefined, {}])).toEqual([]);
    });
});

describe('hasConversation', () => {
    it('is false for nothing and true for something', () => {
        expect(hasConversation([])).toBe(false);
        expect(hasConversation(null)).toBe(false);
        expect(hasConversation([{ role: 'user', content: 'x' }])).toBe(true);
    });
});

// ── The bug this file did not catch the first time ───────────────────────────
// splitForPanes REPLACES the deliverable with a derived `document` item in
// place, so `deliverable` never reaches the view — the mapper only handled the
// name that does not arrive, and an ask run showed its tool line and then
// nothing. Every test above used the name the producer emits rather than the
// one the CONSUMER receives, which is how it passed while the screen was blank.
describe('the answer, under the name it actually arrives with', () => {
    it('reads a `document` as the reply — this is the shape splitForPanes emits', () => {
        const out = askMessages([
            { kind: 'request', text: 'what is the weather?' },
            { kind: 'activity', tool: 'web_search', text: 'weather' },
            { kind: 'document', text: 'It is raining.', envKind: 'markdown' },
        ]);
        expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'It is raining.' });
    });

    it('falls back to a `run` that carries its answer', () => {
        const out = askMessages([{ kind: 'run', answer: 'done, and here is why' }]);
        expect(out).toEqual([{ role: 'assistant', content: 'done, and here is why' }]);
    });

    it('does not emit a bubble for a run that has no answer yet', () => {
        expect(askMessages([{ kind: 'run' }])).toEqual([]);
    });
});
