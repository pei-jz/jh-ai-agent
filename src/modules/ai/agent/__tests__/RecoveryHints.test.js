import { describe, it, expect } from 'vitest';
import { hintForError, buildRecoveryHint } from '../RecoveryHints.js';

describe('hintForError', () => {
    it('handles user-denied/blocked', () => {
        expect(hintForError('error: user denied command execution')).toContain('denied');
        expect(hintForError('rejected by guard')).toContain('denied');
        expect(hintForError('blocked')).toContain('denied');
    });
    it('handles not-found', () => {
        expect(hintForError('error: file not found: x')).toContain('Verify paths');
        expect(hintForError('no such file')).toContain('Verify paths');
    });
    it('handles line/anchor mismatch', () => {
        expect(hintForError('invalid line range')).toContain('Re-read');
        expect(hintForError('anchor mismatch — stale')).toContain('Re-read');
        expect(hintForError('old_text does not match')).toContain('Re-read');
    });
    it('falls back to a generic hint', () => {
        expect(hintForError('some other error')).toContain('verification');
        expect(hintForError('')).toContain('verification');
    });
});

describe('buildRecoveryHint', () => {
    it('returns empty for non-arrays or no errors', () => {
        expect(buildRecoveryHint(null)).toBe('');
        expect(buildRecoveryHint([{ result: 'Success: ok' }])).toBe('');
    });
    it('only considers string results starting with Error', () => {
        const r = buildRecoveryHint([
            { result: 'Success: done' },
            { result: 'Error: file not found: a.js' },
            { result: 42 },
        ]);
        expect(r).toContain('Verify paths');
        expect(r).not.toContain('denied');
    });
    it('concatenates hints for multiple errors', () => {
        const r = buildRecoveryHint([
            { result: 'Error: user denied' },
            { result: 'Error: invalid line range' },
        ]);
        expect(r).toContain('denied');
        expect(r).toContain('Re-read');
    });
});
