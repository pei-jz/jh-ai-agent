// @vitest-environment jsdom
//
// The raw log after migration. The grouping itself is monitor/logs.js and has
// its own tests; this covers what the component does with it — which step opens,
// which header wins while a step is in flight, and the controls.
//
// The divider test is ported from views/__tests__/monitorView.test.js, where it
// drove `renderAllLogs()` and matched the HTML string it returned.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import RawLog from '../RawLog.svelte';

afterEach(() => cleanup());

const step = (n, at = `2026-07-01T00:00:0${n}Z`) => ({
    event: 'status', timestamp: at,
    data: { status: 'running', message: `Thinking... (step ${n})` },
});
const thought = (text) => ({ event: 'thought', data: { text } });
const tool = (name) => ({ event: 'tool_call', data: { name } });
const chat = (over = {}) => ({
    event: 'log',
    data: { method: 'CHAT', status: 200, duration: 120, usage: { prompt_tokens: 10, completion_tokens: 2 }, ...over },
});

function mountLog(props = {}) {
    const onOpenChat = vi.fn();
    const utils = render(RawLog, {
        props: {
            logs: [], version: 1,
            formatLine: (log) => `<div class="mlog">${log.event}</div>`,
            formatTime: (t) => String(t).slice(11, 19),
            onOpenChat,
            ...props,
        },
    });
    return { ...utils, onOpenChat };
}

const steps = (c) => [...c.querySelectorAll('.mstep')].filter(el => el.id !== 'mstep-init');
const headerOf = (el) => el.querySelector('.mstep-header');
const summaryOf = (el) => el.querySelector('.mstep-summary').textContent.trim();

describe('an empty log', () => {
    it('says it is waiting rather than showing nothing', () => {
        const h = mountLog();
        expect(h.container.textContent).toMatch(/Waiting for execution logs/);
        expect(steps(h.container)).toHaveLength(0);
    });
});

describe('grouping', () => {
    it('makes one block per step and numbers it', () => {
        const h = mountLog({ logs: [step(1), thought('a'), step(2), thought('b')] });
        const list = steps(h.container);
        expect(list).toHaveLength(2);
        expect(list[0].textContent).toContain('Step 1');
        expect(list[1].textContent).toContain('Step 2');
    });

    it('routes events before the first step into Init', () => {
        const h = mountLog({ logs: [{ event: 'status', data: { message: 'scanning' } }, step(1)] });
        expect(h.container.querySelector('#mstep-init')).toBeTruthy();
    });

    it('offers no Init block when the run started with a step', () => {
        const h = mountLog({ logs: [step(1), thought('a')] });
        expect(h.container.querySelector('#mstep-init')).toBeNull();
    });

    it('summarises a step from its thought', () => {
        const h = mountLog({ logs: [step(1), thought('Read the config to find the port')] });
        expect(summaryOf(steps(h.container)[0])).toMatch(/config/i);
    });

    it('falls back to the first tool, then to a placeholder', () => {
        const a = mountLog({ logs: [step(1), tool('read_file')] });
        expect(summaryOf(steps(a.container)[0])).toBe('Used read_file');
        cleanup();
        const b = mountLog({ logs: [step(1)] });
        expect(summaryOf(steps(b.container)[0])).toMatch(/no output/i);
    });
});

describe('request dividers', () => {
    // Ported from the renderAllLogs test. The separator lives in
    // requestDividerHtml; the view once prepended its own " — " as well, which
    // produced "— — prompt".
    it('draws one divider per request, with the preview separated once', () => {
        const h = mountLog({
            logs: [step(1), step(2)],
            dividerPreview: (n) => (n === 1 ? 'fix the login bug' : ''),
        });
        expect(h.container.querySelectorAll('.mturn-request').length).toBeGreaterThan(0);
        expect(h.container.textContent).toContain('fix the login bug');
        expect(h.container.textContent).not.toContain('— — ');
    });

    // A continuation restarts the step counter, which is how a new request is
    // recognised — there is no marker event for it.
    it('starts a new request when the step counter restarts', () => {
        const h = mountLog({ logs: [step(1), step(2), step(1)] });
        expect(h.container.querySelectorAll('.mturn-request')).toHaveLength(2);
    });
});

describe('expanding', () => {
    // The predecessor achieved this by collapsing the previous step by hand
    // every time a new one began.
    it('opens the newest step and leaves the rest collapsed', () => {
        const h = mountLog({ logs: [step(1), thought('a'), step(2), thought('b')] });
        const list = steps(h.container);
        expect(headerOf(list[0]).classList.contains('expanded')).toBe(false);
        expect(headerOf(list[1]).classList.contains('expanded')).toBe(true);
    });

    it('toggles a step when its header is clicked', async () => {
        const h = mountLog({ logs: [step(1), thought('a'), step(2)] });
        const first = steps(h.container)[0];
        await fireEvent.click(headerOf(first));
        await waitFor(() => expect(headerOf(steps(h.container)[0]).classList.contains('expanded')).toBe(true));
        await fireEvent.click(headerOf(steps(h.container)[0]));
        await waitFor(() => expect(headerOf(steps(h.container)[0]).classList.contains('expanded')).toBe(false));
    });

    // Content routing used to be tied to `.mstep-header.expanded`, so reading an
    // older step sent every later event into it and left the real one empty.
    it('keeps what a step CONTAINS independent of what is expanded', async () => {
        const logs = [step(1), thought('first'), step(2), thought('second')];
        const h = mountLog({ logs, version: 1 });
        await fireEvent.click(headerOf(steps(h.container)[0]));   // read the old one
        await h.rerender({ logs: [...logs, tool('grep_search')], version: 2 });
        await waitFor(() => {
            const list = steps(h.container);
            // The new event landed in the LAST step, not the expanded one.
            expect(list[1].querySelector('.mstep-body').textContent).toContain('tool_call');
            expect(list[0].querySelector('.mstep-body').textContent).not.toContain('tool_call');
        });
    });
});

describe('the live label', () => {
    // A step in flight shows what it is DOING; a finished one shows what it
    // achieved. That is why the live label is an override, not part of the model.
    it('overrides only the newest step', () => {
        const h = mountLog({
            logs: [step(1), thought('Read the config'), step(2), thought('Edited the file')],
            liveStatus: { text: '⚙ Running: npm test…', type: 'tool' },
        });
        const list = steps(h.container);
        expect(summaryOf(list[1])).toBe('⚙ Running: npm test…');
        expect(summaryOf(list[0])).toMatch(/config/i);
    });

    it('falls back to what the step achieved once the label is cleared', async () => {
        const logs = [step(1), thought('Read the config')];
        const h = mountLog({ logs, liveStatus: { text: '⚙ Running…', type: 'tool' } });
        expect(summaryOf(steps(h.container)[0])).toBe('⚙ Running…');
        await h.rerender({ logs, liveStatus: null });
        await waitFor(() => expect(summaryOf(steps(h.container)[0])).toMatch(/config/i));
    });

    it('pulses only while something is live', async () => {
        const logs = [step(1)];
        const h = mountLog({ logs, liveStatus: { text: 'x', type: 'live' } });
        expect(h.container.querySelector('.mstep-pulse')).toBeTruthy();
        await h.rerender({ logs, liveStatus: null });
        await waitFor(() => expect(h.container.querySelector('.mstep-pulse')).toBeNull());
    });
});

describe('the CHAT button', () => {
    it('appears on a step that made API calls, totalling them', () => {
        const h = mountLog({ logs: [step(1), chat(), chat({ duration: 80 })] });
        const btn = h.container.querySelector('.mstep-chat-btn');
        expect(btn).toBeTruthy();
        expect(btn.textContent).toContain('CHAT 200');
        expect(btn.textContent).toContain('↑20t');
        expect(btn.textContent).toContain('200ms');
    });

    it('marks a failed call', () => {
        const h = mountLog({ logs: [step(1), chat({ status: 500 })] });
        expect(h.container.querySelector('.mstep-chat-btn').classList.contains('err')).toBe(true);
    });

    // The button sits inside the header, whose click toggles the step.
    it('opens the calls without also toggling the step', async () => {
        const h = mountLog({ logs: [step(1), thought('a'), step(2), chat()] });
        const before = headerOf(steps(h.container)[1]).classList.contains('expanded');
        await fireEvent.click(h.container.querySelector('.mstep-chat-btn'));
        expect(h.onOpenChat).toHaveBeenCalledWith([expect.objectContaining({ method: 'CHAT' })]);
        expect(headerOf(steps(h.container)[1]).classList.contains('expanded')).toBe(before);
    });

    it('is absent from a step that made none', () => {
        const h = mountLog({ logs: [step(1), thought('a')] });
        expect(h.container.querySelector('.mstep-chat-btn')).toBeNull();
    });
});

describe('the controls inside a formatted line', () => {
    // These arrive as HTML from the view's formatter, so they are delegated —
    // the one place delegation is still right. All four used to live in a single
    // handler on #console-logs, and keeping only the first when that handler
    // moved here is what made a TOOL row stop opening.

    /** A step whose one line is the given markup. */
    const withLine = (html) => mountLog({ logs: [step(1), thought('x')], formatLine: () => html });

    const TOOL_ROW = `
        <div class="mlog">
            <div class="mlog-tool-row" data-uid="u1">
                <span>read_file</span>
                <button class="mlog-expand-btn" data-uid="u1" data-target="tool-result-u1">▶</button>
            </div>
            <div class="mlog-tool-result" id="tool-result-u1">the file body</div>
        </div>`;

    const TELEMETRY = `
        <div class="mlog-telemetry" id="tele-u2">
            <div class="mlog-tele-header">
                <span class="mlog-tele-method">TOOL:glob</span>
                <span class="mlog-tele-status-ok">200</span>
                <span>▶</span>
            </div>
            <div class="mlog-tele-body" id="tele-body-u2">
                <div class="mlog-tele-tabs">
                    <button class="mlog-tele-tab active" data-tab="req" data-uid="u2">Request</button>
                    <button class="mlog-tele-tab" data-tab="res" data-uid="u2">Response</button>
                </div>
                <div class="mlog-tele-content" id="tele-content-u2">
                    <pre class="tele-pane tele-req-u2">REQUEST</pre>
                    <pre class="tele-pane tele-res-u2" style="display:none">RESPONSE</pre>
                </div>
            </div>
        </div>`;

    it('opens the detail an expand button points at, and closes it again', async () => {
        const h = withLine(`<div class="mlog"><button class="mlog-expand-btn" data-target="d1">▶</button>`
            + `<div id="d1">detail</div></div>`);
        const btn = h.container.querySelector('.mlog-expand-btn');
        const detail = h.container.querySelector('#d1');
        await fireEvent.click(btn);
        expect(detail.classList.contains('open')).toBe(true);
        expect(btn.textContent).toBe('▼');
        await fireEvent.click(btn);
        expect(detail.classList.contains('open')).toBe(false);
        expect(btn.textContent).toBe('▶');
    });

    // The arrow alone is a small target, so the summary line stands in for it.
    it('opens the thought detail from the summary line too', async () => {
        const h = withLine(`<div class="mlog"><div class="mlog-thought-summary">`
            + `<span>I will read the config</span>`
            + `<button class="mlog-expand-btn" data-target="d2">▶</button></div>`
            + `<div id="d2">full thought</div></div>`);
        await fireEvent.click(h.container.querySelector('.mlog-thought-summary span'));
        expect(h.container.querySelector('#d2').classList.contains('open')).toBe(true);
    });

    it('opens a tool result from anywhere on its row', async () => {
        const h = withLine(TOOL_ROW);
        await fireEvent.click(h.container.querySelector('.mlog-tool-row span'));
        expect(h.container.querySelector('#tool-result-u1').classList.contains('open')).toBe(true);
        expect(h.container.querySelector('.mlog-tool-row .mlog-expand-btn').textContent).toBe('▼');
    });

    it('opens a telemetry row from its header', async () => {
        const h = withLine(TELEMETRY);
        const header = h.container.querySelector('.mlog-tele-header');
        await fireEvent.click(header.querySelector('.mlog-tele-method'));
        expect(h.container.querySelector('#tele-body-u2').classList.contains('open')).toBe(true);
        expect(header.querySelector('span:last-child').textContent).toBe('▼');
        await fireEvent.click(header.querySelector('.mlog-tele-method'));
        expect(h.container.querySelector('#tele-body-u2').classList.contains('open')).toBe(false);
    });

    it('switches a telemetry payload tab', async () => {
        const h = withLine(TELEMETRY);
        await fireEvent.click(h.container.querySelector('.mlog-tele-header .mlog-tele-method'));
        const res = [...h.container.querySelectorAll('.mlog-tele-tab')].find(b => /Response/.test(b.textContent));
        await fireEvent.click(res);
        expect(res.classList.contains('active')).toBe(true);
        expect(h.container.querySelector('.tele-req-u2').style.display).toBe('none');
        expect(h.container.querySelector('.tele-res-u2').style.display).toBe('block');
    });

    // The tabs sit INSIDE the body a header click would close, so the tab has to
    // be recognised first.
    it('does not close the telemetry row when a tab is clicked', async () => {
        const h = withLine(TELEMETRY);
        await fireEvent.click(h.container.querySelector('.mlog-tele-header .mlog-tele-method'));
        const res = [...h.container.querySelectorAll('.mlog-tele-tab')].find(b => /Response/.test(b.textContent));
        await fireEvent.click(res);
        expect(h.container.querySelector('#tele-body-u2').classList.contains('open')).toBe(true);
    });

    it('does not toggle the STEP when a line control is used', async () => {
        const h = withLine(TOOL_ROW);
        const before = headerOf(steps(h.container)[0]).classList.contains('expanded');
        await fireEvent.click(h.container.querySelector('.mlog-tool-row span'));
        expect(headerOf(steps(h.container)[0]).classList.contains('expanded')).toBe(before);
    });
});

describe('the approval card', () => {
    // The card is markup the VIEW builds (monitor/confirmCards.js) and is shared
    // with the Story surface, so its buttons are delegated rather than bound.
    // Losing that delegation in the migration is what left Approve and Reject
    // dead in the raw log while the card itself rendered fine.
    const CARD = `
        <div class="mlog">
            <div class="mconfirm-box" data-confirm-card="c1">
                <h4>Command Approval</h4>
                <div class="mconfirm-actions">
                    <button class="btn-approve" data-confirm-id="c1">Approve</button>
                    <button class="btn-reject" data-confirm-id="c1">Reject</button>
                </div>
            </div>
        </div>`;

    const withCard = (onCardClick) => mountLog({
        logs: [step(1), thought('x')], formatLine: () => CARD, onCardClick,
    });

    it('hands a click on Approve to the view', async () => {
        const onCardClick = vi.fn(() => true);
        const h = withCard(onCardClick);
        await fireEvent.click(h.container.querySelector('.btn-approve'));
        expect(onCardClick).toHaveBeenCalled();
    });

    it('hands Reject over too', async () => {
        const onCardClick = vi.fn(() => true);
        const h = withCard(onCardClick);
        await fireEvent.click(h.container.querySelector('.btn-reject'));
        expect(onCardClick).toHaveBeenCalled();
    });

    // The buttons sit inside a step body, so without this the step would fold
    // underneath the click that was meant to approve something.
    it('does not toggle the step when the card handles the click', async () => {
        const h = withCard(vi.fn(() => true));
        const before = headerOf(steps(h.container)[0]).classList.contains('expanded');
        await fireEvent.click(h.container.querySelector('.btn-approve'));
        expect(headerOf(steps(h.container)[0]).classList.contains('expanded')).toBe(before);
    });

    // A click the card does not claim must still reach the other controls.
    it('lets an unclaimed click fall through to the line controls', async () => {
        const h = mountLog({
            logs: [step(1), thought('x')],
            // The target lives INSIDE the line: the lookup is scoped to this
            // component, so a formatted line cannot reach an element elsewhere
            // on the page that happens to share its id.
            formatLine: () => '<div class="mlog"><button class="mlog-expand-btn" data-target="d-fall">▶</button>'
                + '<div id="d-fall">detail</div></div>',
            onCardClick: () => false,
        });
        await fireEvent.click(h.container.querySelector('.mlog-expand-btn'));
        expect(h.container.querySelector('#d-fall').classList.contains('open')).toBe(true);
    });

    it('works with no handler wired at all', async () => {
        const h = withCard(null);
        await expect(fireEvent.click(h.container.querySelector('.btn-approve'))).resolves.toBeDefined();
    });
});

describe('the filter attribute', () => {
    // CSS hides the lines that do not match; the attribute is the whole
    // mechanism, so it has to reach the rendered container.
    it('carries the current filter onto the console element', async () => {
        const h = mountLog({ logs: [step(1)], filter: 'all' });
        expect(h.container.querySelector('.mconsole').getAttribute('data-current-filter')).toBe('all');
        await h.rerender({ logs: [step(1)], filter: 'result' });
        await waitFor(() => expect(
            h.container.querySelector('.mconsole').getAttribute('data-current-filter')).toBe('result'));
    });
});
