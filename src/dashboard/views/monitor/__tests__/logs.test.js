// Tests for monitor/logs.js — the All-Logs step-grouping state machine
// extracted from MonitorView.js (P4 split).

import { describe, it, expect } from 'vitest';
import { buildLogSteps, chatButtonHtml, requestDividerHtml } from '../logs.js';

const fmt = {
    lineHtmlFor: (log) => {
        if (log.event === 'thought') return `[thought:${log.data.text}]`;
        if (log.event === 'tool_call') return `[tool:${log.data.name}]`;
        if (log.event === 'status') return `[status:${log.data.message}]`;
        return '';
    },
    isChatLog: (data) => data?.method === 'CHAT',
    extractThoughtSummary: (raw) => String(raw).slice(0, 20),
    formatTime: (iso) => `T:${iso}`,
};

const stepStatus = (n) => ({ event: 'status', data: { message: `Thinking... (step ${n})` }, timestamp: `t${n}` });

describe('buildLogSteps', () => {
    it('groups events into steps with summaries and lines', () => {
        const logs = [
            stepStatus(1),
            { event: 'thought', data: { text: 'first thought' } },
            { event: 'tool_call', data: { name: 'read_file' } },
            stepStatus(2),
            { event: 'tool_call', data: { name: 'write_file' } },
        ];
        const { init, steps, totalSteps } = buildLogSteps(logs, fmt);
        expect(totalSteps).toBe(2);
        expect(steps).toHaveLength(2);
        expect(steps[0].stepId).toBe(1);
        expect(steps[0].summary).toBe('first thought');
        expect(steps[0].lines).toContain('[thought:first thought]');
        expect(steps[0].lines).toContain('[tool:read_file]');
        expect(steps[1].summary).toBe('Used write_file');
        expect(steps[1].lines).toContain('[tool:write_file]');
        // last step is "latest"
        expect(steps[1].isLatest).toBe(true);
        expect(steps[0].isLatest).toBe(false);
        expect(init).toEqual([]);
    });

    it('collects pre-step events into init', () => {
        const logs = [
            { event: 'status', data: { message: 'Project scan…' } },
            stepStatus(1),
        ];
        const { init, steps } = buildLogSteps(logs, fmt);
        expect(init).toContain('[status:Project scan…]');
        expect(steps).toHaveLength(1);
    });

    it('tracks CHAT entries per step and skips noise events', () => {
        const logs = [
            stepStatus(1),
            { event: 'log', data: { method: 'CHAT', usage: { prompt_tokens: 5 } } },
            { event: 'token_usage', data: {} },
            { event: 'stream', data: {} },
            { event: 'tool_call', data: { name: 'x' } },
        ];
        const { steps } = buildLogSteps(logs, fmt);
        expect(steps[0].chatEntries).toHaveLength(1);
        expect(steps[0].lines).not.toContain('[status:undefined]');
    });

    it('records requestStepIndexes for new requests (step counter restart)', () => {
        // Run 1: steps 1..2, then run 2 restarts at step 1.
        const logs = [
            stepStatus(1),
            stepStatus(2),
            stepStatus(1),
            stepStatus(2),
        ];
        const { steps, requestStepIndexes } = buildLogSteps(logs, fmt);
        expect(steps).toHaveLength(4);
        expect(requestStepIndexes).toEqual([0, 2]);
    });

    it('falls back to a generic step id when the message has no closing paren', () => {
        // 'Thinking... (step 1' passes the startsWith boundary check but the
        // regex needs a closing ')' → falls back to stepCount + 1.
        const logs = [{ event: 'status', data: { message: 'Thinking... (step 1' } }];
        const { steps, totalSteps } = buildLogSteps(logs, fmt);
        expect(totalSteps).toBe(1);
        expect(steps[0].stepId).toBe(1);
    });

    it('handles empty logs', () => {
        const { init, steps, totalSteps, requestStepIndexes } = buildLogSteps([], fmt);
        expect(init).toEqual([]);
        expect(steps).toEqual([]);
        expect(totalSteps).toBe(0);
        expect(requestStepIndexes).toEqual([]);
    });
});

describe('chatButtonHtml', () => {
    it('aggregates usage and error status', () => {
        const html = chatButtonHtml('u1', [
            { usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 3 }, duration: 100, status: 200 },
        ]);
        expect(html).toContain('data-chat-uid="u1"');
        expect(html).toContain('CHAT 200');
        expect(html).toContain('↑10t');
        expect(html).toContain('⚡3t');
        expect(html).toContain('↓5t');
        expect(html).toContain('100ms');
    });

    it('flags error status', () => {
        const html = chatButtonHtml('u2', [{ status: 500, error: 'boom' }]);
        expect(html).toContain('err');
    });
});

describe('requestDividerHtml', () => {
    it('renders the divider with or without a preview', () => {
        expect(requestDividerHtml(1, '')).toContain('▼ Request 1');
        expect(requestDividerHtml(2, ' — fix it')).toContain('— fix it');
    });
});
