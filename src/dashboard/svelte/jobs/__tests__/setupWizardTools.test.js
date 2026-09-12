// @vitest-environment jsdom
//
// Step 3 of the wizard — the work — takes prompt templates and skills the way
// the task composer does: type "/" in the prompt box. MCP servers stay a list
// of checkboxes, because a server is a permission rather than text.
//
// What is pinned here is that each of those reaches the job that gets created —
// in particular that a template picked from the popup is what gets SAVED, not
// the "/wiki" that was typed to find it — and that a server a preset needs but
// this machine lacks is shown rather than silently kept.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';

const invoke = vi.fn(async (cmd) => {
    if (cmd === 'get_ai_config') {
        return {
            approved_projects: ['C:/work'],
            mcp_servers: { mcpServers: { slack: {}, github: {} } },
            prompt_templates: { weekly: { label: '週報の型', prompt: '## 今週やったこと' } },
        };
    }
    if (cmd === 'list_skill_files') {
        return [
            { name: 'daily', title: '日報の書き方', description: '見出しと順番' },
            { name: 'review', title: 'レビュー観点' },
        ];
    }
    return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { default: SetupWizard } = await import('../SetupWizard.svelte');
const { normalizeRecipe } = await import('../../../../modules/ai/triggers/recipes/recipeFormat.js');

afterEach(() => { cleanup(); invoke.mockClear(); });

/** A clock preset that pins a skill and names a server this machine lacks. */
const PRESET = normalizeRecipe({
    id: 'triage', name: '課題の整理', description: '毎朝',
    schedule: { scheduleType: 'fixed', time: '09:00', days: [1, 2, 3, 4, 5] },
    requiresMcp: ['backlog'],
    defaults: { eventName: 'schedule.triage' },
    job: { name: '整理', purpose: '朝のうちに', prompt: '課題を見る', skills: ['daily'] },
}, 'triage');

function harness(recipes = [PRESET]) {
    const registry = { refresh: vi.fn(async () => {}), getAll: () => recipes, approve: vi.fn(async () => {}) };
    const watchers = { upsert: vi.fn(w => w) };
    const jobs = { upsert: vi.fn(j => j) };
    render(SetupWizard, { props: { registry, watchers, jobs, onDone: () => {}, notify: () => {} } });
    return { jobs };
}

/** Straight to step 3 on the plain clock path. Choosing a card IS step 2. */
async function toWork() {
    await fireEvent.click(await screen.findByText('自分で作る'));
    await fireEvent.click(await screen.findByText('スケジュールを決める'));
    await fireEvent.click(screen.getByText('次へ'));
}

async function fillNameAndPurpose() {
    await fireEvent.input(document.querySelector('#wiz-name'), { target: { value: '朝の準備' } });
    await fireEvent.input(document.querySelector('#wiz-purpose'), { target: { value: '下ごしらえ' } });
}

/** Type into the prompt box and pick the popup row whose command is `/key`. */
async function slashPick(key) {
    const box = document.querySelector('#wiz-prompt');
    await fireEvent.input(box, { target: { value: `/${key}` } });
    const row = [...document.querySelectorAll('.slash-popup-item')]
        .find(el => el.querySelector('.slash-popup-key')?.textContent === `/${key}`);
    expect(row, `no popup row for /${key}`).toBeTruthy();
    await fireEvent.mouseDown(row);
    return box;
}

/** Let the config and skill list load, so the popup has something to show. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('the prompt box takes "/" like the task composer', () => {
    it('has no separate template select or skill checkboxes any more', async () => {
        harness();
        await toWork();
        expect(screen.queryByLabelText('テンプレートを挿入')).toBeNull();
        expect(screen.queryByLabelText('日報の書き方')).toBeNull();
        // MCP stays a list.
        expect(await screen.findByLabelText('slack')).toBeTruthy();
    });

    it('lists templates and skills together', async () => {
        harness();
        await toWork();
        await settle();
        await fireEvent.input(document.querySelector('#wiz-prompt'), { target: { value: '/' } });
        const keys = [...document.querySelectorAll('.slash-popup-key')].map(e => e.textContent);
        expect(keys).toEqual(expect.arrayContaining(['/weekly', '/daily', '/review']));
    });

    it('saves the expanded template, not the command typed to find it', async () => {
        const h = harness();
        await toWork();
        await settle();
        await fillNameAndPurpose();
        const box = await slashPick('weekly');
        expect(box.value).toBe('## 今週やったこと');

        await fireEvent.click(screen.getByText('この内容で作る'));
        expect(h.jobs.upsert.mock.calls[0][0].prompt).toBe('## 今週やったこと');
    });

    it('attaches a skill as a chip and pins it on the job', async () => {
        const h = harness();
        await toWork();
        await settle();
        await fillNameAndPurpose();
        const box = await slashPick('review');
        // The command is removed from the box; the skill is a chip, not text.
        expect(box.value).toBe('');
        expect(document.querySelector('.sc-chip')?.textContent).toContain('レビュー観点');

        await fireEvent.input(box, { target: { value: 'やる' } });
        await fireEvent.click(screen.getByText('この内容で作る'));
        const job = h.jobs.upsert.mock.calls[0][0];
        expect(job.skills).toEqual(['review']);
        // Pinned by name only: the body is read when the job runs.
        expect(job.prompt).toBe('やる');
    });

    it('removing the chip unpins it', async () => {
        const h = harness();
        await toWork();
        await settle();
        await fillNameAndPurpose();
        const box = await slashPick('review');
        await fireEvent.click(document.querySelector('.sc-chip-x'));
        await fireEvent.input(box, { target: { value: 'やる' } });
        await fireEvent.click(screen.getByText('この内容で作る'));
        expect(h.jobs.upsert.mock.calls[0][0].skills).toEqual([]);
    });
});

describe('a preset arrives with its tools', () => {
    it('shows the pinned skill as a chip and the missing server as marked', async () => {
        const h = harness();
        await toWork();
        await settle();
        await fireEvent.change(screen.getByLabelText('ひな形から入れる'), { target: { value: 'triage' } });

        expect(document.querySelector('.sc-chip')?.textContent).toContain('日報の書き方');
        const box = await screen.findByLabelText(/backlog/);
        expect(box.checked).toBe(true);
        expect(box.closest('label').textContent).toContain('未設定');

        await fireEvent.click(screen.getByText('この内容で作る'));
        const job = h.jobs.upsert.mock.calls[0][0];
        expect(job.skills).toEqual(['daily']);
        expect(job.mcpServers).toEqual(['backlog']);
    });
});

describe('MCP is still a list of permissions', () => {
    it('saves exactly what was ticked, and [] when nothing was', async () => {
        const h = harness();
        await toWork();
        await fillNameAndPurpose();
        await fireEvent.input(document.querySelector('#wiz-prompt'), { target: { value: 'やる' } });
        await fireEvent.click(await screen.findByLabelText('slack'));
        await fireEvent.click(screen.getByText('この内容で作る'));
        expect(h.jobs.upsert.mock.calls[0][0].mcpServers).toEqual(['slack']);
    });

    it('creates a job with no tools when none are chosen', async () => {
        const h = harness();
        await toWork();
        await fillNameAndPurpose();
        await fireEvent.input(document.querySelector('#wiz-prompt'), { target: { value: 'やる' } });
        await fireEvent.click(screen.getByText('この内容で作る'));
        const job = h.jobs.upsert.mock.calls[0][0];
        // [] means "none", not "all": an omitted list would hand the job every
        // server that happens to be connected when it runs.
        expect(job.mcpServers).toEqual([]);
        expect(job.skills).toEqual([]);
    });
});
