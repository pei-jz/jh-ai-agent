// RecoveryHints — what the agent is told to do after a tool fails.
//
// Precision here is the agent's ability to get unstuck, so these tests are
// written against the app's REAL error strings rather than invented ones: a
// rule that matches a phrase no tool produces is a rule that never fires, and
// nothing else would notice.
import { describe, it, expect } from 'vitest';
import {
    hintForError, buildRecoveryHint, ruleForError, RECOVERY_RULES,
} from '../RecoveryHints.js';

/** Verbatim from the tools, lowercased the way the caller lowercases them. */
const REAL_ERRORS = {
    denied:            'error: user denied file write.',
    denied2:           'error: execution blocked by user permission settings (deny).',
    'refused-replace': 'error: 見積.xlsx is a file this task was already refused permission to replace',
    'truncated-args':  "error: the tool call's arguments were truncated at the output limit — nothing ran",
    'unparseable-args':'error: invalid arguments for mcp tool "x": bad json. fix the call and retry.',
    'tool-unavailable':'error: tool "run_subtask" is not enabled for this task. allowed tools: read_file',
    'timed-out':       'error: write_xlsx did not return after 180s and was abandoned. ',
    'timed-out2':      'error: command timed out after 60 seconds and was killed. ',
    'path-blocked':    "error: path guard: operation blocked — 'c:/x' is outside all allowed roots.",
    'path-blocked2':   'error: file deletion denied — target is outside the workspace and was not approved.',
    'not-found':       'error: file not found: src/x.js',
    'stale-anchor':    'error: end_line 900 exceeds file length (120 lines) in a.js. ',
    'stale-anchor2':   'error: apply_patch produced no change to a.js. ',
    'missing-param':   'error: code_deps requires "path" (the file to examine).',
    syntax:            'error: syntax error in a.js (node --check):\nunexpected token',
    network:           'error fetching url: econnrefused',
};

describe('the rules fire on the strings the app really produces', () => {
    it.each(Object.entries(REAL_ERRORS))('%s', (_name, text) => {
        expect(ruleForError(text), text).not.toBeNull();
    });

    it('routes each one to the rule it is about', () => {
        const id = (t) => ruleForError(t)?.id;
        expect(id(REAL_ERRORS.denied)).toBe('denied');
        expect(id(REAL_ERRORS.denied2)).toBe('denied');
        expect(id(REAL_ERRORS['refused-replace'])).toBe('refused-replace');
        expect(id(REAL_ERRORS['truncated-args'])).toBe('truncated-args');
        expect(id(REAL_ERRORS['tool-unavailable'])).toBe('tool-unavailable');
        expect(id(REAL_ERRORS['timed-out'])).toBe('timed-out');
        expect(id(REAL_ERRORS['timed-out2'])).toBe('timed-out');
        expect(id(REAL_ERRORS['path-blocked'])).toBe('path-blocked');
        expect(id(REAL_ERRORS['not-found'])).toBe('not-found');
        expect(id(REAL_ERRORS.syntax)).toBe('syntax');
    });

    // A denial must not be read as "that path is outside the workspace", which
    // would send the model off to get a location approved instead of stopping.
    it('reads a denial as a denial even when it also mentions the workspace', () => {
        expect(ruleForError(REAL_ERRORS['path-blocked2'])?.id).toBe('denied');
    });
});

describe('an unrecognised error gets no advice at all', () => {
    // The catch-all used to answer every unmatched error with "run verification
    // after edits, bundle your tests" — advice about editing style, handed to
    // timeouts and blocked paths alike. Wrong advice costs a step; silence
    // leaves the tool's own (explanatory) error as what the model reads.
    it('returns nothing rather than something irrelevant', () => {
        expect(hintForError('error: the flux capacitor desynchronised')).toBe('');
        expect(hintForError('')).toBe('');
        expect(hintForError(null)).toBe('');
    });
});

describe('the hints are usable as written', () => {
    it('every rule says what to do next, imperatively and briefly', () => {
        for (const r of RECOVERY_RULES) {
            expect(r.id, 'id').toMatch(/^[a-z][a-z-]*$/);
            expect(r.hint.length, `${r.id} is too long to be read`).toBeLessThan(260);
            expect(r.hint, r.id).toMatch(/[A-Z]/);
        }
    });

    it('has no duplicate ids — they are what de-duplication keys on', () => {
        const ids = RECOVERY_RULES.map(r => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // The denial rule is first on purpose: retrying something the user refused
    // is the failure that reads as not listening.
    it('checks denial before anything else', () => {
        expect(RECOVERY_RULES[0].id).toBe('denied');
    });
});

describe('one line per problem, not one per failure', () => {
    const err = (s) => ({ result: s });

    it('collapses repeats of the same problem and counts them', () => {
        const out = buildRecoveryHint([
            err('Error: file not found: a.js'),
            err('Error: file not found: b.js'),
            err('Error: file not found: c.js'),
        ]);
        expect(out.match(/Self-Correction Hint/g)).toHaveLength(1);
        expect(out).toContain('(×3)');
    });

    it('keeps distinct problems distinct', () => {
        const out = buildRecoveryHint([
            err('Error: file not found: a.js'),
            err('Error: User Denied file write.'),
        ]);
        expect(out.match(/Self-Correction Hint/g)).toHaveLength(2);
        expect(out).toContain('does not exist');
        expect(out).toContain('declined');
    });

    it('ignores successes and non-strings', () => {
        expect(buildRecoveryHint([{ result: 'ok' }, { result: 42 }, {}])).toBe('');
        expect(buildRecoveryHint(null)).toBe('');
    });

    it('says nothing when the only failure is unrecognised', () => {
        expect(buildRecoveryHint([err('Error: something entirely new')])).toBe('');
    });
});
