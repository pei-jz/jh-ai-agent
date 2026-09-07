// @vitest-environment jsdom
//
// The rail header: one composer, and the way back to it.
//
// There used to be a prompt box here AND the one in the middle of the start
// screen. Two boxes raise the question of which is the real one, and let the
// same request be typed in two places with two drafts to keep in step. The box
// here is gone; Home is how you get back to the one that remains — without
// stopping the run you were watching.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { t } from '../../../../i18n/index.js';

import MonitorRoot from '../MonitorRoot.svelte';

afterEach(() => cleanup());

const composer = { text: '', onText: () => {}, onSubmit: () => {} };
const header = { title: 'a task', status: 'running', usage: {} };

const mount = (over = {}) => render(MonitorRoot, {
    props: {
        taskList: { tasks: [], groups: [] },
        composer,
        onNewTask: () => {},
        ...over,
    },
}).container;

describe('the rail header', () => {
    it('has no composer of its own while a task is open', () => {
        const el = mount({ header });
        // The one composer lives on the start screen; with a task open there is
        // none on screen at all.
        expect(el.querySelector('.mcomp-rail')).toBeNull();
        expect(el.querySelectorAll('.mcomp').length).toBe(0);
    });

    it('offers Home while a task is open', () => {
        const el = mount({ header });
        expect(el.querySelector('.mpl-home')).toBeTruthy();
        expect(el.textContent).toContain(t('list.home'));
    });

    it('does not offer Home when there is nothing to leave', () => {
        const el = mount({});
        expect(el.querySelector('.mpl-home')).toBeNull();
    });

    it('Home reports the click rather than doing anything itself', async () => {
        const onHome = vi.fn();
        const el = mount({ header, onHome });
        await fireEvent.click(el.querySelector('.mpl-home'));
        expect(onHome).toHaveBeenCalledTimes(1);
    });

    it('the start screen still carries the one composer', () => {
        const el = mount({ welcome: {} });
        expect(el.querySelector('.mcomp-hero')).toBeTruthy();
    });
});
