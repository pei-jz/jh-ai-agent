// @vitest-environment jsdom
//
// The settings section shows what a watcher is configured to DO.
//
// Recipes came later than watchers. Every watcher made before them — and Slack,
// which is never a recipe — keeps its configuration as plain fields, so a panel
// that only read `values` showed those watchers nothing but a name and an
// interval: a settings section with no settings in it. That is the case the
// user was actually looking at.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('../../../../modules/ai/triggers/RecipeRegistry.js', () => ({
    recipeRegistry: {
        refresh: async () => {},
        list: () => [],
        get: () => null,
        approvalFor: () => null,
        blockedReason: () => null,
    },
}));

const { default: WatcherPanel } = await import('../WatcherPanel.svelte');

afterEach(cleanup);

/** A pre-recipe URL watcher, exactly the shape found on disk. */
const LEGACY_HTTP = {
    id: 'wch_1', name: 'github-download', type: 'http', enabled: true,
    everySeconds: 1800, eventName: 'jhaiagent.release.downloaded',
    url: 'https://api.github.com/repos/x/y/releases/latest',
    watchPath: 'assets[].download_count', aggregate: 'sum',
    filterField: 'name', filterExclude: 'latest.json,.sig',
    equals: '',
    baseline: { stamp: '11', value: 11, parts: [['a.zip', 4], ['b.exe', 7]] },
    lastRunAt: Date.now(), lastOk: true, lastCount: 0,
};

function fakeManager(watchers) {
    const m = {
        watchers: [...watchers],
        reload: () => m.watchers,
        upsert: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(),
        runNow: vi.fn(async () => ({ events: [], ok: true })),
        onEvent: vi.fn(() => []),
    };
    return m;
}

const open = async (w) => {
    render(WatcherPanel, { props: { manager: fakeManager([w]), notify: () => {}, confirmDelete: () => true } });
    await fireEvent.click(screen.getByText(w.name));
};

describe('a watcher that predates recipes still shows its settings', () => {
    it('lists the fields it actually holds', async () => {
        await open(LEGACY_HTTP);
        const body = document.body.textContent;
        expect(body).toContain('https://api.github.com/repos/x/y/releases/latest');
        expect(body).toContain('assets[].download_count');
        expect(body).toContain('latest.json,.sig');
        expect(body).toContain('sum');
    });

    // An empty optional field is not a setting; printing it as a blank row
    // makes the list longer and says nothing.
    it('leaves the empty ones out', async () => {
        await open(LEGACY_HTTP);
        const rows = [...document.querySelectorAll('.wch-kv li')].map(li => li.textContent);
        expect(rows.some(r => r.trim().endsWith(''))).toBe(true);   // sanity: rows exist
        expect(rows.join(' ')).not.toContain('この値になったら');    // `equals` was ''
    });

    it('says a secret is stored without reading it back', async () => {
        await open({ ...LEGACY_HTTP, type: 'mail', host: 'imap.x', user: 'me@x' });
        const body = document.body.textContent;
        expect(body).toContain('（保存済み）');
        expect(body).not.toContain('imap-password');
    });
});

describe('the current value is a result, not a setting', () => {
    // It changes on every poll while nothing about the setup moves; reading the
    // settings meant scrolling past it.
    it('sits in the latest-result section', async () => {
        await open(LEGACY_HTTP);
        const secs = [...document.querySelectorAll('details.wch-sec')];
        const config = secs[0].textContent;
        const last = secs[secs.length - 1].textContent;
        expect(config).toContain('assets[].download_count');
        expect(config).not.toContain('現在の値');
        expect(last).toContain('現在の値');
    });

    it('opens the settings and nothing else', async () => {
        await open(LEGACY_HTTP);
        const secs = [...document.querySelectorAll('details.wch-sec')];
        expect(secs.map(s => s.open)).toEqual([true, false, false]);
    });
});
