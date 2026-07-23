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

let browser = null;
let context = null;
let page = null;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function loadPlaywright() {
    try {
        const pw = await import('playwright');
        return pw;
    } catch (e) {
        throw new Error(
            'Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'
        );
    }
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
