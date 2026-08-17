// Tests for agent/PromptAssembler.js — the pure prompt/history assembly and
// compression helpers extracted from AgentController.js (P3 monolith split).
// These functions were previously embedded in the ~3,300-line controller; this
// suite pins their behaviour so the extraction can never silently regress.

import { describe, it, expect } from 'vitest';
import {
    applyDescriptions, envelopeHasContent, toolArgHint,
    historyChars, historyText, droppedContentHashes,
    resultGroupHasReadContent, pushAssistantToolTurn, pushToolResultsTurn,
    compressToolResultsInHistory,
} from '../PromptAssembler.js';

describe('applyDescriptions', () => {
    it('applies descriptions by matching path (separator-tolerant)', () => {
        const files = [{ path: 'src/a.js', action: 'modified', description: '' }];
        const ok = applyDescriptions(files, [{ path: 'src\\a.js', description: 'the A module' }]);
        expect(ok).toBe(true);
        expect(files[0].description).toBe('the A module');
    });

    it('returns false when items is not an array', () => {
        expect(applyDescriptions([], null)).toBe(false);
        expect(applyDescriptions([], 'nope')).toBe(false);
    });

    it('skips items without path or description', () => {
        const files = [{ path: 'a', description: '' }];
        const ok = applyDescriptions(files, [{ path: 'a' }, { description: 'x' }, null]);
        expect(ok).toBe(false);
    });

    it('clips descriptions to 200 chars', () => {
        const files = [{ path: 'a', description: '' }];
        applyDescriptions(files, [{ path: 'a', description: 'x'.repeat(500) }]);
        expect(files[0].description.length).toBe(200);
    });
});

describe('envelopeHasContent', () => {
    it('detects substantive markdown payloads', () => {
        expect(envelopeHasContent({ kind: 'markdown', payload: { md: 'hello' } })).toBe(true);
        expect(envelopeHasContent({ kind: 'markdown', payload: { markdown: 'x' } })).toBe(true);
        expect(envelopeHasContent({ kind: 'answer', payload: { answer: 'yes' } })).toBe(true);
        expect(envelopeHasContent({ kind: 'answer', payload: { text: '' } })).toBe(false);
    });

    it('detects structured payloads (code-edit / file-list)', () => {
        expect(envelopeHasContent({ kind: 'code-edit', payload: { edits: [{ path: 'a' }] } })).toBe(true);
        expect(envelopeHasContent({ kind: 'file-list', payload: { files: [] } })).toBe(false);
    });

    it('rejects garbage', () => {
        expect(envelopeHasContent(null)).toBe(false);
        expect(envelopeHasContent('text')).toBe(false);
        expect(envelopeHasContent({})).toBe(false);
    });
});

describe('toolArgHint', () => {
    it('returns the command for run_command', () => {
        expect(toolArgHint('run_command', { command: '  npm   test  ' })).toBe('npm test');
    });

    it('returns the file basename for file tools', () => {
        expect(toolArgHint('read_file', { path: 'C:/proj/src/a.js' })).toBe('a.js');
        expect(toolArgHint('write_file', { path: 'b.txt' })).toBe('b.txt');
        expect(toolArgHint('move_file', { to: 'x/y/z.md' })).toBe('z.md');
    });

    it('returns the query for searches', () => {
        expect(toolArgHint('grep_search', { query: 'pattern' })).toBe('pattern');
        expect(toolArgHint('web_search', { query: 'q' })).toBe('q');
    });

    it('returns role for run_subtask and empty otherwise', () => {
        expect(toolArgHint('run_subtask', { role: 'reviewer' })).toBe('reviewer');
        expect(toolArgHint('mystery_tool', {})).toBe('');
        expect(toolArgHint('read_file', null)).toBe('');
    });
});

describe('history helpers', () => {
    it('counts characters (string and object content)', () => {
        expect(historyChars([{ content: 'abc' }, { content: { a: 1 } }])).toBeGreaterThan(3);
        expect(historyChars(null)).toBe(0);
    });

    it('joins all text', () => {
        // The join is a plain map().join('\n') — object content maps to '' so
        // the trailing separator is part of the (historical) behaviour.
        expect(historyText([{ content: 'a' }, { content: 'b' }, { content: { x: 1 } }])).toBe('a\nb\n');
        expect(historyText([])).toBe('');
    });

    it('reports dropped content hashes', () => {
        const before = [{ content: 'keep me' }, { content: 'drop me' }];
        const after = [{ content: 'keep me' }];
        const dropped = droppedContentHashes(before, after);
        expect(dropped).toHaveLength(1);
        expect(droppedContentHashes([], [])).toEqual([]);
    });
});

describe('resultGroupHasReadContent', () => {
    const mkGroup = (results) => 'Tool Execution Results:\n' + JSON.stringify(results);

    it('true when a substantial read_file result is present', () => {
        const content = mkGroup([{ tool_call_name: 'read_file', result: 'x'.repeat(500) }]);
        expect(resultGroupHasReadContent(content, 1000)).toBe(true);
    });

    it('false for short/error/other results and garbage', () => {
        expect(resultGroupHasReadContent(mkGroup([{ tool_call_name: 'read_file', result: 'short' }]), 1000)).toBe(false);
        expect(resultGroupHasReadContent(mkGroup([{ tool_call_name: 'read_file', result: 'Error: boom' }]), 1000)).toBe(false);
        expect(resultGroupHasReadContent(mkGroup([{ tool_call_name: 'grep_search', result: 'x'.repeat(500) }]), 1000)).toBe(false);
        expect(resultGroupHasReadContent('not a group', 1000)).toBe(false);
        expect(resultGroupHasReadContent(null, 1000)).toBe(false);
    });
});

describe('history turn writers', () => {
    it('pushAssistantToolTurn writes the legacy text form without native ids', () => {
        const h = [];
        pushAssistantToolTurn(h, 'resp', { thought: 't', tool_calls: [{ name: 'a', args: {} }] }, {}, new Map());
        expect(h[0]).toEqual({ role: 'assistant', content: 'resp' });
    });

    it('pushAssistantToolTurn writes standards-aligned form with ids', () => {
        const h = [];
        const call = { name: 'read_file', args: { path: 'a' } };
        const callIdOf = new Map([[call, 'call_1']]);
        pushAssistantToolTurn(h, 'resp', { thought: 'think', tool_calls: [call] },
            { nativeTurn: { text: 'think' } }, callIdOf);
        expect(h[0].role).toBe('assistant');
        expect(h[0].tool_calls[0].id).toBe('call_1');
        expect(h[0].tool_calls[0].function.name).toBe('read_file');
    });

    it('pushToolResultsTurn writes native role:tool messages', () => {
        const h = [];
        pushToolResultsTurn(h, [{ id: 'c1', tool_call_name: 'read_file', result: 'ok' }], true, 'tail');
        expect(h[0]).toEqual({ role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'ok' });
        expect(h[1]).toEqual({ role: 'user', content: 'tail' });
    });

    it('pushToolResultsTurn writes the legacy JSON blob in JSON mode', () => {
        const h = [];
        pushToolResultsTurn(h, [{ tool_call_name: 'a', result: 'r' }], false, '');
        expect(h[0].role).toBe('user');
        expect(h[0].content).toContain('Tool Execution Results:');
        expect(h[0].content).toContain('"tool_call_name": "a"');
    });
});

describe('compressToolResultsInHistory', () => {
    const mkToolResult = (name, content, id) => ({ id, tool_call_name: name, result: content });

    it('keeps the 3 most-recent groups verbatim and compresses older ones', () => {
        const h = [];
        for (let i = 1; i <= 6; i++) {
            h.push({ role: 'assistant', content: `thought ${i}` });
            h.push({ role: 'user', content: 'Tool Execution Results:\n' + JSON.stringify([mkToolResult('read_file', 'x'.repeat(100), `c${i}`)]) });
        }
        const originalLast = h[h.length - 1].content;
        compressToolResultsInHistory(h);
        // The last group stays verbatim.
        expect(h[h.length - 1].content).toBe(originalLast);
        // Older groups got summarized (no longer contain the full result).
        expect(h[3].content).toContain('Past tool results');
        expect(h[3].content).not.toContain('xxxxx');
    });

    it('does nothing when fewer than 4 groups exist', () => {
        const h = [
            { role: 'user', content: 'Tool Execution Results:\n[]' },
            { role: 'user', content: 'Tool Execution Results:\n[]' },
            { role: 'user', content: 'Tool Execution Results:\n[]' },
        ];
        const before = h.map(x => x.content);
        compressToolResultsInHistory(h);
        expect(h.map(x => x.content)).toEqual(before);
    });

    it('handles native tool groups and preserves error detail', () => {
        const h = [
            { role: 'assistant', content: 'thought a', tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', name: 'a', content: 'Error: ' + 'x'.repeat(100) },
            { role: 'assistant', content: 'thought b', tool_calls: [{ id: 'c2', function: { name: 'b', arguments: '{"old":"v"}' } }] },
            { role: 'tool', tool_call_id: 'c2', name: 'b', content: 'ok' },
        ];
        compressToolResultsInHistory(h); // fewer than 4 groups → untouched
        expect(h[1].content).toBe('Error: ' + 'x'.repeat(100));
    });

    it('survives malformed group content without throwing', () => {
        const h = [
            { role: 'assistant', content: 'a' },
            { role: 'user', content: 'Tool Execution Results:\n{not json' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'Tool Execution Results:\n' + JSON.stringify([mkToolResult('a', 'ok', 'c1')]) },
            { role: 'assistant', content: 'c' },
            { role: 'user', content: 'Tool Execution Results:\n' + JSON.stringify([mkToolResult('a', 'ok', 'c2')]) },
        ];
        expect(() => compressToolResultsInHistory(h)).not.toThrow();
    });
});
