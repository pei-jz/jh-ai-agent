// @vitest-environment jsdom
//
// TimelineItem / Timeline — region 3 of the Svelte migration.
//
// These replace the render half of views/monitor/__tests__/timelineItems.test.js
// (which kept the classification half) and the whole of timelineRender.test.js,
// whose subject — keyed DOM reuse — is now Svelte's keyed {#each} rather than a
// hand-rolled differ. The reuse property is still asserted here, because it is a
// real requirement and not an implementation detail: a streaming run must touch
// one line's worth of DOM, not rebuild the panel.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import TimelineItem from '../TimelineItem.svelte';
import Timeline from '../Timeline.svelte';

afterEach(() => cleanup());

/** Markdown stand-in: wraps so we can see it was applied, without a real parser. */
const md = (t) => `<p>${String(t ?? '')}</p>`;
const mountItem = (item, props = {}) =>
    render(TimelineItem, { props: { item, renderMarkdown: md, ...props } }).container;

describe('TimelineItem — the wrapper row', () => {
    it('marks the chapter kind and carries the item id for scroll targets', () => {
        const el = mountItem({ id: 'i7', kind: 'group', head: { text: 'Reading' }, lines: [] });
        const row = el.querySelector('.tl-chapter');
        expect(row.classList.contains('tl-step')).toBe(true);
        expect(row.dataset.itemId).toBe('i7');
    });

    it('marks a live item', () => {
        const el = mountItem({ id: 'i1', kind: 'group', live: true, head: { text: 'x' }, lines: [] });
        expect(el.querySelector('.tl-chapter').classList.contains('is-live')).toBe(true);
    });
});

describe('TimelineItem — request', () => {
    const req = { id: 'i1', kind: 'request', _ex: 0, text: 'update the README' };

    it('labels it and shows the text', () => {
        const el = mountItem(req);
        expect(el.textContent).toContain('Your request');
        expect(el.textContent).toContain('update the README');
    });

    it('opens the clamped text on click — on the WRAPPER, where the CSS acts', async () => {
        const el = mountItem(req);
        const row = el.querySelector('.tl-chapter');
        expect(row.classList.contains('is-open')).toBe(false);
        el.querySelector('.tl-card-request').click();
        await tick();
        expect(row.classList.contains('is-open')).toBe(true);
    });

    it('gives the story marker a REAL button — a ::before takes no clicks', () => {
        // The fold affordance never fired at all while it was a pseudo-element.
        const onToggleStory = vi.fn();
        const el = mountItem(req, { onToggleStory });
        const toggle = el.querySelector('.tl-story-toggle');
        expect(toggle.tagName).toBe('BUTTON');
        toggle.click();
        expect(onToggleStory).toHaveBeenCalledWith(0, 'working');
    });

    it('marks the marker when the exchange is folded', () => {
        const el = mountItem({ ...req, _folded: true });
        expect(el.querySelector('.tl-story-toggle').classList.contains('is-folded')).toBe(true);
    });

    it('shows attached image thumbnails', () => {
        const el = mountItem({ ...req, images: ['data:image/png;base64,AAA'] });
        expect(el.querySelectorAll('.mrc-img')).toHaveLength(1);
    });

    it('escapes hostile request text', () => {
        const el = mountItem({ ...req, text: '<img src=x onerror=1>' });
        expect(el.querySelector('img')).toBe(null);
        expect(el.textContent).toContain('<img src=x onerror=1>');
    });
});

describe('TimelineItem — reasoning step', () => {
    const group = {
        id: 'i2', kind: 'group', _stepNo: 8, at: 1786000000000,
        head: { text: 'Looking for the handler' },
        lines: [
            { type: 'tool', text: 'Read: MonitorView.js', tool: 'read_file', path: 'C:/p/src/MonitorView.js' },
            { type: 'tool', text: 'Searched for onclick', tool: 'grep_search' },
        ],
    };

    it('pads the step number so the column stays aligned', () => {
        expect(mountItem(group).querySelector('.tl-step-num').textContent).toBe('08');
    });

    it('shows a dash when the step has no number yet', () => {
        expect(mountItem({ ...group, _stepNo: 0 }).querySelector('.tl-step-num').textContent).toBe('–');
    });

    it('summarises what the step DID as chips, so a folded step still says it', () => {
        const chips = [...mountItem(group).querySelectorAll('.tl-tchip')].map(c => c.textContent.trim());
        expect(chips).toEqual(['read_file', 'grep_search']);
    });

    it('counts its lines', () => {
        expect(mountItem(group).querySelector('.tl-step-count').textContent).toBe('2');
    });

    it('renders each line, with the touched file as its own control', () => {
        const el = mountItem(group);
        expect(el.querySelectorAll('.mtask-feed-item')).toHaveLength(2);
        const file = el.querySelector('[data-open-path]');
        expect(file.tagName).toBe('BUTTON');
        expect(file.textContent).toContain('MonitorView.js');
    });

    it('opens the touched file WITHOUT toggling the line', () => {
        const onOpenFile = vi.fn();
        const el = mountItem(group, { onOpenFile });
        el.querySelector('[data-open-path]').click();
        expect(onOpenFile).toHaveBeenCalledWith('C:/p/src/MonitorView.js');
    });

    it('REPORTS a fold rather than writing into the item', () => {
        // The component must not keep its own copy: the MODEL flips this flag itself
        // (opening a new step folds every earlier one), and a local copy would never
        // see that — which is exactly how auto-folding silently stopped working.
        const onToggleCollapse = vi.fn();
        const item = { ...group };
        mountItem(item, { onToggleCollapse }).querySelector('.mtask-group-head').click();
        expect(onToggleCollapse).toHaveBeenCalledWith('i2');
        expect(item.collapsed).toBeUndefined();
    });

    it('shows the fold state it is GIVEN', () => {
        const el = mountItem(group, { isCollapsed: true });
        expect(el.querySelector('.tl-chapter').classList.contains('collapsed')).toBe(true);
    });

    it('re-folds when the model changes its mind — the auto-fold path', async () => {
        // The model folds earlier steps by itself when a new one opens. The flag
        // arrives as a prop, so the DOM follows without the component holding a copy.
        const item = { ...group };
        const { container, rerender } = render(TimelineItem, {
            props: { item, isCollapsed: false, renderMarkdown: md },
        });
        expect(container.querySelector('.tl-chapter').classList.contains('collapsed')).toBe(false);
        await rerender({ item, isCollapsed: true, renderMarkdown: md });
        expect(container.querySelector('.tl-chapter').classList.contains('collapsed')).toBe(true);
    });
});

describe('TimelineItem — a long line clamps and opens', () => {
    it('expands a clampable line on click', async () => {
        const item = {
            id: 'i3', kind: 'group', head: { text: 'x' },
            lines: [{ type: 'tool', text: 'y'.repeat(200) }],
        };
        const el = mountItem(item);
        const line = el.querySelector('.mtask-feed-item');
        expect(line.classList.contains('clampable')).toBe(true);
        line.click();
        await tick();
        expect(line.classList.contains('expanded')).toBe(true);
    });
});

describe('TimelineItem — ask', () => {
    const ask = { id: 'i4', kind: 'ask', text: 'Which approach?', options: ['A', 'B'] };

    it('carries the question AND its choices in one card', () => {
        // These used to be in two places: the question in the (collapsed) activity
        // feed, the buttons in a slot near the input box.
        const el = mountItem(ask);
        expect(el.textContent).toContain('Which approach?');
        expect([...el.querySelectorAll('.mask-opt')].map(b => b.textContent)).toEqual(['A', 'B']);
    });

    it('answers with the clicked option', () => {
        const onAnswer = vi.fn();
        mountItem(ask, { onAnswer }).querySelectorAll('.mask-opt')[1].click();
        expect(onAnswer).toHaveBeenCalledWith('B');
    });

    it('offers checkboxes and a submit for a multi-select', () => {
        const el = mountItem({ ...ask, multi: true });
        expect(el.querySelectorAll('.mask-check input')).toHaveLength(2);
        expect(el.querySelector('.mask-submit')).not.toBe(null);
    });

    it('submits the checked set, joined', async () => {
        const onAnswer = vi.fn();
        const el = mountItem({ ...ask, multi: true }, { onAnswer });
        const boxes = el.querySelectorAll('.mask-check input');
        boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
        boxes[1].checked = true; boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        el.querySelector('.mask-submit').click();
        expect(onAnswer).toHaveBeenCalledWith('A, B');
    });

    it('does not submit an empty selection', () => {
        const onAnswer = vi.fn();
        mountItem({ ...ask, multi: true }, { onAnswer }).querySelector('.mask-submit').click();
        expect(onAnswer).not.toHaveBeenCalled();
    });

    it('a FREE-TEXT question still gets a card — it used to get none at all', () => {
        const el = mountItem({ id: 'i5', kind: 'ask', text: 'What next?' });
        expect(el.textContent).toContain('What next?');
        expect(el.textContent).toContain('Answer in the box below');
    });

    it('a CLOSED question is history, not a prompt', () => {
        // Reopening a finished task used to re-render the question as a live
        // "answer me" card, every time. It must show as history instead.
        const el = mountItem({ ...ask, answered: true, answer: '', unanswered: true });
        expect(el.querySelectorAll('.mask-opt')).toHaveLength(0);
        expect(el.querySelector('.mask-box').classList.contains('is-open')).toBe(false);
        expect(el.textContent).toContain('Which approach?');
    });

    it('does not claim an answer the user never gave', () => {
        const el = mountItem({ ...ask, answered: true, answer: '', unanswered: true });
        expect(el.textContent).toContain('未回答');
        expect(el.textContent).not.toContain('(answered)');
    });

    it('an unanswered question still offers a way IN — the run is paused on it', () => {
        // The fix for "a completed task never resumes": the closed card was a
        // dead end, so the question it carried could never be answered at all.
        const onReopenAsk = vi.fn();
        const el = mountItem({ ...ask, answered: true, answer: '', unanswered: true }, { onReopenAsk });
        const btn = el.querySelector('.mask-reopen');
        expect(btn).not.toBe(null);
        btn.click();
        expect(onReopenAsk).toHaveBeenCalledTimes(1);
        expect(onReopenAsk.mock.calls[0][0].text).toBe('Which approach?');
    });

    it('an ANSWERED question gets no reopen button — there is nothing left to do', () => {
        const el = mountItem({ ...ask, answered: true, answer: 'A' }, { onReopenAsk: vi.fn() });
        expect(el.querySelector('.mask-reopen')).toBe(null);
    });

    it('shows the answer once answered, and stops offering choices', () => {
        const el = mountItem({ ...ask, answered: true, answer: 'A' });
        expect(el.querySelector('.mask-box').classList.contains('is-answered')).toBe(true);
        expect(el.textContent).toContain('A');
        expect(el.querySelectorAll('.mask-opt')).toHaveLength(0);
    });
});

describe('TimelineItem — deliverables and the final answer', () => {
    it('titles a deliverable for what it IS', () => {
        expect(mountItem({ id: 'i6', kind: 'deliverable', envKind: 'markdown', text: 'x' }).textContent)
            .toContain('Proposal');
        cleanup();
        expect(mountItem({ id: 'i6', kind: 'deliverable', envKind: 'table', text: 'x' }).textContent)
            .toContain('Result');
    });

    it('renders the body through the injected markdown renderer', () => {
        const el = mountItem({ id: 'i6', kind: 'deliverable', envKind: 'markdown', text: 'hello' });
        expect(el.querySelector('.rv-summary').innerHTML).toContain('<p>hello</p>');
    });

    it('reports a standalone card fold — no exchange to route through', () => {
        const onToggleCollapse = vi.fn();
        const item = { id: 'i6', kind: 'deliverable', envKind: 'markdown', text: 'x' };
        mountItem(item, { onToggleCollapse }).querySelector('.tl-fold-h').click();
        expect(onToggleCollapse).toHaveBeenCalledWith('i6');
    });

    it('routes folding through the EXCHANGE when it belongs to one', () => {
        // A class on the node would not survive the next render; the exchange's
        // fold state does.
        const onToggleStory = vi.fn();
        const el = mountItem({ id: 'i6', kind: 'run', _ex: 2, answer: 'done' }, { onToggleStory });
        el.querySelector('.tl-fold-h').click();
        expect(onToggleStory).toHaveBeenCalledWith(2, 'outcome');
    });

    it('offers a copy button on a DOCUMENT, and does not fold the card with it', () => {
        const onCopyDoc = vi.fn();
        const onToggleStory = vi.fn();
        const el = mountItem({ id: 'i6', kind: 'document', envKind: 'markdown', text: 'body', _ex: 1 },
            { onCopyDoc, onToggleStory });
        el.querySelector('.tl-doc-copy').click();
        expect(onCopyDoc).toHaveBeenCalledWith('body');
        expect(onToggleStory).not.toHaveBeenCalled();
    });

    it('shows the run stats and files', () => {
        const el = mountItem({
            id: 'i6', kind: 'run', answer: 'done',
            stats: { steps: 4, tokens: 2000 },
            files: [{ path: 'C:/p/a.js', action: 'modified' }],
        });
        expect(el.textContent).toContain('4 steps');
        expect(el.textContent).toContain('2.0k tok');
        expect(el.querySelector('[data-open-path="C:/p/a.js"]')).not.toBe(null);
    });

    it('says so rather than showing an empty body when there is no answer', () => {
        expect(mountItem({ id: 'i6', kind: 'run' }).textContent).toContain('(no answer)');
    });
});

describe('TimelineItem — folded exchanges', () => {
    it('a folded WORKING is one bar that says how much it hides', () => {
        const el = mountItem({ id: 'i7', kind: 'fold', ex: 1, steps: 12, at: 1000, to: 201000 });
        const bar = el.querySelector('.tl-fold-bar');
        expect(bar.textContent).toContain('12 steps');
        expect(bar.textContent).toContain('3m 20s');
        expect(bar.textContent).toContain('Show working');
    });

    it('a folded RESULT renders its header ALONE, not a hidden body', () => {
        // This is what makes a long task open quickly: the markdown of every past
        // exchange no longer has to be parsed to show one line.
        const el = mountItem({ id: 'i8', kind: 'run', _bodyless: true, _ex: 1, answer: 'one two three' });
        expect(el.textContent).toContain('Agent · Final');
        expect(el.textContent).toContain('3 words');
        expect(el.querySelector('.tl-card-body')).toBe(null);
        expect(el.querySelector('.rv-summary')).toBe(null);
    });

    it('the two bars open DIFFERENT halves', () => {
        // Folding one used to drag the other with it.
        const onToggleStory = vi.fn();
        mountItem({ id: 'i7', kind: 'fold', ex: 3, steps: 2 }, { onToggleStory })
            .querySelector('.tl-fold-bar').click();
        expect(onToggleStory).toHaveBeenCalledWith(3, 'working');
        cleanup();
        onToggleStory.mockClear();
        mountItem({ id: 'i8', kind: 'run', _bodyless: true, _ex: 3 }, { onToggleStory })
            .querySelector('.tl-fold-bar').click();
        expect(onToggleStory).toHaveBeenCalledWith(3, 'outcome');
    });
});

describe('TimelineItem — task_progress', () => {
    const progress = {
        id: 'i14', kind: 'task_progress',
        items: [
            { id: '1', title: 'タスク一覧の調査', status: 'completed' },
            { id: '2', title: '実装', status: 'in_progress' },
            { id: '3', title: 'テスト', status: 'pending' },
            { id: '4', title: '修正内容を反映', status: 'pending' },
        ],
    };

    it('shows the tally and every subtask with its status', () => {
        const el = mountItem(progress);
        expect(el.textContent).toContain('task_progress (1/4 complete)');
        expect(el.textContent).toContain('[1]');
        expect(el.textContent).toContain('タスク一覧の調査');
        expect(el.textContent).toContain('[2]');
        expect(el.textContent).toContain('実装');
        expect(el.querySelectorAll('.tl-progress-row')).toHaveLength(4);
        // Completed rows are marked so the tick reads as done.
        expect(el.querySelectorAll('.tl-progress-row.is-done')).toHaveLength(1);
    });

    it('folds on its OWN header click, not through the exchange', () => {
        const onToggleCollapse = vi.fn();
        const el = mountItem({ ...progress, _ex: 3 }, { onToggleCollapse });
        el.querySelector('.tl-card-h').click();
        expect(onToggleCollapse).toHaveBeenCalledWith('i14');
    });

    it('renders a note when a subtask carries one', () => {
        const el = mountItem({
            ...progress,
            items: [{ id: '1', title: 'x', status: 'pending', note: 'blocked on API' }],
        });
        expect(el.textContent).toContain('blocked on API');
    });
});

describe('TimelineItem — the rest', () => {
    it('renders a turn divider', () => {
        expect(mountItem({ id: 'i9', kind: 'turn', n: 2 }).textContent).toContain('Request 2');
        cleanup();
        expect(mountItem({ id: 'i9', kind: 'turn' }).textContent).toContain('New request');
    });

    it('renders a narration as the agent note', () => {
        const el = mountItem({ id: 'i10', kind: 'narration', text: 'thinking aloud' });
        expect(el.textContent).toContain("The agent's note");
        expect(el.querySelector('.rv-summary').innerHTML).toContain('thinking aloud');
    });

    it('renders an error line', () => {
        const el = mountItem({ id: 'i11', kind: 'error', text: 'it broke' });
        expect(el.querySelector('.mtask-feed-item.is-error').textContent).toContain('it broke');
    });

    it('renders a bare activity line without a numbered frame', () => {
        const el = mountItem({ id: 'i12', kind: 'activity', type: 'tool', text: 'starting up' });
        expect(el.querySelector('.tl-bare-line')).not.toBe(null);
        expect(el.querySelector('.tl-step-num')).toBe(null);
    });

    it('passes the approval card prebuilt markup through', () => {
        // Still built by MonitorView._fmtConfirm and handled by the delegated
        // handler on #result-panel, because the Raw Log surface shares it.
        const el = mountItem({ id: 'i13', kind: 'confirm', text: '<button class="btn-approve">Approve</button>' });
        expect(el.querySelector('.btn-approve')).not.toBe(null);
    });
});

describe('Timeline — keyed reuse', () => {
    const item = (id, text) => ({ id, kind: 'activity', type: 'tool', text });

    it('renders every item, in order', () => {
        const { container } = render(Timeline, {
            props: { items: [item('a', 'first'), item('b', 'second')], renderMarkdown: md },
        });
        const rows = [...container.querySelectorAll('[data-item-id]')].map(r => r.dataset.itemId);
        expect(rows).toEqual(['a', 'b']);
    });

    it('REUSES the node of an unchanged item when one is appended', async () => {
        // The requirement timelineRender.js existed for: a streaming run must touch
        // one line's worth of DOM, not rebuild the panel — otherwise the markdown
        // of every completed exchange is re-parsed on every incoming line.
        const a = item('a', 'first');
        const { container, rerender } = render(Timeline, {
            props: { items: [a], renderMarkdown: md },
        });
        const before = container.querySelector('[data-item-id="a"]');
        await rerender({ items: [a, item('b', 'second')], renderMarkdown: md });
        expect(container.querySelector('[data-item-id="a"]')).toBe(before);
        expect(container.querySelectorAll('[data-item-id]')).toHaveLength(2);
    });

    it('drops the node of an item that is gone', async () => {
        const b = item('b', 'second');
        const { container, rerender } = render(Timeline, {
            props: { items: [item('a', 'first'), b], renderMarkdown: md },
        });
        await rerender({ items: [b], renderMarkdown: md });
        expect(container.querySelector('[data-item-id="a"]')).toBe(null);
        expect(container.querySelector('[data-item-id="b"]')).not.toBe(null);
    });

    it('renders nothing for an empty or missing list', () => {
        expect(render(Timeline, { props: { items: [] } }).container.textContent.trim()).toBe('');
        cleanup();
        expect(render(Timeline, { props: { items: null } }).container.textContent.trim()).toBe('');
    });
});
