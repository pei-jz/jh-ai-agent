// askView — the §4 contract, as assertions.
//
// docs/design/information-architecture.md §4 is prose, and prose does not stay
// true. These are the four properties it names:
//
//   1. an ask run draws NO step rows
//   2. progress is ONE line — three tool calls do not make three lines
//   3. the seconds live inside "Thinking…" and nowhere else
//   4. nothing is thrown away: "Raw Log" gives the full list back
//
// (3) and (4) are checked here; the DOM half of (1) and (2) is in
// svelte/monitor/__tests__/askFlow.test.js.

import { describe, it, expect } from 'vitest';
import { askStream, thinkLabel, CONVERSATION_KINDS } from '../askView.js';

const item = (kind, over = {}) => ({ kind, id: `${kind}-${Math.random()}`, ...over });

describe('askStream — what reaches the screen', () => {
    it('keeps the conversation and withholds the machinery', () => {
        const { items, tools } = askStream([
            item('turn'),
            item('activity', { tool: 'read_file', target: 'auth.rs' }),
            item('activity', { tool: 'grep_search', target: 'middleware' }),
            item('deliverable'),
        ]);
        expect(items.map(i => i.kind)).toEqual(['turn', 'deliverable']);
        expect(tools.count).toBe(2);
        expect(tools.lines).toEqual(['read_file auth.rs', 'grep_search middleware']);
    });

    it('draws no step rows at all when every item is machinery', () => {
        // `run` is NOT machinery: it carries the answer when a turn ended
        // without present_result — see askConversation.js.
        const { items } = askStream([item('activity'), item('task_progress'), item('narration')]);
        expect(items).toEqual([]);
    });

    // A hidden approval request is a run that never continues. An ask run is
    // read-only so it should never produce one — "should never" is exactly the
    // case worth pinning.
    it('never hides an approval request', () => {
        const { items } = askStream([item('confirm'), item('activity')]);
        expect(items.map(i => i.kind)).toEqual(['confirm']);
    });

    it('never hides the agent asking back', () => {
        const { items } = askStream([item('ask'), item('activity')]);
        expect(items.map(i => i.kind)).toEqual(['ask']);
    });

    it('never hides an error — a failure is an answer too', () => {
        const { items } = askStream([item('error')]);
        expect(items.map(i => i.kind)).toEqual(['error']);
    });

    it('hides the folded row entirely when nothing was withheld', () => {
        // "0 tools" is noise on a question answered from what the agent knew.
        expect(askStream([item('turn'), item('deliverable')]).tools).toBeNull();
    });

    it('drops the build view scaffolding rather than counting it as a tool', () => {
        const { items, tools } = askStream([item('turn'), item('fold'), item('group')]);
        expect(items.map(i => i.kind)).toEqual(['turn']);
        expect(tools).toBeNull();
    });

    it('survives junk without throwing', () => {
        expect(askStream(null).items).toEqual([]);
        expect(askStream(undefined).tools).toBeNull();
        expect(askStream([null, undefined, {}]).items).toEqual([]);
    });

    // Property (4): the reduction is lossless. "Raw Log" works by not applying
    // this, so every withheld item has to still be an item.
    it('accounts for every input item — nothing is invented or lost', () => {
        const input = [item('turn'), item('activity'), item('deliverable'), item('narration')];
        const { items, tools } = askStream(input);
        expect(items.length + tools.count).toBe(input.length);
    });

    it('CONVERSATION_KINDS is the documented set', () => {
        expect([...CONVERSATION_KINDS].sort()).toEqual(
            ['ask', 'confirm', 'deliverable', 'document', 'error', 'run', 'turn']);
    });
});

describe('thinkLabel — the one line', () => {
    it('counts in tenths while waiting on the model', () => {
        expect(thinkLabel(0)).toBe('Thinking... (0.0s)');
        expect(thinkLabel(1400)).toBe('Thinking... (1.4s)');
        expect(thinkLabel(12_345)).toBe('Thinking... (12.3s)');
    });

    // Property (3): the SAME line becomes the tool status. It does not gain a
    // second line, and it does not keep the seconds running beside the status.
    it('is overwritten by a tool status, not appended to', () => {
        const label = thinkLabel(4200, 'read_file を実行中…');
        expect(label).toBe('read_file を実行中…');
        expect(label).not.toContain('Thinking');
        expect(label).not.toContain('4.2');
    });

    it('never shows a negative or NaN clock', () => {
        expect(thinkLabel(-500)).toBe('Thinking... (0.0s)');
        expect(thinkLabel(NaN)).toBe('Thinking... (0.0s)');
        expect(thinkLabel(undefined)).toBe('Thinking... (0.0s)');
    });
});
