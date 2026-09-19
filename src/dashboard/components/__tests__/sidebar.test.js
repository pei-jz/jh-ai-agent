// @vitest-environment jsdom
//
// The rail is the app's primary navigation, and it spent this long as five
// unlabelled glyphs: dashboard.css hid `.sidebar-item-label` on the
// understanding that a CSS tooltip carried the name, and that tooltip drew
// `attr(data-tooltip)` — an attribute nothing sets. Hovering produced an empty
// bordered box. These tests pin the two halves together.
import { describe, it, expect, beforeEach } from 'vitest';
import { Sidebar, NAV_ITEMS, FOOTER_ITEMS, readSidebarAutoHide, writeSidebarAutoHide, applySidebarAutoHide } from '../Sidebar.js';

const html = (active = 'monitor') => new Sidebar(active, () => {}).render();

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('the rail names its destinations', () => {
    it('renders a non-empty label for every destination', () => {
        const el = document.createElement('div');
        el.innerHTML = html();
        const labels = [...el.querySelectorAll('.sidebar-item-label')]
            .map(n => n.textContent.trim());
        expect(labels).toHaveLength(NAV_ITEMS.length + FOOTER_ITEMS.length);
        for (const text of labels) expect(text).not.toBe('');
    });

    // The bug itself: a name that exists only in a tooltip is a name that can
    // fail to appear, and this one did.
    it('does not rely on a data-tooltip attribute it never sets', () => {
        expect(html()).not.toContain('data-tooltip');
    });

    // `title` is still there, but for the SHORTCUT — the reminder a tooltip is
    // for — not to carry the name.
    it('keeps the Ctrl+N shortcut in the title, numbered by position', () => {
        const el = document.createElement('div');
        el.innerHTML = html();
        const first = el.querySelector('.sidebar-item');
        expect(first.getAttribute('title')).toContain('(Ctrl+1)');
        // The footer item is not in the Ctrl+N set, so it carries no number.
        const items = [...el.querySelectorAll('.sidebar-item')];
        expect(items[items.length - 1].getAttribute('title')).not.toContain('Ctrl+');
    });

    it('marks the active destination for assistive tech, not colour alone', () => {
        const el = document.createElement('div');
        el.innerHTML = html('memory');
        const current = el.querySelector('[aria-current="page"]');
        expect(current?.dataset.route).toBe('memory');
    });

    // Every rail label goes through t(). They were invisible, which is exactly
    // how they stayed English in a Japanese UI without anyone reporting it.
    it('every item has a catalogue key', () => {
        for (const item of [...NAV_ITEMS, ...FOOTER_ITEMS]) {
            expect(item.labelKey, item.id).toMatch(/^nav\./);
        }
    });
});

describe('the side-menu auto-hide', () => {
    it('defaults to auto-hide ON when nothing is stored', () => {
        expect(readSidebarAutoHide()).toBe(true);
    });

    it('persists and reads the explicit off choice', () => {
        writeSidebarAutoHide(false);
        expect(localStorage.getItem('jhai_sidebar_autohide')).toBe('0');
        expect(readSidebarAutoHide()).toBe(false);
    });

    it('reads a non-"0" value as ON (the default)', () => {
        localStorage.setItem('jhai_sidebar_autohide', '1');
        expect(readSidebarAutoHide()).toBe(true);
    });

    it('renders the .auto-hide class when enabled and omits it when disabled', () => {
        writeSidebarAutoHide(true);
        expect(html()).toContain('class="sidebar auto-hide"');
        writeSidebarAutoHide(false);
        const el = document.createElement('div');
        el.innerHTML = html();
        expect(el.querySelector('.sidebar').classList.contains('auto-hide')).toBe(false);
    });

    it('applies the choice to an already-rendered rail without a rebuild', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="sidebar"></div>';
        document.body.appendChild(el);
        applySidebarAutoHide(true);
        expect(el.querySelector('.sidebar').classList.contains('auto-hide')).toBe(true);
        applySidebarAutoHide(false);
        expect(el.querySelector('.sidebar').classList.contains('auto-hide')).toBe(false);
    });
});
