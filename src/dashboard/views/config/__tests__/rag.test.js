// The directory-tree rules behind the RAG Indexing picker.
//
// `descendantsOf` replaces the one genuinely imperative piece of DOM work left on
// that tab: unchecking a directory used to walk `.rag-dir-cb` and write `.checked`
// plus `parentElement.style.opacity` on every descendant input. The model and the
// checkboxes could therefore disagree, and the rule — what counts as a descendant
// across mixed path separators — was unverifiable.

import { describe, it, expect } from 'vitest';
import { RAG_EXTENSIONS, dirDepth, dirBasename, descendantsOf } from '../rag.js';

describe('RAG_EXTENSIONS', () => {
    it('covers the languages this project is written in', () => {
        for (const ext of ['js', 'rs', 'md', 'json']) {
            expect(RAG_EXTENSIONS, ext).toContain(ext);
        }
    });

    it('has no duplicates', () => {
        expect(new Set(RAG_EXTENSIONS).size).toBe(RAG_EXTENSIONS.length);
    });
});

describe('dirDepth', () => {
    it('counts separators of either flavour', () => {
        expect(dirDepth('src')).toBe(0);
        expect(dirDepth('src/dashboard')).toBe(1);
        expect(dirDepth('src\\dashboard\\views')).toBe(2);
        // Windows hands back both in the same list.
        expect(dirDepth('C:/proj\\src')).toBe(2);
    });

    it('is zero for nothing', () => {
        expect(dirDepth('')).toBe(0);
        expect(dirDepth(null)).toBe(0);
    });
});

describe('dirBasename', () => {
    it('takes the directory own name', () => {
        expect(dirBasename('C:/proj/src/dashboard')).toBe('dashboard');
        expect(dirBasename('C:\\proj\\src')).toBe('src');
    });

    it('ignores a trailing separator', () => {
        expect(dirBasename('C:/proj/src/')).toBe('src');
    });

    it('survives a bare name and nothing', () => {
        expect(dirBasename('src')).toBe('src');
        expect(dirBasename('')).toBe('');
    });
});

describe('descendantsOf', () => {
    const dirs = [
        'C:/proj/src',
        'C:/proj/src/dashboard',
        'C:/proj/src/dashboard/views',
        'C:/proj/src/modules',
        'C:/proj/docs',
        // A sibling whose name STARTS with the parent's: the prefix test has to use
        // the separator or this gets swept in too.
        'C:/proj/srcbackup',
    ];

    it('finds every directory beneath the parent', () => {
        expect(descendantsOf('C:/proj/src', dirs)).toEqual([
            'C:/proj/src/dashboard',
            'C:/proj/src/dashboard/views',
            'C:/proj/src/modules',
        ]);
    });

    it('does NOT include the parent itself', () => {
        expect(descendantsOf('C:/proj/src', dirs)).not.toContain('C:/proj/src');
    });

    it('does not sweep in a SIBLING that merely shares the prefix', () => {
        expect(descendantsOf('C:/proj/src', dirs)).not.toContain('C:/proj/srcbackup');
    });

    it('uses the separator the parent is written with', () => {
        // A hardcoded '/' would silently match nothing on a backslash path.
        const win = ['C:\\proj\\src', 'C:\\proj\\src\\a', 'C:\\proj\\docs'];
        expect(descendantsOf('C:\\proj\\src', win)).toEqual(['C:\\proj\\src\\a']);
    });

    it('tolerates a parent that already ends in a separator', () => {
        expect(descendantsOf('C:/proj/src/', dirs)).toEqual([
            'C:/proj/src/dashboard',
            'C:/proj/src/dashboard/views',
            'C:/proj/src/modules',
        ]);
    });

    it('is empty for a leaf, and for no input', () => {
        expect(descendantsOf('C:/proj/docs', dirs)).toEqual([]);
        expect(descendantsOf('', dirs)).toEqual([]);
        expect(descendantsOf('C:/proj/src', null)).toEqual([]);
    });
});
