// releaseChecks — PURE consistency rules for a release build's configuration.
//
// docs/RELEASING.md documents the signing setup and then says this, about
// configuring the public key while forgetting to set `createUpdaterArtifacts`
// back to true:
//
//   「この組み合わせだけはエラーにならない」
//   (this is the one combination that produces no error)
//
// It produces no error because nothing checked it: `tauri build` succeeds, the
// installer appears, and the `.zip` / `.zip.sig` that the release needs are just
// absent. Nobody finds out until an update fails to reach anyone. A documented
// trap that the tooling does not enforce is still a trap, so these are the rules.
//
// Pure so they can be unit-tested without writing to the real tauri.conf.json —
// scripts/release-preflight.mjs does the file reading and the exit code.

/** What tauri.conf.json ships with until a real signing key exists. */
export const PUBKEY_PLACEHOLDER = 'REPLACE_WITH_YOUR_MINISIGN_PUBLIC_KEY';

/**
 * @param {{pkg: object, conf: object}} input parsed package.json / tauri.conf.json
 * @returns {{ok: boolean, problems: string[], notes: string[], signed: boolean}}
 */
export function checkRelease({ pkg = {}, conf = {} } = {}) {
    const updater = conf?.plugins?.updater ?? {};
    const pubkey = updater.pubkey ?? '';
    const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
    const artifacts = conf?.bundle?.createUpdaterArtifacts === true;
    const signed = !!pubkey && pubkey !== PUBKEY_PLACEHOLDER;

    const problems = [];
    const notes = [];

    if (signed && !artifacts) {
        problems.push(
            'A signing public key is configured but bundle.createUpdaterArtifacts is false. '
            + 'The build will succeed and produce NO .zip / .zip.sig, so there is nothing to '
            + 'attach to the release and no user will ever receive an update. '
            + 'Fix: set "createUpdaterArtifacts": true in src-tauri/tauri.conf.json.');
    }

    if (!signed && artifacts) {
        problems.push(
            'bundle.createUpdaterArtifacts is true but plugins.updater.pubkey is still the '
            + 'placeholder. The build will fail with "A public key has been found, but no '
            + 'private key". Fix: follow docs/RELEASING.md sections 1-2, or set '
            + '"createUpdaterArtifacts": false for an unsigned test build.');
    }

    if (pkg.version !== conf.version) {
        problems.push(
            `Version mismatch: package.json is ${pkg.version}, tauri.conf.json is ${conf.version}. `
            + 'Both feed the update check, so a mismatch makes the app either offer an update '
            + 'forever or never offer one. Fix: set both to the release version.');
    }

    if (signed) {
        const templated = endpoints.filter(u => /<org>|<repo>|example\.com/.test(String(u)));
        if (templated.length) {
            problems.push(
                `Update endpoint is still a template: ${templated.join(', ')}. `
                + 'Fix: point it at the real release host (docs/RELEASING.md section 2).');
        }
        if (endpoints.length === 0) {
            problems.push('A signing key is configured but plugins.updater.endpoints is empty.');
        }
    }

    // The documented pre-release state. NOT a failure: requiring a signing key
    // before someone can produce a single test build is the wrong order, which
    // is exactly why this default was chosen.
    if (!signed && !artifacts) {
        notes.push(
            'Updates are OFF for this build (no signing key, no updater artifacts). This is '
            + 'the documented default — the app says "automatic updates are not configured" '
            + 'rather than reporting an error. Fine for a test build; see docs/RELEASING.md '
            + 'before a real release.');
    }

    return { ok: problems.length === 0, problems, notes, signed };
}
