// THIRD-PARTY-NOTICES.md is an obligation, not documentation.
//
// MIT, BSD and Apache-2.0 permit redistribution on the condition that the
// notice travels with the copy, and an installer is a copy. The failure mode
// is silence: add a dependency, ship, and nothing anywhere reports that the
// file no longer describes what is inside the binary.
//
// These are the cheap parts of that, checked without running the generator
// (which needs `cargo metadata` and a populated node_modules).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const notices = read('THIRD-PARTY-NOTICES.md');
const pkg = JSON.parse(read('package.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

describe('the notices file', () => {
    it('names every runtime dependency', () => {
        // The one that actually catches something: a dependency added since
        // the last `npm run notices`.
        for (const dep of Object.keys(pkg.dependencies || {})) {
            expect(notices, `${dep} is shipped but not in the notices`).toContain(dep);
        }
    });

    it('carries licence TEXT, not just licence names', () => {
        // The state this file was in before: a table of SPDX identifiers,
        // which is not what any of those licences ask for.
        expect(notices).toMatch(/Permission is hereby granted, free of charge/);
        expect(notices).toMatch(/Apache License/);
        expect(notices).toMatch(/```text/);
    });

    it('says it is generated, and by what', () => {
        expect(notices).toMatch(/generated .* from the dependency graphs/);
        expect(notices).toContain('scripts/make-third-party-notices.mjs');
    });

    it('keeps the hand-written provenance that no tool can derive', () => {
        // The tree-sitter grammars are three different copyright holders
        // across four repositories; that was established by hand and would be
        // lost if the whole file were generated.
        expect(notices).toContain('Maxim Sokolov');
        expect(notices).toContain('Ayman Nadeem');
        expect(notices).toMatch(/Inter/);
    });

    it('has a marker for the generator to substitute into', () => {
        expect(read('scripts/notices-preamble.md')).toContain('{{GENERATED}}');
    });
});

describe('reaching the person who installs', () => {
    // A notice that exists only in the repository does not travel with the
    // binary. The recipient of the installer never sees this checkout.
    it('ships the notices and our own licence inside the installer', () => {
        const resources = conf.bundle.resources;
        const shipped = Array.isArray(resources) ? resources : Object.keys(resources);
        const joined = shipped.join(' ');
        expect(joined).toContain('THIRD-PARTY-NOTICES.md');
        expect(joined).toContain('LICENSE');
    });

    it('shows the licence during installation', () => {
        // NSIS renders a licence page when bundle.licenseFile is set (and
        // skips it under /PASSIVE, which is how the updater runs it — an
        // update is not a new agreement).
        expect(conf.bundle.licenseFile).toBeTruthy();
    });
});
