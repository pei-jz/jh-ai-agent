// A job is more than a prompt: which MCP servers it may touch, which skills it
// must follow. What is pinned here is the part that runs unattended — that a
// pinned skill is read at RUN time (so an edit reaches the next run), that a
// missing one stops the run instead of quietly running without it, and that
// the wizard carries both lists into the job it creates.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../AgentModes.js', () => ({
    DEFAULT_MODE_ID: 'general',
    buildBehavior: () => ({}),
}));

const { JobManager } = await import('../JobManager.js');
const { withSkills, JOB_DEFAULTS } = await import('../JobModel.js');
const { initialState, buildPlan, applyTemplate } = await import('../wizardPlan.js');
const { normalizeRecipe } = await import('../../triggers/recipes/recipeFormat.js');

function fakeStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) };
}

describe('withSkills', () => {
    it('puts the procedures first, in the shape /skill uses in chat', () => {
        const out = withSkills('日報を書く', [{ name: 'daily', title: '日報の書き方', body: '1. 見出し' }]);
        expect(out).toBe('# Skill: 日報の書き方 (/daily)\n1. 見出し\n\n---\n\n日報を書く');
    });

    it('leaves the prompt alone when nothing is pinned', () => {
        expect(withSkills('やる', [])).toBe('やる');
    });
});

describe('a new job pins nothing', () => {
    it('defaults to no skills, as it defaults to no MCP servers', () => {
        expect(JOB_DEFAULTS.skills).toEqual([]);
        expect(JOB_DEFAULTS.mcpServers).toEqual([]);
    });
});

describe('a pinned skill is part of every run', () => {
    function managerWith(job, reader) {
        const calls = [];
        const client = {
            request: vi.fn(async (path, opts) => {
                calls.push(JSON.parse(opts.body));
                return { task_id: 't1' };
            }),
        };
        const m = new JobManager({
            storage: fakeStorage({ jh_jobs: JSON.stringify([job]) }),
            client,
            invoker: reader,
        });
        m.load();
        return { m, client, calls };
    }

    const JOB = {
        id: 'job_s', name: '日報', purpose: '毎朝の下書き', enabled: true,
        prompt: '昨日の分を書く', skills: ['daily'], mcpServers: ['backlog'],
        triggers: [{ kind: 'time', scheduleType: 'fixed', time: '09:00', days: [1] }],
    };

    it('reads the body when the job runs, and sends it ahead of the prompt', async () => {
        const reader = vi.fn(async (cmd, args) => (cmd === 'read_skill_file' ? `body of ${args.name}` : null));
        const { m, calls } = managerWith(JOB, reader);

        const rec = await m.run(m.jobs[0], { kind: 'time', prompt: '昨日の分を書く' });

        expect(rec.status).toBe('started');
        expect(reader).toHaveBeenCalledWith('read_skill_file', { name: 'daily' });
        expect(calls[0].prompt).toContain('body of daily');
        expect(calls[0].prompt.endsWith('昨日の分を書く')).toBe(true);
        // The MCP list travels too — it was already wired; this keeps it so.
        expect(calls[0].behavior.mcp_servers).toEqual(['backlog']);
    });

    it('refuses to run without a skill it was told to follow', async () => {
        const reader = vi.fn(async () => { throw new Error('not found'); });
        const { m, client } = managerWith(JOB, reader);

        const rec = await m.run(m.jobs[0], { kind: 'time', prompt: '昨日の分を書く' });

        // Running anyway would do SOMETHING unattended, and the record would
        // look like a normal run.
        expect(client.request).not.toHaveBeenCalled();
        expect(rec.status).toBe('failed');
        expect(rec.error).toContain('daily');
    });

    it('does not mistake a skill that documents {{…}} for an unfilled prompt', async () => {
        const reader = vi.fn(async () => '変数は {{payload.value}} のように書く');
        const { m, calls } = managerWith(JOB, reader);

        const rec = await m.run(m.jobs[0], { kind: 'time', prompt: '昨日の分を書く' });

        expect(rec.status).toBe('started');
        expect(calls[0].prompt).toContain('{{payload.value}}');
    });
});

describe('the wizard carries the tools into the job', () => {
    const PRESET = normalizeRecipe({
        name: '課題の整理', description: '毎朝', schedule: { scheduleType: 'fixed', time: '09:00' },
        requiresMcp: ['backlog'],
        job: { name: '整理', purpose: '朝のうちに', prompt: '課題を見る', skills: ['triage'] },
        defaults: { eventName: 'schedule.triage' },
    }, 'triage');

    it('starts from what the preset declares', () => {
        const s = initialState({ id: 'triage', driver: 'time', recipe: PRESET });
        expect(s.job.mcpServers).toEqual(['backlog']);
        expect(s.job.skills).toEqual(['triage']);
    });

    it('writes both lists onto the job it creates', () => {
        const s = initialState({ id: 'triage', driver: 'time', recipe: PRESET });
        s.job.skills = ['triage', 'report'];
        const { job } = buildPlan(s, { recipe: PRESET });
        expect(job.skills).toEqual(['triage', 'report']);
        expect(job.mcpServers).toEqual(['backlog']);
    });

    it('lets a template replace the tools along with the prompt', () => {
        const blank = initialState(null);
        blank.job.mcpServers = ['slack'];
        const s = applyTemplate(blank, PRESET);
        // A prompt that says "check Backlog" with the previous template's
        // server list is a job that cannot do what it says.
        expect(s.job.mcpServers).toEqual(['backlog']);
        expect(s.job.skills).toEqual(['triage']);
    });

    it('keeps a recipe’s skill list through normalization', () => {
        expect(PRESET.job.skills).toEqual(['triage']);
    });
});
