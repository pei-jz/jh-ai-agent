// browserHandlers — browser automation tool handlers (Phase 2).
//
// Thin wrappers over BrowserBridge, which drives the Playwright worker process.
// Each handler takes the ToolExecutor instance as `ctx` (for onAgentStatus /
// resolvePath / onToolEvent) and returns a plain-text result for the LLM.
// I/O glue (excluded from the unit-coverage gate, like the other handler files).

import { browserBridge } from '../../browser/BrowserBridge.js';
import {
    markBrowserAvailable, markBrowserUnavailable, isMissingPlaywright, INSTALL_COMMAND,
} from '../../browser/playwrightState.js';

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
        markBrowserAvailable();
        return r;
    } catch (e) {
        const msg = e?.message || String(e);
        // Anything else is an ordinary failure — a bad selector, a timeout. Only
        // a MISSING Playwright may latch the gate; hiding the whole tool group
        // because one selector was wrong would be worse than the bug this fixes.
        if (!isMissingPlaywright(msg)) return `Error: ${method} failed — ${msg}`;
        // Playwright not installed/resolvable → record it so the browser tool
        // group auto-hides from the LLM (toolGroups.readToolGroupState).
        markBrowserUnavailable(msg);
        // This turn is also the LAST one that can say so: the tools are gone
        // from the next request, so a bare "failed" would leave the model
        // retrying and the user watching browsing quietly stop being an option
        // with no idea why. Say what happened, and where the way back is.
        return `Error: ${method} failed — ${msg}`
            + `\n[The browser tools are now switched OFF for this run and later ones, because nothing they do can work without Playwright.`
            + ` Do not retry them — continue with fetch_url, or tell the user what is missing.`
            + ` To turn them back on: run \`${INSTALL_COMMAND}\` in the project root, then Settings → ブラウザ操作 → re-check.]`;
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

/**
 * browser_screenshot — capture a PNG; path resolves inside the workspace.
 *
 * The file on disk is for the USER. The agent gets the picture itself: the PNG
 * is parked on ctx.pendingImages and the agent loop attaches it to the next
 * request (same route read_office uses for embedded diagrams). Until that was
 * wired the tool only ever told the model "a file exists at this path", which
 * is no help at all when the whole point is to look at the rendered page —
 * so an agent could drive a browser it could not see.
 */
export async function handleBrowserScreenshot(ctx, args, onAgentStatus) {
    const rel = args.path || `screenshot_${Date.now()}.png`;
    const abs = ctx.resolvePath ? ctx.resolvePath(rel) : rel;
    const r = await call(
        'screenshot',
        { path: abs, fullPage: !!args.fullPage, inline: true },
        onAgentStatus,
        `Capturing screenshot → ${rel}...`
    );
    if (typeof r === 'string') return r;
    ctx.onToolEvent?.('file_modified', { path: abs, action: 'create', diff: `+ screenshot (${r.bytes} bytes)` });
    return `Screenshot saved: ${abs} (${r.bytes} bytes)` + screenshotNote(ctx, r, rel);
}

/**
 * Attach the captured PNG for the next request and describe what happened.
 *
 * Three outcomes, and the model must be able to tell them apart — "no image
 * here" and "an image you are about to receive" call for opposite next moves:
 *   • inlined   → parked, and the note says so
 *   • too large → file only; re-take without fullPage to actually see it
 *   • absent    → a worker predating `inline` (it is rewritten on launch only
 *     when stale, so a running app can still hold the old one). Say nothing
 *     rather than promise an image that never arrives.
 */
function screenshotNote(ctx, r, rel) {
    if (typeof r.data === 'string' && r.data) {
        ctx.pendingImages?.push({
            data: `data:image/png;base64,${r.data}`,
            source: `browser_screenshot:${rel}`,
        });
        return '\n[The screenshot is attached to the NEXT message — look at it before deciding what to do next.]';
    }
    if (r.inline_skipped === 'too_large') {
        return '\n[Too large to show inline, so only the file was written.'
            + ' Re-take it without fullPage (viewport only) if you need to SEE the page.]';
    }
    return '';
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
