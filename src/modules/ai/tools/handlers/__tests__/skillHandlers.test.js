// skillHandlers — the tools that load a written procedure on demand.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const skills = vi.hoisted(() => ({
    getAll: vi.fn(() => []),
    refresh: vi.fn(async () => []),
    load: vi.fn(),
    readResource: vi.fn(),
}));
vi.mock('../../../SkillManager.js', () => ({ skillManager: skills }));

const { handleReadSkill, handleReadSkillFile } = await import('../skillHandlers.js');

const ctx = () => ({ onToolEvent: vi.fn() });
const loaded = (over = {}) => ({
    text: '# Skill: Monthly report (/report)\n\nStep 1',
    meta: { name: 'report', title: 'Monthly report', nameMismatch: null },
    files: [],
    ...over,
});

beforeEach(() => {
    skills.getAll.mockReset().mockReturnValue([{ name: 'report' }, { name: 'triage' }]);
    skills.refresh.mockReset().mockResolvedValue([]);
    skills.load.mockReset().mockResolvedValue(loaded());
    skills.readResource.mockReset().mockResolvedValue('print("hi")');
});

describe('read_skill', () => {
    it('returns the skill body', async () => {
        const out = await handleReadSkill(ctx(), { name: 'report' });
        expect(out).toContain('Step 1');
        expect(skills.load).toHaveBeenCalledWith('report');
    });

    it('reports what it loaded, so the run shows it', async () => {
        const c = ctx();
        await handleReadSkill(c, { name: 'report' }, vi.fn());
        expect(c.onToolEvent).toHaveBeenCalledWith('read_skill', { name: 'report', files: 0 });
    });

    it('says what it is doing', async () => {
        const status = vi.fn();
        await handleReadSkill(ctx(), { name: 'report' }, status);
        expect(status).toHaveBeenCalledWith(expect.stringContaining('/report'));
    });

    it('asks for a name rather than guessing', async () => {
        expect(await handleReadSkill(ctx(), {})).toMatch(/requires a 'name'/);
        expect(skills.load).not.toHaveBeenCalled();
    });

    it('trims a leading or trailing space in the name', async () => {
        await handleReadSkill(ctx(), { name: '  report ' });
        expect(skills.load).toHaveBeenCalledWith('report');
    });

    // The listing may not have run yet in this process, and without it the
    // bundled-file list is empty — the skill would look like prose with no scripts.
    it('loads the listing first when nothing is known yet', async () => {
        skills.getAll.mockReturnValue([]);
        await handleReadSkill(ctx(), { name: 'report' });
        expect(skills.refresh).toHaveBeenCalled();
    });

    it('does not re-list when the skills are already loaded', async () => {
        await handleReadSkill(ctx(), { name: 'report' });
        expect(skills.refresh).not.toHaveBeenCalled();
    });

    // The filename is what /… types and what this tool looks up, so a header
    // that renames the skill leaves the two disagreeing.
    it('mentions a header whose name disagrees with the filename', async () => {
        skills.load.mockResolvedValue(loaded({
            meta: { name: 'report', title: 'T', nameMismatch: 'monthly-report' },
        }));
        expect(await handleReadSkill(ctx(), { name: 'report' })).toContain('monthly-report');
    });

    // A wrong name is the common failure, and the fix is knowing the right ones.
    it('lists the available skills when the one asked for is missing', async () => {
        skills.load.mockRejectedValue(new Error('Cannot read skill'));
        const out = await handleReadSkill(ctx(), { name: 'nope' });
        expect(out).toMatch(/^Error/);
        expect(out).toContain('report, triage');
    });

    it('says so plainly when no skills exist at all', async () => {
        skills.getAll.mockReturnValue([]);
        skills.load.mockRejectedValue(new Error('missing'));
        expect(await handleReadSkill(ctx(), { name: 'nope' })).toMatch(/No skills are installed/);
    });

    it('returns an error string rather than throwing', async () => {
        skills.load.mockRejectedValue(new Error('boom'));
        await expect(handleReadSkill(ctx(), { name: 'x' })).resolves.toMatch(/boom/);
    });
});

describe('read_skill_file', () => {
    it('reads one bundled file and labels where it came from', async () => {
        const out = await handleReadSkillFile(ctx(), { name: 'report', path: 'scripts/build.py' });
        expect(out).toContain('/report → scripts/build.py');
        expect(out).toContain('print("hi")');
        expect(skills.readResource).toHaveBeenCalledWith('report', 'scripts/build.py');
    });

    it('needs both the skill and the path', async () => {
        expect(await handleReadSkillFile(ctx(), { name: 'report' })).toMatch(/requires/);
        expect(await handleReadSkillFile(ctx(), { path: 'scripts/x' })).toMatch(/requires/);
        expect(skills.readResource).not.toHaveBeenCalled();
    });

    // The backend refuses a path that resolves outside the skill folder; this
    // surfaces that refusal rather than swallowing it.
    it('reports a refusal from the backend', async () => {
        skills.readResource.mockRejectedValue(new Error("'../../secrets' is outside the skill directory"));
        const out = await handleReadSkillFile(ctx(), { name: 'report', path: '../../secrets' });
        expect(out).toMatch(/^Error/);
        expect(out).toContain('outside the skill directory');
    });

    it('reports what it read', async () => {
        const c = ctx();
        await handleReadSkillFile(c, { name: 'report', path: 'scripts/build.py' });
        expect(c.onToolEvent).toHaveBeenCalledWith('read_skill_file', { name: 'report', path: 'scripts/build.py' });
    });
});
