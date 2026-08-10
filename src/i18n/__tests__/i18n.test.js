// i18n — the mechanism, and the two catalogs agreeing with each other.
//
// The catalog-consistency suite at the bottom is the valuable half: a missing key or
// a dropped {placeholder} produces a sentence with a hole in it at runtime, in a
// language the author probably does not read. Better to fail here.

import { describe as suite, it, expect, afterEach } from 'vitest';
import {
    CATALOGS, UI_LOCALES, FALLBACK_LOCALE,
    isSupportedLocale, normalizeLocale, detectLocale, interpolate, lookup,
    t, getLocale, setLocale, onLocaleChange, __setLocaleForTest,
} from '../index.js';

afterEach(() => __setLocaleForTest(FALLBACK_LOCALE));

suite('locale support', () => {
    it('ships a catalog for every locale it offers', () => {
        for (const [code] of UI_LOCALES) expect(isSupportedLocale(code)).toBe(true);
    });

    it('falls back to the most complete catalog', () => {
        // ja, not en: the strings were authored in Japanese, so it has the fewest holes.
        expect(FALLBACK_LOCALE).toBe('ja');
        expect(CATALOGS[FALLBACK_LOCALE]).toBeTruthy();
    });

    it('does not mistake inherited Object properties for locales', () => {
        expect(isSupportedLocale('constructor')).toBe(false);
        expect(isSupportedLocale('toString')).toBe(false);
    });
});

suite('normalizeLocale', () => {
    const cases = [
        ['en-GB', 'en'], ['en_US', 'en'], ['EN', 'en'], ['ja-JP', 'ja'],
        // Unshipped languages must resolve to something renderable.
        ['de', 'ja'], ['', 'ja'], [null, 'ja'], ['  ja  ', 'ja'],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} -> ${expected}`, () => {
            expect(normalizeLocale(input)).toBe(expected);
        });
    }
});

suite('detectLocale', () => {
    it('prefers an explicit choice over the OS', () => {
        expect(detectLocale({ stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en');
    });

    it('uses the OS when nothing was chosen', () => {
        expect(detectLocale({ stored: '', navigatorLanguages: ['en-US', 'ja'] })).toBe('en');
    });

    it('walks past languages it does not ship', () => {
        expect(detectLocale({ navigatorLanguages: ['de-DE', 'fr', 'en-GB'] })).toBe('en');
    });

    it('ignores a stored value it no longer supports', () => {
        // e.g. a locale that was removed in an update — must not render blank.
        expect(detectLocale({ stored: 'kr', navigatorLanguages: ['en'] })).toBe('en');
    });

    it('falls back when asked with nothing', () => {
        expect(detectLocale()).toBe(FALLBACK_LOCALE);
        expect(detectLocale({})).toBe(FALLBACK_LOCALE);
    });
});

suite('interpolate', () => {
    it('substitutes named placeholders', () => {
        expect(interpolate('v{version} in {n} days', { version: '2.0', n: 3 }))
            .toBe('v2.0 in 3 days');
    });

    it('leaves an unknown placeholder visible rather than blanking it', () => {
        // A silent deletion turns "Expires on {date}" into "Expires on" and looks
        // like a wording choice instead of a bug.
        expect(interpolate('on {date}', { other: 1 })).toBe('on {date}');
    });

    it('substitutes every occurrence', () => {
        expect(interpolate('{a}-{a}', { a: 'x' })).toBe('x-x');
    });

    it('handles no params and no template', () => {
        expect(interpolate('plain')).toBe('plain');
        expect(interpolate(null, { a: 1 })).toBe('');
        expect(interpolate(undefined)).toBe('');
    });

    it('accepts falsy values as substitutions', () => {
        expect(interpolate('{n} left', { n: 0 })).toBe('0 left');
    });
});

suite('lookup and t', () => {
    it('translates from the active locale', () => {
        __setLocaleForTest('en');
        expect(t('common.save')).toBe('Save');
        __setLocaleForTest('ja');
        expect(t('common.save')).toBe('保存');
    });

    it('never renders a blank or "undefined" for a missing key', () => {
        // The core guarantee. An untranslated button in the wrong language still
        // works; an empty one does not.
        expect(t('no.such.key')).toBe('no.such.key');
        expect(t('no.such.key', null, 'Original text')).toBe('Original text');
        expect(t('')).toBe('');
        expect(t(null)).toBe('');
    });

    it('falls back to the fallback catalog for a key one locale lacks', () => {
        expect(lookup('common.save', 'de')).toBe(CATALOGS.ja['common.save']);
    });

    it('prefers the fallback catalog over the supplied default', () => {
        // A real translation beats a call site's literal, which is usually the
        // pre-migration wording.
        expect(lookup('common.save', 'de', 'SAVE')).toBe(CATALOGS.ja['common.save']);
    });

    it('interpolates translated text', () => {
        __setLocaleForTest('en');
        expect(t('update.available', { version: '3.1' })).toBe('Version 3.1 is available');
    });
});

suite('setLocale', () => {
    it('reports the locale actually in use', () => {
        expect(setLocale('en')).toBe('en');
        expect(getLocale()).toBe('en');
        // Asked for something unshipped: the answer is what we fell back to.
        expect(setLocale('de')).toBe('ja');
    });

    it('notifies listeners', () => {
        const seen = [];
        const off = onLocaleChange(code => seen.push(code));
        setLocale('en');
        setLocale('ja');
        expect(seen).toEqual(['en', 'ja']);
        off();
        setLocale('en');
        expect(seen).toEqual(['en', 'ja']);
    });

    it('does not notify when nothing changed', () => {
        setLocale('ja');
        const seen = [];
        const off = onLocaleChange(code => seen.push(code));
        setLocale('ja');
        expect(seen).toEqual([]);
        off();
    });

    it('keeps going when one listener throws', () => {
        // A view that fails to re-render must not stop the rest of the app from
        // switching language.
        const seen = [];
        const offBad = onLocaleChange(() => { throw new Error('boom'); });
        const offGood = onLocaleChange(code => seen.push(code));
        expect(() => setLocale('en')).not.toThrow();
        expect(seen).toEqual(['en']);
        offBad();
        offGood();
    });
});

suite('catalog consistency', () => {
    const keysOf = (loc) => Object.keys(CATALOGS[loc]).sort();
    const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();

    it('every locale has the same keys', () => {
        const base = keysOf(FALLBACK_LOCALE);
        for (const loc of Object.keys(CATALOGS)) {
            if (loc === FALLBACK_LOCALE) continue;
            const missing = base.filter(k => !(k in CATALOGS[loc]));
            const extra = keysOf(loc).filter(k => !(k in CATALOGS[FALLBACK_LOCALE]));
            expect(missing, `${loc} is missing keys`).toEqual([]);
            expect(extra, `${loc} has keys ${FALLBACK_LOCALE} does not`).toEqual([]);
        }
    });

    it('every locale uses the same placeholders per key', () => {
        // A dropped {version} leaves a sentence with a hole, in a language the
        // author may not read. This is the check that catches it.
        for (const key of keysOf(FALLBACK_LOCALE)) {
            const base = placeholders(CATALOGS[FALLBACK_LOCALE][key]);
            for (const loc of Object.keys(CATALOGS)) {
                expect(placeholders(CATALOGS[loc][key]), `${loc} / ${key}`).toEqual(base);
            }
        }
    });

    it('has no blank messages', () => {
        for (const [loc, catalog] of Object.entries(CATALOGS)) {
            for (const [key, value] of Object.entries(catalog)) {
                expect(typeof value, `${loc} / ${key}`).toBe('string');
                expect(value.trim(), `${loc} / ${key} is blank`).not.toBe('');
            }
        }
    });

    it('keeps the promises that matter in both languages', () => {
        // These two sentences are commitments about how the product behaves, not
        // decoration. Softening one in translation would make the builds disagree.
        expect(CATALOGS.en['update.failed']).not.toMatch(/latest|up to date/i);
        expect(CATALOGS.ja['update.failed']).not.toContain('最新');
        // An expired licence still opens your own files — said in both.
        expect(CATALOGS.en['license.expired.detail']).toMatch(/still open/i);
        expect(CATALOGS.ja['license.expired.detail']).toContain('開けます');
    });
});
