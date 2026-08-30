// 竹簡 (bamboo-ancient) — the adopted "簡牘古文" palette.
//
// The design tokens are static CSS, so the values are pinned here: a later theme
// tweak cannot silently drift away from the agreed palette.
//
// Rewritten after the visual pass (docs/design/visual-language.md): the token
// names are role-based now, the card is opaque, and the slip texture reaches the
// app through `--texture-app` rather than through a rule that names this app's
// element ids.

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

describe('竹簡 — charred bamboo slips', () => {
    const block = themeBlock('bamboo-ancient');

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

    it('moves the background onto charred near-black bamboo slips', () => {
        expect(block).toContain('--surface-app:   #3a2e1e;');
        expect(block).toContain('--surface-panel: #463a26;');
        expect(block).toContain('--surface-sunken:  #2f2518;');
    });

    // Opaque, since the visual pass: a translucent card's contrast depends on
    // what is behind it, and that differs in every theme (visual-language.md §1).
    it('keeps the card opaque', () => {
        expect(block).toMatch(/--surface-raised:\s*#463a26;/);
        expect(block).not.toMatch(/--surface-raised:\s*rgba/);
    });

    it('writes in faint ivory ink', () => {
        expect(block).toContain('--ink:   #e8e0cc;');
        expect(block).toContain('--ink-soft: #c2b89f;');
        expect(block).toContain('--ink-faint:  #8f8570;');
    });

    it('accents with 銅青 (bronze verdigris)', () => {
        expect(block).toContain('--accent:        #7fc4b8;');
    });

    it('borders in aged cord', () => {
        expect(block).toContain('--line:       #6b5a3c;');
    });

    // The theme supplies the IMAGE; the app decides where it goes, once. A theme
    // block that names an element id is what made porting a theme a CSS-writing
    // job — visual-language.md §5.
    it('supplies its texture as tokens, not as rules', () => {
        expect(block).toContain('--grain: url("data:image/svg+xml,');
        expect(block).toContain('--slip: linear-gradient(180deg,');
        // On the CHROME only. The slats are 40px of high-contrast vertical
        // banding — fine behind a title, hard to read a task list or a result
        // through — so the pattern stays on the binding at the top and the
        // palette carries the theme everywhere else.
        expect(block).toContain('--texture-chrome: var(--grain), var(--slip);');
        expect(block).toMatch(/--texture-app:\s*none;/);
        expect(block).toMatch(/--texture-read:\s*none;/);
        expect(css).not.toMatch(/:root\[data-theme="bamboo-ancient"\]\s+[.#]/);
    });

    it('leaves the other themes alone', () => {
        const paperSubtle = themeBlock('paper-subtle');
        expect(paperSubtle).toContain('--surface-app:   #f4f3ef;');
        expect(paperSubtle).toMatch(/--accent:\s*#5f8f6a;/);
    });
});
