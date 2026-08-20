// SkillManager — the store the agent and the slash popup share.
//
// The point of the split is that `refresh()` costs metadata only: a body is
// fetched when a skill is actually used. Before, `list_skill_files` returned a
// title and nothing else, and the description the UI asked for was undefined.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { skillManager } = await import('../../SkillManager.js');

const listing = [
    {
        name: 'report', title: 'Monthly report', description: 'Build the monthly report.',
        allowedTools: 'read_office, write_xlsx', path: 'C:/cfg/skills/report/SKILL.md',
        dir: 'C:/cfg/skills/report',
        files: [
            { rel: 'scripts/build.py', path: 'C:/cfg/skills/report/scripts/build.py' },
            { rel: 'references/schema.md', path: 'C:/cfg/skills/report/references/schema.md' },
        ],
    },
    { name: 'triage', title: 'Triage', description: 'Sort incoming issues.', allowedTools: '', path: 'C:/cfg/skills/triage.md', dir: '', files: [] },
];

beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd) => (cmd === 'list_skill_files' ? listing : null));
    skillManager._skills = [];
});

describe('refresh', () => {
    it('loads metadata and no bodies', async () => {
        await skillManager.refresh();
        expect(skillManager.getAll()).toHaveLength(2);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls.map(c => c[0])).not.toContain('read_skill_file');
    });

    // The field the UI and the catalogue both need, and which was always
    // undefined before.
    it('carries the description', async () => {
        await skillManager.refresh();
        expect(skillManager.get('report').description).toBe('Build the monthly report.');
    });

    it('splits allowed-tools out of the header string', async () => {
        await skillManager.refresh();
        expect(skillManager.get('report').allowedTools).toEqual(['read_office', 'write_xlsx']);
        expect(skillManager.get('triage').allowedTools).toEqual([]);
    });

    it('separates the bundled scripts from the other files', async () => {
        await skillManager.refresh();
        const s = skillManager.get('report');
        expect(s.files).toHaveLength(2);
        expect(s.scripts.map(f => f.rel)).toEqual(['scripts/build.py']);
    });

    // A broken listing must not leave a half-built store behind.
    it('empties the list rather than throwing when the backend fails', async () => {
        invoke.mockImplementation(async () => { throw new Error('no such command'); });
        await expect(skillManager.refresh()).resolves.toBeDefined();
        expect(skillManager.getAll()).toEqual([]);
    });
});

describe('search', () => {
    beforeEach(async () => { await skillManager.refresh(); });

    it('matches the name and the title', () => {
        expect(skillManager.search('rep').map(s => s.name)).toEqual(['report']);
        expect(skillManager.search('Triage').map(s => s.name)).toEqual(['triage']);
    });

    // What you remember about a skill is usually what it DOES.
    it('matches the description too', () => {
        expect(skillManager.search('incoming').map(s => s.name)).toEqual(['triage']);
    });

    it('returns everything for an empty query', () => {
        expect(skillManager.search('')).toHaveLength(2);
    });
});

describe('catalogue', () => {
    it('is one line per skill, with no bodies', async () => {
        await skillManager.refresh();
        const out = skillManager.catalogue();
        expect(out).toContain('- report: Build the monthly report.');
        expect(out).toContain('- triage: Sort incoming issues.');
        expect(out).toMatch(/read_skill/);
    });

    it('is empty when nothing is installed', () => {
        expect(skillManager.catalogue()).toBe('');
    });
});

describe('load', () => {
    const BODY = '---\ndescription: Build the monthly report.\n---\n# Monthly report\n\nStep 1';

    beforeEach(() => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'list_skill_files') return listing;
            if (cmd === 'read_skill_file') return BODY;
            return null;
        });
    });

    it('returns the body with the header stripped', async () => {
        await skillManager.refresh();
        const { meta, text } = await skillManager.load('report');
        expect(meta.body).toContain('# Monthly report');
        expect(text).toContain('Step 1');
        expect(text).not.toContain('---\ndescription:');
    });

    // A skill that ships a script should not have to explain where it lives.
    it('tells the reader where the bundled files are', async () => {
        await skillManager.refresh();
        const { text } = await skillManager.load('report');
        expect(text).toContain('scripts/build.py → C:/cfg/skills/report/scripts/build.py');
    });

    it('refuses a name that would escape the skills directory', async () => {
        await expect(skillManager.load('../secrets')).rejects.toThrow(/Invalid skill name/);
    });

    it('works before refresh has run, just without the file list', async () => {
        const { text } = await skillManager.load('report');
        expect(text).toContain('Step 1');
        expect(text).not.toContain('scripts/build.py');
    });
});

describe('buildPrompt', () => {
    beforeEach(() => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'list_skill_files') return listing;
            if (cmd === 'read_skill_file') return '# T\nDesc\n\nBody';
            return null;
        });
    });

    it('appends what the user typed after the skill name', async () => {
        const out = await skillManager.buildPrompt('triage', 'for the June backlog');
        expect(out).toContain('Body');
        expect(out.trimEnd().endsWith('for the June backlog')).toBe(true);
    });

    it('sends the skill alone when nothing followed it', async () => {
        expect(await skillManager.buildPrompt('triage')).toContain('Body');
    });
});

describe('writing', () => {
    it('refuses a name that is not a safe path segment', async () => {
        await expect(skillManager.save('../evil', 'x')).rejects.toThrow();
        await expect(skillManager.save('a/b', 'x')).rejects.toThrow();
        expect(invoke).not.toHaveBeenCalledWith('write_skill_file', expect.anything());
    });

    it('saves and reloads', async () => {
        await skillManager.save('report', '# T');
        expect(invoke).toHaveBeenCalledWith('write_skill_file', { name: 'report', content: '# T' });
        expect(invoke.mock.calls.map(c => c[0])).toContain('list_skill_files');
    });

    it('converts a flat skill into a folder', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'promote_skill_to_dir') return 'C:/cfg/skills/triage';
            if (cmd === 'list_skill_files') return listing;
            return null;
        });
        expect(await skillManager.promoteToDirectory('triage')).toBe('C:/cfg/skills/triage');
    });

    it('drops the skill from the list on delete without a reload', async () => {
        await skillManager.refresh();
        await skillManager.delete('triage');
        expect(skillManager.getAll().map(s => s.name)).toEqual(['report']);
    });
});

describe('readResource', () => {
    it('asks the backend for one bundled file', async () => {
        await skillManager.readResource('report', 'scripts/build.py');
        expect(invoke).toHaveBeenCalledWith('read_skill_resource', { name: 'report', rel: 'scripts/build.py' });
    });
});
