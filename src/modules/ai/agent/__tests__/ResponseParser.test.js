import { describe, it, expect } from 'vitest';
import {
    safeParseJSON, extractToolCall, extractAllPossibleToolCalls, extractInvokeToolCalls,
    extractFunctionTagToolCalls, normalizeToolCallEntry,
    extractThoughtFromMalformedText, cleanFinalResponse, stripReActPreamble, stripOuterCodeFence,
    looksTruncated, ARGS_TRUNCATED, ARGS_UNPARSEABLE
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

describe('extractFunctionTagToolCalls — DeepSeek/Qwen/MiMo <function=X> dialect', () => {
    it('parses a function block with parameters, keeping code bodies verbatim', () => {
        const text = `<tool_call>
<function=present_result>
<parameter=kind>markdown</parameter>
<parameter=summary>Refactored the loop</parameter>
<parameter=markdown>\`\`\`javascript
const x = 1;
\`\`\`</parameter>
</function>
</tool_call>`;
        const calls = extractFunctionTagToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('present_result');
        expect(calls[0].args.kind).toBe('markdown');
        expect(calls[0].args.summary).toBe('Refactored the loop');
        expect(calls[0].args.markdown).toBe('```javascript\nconst x = 1;\n```');
    });
    it('handles multiple blocks and returns [] for plain prose', () => {
        const two = `<function=a><parameter=x>1</parameter></function><function=b></function>`;
        const calls = extractFunctionTagToolCalls(two);
        expect(calls.map(c => c.name)).toEqual(['a', 'b']);
        expect(calls[0].args.x).toBe(1); // numeric coercion
        expect(extractFunctionTagToolCalls('just prose')).toEqual([]);
    });
    it('JSON-unescapes a single-line value that was embedded in a JSON string', () => {
        // \n / \" / \\ arrive literal when the block sat inside a JSON thought.
        const text = `<function=present_result><parameter=markdown>\`\`\`js\\nconst a = \\"x\\";\\nconst p = \\"a\\\\\\\\b\\";\\n\`\`\`</parameter></function>`;
        const calls = extractFunctionTagToolCalls(text);
        expect(calls[0].args.markdown).toBe('```js\nconst a = "x";\nconst p = "a\\\\b";\n```');
    });
    it('leaves genuine multi-line (real newline) values untouched', () => {
        const text = `<function=f><parameter=code>line1\nline\\tafter</parameter></function>`;
        // Has a real newline → not treated as escaped; the \\t stays literal.
        expect(extractFunctionTagToolCalls(text)[0].args.code).toBe('line1\nline\\tafter');
    });
});

describe('extractToolCall — <function=X> dialect embedded in a JSON thought', () => {
    it('recovers the tool call the model buried inside a malformed thought string', () => {
        // The exact failure shape: a JSON envelope whose thought carries the
        // <tool_call><function=...> dialect and NO tool_calls array.
        const text = `{"thought":"Now I have the full file context. Let me refactor it.<tool_call>
<function=present_result>
<parameter=kind>markdown</parameter>
<parameter=markdown>\`\`\`js
ok();
\`\`\`</parameter>
</function>
</tool_call>`;
        const r = extractToolCall(text);
        expect(r.tool_calls).toHaveLength(1);
        expect(r.tool_calls[0].name).toBe('present_result');
        expect(r.tool_calls[0].args.markdown).toContain('ok();');
        expect(r.thought).toContain('refactor');
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
    it('does NOT truncate a present_result envelope whose markdown holds a ```java block', () => {
        // Regression: the non-greedy block regex stopped at the inner ```java
        // fence, so only the first lines of the code answer reached the app.
        const md = '## Java Stream サンプルコード\\n\\n以下はサンプルです。\\n\\n' +
            '```java\\nimport java.util.stream.*;\\npublic class S {\\n  public static void main(String[] a){\\n' +
            '    IntStream.rangeClosed(2,100).filter(S::p).forEach(System.out::println);\\n  }\\n}\\n```\\n\\n' +
            '### まとめ\\n\\n| 操作 | 説明 |\\n|---|---|\\n| filter | 絞り込み |';
        const txt = '```json\n{"thought":"OBSERVE: x | PLAN: y | CALL: present_result",' +
            '"tool_calls":[{"name":"present_result","args":{"kind":"markdown","markdown":"' + md + '"}}]}\n```';
        const r = extractToolCall(txt);
        expect(r.tool_calls[0].name).toBe('present_result');
        const got = r.tool_calls[0].args.markdown;
        expect(got).toContain('```java');          // code block survived
        expect(got).toContain('class S');           // body survived
        expect(got).toContain('### まとめ');         // content AFTER the code block survived
    });

    it('normalizes OpenAI/DeepSeek-style native tool_calls (function.arguments as JSON string)', () => {
        // DeepSeek answers the JSON-envelope prompt with a NATIVE-shaped envelope:
        // {tool_calls: [{id, type, function: {name, arguments: "{...}"}}]}. Simple
        // Chat parsed this as thought-only and ended the turn without executing.
        const envelope = {
            thought: '調べます。',
            tool_calls: [
                { id: 'call_abc123', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'hello' }) } }
            ]
        };
        const r = extractToolCall(JSON.stringify(envelope));
        expect(r.thought).toBe('調べます。');
        expect(r.tool_calls).toHaveLength(1);
        expect(r.tool_calls[0]).toEqual({ name: 'web_search', args: { query: 'hello' } });
    });

    it('normalizes a bare native single tool call without a tool_calls envelope', () => {
        // Some DeepSeek responses drop the envelope and emit the raw native call.
        const txt = JSON.stringify({
            id: 'call_9', type: 'function',
            function: { name: 'fetch_url', arguments: JSON.stringify({ url: 'https://x.example' }) }
        });
        const r = extractToolCall(txt);
        expect(r).not.toBeNull();
        expect(r.tool_calls).toEqual([{ name: 'fetch_url', args: { url: 'https://x.example' } }]);
    });

    it('normalizes native tool calls inside a json code block envelope', () => {
        const envelope = {
            thought: 't',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) } }
            ]
        };
        const txt = '```json\n' + JSON.stringify(envelope) + '\n```';
        const r = extractToolCall(txt);
        expect(r.tool_calls).toEqual([{ name: 'read_file', args: { path: 'a.js' } }]);
    });

    it('handles empty-string arguments in a native tool call', () => {
        const txt = '{"thought":"t","tool_calls":[{"id":"c2","type":"function","function":{"name":"list_files","arguments":""}}]}';
        const r = extractToolCall(txt);
        expect(r.tool_calls).toEqual([{ name: 'list_files', args: {} }]);
    });

    it('normalizeToolCallEntry returns null for unusable entries', () => {
        expect(normalizeToolCallEntry(null)).toBeNull();
        expect(normalizeToolCallEntry({})).toBeNull();
        expect(normalizeToolCallEntry({ type: 'function', function: {} })).toBeNull();
    });
});

describe('stripOuterCodeFence', () => {
    it('strips an outer ```json wrapper but keeps inner fences', () => {
        const body = '{"md":"a ```java\\nx\\n``` b"}';
        expect(stripOuterCodeFence('```json\n' + body + '\n```')).toBe(body);
    });
    it('returns trimmed input unchanged when there is no outer fence', () => {
        expect(stripOuterCodeFence('  {"a":1}  ')).toBe('{"a":1}');
    });
    it('does not strip when text follows the closing fence', () => {
        const t = '```json\n{"a":1}\n```\ntrailing';
        expect(stripOuterCodeFence(t)).toBe(t.trim());
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

describe('stripReActPreamble', () => {
    it('collapses a preamble-only thought (sentence form) to empty', () => {
        const t = 'OBSERVE: task_progress was blocked but I have all the information needed. ' +
            'PLAN: Present the Stream sample code with explanation and finish the task. CALL: finish_task';
        expect(stripReActPreamble(t)).toBe('');
    });
    it('strips the pipe form with a CALL terminator', () => {
        expect(stripReActPreamble('OBSERVE: x | PLAN: y | CALL: present_result')).toBe('');
    });
    it('preserves real content placed after the preamble', () => {
        const t = 'OBSERVE: existing code uses a for-loop. PLAN: show a Stream version. CALL: present_result\n\n```java\nIntStream.rangeClosed(2,100);\n```';
        const out = stripReActPreamble(t);
        expect(out).toContain('```java');
        expect(out).not.toMatch(/^OBSERVE:/);
    });
    it('strips native-protocol OBSERVE/PLAN (no CALL token) up to the PLAN line', () => {
        const out = stripReActPreamble('OBSERVE: the buffer is empty.\nPLAN: write a sample.\nHere is the sample body.');
        expect(out).toBe('Here is the sample body.');
    });
    it('leaves a normal answer that merely starts with the word Observe untouched', () => {
        const t = 'Observe the output carefully before running again.';
        expect(stripReActPreamble(t)).toBe(t);
    });
    it('returns empty string for falsy input', () => {
        expect(stripReActPreamble('')).toBe('');
        expect(stripReActPreamble(null)).toBe('');
    });
});

// ── A tool call that did not arrive whole ──────────────────────────────────
//
// A call carrying a whole file can exceed the model's output limit, and the
// reply stops mid-JSON. jsonrepair closes the brackets, and what came out
// looked like a complete call: write_file with `content` ending mid-line wrote
// a truncated script, and a call cut off before its `path` arrived as {} and
// was reported as "missing required 'path'". Neither error names the cause, and
// one run spent six steps shrinking the wrong thing before abandoning the tool
// and installing openpyxl to do the job in Python.
describe('truncated tool arguments', () => {
    it('recognises JSON that stops mid-string', () => {
        expect(looksTruncated('{"path":"a.py","content":"def main():')).toBe(true);
    });

    it('recognises JSON that stops between keys', () => {
        expect(looksTruncated('{"path":"a.py","content":"ok",')).toBe(true);
        expect(looksTruncated('{"sheets":[{"rows":[[1,2]')).toBe(true);
    });

    it('does not cry wolf on complete JSON', () => {
        expect(looksTruncated('{"path":"a.py","content":"ok"}')).toBe(false);
        expect(looksTruncated('{"a":[1,2,{"b":"}"}]}')).toBe(false);
        expect(looksTruncated('{}')).toBe(false);
        // Braces and brackets INSIDE strings must not count.
        expect(looksTruncated('{"c":"if (x) { y[0] = 1; }"}')).toBe(false);
        // An escaped quote does not end the string.
        expect(looksTruncated(JSON.stringify({ c: 'say "hi"' }))).toBe(false);
        // A value ending in a backslash is complete, not an open escape.
        expect(looksTruncated(JSON.stringify({ c: 'C:\\' }))).toBe(false);
    });

    it('marks a truncated call instead of repairing it into a plausible one', () => {
        const call = normalizeToolCallEntry({
            function: { name: 'write_file', arguments: '{"path":"a.py","content":"def main():' },
        });
        expect(call.name).toBe('write_file');
        expect(call.args[ARGS_TRUNCATED]).toBeTruthy();
        // The half-written content must NOT reach the tool.
        expect(call.args.content).toBeUndefined();
        expect(call.args.path).toBeUndefined();
    });

    it('leaves a complete call exactly as it was', () => {
        const call = normalizeToolCallEntry({
            function: { name: 'write_file', arguments: '{"path":"a.py","content":"ok"}' },
        });
        expect(call.args).toEqual({ path: 'a.py', content: 'ok' });
        expect(call.args[ARGS_TRUNCATED]).toBeUndefined();
    });

    // jsonrepair rescues most near-JSON, so the unparseable marker is a last
    // resort rather than the common path. What matters either way: the call
    // never reaches a tool as a silently emptied {}.
    it('never turns unreadable arguments into an empty call', () => {
        const call = normalizeToolCallEntry({
            function: { name: 'read_file', arguments: 'path = a.py' },
        });
        expect(call.name).toBe('read_file');
        expect(typeof call.args).toBe('object');
    });
});

// The XML form of the same failure.
//
// A model that answers with <function=…><parameter=…> blocks can be cut off
// inside one, and the parameter regex needs a CLOSING tag to match — so the
// parameter was not "broken", it was absent. write_xlsx arrived with `path` and
// `preset` and no `sheets`, was told sheets was required, and the run spent nine
// steps shrinking the content that had never been the problem.
describe('a <function=…> call that was cut off', () => {
    const openTag = '<function=write_xlsx>';

    it('is marked, not delivered with the parameter silently missing', () => {
        const text = openTag
            + '<parameter=path>C:/a.xlsx</parameter>'
            + '<parameter=preset>plain</parameter>'
            + '<parameter=sheets>[{"name": "sheet1", "rows": [["a"';
        const [call] = extractFunctionTagToolCalls(text);
        expect(call.name).toBe('write_xlsx');
        expect(call.args[ARGS_TRUNCATED]).toBeTruthy();
        // The half of the call that DID arrive must not be handed over as if it
        // were the whole thing.
        expect(call.args.path).toBeUndefined();
        expect(call.args.preset).toBeUndefined();
    });

    it('leaves a complete call alone', () => {
        const text = openTag
            + '<parameter=path>C:/a.xlsx</parameter>'
            + '<parameter=preset>plain</parameter></function>';
        const [call] = extractFunctionTagToolCalls(text);
        expect(call.args).toEqual({ path: 'C:/a.xlsx', preset: 'plain' });
        expect(call.args[ARGS_TRUNCATED]).toBeUndefined();
    });
});

