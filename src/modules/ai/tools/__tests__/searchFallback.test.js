// searchFallback — the ladder a zero-result search walks before giving up.
//
// The behaviour being protected is not "search works", it is "a MISS carries
// information". A model that gets one flat "No matches" line either invents the
// next query well (strong models do) or stalls and starts reading files one at
// a time (weaker ones do). These helpers make the recovery a property of the
// tool rather than a hoped-for property of the model.

import { describe, it, expect } from 'vitest';
import {
    isPlainIdentifier, identifierTokens, distinctiveToken, escapeRegex, suggestNames,
} from '../searchFallback.js';

describe('isPlainIdentifier', () => {
    it('accepts a bare name', () => {
        expect(isPlainIdentifier('supportsNativeTools')).toBe(true);
        expect(isPlainIdentifier('run_study_pass')).toBe(true);
        expect(isPlainIdentifier('_private')).toBe(true);
    });

    it('refuses a name containing $ — legal in JS, an anchor in regex', () => {
        // grep_search takes a REGEX, so `x$` may well mean "x at end of line".
        // Guessing wrong turns a deliberate anchor into a word to split up.
        expect(isPlainIdentifier('_private$x')).toBe(false);
    });

    it('refuses anything that is a real pattern', () => {
        // Taking these apart would change what the user searched for.
        expect(isPlainIdentifier('function\\s+foo')).toBe(false);
        expect(isPlainIdentifier('TODO|FIXME')).toBe(false);
        expect(isPlainIdentifier('a.b')).toBe(false);
        expect(isPlainIdentifier('')).toBe(false);
    });
});

describe('identifierTokens', () => {
    it('splits camelCase, snake_case and kebab-case', () => {
        expect(identifierTokens('supportsNativeTools')).toEqual(['supports', 'Native', 'Tools']);
        expect(identifierTokens('run_study_pass')).toEqual(['run', 'study', 'pass']);
        expect(identifierTokens('code-index-client')).toEqual(['code', 'index', 'client']);
    });

    it('keeps an acronym together', () => {
        expect(identifierTokens('HTTPServer')).toEqual(['HTTP', 'Server']);
        expect(identifierTokens('parseJSONBody')).toEqual(['parse', 'JSON', 'Body']);
    });

    it('survives junk', () => {
        expect(identifierTokens('')).toEqual([]);
        expect(identifierTokens(null)).toEqual([]);
    });
});

describe('distinctiveToken', () => {
    it('picks the longest word worth searching on its own', () => {
        expect(distinctiveToken('supportsNativeTools')).toBe('supports');
        expect(distinctiveToken('runStudyPass')).toBe('Study');
    });

    it('returns nothing when there is nothing to relax to', () => {
        // One word: retrying with it is the SAME failed search.
        expect(distinctiveToken('handler')).toBe('');
        // Not an identifier: splitting would change the query's meaning.
        expect(distinctiveToken('function\\s+foo')).toBe('');
        // Every part too short to be a useful probe.
        expect(distinctiveToken('a_b_c')).toBe('');
    });
});

describe('escapeRegex', () => {
    it('makes a literal safe to use as a pattern', () => {
        expect(escapeRegex('a.b(c)')).toBe('a\\.b\\(c\\)');
    });
});

describe('suggestNames', () => {
    const names = [
        'supportsNativeTools', 'getCurrentProvider', 'runStudyPass',
        'handleSymbolSearch', 'fairShare',
    ];

    it('finds the name behind a typo', () => {
        expect(suggestNames(names, 'supportsNativeTool')[0]).toBe('supportsNativeTools');
        expect(suggestNames(names, 'runStudyPas')[0]).toBe('runStudyPass');
    });

    it('finds the name behind a casing slip', () => {
        expect(suggestNames(names, 'supportsnativetools')[0]).toBe('supportsNativeTools');
    });

    it('treats a substring as a match, not a typo', () => {
        // "fairShare" contains the query: a narrower spelling of the same thing
        // must outrank anything reached by edit distance.
        expect(suggestNames(names, 'fair')[0]).toBe('fairShare');
    });

    it('stays silent when nothing is close', () => {
        expect(suggestNames(names, 'zzzzQuuxFrobnicate')).toEqual([]);
    });

    it('de-duplicates and respects the limit', () => {
        const dupes = ['alpha', 'alpha', 'alphaBeta', 'alphaGamma', 'alphaDelta', 'alphaEpsilon'];
        const out = suggestNames(dupes, 'alpha', { limit: 3 });
        expect(out).toHaveLength(3);
        expect(new Set(out).size).toBe(3);
    });

    it('survives junk input', () => {
        expect(suggestNames(null, 'x')).toEqual([]);
        expect(suggestNames(['a'], '')).toEqual([]);
    });
});
