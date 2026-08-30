// The installer's side of the portable question.
//
// The updater downloads the NSIS installer and runs it with /UPDATE and no /D,
// so it always writes to the REGISTERED install directory. A portable copy that
// accepted an update would leave the new version there while the copy being run
// stayed as it was: signature valid, download complete, relaunch successful,
// still the old build. Nothing observable goes wrong.
//
// Three pieces have to agree for the app to be able to tell which copy it is —
// the installer writes the location, the app reads it back, and both must name
// the same registry key. Nothing at runtime notices if they drift, so it is
// checked here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const hooks = read('src-tauri/nsis/hooks.nsh');

describe('the NSIS hooks', () => {
    it('are wired into the bundle', () => {
        expect(conf.bundle.windows.nsis.installerHooks).toBe('nsis/hooks.nsh');
    });

    // This file is spliced into Tauri's installer.nsi and compiled by makensis.
    // A non-ASCII byte there fails the BUILD, not a test — and by then the
    // failure is a NSIS compiler message about a line nobody wrote by hand.
    it('are ASCII only', () => {
        const bad = [...hooks].filter(c => c.charCodeAt(0) > 127);
        expect(bad, `non-ASCII characters: ${bad.join(' ')}`).toEqual([]);
    });

    it('record the install location under the bundle identifier', () => {
        expect(hooks).toContain(`WriteRegStr SHCTX "Software\\${conf.identifier}" "InstallLocation"`);
    });

    // SHCTX follows the install mode, and on uninstall it does not reliably
    // come back as the hive the value was written to. A key that outlives the
    // install tells a portable copy dropped into the old directory that it is
    // the installed build — the exact confusion this machinery exists to stop.
    it('delete the key from BOTH hives on uninstall', () => {
        expect(hooks).toContain(`DeleteRegKey HKCU "Software\\${conf.identifier}"`);
        expect(hooks).toContain(`DeleteRegKey HKLM "Software\\${conf.identifier}"`);
    });
});

describe('the app side', () => {
    const rust = read('src-tauri/src/commands/install.rs');

    it('reads the same key the installer writes', () => {
        // Via NOTIFY_APP_ID, which a Rust test pins to the bundle identifier —
        // so the constant cannot drift from either end.
        expect(rust).toContain('super::shell::NOTIFY_APP_ID');
        expect(rust).toMatch(/Software\\\{\}/);
    });

    it('looks in both hives, because either could hold an install', () => {
        expect(rust).toContain('["HKCU", "HKLM"]');
    });
});
