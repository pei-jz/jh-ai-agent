/** @vitest-environment jsdom */
// jsdom env: renderMessageHtml pulls in resultView.renderFileList, which may
// reference DOM APIs at import time. The functions themselves return strings.
import { describe, it, expect } from 'vitest';
import {
    extractToolCall, parseThought, renderAgentSteps, renderMessageHtml
} from '../chatRenderer.js';

describe('extractToolCall', () => {
    it('returns null for empty input', () => {
        expect(extractToolCall('')).toBeNull();
        expect(extractToolCall(null)).toBeNull();
    });

    it('parses a fenced ```json block', () => {
        const r = extractToolCall('text\n```json\n{"name":"read_file","args":{"path":"a"}}\n```\nmore');
        expect(r).toEqual({ name: 'read_file', args: { path: 'a' } });
    });

    it('parses a bare JSON object', () => {
        expect(extractToolCall('{"name":"x"}')).toEqual({ name: 'x' });
    });

    it('returns null for non-JSON text', () => {
        expect(extractToolCall('just some prose')).toBeNull();
    });

    it('returns null for malformed JSON in a fence', () => {
        expect(extractToolCall('```json\n{not valid}\n```')).toBeNull();
    });
});

describe('parseThought', () => {
    it('returns all-null for empty', () => {
        expect(parseThought('')).toEqual({ observe: null, plan: null, call: null, raw: null });
    });

    it('extracts OBSERVE/PLAN/CALL fields', () => {
        const r = parseThought('OBSERVE: saw X\nPLAN: do Y\nCALL: read_file');
        expect(r.observe).toBe('saw X');
        expect(r.plan).toBe('do Y');
        expect(r.call).toBe('read_file');
        expect(r.raw).toBeNull();
    });

    it('handles pipe-separated format', () => {
        const r = parseThought('OBSERVE: a | PLAN: b | CALL: c');
        expect(r.observe).toBe('a');
        expect(r.plan).toBe('b');
        expect(r.call).toBe('c');
    });

    it('strips a <thought> wrapper', () => {
        const r = parseThought('noise <thought>PLAN: inside</thought> trailing');
        expect(r.plan).toBe('inside');
    });

    it('treats unstructured text as raw', () => {
        const r = parseThought('just thinking out loud');
        expect(r.raw).toBe('just thinking out loud');
        expect(r.plan).toBeNull();
    });
});

describe('renderAgentSteps', () => {
    it('shows the starting placeholder when there are no steps', () => {
        expect(renderAgentSteps([], null, null)).toContain('Agent starting');
    });

    it('renders a completed step with OPC + tool badges', () => {
        const steps = [{
            thought: 'OBSERVE: x\nPLAN: y',
            toolCalls: [{ name: 'read_file', status: 'done' }],
        }];
        const html = renderAgentSteps(steps, null, null);
        expect(html).toContain('agent-steps-container');
        expect(html).toContain('Step 1');
        expect(html).toContain('Observe');
        expect(html).toContain('read_file');
        expect(html).toContain('✅');
    });

    it('marks running tool calls with the hourglass', () => {
        const steps = [{ thought: 'PLAN: z', toolCalls: [{ name: 't', status: 'running' }] }];
        expect(renderAgentSteps(steps, null, null)).toContain('⏳');
    });

    it('appends final streamed content', () => {
        const html = renderAgentSteps([], null, '**done**');
        expect(html).toContain('agent-final-content');
        expect(html).toContain('<strong>done</strong>');
    });

    it('escapes tool/step text (XSS safety)', () => {
        const steps = [{ thought: 'PLAN: <img src=x>', toolCalls: [] }];
        const html = renderAgentSteps(steps, null, null);
        expect(html).not.toContain('<img src=x>');
        expect(html).toContain('&lt;img');
    });
});

describe('renderMessageHtml', () => {
    it('renders a user bubble with escaped/markdown content', () => {
        const html = renderMessageHtml({ role: 'user', content: '**hi**' });
        expect(html).toContain('msg-user');
        expect(html).toContain('<strong>hi</strong>');
    });

    it('renders an assistant bubble', () => {
        const html = renderMessageHtml({ role: 'assistant', content: 'hello' });
        expect(html).toContain('msg-ai');
        expect(html).toContain('hello');
    });

    it('renders a tool-call bubble with tool names + args', () => {
        const html = renderMessageHtml({
            isToolCall: true,
            content: '{"thought":"because"}',
            toolCalls: [{ name: 'write_file', args: { path: 'x' } }],
        });
        expect(html).toContain('ツール呼び出し中');
        expect(html).toContain('write_file');
        expect(html).toContain('思考プロセス');
    });

    it('renders a tool-result bubble, flagging errors', () => {
        const html = renderMessageHtml({
            isToolResult: true,
            results: [{ tool_call_name: 'run_command', result: 'Error: boom' }],
        });
        expect(html).toContain('ツール実行結果');
        expect(html).toContain('run_command');
        expect(html).toContain('Error: boom');
    });

    it('renders attached image thumbnails', () => {
        const html = renderMessageHtml({ role: 'user', content: 'see', images: ['data:image/png;base64,QQ=='] });
        expect(html).toContain('chat-zoomable-img');
        expect(html).toContain('data:image/png;base64,QQ==');
    });

    it('renders skill chips', () => {
        const html = renderMessageHtml({ role: 'user', content: 'x', skills: [{ name: 'foo', title: 'Foo' }] });
        expect(html).toContain('skill-chip');
        expect(html).toContain('Foo');
    });
});
