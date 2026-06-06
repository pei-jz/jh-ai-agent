import { describe, it, expect } from 'vitest';
import { sanitizeXmlTags, relevanceScore, scoreMessageImportance } from '../MemoryScoring.js';

describe('sanitizeXmlTags', () => {
    it('neutralizes active tags', () => {
        expect(sanitizeXmlTags('<active_file>x</active_file>')).toBe('[active_file]x[/active_file]');
        expect(sanitizeXmlTags('<artifact id="1">y</artifact>')).toBe('[artifact id="1"]y[/artifact]');
    });
    it('leaves unrelated tags and non-strings alone', () => {
        expect(sanitizeXmlTags('<div>z</div>')).toBe('<div>z</div>');
        expect(sanitizeXmlTags(null)).toBeNull();
        expect(sanitizeXmlTags(42)).toBe(42);
    });
});

describe('relevanceScore', () => {
    it('returns 0.5 with no usable query', () => {
        expect(relevanceScore({ summary: 'x' }, '')).toBe(0.5);
        expect(relevanceScore({ summary: 'x' }, '?? !!')).toBe(0.5);
    });
    it('scores keyword overlap across fields', () => {
        const entry = { topic: 'auth login', summary: 'fixed token bug', actions: ['edit auth'], keyFiles: ['auth.js'] };
        expect(relevanceScore(entry, 'auth token')).toBe(1);     // both words hit
        expect(relevanceScore(entry, 'auth missing')).toBe(0.5); // 1 of 2
        expect(relevanceScore(entry, 'unrelated stuff')).toBe(0);
    });
});

describe('scoreMessageImportance', () => {
    it('rewards plans highly', () => {
        expect(scoreMessageImportance({ role: 'assistant', content: 'see plan.md for steps' })).toBeGreaterThanOrEqual(5);
    });
    it('rewards errors and file mods', () => {
        expect(scoreMessageImportance({ role: 'assistant', content: 'Error: failed to compile foo.ts' })).toBeGreaterThan(0);
        expect(scoreMessageImportance({ role: 'assistant', content: 'write_file to src/a.js' })).toBeGreaterThan(0);
    });
    it('rewards genuine user instructions', () => {
        const userMsg = scoreMessageImportance({ role: 'user', content: 'please refactor the parser' });
        const sysMsg = scoreMessageImportance({ role: 'user', content: '[System] notice' });
        expect(userMsg).toBeGreaterThan(sysMsg);
    });
    it('penalizes tool-result dumps and system nudges', () => {
        expect(scoreMessageImportance({ role: 'user', content: 'Tool Execution Results:\n[...]' })).toBeLessThanOrEqual(0);
        expect(scoreMessageImportance({ role: 'user', content: '[System] keep going' })).toBeLessThan(0);
    });
    it('handles empty/missing content', () => {
        expect(scoreMessageImportance({})).toBe(0);
        expect(scoreMessageImportance({ role: 'assistant', content: '' })).toBe(0);
    });
});
