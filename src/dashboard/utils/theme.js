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
import { t } from '../../i18n/index.js';

export const THEMES = ['light', 'dark', 'paper', 'paper-subtle', 'bamboo-ancient', 'kakejiku'];

/**
 * The catalogue key for each theme's name and its one-line description.
 *
 * Held as KEYS rather than as text: the picker is chrome like everything else,
 * and it used to be the one place in the app that stayed Japanese whatever the
 * user had chosen — "Memory" beside 「知っていること」 in the same row.
 */
const META = {
    light:            { label: 'theme.light',       hint: 'theme.light.hint' },
    dark:             { label: 'theme.dark',        hint: 'theme.dark.hint' },
    paper:            { label: 'theme.paper',       hint: 'theme.paper.hint' },
    'paper-subtle':   { label: 'theme.paperSubtle', hint: 'theme.paperSubtle.hint' },
    'bamboo-ancient': { label: 'theme.bamboo',      hint: 'theme.bamboo.hint' },
    kakejiku:         { label: 'theme.kakejiku',    hint: 'theme.kakejiku.hint' },
};

/** Anything unrecognised (or absent) falls back to the shipped default. */
export function normalizeTheme(theme) {
    return THEMES.includes(theme) ? theme : 'light';
}

/** [{ id, label, hint }] in picker order. */
export function themeList() {
    return THEMES.map(id => ({ id, label: t(META[id].label), hint: t(META[id].hint) }));
}

export function themeLabel(theme) {
    return t(META[normalizeTheme(theme)].label);
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
