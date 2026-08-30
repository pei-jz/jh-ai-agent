// The release-configuration trap that docs/RELEASING.md documents and nothing
// enforced: setting the signing public key while leaving createUpdaterArtifacts
// false. The build succeeds, the installer is produced, the .zip/.zip.sig are
// silently absent, and the failure only shows up as an update nobody receives.

import { describe, it, expect } from 'vitest';
import { checkRelease, PUBKEY_PLACEHOLDER } from '../releaseChecks.js';

const REAL_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=';

// A correctly packaged build. Each test states only its own deviation, so a
// new packaging rule does not have to be repeated in every fixture — and a
// test that says nothing about publishers keeps testing what it is named for.
const conf = (over = {}) => ({
    version: '1.0.0',
    productName: 'App',
    identifier: 'io.github.acme.app',
    ...over,
    bundle: {
        createUpdaterArtifacts: false,
        publisher: 'Acme',
        targets: ['nsis'],
        windows: { nsis: { installMode: 'both' } },
        ...(over.bundle || {}),
    },
    plugins: over.plugins || {
        updater: {
            pubkey: PUBKEY_PLACEHOLDER,
            endpoints: ['https://github.com/acme/app/releases/latest/download/latest.json'],
        },
    },
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

// ── Packaging identity ────────────────────────────────────────────────────
//
// These four are mistakes J.H Editor shipped and fixed afterwards. Same stack,
// same installer, same publisher, so they are asserted here instead of being
// remembered.

describe('the identifier', () => {
    it('FAILS on the template shape, which claims a domain nobody owns', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ identifier: 'com.jh-ai-agent.app' }) });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/domain nobody owns/);
    });

    // The reason it must be caught BEFORE the first release, not after.
    it('says that localStorage travels with it', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ identifier: 'com.thing.app' }) });
        expect(r.problems.join(' ')).toMatch(/WebView2 data directory/);
        expect(r.problems.join(' ')).toMatch(/CANNOT be changed after release/);
    });

    it('FAILS on the untouched Tauri scaffold', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ identifier: 'com.tauri.dev' }) });
        expect(r.ok).toBe(false);
    });

    it('FAILS when it claims a GitHub account other than the one publishing', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ identifier: 'io.github.someoneelse.app' }) });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/claims the GitHub account someoneelse/);
    });

    it('accepts the account that publishes the releases', () => {
        expect(checkRelease({ pkg: pkg(), conf: conf() }).ok).toBe(true);
    });
});

describe('the publisher', () => {
    // Unset, Tauri uses the identifier's second segment — "github" — so the
    // install reads as though GitHub shipped it.
    it('FAILS when unset, and says what Windows would show instead', () => {
        const c = conf();
        delete c.bundle.publisher;
        const r = checkRelease({ pkg: pkg(), conf: c });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/will show "github" as the publisher/);
    });
});

describe('the NSIS install mode', () => {
    it('FAILS when unset — the default never elevates', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({ bundle: { targets: ['nsis'], publisher: 'Acme', windows: {} } }),
        });
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/defaults to currentUser/);
        expect(r.problems.join(' ')).toMatch(/fails mid-copy/);
    });

    it('is not demanded of a build that does not produce an NSIS installer', () => {
        const r = checkRelease({
            pkg: pkg(),
            conf: conf({ bundle: { targets: ['deb'], publisher: 'Acme' } }),
        });
        expect(r.ok).toBe(true);
    });
});

describe('names that travel badly', () => {
    it('warns that a space in productName is rewritten on upload', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ productName: 'J.H AI Agent' }) });
        expect(r.ok).toBe(true);              // a warning, not a blocker
        expect(r.notes.join(' ')).toMatch(/GitHub rewrites it on upload/);
        expect(r.notes.join(' ')).toMatch(/make-latest-json/);
    });

    it('says nothing about a name without spaces', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ productName: 'JHAIAgent' }) });
        expect(r.notes.join(' ')).not.toMatch(/GitHub rewrites/);
    });

    it('notes "all" targets — compiling is not evidence of running', () => {
        const r = checkRelease({ pkg: pkg(), conf: conf({ bundle: { targets: 'all', publisher: 'Acme' } }) });
        expect(r.notes.join(' ')).toMatch(/never been run on/);
    });
});

describe('robustness', () => {
    it('does not throw on an empty or partial config', () => {
        expect(() => checkRelease({})).not.toThrow();
        expect(() => checkRelease({ pkg: {}, conf: {} })).not.toThrow();
        expect(() => checkRelease({ pkg: pkg(), conf: { version: '1.0.0' } })).not.toThrow();
    });
});
