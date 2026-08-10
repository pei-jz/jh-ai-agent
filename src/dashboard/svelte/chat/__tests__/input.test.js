// @vitest-environment jsdom
//
// SlashPopup / SkillChips / AttachmentPreviews — the chat input's three lists.
//
// All three were innerHTML plus a `querySelectorAll(...).forEach` re-binding a
// listener per row after every change. The slash popup's was the worst: the list
// filters as you type, so that rebind ran on every keystroke.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SlashPopup from '../SlashPopup.svelte';
import SkillChips from '../SkillChips.svelte';
import AttachmentPreviews from '../AttachmentPreviews.svelte';

afterEach(() => cleanup());

const mount = (Comp, props = {}) => render(Comp, { props }).container;

describe('SlashPopup', () => {
    const items = [
        { type: 'template', key: 'backlog', label: 'Backlog登録', icon: '📝' },
        { type: 'skill', key: 'deploy', label: 'Ship it', icon: '⚡' },
    ];

    it('says so when nothing matches', () => {
        const el = mount(SlashPopup, { items: [] });
        expect(el.textContent).toContain('No matching template or skill');
        expect(el.querySelector('.slash-popup-item')).toBe(null);
    });

    it('lists each command with its key, label and kind', () => {
        const el = mount(SlashPopup, { items });
        const rows = [...el.querySelectorAll('.slash-popup-item')];
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('/backlog');
        expect(rows[0].textContent).toContain('Backlog登録');
        expect(rows[0].textContent).toContain('template');
        expect(rows[1].textContent).toContain('skill');
    });

    it('marks the keyboard selection', () => {
        const rows = [...mount(SlashPopup, { items, selected: 1 }).querySelectorAll('.slash-popup-item')];
        expect(rows[0].classList.contains('selected')).toBe(false);
        expect(rows[1].classList.contains('selected')).toBe(true);
    });

    it('tells the keyboard controls in the header', () => {
        expect(mount(SlashPopup, { items }).textContent).toContain('↑↓ select');
    });

    it('picks on MOUSEDOWN, not click', () => {
        // A click fires after the textarea has blurred, and the caret position the
        // insertion needs is gone by then.
        const onPick = vi.fn();
        const el = mount(SlashPopup, { items, onPick });
        const row = el.querySelector('.slash-popup-item');
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(onPick).not.toHaveBeenCalled();
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(onPick).toHaveBeenCalledWith(items[0]);
    });

    it('prevents the default so the textarea keeps focus', () => {
        const el = mount(SlashPopup, { items, onPick: () => {} });
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        el.querySelector('.slash-popup-item').dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('tolerates a missing list', () => {
        expect(mount(SlashPopup, { items: null }).textContent).toContain('No matching');
    });
});

describe('SkillChips', () => {
    const skills = [{ name: 'deploy', title: 'Ship it' }, { name: 'audit', title: 'Audit' }];

    it('renders a chip per active skill', () => {
        const el = mount(SkillChips, { skills });
        expect([...el.querySelectorAll('.skill-chip-label')].map(l => l.textContent))
            .toEqual(['Ship it', 'Audit']);
    });

    it('falls back to the name when a skill has no title', () => {
        expect(mount(SkillChips, { skills: [{ name: 'raw' }] }).textContent).toContain('raw');
    });

    it('removes by NAME rather than by reading a data attribute back', () => {
        const onRemove = vi.fn();
        mount(SkillChips, { skills, onRemove }).querySelectorAll('.skill-chip-remove')[1].click();
        expect(onRemove).toHaveBeenCalledWith('audit');
    });

    it('renders nothing when there are none', () => {
        expect(mount(SkillChips, { skills: [] }).querySelector('.skill-chip')).toBe(null);
    });
});

describe('AttachmentPreviews', () => {
    const atts = [
        { id: 'a1', type: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' },
        { id: 'a2', type: 'file', name: 'log.txt' },
    ];

    it('previews an image with its thumbnail', () => {
        const el = mount(AttachmentPreviews, { attachments: atts });
        const img = el.querySelector('.preview-image img');
        expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA');
        expect(img.getAttribute('alt')).toBe('shot.png');
    });

    it('previews a non-image as a file row', () => {
        const el = mount(AttachmentPreviews, { attachments: atts });
        const file = el.querySelector('.preview-file');
        expect(file.textContent).toContain('log.txt');
        expect(file.querySelector('img')).toBe(null);
    });

    it('removes by id', () => {
        const onRemove = vi.fn();
        mount(AttachmentPreviews, { attachments: atts, onRemove })
            .querySelectorAll('.btn-remove-preview')[1].click();
        expect(onRemove).toHaveBeenCalledWith('a2');
    });

    it('escapes a hostile file name', () => {
        const el = mount(AttachmentPreviews, {
            attachments: [{ id: 'x', type: 'file', name: '<img src=x onerror=1>' }],
        });
        expect(el.querySelector('img')).toBe(null);
        expect(el.textContent).toContain('<img src=x onerror=1>');
    });

    it('renders nothing when there are none', () => {
        expect(mount(AttachmentPreviews, { attachments: [] }).querySelector('.chat-preview-item')).toBe(null);
    });
});
