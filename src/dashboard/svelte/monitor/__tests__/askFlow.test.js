// @vitest-environment jsdom
//
// The §4 contract, in the DOM.
//
// docs/design/information-architecture.md §4-2 names three properties, and all
// three are about what is NOT on screen — which is exactly the kind of rule that
// rots without a test:
//
//   • the line does not multiply (three tool calls, one line)
//   • the seconds live only inside "Thinking…"
//   • when the turn ends the line is REMOVED, not frozen
//
// Plus §4-4: "Raw Log" gives the ordinary timeline back.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';

import MonitorRoot from '../MonitorRoot.svelte';

const base = {
    header: { title: 'auth_middleware は何を素通しにしてる？' },
    timeline: { items: [], collapsed: new Set(), renderMarkdown: (t) => t },
    taskCount: 1,
};

const mount = (props = {}) => render(MonitorRoot, { props: { ...base, ...props } });
const think = (c) => c.querySelectorAll('.mask-think');
const thinkText = (c) => c.querySelector('.mask-think-text')?.textContent || '';

beforeEach(() => vi.useRealTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the ask progress line', () => {
    it('is exactly one line while the turn is in flight', async () => {
        const { container } = mount({ ask: { think: { since: Date.now(), status: null }, tools: null } });
        await waitFor(() => expect(think(container)).toHaveLength(1));
    });

    it('stays exactly one line after several tool calls', async () => {
        const since = Date.now();
        const { container, rerender } = mount({ ask: { think: { since, status: null }, tools: null } });
        await waitFor(() => expect(think(container)).toHaveLength(1));

        for (const tool of ['read_file', 'grep_search', 'read_office']) {
            await rerender({ ...base, ask: { think: { since, status: `${tool} を実行中…` }, tools: null } });
            expect(think(container)).toHaveLength(1);
        }
        expect(thinkText(container)).toBe('read_office を実行中…');
    });

    it('shows the elapsed seconds, and only inside "Thinking…"', async () => {
        const { container } = mount({
            ask: { think: { since: Date.now() - 1400, status: null }, tools: null },
        });
        await waitFor(() => expect(thinkText(container)).toMatch(/^Thinking\.\.\. \(\d+\.\ds\)$/));
    });

    it('drops the seconds entirely while a tool is running', async () => {
        const { container } = mount({
            ask: { think: { since: Date.now() - 4200, status: 'read_file を実行中…' }, tools: null },
        });
        await waitFor(() => expect(thinkText(container)).toBe('read_file を実行中…'));
        expect(thinkText(container)).not.toMatch(/\d\.\ds/);
    });

    // "終わったら消える" — not greyed out, not frozen at its last value.
    it('is removed when the turn ends, leaving nothing behind', async () => {
        const { container, rerender } = mount({
            ask: { think: { since: Date.now(), status: null }, tools: null },
        });
        await waitFor(() => expect(think(container)).toHaveLength(1));
        await rerender({ ...base, ask: { think: null, tools: null } });
        expect(think(container)).toHaveLength(0);
        expect(container.querySelector('.mask-think-text')).toBeNull();
    });

    // It is a status, not a control. Making it expand a log is what turns the
    // conversation back into a task view.
    it('is not a toggle — no button, no tabindex, no chevron', async () => {
        const { container } = mount({ ask: { think: { since: Date.now(), status: null }, tools: null } });
        await waitFor(() => expect(think(container)).toHaveLength(1));
        const row = container.querySelector('.mask-think');
        expect(row.getAttribute('role')).toBeNull();
        expect(row.getAttribute('tabindex')).toBeNull();
        expect(row.querySelector('.mll-chev')).toBeNull();
    });

    it('does not draw the build view live label alongside it', async () => {
        const { container } = mount({
            working: { text: 'Working…', collapsed: false },
            ask: { think: { since: Date.now(), status: null }, tools: null },
        });
        await waitFor(() => expect(think(container)).toHaveLength(1));
        expect(container.querySelector('.mresult-live-label')).toBeNull();
    });
});

describe('the build run is untouched', () => {
    it('still shows the toggleable live label when there is no ask bag', async () => {
        const { container } = mount({ working: { text: 'Working…', collapsed: false } });
        await waitFor(() => expect(container.querySelector('.mresult-live-label')).toBeTruthy());
        expect(think(container)).toHaveLength(0);
    });

    it('does not narrow the reading column', () => {
        const { container } = mount({ working: null });
        expect(container.querySelector('.monitor-layout').classList.contains('is-ask')).toBe(false);
    });
});

describe('the conversation surface', () => {
    // The correction after the first pass: an `ask` run must render as the old
    // Chat did — bubbles, and tool work behind a CLOSED disclosure — not as the
    // step timeline wearing a filter. See views/monitor/askConversation.js.
    it('draws bubbles, not timeline steps', async () => {
        const { container } = mount({
            ask: { think: null, tools: null, messages: [
                { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
            ] },
        });
        await waitFor(() => expect(container.querySelectorAll('.message-bubble')).toHaveLength(2));
        expect(container.querySelector('.mtl-step')).toBeNull();
    });

    it('puts the user on one side and the agent on the other', async () => {
        const { container } = mount({
            ask: { think: null, tools: null, messages: [
                { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
            ] },
        });
        await waitFor(() => expect(container.querySelector('.msg-user')).toBeTruthy());
        expect(container.querySelector('.msg-ai')).toBeTruthy();
    });

    it('folds a tool run to one line, closed', async () => {
        const { container } = mount({
            ask: { think: null, tools: null, messages: [
                { isToolCall: true, toolCalls: [{ name: 'read_file', args: {} }, { name: 'grep_search', args: {} }] },
                { isToolResult: true, results: [
                    { tool_call_name: 'read_file', result: 'ok' },
                    { tool_call_name: 'grep_search', result: 'ok' },
                ] },
            ] },
        });
        const details = await waitFor(() => {
            const d = container.querySelectorAll('details');
            expect(d.length).toBeGreaterThan(0);
            return d;
        });
        for (const d of details) expect(d.open).toBe(false);
        expect(container.textContent).toContain('read_file');
    });

    // A failed lookup silently folded away is how a wrong answer gets trusted.
    it('marks a tool error rather than folding it away as a success', async () => {
        const { container } = mount({
            ask: { think: null, tools: null, messages: [
                { isToolResult: true, results: [{ tool_call_name: 'web_search', result: 'Error: 503' }] },
            ] },
        });
        await waitFor(() => expect(container.querySelector('.chat-tool-result.is-error')).toBeTruthy());
    });

    it('renders nothing timeline-shaped when there are no messages', () => {
        const { container } = mount({ ask: { think: null, tools: null, messages: [] } });
        expect(container.querySelector('.message-bubble')).toBeNull();
    });
});

// §4-4: the escape hatch works by the ask bag simply not being set — there is no
// second rendering path to keep in step.
describe('the Raw Log escape hatch', () => {
    it('renders the ordinary timeline when the ask bag is null', () => {
        const { container } = mount({ ask: null, working: { text: 'Working…', collapsed: false } });
        expect(container.querySelector('.mask-think')).toBeNull();
        expect(container.querySelector('details.mask-tools')).toBeNull();
        expect(container.querySelector('.mresult-live-label')).toBeTruthy();
    });
});
