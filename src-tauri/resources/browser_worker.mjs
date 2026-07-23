// worker.mjs — Playwright browser worker for JH AI Agent.
//
// A standalone Node process that wraps Playwright and speaks a tiny line-
// oriented JSON-RPC protocol over stdio (one JSON object per line, both ways).
// The frontend drives it through the Rust mcp_spawn/mcp_write/mcp_kill process
// bridge (BrowserBridge.js). Keeping Playwright in a separate process means the
// Tauri webview never loads the (heavy, optional) dependency, and a browser
// crash can't take down the agent UI.
//
// Protocol:
//   →  { id, method, params }        one request per line
//   ←  { id, result }  |  { id, error: { message } }
//
// Methods (all params optional unless noted):
//   launch      { headless?, browser? }                start browser (default chromium headless)
//   navigate    { url }                                goto URL, returns { title, url }
//   click       { selector }                           click element
//   type        { selector, text, clear? }             fill input
//   screenshot  { path?, fullPage? }                   save PNG, returns { path, bytes }
//   eval        { script }                             evaluate JS in page, returns { value }
//   content     {}                                     returns { html } (truncated)
//   close       {}                                     close browser
//
// The worker lazily imports 'playwright' on first use and exits non-zero with a
// clear message if it isn't installed (`npm i -D playwright` + `npx playwright install`).

import readline from 'node:readline';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let browser = null;
let context = null;
let page = null;
let _pwCache = null;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

/** Yield `start` and every ancestor directory up to the filesystem root. */
function* ancestors(start) {
    let cur = path.resolve(start);
    for (;;) {
        yield cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
}

/**
 * Load Playwright by ABSOLUTE path.
 *
 * The worker runs from the app config dir (materialised there so it survives
 * Vite bundling), so a bare `import('playwright')` resolves node_modules from
 * the config dir upward and NEVER reaches the project's install — the feature
 * looked permanently "not installed". Instead we anchor Node's own resolver
 * (createRequire) at candidate bases that DO sit at/below the project tree:
 *   1. JHAI_PLAYWRIGHT_BASE — a dir the Rust side found to contain
 *      node_modules/playwright (passed via env by BrowserBridge).
 *   2. process.cwd() and its ancestors — covers `npm run tauri dev` (cwd = project root).
 * require.resolve() walks node_modules up from the base, so any base within the
 * project tree finds it; we then dynamic-import the resolved entry by file URL.
 */
async function loadPlaywright() {
    if (_pwCache) return _pwCache;
    const bases = [];
    if (process.env.JHAI_PLAYWRIGHT_BASE) bases.push(process.env.JHAI_PLAYWRIGHT_BASE);
    bases.push(...ancestors(process.cwd()));
    for (const base of bases) {
        try {
            // The anchor file need not exist; it only fixes the resolver's start dir.
            const req = createRequire(path.join(base, 'package.json'));
            const entry = req.resolve('playwright');
            const mod = await import(pathToFileURL(entry).href);
            _pwCache = mod.default ?? mod;   // playwright is CJS → exports on .default/named
            return _pwCache;
        } catch (_) { /* try the next base */ }
    }
    // Last resort: bare import (works if playwright happens to be resolvable here).
    try {
        const mod = await import('playwright');
        _pwCache = mod.default ?? mod;
        return _pwCache;
    } catch (_) { /* fall through to the actionable error */ }
    throw new Error(
        'Playwright is not installed (or not resolvable from the project). ' +
        'Run in the project root: npm i -D playwright && npx playwright install chromium'
    );
}

async function ensurePage() {
    if (page) return page;
    const pw = await loadPlaywright();
    const browserType = pw.chromium; // chromium by default; keep it simple/optional
    browser = await browserType.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    return page;
}

const handlers = {
    async launch(params = {}) {
        const pw = await loadPlaywright();
        const name = params.browser || 'chromium';
        const browserType = pw[name] || pw.chromium;
        if (browser) { try { await browser.close(); } catch (_) {} }
        browser = await browserType.launch({ headless: params.headless !== false });
        context = await browser.newContext();
        page = await context.newPage();
        return { launched: true, browser: name };
    },

    async navigate(params = {}) {
        if (!params.url) throw new Error('navigate requires url');
        const p = await ensurePage();
        await p.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { title: await p.title(), url: p.url() };
    },

    async click(params = {}) {
        if (!params.selector) throw new Error('click requires selector');
        const p = await ensurePage();
        await p.click(params.selector, { timeout: 10000 });
        return { clicked: params.selector };
    },

    async type(params = {}) {
        if (!params.selector) throw new Error('type requires selector');
        const p = await ensurePage();
        if (params.clear) await p.fill(params.selector, '');
        await p.fill(params.selector, String(params.text ?? ''));
        return { typed: params.selector };
    },

    async screenshot(params = {}) {
        const p = await ensurePage();
        const path = params.path || `screenshot_${Date.now()}.png`;
        const buf = await p.screenshot({ path, fullPage: !!params.fullPage });
        return { path, bytes: buf.length };
    },

    async eval(params = {}) {
        if (!params.script) throw new Error('eval requires script');
        const p = await ensurePage();
        // eslint-disable-next-line no-eval
        const value = await p.evaluate(params.script);
        return { value };
    },

    async content() {
        const p = await ensurePage();
        let html = await p.content();
        const MAX = 200 * 1024;
        if (html.length > MAX) html = html.slice(0, MAX) + '\n[truncated]';
        return { html };
    },

    async close() {
        if (browser) { try { await browser.close(); } catch (_) {} }
        browser = context = page = null;
        return { closed: true };
    },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return;
    let req;
    try { req = JSON.parse(t); } catch (_) { return; }
    const { id, method, params } = req;
    const fn = handlers[method];
    if (!fn) { send({ id, error: { message: `unknown method: ${method}` } }); return; }
    try {
        const result = await fn(params || {});
        send({ id, result });
    } catch (e) {
        send({ id, error: { message: e?.message || String(e) } });
    }
});

process.on('SIGTERM', async () => { if (browser) { try { await browser.close(); } catch (_) {} } process.exit(0); });
