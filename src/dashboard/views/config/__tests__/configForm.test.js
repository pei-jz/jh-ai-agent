// The normalization rules behind the General settings form.
//
// These were embedded in `readFormValues()`, a 90-line function that read every
// field back out of the DOM. Each rule here is load-bearing and at least two were
// bug fixes that a rewrite could easily have undone — normalizeModelId and
// normalizeSecret especially. That is why they are pure functions with tests rather
// than a few lines inside a form handler.

import { describe, it, expect, vi } from 'vitest';
import {
    SAFETY_FIELDS, OUTPUT_LANGUAGES, MASKED,
    normalizeInt, normalizeRatio, normalizeText, normalizeSecret,
    normalizeModelId, normalizePathList, normalizeHostList, approvedPatternRefusal, modelChoices,
} from '../configForm.js';

describe('SAFETY_FIELDS', () => {
    it('describes every agent-safety limit', () => {
        expect(SAFETY_FIELDS.map(f => f.key)).toEqual([
            'max_steps', 'token_budget', 'wall_clock_minutes',
            'no_progress_window', 'identical_call_threshold',
            // Tier promotion by step count. Off by default: it used to fire at
            // step 15 on every run — a stale field name, not a setting.
            'escalate_at_step',
            'cycle_detection_min_repeats',
        ]);
    });

    it('gives every field a label, bounds, placeholder and hint', () => {
        for (const f of SAFETY_FIELDS) {
            expect(f.label, f.key).toBeTruthy();
            expect(f.hint, f.key).toBeTruthy();
            expect(f.placeholder, f.key).toBeTruthy();
            expect(Number.isFinite(f.min), f.key).toBe(true);
            expect(Number.isFinite(f.max), f.key).toBe(true);
            expect(Number.isFinite(f.fallback), f.key).toBe(true);
        }
    });

    it('keeps the non-zero defaults the detectors rely on', () => {
        const by = Object.fromEntries(SAFETY_FIELDS.map(f => [f.key, f.fallback]));
        expect(by.no_progress_window).toBe(15);
        expect(by.identical_call_threshold).toBe(5);
        expect(by.cycle_detection_min_repeats).toBe(3);
    });
});

describe('OUTPUT_LANGUAGES', () => {
    it('offers Japanese first — it is the default', () => {
        expect(OUTPUT_LANGUAGES[0][0]).toBe('Japanese');
    });

    it('pairs every value with a label', () => {
        for (const [val, label] of OUTPUT_LANGUAGES) {
            expect(val).toBeTruthy();
            expect(label).toBeTruthy();
        }
    });
});

describe('normalizeInt', () => {
    it('reads a number', () => {
        expect(normalizeInt('30')).toBe(30);
        expect(normalizeInt(' 1000000 ')).toBe(1000000);
        expect(normalizeInt('0')).toBe(0);
    });

    it('treats BLANK as 0 — clearing the box turns the limit off', () => {
        // Not the field's default: emptying the input has to be a way to disable it.
        expect(normalizeInt('', 15)).toBe(0);
        expect(normalizeInt('   ', 15)).toBe(0);
        expect(normalizeInt(null, 15)).toBe(0);
    });

    it('falls back to the DEFAULT on junk, not to 0', () => {
        // Silently becoming 0 would disable a detector because of a typo.
        expect(normalizeInt('abc', 15)).toBe(15);
        expect(normalizeInt('-5', 15)).toBe(15);
    });
});

describe('normalizeRatio', () => {
    it('accepts a float in (0, 1]', () => {
        expect(normalizeRatio('0.5')).toBe(0.5);
        expect(normalizeRatio('1')).toBe(1);
        expect(normalizeRatio('0.05')).toBe(0.05);
    });

    it('is null for blank or out-of-range — the backend then uses 0.5', () => {
        expect(normalizeRatio('')).toBe(null);
        expect(normalizeRatio('0')).toBe(null);
        expect(normalizeRatio('1.5')).toBe(null);
        expect(normalizeRatio('abc')).toBe(null);
    });

    it('does NOT truncate to an integer', () => {
        // Integer parsing would destroy this field, which is why it never went
        // through the shared numeric reader.
        expect(normalizeRatio('0.35')).toBeCloseTo(0.35);
    });
});

describe('normalizeText', () => {
    it('trims, and turns empty into null', () => {
        expect(normalizeText('  http://p  ')).toBe('http://p');
        expect(normalizeText('')).toBe(null);
        expect(normalizeText('   ')).toBe(null);
        expect(normalizeText(undefined)).toBe(null);
    });
});

describe('normalizeSecret', () => {
    it('saves a real value', () => {
        expect(normalizeSecret('tvly-abc')).toBe('tvly-abc');
    });

    it('returns UNDEFINED for the mask — never overwrite the stored key', () => {
        // The backend hands back asterisks instead of the secret; saving those back
        // would replace the real key with asterisks.
        expect(normalizeSecret(MASKED)).toBeUndefined();
    });

    it('clears explicitly when emptied', () => {
        expect(normalizeSecret('')).toBe(null);
    });
});

describe('normalizeModelId', () => {
    it('keeps the selection', () => {
        expect(normalizeModelId('inst_1:gpt-4o')).toBe('inst_1:gpt-4o');
    });

    it('clears with an EMPTY STRING, never null', () => {
        // The backend merges field-wise and reads null as "not mentioned", restoring
        // the previous value — which made "(not set)" impossible to choose.
        expect(normalizeModelId('')).toBe('');
        expect(normalizeModelId(null)).toBe('');
        expect(normalizeModelId(undefined)).toBe('');
    });
});

describe('normalizePathList', () => {
    it('splits per line and drops blanks', () => {
        expect(normalizePathList('C:/a\n\n  C:/b  \n')).toEqual(['C:/a', 'C:/b']);
    });

    it('is empty for nothing', () => {
        expect(normalizePathList('')).toEqual([]);
        expect(normalizePathList(null)).toEqual([]);
    });
});

// This list is a security opt-out: each entry re-opens an address fetch_url
// would otherwise refuse. The parsing has to be forgiving about what a person
// pastes but strict about what it stores.
describe('normalizeHostList', () => {
    it('keeps plain hostnames, lower-cased and de-duplicated', () => {
        expect(normalizeHostList('localhost\nIntranet.Example.com\nlocalhost'))
            .toEqual(['localhost', 'intranet.example.com']);
    });

    it('reduces a pasted URL to its host', () => {
        expect(normalizeHostList('http://localhost:3000/api/v1')).toEqual(['localhost']);
        expect(normalizeHostList('https://intranet.example.com/wiki')).toEqual(['intranet.example.com']);
    });

    it('strips a port', () => {
        expect(normalizeHostList('127.0.0.1:14300')).toEqual(['127.0.0.1']);
    });

    it('keeps an IPv6 literal intact', () => {
        expect(normalizeHostList('[::1]')).toEqual(['::1']);
        expect(normalizeHostList('fe80::1')).toEqual(['fe80::1']);
    });

    it('drops the trailing root dot so it matches the guard', () => {
        expect(normalizeHostList('example.com.')).toEqual(['example.com']);
    });

    it('REFUSES a bare wildcard — it would undo the guard entirely', () => {
        expect(normalizeHostList('*')).toEqual([]);
        expect(normalizeHostList('example.com\n*\nother.com')).toEqual(['example.com', 'other.com']);
    });

    it('is empty for nothing', () => {
        expect(normalizeHostList('')).toEqual([]);
        expect(normalizeHostList(null)).toEqual([]);
    });
});

describe('approvedPatternRefusal — a hard safety boundary', () => {
    const safe = vi.fn(() => 'normal');
    const dangerous = vi.fn(() => 'dangerous');

    it('allows an ordinary pattern', () => {
        expect(approvedPatternRefusal('npm run build *', safe)).toBe(null);
    });

    it('refuses a bare wildcard — it would approve EVERY command', () => {
        expect(approvedPatternRefusal('*', safe)).toContain('every command');
        expect(approvedPatternRefusal('* *', safe)).toContain('every command');
    });

    it('refuses anything classified dangerous, however it is spelled', () => {
        expect(approvedPatternRefusal('rm -rf /', dangerous)).toContain('DANGEROUS');
    });

    it('classifies the command WITHOUT its trailing wildcard', () => {
        // Left in, the `*` reads as an argument and can hide the verb being matched.
        const classify = vi.fn(() => 'normal');
        approvedPatternRefusal('git push --force *', classify);
        expect(classify).toHaveBeenCalledWith('git push --force');
    });

    it('refuses an empty pattern', () => {
        expect(approvedPatternRefusal('', safe)).toBeTruthy();
        expect(approvedPatternRefusal('   ', safe)).toBeTruthy();
    });

    it('still allows a pattern when no classifier is supplied', () => {
        expect(approvedPatternRefusal('ls *', undefined)).toBe(null);
    });
});

describe('modelChoices', () => {
    it('builds the id:model composite the routing selects speak', () => {
        expect(modelChoices([{ id: 'inst_1', name: 'Prod', model: 'gpt-4o' }])).toEqual([
            { id: 'inst_1:gpt-4o', label: 'Prod (gpt-4o)' },
        ]);
    });

    it('is empty with no connections', () => {
        expect(modelChoices([])).toEqual([]);
        expect(modelChoices(null)).toEqual([]);
    });
});
