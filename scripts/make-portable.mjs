#!/usr/bin/env node
// make-portable — package the built exe as a portable zip.
//
// `tauri build` produces an installer and nothing else. A portable build is for
// the machines where an installer is not an option: a locked-down work PC, a
// USB stick, or simply someone who wants to try the app without it writing to
// Program Files and the registry.
//
// It is assembled from the SAME `target/release` output the installer is built
// from, so there is no second build to keep in step.
//
// Two things the zip must carry besides the exe:
//
//   - the resource files (`bundle.resources`), read from tauri.conf.json rather
//     than listed here. Those are the licence texts we are obliged to
//     redistribute; an installer that ships them and a portable zip that does
//     not is the same omission, made twice as easily.
//   - a README saying this copy does not auto-update. The app enforces that
//     itself (commands/install.rs), but someone who unzips it should not have
//     to discover the policy from a dialog.
//
//   npm run release:portable

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = readFileSync(join(repo, 'src-tauri/Cargo.toml'), 'utf8');
const crateName = (cargo.match(/^name\s*=\s*"([^"]+)"/m) || [])[1];

const version = conf.version;
const product = conf.productName;
const releaseDir = join(repo, 'src-tauri/target/release');
if (!existsSync(releaseDir)) die('no build output. Run `npm run tauri build` first');

// Which file is the executable depends on whether the CLI renamed it, so it is
// found rather than assumed — a wrong guess here would silently zip up nothing.
const exeName = [conf.mainBinaryName, product, crateName]
    .filter(Boolean)
    .map(n => `${n}.exe`)
    .find(n => existsSync(join(releaseDir, n)));
if (!exeName) {
    const present = readdirSync(releaseDir).filter(f => f.endsWith('.exe'));
    die(`no executable found in target/release. Present: ${present.join(', ') || '(none)'}`);
}

// The build must not be older than the code it claims to be. Same reasoning as
// scripts/make-latest-json.mjs: a stale artifact is right in every checkable
// way and simply does not contain the change.
const newestSource = (() => {
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
        } else if (st.mtimeMs > newest) newest = st.mtimeMs;
    };
    ['src', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json',
     'THIRD-PARTY-NOTICES.md', 'LICENSE'].forEach(walk);
    return newest;
})();
if (newestSource > statSync(join(releaseDir, exeName)).mtimeMs) {
    die('the executable is older than the source. Rebuild before packaging.');
}

const outDir = join(releaseDir, 'bundle/portable');
const stageRoot = join(releaseDir, 'portable-staging');
const stage = join(stageRoot, product);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(join(releaseDir, exeName), join(stage, `${product}.exe`));

// Resource targets come from the config, so adding a resource to the installer
// adds it here too.
const resources = conf.bundle?.resources || {};
const targets = Array.isArray(resources)
    ? resources.map(p => basename(p))
    : Object.values(resources);
const missing = [];
for (const target of targets) {
    const from = join(releaseDir, target);
    if (!existsSync(from)) { missing.push(target); continue; }
    const to = join(stage, target);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
}
if (missing.length) {
    die('these resources are declared in bundle.resources but are missing from the '
        + `build output: ${missing.join(', ')}. Rebuild, so the portable zip carries `
        + 'the same licence files the installer does.');
}

// resources/ (the icon, and anything else Tauri stages there) travels as-is.
const resDir = join(releaseDir, 'resources');
if (existsSync(resDir)) {
    mkdirSync(join(stage, 'resources'), { recursive: true });
    for (const f of readdirSync(resDir)) {
        const from = join(resDir, f);
        if (statSync(from).isFile()) copyFileSync(from, join(stage, 'resources', f));
    }
}

writeFileSync(join(stage, 'README.txt'), [
    `${product} ${version} — portable`,
    '',
    'Unzip anywhere and run the executable. Nothing is written to Program Files',
    'and nothing is added to the registry, so there is no uninstaller: delete the',
    'folder and the app is gone.',
    '',
    'THIS COPY DOES NOT UPDATE ITSELF.',
    'An update is written to the location the installer registered, so it would',
    'never reach an unzipped copy. The app knows this and will not offer you one.',
    'To move to a newer version, download the next portable zip.',
    '',
    'Requires the Microsoft Edge WebView2 runtime, which ships with Windows 11 and',
    'with current Windows 10. The installer would fetch it if it were missing;',
    'this zip cannot, so install it from Microsoft if the window comes up blank.',
    '',
    'Settings, task history and API keys are stored per user, not in this folder:',
    'API keys go to Windows Credential Manager, the rest to the app data',
    'directory. Deleting this folder does not remove them.',
    '',
    'LICENSE, LICENSE-MIT, LICENSE-APACHE and THIRD-PARTY-NOTICES.md are included',
    'and apply to this copy.',
    '',
].join('\r\n'), 'utf8');

// Space-free from the start: this is a release asset, and GitHub rewrites
// spaces in uploaded filenames (see scripts/make-latest-json.mjs).
const zipName = `${product.replace(/\s+/g, '.')}_${version}_x64-portable.zip`;
mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
rmSync(zipPath, { force: true });

// Compress-Archive rather than a dependency: this script only runs on the
// machine that just produced a Windows build, and PowerShell is already there.
try {
    execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${stage.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
    die('Compress-Archive failed: ' + String(e.stderr || e.message || e).split('\n')[0]);
}
rmSync(stageRoot, { recursive: true, force: true });

const sha = createHash('sha256');
await new Promise((res, rej) => {
    createReadStream(zipPath).on('data', d => sha.update(d)).on('end', res).on('error', rej);
});

console.log('wrote ' + zipPath);
console.log(`  ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
console.log('  sha256 ' + sha.digest('hex'));
console.log('');
console.log('Attach it to the release alongside the installer. It is NOT part of');
console.log('latest.json — a portable copy is never offered an update.');
