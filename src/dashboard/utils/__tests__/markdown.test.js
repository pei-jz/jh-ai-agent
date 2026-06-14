import { describe, it, expect } from 'vitest';
import {
    escapeHtml, renderMarkdown, renderResultSummary, renderFileList, filesFromModified
} from '../markdown.js';

describe('escapeHtml', () => {
    it('escapes HTML metacharacters', () => {
        expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;');
    });
    it('returns empty for null/undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('renderMarkdown', () => {
    it('returns empty for falsy', () => {
        expect(renderMarkdown('')).toBe('');
    });
    it('renders headings with inline formatting', () => {
        const h = renderMarkdown('## Hello **world**');
        expect(h).toContain('<h2 class="rv-h">');
        expect(h).toContain('<strong>world</strong>');
    });
    it('renders fenced code blocks (escaped)', () => {
        const h = renderMarkdown('```js\nconst x = 1 < 2;\n```');
        expect(h).toContain('<pre class="rv-code"><code>');
        expect(h).toContain('const x = 1 &lt; 2;');
    });
    it('renders GFM tables', () => {
        const md = '| A | B |\n|---|---|\n| 1 | 2 |';
        const h = renderMarkdown(md);
        expect(h).toContain('<table class="rv-table">');
        expect(h).toContain('<th>A</th>');
        expect(h).toContain('<td>1</td>');
    });
    it('renders unordered and ordered lists', () => {
        expect(renderMarkdown('- a\n- b')).toContain('<ul class="rv-list"><li>a</li><li>b</li></ul>');
        expect(renderMarkdown('1. a\n2. b')).toContain('<ol class="rv-list"><li>a</li><li>b</li></ol>');
    });
    it('renders blockquotes and horizontal rules', () => {
        expect(renderMarkdown('> quoted')).toContain('<blockquote class="rv-quote">quoted</blockquote>');
        expect(renderMarkdown('---')).toContain('<hr class="rv-hr">');
    });
    it('renders inline code and links', () => {
        const h = renderMarkdown('see `code` and [link](https://x)');
        expect(h).toContain('<code>code</code>');
        expect(h).toContain('<a href="https://x"');
    });
    it('merges consecutive lines into a paragraph', () => {
        const h = renderMarkdown('line one\nline two');
        expect(h).toContain('<p class="rv-p">line one line two</p>');
    });
});

describe('filesFromModified', () => {
    it('derives created vs modified from original', () => {
        const out = filesFromModified([
            { path: 'a.js', original: null, current: 'x' },
            { path: 'b.js', original: 'old', current: 'new' },
        ]);
        expect(out[0]).toMatchObject({ path: 'a.js', action: 'created' });
        expect(out[1]).toMatchObject({ path: 'b.js', action: 'modified' });
    });
    it('handles empty/undefined', () => {
        expect(filesFromModified()).toEqual([]);
        expect(filesFromModified([])).toEqual([]);
    });
});

describe('renderResultSummary', () => {
    it('shows placeholder when null', () => {
        expect(renderResultSummary(null)).toContain('No result summary');
    });
    it('renders summary markdown + a file table with open-path links', () => {
        const html = renderResultSummary({
            summary: '# Done',
            files: [{ path: 'src/x.js', action: 'created', description: 'entry' }],
        });
        expect(html).toContain('<h1 class="rv-h">Done</h1>');
        expect(html).toContain('data-open-path="src/x.js"');
        expect(html).toContain('🆕 Created');
        expect(html).toContain('entry');
    });
    it('shows "なし" when there are no files', () => {
        expect(renderResultSummary({ summary: 'x', files: [] })).toContain('None');
    });
    it('renders the structured shape: answer headline + stats chips + collapsible details', () => {
        const html = renderResultSummary({
            answer: '# 回答\n\n不足データを報告',
            stats: { steps: 2, tools: { present_result: 1, finish_task: 1 }, tokens: 5200, durationMs: 20000, files: 0 },
            request: 'ご依頼テキスト',
            plan: '計画テキスト',
            files: [],
        });
        // answer section
        expect(html).toContain('rv-answer');
        expect(html).toContain('<h1 class="rv-h">回答</h1>');
        // stats chips (tool total = 2, tokens shown as k, duration in s)
        expect(html).toContain('rv-chip');
        expect(html).toContain('Steps 2');
        expect(html).toContain('Tools 2');
        expect(html).toContain('5.2k');
        // collapsible details holds request + plan
        expect(html).toContain('<details');
        expect(html).toContain('ご依頼テキスト');
        expect(html).toContain('計画テキスト');
    });
    it('prefers structured answer over flat summary when both present', () => {
        const html = renderResultSummary({ answer: 'STRUCTURED', summary: 'FLAT', files: [] });
        expect(html).toContain('STRUCTURED');
        expect(html).not.toContain('FLAT');
    });
});

describe('renderFileList', () => {
    it('returns empty string for no files', () => {
        expect(renderFileList([])).toBe('');
        expect(renderFileList(null)).toBe('');
    });
    it('renders a labelled table with file links', () => {
        const html = renderFileList([{ path: 'a/b.tsx', action: 'modified', description: 'd' }]);
        expect(html).toContain('rv-filelist');
        expect(html).toContain('data-open-path="a/b.tsx"');
        expect(html).toContain('b.tsx');
        expect(html).toContain('✏️ Modified');
    });
    it('honors a custom title', () => {
        expect(renderFileList([{ path: 'x' }], { title: 'CUSTOM' })).toContain('CUSTOM');
    });
});
