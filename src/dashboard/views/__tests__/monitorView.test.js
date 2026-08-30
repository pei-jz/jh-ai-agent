// @vitest-environment jsdom
//
// MonitorView — the parts that have actually broken in use:
//   • which task opens by default (the server returns tasks UNSORTED)
//   • task-list grouping and the default-collapsed state
//   • the request bubble appearing twice
//   • the in-progress view surviving a navigation away and back
//
// The class only touches the DOM through document lookups, so most of this runs
// against a small hand-built page rather than the real view markup.
//
// NOTE on `await tick()`: the Task view's migrated regions are Svelte components and
// prop pushes are BATCHED (see dashboard/svelte/mount.svelte.js — flushing on every
// push cost ~31ms per streamed line on a long run). So a test that drives the view and
// then reads the DOM has to let the update land first.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { t } from '../../../i18n/index.js';

const invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ listen: vi.fn(async () => () => {}), onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock('../../../modules/ai/McpManager.js', () => ({
    mcpManager: { clients: new Map(), getAllTools: () => [], onChange: () => () => {} },
}));
vi.mock('../../../modules/ai/LLMService.js', () => ({ default: { getCurrentModel: () => 'm', supportsNativeTools: () => true } }));
vi.mock('../../../modules/ai/PromptTemplateManager.js', () => ({ promptTemplateManager: { list: () => [], loadFromConfig: vi.fn() } }));
vi.mock('../../../modules/ai/SkillManager.js', () => ({ skillManager: { list: () => [], listSkills: async () => [], refresh: vi.fn(async () => []) } }));

const { MonitorView } = await import('../MonitorView.js');
const { destroyComponent } = await import('../../svelte/mount.svelte.js');

const task = (id, over = {}) => ({
    id, prompt: `prompt ${id}`, status: 'completed', progress: 1,
    started_at: '2026-07-01T00:00:00Z', workspace_path: 'C:/work/proj',
    token_usage: {}, ...over,
});

let v;
beforeEach(() => {
    // Tear the previous test's root down BEFORE its host disappears. Wiping
    // innerHTML alone leaves the component mounted as far as the seam is
    // concerned, and its effects keep running against a detached tree — which is
    // how three chapter-jump tests passed alone and failed inside the file.
    destroyComponent(document.getElementById('monitor-root'));
    document.body.innerHTML = '';
    v = new MonitorView();
});

/**
 * Put the view on a page.
 *
 * Everything the Monitor draws is MonitorRoot.svelte now, so a test that needs
 * the DOM mounts the real component instead of hand-building a stand-in — the
 * fixtures used to be a guess at the markup, and drifted from it.
 */
function mount(over = {}) {
    document.body.innerHTML = '<div id="monitor-root"></div>';
    Object.assign(v, over);
    // The selected task has to EXIST in the list, or the right column is the
    // empty-state placeholder and there is nothing to assert against.
    if (!v.tasks?.length) v.tasks = [task(v.selectedTaskId || 'T1')];
    if (!v.selectedTaskId) v.selectedTaskId = v.tasks[0].id;
    if (!v.tasks.some(t => t.id === v.selectedTaskId)) v.tasks = [...v.tasks, task(v.selectedTaskId)];
    v._sync();
    return document.getElementById('monitor-root');
}

/** The story column — a keyed projection of the timeline. */
const storyEl = () => document.querySelector('.mresult');

describe('default task selection', () => {
    it('picks the MOST RECENT task — the server list is unsorted', () => {
        v.tasks = [
            task('old', { started_at: '2026-07-01T10:00:00Z' }),
            task('newest', { started_at: '2026-07-05T10:00:00Z' }),
            task('mid', { started_at: '2026-07-03T10:00:00Z' }),
        ];
        expect(v._newestTaskId()).toBe('newest');
    });

    it('falls back to the first entry when timestamps are missing', () => {
        v.tasks = [task('a', { started_at: null }), task('b', { started_at: null })];
        expect(v._newestTaskId()).toBeTruthy();
    });

    it('returns null for an empty list', () => {
        v.tasks = [];
        expect(v._newestTaskId()).toBe(null);
    });
});

// NOTE: the "task list grouping" tests moved out with the string builders they
// exercised. The RULES (filter / sort / group / default-collapse) are pure
// functions now, tested in monitor/__tests__/taskList.test.js; the markup and the
// clicks are in dashboard/svelte/monitor/__tests__/TaskList.test.js.

describe('run results — deduplication', () => {
    const completeLog = (ts, request) => ({
        event: 'complete', timestamp: ts,
        data: { resultSummary: { request, summary: `answer for ${request}` } },
    });

    it('keeps one bubble per run', () => {
        v.logs = [completeLog('t1', 'first request'), completeLog('t2', 'second request')];
        v._rebuildResultSummaries();
        expect(v.resultSummaries).toHaveLength(2);
    });

    it('collapses a replayed duplicate (same timestamp + request)', () => {
        v.logs = [completeLog('t1', 'same'), completeLog('t1', 'same')];
        v._rebuildResultSummaries();
        expect(v.resultSummaries).toHaveLength(1);
    });

    it('ignores completes that carry no result summary', () => {
        v.logs = [{ event: 'complete', timestamp: 't1', data: {} }, completeLog('t2', 'real')];
        v._rebuildResultSummaries();
        expect(v.resultSummaries).toHaveLength(1);
    });

    it('is idempotent — rebuilding does not accumulate', () => {
        v.logs = [completeLog('t1', 'a')];
        v._rebuildResultSummaries();
        v._rebuildResultSummaries();
        expect(v.resultSummaries).toHaveLength(1);
    });
});

// NOTE: the "long request display" tests moved with _requestHtml, which is gone.
// It rendered the text TWICE (a clamped copy and a full one) and swapped which was
// shown via a delegated toggle. The request card now holds one copy, clamps it in
// CSS, and opens the whole card — see
// dashboard/svelte/monitor/__tests__/TimelineItem.test.js ("TimelineItem — request").

describe('in-progress view survives navigation (snapshot/restore)', () => {
    const page = () => mount({ selectedTaskId: v.selectedTaskId || 'T1' });

    it('restores the in-flight trace after re-opening a RUNNING task', () => {
        page();
        v.selectedTaskId = 'T1';
        v._taskFinished = false;
        v._setResultLive('考えています', 'thought');
        v._setResultLive('read_file: a.js', 'tool');

        v._snapshotLiveState();          // navigating away
        page();                          // fresh DOM, as a new view would build
        expect(v._restoreLiveState('T1')).toBe(true);
        expect(storyEl().textContent).toContain('考えています');
        expect(storyEl().textContent).toContain('read_file: a.js');
    });

    it('KEEPS grouping working after a restore', async () => {
        // The old snapshot restored innerHTML while a stale node reference held
        // the open group, so every later line stopped nesting.
        page();
        v.selectedTaskId = 'T3';
        v._taskFinished = false;
        v._setResultLive('推論', 'thought');
        v._snapshotLiveState();
        page();
        v._restoreLiveState('T3');
        v._setResultLive('後続ツール', 'tool');
        await tick();
        await tick();

        const group = document.querySelector('.mtl .tl-card-step');
        expect(group.querySelectorAll('.tl-step-body .mtask-feed-item')).toHaveLength(1);
    });

    it('does NOT snapshot a finished task — its permanent bubbles take over', () => {
        page();
        v.selectedTaskId = 'T2';
        v._taskFinished = true;
        v._snapshotLiveState();
        page();
        expect(v._restoreLiveState('T2')).toBe(false);
    });

    it('restoring an unknown task is a no-op', () => {
        page();
        expect(v._restoreLiveState('never-seen')).toBe(false);
    });
});

describe('live activity feed — reasoning groups', () => {
    beforeEach(() => {
        mount();
        v._taskFinished = false;
    });

    // Steps are chapters on the rail now.
    const groups = () => document.querySelectorAll('.mtl .tl-step');

    it('nests the tool lines that follow a reasoning line inside its group', async () => {
        v._setResultLive('考えています', 'thought');
        v._setResultLive('read_file: a.js', 'tool');
        v._setResultLive('grep_search: foo', 'tool');
        await tick();
        expect(groups()).toHaveLength(1);
        expect(groups()[0].querySelectorAll('.tl-step-body .mtask-feed-item')).toHaveLength(2);
    });

    it('a NEW reasoning line starts its own group', async () => {
        v._setResultLive('最初の推論', 'thought');
        v._setResultLive('tool line', 'tool');
        v._setResultLive('次の推論', 'thought');
        await tick();
        expect(groups()).toHaveLength(2);
        expect(groups()[0].querySelectorAll('.tl-step-body .mtask-feed-item')).toHaveLength(1);
        expect(groups()[1].querySelectorAll('.tl-step-body .mtask-feed-item')).toHaveLength(0);
    });

    it('a question ends the group and stands on its own', async () => {
        v._setResultLive('推論', 'thought');
        v._showAskCard({ message: 'どちらにしますか？' });
        v._setResultLive('後続のツール', 'tool');
        await tick();
        // The tool line after the question is NOT swallowed into the group.
        expect(groups()[0].querySelectorAll('.tl-step-body .mtask-feed-item')).toHaveLength(0);
        expect(document.querySelector('.mtl .mask-q').textContent).toContain('どちらにしますか？');
    });

    it('does NOT cap the steps — a long run has to show all of them', async () => {
        // Steps used to be trimmed at 40, which silently truncated the story of a
        // long run. Folded, a step costs one line; the cap now applies only to
        // transient lines.
        for (let i = 0; i < 120; i++) v._setResultLive(`推論 ${i}`, 'thought');
        await tick();
        expect(document.querySelectorAll('.mtl .tl-step')).toHaveLength(120);
    });

    it('still caps the transient lines that arrive before any reasoning', () => {
        for (let i = 0; i < 120; i++) v._setResultLive(`tool line ${i}`, 'tool');
        expect(document.querySelectorAll('.mtl .tl-bare').length).toBeLessThanOrEqual(40);
    });

    it('a FREE-TEXT question is visible — it used to render nowhere', async () => {
        v._showAskCard({ message: 'シート名を教えてください' });
        await tick();
        expect(storyEl().textContent).toContain('シート名を教えてください');
    });
});

describe('task_progress becomes a chapter in the story', () => {
    beforeEach(() => {
        mount();
        v._taskFinished = false;
    });

    // The live path is: socket handler → pushTaskProgress → _renderResultPanel.
    // The socket is not reachable here, so drive the same two calls the handler
    // makes (this mirrors how _setResultLive is tested above).
    const pushProgress = (items) => {
        if (v._timeline.pushTaskProgress(items)) v._renderResultPanel();
    };

    it('renders the checklist and its tally when the tool fires', async () => {
        pushProgress([
            { id: '1', title: 'タスク一覧の調査', status: 'completed' },
            { id: '2', title: '実装', status: 'in_progress' },
            { id: '3', title: 'テスト', status: 'pending' },
        ]);
        await tick();
        const el = document.querySelector('.mtl');
        expect(el.textContent).toContain('task_progress (1/3 complete)');
        expect(el.querySelectorAll('.tl-progress-row')).toHaveLength(3);
    });

    it('a same-plan follow-up update replaces the list IN PLACE — one card, latest state', async () => {
        pushProgress([{ id: '1', title: '調査', status: 'pending' }]);
        await tick();
        pushProgress([{ id: '1', title: '調査', status: 'completed' }]);
        await tick();
        const el = document.querySelector('.mtl');
        expect(el.querySelectorAll('.tl-card-progress')).toHaveLength(1);
        expect(el.textContent).toContain('task_progress (1/1 complete)');
        expect(el.querySelectorAll('.tl-progress-row')).toHaveLength(1);
    });

    it('a REPLANNED checklist gets its own card — the latest plan is what runs', async () => {
        pushProgress([{ id: '1', title: '調査', status: 'completed' }]);
        await tick();
        pushProgress([
            { id: 'a', title: '新計画1', status: 'in_progress' },
            { id: 'b', title: '新計画2', status: 'pending' },
        ]);
        await tick();
        const el = document.querySelector('.mtl');
        expect(el.querySelectorAll('.tl-card-progress')).toHaveLength(2);
        // The LATEST card carries the newest plan.
        expect(el.textContent).toContain('task_progress (0/2 complete)');
        expect(el.querySelectorAll('.tl-progress-row')).toHaveLength(3);
    });
});

describe('header mini progress bar follows the task_progress card', () => {
    beforeEach(() => {
        // A header mount point plus the timeline host, as _renderDetail builds.
        mount();
        v.tasks = [task('t1', { status: 'running' })];
        v.selectedTaskId = 't1';
        v.currentStatus = 'running';
        v._taskFinished = false;
    });

    const pushProgress = (items) => {
        if (v._timeline.pushTaskProgress(items)) v._renderResultPanel();
    };

    it('shows the Progress bar with the tally once a multi-step plan registers', async () => {
        pushProgress([
            { id: '1', title: '調査', status: 'completed' },
            { id: '2', title: '実装', status: 'in_progress' },
        ]);
        await tick();
        const bar = document.querySelector('.mdh-progress');
        expect(bar).not.toBe(null);
        expect(bar.querySelector('.mdh-ctx-pct').textContent).toBe('1/2');
        expect(bar.querySelector('.mdh-ctx-fill').style.width).toBe('50%');
    });

    it('updates the bar when a same-plan status moves forward', async () => {
        pushProgress([{ id: '1', title: 'a', status: 'pending' }, { id: '2', title: 'b', status: 'pending' }]);
        await tick();
        pushProgress([{ id: '1', title: 'a', status: 'completed' }, { id: '2', title: 'b', status: 'completed' }]);
        await tick();
        const pct = document.querySelector('.mdh-progress .mdh-ctx-pct');
        expect(pct.textContent).toBe('2/2 ✓');
        expect(document.querySelector('.mdh-progress .mdh-ctx-fill').style.width).toBe('100%');
    });

    it('hides the bar once the run is no longer running', async () => {
        pushProgress([{ id: '1', title: 'a', status: 'completed' }, { id: '2', title: 'b', status: 'completed' }]);
        await tick();
        v.currentStatus = 'completed';
        v._sync();
        await tick();
        expect(document.querySelector('.mdh-progress')).toBe(null);
    });
});

describe('project-instructions button', () => {
    // Reported failure: clicking it on a task whose workspace was never opened
    // by an agent session died with "Path guard: operation blocked — …
    // 'C:\cusor_workspace\Task\.agent/instructions.md' is outside all allowed
    // roots". Nothing had registered that workspace.
    const WS = 'C:\\cusor_workspace\\Task';

    // The trigger is now the inspector's Actions button, which calls the method
    // directly. It used to forward a synthetic click to a #btn-project-instructions
    // element in the header's workspace row — and when that row moved into the
    // inspector, the forward silently became a no-op.
    function mount(selected = 't1') {
        document.body.innerHTML = '<button id="insp-instr"></button>';
        v.tasks = [task('t1', { workspace_path: WS })];
        v.selectedTaskId = selected;
        const btn = document.getElementById('insp-instr');
        btn.click = () => { v._openProjectInstructions(btn); };
        return btn;
    }

    const callsTo = (cmd) => invoke.mock.calls.filter(c => c[0] === cmd);
    // The handler dynamically imports ProjectInstructions.js, so a single
    // macrotask is not always enough — poll until the click has settled.
    const settled = async (done) => {
        for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5));
        expect(done()).toBe(true);
    };
    const flush = () => settled(() => invoke.mock.calls.some(c => c[0] === 'open_path_default')
        || globalThis.alert.mock.calls.length > 0);

    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async () => null);
        globalThis.alert = vi.fn();
    });

    it('registers the .agent directory BEFORE writing the file', async () => {
        // read_file rejecting = the file does not exist yet, so it gets created.
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'read_file') throw new Error('not found');
            return null;
        });
        mount().click();
        await flush();

        expect(callsTo('set_allowed_roots')[0][1]).toEqual({ roots: ['C:/cusor_workspace/Task/.agent'] });
        const order = invoke.mock.calls.map(c => c[0]);
        expect(order.indexOf('set_allowed_roots')).toBeLessThan(order.indexOf('write_file'));
        expect(globalThis.alert).not.toHaveBeenCalled();
    });

    it('normalizes the path — the error dialog showed mixed separators', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'read_file') throw new Error('not found');
            return null;
        });
        mount().click();
        await flush();

        const written = callsTo('write_file')[0][1];
        expect(written.path).toBe('C:/cusor_workspace/Task/.agent/instructions.md');
        expect(written.path).not.toContain('\\');
        // Template seeded with the workspace's own name.
        expect(written.content).toContain(t('common.task'));
    });

    it('opens an EXISTING file without rewriting it', async () => {
        mount().click();               // read_file resolves → the file is there
        await flush();

        expect(callsTo('write_file')).toHaveLength(0);
        expect(callsTo('open_path_default')[0][1]).toEqual({ path: 'C:/cusor_workspace/Task/.agent/instructions.md' });
    });

    it('still tries the write when registration fails, and reports the real error', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'set_allowed_roots') throw new Error('no such command');
            if (cmd === 'read_file') throw new Error('not found');
            if (cmd === 'write_file') throw new Error('Path guard: operation blocked');
            return null;
        });
        mount().click();
        await flush();

        expect(globalThis.alert).toHaveBeenCalledWith(expect.stringContaining('Path guard'));
    });

    it.each([
        ['empty', ''],
        // Truthy but not a real path — must not become "   /.agent/…".
        ['whitespace-only', '   '],
    ])('does nothing when the selected task workspace is %s', async (_label, wsValue) => {
        v.tasks = [task('t1', { workspace_path: wsValue })];
        v.selectedTaskId = 't1';
        v._openProjectInstructions();
        // Nothing should ever happen here, so wait a beat rather than for a call.
        await new Promise(r => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('re-enables the button after a failure so the user can retry', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'read_file') throw new Error('not found');
            if (cmd === 'write_file') throw new Error('boom');
            return null;
        });
        const btn = mount();
        btn.click();
        await flush();
        expect(btn.disabled).toBe(false);
    });
});

// The single-timeline redesign deleted #result-pending / #result-confirm /
// #result-ask but left code looking those ids up. getElementById returned null and
// the affected features silently did NOTHING — an approval that could not be
// approved, and a follow-up request that never appeared. These tests pin the two
// behaviours to the timeline, which is where the cards actually render now.
describe('approval buttons work in the Story view', () => {
    const page = () => {
        v.sendConfirmResponse = vi.fn();
        mount({ tasks: [task('t1')], selectedTaskId: 't1' });
        return document.querySelector('.mtl');
    };

    const card = (cid) => `<div data-confirm-card="${cid}"><div class="mconfirm-actions">`
        + `<button class="btn-approve-always" data-confirm-id="${cid}">always</button>`
        + `<button class="btn-approve" data-confirm-id="${cid}">Approve</button>`
        + `<button class="btn-reject" data-confirm-id="${cid}">Reject</button>`
        + `</div></div>`;

    it('Approve inside the timeline reaches sendConfirmResponse', () => {
        const host = page();
        host.innerHTML = card('c1');
        host.querySelector('.btn-approve').click();
        expect(v.sendConfirmResponse).toHaveBeenCalledWith('c1', true);
    });

    it('Reject reaches it too, with approved=false', () => {
        const host = page();
        host.innerHTML = card('c2');
        host.querySelector('.btn-reject').click();
        expect(v.sendConfirmResponse).toHaveBeenCalledWith('c2', false);
    });

    it('Always-allow passes the always flag', () => {
        const host = page();
        host.innerHTML = card('c3');
        host.querySelector('.btn-approve-always').click();
        expect(v.sendConfirmResponse).toHaveBeenCalledWith('c3', true, true);
    });

    it('the per-workspace auto-approve checkbox still toggles', () => {
        const host = page();
        v._setWsAutoApprove = vi.fn();
        host.innerHTML = `<input type="checkbox" class="cb-autows" data-ws="C:/work/proj">`;
        const cb = host.querySelector('.cb-autows');
        cb.checked = true;
        cb.click();
        expect(v._setWsAutoApprove).toHaveBeenCalledWith('C:/work/proj', expect.any(Boolean));
    });

    it('a click on ordinary timeline content is left alone', () => {
        const host = page();
        host.innerHTML = `<div class="tl-card">just text</div>`;
        host.querySelector('.tl-card').click();
        expect(v.sendConfirmResponse).not.toHaveBeenCalled();
    });
});

describe('a follow-up request appears immediately', () => {
    it('_showPendingUser pushes a live request onto the timeline', () => {
        v.tasks = [task('t1')];
        v.selectedTaskId = 't1';
        v._renderResultPanel = vi.fn();
        v._scrollTaskToBottom = vi.fn();

        v._showPendingUser('please also update the README');

        const reqs = v._timeline.items.filter(i => i.kind === 'request');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].text).toBe('please also update the README');
        expect(reqs[0].live).toBe(true);
        expect(v._renderResultPanel).toHaveBeenCalled();
    });

    it('carries image attachments so they stay visible after sending', () => {
        v._renderResultPanel = vi.fn();
        v._scrollTaskToBottom = vi.fn();
        v._showPendingUser('look at this', ['data:image/png;base64,AAA']);
        const req = v._timeline.items.find(i => i.kind === 'request');
        expect(req.images).toEqual(['data:image/png;base64,AAA']);
    });

    it('an image-only message still gets a bubble', () => {
        v._renderResultPanel = vi.fn();
        v._scrollTaskToBottom = vi.fn();
        v._showPendingUser('', ['data:image/png;base64,AAA']);
        expect(v._timeline.items.filter(i => i.kind === 'request')).toHaveLength(1);
    });

    it('an empty send does nothing at all', () => {
        v._renderResultPanel = vi.fn();
        v._showPendingUser('', []);
        expect(v._timeline.items.filter(i => i.kind === 'request')).toHaveLength(0);
        expect(v._renderResultPanel).not.toHaveBeenCalled();
    });

    it('a completion with no summary SETTLES the request instead of dropping it', () => {
        // Left live, the request is a trim/clearLive candidate — which is how a
        // just-sent follow-up used to vanish the moment the run ended.
        v._renderResultPanel = vi.fn();
        v._scrollTaskToBottom = vi.fn();
        v._showPendingUser('do the thing');
        v._finalizePendingUser('done it');

        const req = v._timeline.items.find(i => i.kind === 'request');
        expect(req.live).toBe(false);
        expect(v._timeline.items.some(i => i.kind === 'deliverable')).toBe(true);
    });
});

describe('load earlier logs', () => {
    const page = () => mount();
    /** The Load-earlier button, present only while something precedes. */
    const earlierBtn = () => document.querySelector('.mresult-earlier button');

    const entry = (idx, over = {}) => ({
        event: 'status', timestamp: `t${idx}`,
        data: { _idx: idx, status: 'running', message: `step ${idx}`, ...over },
    });
    const completeAt = (idx, request) => ({
        event: 'complete', timestamp: `t${idx}`,
        data: { _idx: idx, resultSummary: { request, answer: `answer ${request}` } },
    });

    let fetched;
    beforeEach(() => {
        page();
        fetched = [];
        v.selectedTaskId = 'T1';
        v.tasks = [task('T1')];
        window.apiClient = {
            getTaskLogs: vi.fn(async (id, opts) => { fetched.push(opts); return v.__next || []; }),
        };
    });

    it('does nothing when there is nothing earlier', async () => {
        v._logStart = 0;
        await v.loadEarlierLogs();
        expect(window.apiClient.getTaskLogs).not.toHaveBeenCalled();
    });

    it('requests the page BEFORE the oldest entry it holds', async () => {
        v._logStart = 400;
        v.__next = [entry(300)];
        await v.loadEarlierLogs();
        expect(fetched[0]).toMatchObject({ before: 400 });
    });

    it('prepends the older entries and moves the anchor back', async () => {
        v._logStart = 400;
        v.logs = [entry(400)];
        v.__next = [entry(200), entry(201)];
        await v.loadEarlierLogs();

        expect(v.logs).toHaveLength(3);
        expect(v.logs[0].data._idx).toBe(200);
        expect(v._logStart).toBe(200);
    });

    it('surfaces an EARLIER completed run in the Task view', async () => {
        v._logStart = 400;
        v.logs = [];
        v.__next = [completeAt(10, 'the earlier request')];
        await v.loadEarlierLogs();
        expect(storyEl().textContent).toContain('the earlier request');
    });

    it('says so when the page held no completions — it is not broken, just step logs', async () => {
        // The reported "load earlier does nothing": the Task view is built from
        // completions, so a page of plain step logs legitimately adds no bubbles.
        v._logStart = 400;
        v.__next = [entry(10), entry(11)];
        await v.loadEarlierLogs();
        const note = document.querySelector('.mresult-earlier-note').textContent;
        expect(note).toContain('Loaded 2 entries');
        expect(note).toContain('All Logs');
    });

    it('stops instead of refetching forever when the backend omits _idx', async () => {
        v._logStart = 400;
        v.__next = [{ event: 'status', data: { message: 'no idx here' } }];
        await v.loadEarlierLogs();
        expect(v._logStart).toBe(0);
        // Nothing earlier remains, so the button is gone — only the note stays.
        expect(document.querySelectorAll('.mresult-earlier button')).toHaveLength(0);
    });

    it('reports reaching the beginning', async () => {
        v._logStart = 50;
        v.__next = [];
        await v.loadEarlierLogs();
        expect(v._logStart).toBe(0);
        expect(document.querySelector('.mresult-earlier-note').textContent).toContain('No earlier logs');
    });

    it('reports a failure instead of silently doing nothing', async () => {
        v._logStart = 50;
        window.apiClient.getTaskLogs = vi.fn(async () => { throw new Error('network down'); });
        await v.loadEarlierLogs();
        expect(document.querySelector('.mresult-earlier-note').textContent).toContain('network down');
    });

    it('re-enables the button afterwards', async () => {
        v._logStart = 400;
        v.__next = [entry(300)];
        await v.loadEarlierLogs();
        // The row is usable again: the button is back and not disabled.
        expect(document.querySelector('.mresult-earlier button')?.disabled).toBeFalsy();
    });
});

describe('switching task from the list', () => {
    // The reported "selecting a task in the list shows nothing": _switchTask still
    // ended with `right.innerHTML = this._renderDetail(task)` after both `right`
    // and `_renderDetail` were removed with the string renderers. That threw
    // BEFORE _autoConnect(), so the incoming task's logs were never fetched and
    // the story column stayed empty under the outgoing task's chrome.
    const completeLog = (idx, request) => ({
        event: 'complete', timestamp: `t${idx}`,
        data: { _idx: idx, resultSummary: { request, answer: `answer ${request}` } },
    });

    beforeEach(() => {
        mount({ selectedTaskId: 'T1', tasks: [task('T1'), task('T2')] });
        window.apiClient = {
            getTask: vi.fn(async (id) => ({ id, status: 'completed' })),
            getTaskLogs: vi.fn(async (id) => [completeLog(0, `request for ${id}`)]),
        };
    });

    /** Let _autoConnect's async chain and the batched prop push both land. */
    const settle = async () => { for (let i = 0; i < 4; i++) await tick(); await tick(); };

    it('fetches the logs of the incoming task and draws its story', async () => {
        v._switchTask('T2');
        await settle();

        expect(window.apiClient.getTaskLogs).toHaveBeenCalledWith('T2', expect.anything());
        expect(v.selectedTaskId).toBe('T2');
        expect(storyEl().textContent).toContain('request for T2');
    });

    it('does not carry the chrome of the previous task over', async () => {
        // Paging state, the live label and a question parked on the steer box all
        // belong to the task being left.
        v._logStart = 400;
        v._earlierNote = 'Loaded 12 entries';
        v._working = true;
        v._steerAskPlaceholder = '❓ どのシートですか';
        v._filter = 'all';

        v._switchTask('T2');
        await tick();

        expect(v._logStart).toBe(0);
        expect(v._earlierNote).toBe('');
        expect(v._working).toBe(false);
        expect(v._steerAskPlaceholder).toBe('');
        expect(v._filter).toBe('result');
        expect(document.querySelector('.mresult-earlier button')).toBeNull();
        expect(document.querySelector('.mresult-live-label')).toBeNull();
    });

    it('says it is loading while the logs are in flight', async () => {
        let release;
        window.apiClient.getTaskLogs = vi.fn(() => new Promise(r => { release = r; }));
        v._switchTask('T2');
        await tick();
        expect(document.querySelector('.mload')).toBeTruthy();

        release([completeLog(0, 'request for T2')]);
        await settle();
        expect(document.querySelector('.mload')).toBeNull();
    });
});

describe('pending question banner', () => {
    const page = () => mount({ selectedTaskId: 'T1', tasks: [task('T1')], _taskFinished: false });

    beforeEach(() => { page(); });

    /** The banner is derived from the items, so it exists only while one waits. */
    const slot = () => document.querySelector('.mask-pending');

    it('appears while a question is unanswered', async () => {
        v._showAskCard({ message: 'どのシートですか' });
        await tick();
        expect(slot()).toBeTruthy();
        expect(slot().textContent).toContain(t('task.waiting'));
    });

    it('disappears once the question is answered', async () => {
        v._showAskCard({ message: 'q' });
        v._clearAskCard();
        await tick();
        expect(slot()).toBeNull();
    });

    it('is absent when nothing was asked', async () => {
        v._setResultLive('thinking', 'thought');
        await tick();
        expect(slot()).toBeNull();
    });

    it('scrolls the question into view when clicked', async () => {
        v._showAskCard({ message: 'q' });
        await tick();
        // The banner scrolls the question into view itself now — it knows the
        // item's id, so it does not need the view to find the row for it.
        const target = document.querySelector('.mtl [data-item-id]');
        const into = vi.fn();
        if (target) target.scrollIntoView = into;
        slot().click();
        expect(into).toHaveBeenCalled();
    });
});

describe('auto-follow respects the reader', () => {
    beforeEach(() => {
        mount({ selectedTaskId: 'T1', tasks: [task('T1')], _taskFinished: false });
    });

    it('does not yank the view once the reader has scrolled up', async () => {
        const rp = document.querySelector('.mresult');
        Object.defineProperty(rp, 'scrollHeight', { value: 5000, configurable: true });
        Object.defineProperty(rp, 'clientHeight', { value: 500, configurable: true });
        rp.scrollTop = 100;
        // A REAL scroll: the panel owns "am I at the bottom" — it is the element
        // that knows — and tells the view, which is how auto-follow learns to
        // stop. Setting the flag by hand would test the flag, not the wiring.
        rp.dispatchEvent(new Event('scroll'));
        expect(v._userScrolledUp).toBe(true);

        v._setResultLive('a new step arrives', 'thought');
        await tick();
        expect(rp.scrollTop).toBe(100);
        expect(document.querySelector('.mresult-jump')).toBeTruthy();
    });

    it('jumping back to the bottom re-arms following', () => {
        v._userScrolledUp = true;
        v._scrollTaskToBottom();
        expect(v._userScrolledUp).toBe(false);
        expect(document.querySelector('.mresult-jump')).toBeNull();
    });
});

describe('token totals come from one place', () => {
    // Reported: the header showed real numbers while the inspector showed 0.
    // The header read the task record; the inspector read a live accumulator
    // that a task loaded from history never fills.
    const usageLog = (p, c, cache) => ({
        event: 'token_usage',
        data: { prompt_tokens: p, completion_tokens: c, cache_read_input_tokens: cache, total_tokens: p + c + cache },
    });

    beforeEach(() => {
        v.selectedTaskId = 'T1';
        v.tasks = [task('T1')];
        v.logs = [];
        v.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    });

    it('prefers the LIVE accumulator during a run', () => {
        v.tokenUsage.total_tokens = 999;
        v.tasks[0].token_usage = { total_tokens: 5 };
        expect(v._usageTotals().total_tokens).toBe(999);
    });

    it('falls back to the task record for a run loaded from history', () => {
        v.tasks[0].token_usage = { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 };
        expect(v._usageTotals().total_tokens).toBe(1000);
    });

    it('sums the logs when neither is available', () => {
        v.logs = [usageLog(100, 20, 5), usageLog(200, 30, 10)];
        const u = v._usageTotals();
        expect(u.prompt_tokens).toBe(300);
        expect(u.completion_tokens).toBe(50);
        expect(u.cache_read_input_tokens).toBe(15);
        expect(u.total_tokens).toBe(365);
    });

    it('derives a missing total rather than reporting zero', () => {
        v.logs = [{ event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 4 } }];
        expect(v._usageTotals().total_tokens).toBe(14);
    });

    it('returns zeros — not undefined — when there is nothing at all', () => {
        expect(v._usageTotals()).toMatchObject({ total_tokens: 0, prompt_tokens: 0 });
    });

    it('the task record is ignored when it is empty', () => {
        v.tasks[0].token_usage = {};
        v.logs = [usageLog(7, 3, 0)];
        expect(v._usageTotals().total_tokens).toBe(10);
    });
});

// The new-task modal moved to svelte/monitor/NewTaskModal.svelte; its tests are
// in svelte/monitor/__tests__/newTaskModal.test.js, and the payload's rules
// (mcp_servers explicitly empty, images omitted rather than sent empty) in
// views/monitor/__tests__/newTaskRequest.test.js.

// Reported: the approval card appeared in the Raw Log but not in the Story, and
// its buttons did nothing. Both follow from ONE cause — a confirm_request whose
// data carries no confirmId. The raw log renders the packet unconditionally,
// while the story path returned early on the missing id; and the buttons the raw
// log did draw carried `data-confirm-id="undefined"`, which the server cannot
// match to anything.
describe('an approval that arrives without an id', () => {
    const bad = {
        type: 'command_confirm', command: 'npm test',
        message: 'AI wants to run this terminal command:', risk: 'normal', allowAlways: true,
    };

    it('still reaches the Story, rather than vanishing from it', async () => {
        mount({ selectedTaskId: 'T1', tasks: [task('T1')] });
        v._showTaskConfirm(bad);
        await tick();
        expect(document.querySelector('.mresult .mconfirm-box')).toBeTruthy();
    });

    // A button that silently does nothing is the worst of the options: the user
    // waits for a run that will never resume.
    it('says why it cannot be answered instead of doing nothing', () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        v.socket = { readyState: 1, send: vi.fn() };
        v.sendConfirmResponse(undefined, true);
        expect(v.socket.send).not.toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/no id/i));
        alertSpy.mockRestore();
    });

    // The id arrives through the DOM, so it is the STRING "undefined" that a
    // button ends up carrying — not the value.
    it('recognises the string forms too', () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        v.socket = { readyState: 1, send: vi.fn() };
        for (const id of ['undefined', 'null', '']) {
            v.sendConfirmResponse(id, true);
        }
        expect(v.socket.send).not.toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledTimes(3);
        alertSpy.mockRestore();
    });

    it('sends normally when the id is real', () => {
        v.socket = { readyState: 1, send: vi.fn() };
        v.sendConfirmResponse('c1', true);
        expect(v.socket.send).toHaveBeenCalledTimes(1);
        expect(JSON.parse(v.socket.send.mock.calls[0][0])).toMatchObject({
            event: 'confirm_response', data: { confirmId: 'c1', approved: true },
        });
    });
});

describe('pane dividers — drag-resizable edges', () => {
    // The Monitor's three columns (task list ↔ story ↔ inspector) resize by
    // dragging the two .mpane-divider hit areas. The widths are remembered in
    // localStorage (jhai_monitor_left_width / _insp_width) and applied to the
    // layout root as CSS variables so every pane reads them consistently.

    beforeEach(() => {
        localStorage.clear();
        // Defaults: 240 (task list) / 264 (inspector) from the module vars.
        mount({ _leftPaneWidth: 240, _inspPaneWidth: 264, selectedTaskId: 'T1', tasks: [task('T1')] });
    });

    // jsdom has no PointerEvent constructor — MouseEvent carries clientX, and
    // the handler only listens to the event NAME, so 'pointer*' + MouseEvent
    // exercises the same path a real pointer drag does.
    const pointer = (type, clientX) =>
        new MouseEvent(type, { clientX, bubbles: true, cancelable: true });

    /** 0 = the task-list edge, 1 = the inspector edge (only while it is open). */
    const dividerAt = (i) => document.querySelectorAll('.mpane-divider')[i];

    const drag = (which, dx, startX = 100) => {
        const divider = dividerAt(which);
        divider.dispatchEvent(pointer('pointerdown', startX));
        document.dispatchEvent(pointer('pointermove', startX + dx));
        document.dispatchEvent(pointer('pointerup', startX + dx));
    };

    it('applies the remembered widths as CSS variables on bind', () => {
        const layout = document.querySelector('.monitor-layout');
        expect(layout.style.getPropertyValue('--mpane-left-w')).toBe('240px');
        expect(layout.style.getPropertyValue('--mpane-insp-w')).toBe('264px');
    });

    it('left divider grows the task list and persists the width', () => {
        drag(0, 60);
        const layout = document.querySelector('.monitor-layout');
        expect(layout.style.getPropertyValue('--mpane-left-w')).toBe('300px');
        expect(localStorage.getItem('jhai_monitor_left_width')).toBe('300');
    });

    it('tracks the cursor WITHOUT accumulating across moves', () => {
        // Each move applies base + dx from the pointerdown snapshot, not the
        // previously-updated width — otherwise a fast drag (many moves) runs
        // ahead of the cursor and snaps between positions.
        const divider = dividerAt(0);
        divider.dispatchEvent(pointer('pointerdown', 100));
        document.dispatchEvent(pointer('pointermove', 130));   // dx=30 → 270
        document.dispatchEvent(pointer('pointermove', 140));   // dx=40 → 280 (NOT 270+40)
        document.dispatchEvent(pointer('pointermove', 145));   // dx=45 → 285
        document.dispatchEvent(pointer('pointerup', 145));
        const layout = document.querySelector('.monitor-layout');
        expect(layout.style.getPropertyValue('--mpane-left-w')).toBe('285px');
        expect(localStorage.getItem('jhai_monitor_left_width')).toBe('285');
    });

    it('inspector drag tracks the cursor too', () => {
        mount({ _inspectorOpen: true });
        const divider = dividerAt(1);
        divider.dispatchEvent(pointer('pointerdown', 200));
        document.dispatchEvent(pointer('pointermove', 180));   // dx=-20 → 284
        document.dispatchEvent(pointer('pointermove', 170));   // dx=-30 → 294
        document.dispatchEvent(pointer('pointerup', 170));
        const layout = document.querySelector('.monitor-layout');
        expect(layout.style.getPropertyValue('--mpane-insp-w')).toBe('294px');
        expect(localStorage.getItem('jhai_monitor_insp_width')).toBe('294');
    });

    it('left divider clamps to PANE_W_MIN/PANE_W_MAX', () => {
        // Dragging far beyond the limits never APPLIES the out-of-range width
        // (the handler refuses the update, so the pane stays at the boundary).
        drag(0, -60);   // 240 - 60 → 180 (min boundary)
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('180px');
        drag(0, -500);  // 180 - 500 → refused, stays 180
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('180px');
        drag(0, 460);   // 180 + 460 → 640 (max boundary)
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('640px');
        drag(0, 500);   // 640 + 500 → refused, stays 640
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('640px');
    });

    it('inspector divider shrinks the inspector and persists the width', () => {
        mount({ _inspectorOpen: true });
        drag(1, 40);     // dragging right → inspector NARROWS
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-insp-w')).toBe('224px');
        expect(localStorage.getItem('jhai_monitor_insp_width')).toBe('224');
    });

    it('removes the resizing class and listeners after pointerup', () => {
        const divider = dividerAt(0);
        divider.dispatchEvent(pointer('pointerdown', 100));
        expect(document.body.classList.contains('resizing-panes')).toBe(true);
        document.dispatchEvent(pointer('pointerup', 100));
        expect(document.body.classList.contains('resizing-panes')).toBe(false);
        // A later move must no longer resize anything.
        document.dispatchEvent(pointer('pointermove', 500));
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('240px');
    });

    it('re-binds after a re-render that replaces the layout', () => {
        mount({ selectedTaskId: 'T1', tasks: [task('T1')] });
        v._leftPaneWidth = 240;
        v._sync();
        drag(0, 30);
        expect(document.querySelector('.monitor-layout').style.getPropertyValue('--mpane-left-w')).toBe('270px');
    });
});

describe('chapter jump scrolls ONLY the story panel', () => {
    // The regression: scrollIntoView scrolls EVERY scrollable ancestor — including
    // the app shell's .main-content — so a chapter jump yanked the whole page up
    // and hid the task header behind the top edge. _scrollStoryTo must move only
    // #result-panel and never touch an outer container.
    // NOTE the class: .mtl is what MonitorRoot renders around the timeline. This
    // fixture used to say id="task-timeline" — the mount host from before the
    // migration — so it kept passing after the selector it stands in for had
    // stopped matching anything in the real view.
    const page = () => {
        document.body.innerHTML = `
            <div class="main-content">
                <div class="monitor-layout">
                    <div class="mpanel-right">
                        <div class="mconsole mresult">
                            <div class="mtl">
                                <div data-item-id="req1" style="height:60px">request</div>
                                <div data-item-id="deliv1" style="height:60px">deliverable</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
    };

    const rect = (el, top, height = 50) => {
        el.getBoundingClientRect = () => ({ top, height, bottom: top + height });
    };

    beforeEach(() => { page(); });

    it('positions the target under the filter bar in #result-panel', () => {
        const panel = document.querySelector('.mresult');
        rect(panel, 100, 600);          // panel viewport starts at y=100
        panel.scrollTop = 0;
        const scrollTo = vi.fn();
        panel.scrollTo = scrollTo;
        const row = document.querySelector('[data-item-id="deliv1"]');
        rect(row, 1250);                // 1150px below the panel's top edge

        v._jumpToChapter('deliv1');

        expect(scrollTo).toHaveBeenCalledWith({
            top: 1250 - 100 - 8,        // rel (1250-100) − 8px air under the bar
            behavior: 'smooth',
        });
        // The rail reads the active chapter off its props.
        expect(v._activeChapter).toBe('deliv1');
    });

    it('never calls scrollIntoView, so outer containers cannot move', () => {
        const row = document.querySelector('[data-item-id="req1"]');
        rect(row, 300);
        const panel = document.querySelector('.mresult');
        rect(panel, 100, 600);
        panel.scrollTop = 0;
        const scrollTo = vi.fn();
        panel.scrollTo = scrollTo;
        const spy = vi.fn();
        row.scrollIntoView = spy;

        v._jumpToChapter('req1');

        expect(spy).not.toHaveBeenCalled();
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('clamps to the top and tolerates a missing row', () => {
        const panel = document.querySelector('.mresult');
        rect(panel, 100, 600);
        panel.scrollTop = 50;
        const scrollTo = vi.fn();
        panel.scrollTo = scrollTo;
        // Target ABOVE the current scroll — negative offset must clamp to 0.
        const row = document.querySelector('[data-item-id="req1"]');
        rect(row, 10);

        v._jumpToChapter('req1');
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

        // Missing row → no scroll at all, no crash.
        scrollTo.mockClear();
        v._jumpToChapter('no-such-chapter');
        expect(scrollTo).not.toHaveBeenCalled();
    });
});

// The Story view shows pending approvals (🛡 Command Approval) as timeline cards.
// The LIVE path pushes them via _showTaskConfirm, but a task rebuilt from stored
// logs (reload / task re-selection / completion rebuild) goes through
// buildTimeline — which used to ignore confirm_request entirely, so the card
// silently vanished from the Story while Raw Log still showed it.
describe('Story rebuild restores a pending approval card', () => {
    const page = () => {
        mount();
        v.tasks = [task('t1')];
        v.selectedTaskId = 't1';
        v._renderResultPanel();
    };

    const confirmLog = (cid = 'conf_9', over = {}) => ({
        event: 'confirm_request', timestamp: '2026-07-01T00:00:00Z',
        data: {
            confirmId: cid, type: 'command_confirm',
            command: 'git push --force', message: 'AI wants to run this terminal command:',
            risk: 'dangerous', allowAlways: false, ...over,
        },
    });

    it('replaying logs with a pending approval re-renders the 🛡 card', async () => {
        page();
        v.logs = [
            { event: 'status', timestamp: '2026-07-01T00:00:00Z', data: { status: 'running', message: 'Thinking... (step 1)' } },
            confirmLog(),
        ];
        v._rebuildResultSummaries();
        v._renderResultPanel();
        await tick();

        const timeline = document.querySelector('.mtl');
        expect(timeline.textContent).toContain('🛡 Command Approval');
        expect(timeline.textContent).toContain('git push --force');
        expect(timeline.querySelector('.btn-approve')).not.toBe(null);
        expect(timeline.querySelector('.btn-reject')).not.toBe(null);
    });

    it('an approval followed by tool activity is NOT resurrected (it was answered)', async () => {
        page();
        v.logs = [
            { event: 'status', timestamp: '2026-07-01T00:00:00Z', data: { status: 'running', message: 'Thinking... (step 1)' } },
            confirmLog('conf_10'),
            { event: 'tool_call', timestamp: '2026-07-01T00:00:02Z', data: { name: 'run_command', args: {} } },
        ];
        v._rebuildResultSummaries();
        v._renderResultPanel();
        await tick();

        expect(storyEl().textContent).not.toContain('🛡 Command Approval');
    });
});

describe('live approval card renders in the Story (the _showTaskConfirm path)', () => {
    const page = () => {
        mount();
        v.tasks = [task('t1')];
        v.selectedTaskId = 't1';
        v._renderResultPanel();
    };

    it('a live confirm_request shows the 🛡 card with working buttons', async () => {
        page();
        v._showTaskConfirm({
            confirmId: 'conf_live_1', type: 'command_confirm',
            command: 'Remove-Item -Recurse tmp', message: 'AI wants to run this terminal command:',
            risk: 'dangerous', allowAlways: false,
        });
        await tick();

        const timeline = document.querySelector('.mtl');
        expect(timeline.textContent).toContain('🛡 Command Approval');
        expect(timeline.textContent).toContain('Remove-Item -Recurse tmp');
        expect(timeline.querySelector('[data-confirm-card="conf_live_1"]')).not.toBe(null);
    });

    it('survives a subsequent _rebuildResultSummaries() (e.g. completion) as long as it is still pending', async () => {
        // The rebuild used to wipe the card because buildTimeline ignored
        // confirm_request entirely — the exact regression being fixed.
        page();
        const live = {
            confirmId: 'conf_live_2', type: 'command_confirm',
            command: 'git push --force', message: 'AI wants to run this terminal command:',
            risk: 'dangerous', allowAlways: false,
        };
        v._showTaskConfirm(live);
        v.logs = [
            { event: 'status', timestamp: '2026-07-01T00:00:00Z', data: { status: 'running', message: 'Thinking... (step 1)' } },
            { event: 'confirm_request', timestamp: '2026-07-01T00:00:00Z', data: live },
        ];
        v._rebuildResultSummaries();
        v._renderResultPanel();
        await tick();

        expect(storyEl().textContent).toContain('🛡 Command Approval');
        expect(storyEl().textContent).toContain('git push --force');
    });
});

// The raw log moved to svelte/monitor/RawLog.svelte — one model over `this.logs`
// (monitor/logs.js buildLogSteps) instead of the string renderer and the
// incremental DOM builder that both derived it. Its tests, including the request
// divider's single separator, are in svelte/monitor/__tests__/rawLog.test.js.
