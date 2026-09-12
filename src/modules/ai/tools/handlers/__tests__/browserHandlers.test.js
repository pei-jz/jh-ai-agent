// browser_screenshot — the agent has to SEE the page, not just learn a file
// exists. These cover the three outcomes of the inline attachment, because the
// note is what tells the model whether an image is coming.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridge = vi.hoisted(() => ({ request: vi.fn(), stop: vi.fn() }));
vi.mock('../../../browser/BrowserBridge.js', () => ({ browserBridge: bridge }));

const { handleBrowserScreenshot } = await import('../browserHandlers.js');

const ctx = () => ({
    pendingImages: [],
    resolvePath: (p) => `/ws/${p}`,
    onToolEvent: vi.fn(),
});

beforeEach(() => { bridge.request.mockReset(); });

describe('browser_screenshot', () => {
    it('parks the PNG for the next request and says so', async () => {
        bridge.request.mockResolvedValue({ path: '/ws/a.png', bytes: 120, data: 'QUJD' });
        const c = ctx();

        const out = await handleBrowserScreenshot(c, { path: 'a.png' }, vi.fn());

        expect(c.pendingImages).toEqual([
            { data: 'data:image/png;base64,QUJD', source: 'browser_screenshot:a.png' },
        ]);
        expect(out).toContain('/ws/a.png');
        expect(out).toContain('attached to the NEXT message');
    });

    it('asks the worker to inline the capture', async () => {
        bridge.request.mockResolvedValue({ path: '/ws/a.png', bytes: 1, data: 'QQ==' });

        await handleBrowserScreenshot(ctx(), { path: 'a.png', fullPage: true }, vi.fn());

        expect(bridge.request).toHaveBeenCalledWith(
            'screenshot',
            { path: '/ws/a.png', fullPage: true, inline: true },
        );
    });

    // Silence here would leave the model waiting for a picture that never comes,
    // so an over-cap shot has to name the way out (drop fullPage).
    it('points at the viewport-only retake when the shot is over the cap', async () => {
        bridge.request.mockResolvedValue({ path: '/ws/a.png', bytes: 9e6, inline_skipped: 'too_large' });
        const c = ctx();

        const out = await handleBrowserScreenshot(c, { path: 'a.png', fullPage: true }, vi.fn());

        expect(c.pendingImages).toEqual([]);
        expect(out).toContain('fullPage');
        expect(out).not.toContain('attached to the NEXT message');
    });

    // A deployed worker is rewritten only when stale, so a running app can still
    // hold one that knows nothing about `inline`. Promising an image then is worse
    // than staying quiet.
    it('promises nothing when an older worker returns no image', async () => {
        bridge.request.mockResolvedValue({ path: '/ws/a.png', bytes: 120 });
        const c = ctx();

        const out = await handleBrowserScreenshot(c, { path: 'a.png' }, vi.fn());

        expect(c.pendingImages).toEqual([]);
        expect(out).toBe('Screenshot saved: /ws/a.png (120 bytes)');
    });

    // The turn that fails is the LAST one that can explain itself: the tools are
    // hidden from the next request, so the message has to carry both the cause
    // and the way back, or browsing just silently stops being an option.
    it('names the cause, the install and the way back when Playwright is missing', async () => {
        bridge.request.mockRejectedValue(new Error('Playwright is not installed'));
        const c = ctx();

        const out = await handleBrowserScreenshot(c, { path: 'a.png' }, vi.fn());

        expect(out).toContain('Playwright is not installed');
        expect(out).toContain('npx playwright install chromium');
        expect(out).toContain('switched OFF');
        expect(c.pendingImages).toEqual([]);
    });

    // Latching the gate on this would hide every browser tool over one timeout.
    it('leaves an ordinary failure as a plain error', async () => {
        bridge.request.mockRejectedValue(new Error('browser request timed out (screenshot)'));

        const out = await handleBrowserScreenshot(ctx(), { path: 'a.png' }, vi.fn());

        expect(out).toBe('Error: screenshot failed — browser request timed out (screenshot)');
    });
});
