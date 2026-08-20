// @vitest-environment jsdom
//
// The chat-history picker. It replaces `showHistoryModal()`, which built the
// dialog with `document.createElement`, attached `onclick` properties to the
// nodes, and — to refresh after deleting a row — removed the overlay from
// document.body and called itself again.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import HistoryModal from '../HistoryModal.svelte';

afterEach(() => cleanup());

const SESSIONS = [
    { id: 'a', title: 'Oldest', timestamp: 1_700_000_000_000, messages: [] },
    { id: 'c', title: 'Newest', timestamp: 1_700_000_200_000, messages: [] },
    { id: 'b', title: 'Middle', timestamp: 1_700_000_100_000, messages: [] },
];

function mountModal(props = {}) {
    const handlers = {
        onPick: vi.fn(), onDelete: vi.fn(), onClearAll: vi.fn(), onClose: vi.fn(),
    };
    const utils = render(HistoryModal, { props: { sessions: SESSIONS, activeId: 'c', ...handlers, ...props } });
    return { ...utils, ...handlers };
}

const rows = (c) => [...c.querySelectorAll('.ch-item')];

describe('the list', () => {
    it('shows the most recent conversation first', () => {
        const h = mountModal();
        expect(rows(h.container).map(r => r.querySelector('.ch-title').textContent))
            .toEqual(['Newest', 'Middle', 'Oldest']);
    });

    it('marks which conversation is open', () => {
        const h = mountModal();
        const active = rows(h.container).filter(r => r.classList.contains('is-active'));
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toMatch(/Newest/);
    });

    it('says so when there is no history', () => {
        const h = mountModal({ sessions: [] });
        expect(h.container.textContent).toMatch(/No history found/);
        expect(rows(h.container)).toHaveLength(0);
    });
});

describe('picking and deleting', () => {
    it('reports which conversation was chosen', async () => {
        const h = mountModal();
        await fireEvent.click(rows(h.container).find(r => /Middle/.test(r.textContent)));
        expect(h.onPick).toHaveBeenCalledWith('b');
    });

    // The delete button sits INSIDE the row: without stopPropagation, deleting a
    // conversation also opened it.
    it('deletes without also opening the row', async () => {
        const h = mountModal();
        const row = rows(h.container).find(r => /Oldest/.test(r.textContent));
        await fireEvent.click(row.querySelector('.ch-del'));
        expect(h.onDelete).toHaveBeenCalledWith('a', 'Oldest');
        expect(h.onPick).not.toHaveBeenCalled();
    });

    it('offers a wipe of everything', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.ch-clear-all'));
        expect(h.onClearAll).toHaveBeenCalled();
    });
});

describe('dismissal', () => {
    it('closes on the backdrop but not on the dialog itself', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.ch-modal'));
        expect(h.onClose).not.toHaveBeenCalled();
        await fireEvent.click(h.container.querySelector('.ch-overlay'));
        expect(h.onClose).toHaveBeenCalled();
    });

    it('closes on Escape', async () => {
        const h = mountModal();
        await fireEvent.keyDown(h.container.querySelector('.ch-overlay'), { key: 'Escape' });
        expect(h.onClose).toHaveBeenCalled();
    });

    it('closes from the ✖ button', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.ch-close'));
        expect(h.onClose).toHaveBeenCalled();
    });
});
