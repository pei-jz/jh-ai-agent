#!/usr/bin/env node
// make-latest-json — build the updater manifest from what was actually built.
//
// `tauri build` does not produce latest.json. `createUpdaterArtifacts: true`
// gets you the installer and its `.sig`; assembling the manifest is either a
// GitHub Action's job or yours. Building locally and publishing by hand makes
// it yours, and docs/RELEASING.md used to say "write this JSON" — which is the
// problem this script exists for. Every way of getting it wrong is silent:
// paste the wrong signature, point at the wrong file, keep last release's
// version, and the build succeeds, the release publishes, and the only symptom
// is a user saying updates never arrive.
//
// Three specific traps, each one a thing J.H Editor shipped:
//
//   1. GitHub rewrites spaces in an uploaded asset's filename. productName is
//      "J.H AI Agent", so the installer has spaces and the URL written here
//      would not be the URL it is served from. The file is RENAMED (not
//      copied — two byte-identical exes differing only in name is a choice
//      nobody should have to make correctly every release).
//   2. The bundle directory keeps every version ever built. Picking by suffix
//      alone means readdir order decides, and a manifest can end up naming
//      the new version with an old installer: signature valid, install
//      succeeds, nothing changes.
//   3. An unsigned build produces no `.sig`, which is only noticed when the
//      updater rejects the download.
//
//   node scripts/make-latest-json.mjs [--notes "what changed"]

import { readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
const tag = `v${version}`;

// owner/repo comes from the endpoint the app will actually query, so the
// manifest cannot disagree with the config it was built from.
const endpoint = conf.plugins?.updater?.endpoints?.[0];
if (!endpoint) die('plugins.updater.endpoints is not set');
const m = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\//);
if (!m) die(`cannot read owner/repo from the endpoint: ${endpoint}`);
const [, owner, repoName] = m;

const bundleDir = join(repo, 'src-tauri/target/release/bundle');
const nsisDir = join(bundleDir, 'nsis');
if (!existsSync(nsisDir)) die('no build output. Run `npm run tauri build` first');

const files = readdirSync(nsisDir);

const forVersion = files.filter(f => f.endsWith('-setup.exe') && f.includes(`_${version}_`));
if (forVersion.length === 0) {
    const others = files.filter(f => f.endsWith('-setup.exe'));
    die(others.length
        ? `no installer for ${version}. Present: ${others.join(', ')}. Rebuild.`
        : 'no installer (*-setup.exe) found');
}

const signed = forVersion.filter(f => files.includes(`${f}.sig`));
if (signed.length === 0) {
    die('the installer has no .sig. Set TAURI_SIGNING_PRIVATE_KEY and rebuild '
        + '(docs/RELEASING.md section 4).');
}

// A name with spaces is this build's fresh output; a name without is one this
// script already renamed. Prefer the former so a re-run is a no-op.
const installer = signed.find(f => /\s/.test(f)) || signed[0];

const signature = readFileSync(join(nsisDir, `${installer}.sig`), 'utf8').trim();
if (!signature) die('the signature file is empty');

// Is this build newer than the code it claims to be?
//
// Editing a file and then publishing without rebuilding produces a release
// that is correct in every checkable way — right version, valid signature,
// reachable URL — and simply does not contain the change. Nothing downstream
// can catch it, so it is caught here.
const newestSource = (() => {
    const roots = ['src', 'src-tauri/src', 'src-tauri/Cargo.toml',
                   'src-tauri/tauri.conf.json', 'package.json',
                   'THIRD-PARTY-NOTICES.md', 'LICENSE'];
    let newest = 0;
    const walk = (rel) => {
        const abs = join(repo, rel);
        if (!existsSync(abs)) return;
        const st = statSync(abs);
        if (st.isDirectory()) {
            for (const e of readdirSync(abs)) {
                if (e === 'node_modules' || e === 'target' || e === '__tests__') continue;
                walk(join(rel, e));
            }
        } else if (st.mtimeMs > newest) {
            newest = st.mtimeMs;
        }
    };
    roots.forEach(walk);
    return newest;
})();

const builtAt = statSync(join(nsisDir, installer)).mtimeMs;
if (newestSource > builtAt) {
    die(`the installer is older than the source (built ${new Date(builtAt).toISOString()}, `
        + `source last changed ${new Date(newestSource).toISOString()}). `
        + 'Publishing this ships a build without the latest changes, and nothing about the '
        + 'release would look wrong. Rebuild first.');
}

const assetName = installer.replace(/\s+/g, '.');
if (assetName !== installer) {
    for (const [from, to] of [[installer, assetName], [`${installer}.sig`, `${assetName}.sig`]]) {
        rmSync(join(nsisDir, to), { force: true });   // leftovers from a previous build
        renameSync(join(nsisDir, from), join(nsisDir, to));
    }
}

const notesArg = process.argv.indexOf('--notes');
const notes = notesArg !== -1 ? process.argv[notesArg + 1] : `J.H AI Agent ${version}`;

const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
        'windows-x86_64': {
            signature,
            url: `https://github.com/${owner}/${repoName}/releases/download/${tag}/${assetName}`,
        },
    },
};

const out = join(bundleDir, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('wrote ' + out);
console.log('');
console.log('Upload exactly these to the ' + tag + ' release:');
console.log('  ' + join(nsisDir, assetName));
console.log('  ' + join(nsisDir, assetName + '.sig'));
console.log('  ' + out);
if (assetName !== installer) {
    console.log('');
    console.log(`  note: renamed "${installer}" to "${assetName}".`);
    console.log('        Uploading the spaced name would not match the manifest URL.');
}
