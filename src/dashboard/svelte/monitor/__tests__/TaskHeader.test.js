// @vitest-environment jsdom
//
// TaskHeader — region 2 of the Svelte migration.
//
// The behaviours pinned here are the ones that were previously unverifiable,
// because each live field was written by `getElementById(...).textContent =` from
// a different place in MonitorView: that the numbers appear at all, that Abort
// becomes Delete when the run ends, and that the context bar reflects its state
// rather than an inline style set from JS.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import TaskHeader from '../TaskHeader.svelte';

afterEach(() => cleanup());

const task = {
    id: 'a78b33ad9c',
    prompt: 'jh-ai-agent を調査して評価してください',
    caller: 'NewTask',
    started_at: '2026-08-08T21:25:30Z',
    workspace_path: 'C:/cusor_workspace/jh-ai-agent',
};

const mount = (props = {}) => render(TaskHeader, {
    props: { task, status: 'completed', ...props },
}).container;

describe('TaskHeader — what it leads with', () => {
    it('puts the request first, then the vital signs', () => {
        const el = mount({ steps: 77, usage: { total_tokens: 2901720 } });
        const order = ['.mdh-title', '.mdh-meta']
            .map(sel => [...el.querySelectorAll('*')].indexOf(el.querySelector(sel)));
        expect(order[0]).toBeLessThan(order[1]);
    });

    it('shows the prompt, and keeps the full text as a tooltip', () => {
        const el = mount();
        expect(el.querySelector('.mdh-title').textContent).toContain('jh-ai-agent');
        expect(el.querySelector('.mdh-title').title).toBe(task.prompt);
    });

    it('does NOT repeat the id / caller — the inspector beside it carries those', () => {
        // A header line that only restates what is already visible next to it
        // costs a row of fixed furniture above the story and adds nothing.
        const el = mount();
        expect(el.querySelector('.mdh-sub')).toBe(null);
        expect(el.textContent).not.toContain('#a78b33ad');
        expect(el.textContent).not.toContain('caller');
    });

    it('renders nothing without a task', () => {
        expect(render(TaskHeader, { props: { task: null } }).container.textContent.trim()).toBe('');
    });
});

describe('TaskHeader — the vital signs', () => {
    it('renders the elapsed and token totals', () => {
        const el = mount({ steps: 77, usage: { total_tokens: 2901720, prompt_tokens: 2861972, cache_read_input_tokens: 2530944, completion_tokens: 39748 } });
        const meta = el.querySelector('.mdh-meta').textContent;
        expect(meta).toContain('2901.7k');
        // The breakdown, with thousands separators.
        expect(meta).toContain('2,861,972');
        expect(meta).toContain('2,530,944');
        expect(meta).toContain('39,748');
    });

    it('no longer repeats status, started or steps — the list and the inspector carry them', () => {
        // A header line that only restates what is visible beside it costs a row
        // of fixed furniture above the story and adds nothing.
        const el = mount({ steps: 77, status: 'completed' });
        expect(el.querySelector('.task-badge')).toBe(null);
        expect(el.textContent).not.toContain('started');
        expect(el.textContent).not.toContain('steps');
    });

    it('measures elapsed to the completion stamp on a finished run', () => {
        const el = mount({
            status: 'completed',
            task: { ...task, completed_at: '2026-08-08T21:32:26Z' },
            now: Date.parse('2026-08-09T00:00:00Z'),
        });
        expect(el.querySelector('.mdh-meta').textContent).toContain('6m 56s');
    });
});

describe('TaskHeader — Abort vs Delete', () => {
    it('offers Abort ONLY while running', () => {
        expect(mount({ status: 'running' }).textContent).toContain('Abort');
        cleanup();
        expect(mount({ status: 'running' }).textContent).not.toContain('Delete');
    });

    it('offers Delete once the run has ended', () => {
        // This used to require removing #btn-abort-task from the DOM by hand on
        // completion; the button is derived from status now.
        const el = mount({ status: 'completed' });
        expect(el.textContent).toContain('Delete');
        expect(el.textContent).not.toContain('Abort');
    });

    it('calls back on Abort', () => {
        const onAbort = vi.fn();
        mount({ status: 'running', onAbort }).querySelector('.mdh-act').click();
        expect(onAbort).toHaveBeenCalled();
    });

    it('calls back on Delete', () => {
        const onDelete = vi.fn();
        mount({ status: 'completed', onDelete }).querySelector('.mdh-act').click();
        expect(onDelete).toHaveBeenCalled();
    });
});

describe('TaskHeader — context gauge', () => {
    it('fills the bar and labels it', () => {
        const el = mount({ context: { used: 135000, limit: 256000 } });
        expect(el.querySelector('.mdh-ctx-pct').textContent).toBe('135K / 256K (53%)');
        expect(el.querySelector('.mdh-ctx-fill').style.width).toBe('53%');
    });

    it('marks danger with a CLASS rather than an inline background', () => {
        const el = mount({ context: { used: 90, limit: 100 } });
        expect(el.querySelector('.mdh-ctx-fill').classList.contains('is-danger')).toBe(true);
    });

    it('is not in danger below the threshold', () => {
        const el = mount({ context: { used: 10, limit: 100 } });
        expect(el.querySelector('.mdh-ctx-fill').classList.contains('is-danger')).toBe(false);
    });

    it('shows a dash and an empty bar before the first LLM call', () => {
        const el = mount({ context: null });
        expect(el.querySelector('.mdh-ctx-pct').textContent).toBe('—');
        expect(el.querySelector('.mdh-ctx-fill').style.width).toBe('0%');
    });
});

describe('TaskHeader — subtask progress bar', () => {
    it('renders a Progress bar with the tally when a plan is running', () => {
        const el = mount({ status: 'running', progress: { done: 2, total: 5 } });
        const bar = el.querySelector('.mdh-progress');
        expect(bar).not.toBe(null);
        expect(bar.querySelector('.mdh-ctx-pct').textContent).toBe('2/5');
        expect(bar.querySelector('.mdh-ctx-fill').style.width).toBe('40%');
    });

    it('adds a checkmark when every subtask is complete', () => {
        const el = mount({ status: 'running', progress: { done: 5, total: 5 } });
        expect(el.querySelector('.mdh-progress .mdh-ctx-pct').textContent).toBe('5/5 ✓');
    });

    it('hides the bar for a single-step or empty plan', () => {
        const one = mount({ status: 'running', progress: { done: 1, total: 1 } });
        expect(one.querySelector('.mdh-progress')).toBe(null);
        cleanup();
        const none = mount({ status: 'running', progress: null });
        expect(none.querySelector('.mdh-progress')).toBe(null);
    });
});
