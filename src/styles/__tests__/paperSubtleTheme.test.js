// 白紙 (paper-subtle) — the OTHER light theme.
//
// It began as "Washi & Ink": unbleached cream, one step lighter than 古紙. That
// is why the two read as the same theme — only the accent differed, and an
// accent cannot carry a theme on its own. The ground is white now and the moss
// accent stayed, which makes this the second LIGHT theme rather than a paler
// 古紙.
//
// The palette is asserted here so a later tweak cannot quietly walk it back
// toward cream.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../dashboard.css'), 'utf8');

function themeBlock(theme) {
    // The DECLARATION, not the first mention: the stylesheet's comments quote
    // selectors, and a bare indexOf found those first.
    const start = css.indexOf(`:root[data-theme="${theme}"] {`);
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
}

describe('白紙 — the other light theme', () => {
    const block = themeBlock('paper-subtle');

    it('defines every token the components rely on', () => {
        const tokens = [
            '--surface-app', '--surface-panel', '--surface-sunken', '--surface-raised',
            '--surface-input', '--surface-hover',
            '--ink', '--ink-soft', '--ink-faint', '--on-accent',
            '--accent', '--accent-hover', '--accent-dim', '--accent-surface',
            '--shadow-pop', '--shadow-drag',
            '--line', '--line-soft', '--line-focus',
            '--success', '--warning', '--error', '--info',
            '--font-accent',
        ];
        for (const t of tokens) expect(block, `${t} missing`).toContain(`${t}:`);
    });

    // The whole point of the change.
    it('sits on WHITE, not cream', () => {
        expect(block).toContain('--surface-panel: #fbfaf7;');
        expect(block).toMatch(/--surface-raised:\s*#ffffff;/);
        // The old cream values must not come back.
        expect(block).not.toContain('#f2ecdc');
        expect(block).not.toContain('#e8e2d3');
    });

    it('keeps the moss accent — that is what it is FOR', () => {
        expect(block).toMatch(/--accent:\s*#5f8f6a;/);
    });

    it('is visibly a different theme from 古紙', () => {
        const paper = themeBlock('paper');
        const ground = (b) => b.match(/--surface-app:\s*(\S+);/)[1];
        const accent = (b) => b.match(/--accent:\s*(\S+);/)[1];
        expect(ground(block)).not.toBe(ground(paper));
        expect(accent(block)).not.toBe(accent(paper));
    });

    it('keeps the card opaque', () => {
        expect(block).toMatch(/--surface-raised:\s*#[0-9a-f]{6};/i);
        expect(block).not.toMatch(/--surface-raised:\s*rgba/);
    });

    // 古紙 is the one with a surface; this is the plain sheet. A texture here is
    // part of what made the two look alike.
    it('has no texture at all', () => {
        expect(block).not.toContain('--texture-app:');
        expect(block).not.toContain('--texture-read:');
    });

    it('uses ink-black text', () => {
        expect(block).toMatch(/--ink:\s*#23262a;/);
    });

    it('leaves 古紙 alone', () => {
        const paper = themeBlock('paper');
        expect(paper).toContain('--surface-app:   #e7dab9;');
        expect(paper).toContain('--accent:        #b23a48;');
    });
});
