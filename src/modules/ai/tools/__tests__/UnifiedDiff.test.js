// UnifiedDiff — the properties that make a patch better than a transcription.
//
// The point of adding a fourth editing tool is that `multi_replace_file_content`
// makes the model reproduce existing text exactly (it fails often enough that the
// executor carries a three-strikes recovery path) and `replace_lines` needs line
// numbers that are still valid at call time. A patch needs neither: context lines
// are copied from read_file output, and the @@ number is a hint the matcher
// searches around. These tests pin that behaviour — especially the parts that are
// easy to "simplify" back into a strict-address applier.

import { describe, it, expect } from 'vitest';
import { parsePatch, applyPatch, applyHunks, locateHunk, SEARCH_RADIUS } from '../UnifiedDiff.js';

const FILE = [
    'function a() {',
    '    return 1;',
    '}',
    '',
    'function b() {',
    '    return 2;',
    '}',
    '',
].join('\n');

describe('parsePatch', () => {
    it('reads a single hunk', () => {
        const r = parsePatch('@@ -1,3 +1,3 @@\n function a() {\n-    return 1;\n+    return 42;\n }');
        expect(r.ok).toBe(true);
        expect(r.hunks).toHaveLength(1);
        expect(r.hunks[0].oldStart).toBe(1);
        expect(r.hunks[0].lines).toHaveLength(4);
    });

    it('ignores the file headers models emit out of habit', () => {
        const r = parsePatch([
            'diff --git a/x.js b/x.js',
            '--- a/x.js',
            '+++ b/x.js',
            '@@ -1,1 +1,1 @@',
            '-a',
            '+b',
        ].join('\n'));
        expect(r.ok).toBe(true);
        expect(r.hunks).toHaveLength(1);
    });

    it('reads a stripped blank context line as context, not as the end', () => {
        // Editors and JSON round-trips eat the trailing space on a blank context
        // line. Treating that as "hunk over" silently truncates the patch.
        const r = parsePatch('@@ -1,4 +1,4 @@\n a\n\n-b\n+c');
        expect(r.ok).toBe(true);
        expect(r.hunks[0].lines.map(l => l.kind)).toEqual([' ', ' ', '-', '+']);
    });

    it('rejects a line with no diff marker instead of guessing', () => {
        const r = parsePatch('@@ -1,2 +1,2 @@\n a\nb\n+c');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not a diff marker/);
    });

    it('rejects a patch with no hunks', () => {
        expect(parsePatch('just some prose').ok).toBe(false);
        expect(parsePatch('').ok).toBe(false);
    });

    it('rejects a context-only hunk — it would change nothing', () => {
        const r = parsePatch('@@ -1,2 +1,2 @@\n a\n b');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/changes nothing/);
    });

    it('rejects a malformed header rather than mis-locating the hunk', () => {
        expect(parsePatch('@@ nonsense @@\n-a\n+b').ok).toBe(false);
    });
});

describe('applyPatch', () => {
    it('applies a replacement', () => {
        const r = applyPatch(FILE, '@@ -1,3 +1,3 @@\n function a() {\n-    return 1;\n+    return 42;\n }');
        expect(r.ok).toBe(true);
        expect(r.content).toContain('return 42;');
        expect(r.content).not.toContain('return 1;');
        expect(r.content).toContain('return 2;');   // the other function is untouched
    });

    it('applies an insertion', () => {
        const r = applyPatch(FILE, '@@ -1,2 +1,3 @@\n function a() {\n+    // added\n     return 1;');
        expect(r.ok).toBe(true);
        expect(r.content).toContain('    // added\n    return 1;');
    });

    it('applies a deletion', () => {
        const r = applyPatch(FILE, '@@ -1,3 +1,2 @@\n function a() {\n-    return 1;\n }');
        expect(r.ok).toBe(true);
        expect(r.content).not.toContain('return 1;');
    });

    it('applies several hunks in one call', () => {
        const r = applyPatch(FILE, [
            '@@ -1,3 +1,3 @@',
            ' function a() {',
            '-    return 1;',
            '+    return 11;',
            ' }',
            '@@ -5,3 +5,3 @@',
            ' function b() {',
            '-    return 2;',
            '+    return 22;',
            ' }',
        ].join('\n'));
        expect(r.ok).toBe(true);
        expect(r.applied).toBe(2);
        expect(r.content).toContain('return 11;');
        expect(r.content).toContain('return 22;');
    });

    // THE property that makes patches worth having over replace_lines.
    it('still applies when the @@ line numbers are stale', () => {
        const shifted = '// a new header line\n// and another\n' + FILE;
        const r = applyPatch(shifted, '@@ -1,3 +1,3 @@\n function a() {\n-    return 1;\n+    return 42;\n }');
        expect(r.ok).toBe(true);
        expect(r.content).toContain('return 42;');
        expect(r.content.startsWith('// a new header line')).toBe(true);
    });

    it('tolerates re-indented context, and says it did', () => {
        const patch = '@@ -1,3 +1,3 @@\n function a() {\n-  return 1;\n+  return 42;\n }';
        const r = applyPatch(FILE, patch);
        expect(r.ok).toBe(true);
        expect(r.fuzzy).toBe(1);
    });

    it('prefers an EXACT match far away over a loose one nearby', () => {
        // Relaxed whitespace is a concession, never a preference: a place where
        // the text really matches must win.
        const content = ['  target', 'x', 'x', 'target', ''].join('\n');
        const r = applyPatch(content, '@@ -1,1 +1,1 @@\n-target\n+CHANGED');
        expect(r.ok).toBe(true);
        expect(r.content.split('\n')[0]).toBe('  target');   // the loose one survives
        expect(r.content.split('\n')[3]).toBe('CHANGED');    // the exact one changed
        expect(r.fuzzy).toBe(0);
    });

    it('does not let two hunks match the same region', () => {
        // Without a forward-only cursor the second hunk re-matches the first
        // location and the block is silently duplicated.
        const content = 'dup\ndup\n';
        const r = applyPatch(content, '@@ -1,1 +1,1 @@\n-dup\n+one\n@@ -2,1 +2,1 @@\n-dup\n+two\n');
        expect(r.ok).toBe(true);
        expect(r.content).toBe('one\ntwo\n');
    });

    it('reports a hunk that does not match, without writing anything', () => {
        const r = applyPatch(FILE, '@@ -1,3 +1,3 @@\n function nonexistent() {\n-    return 9;\n+    return 8;\n }');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/does not match/);
        expect(r.error).toMatch(/Re-read the file/);
    });

    it('names WHICH hunk failed in a multi-hunk patch', () => {
        const r = applyPatch(FILE, [
            '@@ -1,3 +1,3 @@',
            ' function a() {',
            '-    return 1;',
            '+    return 11;',
            ' }',
            '@@ -5,3 +5,3 @@',
            ' function NOPE() {',
            '-    return 2;',
            '+    return 22;',
            ' }',
        ].join('\n'));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/hunk 2 of 2/);
    });
});

describe('line endings and trailing newline', () => {
    it('preserves CRLF', () => {
        const crlf = 'a\r\nb\r\nc\r\n';
        const r = applyPatch(crlf, '@@ -1,2 +1,2 @@\n a\n-b\n+B');
        expect(r.ok).toBe(true);
        expect(r.content).toBe('a\r\nB\r\nc\r\n');
    });

    it('preserves LF', () => {
        const r = applyPatch('a\nb\nc\n', '@@ -1,2 +1,2 @@\n a\n-b\n+B');
        expect(r.content).toBe('a\nB\nc\n');
    });

    it('does not invent a trailing newline where there was none', () => {
        const r = applyPatch('a\nb', '@@ -1,2 +1,2 @@\n a\n-b\n+B');
        expect(r.ok).toBe(true);
        expect(r.content).toBe('a\nB');
    });

    it('keeps a trailing newline that was there', () => {
        const r = applyPatch('a\nb\n', '@@ -1,2 +1,2 @@\n a\n-b\n+B');
        expect(r.content).toBe('a\nB\n');
    });

    it('accepts a CRLF patch against an LF file', () => {
        const r = applyPatch('a\nb\nc\n', '@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+B');
        expect(r.ok).toBe(true);
        expect(r.content).toBe('a\nB\nc\n');
    });
});

describe('locateHunk', () => {
    const hay = ['a', 'b', 'c', 'd', 'e'];

    it('finds an exact run at the hint', () => {
        expect(locateHunk(hay, ['c', 'd'], 2)).toEqual({ index: 2, exact: true });
    });

    it('searches outward from a wrong hint', () => {
        expect(locateHunk(hay, ['c', 'd'], 0)).toEqual({ index: 2, exact: true });
        expect(locateHunk(hay, ['a', 'b'], 4)).toEqual({ index: 0, exact: true });
    });

    it('is null when the run is absent', () => {
        expect(locateHunk(hay, ['x', 'y'], 0)).toBeNull();
    });

    it('gives up beyond the search radius rather than scanning a huge file', () => {
        const big = [...Array(SEARCH_RADIUS + 50).fill('filler'), 'needle'];
        expect(locateHunk(big, ['needle'], 0)).toBeNull();
        expect(locateHunk(big, ['needle'], big.length - 1)).not.toBeNull();
    });
});

describe('applyHunks preserves the input', () => {
    it('does not mutate the content string it was given', () => {
        const before = FILE;
        const parsed = parsePatch('@@ -1,3 +1,3 @@\n function a() {\n-    return 1;\n+    return 42;\n }');
        applyHunks(FILE, parsed.hunks);
        expect(FILE).toBe(before);
    });
});
