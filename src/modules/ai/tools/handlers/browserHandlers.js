// browserHandlers — browser automation tool handlers (Phase 2).
//
// Thin wrappers over BrowserBridge, which drives the Playwright worker process.
// Each handler takes the ToolExecutor instance as `ctx` (for onAgentStatus /
// resolvePath / onToolEvent) and returns a plain-text result for the LLM.
// I/O glue (excluded from the unit-coverage gate, like the other handler files).

import { browserBridge } from '../../browser/BrowserBridge.js';

/**
 * Wrap a bridge call with a uniform error prefix so the LLM gets an actionable
 * message (e.g. the "playwright not installed" hint) instead of a thrown stack.
 */
async function call(method, params, onAgentStatus, label) {
    onAgentStatus?.(label);
    try {
        const r = await browserBridge.request(method, params);
        // A successful browser op proves Playwright is usable → clear any prior
        // "unavailable" flag so the tools are advertised again.
        try {
            if (typeof localStorage !== 'undefined') localStorage.removeItem('jhai_playwright_unavailable');
        } catch (_) { /* non-browser env */ }
        return r;
    } catch (e) {
        const msg = e?.message || String(e);
        // Playwright not installed/resolvable → record it so the browser tool
        // group auto-hides from the LLM (toolGroups.readToolGroupState).
        if (/not installed|not resolvable/i.test(msg)) {
            try {
                if (typeof localStorage !== 'undefined') localStorage.setItem('jhai_playwright_unavailable', '1');
            } catch (_) { /* non-browser env */ }
        }
        return `Error: ${method} failed — ${msg}`;
    }
}

/** browser_navigate — open a URL, returns page title + final URL. */
export async function handleBrowserNavigate(ctx, args, onAgentStatus) {
    if (!args.url) return 'Error: browser_navigate requires a url parameter.';
    const r = await call('navigate', { url: args.url }, onAgentStatus, `Opening ${args.url}...`);
    if (typeof r === 'string') return r;
    return `Navigated to: ${r.url}\nTitle: ${r.title}`;
}

/** browser_click — click an element by CSS selector. */
export async function handleBrowserClick(ctx, args, onAgentStatus) {
    if (!args.selector) return 'Error: browser_click requires a selector parameter.';
    const r = await call('click', { selector: args.selector }, onAgentStatus, `Clicking ${args.selector}...`);
    if (typeof r === 'string') return r;
    return `Clicked: ${r.clicked}`;
}

/** browser_type — fill an input/textarea by CSS selector. */
export async function handleBrowserType(ctx, args, onAgentStatus) {
    if (!args.selector) return 'Error: browser_type requires a selector parameter.';
    const r = await call(
        'type',
        { selector: args.selector, text: args.text ?? '', clear: args.clear !== false },
        onAgentStatus,
        `Typing into ${args.selector}...`
    );
    if (typeof r === 'string') return r;
    return `Typed into: ${r.typed}`;
}

/** browser_eval — run JS in the page and return its JSON-serialisable value. */
export async function handleBrowserEval(ctx, args, onAgentStatus) {
    if (!args.script) return 'Error: browser_eval requires a script parameter.';
    const r = await call('eval', { script: args.script }, onAgentStatus, 'Evaluating script in page...');
    if (typeof r === 'string') return r;
    let out;
    try { out = JSON.stringify(r.value, null, 2); } catch (_) { out = String(r.value); }
    return `Eval result:\n${out}`;
}

/** browser_content — return the page's rendered HTML (truncated). */
export async function handleBrowserContent(ctx, args, onAgentStatus) {
    const r = await call('content', {}, onAgentStatus, 'Reading page HTML...');
    if (typeof r === 'string') return r;
    return r.html;
}

/** browser_screenshot — capture a PNG; path resolves inside the workspace. */
export async function handleBrowserScreenshot(ctx, args, onAgentStatus) {
    const rel = args.path || `screenshot_${Date.now()}.png`;
    const abs = ctx.resolvePath ? ctx.resolvePath(rel) : rel;
    const r = await call(
        'screenshot',
        { path: abs, fullPage: !!args.fullPage },
        onAgentStatus,
        `Capturing screenshot → ${rel}...`
    );
    if (typeof r === 'string') return r;
    ctx.onToolEvent?.('file_modified', { path: abs, action: 'create', diff: `+ screenshot (${r.bytes} bytes)` });
    return `Screenshot saved: ${abs} (${r.bytes} bytes)`;
}

/** browser_close — close the browser + worker (frees resources). */
export async function handleBrowserClose(ctx, args, onAgentStatus) {
    onAgentStatus?.('Closing browser...');
    try {
        await browserBridge.request('close', {}, 10000);
    } catch (_) { /* best-effort */ }
    await browserBridge.stop();
    return 'Browser closed.';
}
