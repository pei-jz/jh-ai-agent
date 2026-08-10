import { describe, it, expect } from 'vitest';
import {
    escapeHtml, formatMessageContent, formatMarkdown, renderTableHtml
} from '../chatMarkdown.js';

describe('escapeHtml', () => {
    it('returns empty string for falsy input', () => {
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('escapes all five HTML-sensitive characters', () => {
        expect(escapeHtml(`<a href="x" data='y'>&</a>`))
            .toBe('&lt;a href=&quot;x&quot; data=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
    });

    it('escapes ampersand first (no double-escaping artifacts)', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });
});

describe('renderTableHtml', () => {
    it('builds a table with headers and rows', () => {
        const html = renderTableHtml(['A', 'B'], [['1', '2'], ['3', '4']]);
        expect(html).toContain('<th>A</th><th>B</th>');
        expect(html).toContain('<tr><td>1</td><td>2</td></tr>');
        expect(html).toContain('<tr><td>3</td><td>4</td></tr>');
        expect(html).toContain('table-wrap');
    });

    it('handles empty rows', () => {
        const html = renderTableHtml(['H'], []);
        expect(html).toContain('<th>H</th>');
        expect(html).toContain('<tbody></tbody>');
    });
});

describe('formatMarkdown', () => {
    it('returns empty for falsy', () => {
        expect(formatMarkdown('')).toBe('');
        expect(formatMarkdown(null)).toBe('');
    });

    it('escapes HTML before formatting (XSS safety)', () => {
        const out = formatMarkdown('<script>alert(1)</script>');
        expect(out).not.toContain('<script>');
        expect(out).toContain('&lt;script&gt;');
    });

    it('renders fenced code blocks with language label', () => {
        const out = formatMarkdown('```js\nconst x = 1;\n```');
        expect(out).toContain('code-block-wrapper');
        expect(out).toContain('code-block-lang');
        expect(out).toContain('language-js');
        expect(out).toContain('const x = 1;');
    });

    it('renders inline code', () => {
        const out = formatMarkdown('use `npm run build` now');
        expect(out).toContain('<code class="inline-code">npm run build</code>');
    });

    it('renders headers h1–h6', () => {
        expect(formatMarkdown('# Title')).toContain('<h1>Title</h1>');
        expect(formatMarkdown('###### Deep')).toContain('<h6>Deep</h6>');
    });

    it('renders bold and italic', () => {
        const out = formatMarkdown('**bold** and *it* and _under_');
        expect(out).toContain('<strong>bold</strong>');
        expect(out).toContain('<em>it</em>');
        expect(out).toContain('<em>under</em>');
    });

    it('wraps unordered list items in <ul>', () => {
        expect(formatMarkdown('- one\n- two')).toContain('<ul>');
    });

    it('tags ordered list items with the ol-item class', () => {
        // Pure ordered lists keep the per-item marker; the <ol> wrapper only
        // forms when a plain <li> is adjacent (faithful to the original ChatView).
        const out = formatMarkdown('1. first\n2. second');
        expect(out).toContain('first');
        expect(out).toContain('second');
        expect(out).toMatch(/<li[^>]*>first<\/li>/);
    });

    it('renders a markdown table via the table parser', () => {
        const md = '| A | B |\n| - | - |\n| 1 | 2 |';
        const out = formatMarkdown(md);
        expect(out).toContain('<th>A</th>');
        expect(out).toContain('<td>1</td>');
    });

    it('converts newlines to <br> outside block elements', () => {
        const out = formatMarkdown('line one\nline two');
        expect(out).toContain('line one<br>line two');
    });

    it('renders blockquotes (after > is escaped to &gt;)', () => {
        const out = formatMarkdown('> quoted');
        expect(out).toContain('<blockquote>quoted</blockquote>');
    });
});

describe('formatMessageContent', () => {
    it('returns empty for falsy', () => {
        expect(formatMessageContent('')).toBe('');
        expect(formatMessageContent(null)).toBe('');
    });

    it('passes through plain content via formatMarkdown when no think block', () => {
        const out = formatMessageContent('**hi**');
        expect(out).toContain('<strong>hi</strong>');
    });

    it('renders a completed think block + remaining content', () => {
        const out = formatMessageContent('before<think>reasoning</think>after');
        expect(out).toContain('Thought Process (Completed)');
        expect(out).toContain('reasoning');
        expect(out).toContain('before');
        expect(out).toContain('after');
    });

    it('renders a streaming (unclosed) think block', () => {
        const out = formatMessageContent('intro<think>still thinking');
        expect(out).toContain('Thought Process (Thinking...)');
        expect(out).toContain('thought-process-streaming');
        expect(out).toContain('still thinking');
    });
});

describe('code-block content protection', () => {
    it('does NOT transform markdown inside a fenced code block', () => {
        const md = '```markdown\n## head\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n```';
        const out = formatMarkdown(md);
        // Contents stay literal — no lists/tables/headers rendered inside <pre>
        expect(/<pre>[\s\S]*<li>/.test(out)).toBe(false);
        expect(/<pre>[\s\S]*<table>/.test(out)).toBe(false);
        expect(out).toContain('- item one');
        expect(out).toContain('| a | b |');
        expect(out).toContain('## head');
    });

    it('does not italicize/bold inside inline code', () => {
        const out = formatMarkdown('use `*args*` here');
        expect(out).toContain('<code class="inline-code">*args*</code>');
        expect(out).not.toContain('<em>args</em>');
    });

    it('numbers in normal text are unaffected by placeholder restore', () => {
        const out = formatMarkdown('version 12 and `x`');
        expect(out).toContain('version 12');
        expect(out).toContain('<code class="inline-code">x</code>');
    });

    it('markdown outside the code block still renders', () => {
        const out = formatMarkdown('- real item\n\n```js\n- fake item\n```');
        expect(out).toContain('<ul><li>real item</li></ul>');
        expect(out).toContain('- fake item');
    });
});
