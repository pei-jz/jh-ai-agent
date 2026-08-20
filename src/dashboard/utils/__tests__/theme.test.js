import { describe, it, expect } from 'vitest';
import { THEMES, normalizeTheme, nextTheme, themeIcon, themeLabel, themeAttr } from '../theme.js';

describe('the theme cycle', () => {
    it('visits every theme and returns to the start', () => {
        const seen = [];
        let t = 'light';
        for (let i = 0; i < THEMES.length; i++) { seen.push(t); t = nextTheme(t); }
        expect(seen).toEqual(['light', 'dark', 'paper', 'paper-subtle', 'bamboo-ancient']);
        expect(t).toBe('light');          // back where it began
    });

    it('never leaves the known set, whatever it is handed', () => {
        for (const junk of ['', null, undefined, 'sepia', 42]) {
            expect(THEMES).toContain(nextTheme(junk));
        }
    });
});

describe('normalizeTheme', () => {
    it('passes a known theme through', () => {
        for (const t of THEMES) expect(normalizeTheme(t)).toBe(t);
    });

    it('falls back to the shipped default for anything else', () => {
        expect(normalizeTheme('sepia')).toBe('light');
        expect(normalizeTheme(undefined)).toBe('light');
    });
});

describe('themeAttr', () => {
    it('names every theme except the default', () => {
        expect(themeAttr('light')).toBe('light');
        expect(themeAttr('paper')).toBe('paper');
        expect(themeAttr('paper-subtle')).toBe('paper-subtle');
        expect(themeAttr('bamboo-ancient')).toBe('bamboo-ancient');
    });

    it('returns null for DARK — the stylesheet default must stay unnamed', () => {
        // dashboard.css declares dark on `:root`; writing data-theme="dark" would
        // match no rule at all.
        expect(themeAttr('dark')).toBe(null);
    });
});

describe('the button reflects where you would GO, not where you are', () => {
    it('offers the next theme\'s glyph', () => {
        expect(themeIcon('light')).toBe('moon');            // → dark
        expect(themeIcon('dark')).toBe('paper');            // → paper
        expect(themeIcon('paper')).toBe('template');        // → paper (subtle)
        expect(themeIcon('paper-subtle')).toBe('bamboo');   // → bamboo (ancient)
        expect(themeIcon('bamboo-ancient')).toBe('sun');    // → light
    });

    it('labels every theme, and the label names the destination', () => {
        expect(themeLabel('light')).toMatch(/dark/i);
        expect(themeLabel('dark')).toMatch(/paper/i);
        expect(themeLabel('paper')).toMatch(/subtle/i);
        expect(themeLabel('paper-subtle')).toMatch(/bamboo/i);
        expect(themeLabel('bamboo-ancient')).toMatch(/light/i);
    });

    it('has an icon and a label for every theme in the cycle', () => {
        for (const t of THEMES) {
            expect(themeIcon(t)).toBeTruthy();
            expect(themeLabel(t)).toBeTruthy();
        }
    });
});
