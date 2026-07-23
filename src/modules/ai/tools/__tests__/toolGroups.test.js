import { describe, it, expect } from 'vitest';
import { toolGroupOf, isToolAdvertised } from '../toolGroups.js';

describe('toolGroupOf', () => {
    it('classifies browser_* and git_* tools', () => {
        expect(toolGroupOf('browser_navigate')).toBe('browser');
        expect(toolGroupOf('git_commit')).toBe('git');
    });
    it('returns null for core tools and bad input', () => {
        expect(toolGroupOf('read_file')).toBe(null);
        expect(toolGroupOf('run_command')).toBe(null);
        expect(toolGroupOf(null)).toBe(null);
        expect(toolGroupOf(42)).toBe(null);
    });
});

describe('isToolAdvertised', () => {
    it('core tools are always advertised', () => {
        expect(isToolAdvertised('read_file', { prefs: { browser: false, git: false } })).toBe(true);
    });
    it('optional groups advertised by default (no prefs)', () => {
        expect(isToolAdvertised('browser_navigate')).toBe(true);
        expect(isToolAdvertised('git_status')).toBe(true);
    });
    it('a disabled group is hidden', () => {
        expect(isToolAdvertised('browser_eval', { prefs: { browser: false } })).toBe(false);
        expect(isToolAdvertised('git_commit', { prefs: { git: false } })).toBe(false);
    });
    it('disabling one group does not affect the other', () => {
        expect(isToolAdvertised('git_status', { prefs: { browser: false } })).toBe(true);
    });
    it('browser tools auto-hide when Playwright is unavailable', () => {
        expect(isToolAdvertised('browser_navigate', { playwrightUnavailable: true })).toBe(false);
        // …but git is unaffected by the Playwright flag.
        expect(isToolAdvertised('git_diff', { playwrightUnavailable: true })).toBe(true);
    });
});
