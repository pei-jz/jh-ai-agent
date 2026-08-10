// i18n — the app's own UI language.
//
// NOT the same thing as the agent's output language. `config.output_language`
// (OUTPUT_LANGUAGES in views/config/configForm.js) tells the model what language to
// answer in; this decides what the buttons say. They are genuinely independent: a
// Japanese developer working on an English-language codebase may well want an English
// UI and Japanese answers, and conflating the two would take that away.
//
// The design goals, in order:
//   1. a missing translation must NEVER render as blank, "undefined", or a key —
//      an untranslated button that reads in the wrong language still works;
//   2. `t()` must be synchronous, because it is called from render paths;
//   3. adding a language must not mean touching call sites.
//
// Scope, honestly: the mechanism is complete and the surfaces added since it landed
// use it. The older views still hold literal strings. Migrating them is mechanical
// (see docs/design/i18n.md) and deliberately not done in one sweep — a mass
// find-and-replace across ~10k lines of view code is how you break wording that
// somebody carefully chose.

import { ja } from './messages/ja.js';
import { en } from './messages/en.js';

/** Catalogs, keyed by locale. */
export const CATALOGS = { ja, en };

/** Locales offered in the UI: [code, label in its own language]. */
export const UI_LOCALES = [
    ['ja', '日本語'],
    ['en', 'English'],
];

/**
 * The last-resort locale.
 *
 * Japanese, not English: this app's strings were written in Japanese first, so `ja`
 * is the catalog most likely to actually have a given key. Falling back to the more
 * complete catalog produces fewer visible holes.
 */
export const FALLBACK_LOCALE = 'ja';

const STORAGE_KEY = 'jhai_ui_locale';

let locale = FALLBACK_LOCALE;
/** Called after a locale change so views can re-render. */
const listeners = new Set();

/** Is `code` a locale we ship a catalog for? */
export function isSupportedLocale(code) {
    return Object.prototype.hasOwnProperty.call(CATALOGS, String(code || ''));
}

/**
 * Pick a locale from a browser language tag.
 *
 * Matches on the primary subtag, so `en-GB`, `en_US` and `EN` all land on `en`.
 * Anything we do not ship falls back rather than showing an empty UI.
 */
export function normalizeLocale(tag) {
    const primary = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
    return isSupportedLocale(primary) ? primary : FALLBACK_LOCALE;
}

/**
 * Decide the starting locale: an explicit choice wins over the OS.
 *
 * @param {{stored?: string, navigatorLanguages?: string[]}} opts
 */
export function detectLocale({ stored = '', navigatorLanguages = [] } = {}) {
    if (isSupportedLocale(stored)) return stored;
    for (const tag of navigatorLanguages) {
        const primary = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
        if (isSupportedLocale(primary)) return primary;
    }
    return FALLBACK_LOCALE;
}

/**
 * Substitute {placeholders}. An unknown placeholder is left as-is rather than
 * blanked, so a mismatch between a catalog and a call site is visible in testing
 * instead of silently deleting words.
 */
export function interpolate(template, params) {
    const s = String(template ?? '');
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
    ));
}

/**
 * Look up a key, following the fallback chain.
 *
 * Chain: requested locale -> FALLBACK_LOCALE -> the supplied default -> the key.
 * The last step is the important one: it guarantees `t()` returns something
 * printable no matter how wrong the arguments were.
 */
export function lookup(key, loc, fallbackText = '') {
    const k = String(key || '');
    const hit = CATALOGS[loc]?.[k];
    if (typeof hit === 'string') return hit;

    const fb = CATALOGS[FALLBACK_LOCALE]?.[k];
    if (typeof fb === 'string') return fb;

    return fallbackText || k;
}

/**
 * Translate.
 *
 * @param {string} key dotted id, e.g. 'update.available'
 * @param {object} [params] {placeholder: value}
 * @param {string} [fallbackText] shown when no catalog has the key — pass the
 *        original literal while migrating a view so the UI never regresses to a key
 */
export function t(key, params = null, fallbackText = '') {
    return interpolate(lookup(key, locale, fallbackText), params);
}

/** The active locale. */
export function getLocale() {
    return locale;
}

/**
 * Change the locale and persist it.
 *
 * Returns the locale actually in use, which may differ from what was asked for —
 * callers should render from the return value rather than assume.
 */
export function setLocale(next) {
    const resolved = normalizeLocale(next);
    if (resolved === locale) return locale;
    locale = resolved;
    try { localStorage.setItem(STORAGE_KEY, resolved); } catch (_) { /* private mode */ }
    for (const fn of listeners) {
        // One listener throwing must not stop the rest of the app from re-rendering.
        try { fn(resolved); } catch (e) { console.warn('locale listener failed:', e); }
    }
    return locale;
}

/** Run `fn` after every locale change. Returns an unsubscribe. */
export function onLocaleChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Read the stored choice at boot. Called once by main.js. */
export function initLocale() {
    let stored = '';
    try { stored = localStorage.getItem(STORAGE_KEY) || ''; } catch (_) {}
    const langs = typeof navigator !== 'undefined'
        ? (navigator.languages || [navigator.language]).filter(Boolean)
        : [];
    locale = detectLocale({ stored, navigatorLanguages: langs });
    return locale;
}

/** Test seam: force a locale without touching storage or notifying listeners. */
export function __setLocaleForTest(next) {
    locale = normalizeLocale(next);
}
