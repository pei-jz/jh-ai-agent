#!/usr/bin/env node
// make-third-party-notices — collect the licence texts we are obliged to ship.
//
// MIT, BSD and Apache-2.0 all permit redistribution on the condition that the
// copyright notice and permission text travel with the copies. That condition
// is not satisfied by naming the licence: the text has to be there. And it
// applies to the installer, not only to the source tree — Rust crates are
// compiled INTO the executable and npm packages are bundled INTO dist/, so a
// built installer is a redistribution of all of them.
//
// This is generated rather than written because a hand-maintained list is
// correct only until the next `npm install`, and a stale notice is not a
// notice. What cannot be derived — the provenance of the prebuilt .wasm files,
// why the font is vendored — lives in scripts/notices-preamble.md and is
// carried through verbatim.
//
//   npm run notices
//
// Two graphs are walked, and each one ends up inside the shipped artifact:
//   - npm `dependencies`, transitively — Vite bundles these into dist/
//   - Rust crates for the shipped target — linked into the exe

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

/** Filenames that hold a licence body. */
const LICENSE_FILES = /^(LICEN[CS]E|COPYING|NOTICE)([-.].*)?$/i;

/** Read every licence body sitting directly in a package directory. */
function licenseTextFrom(dir) {
    if (!dir || !existsSync(dir)) return null;
    let names;
    try { names = readdirSync(dir); } catch { return null; }
    const hits = names.filter(n => LICENSE_FILES.test(n)).sort();
    const parts = [];
    for (const n of hits) {
        try {
            const body = readFileSync(join(dir, n), 'utf8').trim();
            if (body) parts.push(hits.length > 1 ? `--- ${n} ---\n${body}` : body);
        } catch { /* unreadable: skip rather than fail the whole run */ }
    }
    return parts.length ? parts.join('\n\n') : null;
}

// ---------------------------------------------------------------- npm

// `dependencies` only, transitively. devDependencies build the app but are not
// in it, so their notices are not required — and including them would bury the
// ones that are.
function collectNpm() {
    const seen = new Map();
    const rootPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

    // npm hoists, so a package's own dependencies may sit in any node_modules
    // between it and the root. Walk up the way Node resolution does.
    const resolve = (name, fromDir) => {
        let dir = fromDir;
        for (;;) {
            const cand = join(dir, 'node_modules', name);
            if (existsSync(join(cand, 'package.json'))) return cand;
            const up = dirname(dir);
            if (up === dir) return null;
            dir = up;
        }
    };

    const walk = (name, fromDir) => {
        const dir = resolve(name, fromDir);
        if (!dir) return;                        // optional dep not installed
        let pkg;
        try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
        catch { return; }

        const key = `${pkg.name}@${pkg.version}`;
        if (seen.has(key)) return;
        seen.set(key, {
            name: pkg.name,
            version: pkg.version,
            license: pkg.license || pkg.licenses?.[0]?.type || null,
            homepage: pkg.homepage || pkg.repository?.url || pkg.repository || null,
            text: licenseTextFrom(dir),
        });
        for (const dep of Object.keys(pkg.dependencies || {})) walk(dep, dir);
    };

    for (const dep of Object.keys(rootPkg.dependencies || {})) walk(dep, repo);
    return [...seen.values()];
}

// --------------------------------------------------------------- cargo

// --filter-platform matters: without it the graph carries crates that only
// build for Android, macOS or wasm. Listing dependencies of a platform we do
// not ship is not more careful, it is less accurate, and it hides the ones we
// do ship in the noise.
const TARGET = process.env.NOTICES_TARGET || 'x86_64-pc-windows-msvc';

function collectCargo() {
    let meta;
    try {
        const out = execFileSync(
            'cargo',
            ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET],
            { cwd: join(repo, 'src-tauri'), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
        );
        meta = JSON.parse(out);
    } catch (e) {
        die('cargo metadata failed, so the Rust notices would be missing: '
            + String(e.message || e).split('\n')[0]);
    }

    const members = new Set(meta.workspace_members || []);
    const byId = new Map(meta.packages.map(p => [p.id, p]));
    const ids = (meta.resolve?.nodes || []).map(n => n.id).filter(id => !members.has(id));

    return ids.map(id => byId.get(id)).filter(Boolean).map(p => ({
        name: p.name,
        version: p.version,
        license: p.license || (p.license_file ? 'see licence file' : null),
        homepage: p.repository || p.homepage || null,
        text: licenseTextFrom(p.manifest_path ? dirname(p.manifest_path) : null),
    }));
}

// -------------------------------------------------------------- output

// Identical bodies are printed once.
//
// The Apache-2.0 text is the same in every crate that uses it and repeats
// several hundred times across the windows-sys family alone. Repeating it adds
// no information and buries the ones that ARE unique — an MIT body differs only
// in its copyright line, which is exactly the part the licence requires. The
// obligation is that the notice is present and attributable, not that each
// package gets its own copy.
function section(title, items, intro = '') {
    const lines = [`## ${title}`, ''];
    if (intro) lines.push(intro, '');
    if (!items.length) { lines.push('_(none)_', ''); return lines.join('\n'); }

    const groups = new Map();
    for (const it of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = it.text || `__no-text__:${it.license || 'unknown'}`;
        if (!groups.has(key)) groups.set(key, { text: it.text, members: [] });
        groups.get(key).members.push(it);
    }

    lines.push(`${items.length} package(s); ${groups.size} distinct licence text(s).`, '');

    let n = 0;
    for (const g of groups.values()) {
        n += 1;
        const head = g.members.length === 1
            ? `${g.members[0].name} ${g.members[0].version || ''}`.trim()
            : `${g.members[0].name} and ${g.members.length - 1} other(s)`;
        lines.push(`### ${n}. ${head}`, '');
        for (const m of g.members) {
            const url = m.homepage
                ? ` — ${String(m.homepage).replace(/^git\+/, '').replace(/\.git$/, '')}`
                : '';
            const supplied = m.supplied
                ? ' — the package ships no copy of its licence; the canonical Apache-2.0 text below applies'
                : '';
            lines.push(`- \`${m.name}${m.version ? ' ' + m.version : ''}\` (${m.license || 'licence not declared'})${url}${supplied}`);
        }
        lines.push('');
        if (g.text) lines.push('```text', g.text, '```', '');
        else lines.push(
            '> This package declares its licence but ships no copy of the text, and the '
            + 'text for this licence carries a copyright line that cannot be supplied '
            + 'from elsewhere. The declaration above and the URL are the notice.', '');
    }
    return lines.join('\n');
}

// A package can declare a licence and ship no copy of it — 20-odd crates in
// this graph do. Where the declared licence includes Apache-2.0 the gap is
// closable: that text names no copyright holder, so the canonical copy is the
// same text the package would have shipped, and we already carry one at
// LICENSE-APACHE. MIT and BSD are different — their body carries a copyright
// line we would have to invent — so those keep the URL and say so plainly.
const APACHE = readFileSync(join(repo, 'LICENSE-APACHE'), 'utf8').trim();

function fillApache(items) {
    for (const it of items) {
        if (!it.text && /apache-2\.0/i.test(it.license || '')) {
            it.text = APACHE;
            it.supplied = true;
        }
    }
    return items;
}

const npm = fillApache(collectNpm());
if (!npm.length) die('no npm dependencies were found. Is node_modules installed?');
const cargo = fillApache(collectCargo());

const preamble = readFileSync(join(repo, 'scripts/notices-preamble.md'), 'utf8');
if (!preamble.includes('{{GENERATED}}')) {
    die('scripts/notices-preamble.md has no {{GENERATED}} marker to substitute into');
}

const stamp = new Date().toISOString().slice(0, 10);
const generated = [
    `_Sections 3 and 4 were generated ${stamp} from the dependency graphs._`,
    '',
    section('3. npm packages bundled into `dist/`', npm,
        'Runtime `dependencies`, transitively. `devDependencies` build the app but '
        + 'are not part of it.'),
    section(`4. Rust crates linked into the executable (${TARGET})`, cargo,
        'Every crate in the dependency graph for the shipped target. Compiling a '
        + 'crate into the binary is redistributing it.'),
].join('\n');

const outPath = join(repo, 'THIRD-PARTY-NOTICES.md');
const body = preamble.replace('{{GENERATED}}', generated);

// --check answers "is the committed file still a description of what ships?"
// without writing anything, so a release build can refuse to ship notices that
// no longer match the dependency graph. The date stamp moves on every run and
// is excluded: a regeneration that differs only by today's date is not
// staleness, and treating it as such would make the check cry wolf daily.
if (process.argv.includes('--check')) {
    const strip = (x) => x.replace(/_Sections 3 and 4 were generated [^_]*_/, '');
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (strip(current) !== strip(body)) {
        die('THIRD-PARTY-NOTICES.md no longer matches the dependency graph. '
            + 'Run `npm run notices` and commit the result.');
    }
    console.log('THIRD-PARTY-NOTICES.md is current.');
    process.exit(0);
}

writeFileSync(outPath, body, 'utf8');

console.log('wrote THIRD-PARTY-NOTICES.md');
console.log(`  npm    ${npm.length} package(s) (${npm.filter(x => x.text).length} with a licence body)`);
console.log(`  cargo  ${cargo.length} crate(s) (${cargo.filter(x => x.text).length} with a licence body) [${TARGET}]`);
