// The CSP trap that only exists in the packaged build.
//
// Tauri does not serve the CSP from tauri.conf.json as written. At build time
// it adds a `nonce` attribute to every <style> element in the HTML
// (tauri-utils html.rs, `inject_nonce(document, "style", …)`) and appends that
// nonce to `style-src` when serving. Per the CSP spec, a single nonce makes
// the browser IGNORE 'unsafe-inline' — so the policy that actually runs is
// stricter than the one configured.
//
// J.H Editor shipped into this: its packaged build showed every modal at once
// with no theme applied, 73 violations, and none of it reproduced under
// `tauri dev` — the CSP is injected into bundled assets only.
//
// The blast radius here is larger. This app injects nearly all of its CSS at
// runtime as <style> elements (the `*.styles.js` modules), and Svelte compiles
// `style="width:{n}%"` to a style ATTRIBUTE. Both are inline styles. If
// 'unsafe-inline' were ever dropped from what runs, the packaged app would
// come up unstyled while `npm run dev` stayed perfect.
//
// Two things keep that from happening, and both are asserted here.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    .app.security.csp;

describe('the served CSP', () => {
    // Tauri rewrites `style-src` and nothing else. Declaring the specific
    // directives puts elements and attributes out of its reach: they are what
    // the browser consults for each, and they say what we configured.
    it('declares style-src-elem and style-src-attr, which Tauri does not touch', () => {
        expect(csp).toMatch(/style-src-elem [^;]*'unsafe-inline'/);
        expect(csp).toMatch(/style-src-attr [^;]*'unsafe-inline'/);
    });

    it('still allows inline styles through the base directive', () => {
        expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
    });
});

describe('the entry HTML', () => {
    // Belt to that braces: with no <style> element in the document there is no
    // style nonce for Tauri to add in the first place.
    const html = (p) => readFileSync(join(root, p), 'utf8');

    it('carries no <style> element — that is what would create the nonce', () => {
        expect(html('src/index.html')).not.toMatch(/<style[\s>]/i);
    });

    it('and neither does the build output, when there is one', () => {
        const built = join(root, 'dist/index.html');
        if (!existsSync(built)) return;       // nothing built yet; nothing to check
        expect(readFileSync(built, 'utf8')).not.toMatch(/<style[\s>]/i);
    });

    // Inline SCRIPTS are handled differently: tauri-codegen hashes them
    // (`inject_script_hashes`) and adds 'sha256-…' to script-src, which is why
    // the theme bootstrap in index.html runs even though script-src has no
    // 'unsafe-inline'. It relies on the script being in the HTML at build
    // time, which it is — this records why no allowance is needed for it.
    it('keeps the theme bootstrap inline, where Tauri can hash it', () => {
        expect(html('src/index.html')).toMatch(/localStorage\.getItem\('jhai_theme'\)/);
        expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    });
});
