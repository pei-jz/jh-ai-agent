import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The adopted Paper (Subtle) redesign — "和紙と墨" (Washi & Ink),
// proposal #2 (docs/design/paper-subtle-proposals/02-washi-ink.html).
// The design tokens are static CSS; the tests pin the values so a future
// theme tweak cannot silently drift away from the agreed palette.

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '../dashboard.css');
const css = readFileSync(cssPath, 'utf8');

// Extract the custom-property block of one theme.
function themeBlock(theme) {
    const start = css.indexOf(`:root[data-theme="${theme}"]`);
    expect(start).toBeGreaterThan(-1); // theme must exist in the stylesheet
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

describe('paper-subtle theme — adopted "Washi & Ink" palette', () => {
    const block = themeBlock('paper-subtle');

    it('defines every token the components rely on', () => {
        const tokens = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card',
            '--bg-card-solid', '--bg-input', '--bg-hover',
            '--text-primary', '--text-secondary', '--text-tertiary', '--text-inverse',
            '--accent', '--accent-hover', '--accent-dim', '--accent-glow', '--accent-glow-lg',
            '--border', '--border-light', '--border-focus',
            '--success', '--success-bg', '--warning', '--warning-bg',
            '--error', '--error-bg', '--info', '--info-bg',
            '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-glow',
            '--paper-rule-color', '--paper-rule-size', '--paper-margin-color', '--font-hand'];
        for (const t of tokens) expect(block).toContain(`${t}:`);
    });

    it('moves the background off the old "too white" cream onto unbleached washi', () => {
        expect(block).toContain('--bg-primary:   #e8e2d3;');
        expect(block).toContain('--bg-secondary: #f2ecdc;');
        expect(block).toContain('--bg-tertiary:  #dcd4c0;');
        expect(block).toContain('--bg-card-solid:#f2ecdc;');
    });

    it('keeps the card translucent so the washi shows through', () => {
        expect(block).toContain('--bg-card:      rgba(242, 236, 220, 0.92);');
    });

    it('uses ink-black text instead of grey-green', () => {
        expect(block).toContain('--text-primary:   #2f2b24;');
        expect(block).toContain('--text-secondary: #6d6759;');
        expect(block).toContain('--text-tertiary:  #98917f;');
    });

    it('swaps the terracotta accent for mossy verdigris (緑青)', () => {
        expect(block).toContain('--accent:        #6d8f6f;');
        expect(block).toContain('--accent-hover:  #567457;');
        expect(block).toContain('--border-focus: rgba(109, 143, 111, 0.55);');
    });

    it('sharpens the borders to rattan', () => {
        expect(block).toContain('--border:       #cfc5a9;');
    });

    it('adds a faint washi fibre grain for body / cards / result panel', () => {
        expect(block).toContain('--grain: url("data:image/svg+xml,');
        expect(css).toMatch(/background-image:\s*var\(--grain,\s*none\);/);          // body + .card
        expect(css).toMatch(/:root\[data-theme="paper-subtle"\] #result-panel \{/);  // reading surface
    });

    it('keeps the paper theme untouched (only paper-subtle changed)', () => {
        const paper = themeBlock('paper');
        expect(paper).toContain('--bg-primary:   #e7dab9;');
        expect(paper).toContain('--accent:        #b23a48;');
    });
});
