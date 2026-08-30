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
 * The owner/repo an update endpoint points at, or null.
 *
 * Only GitHub release URLs are recognised, because that is the shape the
 * endpoint takes and the only one this can check against a git remote.
 */
export function endpointRepo(url) {
    const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//);
    return m ? `${m[1]}/${m[2]}` : null;
}

/** The owner/repo of a git remote URL (https or ssh), or null. */
export function remoteRepo(url) {
    const s = String(url || '').trim();
    const m = s.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * @param {{pkg: object, conf: object, remote?: string}} input
 *   parsed package.json / tauri.conf.json, and the origin remote URL if known.
 * @returns {{ok: boolean, problems: string[], notes: string[], signed: boolean}}
 */
export function checkRelease({ pkg = {}, conf = {}, remote = '' } = {}) {
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

    // Does the endpoint point at THIS repository?
    //
    // It shipped pointing at `JH-Software/jh-ai-agent` while the remote was
    // `pei-jz/jh-ai-agent`. Nothing fails: the build succeeds, the app checks
    // for updates, gets a 404 and reports "up to date" forever. Worse, an
    // unclaimed org name is a name someone else can register — at which point
    // the update channel names their repository, and only the signature check
    // stands between that and running their code.
    //
    // Checked whether or not a key is configured: an endpoint that names the
    // wrong repo is wrong before it is signed, and this is when it is cheap.
    const remoteAt = remoteRepo(remote);
    if (remoteAt) {
        const wrong = endpoints
            .map(u => ({ url: u, at: endpointRepo(u) }))
            .filter(e => e.at && e.at.toLowerCase() !== remoteAt.toLowerCase());
        for (const e of wrong) {
            problems.push(
                `Update endpoint points at ${e.at} but the git remote is ${remoteAt}: ${e.url}. `
                + 'Update checks would 404 forever, and an unclaimed owner name can be '
                + 'registered by someone else. Fix: point the endpoint at the release '
                + 'repository, or change the remote if the endpoint is the correct one.');
        }
    } else if (endpoints.some(u => endpointRepo(u))) {
        notes.push(
            'Could not read a GitHub remote, so the update endpoint was not checked against '
            + 'it. Confirm by hand that it names the repository releases are published to.');
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

    // ── Packaging identity ────────────────────────────────────────────────
    //
    // Everything below is a mistake J.H Editor shipped into and had to fix
    // after the fact. Same stack, same installer, same publisher — so they are
    // checked here rather than remembered.

    const id = String(conf.identifier || '');

    // The identifier is the WebView2 data directory's name, and this app keeps
    // the theme, the workspace list and every draft in localStorage — which
    // lives under it. Changing it after a release does not migrate that: from
    // the user's side the settings are simply gone, and the old folder stays on
    // disk forever. So it can only be got right BEFORE the first release.
    //
    // Reverse-DNS also means a namespace you control. `com.<product>.app` names
    // a domain nobody registered; the convention for a project without one is
    // its GitHub account (Flathub requires exactly this).
    if (/^com\.tauri\./.test(id) || /^com\.[^.]+\.app$/.test(id)) {
        problems.push(
            `identifier is ${id}, which claims a domain nobody owns and is the shape the `
            + 'Tauri template ships. It is also the WebView2 data directory, so localStorage '
            + '(theme, workspaces, drafts) moves with it and CANNOT be changed after release '
            + 'without silently wiping it. Fix: io.github.<account>.<app>, now.');
    }

    // ...and if it names a GitHub account, it has to be the one publishing.
    const owner = (endpointRepo(endpoints[0]) || '').split('/')[0];
    const claimed = id.match(/^io\.github\.([^.]+)\./);
    if (owner && claimed && claimed[1].toLowerCase() !== owner.toLowerCase()) {
        problems.push(
            `identifier claims the GitHub account ${claimed[1]} but releases are published `
            + `from ${owner}.`);
    }

    // Windows shows the publisher in "Apps & features" and in the UAC prompt.
    // Tauri falls back to the identifier's SECOND segment when it is unset —
    // with io.github.* that reads "github", i.e. the install looks like it came
    // from GitHub rather than from us.
    if (!conf?.bundle?.publisher) {
        const fallback = id.split('.')[1] || '(none)';
        problems.push(
            `bundle.publisher is not set, so Windows will show "${fallback}" as the publisher `
            + '(Tauri falls back to the identifier\'s second segment). Fix: set bundle.publisher.');
    }

    const targets = conf?.bundle?.targets;
    const list = Array.isArray(targets) ? targets : [];
    if (targets === 'all') {
        notes.push(
            'bundle.targets is "all", so the build also produces bundles for platforms this '
            + 'app has never been run on. Compiling is not evidence. Consider listing only '
            + 'the tested targets.');
    }

    // Without installMode the NSIS default is currentUser, which does not ask
    // for elevation. Choosing Program Files then fails with "Error opening file
    // for writing" — AFTER the progress bar has started, leaving a half-install.
    if (list.includes('nsis') && !conf?.bundle?.windows?.nsis?.installMode) {
        problems.push(
            'NSIS is a bundle target but bundle.windows.nsis.installMode is unset, so it '
            + 'defaults to currentUser and never elevates. Installing to Program Files then '
            + 'fails mid-copy. Fix: "installMode": "both".');
    }

    // GitHub replaces spaces in a release asset's filename. Upload
    // `J.H AI Agent_0.1.0_x64-setup.exe` as-is and the URL written into
    // latest.json is not the URL it is served from: the signature is valid, the
    // release looks right, and no update ever arrives.
    if (/\s/.test(String(conf.productName || ''))) {
        notes.push(
            `productName contains a space, so tauri build names the installer with one and `
            + 'GitHub rewrites it on upload. Run `node scripts/make-latest-json.mjs`, which '
            + 'renames the artifact and writes the manifest from the renamed name.');
    }

    return { ok: problems.length === 0, problems, notes, signed };
}
