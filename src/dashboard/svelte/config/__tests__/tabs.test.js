// @vitest-environment jsdom
//
// TemplatesTab / SkillsTab / RagTab — the rest of region 5. (MemoryTab left
// with the memory surface: svelte/memory/MemoryEditor.svelte.)
//
// Between them these replaced ~330 lines of string rendering and ~330 lines of
// per-button listeners. The behaviours worth pinning are the ones the old shape made
// awkward or impossible: in-place fact editing (it was a window.prompt), the RAG
// directory cascade (it was a DOM walk), and validation that names the problem.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import TemplatesTab from '../TemplatesTab.svelte';
import SkillsTab from '../SkillsTab.svelte';
import RagTab from '../RagTab.svelte';
// The copy in these tabs comes from the i18n catalogs now, and the default
// locale is ja. Pin en so the assertions below read as the sentences they
// are checking for rather than as opaque strings.
import { __setLocaleForTest } from '../../../../i18n/index.js';

__setLocaleForTest('en');

afterEach(() => cleanup());

const mount = (Comp, props = {}) => render(Comp, { props }).container;
/** Mount and keep the handle, so props can be pushed the way a click does. */
const mountLive = (Comp, props = {}) => render(Comp, { props });
const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

describe('TemplatesTab', () => {
    const tpl = { key: 'backlog', label: 'Backlog', prompt: 'Register this task', icon: '📝' };

    it('says what to do when there are none', () => {
        expect(mount(TemplatesTab).textContent).toContain('No templates yet');
    });

    it('lists each template with its slash command', () => {
        const el = mount(TemplatesTab, { templates: [tpl] });
        expect(el.querySelector('.cfg-cmd').textContent).toBe('/backlog');
        expect(el.textContent).toContain('Backlog');
    });

    it('truncates a long prompt preview', () => {
        const el = mount(TemplatesTab, { templates: [{ ...tpl, prompt: 'x'.repeat(200) }] });
        const cell = el.querySelector('.cfg-prompt-preview').textContent;
        expect(cell.endsWith('…')).toBe(true);
        expect(cell.length).toBeLessThan(100);
    });

    it('reports new / edit / delete', () => {
        const onNew = vi.fn(); const onEdit = vi.fn(); const onDelete = vi.fn();
        const el = mount(TemplatesTab, { templates: [tpl], onNew, onEdit, onDelete });
        el.querySelector('#btn-tpl-new').click();
        expect(onNew).toHaveBeenCalled();
        el.querySelector('.btn-tpl-edit').click();
        expect(onEdit).toHaveBeenCalledWith('backlog');
        el.querySelector('.btn-tpl-delete').click();
        expect(onDelete).toHaveBeenCalledWith('backlog');
    });

    it('prefills the form when editing, and LOCKS the key', () => {
        // The key is the identity, so editing one would mean creating another.
        const el = mount(TemplatesTab, { templates: [tpl], editing: tpl, showForm: true });
        expect(el.querySelector('#tpl-key').value).toBe('backlog');
        expect(el.querySelector('#tpl-key').readOnly).toBe(true);
        expect(el.querySelector('#tpl-label').value).toBe('Backlog');
    });

    it('leaves the key editable for a NEW template', () => {
        const el = mount(TemplatesTab, { showForm: true });
        expect(el.querySelector('#tpl-key').readOnly).toBe(false);
        expect(el.querySelector('#tpl-icon').value).toBe('📝');
    });

    it('refuses an invalid command name and SAYS why', async () => {
        const onSave = vi.fn();
        const el = mount(TemplatesTab, { showForm: true, onSave });
        type(el.querySelector('#tpl-key'), 'has space');
        type(el.querySelector('#tpl-label'), 'L');
        type(el.querySelector('#tpl-prompt'), 'P');
        await tick();
        el.querySelector('#btn-tpl-save').click();
        await tick();
        expect(onSave).not.toHaveBeenCalled();
        expect(el.querySelector('.cfg-modal-errors').textContent).toContain('letters');
    });

    it('saves a valid template, defaulting the icon', async () => {
        const onSave = vi.fn();
        const el = mount(TemplatesTab, { showForm: true, onSave });
        type(el.querySelector('#tpl-key'), 'deploy');
        type(el.querySelector('#tpl-label'), 'Deploy');
        type(el.querySelector('#tpl-prompt'), 'Ship it');
        type(el.querySelector('#tpl-icon'), '');
        await tick();
        el.querySelector('#btn-tpl-save').click();
        expect(onSave).toHaveBeenCalledWith({
            key: 'deploy', label: 'Deploy', prompt: 'Ship it', icon: '📝',
        });
    });
});
describe('SkillsTab', () => {
    const skill = { name: 'backlog-register', title: 'Register in Backlog' };

    it('says what to do when there are none', () => {
        expect(mount(SkillsTab).textContent).toContain('No skills yet');
    });

    it('lists each skill with its command and title', () => {
        const el = mount(SkillsTab, { skills: [skill] });
        expect(el.querySelector('.cfg-cmd').textContent).toBe('/backlog-register');
        expect(el.textContent).toContain('Register in Backlog');
    });

    it('HIDES the name field while editing — the name is the file', () => {
        const el = mount(SkillsTab, {
            skills: [skill], editing: { name: 'backlog-register', content: '# x' }, showForm: true,
        });
        expect(el.querySelector('#skill-name')).toBe(null);
        expect(el.querySelector('#skill-content').value).toBe('# x');
        expect(el.textContent).toContain('backlog-register');
    });

    it('asks for a name on a NEW skill', () => {
        expect(mount(SkillsTab, { showForm: true }).querySelector('#skill-name')).not.toBe(null);
    });

    it('applies the same name rule as templates', async () => {
        const onSave = vi.fn();
        const el = mount(SkillsTab, { showForm: true, onSave });
        type(el.querySelector('#skill-name'), 'bad name');
        type(el.querySelector('#skill-content'), '# x');
        await tick();
        el.querySelector('#btn-skill-save').click();
        await tick();
        expect(onSave).not.toHaveBeenCalled();
        expect(el.querySelector('.cfg-modal-errors').textContent).toContain('letters');
    });

    it('keeps the existing name when saving an edit', async () => {
        const onSave = vi.fn();
        const el = mount(SkillsTab, {
            editing: { name: 'kept', content: '# old' }, showForm: true, onSave,
        });
        type(el.querySelector('#skill-content'), '# new');
        await tick();
        el.querySelector('#btn-skill-save').click();
        expect(onSave).toHaveBeenCalledWith({ name: 'kept', content: '# new' });
    });

    it('reports edit and delete by name', () => {
        const onEdit = vi.fn(); const onDelete = vi.fn();
        const el = mount(SkillsTab, { skills: [skill], onEdit, onDelete });
        el.querySelector('.btn-skill-edit').click();
        expect(onEdit).toHaveBeenCalledWith('backlog-register');
        el.querySelector('.btn-skill-delete').click();
        expect(onDelete).toHaveBeenCalledWith('backlog-register');
    });
});
describe('RagTab', () => {
    const dirs = ['C:/p/src', 'C:/p/src/a', 'C:/p/src/a/b', 'C:/p/docs'];

    it('prompts for a path before anything is loaded', () => {
        expect(mount(RagTab).textContent).toContain('Load Directories');
        expect(mount(RagTab).textContent).toContain('Enter a workspace path');
    });

    it('indents each directory by its depth', () => {
        const el = mount(RagTab, { dirs });
        const rows = [...el.querySelectorAll('.cfg-rag-dir')];
        expect(rows[0].style.paddingLeft).toBe('32px');   // C:/p/src → 2 separators
        expect(rows[1].style.paddingLeft).toBe('48px');
    });

    it('shows a directory as included unless it is EXCLUDED', () => {
        // Absence from the exclusion list means included, so a freshly loaded tree is
        // all-on without needing an entry per directory.
        const el = mount(RagTab, { dirs, exclusions: ['C:/p/docs'] });
        const boxes = [...el.querySelectorAll('.rag-dir-cb')];
        expect(boxes.map(b => b.checked)).toEqual([true, true, true, false]);
        expect([...el.querySelectorAll('.cfg-rag-dir')][3].classList.contains('is-excluded')).toBe(true);
    });

    it('CASCADES an exclusion to every descendant, in one report', () => {
        // This was a DOM walk that set .checked and .style.opacity on child inputs,
        // so the model and the checkboxes could disagree.
        const onToggleDir = vi.fn();
        const el = mount(RagTab, { dirs, onToggleDir });
        const box = el.querySelector('.rag-dir-cb');   // C:/p/src
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onToggleDir).toHaveBeenCalledWith(['C:/p/src', 'C:/p/src/a', 'C:/p/src/a/b'], false);
    });

    it('offers every extension, checked per the current selection', () => {
        const el = mount(RagTab, { extensions: ['js', 'md'] });
        const on = [...el.querySelectorAll('.rag-ext-cb')].filter(b => b.checked).map(b => b.value);
        expect(on).toEqual(['js', 'md']);
    });

    it('reports an extension toggle', () => {
        const onToggleExtension = vi.fn();
        const el = mount(RagTab, { extensions: [], onToggleExtension });
        const box = el.querySelector('.rag-ext-cb');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onToggleExtension).toHaveBeenCalledWith('js', true);
    });

    it('reports the path and the load request', () => {
        const onPathChange = vi.fn(); const onLoadDirs = vi.fn();
        const el = mount(RagTab, { onPathChange, onLoadDirs });
        type(el.querySelector('#rag-path-input'), 'C:/p');
        expect(onPathChange).toHaveBeenCalledWith('C:/p');
        el.querySelector('#btn-rag-load-dirs').click();
        expect(onLoadDirs).toHaveBeenCalled();
    });

    it('says the indexer is not implemented rather than offering a dead button', () => {
        const el = mount(RagTab);
        expect(el.querySelector('#btn-rag-start').disabled).toBe(true);
        expect(el.textContent).toContain('not available yet');
    });

    it('shows a progress bar only once indexing reports progress', () => {
        expect(mount(RagTab).querySelector('.cfg-rag-bar')).toBe(null);
        cleanup();
        expect(mount(RagTab, { progress: 40 }).querySelector('.cfg-rag-bar > div').style.width).toBe('40%');
    });
});
describe('the edit form is filled from the row that was clicked', () => {
    const tpl = { key: 'backlog', label: 'Backlog', prompt: 'Register this task', icon: '📝' };
    const other = { key: 'wiki', label: 'Wiki search', prompt: 'Search the wiki', icon: '🔎' };

    it('fills the template form when Edit opens it', async () => {
        const h = mountLive(TemplatesTab, { templates: [tpl], editing: null, showForm: false });
        await h.rerender({ templates: [tpl], editing: tpl, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-key').value).toBe('backlog'));
        expect(h.container.querySelector('#tpl-label').value).toBe('Backlog');
        expect(h.container.querySelector('#tpl-prompt').value).toBe('Register this task');
    });

    it('swaps the values when a DIFFERENT row is edited', async () => {
        const h = mountLive(TemplatesTab, { templates: [tpl, other], editing: tpl, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-key').value).toBe('backlog'));
        await h.rerender({ templates: [tpl, other], editing: other, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-key').value).toBe('wiki'));
    });

    it('opens EMPTY for a new template after an edit', async () => {
        const h = mountLive(TemplatesTab, { templates: [tpl], editing: tpl, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-key').value).toBe('backlog'));
        await h.rerender({ templates: [tpl], editing: null, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-key').value).toBe(''));
    });

    // A $derived would do this on every keystroke, which is why the form is
    // seeded rather than bound.
    it('does not throw away what is being typed', async () => {
        const h = mountLive(TemplatesTab, { templates: [tpl], editing: tpl, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-label').value).toBe('Backlog'));
        type(h.container.querySelector('#tpl-label'), 'Backlog (edited)');
        // The parent re-pushes props for unrelated reasons all the time.
        await h.rerender({ templates: [tpl], editing: tpl, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#tpl-label').value).toBe('Backlog (edited)'));
    });

    it('fills the skill form when Edit opens it', async () => {
        const skill = { name: 'triage', title: 'Triage', description: '', dir: '', files: [] };
        const h = mountLive(SkillsTab, { skills: [skill], editing: null, showForm: false });
        await h.rerender({
            skills: [skill], editing: { name: 'triage', content: '# Triage\nSort issues.' }, showForm: true,
        });
        await waitFor(() => expect(h.container.querySelector('#skill-content').value).toContain('Sort issues.'));
    });

    it('opens the skill form empty for a new one', async () => {
        const skill = { name: 'triage', title: 'Triage', description: '', dir: '', files: [] };
        const h = mountLive(SkillsTab, {
            skills: [skill], editing: { name: 'triage', content: 'OLD' }, showForm: true,
        });
        await waitFor(() => expect(h.container.querySelector('#skill-content').value).toBe('OLD'));
        await h.rerender({ skills: [skill], editing: null, showForm: true });
        await waitFor(() => expect(h.container.querySelector('#skill-content').value).toBe(''));
    });
});
