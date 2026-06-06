import { describe, it, expect } from 'vitest';
import {
    detectLineEnding, normalizeLE, countOccurrences, replaceAllLiteral,
    findClosestRegion, visualizeWS
} from '../FileEdit.js';

describe('detectLineEnding', () => {
    it('returns CRLF when CRLF dominates', () => {
        expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n');
    });
    it('returns LF otherwise', () => {
        expect(detectLineEnding('a\nb\nc')).toBe('\n');
        expect(detectLineEnding('no newlines')).toBe('\n');
    });
});

describe('normalizeLE', () => {
    it('converts CRLF to LF', () => {
        expect(normalizeLE('a\r\nb')).toBe('a\nb');
    });
    it('passes non-strings through', () => {
        expect(normalizeLE(null)).toBeNull();
        expect(normalizeLE(5)).toBe(5);
    });
});

describe('countOccurrences', () => {
    it('counts non-overlapping occurrences', () => {
        expect(countOccurrences('aXbXc', 'X')).toBe(2);
        expect(countOccurrences('aaaa', 'aa')).toBe(2);
        expect(countOccurrences('abc', 'z')).toBe(0);
    });
    it('returns 0 for empty needle', () => {
        expect(countOccurrences('abc', '')).toBe(0);
    });
});

describe('replaceAllLiteral', () => {
    it('replaces every occurrence', () => {
        expect(replaceAllLiteral('a.b.c', '.', '-')).toBe('a-b-c');
    });
    it('leaves text unchanged when needle absent', () => {
        expect(replaceAllLiteral('abc', 'z', 'Q')).toBe('abc');
    });
});

describe('findClosestRegion', () => {
    const file = [
        'function foo() {',
        '  const x = 1;',
        '  return x;',
        '}',
    ].join('\n');

    it('locates the most similar block', () => {
        const r = findClosestRegion(file, '  const x = 1;');
        expect(r).not.toBeNull();
        expect(r.content).toContain('const x = 1');
        expect(r.startLine).toBe(2);
        expect(r.score).toBeGreaterThan(0.4);
        expect(r.score).toBeLessThanOrEqual(1);
    });

    it('returns null for whitespace-only target', () => {
        expect(findClosestRegion(file, '   \n  ')).toBeNull();
    });

    it('returns null when nothing is similar enough', () => {
        expect(findClosestRegion(file, 'completely unrelated zzzzz qqqqq')).toBeNull();
    });
});

describe('visualizeWS', () => {
    it('marks tabs and spaces', () => {
        expect(visualizeWS('\ta b')).toBe('→a·b');
    });
});
