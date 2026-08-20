import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The adopted Bamboo Slip redesign — "簡牘古文" (Bamboo-ancient),
// proposal #3 (docs/design/bamboo-slip-proposals/03-bamboo-ancient.html).
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

describe('bamboo-ancient theme — adopted "簡牘古文" palette', () => {
    const block = themeBlock('bamboo-ancient');

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

    it('moves the background onto charred near-black bamboo slips', () => {
        expect(block).toContain('--bg-primary:   #3a2e1e;');
        expect(block).toContain('--bg-secondary: #463a26;');
        expect(block).toContain('--bg-tertiary:  #2f2518;');
        expect(block).toContain('--bg-card-solid:#463a26;');
    });

    it('keeps the card translucent so the slip texture shows through', () => {
        expect(block).toContain('--bg-card:      rgba(70, 58, 38, 0.92);');
    });

    it('uses faint ivory ink instead of grey-green', () => {
        expect(block).toContain('--text-primary:   #e8e0cc;');
        expect(block).toContain('--text-secondary: #c2b89f;');
        expect(block).toContain('--text-tertiary:  #8f8570;');
    });

    it('uses bronze-verdigris (銅青) as the accent', () => {
        expect(block).toContain('--accent:        #7fc4b8;');
        expect(block).toContain('--accent-hover:  #96d6cb;');
        expect(block).toContain('--border-focus: rgba(127, 196, 184, 0.60);');
    });

    it('uses old darkened bamboo for the borders', () => {
        expect(block).toContain('--border:       #6b5a3c;');
    });

    it('adds a bamboo slip texture for the app canvas and the result panel', () => {
        expect(block).toContain('--grain: url("data:image/svg+xml,');
        expect(block).toContain('--slip: linear-gradient(180deg,');
        expect(css).toMatch(/:root\[data-theme="bamboo-ancient"\] body \{/);
        expect(css).toMatch(/:root\[data-theme="bamboo-ancient"\] #result-panel \{/);
    });

    it('keeps the paper-subtle theme untouched', () => {
        const paperSubtle = themeBlock('paper-subtle');
        expect(paperSubtle).toContain('--bg-primary:   #e8e2d3;');
        expect(paperSubtle).toContain('--accent:        #6d8f6f;');
    });
});
