import { describe, it, expect } from 'vitest';
import {
    safeParseJSON, extractToolCall, extractAllPossibleToolCalls, extractInvokeToolCalls,
    extractThoughtFromMalformedText, cleanFinalResponse
} from '../ResponseParser.js';

describe('extractInvokeToolCalls', () => {
    it('parses Anthropic-style <function_calls><invoke> XML', () => {
        const text = `まず構造を把握します。
<function_calls>
<invoke name="list_files">
<parameter name="path" string="true">C:/cusor_workspace/MiMo-Code</parameter>
</invoke>
</function_calls>`;
        const calls = extractInvokeToolCalls(text);
        expect(calls).toEqual([{ name: 'list_files', args: { path: 'C:/cusor_workspace/MiMo-Code' } }]);
    });
    it('JSON-parses non-string params and keeps string="true" as text', () => {
        const text = `<invoke name="read_file"><parameter name="path" string="true">a/b.js</parameter><parameter name="max_lines">50</parameter></invoke>`;
        expect(extractInvokeToolCalls(text)).toEqual([
            { name: 'read_file', args: { path: 'a/b.js', max_lines: 50 } },
        ]);
    });
    it('handles multiple invokes and returns [] for plain text', () => {
        const two = `<invoke name="a"></invoke><invoke name="b"></invoke>`;
        expect(extractInvokeToolCalls(two).map(c => c.name)).toEqual(['a', 'b']);
        expect(extractInvokeToolCalls('just prose')).toEqual([]);
    });
});

describe('extractToolCall — invoke XML integration', () => {
    it('extracts invoke-style tool calls + leading prose as thought', () => {
        const text = `プロジェクトを調査します。
<function_calls><invoke name="list_files"><parameter name="path" string="true">.</parameter></invoke></function_calls>`;
        const r = extractToolCall(text);
        expect(r.tool_calls).toEqual([{ name: 'list_files', args: { path: '.' } }]);
        expect(r.thought).toContain('調査');
    });
});

describe('safeParseJSON', () => {
    it('parses plain JSON', () => {
        expect(safeParseJSON('{"a":1}')).toEqual({ a: 1 });
    });
    it('passes through non-strings', () => {
        const obj = { x: 1 };
        expect(safeParseJSON(obj)).toBe(obj);
        expect(safeParseJSON(42)).toBe(42);
    });
    it('strips markdown fences', () => {
        expect(safeParseJSON('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    });
    it('fixes unescaped Windows backslashes', () => {
        // Use path segments with no valid JSON-escape initials (\W, \p) so every
        // backslash is doubled by the win-escape fixer.
        const r = safeParseJSON('{"path":"C:\\Work\\proj"}');
        expect(r.path).toBe('C:\\Work\\proj');
    });
    it('repairs missing commas via jsonrepair', () => {
        expect(safeParseJSON('{"a":1 "b":2}')).toEqual({ a: 1, b: 2 });
    });
    it('repairs trailing commas', () => {
        expect(safeParseJSON('{"a":1,}')).toEqual({ a: 1 });
    });
    it('extracts outermost object from surrounding prose', () => {
        expect(safeParseJSON('blah {"a":1} trailing')).toEqual({ a: 1 });
    });
    it('extracts AND repairs an embedded malformed object (deep fallback)', () => {
        // Prose around an object that is itself malformed → outermost extraction
        // then jsonrepair fixes the missing comma.
        expect(safeParseJSON('result: {"a":1 "b":2} done')).toEqual({ a: 1, b: 2 });
    });
});

describe('extractToolCall', () => {
    it('returns null for empty', () => {
        expect(extractToolCall('')).toBeNull();
        expect(extractToolCall(null)).toBeNull();
    });
    it('parses XML <tool_call> tags', () => {
        const txt = '<thought>thinking</thought><tool_calls><tool_call name="read_file" args={"path":"a.js"} /></tool_calls>';
        const r = extractToolCall(txt);
        expect(r.thought).toBe('thinking');
        expect(r.tool_calls).toEqual([{ name: 'read_file', args: { path: 'a.js' } }]);
    });
    it('parses a json code block envelope', () => {
        const txt = '```json\n{"thought":"t","tool_calls":[{"name":"x","args":{}}]}\n```';
        const r = extractToolCall(txt);
        expect(r.thought).toBe('t');
        expect(r.tool_calls[0].name).toBe('x');
    });
    it('parses a raw whole-string JSON envelope', () => {
        const r = extractToolCall('{"thought":"hi","tool_calls":[{"name":"y","args":{"k":1}}]}');
        expect(r.tool_calls[0]).toEqual({ name: 'y', args: { k: 1 } });
    });
    it('accepts a single tool_calls object (not array)', () => {
        const r = extractToolCall('{"tool_calls":{"name":"z","args":{}}}');
        expect(r.tool_calls[0].name).toBe('z');
    });
    it('falls back to brace-matching for loose {name,args}', () => {
        const r = extractToolCall('prose {"name":"finish_task","args":{"summary":"done"}} more');
        expect(r.tool_calls[0].name).toBe('finish_task');
    });
    it('extracts thought-only text', () => {
        const r = extractToolCall('{"thought":"only thinking"}');
        expect(r.thought).toBe('only thinking');
        expect(r.tool_calls).toEqual([]);
    });
    it('merges object thoughts across code blocks and collects tool_calls', () => {
        const txt = '```json\n{"thought":{"a":1},"tool_calls":[{"name":"t1","args":{}}]}\n```' +
                    '\n```json\n{"thought":{"b":2}}\n```';
        const r = extractToolCall(txt);
        expect(r.tool_calls[0].name).toBe('t1');
        expect(r.thought).toMatchObject({ a: 1, b: 2 });
    });
    it('returns null when nothing parseable', () => {
        expect(extractToolCall('just some words')).toBeNull();
    });
});

describe('extractAllPossibleToolCalls', () => {
    it('finds multiple calls and dedupes', () => {
        const txt = '{"name":"a","args":{"x":1}} {"name":"a","args":{"x":1}} {"name":"b","args":{}}';
        const calls = extractAllPossibleToolCalls(txt);
        expect(calls.map(c => c.name)).toEqual(['a', 'b']);
    });
    it('ignores braces inside strings', () => {
        const calls = extractAllPossibleToolCalls('{"name":"a","args":{"s":"{not a call}"}}');
        expect(calls).toHaveLength(1);
        expect(calls[0].args.s).toBe('{not a call}');
    });
    it('returns [] when no name/args objects', () => {
        expect(extractAllPossibleToolCalls('{"foo":1}')).toEqual([]);
    });
});

describe('extractThoughtFromMalformedText', () => {
    it('extracts a string thought', () => {
        expect(extractThoughtFromMalformedText('garbage "thought": "hello" garbage')).toBe('hello');
    });
    it('extracts an object thought', () => {
        const r = extractThoughtFromMalformedText('"thought": { "current_task": "do x" } tail');
        expect(r).toEqual({ current_task: 'do x' });
    });
    it('returns null when absent', () => {
        expect(extractThoughtFromMalformedText('nothing here')).toBeNull();
    });
});

describe('cleanFinalResponse', () => {
    it('returns empty for falsy', () => {
        expect(cleanFinalResponse('')).toBe('');
    });
    it('returns plain prose as-is', () => {
        expect(cleanFinalResponse('Here is the answer in prose.')).toContain('answer in prose');
    });
    it('formats a thought block when only a thought is present', () => {
        const r = cleanFinalResponse('<thought>some meaningful reasoning here</thought>');
        expect(r).toContain('🧠 Reasoning Process');
    });
    it('falls back to the friendly message for empty/placeholder', () => {
        expect(cleanFinalResponse('<thought>reasoning</thought>')).toContain('正常に完了');
    });
    it('strips a json envelope and surfaces remaining prose', () => {
        const r = cleanFinalResponse('Real answer text that is long enough.\n```json\n{"thought":"t"}\n```');
        expect(r).toContain('Real answer text');
    });
    it('renders an object thought from a json code block as a reasoning block', () => {
        const r = cleanFinalResponse('```json\n{"thought":{"step":"analyze"}}\n```');
        expect(r).toContain('🧠 Reasoning Process');
        expect(r).toContain('**step**');
    });
    it('handles an outermost {…} envelope without code fences', () => {
        const r = cleanFinalResponse('{"thought":"meaningful reasoning content here"}');
        expect(r).toContain('🧠 Reasoning Process');
    });
    it('returns the raw text when JSON parsing inside throws but prose exists', () => {
        const r = cleanFinalResponse('plain answer with a stray { brace that is not json');
        expect(r).toContain('plain answer');
    });
});
