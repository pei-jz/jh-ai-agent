// The two release scripts, checked for the things that break them silently.
//
// They are PowerShell, so nothing in the JS suite executes them. What can be
// asserted cheaply is the shape: that the encoding will not mangle their
// prompts, that the key never reaches a place it can be read back from, and
// that they call the tools that exist rather than the ones that used to.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = (p) => readFileSync(join(root, p));
const text = (p) => raw(p).toString('utf8');

const BUILD = 'scripts/build-release.ps1';
const PUBLISH = 'scripts/publish-release.ps1';

describe('encoding', () => {
    // Windows PowerShell 5.1 reads a .ps1 with no BOM as ANSI. Every Japanese
    // string in these scripts — including the "enter your passphrase" prompt —
    // would come out as mojibake, on the one run where the operator most needs
    // to know what is being asked of them.
    it.each([BUILD, PUBLISH])('%s starts with a UTF-8 BOM', (p) => {
        expect([...raw(p).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    });
});

describe('the signing key', () => {
    const build = text(BUILD);

    // A passphrase given as a parameter lands in ConsoleHost_history.txt in
    // cleartext and stays there.
    it('is never a parameter — it is read as a SecureString', () => {
        expect(build).toContain('-AsSecureString');
        expect(build).not.toMatch(/\[string\]\s*\$Pass/i);
        expect(build).not.toMatch(/\[string\]\s*\$Password/i);
    });

    // The env vars must not outlive the build, including when it fails.
    it('is removed from the environment in a finally block', () => {
        expect(build).toContain('Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY ');
        expect(build).toContain('Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD ');
        const finallyIdx = build.lastIndexOf('} finally {');
        expect(build.indexOf('Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY '))
            .toBeGreaterThan(build.indexOf('$env:TAURI_SIGNING_PRIVATE_KEY ='));
        expect(finallyIdx).toBeGreaterThan(-1);
    });

    // Handing over the public key by mistake builds fine and simply does not
    // sign — the failure appears later, as an update nobody can install.
    it('refuses a public key', () => {
        expect(build).toContain('minisign public key');
    });

    it('is never echoed', () => {
        expect(build).not.toMatch(/Write-(Host|Output).*\$keyValue/);
        expect(build).not.toMatch(/Write-(Host|Output).*\$passValue/);
    });
});

describe('what the build script runs', () => {
    const build = text(BUILD);

    it('checks the release config and the notices before building', () => {
        expect(build).toContain('npm run release:preflight');
        expect(build).toContain('make-third-party-notices.mjs --check');
    });

    it('produces the manifest and the portable zip', () => {
        expect(build).toContain('node scripts/make-latest-json.mjs');
        expect(build).toContain('node scripts/make-portable.mjs');
    });

    it('runs both test suites', () => {
        expect(build).toContain('npm test');
        expect(build).toContain('cargo test');
    });

    // A leftover bundle from an earlier build is a second candidate to upload,
    // identical in every way a human checks.
    it('clears the previous bundle directory first', () => {
        expect(build).toMatch(/Remove-Item \$bundle -Recurse -Force/);
    });
});

describe('what the publish script refuses', () => {
    const publish = text(PUBLISH);

    it('an installer whose name has a space', () => {
        // GitHub rewrites it on upload, so the manifest URL would not resolve.
        expect(publish).toMatch(/インストーラ名に空白がある/);
    });

    it('a manifest URL that does not match the file or the tag', () => {
        expect(publish).toContain('$urlName -ne $installer.Name');
        expect(publish).toMatch(/download\/\$\(\[regex\]::Escape\(\$Tag\)\)/);
    });

    it('a release left as a draft', () => {
        // A draft is not in releases/latest and its asset URLs are temporary.
        expect(publish).toContain('--draft=false');
    });

    it('and checks the real endpoint afterwards', () => {
        expect(publish).toContain('Invoke-WebRequest -Uri $endpoint');
    });
});
