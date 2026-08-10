// What the Settings UI knows about each LLM provider.
//
// This table replaced FOUR parallel `switch (provider)` statements (row label +
// icon, key placeholder, URL placeholder, default base URL). They had already
// drifted: 'generic' was absent from two of them, so a generic OpenAI-compatible
// connection displayed the raw string "generic" and offered no placeholder help.
// The drift is what these tests exist to prevent.

import { describe, it, expect } from 'vitest';
import {
    allProviders, providerInfo, defaultBaseUrl, effectiveActiveId,
    validateInstance, suggestForProvider,
} from '../providers.js';

describe('the provider table is complete', () => {
    const EXPECTED = ['openai', 'anthropic', 'gemini', 'azure', 'ollama', 'generic'];

    it('offers every provider the app supports', () => {
        expect(allProviders().map(p => p.id)).toEqual(EXPECTED);
    });

    it('gives EVERY provider all four pieces of UI text', () => {
        // The drift this replaces was exactly a provider missing from one list.
        for (const p of allProviders()) {
            expect(p.label, `${p.id} label`).toBeTruthy();
            expect(p.icon, `${p.id} icon`).toBeTruthy();
            expect(p.keyHint, `${p.id} keyHint`).toBeTruthy();
            expect(p.urlHint, `${p.id} urlHint`).toBeTruthy();
            expect(p.model, `${p.id} model`).toBeTruthy();
        }
    });

    it('marks the local runtime as needing no key', () => {
        expect(providerInfo('ollama').keyless).toBe(true);
        expect(providerInfo('openai').keyless).toBe(false);
    });
});

describe('providerInfo', () => {
    it('describes a known provider', () => {
        const p = providerInfo('anthropic');
        expect(p.label).toBe('Anthropic Claude');
        expect(p.icon).toBe('brain');
        expect(p.known).toBe(true);
    });

    it('flags an UNKNOWN id instead of dressing it up as real', () => {
        // The old switch defaulted the label but kept the generic bot icon, so a
        // typo looked like a supported provider.
        const p = providerInfo('opnai');
        expect(p.known).toBe(false);
        expect(p.label).toBe('opnai');
        expect(p.icon).toBe('alert');
    });

    it('survives a missing id', () => {
        expect(providerInfo(undefined).label).toBe('(unknown)');
        expect(providerInfo(null).known).toBe(false);
    });

    it('gives Azure its own URL label — it is an endpoint, not an API base', () => {
        expect(providerInfo('azure').urlLabel).toBe('Endpoint URL');
        expect(providerInfo('openai').urlLabel).toContain('Optional');
    });
});

describe('defaultBaseUrl', () => {
    it('prefills the known endpoints', () => {
        expect(defaultBaseUrl('openai')).toBe('https://api.openai.com/v1');
        expect(defaultBaseUrl('ollama')).toBe('http://localhost:11434');
    });

    it('never guesses for GENERIC — the unknown endpoint is the whole point', () => {
        expect(defaultBaseUrl('generic')).toBe('');
    });

    it('is empty for an unknown provider', () => {
        expect(defaultBaseUrl('nope')).toBe('');
    });
});

describe('effectiveActiveId', () => {
    const list = [{ id: 'a' }, { id: 'b' }];

    it('honours a stored choice', () => {
        expect(effectiveActiveId(list, 'b')).toBe('b');
    });

    it('falls back to the FIRST when nothing is chosen', () => {
        // The agent uses the first one, so the ★ ACTIVE marker has to sit there —
        // otherwise it marks no row while a connection is quietly in use.
        expect(effectiveActiveId(list, null)).toBe('a');
    });

    it('falls back when the stored id no longer exists', () => {
        // e.g. the active connection was just deleted.
        expect(effectiveActiveId(list, 'deleted')).toBe('a');
    });

    it('is null with no connections at all', () => {
        expect(effectiveActiveId([], 'a')).toBe(null);
        expect(effectiveActiveId(null, null)).toBe(null);
    });
});

describe('validateInstance', () => {
    const ok = { provider: 'openai', name: 'Mine', model: 'gpt-4o', api_key: 'sk-x' };

    it('accepts a complete connection', () => {
        expect(validateInstance(ok)).toEqual([]);
    });

    it('requires a name and a model', () => {
        expect(validateInstance({ ...ok, name: '  ' }).join(' ')).toContain('name');
        expect(validateInstance({ ...ok, model: '' }).join(' ')).toContain('Model');
    });

    it('requires a key — except for a local runtime', () => {
        expect(validateInstance({ ...ok, api_key: '' }).join(' ')).toContain('API key');
        expect(validateInstance({ provider: 'ollama', name: 'L', model: 'qwen' })).toEqual([]);
    });

    it('requires a base URL for GENERIC, which has no default to fall back on', () => {
        const errs = validateInstance({ provider: 'generic', name: 'G', model: 'm', api_key: 'k' });
        expect(errs.join(' ')).toContain('Base URL');
        expect(validateInstance({ provider: 'generic', name: 'G', model: 'm', api_key: 'k', base_url: 'http://x/v1' })).toEqual([]);
    });

    it('reports EVERY problem at once', () => {
        // Refusing to save while saying nothing about which field was wrong was the
        // old behaviour.
        expect(validateInstance({ provider: 'openai' }).length).toBeGreaterThanOrEqual(3);
    });

    it('asks for a provider when none was picked', () => {
        expect(validateInstance({ name: 'n', model: 'm' }).join(' ')).toContain('provider');
    });
});

describe('suggestForProvider', () => {
    it('fills empty name and model', () => {
        expect(suggestForProvider('openai', {})).toEqual({
            name: 'OPENAI Connection', model: 'gpt-4o',
        });
    });

    it('NEVER overwrites something the user typed', () => {
        const out = suggestForProvider('openai', { name: 'My prod key', model: 'gpt-4o-mini' });
        expect(out.name).toBeUndefined();
        expect(out.model).toBeUndefined();
    });

    it('does replace a previous AUTO-generated name', () => {
        // "ANTHROPIC Connection" was itself a suggestion, so switching provider
        // should move it along rather than leaving a mismatched label.
        expect(suggestForProvider('gemini', { name: 'ANTHROPIC Connection', model: 'x' }).name)
            .toBe('GEMINI Connection');
        expect(suggestForProvider('gemini', { name: 'Old Instance', model: 'x' }).name)
            .toBe('GEMINI Connection');
    });

    it('suggests nothing for an unknown provider', () => {
        expect(suggestForProvider('nope', {})).toEqual({});
    });
});
