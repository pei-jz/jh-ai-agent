import { describe, it, expect, beforeEach } from 'vitest';
import { readUseCounts, recordUse, rankRecipes, USE_COUNTS_KEY } from '../recipes.js';

/** A stand-in for localStorage, so these run without jsdom. */
function fakeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, v),
        _dump: () => Object.fromEntries(m),
    };
}

const tpl = (key, label, over = {}) => ({ key, label, prompt: 'do ' + key, ...over });

let store;
beforeEach(() => { store = fakeStorage(); });

describe('readUseCounts', () => {
    it('starts empty', () => {
        expect(readUseCounts(store)).toEqual({});
    });

    it('reads back what was recorded', () => {
        recordUse('review', store);
        recordUse('review', store);
        expect(readUseCounts(store)).toEqual({ review: 2 });
    });

    it('treats corrupt storage as empty rather than throwing on render', () => {
        expect(readUseCounts(fakeStorage({ [USE_COUNTS_KEY]: 'not json' }))).toEqual({});
        expect(readUseCounts(fakeStorage({ [USE_COUNTS_KEY]: '[1,2]' }))).toEqual({});
    });

    it('survives having no storage at all', () => {
        expect(readUseCounts(undefined)).toEqual({});
        expect(() => recordUse('x', undefined)).not.toThrow();
    });

    it('ignores an empty key', () => {
        recordUse('', store);
        expect(readUseCounts(store)).toEqual({});
    });
});

describe('rankRecipes', () => {
    const templates = [tpl('a', 'Alpha'), tpl('b', 'Beta'), tpl('c', 'Gamma')];

    it('floats the ones you actually use', () => {
        const out = rankRecipes(templates, { c: 5, a: 1 });
        expect(out.map(t => t.key)).toEqual(['c', 'a', 'b']);
    });

    // A list that reshuffles between visits costs the muscle memory that made
    // the shortcut worth having.
    it('keeps the defined order within a tie', () => {
        expect(rankRecipes(templates, {}).map(t => t.key)).toEqual(['a', 'b', 'c']);
        expect(rankRecipes(templates, { a: 2, b: 2 }).map(t => t.key)).toEqual(['a', 'b', 'c']);
    });

    it('reports the count so the chip can show it', () => {
        expect(rankRecipes(templates, { a: 7 })[0].uses).toBe(7);
        expect(rankRecipes(templates, {})[0].uses).toBe(0);
    });

    it('drops a template with no prompt — the chip would do nothing', () => {
        const out = rankRecipes([...templates, tpl('empty', 'Empty', { prompt: '   ' })], {});
        expect(out.map(t => t.key)).not.toContain('empty');
    });

    it('respects the limit', () => {
        expect(rankRecipes(templates, {}, 2)).toHaveLength(2);
    });

    it('survives a missing or malformed list', () => {
        expect(rankRecipes(undefined, {})).toEqual([]);
        expect(rankRecipes('nope', {})).toEqual([]);
        expect(rankRecipes([null, undefined, {}], {})).toEqual([]);
    });
});
