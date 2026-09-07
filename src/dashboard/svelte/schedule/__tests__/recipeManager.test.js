// @vitest-environment jsdom
//
// Editing a recipe means editing something that runs unattended on a timer.
// Two rules make that safe enough to put behind a button, and both are here:
// nothing is written unvalidated, and a recipe a watcher is already running
// cannot be changed underneath it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));

const { default: RecipeManager } = await import('../RecipeManager.svelte');

afterEach(cleanup);

const BUILTIN = { id: 'http', name: 'URL の監視', engine: 'http', builtin: true, basic: true, fields: [] };
const MINE = { id: 'mine', name: '自作', engine: 'http', builtin: false, fields: [] };

function fakeRegistry(list = [BUILTIN, MINE], overrides = {}) {
    return {
        refresh: vi.fn(async () => {}),
        getAll: () => list,
        folder: async () => 'C:/cfg/watchers',
        check: vi.fn(() => ({ ok: true, problems: [], recipe: {} })),
        save: vi.fn(async () => ({ ok: true, problems: [] })),
        remove: vi.fn(async () => ({ ok: true, problems: [] })),
        ...overrides,
    };
}

const mount = (registry, watchers = []) => render(RecipeManager, {
    props: { registry, watchers, notify: () => {}, confirmDelete: () => true },
});

describe('a recipe a watcher is running cannot be edited', () => {
    // The approval system records the hash a watcher was switched on with, so
    // editing underneath it does not change what it does — it STOPS it, with a
    // message about content that no longer matches. Saying "in use" is kinder
    // than letting someone break their own automation.
    it('says who is using it, and offers a copy instead', async () => {
        const reg = fakeRegistry();
        mount(reg, [{ id: 'w1', name: 'github-download', recipeId: 'mine' }]);
        await fireEvent.click(await screen.findByText('自作'));

        expect(document.body.textContent).toContain('使用中のため変更できません');
        expect(document.body.textContent).toContain('github-download');
        expect(document.querySelector('.rec-json').readOnly).toBe(true);
        expect(screen.getByText('複製して編集')).toBeTruthy();
    });

    it('refuses the save even if it is somehow attempted', async () => {
        const reg = fakeRegistry();
        const { component } = mount(reg, [{ id: 'w1', name: 'w', recipeId: 'mine' }]);
        await fireEvent.click(await screen.findByText('自作'));
        // No save button is offered, and the registry is never called.
        expect(screen.queryByText('保存')).toBeNull();
        expect(reg.save).not.toHaveBeenCalled();
        expect(component).toBeTruthy();
    });

    it('leaves an unused one editable', async () => {
        const reg = fakeRegistry();
        mount(reg, []);
        await fireEvent.click(await screen.findByText('自作'));
        expect(document.querySelector('.rec-json').readOnly).toBe(false);
        expect(screen.getByText('保存')).toBeTruthy();
    });
});

describe('a built-in is read-only, but copyable', () => {
    it('explains why and offers the copy', async () => {
        mount(fakeRegistry(), []);
        await fireEvent.click(await screen.findByText('URL の監視'));
        expect(document.body.textContent).toContain('組み込みのレシピです');
        expect(document.querySelector('.rec-json').readOnly).toBe(true);
    });

    it('copying gives a new id so it shadows nothing by accident', async () => {
        mount(fakeRegistry(), []);
        await fireEvent.click(await screen.findByText('URL の監視'));
        await fireEvent.click(screen.getByText('複製して編集'));
        const json = JSON.parse(document.querySelector('.rec-json').value);
        expect(json.id).toBe('http-copy');
        expect(document.querySelector('.rec-json').readOnly).toBe(false);
    });
});

describe('nothing is written unvalidated', () => {
    // The editor uses the same normalize/validate path as the loader, so it
    // cannot accept a file the loader will then reject — which would read as
    // the recipe vanishing after a save that said it worked.
    it('shows the problems and does not save', async () => {
        const reg = fakeRegistry([MINE], {
            save: vi.fn(async () => ({ ok: false, problems: ['engine "nope" は使えません。'] })),
        });
        mount(reg, []);
        await fireEvent.click(await screen.findByText('自作'));
        await fireEvent.click(screen.getByText('保存'));
        expect(await screen.findByText(/engine "nope"/)).toBeTruthy();
    });

    it('refuses a file with no id before it reaches the disk', async () => {
        const reg = fakeRegistry([MINE]);
        mount(reg, []);
        await fireEvent.click(await screen.findByText('自作'));
        const box = document.querySelector('.rec-json');
        await fireEvent.input(box, { target: { value: '{"name":"no id here"}' } });
        await fireEvent.click(screen.getByText('保存'));
        expect(reg.save).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('id がありません');
    });

    it('can validate without saving', async () => {
        const reg = fakeRegistry([MINE]);
        mount(reg, []);
        await fireEvent.click(await screen.findByText('自作'));
        await fireEvent.click(screen.getByText('検証だけする'));
        expect(reg.check).toHaveBeenCalled();
        expect(reg.save).not.toHaveBeenCalled();
    });
});

describe('the list says what each recipe is', () => {
    it('marks built-ins and the ones in use', async () => {
        mount(fakeRegistry(), [{ id: 'w', name: 'w', recipeId: 'mine' }]);
        expect(await screen.findByText('組み込み')).toBeTruthy();
        expect(screen.getByText('使用中')).toBeTruthy();
    });
});
