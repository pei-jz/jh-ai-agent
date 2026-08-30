// theme — the set, and how one is chosen.
//
// This replaced a CYCLE (one titlebar button that advanced to the next theme).
// With five themes that meant up to four presses and four full repaints to
// reach the one you wanted, and the button could only ever name the NEXT theme
// — never the current one. What is asserted now is the list contract the picker
// is built from.

import { describe, it, expect } from 'vitest';
import { THEMES, themeList, themeLabel, themeAttr, normalizeTheme } from '../theme.js';

describe('the set', () => {
    it('lists every theme once', () => {
        expect(new Set(THEMES).size).toBe(THEMES.length);
    });

    it('includes the two plain ones and the textured family', () => {
        expect(THEMES).toEqual(
            ['light', 'dark', 'paper', 'paper-subtle', 'bamboo-ancient', 'kakejiku']);
    });

    // The picker shows both, so a theme with neither would render a blank row.
    it('gives every theme a name and a one-line hint', () => {
        for (const t of themeList()) {
            expect(t.label, `${t.id} has no label`).toBeTruthy();
            expect(t.hint, `${t.id} has no hint`).toBeTruthy();
        }
    });

    it('lists them in THEMES order', () => {
        expect(themeList().map(t => t.id)).toEqual(THEMES);
    });
});

describe('normalizeTheme', () => {
    it('passes a known theme through', () => {
        for (const t of THEMES) expect(normalizeTheme(t)).toBe(t);
    });

    // A stale localStorage value from an older build must not leave the app
    // with an attribute no stylesheet answers to.
    it.each([undefined, null, '', 'nope', 42, {}])('falls back for %p', (v) => {
        expect(normalizeTheme(v)).toBe('light');
    });
});

describe('themeAttr', () => {
    // Dark is what the bare `:root` block already expresses, so naming it would
    // be a second source of truth for the same palette.
    it('is null for dark — the default is the ABSENCE of the attribute', () => {
        expect(themeAttr('dark')).toBeNull();
    });

    it('is the id for every other theme', () => {
        for (const t of THEMES.filter(x => x !== 'dark')) {
            expect(themeAttr(t)).toBe(t);
        }
    });

    it('normalises before answering', () => {
        expect(themeAttr('nope')).toBe('light');
    });
});

describe('themeLabel', () => {
    it('names the theme you are IN', () => {
        // The button carries this; a cycle could only name where you would go.
        expect(themeLabel('paper')).toBe('古紙');
        expect(themeLabel('kakejiku')).toBe('掛け軸');
    });

    it('never throws on an unknown value', () => {
        expect(themeLabel('nope')).toBe(themeLabel('light'));
    });
});
