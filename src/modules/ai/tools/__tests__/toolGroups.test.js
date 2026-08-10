import { describe, it, expect, afterEach } from 'vitest';
import { toolGroupOf, isToolAdvertised, readToolGroupState } from '../toolGroups.js';

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

describe('readToolGroupState', () => {
    afterEach(() => { delete globalThis.localStorage; });

    it('returns defaults when localStorage is unavailable', () => {
        expect(readToolGroupState()).toEqual({ prefs: {}, playwrightUnavailable: false, hasResources: false });
    });

    it('parses prefs JSON and the playwright-unavailable flag', () => {
        const store = { jhai_tool_groups: '{"browser":false,"git":true}', jhai_playwright_unavailable: '1' };
        globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null) };
        expect(readToolGroupState()).toEqual({ prefs: { browser: false, git: true }, playwrightUnavailable: true, hasResources: false });
    });

    it('tolerates malformed prefs JSON (falls back to defaults)', () => {
        globalThis.localStorage = { getItem: () => '{not json' };
        expect(readToolGroupState()).toEqual({ prefs: {}, playwrightUnavailable: false, hasResources: false });
    });

    it('missing keys → empty prefs, flag false', () => {
        globalThis.localStorage = { getItem: () => null };
        expect(readToolGroupState()).toEqual({ prefs: {}, playwrightUnavailable: false, hasResources: false });
    });
});

describe('resource tools — advertised only when an app publishes something', () => {
    it('classifies the resource tools as their own group', () => {
        expect(toolGroupOf('list_resources')).toBe('resources');
        expect(toolGroupOf('read_resource')).toBe('resources');
        expect(toolGroupOf('read_file')).toBe(null);
    });

    it('is HIDDEN by default — unlike browser/git, absence of evidence hides it', () => {
        expect(isToolAdvertised('read_resource', {})).toBe(false);
        expect(isToolAdvertised('list_resources', { hasResources: false })).toBe(false);
    });

    it('appears once a connected app has published resources', () => {
        expect(isToolAdvertised('read_resource', { hasResources: true })).toBe(true);
    });

    it('the user can still switch the group off while apps are publishing', () => {
        expect(isToolAdvertised('read_resource', { hasResources: true, prefs: { resources: false } })).toBe(false);
    });

    it('readToolGroupState carries the live flag through', () => {
        globalThis.localStorage = { getItem: () => null };
        expect(readToolGroupState({ hasResources: true }).hasResources).toBe(true);
        expect(readToolGroupState().hasResources).toBe(false);
    });
});
