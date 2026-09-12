// @vitest-environment jsdom
//
// The catalogue exists because "how do I register this" was answered and "what
// should I automate" was not. What it must get right is small and specific:
// lead with the work, say why a model is needed, and never offer something that
// will fail on its first run because a server is missing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

const { default: JobCatalog } = await import('../JobCatalog.svelte');
const { normalizeRecipe } = await import('../../../../modules/ai/triggers/recipes/recipeFormat.js');

afterEach(cleanup);

const card = (over) => normalizeRecipe({
    name: 'x', description: 'd', engine: 'http', config: { url: 'https://x/y' },
    defaults: { eventName: 'e' }, job: { prompt: 'do it' }, ...over,
}, over.id);

const LEDGER = card({ id: 'ledger', name: '台帳に追記', needsAI: '本文の形が毎回違います', category: 'transcribe' });
const REPORT = card({ id: 'report', name: '日報', needsAI: '出力が文章です', category: 'write' });
const TICKETS = card({
    id: 'tickets', name: '課題の整理', needsAI: '優先度は読まないと決まりません',
    category: 'organize', requiresMcp: ['backlog'],
});
// A useful watcher with no reason to involve a model. It belongs in the watcher
// tab, not on the screen someone meets first.
const HEALTH = card({ id: 'health', name: '死活監視' });

const mount = (props = {}) => render(JobCatalog, {
    props: { recipes: [LEDGER, REPORT, TICKETS, HEALTH], configuredMcp: [], onPick: () => {}, ...props },
});

describe('the catalogue leads with the work', () => {
    it('groups by what it saves you, not by engine', () => {
        mount();
        const heads = [...document.querySelectorAll('.cat-group')].map(e => e.textContent);
        expect(heads).toEqual(['転記をなくす', '書く手間をなくす', '整理する']);
        // Not "http" / "mail" / "folder" — grouping by mechanism is the mistake
        // this whole redesign has been undoing.
        expect(heads.join()).not.toMatch(/http|mail|folder/);
    });

    it('shows the reason a model is needed, on every card', () => {
        mount();
        const whys = [...document.querySelectorAll('.cat-why')].map(e => e.textContent.trim());
        expect(whys).toHaveLength(3);
        expect(whys[0]).toContain('本文の形が毎回違います');
    });

    it('leaves out anything that cannot say why', () => {
        mount();
        expect(screen.queryByText('死活監視')).toBeNull();
    });
});

describe('a card that needs a server nobody configured', () => {
    it('names the server rather than saying "MCP required"', () => {
        mount();
        expect(screen.getByText(/backlog/)).toBeTruthy();
    });

    it('stops saying so once it is configured', () => {
        mount({ configuredMcp: ['backlog'] });
        expect(document.querySelector('.cat-need')).toBeNull();
    });

    it('is still clickable — the wizard is where you learn what to set up', async () => {
        const onPick = vi.fn();
        mount({ onPick });
        await fireEvent.click(screen.getByText('課題の整理'));
        expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
            id: 'tickets', missingMcp: ['backlog'],
        }));
    });
});

describe('the honest note about not needing this at all', () => {
    // The templates that do not need a model are left out of the catalogue, so
    // the honesty has to live somewhere. It lives here, as advice rather than
    // as a shelf of things labelled "you don't need this".
    it('names the cheaper pattern outright', () => {
        mount();
        expect(document.querySelector('.cat-foot').textContent).toContain('run_command');
    });

    it('offers a way out for anything not listed', async () => {
        const onCustom = vi.fn();
        mount({ onCustom });
        await fireEvent.click(screen.getByText('自分で作る'));
        expect(onCustom).toHaveBeenCalled();
    });
});
