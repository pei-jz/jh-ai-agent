// @vitest-environment jsdom
//
// The approval prompt IS the security boundary of pairing, so what it SAYS is
// the thing under test, not just that it renders.
//
// Two failure modes shape it. It can name a claim instead of a program — any
// process can POST {"app": "JHEditor"} — so the executable path the OS reported
// has to be on screen beside the name. And it can be approved by reflex when a
// background process fires a request at the moment the user launches an editor,
// which is what the comparison code is for.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

const { default: PairRequestDialog } = await import('../PairRequestDialog.svelte');

afterEach(cleanup);

const REQ = {
    id: 'pair_1',
    app: 'JHEditor',
    code: '481902',
    pid: 4242,
    exe: 'C:\\Program Files\\JHEditor\\jheditor.exe',
};

const show = (request = REQ, props = {}) =>
    render(PairRequestDialog, { props: { request, onAnswer: () => {}, ...props } }).container;

describe('what the prompt tells the user', () => {
    it('shows the executable the OS reported, not only the name the app chose', () => {
        const el = show();
        expect(el.querySelector('.pair-exe-name').textContent).toBe('jheditor.exe');
        expect(el.querySelector('.pair-exe-path').textContent).toContain('Program Files');
        expect(el.textContent).toContain('4242');
    });

    // "Unidentified" is information. Hiding it would leave the claimed name as
    // the only thing on screen, which is the case where the name is worth least.
    it('says when the process could not be identified', () => {
        const el = show({ ...REQ, exe: null, pid: null });
        expect(el.querySelector('.pair-exe-name')).toBeNull();
        expect(el.querySelector('.pair-unknown').textContent).toMatch(/特定できません/);
        expect(el.querySelector('.pair-unknown').textContent).toMatch(/自己申告/);
    });

    it('shows the comparison code the requesting app also displays', () => {
        expect(show().querySelector('.pair-code').textContent).toBe('481902');
    });

    // Approving grants the whole API, and the token's lifetime is the other
    // half of what the user is agreeing to.
    it('states what approving grants and how long it lasts', () => {
        const text = show().textContent;
        expect(text).toContain('API');
        expect(text).toMatch(/保存されず|無効/);
    });
});

describe('answering', () => {
    it('denies and approves through the same callback', async () => {
        const onAnswer = vi.fn();
        const el = show(REQ, { onAnswer });

        await fireEvent.click([...el.querySelectorAll('button')].find(b => b.textContent.includes('拒否')));
        expect(onAnswer).toHaveBeenCalledWith('pair_1', false);

        onAnswer.mockClear();
        await fireEvent.click([...el.querySelectorAll('button')].find(b => b.textContent.includes('承認')));
        expect(onAnswer).toHaveBeenCalledWith('pair_1', true);
    });

    // A request that has expired cannot be approved server-side. A dialog that
    // does not show the clock lets the user press a button that does nothing.
    it('counts down, and denies on its own when the time runs out', async () => {
        vi.useFakeTimers();
        const onAnswer = vi.fn();
        const el = show(REQ, { onAnswer, expiresIn: 2 });
        expect(el.querySelector('.pair-clock').textContent).toContain('2');

        await vi.advanceTimersByTimeAsync(2000);
        expect(onAnswer).toHaveBeenCalledWith('pair_1', false);
        vi.useRealTimers();
    });
});
