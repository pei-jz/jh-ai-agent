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

describe('the inspector column', () => {
    // It shows THAT task's stats, files and cost. With nothing selected it has
    // nothing to show, and what it drew instead was an empty 264px strip with a
    // rule down the side of the start screen — furniture that pushed the one
    // question on the screen out of a sixth of the window.
    it('takes no room on the start screen', () => {
        const el = mount({ welcome: {}, inspectorOpen: true, inspector: { task: null, stats: {}, usage: {} } });
        expect(el.querySelector('.mtl-insp')).toBeNull();
    });

    it('comes back with a task open', () => {
        const el = mount({ header, inspectorOpen: true, inspector: { task: null, stats: {}, usage: {} } });
        expect(el.querySelector('.mtl-insp')).toBeTruthy();
    });

    it('stays closed with a task open when the user closed it', () => {
        const el = mount({ header, inspectorOpen: false });
        expect(el.querySelector('.mtl-insp')).toBeNull();
    });
});

/* Intents were removed from what hubApps returns (Report_20260913 §6-6), but
   this view still read `a.intents.length` — so with ANY app connected, every
   task view threw and rendered blank. */
describe('the hub strip', () => {
    it('does not throw for a connected app that has no intents', () => {
        expect(() => mount({ header, hub: { apps: [{ name: 'jheditor', resources: [] }] } })).not.toThrow();
    });

    it('shows the strip for an app with open documents, and not for one without', () => {
        const withDocs = mount({ header, hub: { apps: [{ name: 'jheditor', resources: [{ uri: 'doc://a', name: 'a.md' }] }] } });
        expect(withDocs.querySelector('.hub-strip')).toBeTruthy();
        cleanup();
        const without = mount({ header, hub: { apps: [{ name: 'jheditor', resources: [] }] } });
        expect(without.querySelector('.hub-strip')).toBeNull();
    });
});

/*
 * Hiding the task list must not hide the way back to it.
 *
 * Reported: "左側のタスク一覧を閉じると、開く方法がありません". The toggle lived in
 * the tab bar, which only exists while a task is open — and the collapsed state
 * persists in localStorage, so opening the app on the start screen (where it
 * opens) left the list, "New" and "Home" all behind a button that was not on
 * screen, restart after restart.
 */
describe('the collapsed task list', () => {
    it('leaves a rail that opens it again — with a task open', () => {
        const el = mount({ header, listCollapsed: true });
        expect(el.querySelector('.mpanel-left.pane-hidden')).toBeTruthy();
        expect(el.querySelector('.mpanel-rail .mrail-btn')).toBeTruthy();
    });

    it('leaves the SAME rail on the start screen, where the tab bar does not exist', () => {
        // This is the case that stranded it: no task, so no filter bar.
        const el = mount({ welcome: {}, listCollapsed: true });
        expect(el.querySelector('.mfilter-bar')).toBeNull();
        expect(el.querySelector('.mpanel-rail .mrail-btn')).toBeTruthy();
    });

    it('the rail reports the click, and says how many tasks are behind it', async () => {
        const onToggleList = vi.fn();
        const el = mount({ welcome: {}, listCollapsed: true, taskCount: 7, onToggleList });
        expect(el.querySelector('.mrail-count').textContent).toContain('7');
        await fireEvent.click(el.querySelector('.mrail-btn'));
        expect(onToggleList).toHaveBeenCalledTimes(1);
    });

    it('is closed from the list\'s own header, not from the tab bar', async () => {
        const onToggleList = vi.fn();
        const el = mount({ header, onToggleList });
        // Exactly one control, at the list's edge — not one here and one there.
        expect(el.querySelector('.mpanel-rail')).toBeNull();
        const hide = el.querySelector('.mpl-hide');
        expect(hide).toBeTruthy();
        await fireEvent.click(hide);
        expect(onToggleList).toHaveBeenCalledTimes(1);
    });

    it('drops the resize handle with the column it resizes', () => {
        const open = mount({ header }).querySelectorAll('.mpane-divider:not(.pane-hidden)').length;
        cleanup();
        const shut = mount({ header, listCollapsed: true }).querySelectorAll('.mpane-divider:not(.pane-hidden)').length;
        expect(shut).toBe(open - 1);
    });

    it('keeps the inspector toggle in the tab bar — it cannot be stranded there', () => {
        // The inspector only exists in the task view, which is where its toggle
        // is. Moving it would be symmetry for its own sake.
        const el = mount({ header });
        expect(el.querySelector('.mfilter-bar .mpanel-toggle')).toBeTruthy();
    });
});
