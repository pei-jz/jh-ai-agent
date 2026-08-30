#!/usr/bin/env node
// release-preflight — refuse to build a release that cannot be updated.
//
// The rules live in ./releaseChecks.js (pure, unit-tested). This file is the
// file reading and the exit code, nothing else.
//
// Run: npm run release:preflight
// Exit: 0 = consistent, 1 = something would silently produce an unusable release.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkRelease } from './releaseChecks.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const pkg = read('package.json');
const conf = read('src-tauri/tauri.conf.json');
// The remote is read here rather than in the rules, which stay pure. A machine
// without git, or a checkout with no origin, simply skips that check.
let remote = '';
try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
} catch (_) { /* not a git checkout, or no origin */ }

const { ok, problems, notes, signed } = checkRelease({ pkg, conf, remote });

for (const n of notes) console.log(`note: ${n}\n`);

if (!ok) {
    console.error(`release-preflight: ${problems.length} problem(s) found.\n`);
    for (const p of problems) console.error(`  x ${p}\n`);
    process.exit(1);
}

console.log(`release-preflight: OK (version ${pkg.version}, updates ${signed ? 'signed' : 'off'}).`);
