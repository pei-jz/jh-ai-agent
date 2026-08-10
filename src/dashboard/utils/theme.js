// theme — which themes exist, and what the toggle does next.
//
// Extracted from main.js so the cycle has a testable contract. main.js keeps the
// parts that touch the world (localStorage, the <html> attribute, the button).
//
// Dark is the token DEFAULT in dashboard.css, so it is the one theme expressed
// by the ABSENCE of `data-theme` — see themeAttr().

/** In cycle order. The two paper variants are ported from JHEditor / the Task app. */
export const THEMES = ['light', 'dark', 'paper', 'paper-subtle'];

const NEXT = { light: 'dark', dark: 'paper', paper: 'paper-subtle', 'paper-subtle': 'light' };
// The button shows the theme you would switch TO, not the one you are in.
const ICON = { light: 'moon', dark: 'paper', paper: 'template', 'paper-subtle': 'sun' };
const LABEL = {
    light: 'ダークモードへ / Switch to dark',
    dark: 'ペーパーへ / Switch to paper',
    paper: 'ペーパー(Subtle)へ / Switch to paper (subtle)',
    'paper-subtle': 'ライトモードへ / Switch to light',
};

/** Anything unrecognised (or absent) falls back to the shipped default. */
export function normalizeTheme(theme) {
    return THEMES.includes(theme) ? theme : 'light';
}

export function nextTheme(theme) {
    return NEXT[normalizeTheme(theme)];
}

export function themeIcon(theme) {
    return ICON[normalizeTheme(theme)];
}

export function themeLabel(theme) {
    return LABEL[normalizeTheme(theme)];
}

/**
 * The value for `<html data-theme>`.
 * @returns {string|null} null means "remove the attribute" — dark is the default
 *   the stylesheet already expresses, so it must not be named.
 */
export function themeAttr(theme) {
    const t = normalizeTheme(theme);
    return t === 'dark' ? null : t;
}
