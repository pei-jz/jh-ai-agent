// theme — which themes exist, and how they are chosen.
//
// It used to be a CYCLE: one titlebar button that advanced to the next theme.
// With five that meant up to four clicks (and four full repaints) to reach the
// one you wanted, and the button could not say where you were — only where the
// next press would take you. A list you pick from does both, and it stops the
// cost of a new theme being "one more press for everyone else".
//
// Extracted from main.js so the set has a testable contract. main.js keeps the
// parts that touch the world (localStorage, the <html> attribute, the menu).
//
// Dark is the token DEFAULT in dashboard.css, so it is the one theme expressed
// by the ABSENCE of `data-theme` — see themeAttr().

/**
 * Every theme, in the order the picker lists them: the two plain ones first,
 * then the textured family (ported from JHEditor / the Task app) grouped
 * together, because that is how someone browsing them thinks about the set.
 */
export const THEMES = ['light', 'dark', 'paper', 'paper-subtle', 'bamboo-ancient', 'kakejiku'];

/** Display name and one line of what it is, for the picker. */
const META = {
    light:            { label: 'ライト',       hint: '既定。白地に violet' },
    dark:             { label: 'ダーク',       hint: '暗所向け。cyan' },
    paper:            { label: '古紙',         hint: '罫のある紙。臙脂' },
    'paper-subtle':   { label: '白紙',         hint: '白い紙に苔緑' },
    'bamboo-ancient': { label: '竹簡',         hint: '焦げ竹の簡。銅青' },
    kakejiku:         { label: '掛け軸',       hint: '絹本の軸装。藍' },
};

/** Anything unrecognised (or absent) falls back to the shipped default. */
export function normalizeTheme(theme) {
    return THEMES.includes(theme) ? theme : 'light';
}

/** [{ id, label, hint }] in picker order. */
export function themeList() {
    return THEMES.map(id => ({ id, ...META[id] }));
}

export function themeLabel(theme) {
    return META[normalizeTheme(theme)].label;
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
