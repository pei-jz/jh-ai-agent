// @vitest-environment jsdom
//
// The Monitor's three small overlays after migration. The API-call tab rules are
// in views/monitor/__tests__/apiCallView.test.js; this covers the dialogs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

import { t } from '../../../../i18n/index.js';
import ApiCallModal from '../ApiCallModal.svelte';
import AllowlistModal from '../AllowlistModal.svelte';
import ImageZoom from '../ImageZoom.svelte';

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

const ENTRY = {
    method: 'CHAT', status: 200, duration: 420,
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    request: {
        sent_request: '{"model":"gpt-4o"}',
        model: 'gpt-4o',
        system_prompt: 'You are helpful.',
        history: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'read_file' }],
    },
    response: 'the answer',
};

describe('ApiCallModal', () => {
    const mountModal = (props = {}) => {
        const onClose = vi.fn();
        return { ...render(ApiCallModal, { props: { entries: [ENTRY], onClose, ...props } }), onClose };
    };

    it('titles itself with the call count and what they cost', () => {
        const h = mountModal();
        expect(h.container.querySelector('.mchat-title').textContent)
            .toMatch(/API Calls \(1\).*↑100t ↓20t.*420ms/);
    });

    it('shows the call headline: method, status, duration and usage', () => {
        const h = mountModal();
        const meta = h.container.querySelector('.mchat-entry-meta').textContent;
        expect(meta).toContain('CHAT');
        expect(meta).toContain('200');
        expect(meta).toContain('420ms');
        expect(meta).toContain('total: 120 tokens');
    });

    it('marks a failed call differently from a successful one', () => {
        const h = mountModal({ entries: [{ ...ENTRY, status: 500 }] });
        expect(h.container.querySelector('.mlog-tele-status-err')).toBeTruthy();
        expect(h.container.querySelector('.mlog-tele-status-ok')).toBeNull();
    });

    // The as-sent body is the request as actually thrown at the provider.
    it('opens on the as-sent body and shows only that panel', () => {
        const h = mountModal();
        expect(h.container.querySelector('.mchat-subtab.active').textContent).toMatch(/Sent/);
        expect(h.container.querySelectorAll('.mchat-pre')).toHaveLength(1);
        expect(h.container.querySelector('.mchat-pre').textContent).toContain('gpt-4o');
    });

    it('switches panels when another tab is clicked', async () => {
        const h = mountModal();
        const historyTab = [...h.container.querySelectorAll('.mchat-subtab')].find(b => /History/.test(b.textContent));
        await fireEvent.click(historyTab);
        await waitFor(() => expect(h.container.querySelector('.mchat-pre').textContent).toContain('[0] user'));
        expect(h.container.querySelector('.mchat-subtab.active').textContent).toMatch(/History/);
    });

    // Two entries used to share one delegated handler keyed by a data-grp string.
    it('keeps each entry\'s open tab independent', async () => {
        const h = mountModal({ entries: [ENTRY, ENTRY] });
        const entries = h.container.querySelectorAll('.mchat-entry');
        const second = [...entries[1].querySelectorAll('.mchat-subtab')].find(b => /Response/.test(b.textContent));
        await fireEvent.click(second);
        await waitFor(() => {
            expect(entries[1].querySelector('.mchat-subtab.active').textContent).toMatch(/Response/);
            expect(entries[0].querySelector('.mchat-subtab.active').textContent).toMatch(/Sent/);
        });
    });

    it('copies the VISIBLE tab and says so', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.mchat-copy'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('gpt-4o')));
        await waitFor(() => expect(h.container.querySelector('.mchat-copy').textContent).toMatch(/Copied/));
    });

    it('survives a blocked clipboard', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async () => { throw new Error('denied'); } }, configurable: true,
        });
        const h = mountModal();
        await expect(fireEvent.click(h.container.querySelector('.mchat-copy'))).resolves.toBeDefined();
    });

    it('says so when a step recorded no calls', () => {
        const h = mountModal({ entries: [] });
        expect(h.container.textContent).toMatch(/No API calls recorded/);
    });

    // Listing and replay strip the heavy fields; the full record is fetched only
    // for the calls actually opened.
    it('fetches the full payload for a stripped entry', async () => {
        const getTaskLogEntry = vi.fn(async () => ({
            data: { request: { history: [{ role: 'user', content: 'RESTORED' }] }, response: 'full' },
        }));
        const h = mountModal({
            entries: [{ method: 'CHAT', request: { _slim: true }, _idx: 7 }],
            taskId: 'T1',
            api: { getTaskLogEntry },
        });
        await waitFor(() => expect(getTaskLogEntry).toHaveBeenCalledWith('T1', 7));
        await waitFor(() => expect(h.container.textContent).toContain('RESTORED'));
    });

    it('degrades to the slim view when the fetch fails', async () => {
        const h = mountModal({
            entries: [{ method: 'CHAT', request: { _slim: true }, _idx: 7 }],
            taskId: 'T1',
            api: { getTaskLogEntry: vi.fn(async () => { throw new Error('gone'); }) },
        });
        await waitFor(() => expect(h.container.querySelector('.mchat-entry')).toBeTruthy());
        expect(h.container.textContent).toContain('CHAT');
    });

    it('closes from ✖, from the backdrop and on Escape', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.mchat-close'));
        expect(h.onClose).toHaveBeenCalled();
        await fireEvent.click(h.container.querySelector('.mchat-overlay'));
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(h.onClose.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('does not close when the dialog itself is clicked', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.mchat-box'));
        expect(h.onClose).not.toHaveBeenCalled();
    });
});

describe('AllowlistModal', () => {
    const mountModal = () => {
        const onClose = vi.fn();
        return { ...render(AllowlistModal, { props: { onClose } }), onClose };
    };

    it('lists both allowlists', () => {
        localStorage.setItem('jhai_approved_commands', JSON.stringify(['npm test', 'git status']));
        localStorage.setItem('jhai_autoapprove_workspaces', JSON.stringify(['C:/ws']));
        const h = mountModal();
        expect(h.container.textContent).toContain('npm test');
        expect(h.container.textContent).toContain('git status');
        expect(h.container.textContent).toContain('C:/ws');
        expect(h.container.querySelectorAll('.acm-row')).toHaveLength(3);
    });

    it('says (none) for an empty list', () => {
        const h = mountModal();
        expect(h.container.querySelectorAll('.acm-empty')).toHaveLength(2);
    });

    // The predecessor rebuilt the whole overlay with innerHTML for this.
    it('removes one entry and persists the rest', async () => {
        localStorage.setItem('jhai_approved_commands', JSON.stringify(['npm test', 'git status']));
        const h = mountModal();
        const row = [...h.container.querySelectorAll('.acm-row')].find(r => /npm test/.test(r.textContent));
        await fireEvent.click(row.querySelector('.acm-del'));
        await waitFor(() => expect(h.container.textContent).not.toContain('npm test'));
        expect(h.container.textContent).toContain('git status');
        expect(JSON.parse(localStorage.getItem('jhai_approved_commands'))).toEqual(['git status']);
    });

    it('does not confuse the two lists when removing', async () => {
        localStorage.setItem('jhai_approved_commands', JSON.stringify(['same']));
        localStorage.setItem('jhai_autoapprove_workspaces', JSON.stringify(['same']));
        const h = mountModal();
        await fireEvent.click(h.container.querySelectorAll('.acm-del')[0]);
        await waitFor(() => expect(JSON.parse(localStorage.getItem('jhai_approved_commands'))).toEqual([]));
        expect(JSON.parse(localStorage.getItem('jhai_autoapprove_workspaces'))).toEqual(['same']);
    });

    it('reads a corrupted list as empty rather than throwing', () => {
        localStorage.setItem('jhai_approved_commands', 'not json');
        expect(() => mountModal()).not.toThrow();
    });

    // The lists are not the whole story, and saying so is the point of the note.
    it('states that dangerous commands are always confirmed', () => {
        expect(mountModal().container.textContent).toContain(t('allow.dangerNote'));
    });

    it('closes from ✖ and from the backdrop', async () => {
        const h = mountModal();
        await fireEvent.click(h.container.querySelector('.acm-close'));
        expect(h.onClose).toHaveBeenCalled();
        await fireEvent.click(h.container.querySelector('.acm-overlay'));
        expect(h.onClose).toHaveBeenCalledTimes(2);
    });
});

describe('ImageZoom', () => {
    it('shows the image', () => {
        const h = render(ImageZoom, { props: { src: 'data:image/png;base64,AAA' } });
        expect(h.container.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,AAA');
    });

    // The predecessor interpolated the src into an innerHTML string unescaped.
    it('sets the src as an attribute, so quotes cannot break out of it', () => {
        const nasty = 'x" onerror="alert(1)';
        const h = render(ImageZoom, { props: { src: nasty } });
        expect(h.container.querySelector('img').getAttribute('src')).toBe(nasty);
        expect(h.container.querySelector('img').hasAttribute('onerror')).toBe(false);
    });

    it('closes on a click anywhere and on Escape', async () => {
        const onClose = vi.fn();
        const h = render(ImageZoom, { props: { src: 'x', onClose } });
        await fireEvent.click(h.container.querySelector('.iz-overlay'));
        expect(onClose).toHaveBeenCalled();
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
