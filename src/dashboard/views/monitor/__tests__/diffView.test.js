// diffView — the pure helpers behind the lightweight inline diff viewer.

import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, relPathFor } from '../diffView.js';

describe('parseUnifiedDiff', () => {
    it('types each line so the renderer colours it', () => {
        const diff = [
            'diff --git a/src/a.js b/src/a.js',
            'index abc..def 100644',
            '--- a/src/a.js',
            '+++ b/src/a.js',
            '@@ -1,3 +1,3 @@',
            ' context line',
            '-removed',
            '+added',
        ].join('\n');
        expect(parseUnifiedDiff(diff).map(l => l.type)).toEqual([
            'meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add',
        ]);
    });

    it('strips a trailing CR so a Windows git output still classifies', () => {
        expect(parseUnifiedDiff('-removed\r\n+added\r\n').map(l => l.type))
            .toEqual(['del', 'add']);
    });

    it('handles empty and missing input', () => {
        expect(parseUnifiedDiff('')).toEqual([]);
        expect(parseUnifiedDiff(null)).toEqual([]);
    });
});

describe('relPathFor', () => {
    it('relativises a path inside the workspace', () => {
        expect(relPathFor('C:/proj/src/a.js', 'C:/proj')).toBe('src/a.js');
    });

    it('is case-insensitive on the workspace prefix (Windows drives)', () => {
        expect(relPathFor('c:/proj/src/a.js', 'C:/Proj')).toBe('src/a.js');
    });

    it('falls back to the path when there is no workspace', () => {
        expect(relPathFor('C:/proj/a.js', '')).toBe('C:/proj/a.js');
    });

    it('keeps an out-of-tree path unchanged', () => {
        expect(relPathFor('D:/elsewhere/a.js', 'C:/proj')).toBe('D:/elsewhere/a.js');
    });
});
