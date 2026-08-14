// @vitest-environment jsdom
//
// Inspector — the first component of the Svelte migration.
//
// These replace the string-builder tests that used to live in
// views/monitor/__tests__/inspector.test.js. Every behaviour asserted there is
// asserted here, against a MOUNTED component, plus the things a string builder
// could not be asked about at all: that a click actually reaches a callback, and
// that a prop change updates the DOM in place.
//
// The calculations (cache accounting, cost, tree shaping) stay unit-tested as
// pure functions next to their implementation — that file keeps its table-driven
// checks and needs no DOM.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Inspector from '../Inspector.svelte';

afterEach(() => cleanup());

const task = { id: 'a1f2c3d4e5', caller: 'IDE', status: 'running', started_at: '2026-07-29T02:14:08Z' };
const withWs = { ...task, workspace_path: 'C:/proj' };

/** Mount and hand back the container, for plain textContent/query assertions. */
const mountInsp = (props = {}) => render(Inspector, { props: { task, ...props } }).container;

describe('Inspector — task facts', () => {
    it('shows the facts you would otherwise hunt for', () => {
        const el = mountInsp({ stats: { steps: 6, durationMs: 18400 } });
        const text = el.textContent;
        expect(text).toContain('#a1f2c3d4');      // id, shortened
        expect(text).toContain('IDE');
        expect(text).toContain('18s');            // elapsed
    });

    it('NO LONGER repeats Status / Started / Steps — the task list carries them', () => {
        // The left panel already shows the status dot, the start time and the
        // progress; a reference column repeating them was pure height.
        const el = mountInsp({ stats: { steps: 6, durationMs: 18400 } });
        const text = el.textContent;
        expect(text).not.toContain('Status');
        expect(text).not.toContain('Started');
        expect(text).not.toContain('Steps');
        // And no accidental timestamps either.
        expect(text).not.toContain('2026-07-29 02:14:08');
    });

    it('omits rows it has no value for', () => {
        const el = mountInsp({ task: { id: 'x' } });
        expect(el.textContent).not.toContain('Caller');
        expect(el.textContent).not.toContain('Elapsed');
    });

    it('renders nothing at all without a task', () => {
        expect(render(Inspector, { props: { task: null } }).container.textContent.trim()).toBe('');
    });

    it('escapes hostile values — the compiler does this now, not a helper', () => {
        // The old renderer called esc() by hand at each interpolation, which is a
        // thing you can forget. Here it is structural.
        const el = mountInsp({ task: { id: 'x', caller: '<script>alert(1)</script>' } });
        expect(el.querySelector('script')).toBe(null);
        expect(el.textContent).toContain('<script>alert(1)</script>');
    });

    it('escapes a hostile FILE PATH too', () => {
        const el = mountInsp({ task: withWs, files: [{ path: '"><img src=x>', action: 'created' }] });
        expect(el.querySelector('img')).toBe(null);
    });
});

describe('Inspector — token flow', () => {
    it('renders totals in readable units', () => {
        const el = mountInsp({ usage: { prompt_tokens: 9800, completion_tokens: 2600, total_tokens: 12400 } });
        expect(el.textContent).toContain('9.8k');
        expect(el.textContent).toContain('2.6k');
        expect(el.textContent).toContain('12.4k');
    });

    it('mentions cache ONLY when caching did something', () => {
        expect(mountInsp({ usage: { prompt_tokens: 100 } }).textContent).not.toContain('Cached');
        cleanup();
        expect(mountInsp({ usage: { cache_read_input_tokens: 2100 } }).textContent).toContain('Cached');
    });

    it('says the section is per step, and draws the chart, when there IS per-step data', () => {
        const el = mountInsp({ usage: { total_tokens: 12400 }, perStep: [100, 200, 300] });
        expect(el.textContent).toContain('Token usage (per step)');
        expect(el.querySelector('.insp-spark')).not.toBe(null);
    });

    it('falls back to plain totals with no per-step data', () => {
        const el = mountInsp({ usage: { total_tokens: 12400 } });
        expect(el.textContent).toContain('Token usage');
        expect(el.querySelector('.insp-spark')).toBe(null);
    });
});

describe('Inspector — cost', () => {
    const usage = { prompt_tokens: 1_000_000, cache_read_input_tokens: 900_000, completion_tokens: 100_000, total_tokens: 1_100_000 };
    const rates = { input_per_1m: 3, cache_read_per_1m: 0.3, output_per_1m: 15 };

    it('puts the money next to the tokens it prices', () => {
        const el = mountInsp({ usage, rates });
        expect(el.textContent).toContain('In (fresh)');
        expect(el.textContent).toContain('$0.300');   // the uncached input
        expect(el.textContent).toContain('$2.07');    // the run total
    });

    it('reports the input as the part that MISSED the cache', () => {
        expect(mountInsp({ usage, rates }).textContent).toContain('100.0k');
    });

    it('omits the cost column entirely when rates are unknown', () => {
        const el = mountInsp({ usage });
        expect(el.querySelector('.insp-cost')).toBe(null);
        expect(el.textContent).toContain('100.0k');   // the tokens still show
    });
});

describe('Inspector — workspace', () => {
    it('shows the path; it moved here out of the header', () => {
        const el = mountInsp({ task: { ...task, workspace_path: 'C:/cusor_workspace/jh-ai-agent' } });
        expect(el.textContent).toContain('Workspace');
        expect(el.textContent).toContain('C:/cusor_workspace/jh-ai-agent');
    });

    it('says so rather than showing an empty row', () => {
        expect(mountInsp().textContent).toContain('no workspace');
    });
});

describe('Inspector — changed files as a tree', () => {
    const files = [
        { path: 'C:/proj/src/dashboard/a.js', action: 'modified' },
        { path: 'C:/proj/src/dashboard/b.js', action: 'created' },
        { path: 'C:/proj/docs/r.md', action: 'read' },
    ];

    it('groups files under their directory rather than listing basenames', () => {
        const el = mountInsp({ task: withWs, files });
        const dirs = [...el.querySelectorAll('.insp-tree-n')].map(d => d.textContent.trim());
        expect(dirs).toContain('src/dashboard');   // single-child chain collapsed
        expect(dirs).toContain('docs');
    });

    it('counts the files in a directory, so a FOLDED one still says something', () => {
        const el = mountInsp({ task: withWs, files });
        const counts = [...el.querySelectorAll('.insp-tree-dir')].map(d => ({
            name: d.querySelector('.insp-tree-n').textContent.trim(),
            count: d.querySelector('.insp-tree-count').textContent.trim(),
        }));
        expect(counts).toEqual(expect.arrayContaining([
            { name: 'src/dashboard', count: '2' },
            { name: 'docs', count: '1' },
        ]));
    });

    it('starts OPEN — the common case is a handful of files', () => {
        // Hiding those behind a click would be pure friction.
        const el = mountInsp({ task: withWs, files });
        expect(el.querySelectorAll('.insp-tree-file')).toHaveLength(3);
        expect(el.querySelector('.insp-tree-dir').getAttribute('aria-expanded')).toBe('true');
    });

    it('FOLDS a directory on click, hiding only its own files', async () => {
        const el = mountInsp({ task: withWs, files });
        const rows = [...el.querySelectorAll('.insp-tree-dir')];
        const docs = rows.find(r => r.querySelector('.insp-tree-n').textContent.trim() === 'docs');
        docs.click();
        await tick();
        expect(docs.getAttribute('aria-expanded')).toBe('false');
        expect(docs.classList.contains('is-closed')).toBe(true);
        // docs held one file; the other two are still there.
        expect(el.querySelectorAll('.insp-tree-file')).toHaveLength(2);
    });

    it('unfolds again', async () => {
        const el = mountInsp({ task: withWs, files });
        const dir = el.querySelector('.insp-tree-dir');
        dir.click();
        await tick();
        dir.click();
        await tick();
        expect(dir.getAttribute('aria-expanded')).toBe('true');
        expect(el.querySelectorAll('.insp-tree-file')).toHaveLength(3);
    });

    it('makes the directory row a real button, so folding is keyboard reachable', () => {
        expect(mountInsp({ task: withWs, files }).querySelector('.insp-tree-dir').tagName)
            .toBe('BUTTON');
    });

    it('keeps the openable path on each row and marks writes', () => {
        const el = mountInsp({ task: withWs, files });
        expect(el.querySelector('[data-open-path="C:/proj/src/dashboard/a.js"]')).not.toBe(null);
        expect(el.querySelectorAll('.ui-icon-edit').length).toBe(2);   // modified + created
        expect(el.querySelectorAll('.ui-icon-file').length).toBe(1);   // read
    });

    it('makes each file row a real button, so it is keyboard reachable', () => {
        // The old markup was a <div> with a delegated click handler — unfocusable
        // no matter what CSS said.
        const el = mountInsp({ task: withWs, files });
        const row = el.querySelector('[data-open-path]');
        expect(row.tagName).toBe('BUTTON');
    });

    it('caps a huge list and says what it withheld', () => {
        const many = Array.from({ length: 260 }, (_, i) => ({ path: `C:/proj/f${i}.js`, action: 'modified' }));
        const el = mountInsp({ task: withWs, files: many });
        expect(el.querySelectorAll('[data-open-path]').length).toBe(200);
        expect(el.textContent).toContain('260');        // the count stays honest
        expect(el.textContent).toContain('+60 more');
    });

    it('shows no files section when nothing was touched', () => {
        const el = mountInsp({ task: withWs, files: [] });
        expect(el.textContent).not.toContain('Changed files');
    });

    it('a click hands the REAL path to the callback', () => {
        const onOpenFile = vi.fn();
        const el = mountInsp({ task: withWs, files, onOpenFile });
        el.querySelector('[data-open-path="C:/proj/docs/r.md"]').click();
        expect(onOpenFile).toHaveBeenCalledWith('C:/proj/docs/r.md');
    });
});

describe('Inspector — chapters', () => {
    const chapters = [
        { id: 'i1', kind: 'request', label: 'Request · refactor the dashboard' },
        { id: 'i5', kind: 'deliverable', label: 'Deliverable · everything moved' },
    ];

    it('renders a jump target per chapter', () => {
        const el = mountInsp({ chapters });
        expect(el.querySelector('[data-chap="i5"]').textContent).toContain('everything moved');
        expect(el.querySelector('.insp-chap-deliverable')).not.toBe(null);
        expect(el.querySelector('.insp-chap-request')).not.toBe(null);
    });

    it('marks the active one', () => {
        const el = mountInsp({ chapters, activeChapter: 'i5' });
        expect(el.querySelector('[data-chap="i5"]').classList.contains('is-active')).toBe(true);
        expect(el.querySelector('[data-chap="i1"]').classList.contains('is-active')).toBe(false);
    });

    it('stays silent when there is nothing to navigate — one chapter is not a TOC', () => {
        expect(mountInsp({ chapters: [chapters[0]] }).textContent).not.toContain('Chapters');
        cleanup();
        expect(mountInsp({ chapters: [] }).textContent).not.toContain('Chapters');
    });

    it('a click reports the chapter id', () => {
        const onChapter = vi.fn();
        const el = mountInsp({ chapters, onChapter });
        el.querySelector('[data-chap="i5"]').click();
        expect(onChapter).toHaveBeenCalledWith('i5');
    });
});

describe('Inspector — actions', () => {
    it('offers the workspace actions only when there IS a workspace', () => {
        const el = mountInsp({ task: withWs });
        for (const a of ['workspace', 'instructions', 'copy']) {
            expect(el.querySelector(`[data-insp-act="${a}"]`)).not.toBe(null);
        }
    });

    it('hides the dead ones on an MCP / research task', () => {
        const el = mountInsp();
        expect(el.querySelector('[data-insp-act="copy"]')).not.toBe(null);
        expect(el.querySelector('[data-insp-act="workspace"]')).toBe(null);
        expect(el.querySelector('[data-insp-act="instructions"]')).toBe(null);
    });

    it.each(['workspace', 'instructions', 'copy'])('reports the %s intent by name', (act) => {
        const onAction = vi.fn();
        const el = mountInsp({ task: withWs, onAction });
        el.querySelector(`[data-insp-act="${act}"]`).click();
        expect(onAction).toHaveBeenCalledWith(act);
    });
});
