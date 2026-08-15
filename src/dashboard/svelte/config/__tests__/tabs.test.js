// @vitest-environment jsdom
//
// TemplatesTab / SkillsTab / RagTab / MemoryTab — the rest of region 5.
//
// Between them these replaced ~330 lines of string rendering and ~330 lines of
// per-button listeners. The behaviours worth pinning are the ones the old shape made
// awkward or impossible: in-place fact editing (it was a window.prompt), the RAG
// directory cascade (it was a DOM walk), and validation that names the problem.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import TemplatesTab from '../TemplatesTab.svelte';
import SkillsTab from '../SkillsTab.svelte';
import RagTab from '../RagTab.svelte';
import MemoryTab from '../MemoryTab.svelte';
// The copy in these tabs comes from the i18n catalogs now, and the default
// locale is ja. Pin en so the assertions below read as the sentences they
// are checking for rather than as opaque strings.
import { __setLocaleForTest } from '../../../../i18n/index.js';

__setLocaleForTest('en');

afterEach(() => cleanup());

const mount = (Comp, props = {}) => render(Comp, { props }).container;
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

describe('MemoryTab', () => {
    const facts = [{ fact: 'Uses Vite 6', date: '2026-08-01', hits: 3 }];
    const episodes = [{ date: '2026-08-02', topic: 'Header fix', summary: 'Shrank it', outcome: 'success' }];

    it('distinguishes "not loaded" from "loaded and empty"', () => {
        // null means no workspace has been read yet; [] means the workspace has none.
        expect(mount(MemoryTab).textContent).toContain('press "Load"');
        cleanup();
        const loaded = mount(MemoryTab, { facts: [], episodes: [] });
        expect(loaded.textContent).toContain('No facts stored yet');
        expect(loaded.textContent).toContain('No session history yet');
    });

    it('offers the approved projects as suggestions', () => {
        const el = mount(MemoryTab, { workspace: '', projects: ['C:/a', 'C:/b'] });
        expect([...el.querySelectorAll('#memory-ws-list option')].map(o => o.value)).toEqual(['C:/a', 'C:/b']);
    });

    it('shows the workspace it was given, without guessing one', () => {
        // The view resolves the default (remembered choice, else the first approved
        // project); the component only displays it. Two places deciding would be one
        // too many.
        expect(mount(MemoryTab, { workspace: 'C:/a' }).querySelector('#memory-ws-input').value).toBe('C:/a');
        cleanup();
        expect(mount(MemoryTab, { projects: ['C:/a'] }).querySelector('#memory-ws-input').value).toBe('');
    });

    it('reports what was typed into the workspace box', () => {
        const onWorkspaceChange = vi.fn();
        type(mount(MemoryTab, { onWorkspaceChange }).querySelector('#memory-ws-input'), 'C:/proj');
        expect(onWorkspaceChange).toHaveBeenCalledWith('C:/proj');
    });

    it('lists facts with their date and hit count', () => {
        const el = mount(MemoryTab, { facts, episodes: [] });
        expect(el.textContent).toContain('Uses Vite 6');
        expect(el.textContent).toContain('2026-08-01');
        expect(el.querySelector('.cfg-mem-hits').textContent.trim()).toBe('3');
    });

    it('edits a fact IN PLACE — it used to be a window.prompt', async () => {
        const onEditFact = vi.fn();
        const el = mount(MemoryTab, { facts, episodes: [], onEditFact });
        el.querySelector('.memory-fact-edit').click();
        await tick();
        const input = el.querySelector('.cfg-mem-edit');
        expect(input.value).toBe('Uses Vite 6');
        type(input, 'Uses Vite 6 and Svelte 5');
        await tick();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onEditFact).toHaveBeenCalledWith(0, 'Uses Vite 6 and Svelte 5');
    });

    it('abandons an edit on Escape', async () => {
        const onEditFact = vi.fn();
        const el = mount(MemoryTab, { facts, episodes: [], onEditFact });
        el.querySelector('.memory-fact-edit').click();
        await tick();
        el.querySelector('.cfg-mem-edit').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await tick();
        expect(onEditFact).not.toHaveBeenCalled();
        expect(el.querySelector('.cfg-mem-edit')).toBe(null);
    });

    it('reports fact and episode deletions by index', () => {
        const onDeleteFact = vi.fn(); const onDeleteEpisode = vi.fn();
        const el = mount(MemoryTab, { facts, episodes, onDeleteFact, onDeleteEpisode });
        el.querySelector('.memory-fact-del').click();
        expect(onDeleteFact).toHaveBeenCalledWith(0);
        el.querySelector('.memory-episode-del').click();
        expect(onDeleteEpisode).toHaveBeenCalledWith(0);
    });

    it('marks an episode outcome with an icon', () => {
        const el = mount(MemoryTab, {
            facts: [],
            episodes: [
                { topic: 'ok', outcome: 'success' },
                { topic: 'bad', outcome: 'error' },
                { topic: 'meh', outcome: 'whatever' },
            ],
        });
        expect(el.textContent).toContain('✅');
        expect(el.textContent).toContain('❌');
        expect(el.textContent).toContain('⚠️');
    });

    it('reports load, browse and the clear-alls', () => {
        const cbs = {
            onLoad: vi.fn(), onBrowse: vi.fn(), onClearFacts: vi.fn(), onClearEpisodes: vi.fn(),
        };
        const el = mount(MemoryTab, { facts, episodes, ...cbs });
        el.querySelector('#btn-memory-load').click();
        el.querySelector('#btn-memory-ws-browse').click();
        el.querySelector('#btn-memory-facts-clear').click();
        el.querySelector('#btn-memory-episodes-clear').click();
        for (const [name, fn] of Object.entries(cbs)) expect(fn, name).toHaveBeenCalled();
    });
});

// ── Experience cards (Step 2 of the memory plan) ─────────────────────────
// The switch is the point: a wrong lesson the user cannot turn off is exactly
// how a learned memory poisons an agent.
describe('MemoryTab — experience cards', () => {
    const lesson = {
        id: 'L-1', type: 'lesson', signature: 'write_file|edit_mismatch|.svelte',
        trigger: { tool: 'write_file', ext: '.svelte' }, symptom: 'anchor does not match',
        fix: 'read_file → write_file', costSteps: 7, hits: 2,
    };
    const locator = {
        id: 'I-2', type: 'insight', kind: 'locator', q: 'licenseState',
        target: 'src/license.js', trigger: { tool: 'grep_search' }, hits: 1,
    };

    it('says what an empty store means, rather than showing nothing', () => {
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [] });
        expect(el.textContent).toContain('Nothing learned yet');
    });

    it('shows a lesson with its verified fix and what it cost', () => {
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [lesson] });
        expect(el.textContent).toContain('anchor does not match');
        expect(el.textContent).toContain('Verified fix: read_file → write_file');
        expect(el.querySelector('#memory-cards-list').textContent).toContain('7');
    });

    it('is honest about a lesson with no fix yet', () => {
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [{ ...lesson, fix: null }] });
        expect(el.textContent).toContain('No verified fix yet');
    });

    it('shows an insight about where something lives', () => {
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [locator] });
        expect(el.textContent).toContain('licenseState');
        expect(el.textContent).toContain('Found in: src/license.js');
    });

    it('switches a card off by index — the poisoning escape hatch', () => {
        const onToggleCard = vi.fn();
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [lesson], onToggleCard });
        const box = el.querySelector('.memory-card-toggle');
        expect(box.checked).toBe(true);
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onToggleCard).toHaveBeenCalledWith(0, true); // (index, disabled)
    });

    it('marks a switched-off card as inert instead of hiding it', () => {
        // Hiding it would make "why is this not firing?" unanswerable.
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [{ ...lesson, disabled: true }] });
        expect(el.querySelector('#memory-cards-list tr.is-off')).not.toBe(null);
        expect(el.querySelector('.memory-card-toggle').checked).toBe(false);
    });

    it('reports deletion by index', () => {
        const onDeleteCard = vi.fn();
        const el = mount(MemoryTab, { facts: [], episodes: [], cards: [lesson], onDeleteCard });
        el.querySelector('.memory-card-del').click();
        expect(onDeleteCard).toHaveBeenCalledWith(0);
    });

    it('shows which memory layer a fact reached', () => {
        const el = mount(MemoryTab, {
            facts: [{ fact: 'seen once', type: 'episodic' }, { fact: 'established rule', type: 'semantic' }],
            episodes: [],
        });
        const badges = [...el.querySelectorAll('#memory-facts-list .cfg-mem-badge')].map(b => b.textContent);
        expect(badges).toEqual(['episodic', 'semantic']);
    });

    it('shows a legacy fact (no type) as semantic', () => {
        const el = mount(MemoryTab, { facts: [{ fact: 'written before the layers existed' }], episodes: [] });
        expect(el.querySelector('#memory-facts-list .cfg-mem-badge').textContent).toBe('semantic');
    });
});

// Study is how the agent learns a project it has not worked in yet: experience
// only records where it happened to walk, so a fresh workspace has a memory of
// nothing at all.
describe('MemoryTab — study pass', () => {
    it('offers the study control beside the workspace it acts on', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws' });
        expect(el.querySelector('#btn-memory-study')).not.toBe(null);
    });

    it('reports it, and blocks a second start, while running', () => {
        const onStudy = vi.fn();
        const el = mount(MemoryTab, { workspace: 'C:/ws', studying: true, onStudy });
        const btn = el.querySelector('#btn-memory-study');
        expect(btn.disabled).toBe(true);
        btn.click();
        expect(onStudy).not.toHaveBeenCalled();
    });

    it('starts a study when asked', () => {
        const onStudy = vi.fn();
        mount(MemoryTab, { workspace: 'C:/ws', onStudy }).querySelector('#btn-memory-study').click();
        expect(onStudy).toHaveBeenCalled();
    });

    it('shows progress in place of the explanation once it is under way', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', studyStatus: '120 / 400' });
        expect(el.textContent).toContain('120 / 400');
    });
});

// Coverage says which areas the agent knows NOTHING about — the question no
// tooling usually answers, and the one that decides how far to trust an answer.
describe('MemoryTab — index coverage', () => {
    const stats = { files: 116, symbols: 375, edges: 210, coverage: [
        { dir: 'src/modules', files: 60 },
        { dir: 'src/dashboard', files: 40 },
    ] };

    it('reports the size of the index', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', indexStats: stats });
        expect(el.textContent).toContain('116');
        expect(el.textContent).toContain('375');
    });

    it('names each area with its share', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', indexStats: stats });
        const rows = [...el.querySelectorAll('.cfg-mem-cov-row .d')].map(n => n.textContent);
        expect(rows).toEqual(['src/modules', 'src/dashboard']);
    });

    it('says that uncovered areas are answered by guessing', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', indexStats: stats });
        expect(el.textContent).toMatch(/推測で答える|answering by guessing|guess/i);
    });

    it('shows nothing at all before a study has run', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', indexStats: { files: 0 } });
        expect(el.querySelector('.cfg-mem-cov')).toBe(null);
    });
});

// The A/B rows accumulate on every run and were, until this panel existed, read
// by nobody: answering "is the memory helping?" meant writing a script against
// metrics.jsonl. A measurement that inconvenient does not get looked at, which
// is the outcome the control arm was introduced to avoid.
describe('MemoryTab — A/B readout', () => {
    const ab = {
        rows: 41,
        on: { runs: 37, iterations: 19, explorationCost: 22 },
        off: { runs: 4, iterations: 21, explorationCost: 25 },
        delta: { iterations: -2, explorationCost: -3 },
        followThrough: { on: { rate: 0.6 }, baseline: { rate: 0.25 }, lift: 0.35 },
        needed: { mean: 22.1, sd: 13.1, perArm: 89 },
        comparable: true,
    };

    it('shows both arms and how far the comparison has to go', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', abStats: ab });
        expect(el.textContent).toContain('37');
        expect(el.textContent).toContain('89');
    });

    it('paces progress against the SMALLER arm, which is the binding one', () => {
        // 37 recall runs are worth nothing without control runs to compare them
        // to. Showing 37/89 here would read as 42% done when it is 4%.
        const el = mount(MemoryTab, { workspace: 'C:/ws', abStats: ab });
        expect(el.textContent).toContain('4/89');
    });

    it('reports follow-through against its baseline, not on its own', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', abStats: ab });
        const grid = el.querySelector('.cfg-mem-ab-grid').textContent;
        expect(grid).toContain('60% / 25%');
        expect(grid).toContain('35%');
    });

    it('withholds every delta while one arm is empty', () => {
        const el = mount(MemoryTab, {
            workspace: 'C:/ws',
            abStats: { ...ab, off: { runs: 0 }, comparable: false },
        });
        expect(el.querySelector('.cfg-mem-ab-grid')).toBe(null);
    });

    it('shows nothing before any run has been recorded', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', abStats: null });
        expect(el.querySelector('.cfg-mem-ab')).toBe(null);
    });
});

// The orientation note is the ONLY memory here that is inferred rather than
// observed, and it rides in every prompt — so a wrong line in it is repeated on
// every step until somebody reads it. Which requires being able to read it.
describe('MemoryTab — orientation note', () => {
    const ov = { text: '- A Tauri desktop app.\n- Agent loop in AgentController.', generatedAt: '2026-08-13T10:00:00Z' };

    it('shows the note', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', overview: ov });
        expect(el.querySelector('.cfg-mem-ov-text').textContent).toContain('Agent loop in AgentController');
    });

    it('says when it was generated, and that it is in every prompt', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', overview: ov });
        expect(el.textContent).toContain('2026-08-13');
    });

    it('lets a wrong line be corrected in place', async () => {
        const onSaveOverview = vi.fn();
        const el = mount(MemoryTab, { workspace: 'C:/ws', overview: ov, onSaveOverview });
        el.querySelector('#btn-memory-ov-edit').click();
        await tick();
        const box = el.querySelector('.cfg-mem-ov-edit');
        expect(box.value).toContain('Tauri');
        box.value = '- corrected';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        el.querySelector('#btn-memory-ov-save').click();
        expect(onSaveOverview).toHaveBeenCalledWith('- corrected');
    });

    it('shows nothing before a study has written one', () => {
        const el = mount(MemoryTab, { workspace: 'C:/ws', overview: { text: '', generatedAt: '' } });
        expect(el.querySelector('.cfg-mem-ov')).toBe(null);
    });
});
