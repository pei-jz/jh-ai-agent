// @vitest-environment jsdom
//
// WatcherPanel — the form, now that the form IS the recipe.
//
// What this pins is the part a screenshot cannot: that the fields come from the
// recipe file rather than from a branch in here, that a credential goes to the
// credential store under its own field id, and that a recipe which executes
// something cannot be saved until someone has said they read it. The last one
// is the whole reason the app can run a user's script unattended without a
// sandbox — see docs/design/watcher-recipes.md.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

let invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

vi.mock('../../../../modules/ai/jobs/JobManager.js', () => ({
    jobManager: { refreshSources: () => {} },
}));

const { normalizeRecipe } = await import('../../../../modules/ai/triggers/recipes/recipeFormat.js');
const { default: WatcherPanel } = await import('../WatcherPanel.svelte');

afterEach(() => { cleanup(); invoke = vi.fn(async () => null); });

const HTTP_RECIPE = normalizeRecipe({
    name: 'CI が落ちた',
    engine: 'http',
    builtin: true,
    fields: [
        { key: 'repo', label: 'リポジトリ', type: 'text', required: true },
        { key: 'token', label: 'トークン', type: 'secret' },
    ],
    config: {
        url: 'https://api.example.com/{{repo}}/runs',
        headerName: 'Authorization', headerValue: 'Bearer {{token}}',
    },
    defaults: { everySeconds: 300, eventName: 'ci.failed' },
}, 'ci');

const SCRIPT_RECIPE = normalizeRecipe({
    name: '在庫チェック',
    engine: 'script',
    config: { command: 'python check.py', cwd: 'C:/work' },
    defaults: { everySeconds: 600, eventName: 'stock.low' },
}, 'stock');

function fakeManager(watchers = []) {
    const m = {
        watchers: [...watchers],
        reload: () => m.watchers,
        upsert: vi.fn((w) => { m.watchers.push(w); return w; }),
        remove: vi.fn(),
        setEnabled: vi.fn(),
        runNow: vi.fn(async () => ({ events: [], ok: true })),
    };
    return m;
}

function fakeRegistry(recipes) {
    return {
        approvals: {},
        refresh: async () => recipes,
        getAll: () => recipes,
        get: (id) => recipes.find(r => r.id === id) || null,
        problemsFor: () => [],
        approve: vi.fn(async function (id, recipe, values) {
            this.approvals[id] = { recipe: recipe.id, values };
        }),
        revoke: vi.fn(),
    };
}

/** Let the recipe list (loaded from a promise) reach the DOM. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('the form is generated from the recipe', () => {
    it('draws the recipe’s own fields, not a fixed set', async () => {
        render(WatcherPanel, {
            manager: fakeManager(), registry: fakeRegistry([HTTP_RECIPE, SCRIPT_RECIPE]),
        });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));

        expect(screen.getByLabelText('リポジトリ *')).toBeTruthy();
        // A secret is a password box, and the value never lands in the watcher.
        expect(screen.getByLabelText('トークン').getAttribute('type')).toBe('password');
        // The host it will reach is on screen BEFORE anything is saved.
        expect(screen.getByText('api.example.com')).toBeTruthy();
    });

    it('will not save while a required field is empty', async () => {
        const notify = vi.fn();
        const manager = fakeManager();
        render(WatcherPanel, {
            manager, registry: fakeRegistry([HTTP_RECIPE]), notify,
        });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));
        await fireEvent.click(screen.getByText('保存'));

        expect(manager.upsert).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalled();
    });

    it('stores the secret under its own field id and keeps it out of the watcher', async () => {
        const manager = fakeManager();
        const registry = fakeRegistry([HTTP_RECIPE]);
        render(WatcherPanel, { manager, registry, notify: vi.fn() });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));
        await fireEvent.input(screen.getByLabelText('リポジトリ *'), { target: { value: 'a/b' } });
        await fireEvent.input(screen.getByLabelText('トークン'), { target: { value: 'SECRET' } });
        await fireEvent.click(screen.getByText('保存'));
        await settle();

        const stored = invoke.mock.calls.find(([cmd]) => cmd === 'set_watcher_secret');
        expect(stored[1].id).toMatch(/^watcher-field:wch_\d+:token$/);
        expect(stored[1].password).toBe('SECRET');

        const saved = manager.upsert.mock.calls[0][0];
        expect(saved.values).toEqual({ repo: 'a/b' });
        expect(JSON.stringify(saved)).not.toContain('SECRET');
        // The approval is recorded with the SAVED values, so the first poll
        // checks the same thing the user was shown.
        expect(registry.approve).toHaveBeenCalled();
        expect(registry.approve.mock.calls[0][2]).toEqual({ repo: 'a/b' });
    });
});

describe('anything that executes has to be read first', () => {
    it('refuses to save a script recipe until the box is ticked', async () => {
        const manager = fakeManager();
        const registry = fakeRegistry([SCRIPT_RECIPE]);
        const notify = vi.fn();
        render(WatcherPanel, { manager, registry, notify });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));

        // The command is on screen — that is what is being agreed to.
        expect(screen.getByText('python check.py')).toBeTruthy();
        await fireEvent.click(screen.getByText('保存'));
        expect(manager.upsert).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalled();

        await fireEvent.click(screen.getByLabelText('内容を確認しました'));
        await fireEvent.click(screen.getByText('保存'));
        await settle();
        expect(manager.upsert).toHaveBeenCalled();
        expect(registry.approve).toHaveBeenCalled();
    });

    it('does not ask for a tick on a built-in that only fetches', async () => {
        const manager = fakeManager();
        render(WatcherPanel, {
            manager, registry: fakeRegistry([HTTP_RECIPE]), notify: vi.fn(),
        });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));
        // Asking on every save is how a confirmation becomes a reflex.
        expect(screen.queryByLabelText('内容を確認しました')).toBeNull();
    });
});

describe('a new watcher is never live the moment it exists', () => {
    it('saves disabled, recipe or not', async () => {
        const manager = fakeManager();
        render(WatcherPanel, {
            manager, registry: fakeRegistry([HTTP_RECIPE]), notify: vi.fn(),
        });
        await settle();
        await fireEvent.click(screen.getByText('＋ 監視を追加'));
        await fireEvent.input(screen.getByLabelText('リポジトリ *'), { target: { value: 'a/b' } });
        await fireEvent.click(screen.getByText('保存'));
        await settle();
        expect(manager.upsert.mock.calls[0][0].enabled).toBe(false);
    });
});
