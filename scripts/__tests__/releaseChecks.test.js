// The release-configuration trap that docs/RELEASING.md documents and nothing
// enforced: setting the signing public key while leaving createUpdaterArtifacts
// false. The build succeeds, the installer is produced, the .zip/.zip.sig are
// silently absent, and the failure only shows up as an update nobody receives.

import { describe, it, expect } from 'vitest';
import { checkRelease, PUBKEY_PLACEHOLDER } from '../releaseChecks.js';

const REAL_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=';

const conf = (over = {}) => ({
    version: '1.0.0',
    bundle: { createUpdaterArtifacts: false },
    plugins: {
        updater: {
            pubkey: PUBKEY_PLACEHOLDER,
            endpoints: ['https://github.com/acme/app/releases/latest/download/latest.json'],
        },
    },
    ...over,
});
const pkg = (version = '1.0.0') => ({ version });

describe('the silent combination', () => {
    it('FAILS when a key is configured but updater artifacts are off', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({
                bundle: { createUpdaterArtifacts: false },
                plugins: { updater: { pubkey: REAL_KEY, endpoints: ['https://acme.test/latest.json'] } },
            }),
        });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/createUpdaterArtifacts/);
        expect(r.problems.join(' ')).toMatch(/no user will ever receive an update/);
    });

    it('passes once artifacts are turned back on', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({
                bundle: { createUpdaterArtifacts: true },
                plugins: { updater: { pubkey: REAL_KEY, endpoints: ['https://acme.test/latest.json'] } },
            }),
        });
        expect(r.ok).toBe(true);
        expect(r.signed).toBe(true);
    });
});

describe('the reverse combination', () => {
    it('FAILS when artifacts are on but the key is still the placeholder', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({ bundle: { createUpdaterArtifacts: true } }),
        });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/no private key/);
    });
});

describe('the documented pre-release default', () => {
    it('is NOT a failure — requiring a signing key for a test build is the wrong order', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf() });
        expect(r.ok).toBe(true);
        expect(r.signed).toBe(false);
        expect(r.notes.join(' ')).toMatch(/Updates are OFF/);
    });

    it('does not nag about endpoints while updates are off', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({
                plugins: { updater: { pubkey: PUBKEY_PLACEHOLDER, endpoints: [] } },
            }),
        });
        expect(r.ok).toBe(true);
    });
});

describe('version drift', () => {
    it('FAILS when package.json and tauri.conf.json disagree', () => {
        const r = checkRelease({ pkg: pkg('1.1.0'), conf: conf() });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/Version mismatch/);
    });
});

describe('endpoints, once signing is real', () => {
    const signed = (endpoints) => conf({
        bundle: { createUpdaterArtifacts: true },
        plugins: { updater: { pubkey: REAL_KEY, endpoints } },
    });

    it('FAILS on a template endpoint left from the docs', () => {
        const r = checkRelease({ pkg: pkg(), conf: signed(['https://github.com/<org>/<repo>/releases/latest/download/latest.json']) });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/still a template/);
    });

    it('FAILS when there is nowhere to check', () => {
        const r = checkRelease({ pkg: pkg(), conf: signed([]) });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/endpoints is empty/);
    });

    it('accepts a real endpoint', () => {
        const r = checkRelease({ pkg: pkg(), conf: signed(['https://github.com/acme/app/releases/latest/download/latest.json']) });
        expect(r.ok).toBe(true);
    });
});

describe('robustness', () => {
    it('does not throw on an empty or partial config', () => {
        expect(() => checkRelease({})).not.toThrow();
        expect(() => checkRelease({ pkg: {}, conf: {} })).not.toThrow();
        expect(() => checkRelease({ pkg: pkg(), conf: { version: '1.0.0' } })).not.toThrow();
    });
});
