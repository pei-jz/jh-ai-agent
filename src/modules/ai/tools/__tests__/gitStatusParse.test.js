import { describe, it, expect } from 'vitest';
import { parseStatusPaths, buildStagingPreview } from '../gitStatusParse.js';

// Sample `git status --porcelain=v2 --branch` output (header + all line kinds).
const V2 = [
    '# branch.oid abc123',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.js',
    '1 M. N... 100644 100644 100644 ccc ddd README.md',
    '2 R. N... 100644 100644 100644 eee fff R100 src/new.js\tsrc/old.js',
    'u UU N... 100644 100644 100644 000 111 222 conflict.txt',
    '? .env',
    '! ignored-by-gitignore.log',
].join('\n');

describe('parseStatusPaths', () => {
    it('extracts changed / renamed / unmerged / untracked paths (new name for renames)', () => {
        expect(parseStatusPaths(V2)).toEqual([
            'src/app.js', 'README.md', 'src/new.js', 'conflict.txt', '.env',
        ]);
    });
    it('ignores # branch headers and ! ignored lines', () => {
        expect(parseStatusPaths('# branch.head main\n! foo.log')).toEqual([]);
    });
    it('tolerates CRLF and blank input', () => {
        expect(parseStatusPaths('1 .M N... 1 1 1 a b x.js\r')).toEqual(['x.js']);
        expect(parseStatusPaths('')).toEqual([]);
        expect(parseStatusPaths(null)).toEqual([]);
        expect(parseStatusPaths(undefined)).toEqual([]);
    });
});

describe('buildStagingPreview', () => {
    it('lists explicit paths when the caller passed some (ignores status)', () => {
        expect(buildStagingPreview(['a.js', 'b.js'], V2)).toBe('  • a.js\n  • b.js');
    });
    it('derives the file list from status when staging all', () => {
        expect(buildStagingPreview(null, V2)).toContain('  • .env');
        expect(buildStagingPreview(null, V2)).toContain('  • src/app.js');
    });
    it('surfaces .env so a blind git add -A can be caught', () => {
        expect(buildStagingPreview(null, V2)).toMatch(/\.env/);
    });
    it('caps the list and notes the remainder', () => {
        const many = Array.from({ length: 45 }, (_, i) => `f${i}.js`);
        const out = buildStagingPreview(many, '');
        expect(out).toContain('…(+5 more)');
        expect(out.split('\n').filter(l => l.includes('•')).length).toBe(40);
    });
    it('reports no changes for an empty tree', () => {
        expect(buildStagingPreview(null, '# branch.head main')).toBe('(no changes detected)');
    });
});
