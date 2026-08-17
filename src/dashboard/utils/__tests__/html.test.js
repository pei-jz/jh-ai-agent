// The one escaper, and the URL vetting that renderMarkdown depends on.
//
// There were nine escapeHtml/esc definitions with four behaviours. The one in
// components/SlashCommands.js escaped only `& < >` and its output went into
// double-quoted attributes, so a skill file named `x" onmouseover="…` escaped the
// attribute. These tests pin the merged behaviour.
//
// Why it matters more here than in a normal web app: `withGlobalTauri` is on, so
// script running in this page reaches `window.__TAURI__.core.invoke` and through
// it the filesystem and the shell.

import { describe, it, expect } from 'vitest';
import { escapeHtml, esc, safeUrl } from '../html.js';

describe('escapeHtml', () => {
    it('escapes all five metacharacters', () => {
        expect(escapeHtml(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#039;');
    });

    it('escapes & FIRST so entities are not double-escaped', () => {
        expect(escapeHtml('<')).toBe('&lt;');
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    it('closes the SlashCommands hole: quotes cannot escape an attribute', () => {
        const hostile = 'x" onmouseover="alert(1)';
        const attr = `<span title="${escapeHtml(hostile)}">`;
        expect(attr).not.toContain('onmouseover="alert');
        expect(attr).toContain('&quot;');
    });

    it('escapes single quotes too — call sites use both quote styles', () => {
        const attr = `<span title='${escapeHtml("x' onclick='bad()")}'>`;
        expect(attr).not.toContain("onclick='bad");
    });

    it('treats null and undefined as empty', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('keeps 0 and false rather than blanking them', () => {
        expect(escapeHtml(0)).toBe('0');
        expect(escapeHtml(false)).toBe('false');
    });

    it('esc is the same function', () => {
        expect(esc).toBe(escapeHtml);
    });
});

describe('safeUrl', () => {
    it('passes ordinary web links through unchanged', () => {
        for (const u of [
            'https://example.com/a?b=1&c=2',
            'http://example.com',
            'mailto:someone@example.com',
            'file:///C:/work/report.xlsx',
        ]) {
            expect(safeUrl(u)).toBe(u);
        }
    });

    it('passes relative and same-document links through', () => {
        for (const u of ['#section', '/api/tasks', './a.md', '../b.md', '//cdn.example.com/x']) {
            expect(safeUrl(u)).toBe(u);
        }
    });

    it('refuses javascript: — the one that reaches window.__TAURI__', () => {
        expect(safeUrl('javascript:alert(1)')).toBe('#');
        expect(safeUrl('JavaScript:alert(1)')).toBe('#');
        expect(safeUrl('  javascript:alert(1)')).toBe('#');
    });

    it('refuses javascript: hidden by control characters or entities', () => {
        // Browsers ignore both when resolving the scheme, so a naive regex on the
        // raw string lets them through.
        expect(safeUrl('java\tscript:alert(1)')).toBe('#');
        expect(safeUrl('java\nscript:alert(1)')).toBe('#');
        expect(safeUrl('java&#0;script:alert(1)')).toBe('#');
        expect(safeUrl('java&#x0;script:alert(1)')).toBe('#');
    });

    it('refuses data: and vbscript:', () => {
        expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
        expect(safeUrl('vbscript:msgbox(1)')).toBe('#');
    });

    it('refuses a scheme nobody has thought of (allow-list, not deny-list)', () => {
        expect(safeUrl('chrome://settings')).toBe('#');
        expect(safeUrl('tauri://localhost')).toBe('#');
    });

    it('is # for empty input', () => {
        expect(safeUrl('')).toBe('#');
        expect(safeUrl(null)).toBe('#');
        expect(safeUrl(undefined)).toBe('#');
    });
});
