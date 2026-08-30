// @vitest-environment jsdom
//
// The Memory destination (docs/design/information-architecture.md §7 step 4).
//
// What is worth pinning is the thing the relocation was FOR: memory used to be
// in two places and neither could be navigated to. So: one workspace selector
// drives both halves, and the destination opens on the project the last run
// used rather than on an empty picker.
//
// The optimistic-write behaviour is carried over from ConfigRoot, where it was
// covered by config/__tests__/tabs.test.js. It is re-asserted here because the
// code moved and "it used to be tested" is not a property of the new file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const writeCards = vi.fn(async () => {});
const writeFacts = vi.fn(async () => {});
const readWorkspaceMemory = vi.fn(async () => ({ facts: [], episodes: [], cards: [] }));
vi.mock('../../../../modules/ai/memory/workspaceMemory.js', () => ({
    readWorkspaceMemory: (...a) => readWorkspaceMemory(...a),
    writeFacts: (...a) => writeFacts(...a),
    writeEpisodes: vi.fn(async () => {}),
    writeCards: (...a) => writeCards(...a),
    readOverview: vi.fn(async () => null),
    writeOverview: vi.fn(async () => {}),
    allowMemoryDir: vi.fn(async () => {}),
}));

import MemoryRoot from '../MemoryRoot.svelte';

const card = (over = {}) => ({
    id: 'L-1', type: 'lesson', signature: 'write_file|mismatch',
    trigger: { tool: 'write_file', ext: '.js' },
    symptom: 'old_text did not match', fix: 're-read first',
    hits: 1, costSteps: 4, disabled: false,
    first_seen: '2026-08-01', last_recurrence: '2026-08-10',
    ...over,
});

const CONFIG = { approved_projects: ['C:/proj', 'C:/other'] };

function mount(props = {}) {
    const notify = vi.fn();
    return { notify, ...render(MemoryRoot, { props: { notify, ...props } }) };
}

beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    writeCards.mockClear();
    writeCards.mockImplementation(async () => {});
    readWorkspaceMemory.mockClear();
    readWorkspaceMemory.mockImplementation(async () => ({ facts: [], episodes: [], cards: [] }));
    invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? CONFIG : ''));
});
afterEach(() => cleanup());

const wsInput = (c) => c.querySelector('.mem-ws-input');

describe('the Memory destination', () => {
    // The point of the move: it opens on the project you were just working in,
    // not on an empty picker you have to fill before seeing anything.
    it('opens on the workspace the last run used', async () => {
        localStorage.setItem('jhai_last_ws', 'C:/from-a-run');
        const { container } = mount();
        await waitFor(() => expect(wsInput(container).value).toBe('C:/from-a-run'));
        await waitFor(() => expect(readWorkspaceMemory).toHaveBeenCalledWith('C:/from-a-run', expect.anything()));
    });

    it('falls back to the first approved project when nothing has run', async () => {
        const { container } = mount();
        await waitFor(() => expect(wsInput(container).value).toBe('C:/proj'));
    });

    it('offers both halves of the subject in one place', async () => {
        const { container } = mount();
        await waitFor(() => expect(container.querySelectorAll('.mem-tab')).toHaveLength(2));
        const labels = [...container.querySelectorAll('.mem-tab')].map(b => b.textContent.trim());
        expect(labels.join(' ')).toMatch(/知っていること/);
        expect(labels.join(' ')).toMatch(/編集/);
    });

    it('opens on the editor when the route asked for it', async () => {
        const { container } = mount({ initialTab: 'edit' });
        await waitFor(() => {
            const on = container.querySelector('.mem-tab.is-on');
            expect(on.textContent).toMatch(/編集/);
        });
    });

    // ONE selector, not one per half — the split it replaced had two.
    it('drives both halves from a single workspace field', async () => {
        const { container } = mount();
        await waitFor(() => expect(wsInput(container)).toBeTruthy());
        readWorkspaceMemory.mockClear();

        // `bind:value` listens on `input`; a bare `change` never updates the
        // bound state, so both are dispatched the way a real edit does.
        await fireEvent.input(wsInput(container), { target: { value: 'C:/other' } });
        await fireEvent.change(wsInput(container));
        await waitFor(() => expect(readWorkspaceMemory).toHaveBeenCalledWith('C:/other', expect.anything()));

        // switching to the editor does not ask again for a different workspace
        await fireEvent.click([...container.querySelectorAll('.mem-tab')][1]);
        await waitFor(() => expect(wsInput(container).value).toBe('C:/other'));
    });

    it('remembers the chosen workspace for the next visit', async () => {
        const { container } = mount();
        await waitFor(() => expect(wsInput(container)).toBeTruthy());
        await fireEvent.input(wsInput(container), { target: { value: 'C:/other' } });
        await fireEvent.change(wsInput(container));
        await waitFor(() => expect(localStorage.getItem('jhai_last_ws')).toBe('C:/other'));
    });

    it('reports a read failure instead of showing an empty store', async () => {
        readWorkspaceMemory.mockImplementation(async () => { throw new Error('EACCES'); });
        const { container } = mount();
        await waitFor(() => expect(container.textContent).toMatch(/EACCES/));
    });
});

describe('switching a card off', () => {
    beforeEach(() => {
        readWorkspaceMemory.mockImplementation(async () => ({ facts: [], episodes: [], cards: [card()] }));
    });

    it('flips at once and persists — a toggle that waits on three file reads feels broken', async () => {
        const { container } = mount();
        const toggle = await waitFor(() => {
            const b = container.querySelector('.dm-toggle input');
            expect(b).toBeTruthy();
            return b;
        });
        await fireEvent.click(toggle);
        await waitFor(() => expect(writeCards).toHaveBeenCalled());
        const [, saved] = writeCards.mock.calls[0];
        expect(saved[0].disabled).toBe(true);
    });

    it('reverts the row when the write fails, and says why', async () => {
        writeCards.mockImplementation(async () => { throw new Error('EPERM'); });
        const { container, notify } = mount();
        const toggle = await waitFor(() => {
            const b = container.querySelector('.dm-toggle input');
            expect(b).toBeTruthy();
            return b;
        });
        await fireEvent.click(toggle);
        await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/cards\.jsonl/)));
    });
});
