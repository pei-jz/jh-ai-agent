// The app CSP must permit WebAssembly compilation.
//
// This is a config assertion rather than a unit test because the failure it
// guards has no visible symptom. tree-sitter's grammars are wasm, and
// web-tree-sitter is emscripten-built: its `Parser.init()` returns
//   initPromise = new Promise(resolveInitPromise => { … })
// — a promise with NO reject path. When CSP blocks WebAssembly.instantiate,
// emscripten's handler calls abort(), which throws inside an internal `.then`
// and leaves that promise PENDING FOREVER. Nothing rejects, so no try/catch
// fires; symbol_search simply stopped mid-run and the whole agent hung behind
// it (observed: a run stuck on "Searching symbols: …" for over 30 minutes).
//
// `'wasm-unsafe-eval'` is the narrow keyword for exactly this: it permits wasm
// compilation and does NOT enable eval() for JavaScript.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, '../../../../../src-tauri/tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const csp = conf?.app?.security?.csp || '';

describe('app CSP', () => {
    it('is configured at all', () => {
        expect(csp).toBeTruthy();
    });

    it('allows WebAssembly compilation (tree-sitter grammars)', () => {
        const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src'));
        expect(scriptSrc).toBeTruthy();
        expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    });

    it('does NOT loosen script execution beyond wasm', () => {
        // 'unsafe-eval' would also permit wasm, and a great deal else. If it
        // ever appears here it should be a deliberate, separate decision.
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).not.toContain("'unsafe-inline' 'self'; script-src");
    });
});
