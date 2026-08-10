import { describe, it, expect } from 'vitest';
import { levenshtein, pickClosestFile } from '../FuzzyPath.js';

const entries = (...names) => names.map(name => ({ name, is_dir: false }));

describe('levenshtein', () => {
    it('computes edit distance', () => {
        expect(levenshtein('', '')).toBe(0);
        expect(levenshtein('abc', 'abc')).toBe(0);
        expect(levenshtein('abc', '')).toBe(3);
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('kitten', 'sitting')).toBe(3);
        expect(levenshtein('side', 'sidebar')).toBe(3);
    });
});

describe('pickClosestFile', () => {
    it('returns null for non-array or empty entries', () => {
        expect(pickClosestFile('a/b.tsx', null)).toBeNull();
        expect(pickClosestFile('a/b.tsx', [])).toBeNull();
        expect(pickClosestFile('a/b.tsx', entries(/* none after dir filter */))).toBeNull();
    });

    it('auto-corrects an extension/typo to a unique strong match (Side → Sidebar)', () => {
        const r = pickClosestFile('src/components/Side.tsx', entries('Sidebar.tsx', 'Header.tsx', 'App.tsx'), '.');
        expect(r.name).toBe('Sidebar.tsx');
        expect(r.path).toBe('src/components/Sidebar.tsx');
        expect(r.autoCorrect).toBe(true);
    });

    it('auto-corrects Sbar → Sidebar', () => {
        const r = pickClosestFile('src/Sbar.tsx', entries('Sidebar.tsx', 'Footer.tsx'), '.');
        expect(r.name).toBe('Sidebar.tsx');
        expect(r.autoCorrect).toBe(true);
    });

    it('does NOT auto-correct when two candidates are similarly close', () => {
        const r = pickClosestFile('src/Sidebar.tsx', entries('Sidebar1.tsx', 'Sidebar2.tsx'), '.');
        // both ~equally similar → ambiguous → no auto-correct
        expect(r.autoCorrect).toBe(false);
    });

    it('ignores directories and exposes suggestions', () => {
        const r = pickClosestFile('src/util.js', [
            { name: 'sub', is_dir: true },
            { name: 'utils.js', is_dir: false },
        ], '.');
        expect(r.name).toBe('utils.js');
        expect(r.suggestions[0]).toContain('utils.js');
    });

    it('uses workspacePath fallback when the path has no slash', () => {
        const r = pickClosestFile('readme.md', entries('README.md'), '/ws');
        expect(r.path).toBe('/ws/README.md');
    });
});
