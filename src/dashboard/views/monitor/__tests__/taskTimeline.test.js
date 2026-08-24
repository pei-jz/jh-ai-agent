// The ordering rules that used to live inside DOM handlers and could not be
// tested. Every case here corresponds to a reported Task-view symptom.

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskTimeline, buildTimeline, envelopeText, splitForPanes, chapters, replayLineType, replayStepNo, withTurnDividers, clockText, withExchangeFolds, exchangeCount, collapsedIds, pinLiveProgress } from '../taskTimeline.js';

const kinds = (tl) => tl.items.map(i => i.kind);

let tl;
beforeEach(() => { tl = new TaskTimeline(); });

describe('reasoning groups', () => {
    it('nests the lines a reasoning step produced under it', () => {
        tl.pushActivity('thought', 'I will read the workbook');
        tl.pushActivity('tool', 'read_office a.xlsx');
        tl.pushActivity('tool', 'read_office b.xlsx');

        expect(kinds(tl)).toEqual(['group']);
        expect(tl.items[0].lines.map(l => l.text)).toEqual(['read_office a.xlsx', 'read_office b.xlsx']);
    });

    it('a new reasoning line starts a new group', () => {
        tl.pushActivity('thought', 'first');
        tl.pushActivity('tool', 'a');
        tl.pushActivity('thought', 'second');
        tl.pushActivity('tool', 'b');

        expect(kinds(tl)).toEqual(['group', 'group']);
        expect(tl.items[0].lines).toHaveLength(1);
        expect(tl.items[1].lines).toHaveLength(1);
    });

    it('bumps rev when a line joins a group, so a renderer notices', () => {
        const g = tl.pushActivity('thought', 'x');
        const before = g.rev;
        tl.pushActivity('tool', 'y');
        expect(g.rev).toBe(before + 1);
    });

    it('lines before the first reasoning stand on their own', () => {
        tl.pushActivity('tool', 'early');
        expect(kinds(tl)).toEqual(['activity']);
    });

    it('ignores blank lines instead of emitting empty rows', () => {
        expect(tl.pushActivity('tool', '   ')).toBe(null);
        expect(tl.pushActivity('thought', null)).toBe(null);
        expect(tl.items).toHaveLength(0);
    });
});

describe('narration', () => {
    it('REPLACES itself as prose streams in, rather than stacking copies', () => {
        tl.pushNarration('Let me');
        tl.pushNarration('Let me look at');
        tl.pushNarration('Let me look at the sheets');

        expect(kinds(tl)).toEqual(['narration']);
        expect(tl.items[0].text).toBe('Let me look at the sheets');
        expect(tl.items[0].rev).toBe(2);
    });

    it('a new reasoning step closes the open narration', () => {
        tl.pushNarration('first prose');
        tl.pushActivity('thought', 'now acting');
        tl.pushNarration('second prose');
        expect(kinds(tl)).toEqual(['narration', 'group', 'narration']);
    });
});

describe('deliverable (present_result)', () => {
    it('an EMPTY follow-up envelope must not clobber real content', () => {
        tl.pushDeliverable('markdown', '# The report');
        tl.pushDeliverable('answer', '');
        expect(tl.items).toHaveLength(1);
        expect(tl.items[0].text).toBe('# The report');
    });

    it('a non-empty follow-up updates in place', () => {
        tl.pushDeliverable('markdown', 'draft');
        tl.pushDeliverable('markdown', 'final');
        expect(tl.items).toHaveLength(1);
        expect(tl.items[0].text).toBe('final');
        expect(tl.items[0].rev).toBe(1);
    });

    it('ignores an empty first envelope', () => {
        expect(tl.pushDeliverable('markdown', '  ')).toBe(null);
        expect(tl.items).toHaveLength(0);
    });
});

describe('ask_user', () => {
    it('keeps the question and its choices in ONE item', () => {
        const ask = tl.pushAsk({ text: '❓ どちらにしますか', options: ['A', 'B'], multi: false });
        expect(ask.text).toBe('どちらにしますか');       // the ❓ prefix is display, not content
        expect(ask.options).toEqual(['A', 'B']);
    });

    it('a FREE-TEXT question still produces an item — it used to vanish entirely', () => {
        // Options were what created the card; without them the question only
        // existed inside a feed that had just been collapsed.
        const ask = tl.pushAsk({ text: '対象のシート名を教えてください' });
        expect(ask).not.toBe(null);
        expect(ask.options).toEqual([]);
        expect(kinds(tl)).toContain('ask');
    });

    it('ends the current reasoning group', () => {
        tl.pushActivity('thought', 'thinking');
        tl.pushAsk({ text: 'q?' });
        tl.pushActivity('tool', 'after');
        // The tool line must NOT be swallowed by the pre-question group.
        expect(tl.items[0].lines).toHaveLength(0);
        expect(kinds(tl)).toEqual(['group', 'ask', 'activity']);
    });

    it('drops junk options rather than rendering empty buttons', () => {
        expect(tl.pushAsk({ text: 'q', options: ['ok', '', 3, null] }).options).toEqual(['ok']);
    });

    it('updates the open question instead of stacking a second one', () => {
        tl.pushAsk({ text: 'first' });
        tl.pushAsk({ text: 'second', options: ['x'] });
        expect(tl.items.filter(i => i.kind === 'ask')).toHaveLength(1);
        expect(tl.items[0].text).toBe('second');
    });

    it('an answered question stays as a record of the exchange', () => {
        tl.pushAsk({ text: 'q' });
        tl.resolveAsk('my answer');
        const ask = tl.items.find(i => i.kind === 'ask');
        expect(ask.answered).toBe(true);
        expect(ask.answer).toBe('my answer');
    });

    it('resolving with no open question is a no-op', () => {
        expect(tl.resolveAsk('x')).toBe(null);
    });
});

describe('confirm', () => {
    it('holds at most one pending approval', () => {
        tl.pushConfirm('run npm test?');
        tl.pushConfirm('run npm build?');
        expect(tl.items.filter(i => i.kind === 'confirm')).toHaveLength(1);
        expect(tl.items[0].text).toBe('run npm build?');
    });

    it('resolving REMOVES it — a decided approval is not history worth keeping', () => {
        tl.pushConfirm('x');
        tl.resolveConfirm();
        expect(kinds(tl)).toEqual([]);
    });

    it('resolving nothing is a no-op', () => {
        expect(tl.resolveConfirm()).toBe(null);
    });
});

describe('task_progress', () => {
    const items = () => [
        { id: '1', title: '調査', status: 'pending' },
        { id: '2', title: '実装', status: 'in_progress' },
        { id: '3', title: 'テスト', status: 'completed' },
    ];

    it('adds its own chapter with the checklist', () => {
        tl.pushTaskProgress(items());
        expect(kinds(tl)).toEqual(['task_progress']);
        expect(tl.items[0].items).toHaveLength(3);
        expect(tl.items[0].items[1].status).toBe('in_progress');
    });

    it('REPLACES the list in place on update instead of stacking cards', () => {
        // Same plan, statuses moving forward — ONE card, refreshed in place.
        tl.pushTaskProgress(items());
        tl.pushTaskProgress(items().map(t => ({ ...t, status: 'completed' })));
        expect(tl.items.filter(i => i.kind === 'task_progress')).toHaveLength(1);
        expect(tl.items[0].items).toHaveLength(3);
        expect(tl.items[0].rev).toBe(1);   // the renderer is told it changed
    });

    it('gives a DIFFERENT plan its own card instead of reusing the first', () => {
        // A multi-turn task: the agent plans, asks, then replans with a new
        // checklist. The old card showed the FIRST plan's progress while the
        // agent executed the second — the reported confusion.
        tl.pushTaskProgress(items());
        tl.pushTaskProgress([
            { id: 'a', title: '新計画1', status: 'in_progress' },
            { id: 'b', title: '新計画2', status: 'pending' },
        ]);
        const cards = tl.items.filter(i => i.kind === 'task_progress');
        expect(cards).toHaveLength(2);
        expect(cards[0].items.map(t => t.id)).toEqual(['1', '2', '3']);
        expect(cards[1].items.map(t => t.id)).toEqual(['a', 'b']);
    });

    it('updates the card in place when only STATUSES change (same plan)', () => {
        tl.pushTaskProgress(items());
        const done = items().map(t => ({ ...t, status: t.id === '1' ? 'completed' : t.status }));
        tl.pushTaskProgress(done);
        const cards = tl.items.filter(i => i.kind === 'task_progress');
        expect(cards).toHaveLength(1);
        expect(cards[0].items[0].status).toBe('completed');
    });

    it('normalises entries and drops junk', () => {
        const p = tl.pushTaskProgress([
            { id: 1, title: 'ok', status: 'pending' },
            { title: 'no id', status: 'pending' },
            null,
            'junk',
        ]);
        expect(p.items).toHaveLength(2);
        expect(p.items[0].id).toBe('1');
    });

    it('ignores an empty payload', () => {
        expect(tl.pushTaskProgress([])).toBe(null);
        expect(tl.pushTaskProgress(null)).toBe(null);
        expect(tl.items).toHaveLength(0);
    });

    it('ends the current reasoning group, like ask', () => {
        tl.pushActivity('thought', 'thinking');
        tl.pushTaskProgress(items());
        tl.pushActivity('tool', 'after');
        expect(tl.items[0].lines).toHaveLength(0);
        expect(kinds(tl)).toEqual(['group', 'task_progress', 'activity']);
    });

    it('a completed run does not sweep the checklist away', () => {
        tl.pushRequest('do it');
        tl.pushTaskProgress(items());
        tl.pushRun({ request: 'do it', answer: 'done' });
        expect(kinds(tl)).toContain('task_progress');
    });
});

describe('pinLiveProgress — the checklist stays visible while the run is live', () => {
    // Build a stream shaped like the rendered timeline: settled history, the
    // checklist card, then live activity below it.
    const stream = () => [
        { id: 'a', kind: 'request', live: false },
        { id: 'b', kind: 'run', live: false },
        { id: 'c', kind: 'task_progress', live: false, items: [] },
        { id: 'd', kind: 'group', live: true },
        { id: 'e', kind: 'activity', live: true },
    ];

    it('pins the card to the BOTTOM while the run is live', () => {
        const out = pinLiveProgress(stream(), true);
        const kinds = out.map(i => i.kind);
        // The live request is itself flagged live, so "ahead of the first live
        // item" would pin the card to the TOP — the exact burying this function
        // exists to fix. The card goes to the end, where the reader is looking.
        expect(kinds).toEqual(['request', 'run', 'group', 'activity', 'task_progress']);
    });

    it('leaves the order untouched when the run is NOT live', () => {
        expect(pinLiveProgress(stream(), false).map(i => i.kind))
            .toEqual(['request', 'run', 'task_progress', 'group', 'activity']);
    });

    it('keeps a live request ABOVE the pinned card (the request stays first)', () => {
        // The run is live, so the request is live too. The card must NOT jump
        // above it — that is the original bug (card pinned at the top).
        const liveReq = stream().map(i => (i.kind === 'request' ? { ...i, live: true } : i));
        const out = pinLiveProgress(liveReq, true);
        expect(out[0].kind).toBe('request');
        expect(out[out.length - 1].kind).toBe('task_progress');
    });

    it('returns the same array reference when there is no progress card', () => {
        const noCard = stream().filter(i => i.kind !== 'task_progress');
        expect(pinLiveProgress(noCard, true)).toBe(noCard);
    });

    it('appends at the end when everything is settled (no live items)', () => {
        const settled = stream().map(i => ({ ...i, live: false }));
        const out = pinLiveProgress(settled, true);
        expect(out[out.length - 1].kind).toBe('task_progress');
    });

    it('does not mutate the input array', () => {
        const input = stream();
        const before = input.map(i => i.id).join(',');
        pinLiveProgress(input, true);
        expect(input.map(i => i.id).join(',')).toBe(before);
    });

    it('pins ONLY the LATEST card when a replan left several in the story', () => {
        // Old cards are history: pinning them all would stack a pile of
        // checklists at the bottom. The newest plan is the one being executed.
        const multi = [
            { id: 'old', kind: 'task_progress', live: false, items: [] },
            { id: 'req', kind: 'request', live: true },
            { id: 'g', kind: 'group', live: true },
            { id: 'new', kind: 'task_progress', live: false, items: [] },
        ];
        const out = pinLiveProgress(multi, true);
        expect(out[0].id).toBe('old');        // stays in place
        expect(out[out.length - 1].id).toBe('new');  // pinned to the bottom
        expect(out.filter(i => i.kind === 'task_progress')).toHaveLength(2);
    });
});

describe('run completion', () => {
    it('KEEPS the reasoning steps, folded — they are how the run got there', () => {
        // Deleting them meant the story could only be read while it was being
        // written. Folded, a step costs one line.
        tl.pushRequest('compare the sheets');
        tl.pushActivity('thought', 'reading');
        tl.pushActivity('tool', 'read_office');
        tl.pushNarration('working…');
        tl.pushDeliverable('markdown', '# Report');
        tl.pushRun({ request: 'compare the sheets', answer: '# Report', files: [], stats: {} });

        // The REQUEST leads its own exchange and survives completion: it is the
        // thing every step below it answers to.
        expect(kinds(tl)).toEqual(['request', 'group', 'run']);
        const step = tl.items[1];
        expect(step.collapsed).toBe(true);
        expect(step.live).toBe(false);
        expect(step.lines).toHaveLength(1);        // its tool line is still there
        expect(tl.items[2].answer).toBe('# Report');
    });

    it('still drops the transient prose and the loose request bubble', () => {
        tl.pushRequest('do it');
        tl.pushNarration('thinking out loud');
        tl.pushRun({ request: 'do it', answer: 'done' });
        // The prose goes; the request stays, where and when it was made.
        expect(kinds(tl)).toEqual(['request', 'run']);
    });

    it('an UNANSWERED question survives, and sits BELOW the exchange', () => {
        // Reported: the question rendered ABOVE the request that led to it, so the
        // panel read "answer this — and here, below, is what you asked for".
        tl.pushActivity('thought', 'thinking');
        tl.pushAsk({ text: 'which sheet?' });
        tl.pushRun({ request: 'r', answer: 'a' });

        expect(kinds(tl)).toEqual(['request', 'group', 'run', 'ask']);
    });

    it('KEEPS a delivered report the run answer does not restate', () => {
        // The agent can present a report and then pause on a question; the run's
        // `answer` is then only its closing thought. Dropping the deliverable made
        // the report the user was reading vanish on completion.
        tl.pushDeliverable('markdown', '# 詳細レポート\nここに本文');
        tl.pushAsk({ text: 'どの案にしますか' });
        tl.pushRun({ request: 'r', answer: '案を提示しました' });

        expect(kinds(tl)).toEqual(['request', 'run', 'deliverable', 'ask']);
        expect(tl.items[2].text).toContain('詳細レポート');
    });

    it('drops a deliverable the answer already contains (no double report)', () => {
        const report = '# レポート本文';
        tl.pushDeliverable('markdown', report);
        tl.pushRun({ request: 'r', answer: `${report}\n\n以上です` });
        expect(kinds(tl)).toEqual(['request', 'run']);
    });

    it('an ANSWERED question is folded away like the rest of the trace', () => {
        tl.pushAsk({ text: 'q' });
        tl.resolveAsk('a');
        tl.pushRun({ request: 'r', answer: 'x' });
        expect(kinds(tl)).toEqual(['request', 'run']);
    });

    it('several runs accumulate as a conversation', () => {
        tl.pushRun({ request: 'one', answer: 'first' });
        tl.pushActivity('thought', 'more work');
        tl.pushRun({ request: 'two', answer: 'second' });
        // Each exchange opens with its own request, in order.
        expect(kinds(tl)).toEqual(['request', 'run', 'request', 'group', 'run']);
        expect(tl.items.filter(i => i.kind === 'request').map(i => i.text)).toEqual(['one', 'two']);
    });

    it('prefers `answer`, falling back to `summary`', () => {
        tl.pushRun({ request: 'r', summary: 'only summary' });
        expect(tl.items[1].answer).toBe('only summary');
    });

    it('ignores a completion with no summary object', () => {
        expect(tl.pushRun(null)).toBe(null);
        expect(tl.items).toHaveLength(0);
    });
});

// File descriptions are generated by an LLM call that deliberately does NOT gate
// completion, so they land after the run is already on screen.
describe('late file descriptions (patchRun)', () => {
    const files = () => [
        { path: 'src/a.js', action: 'modified', description: '' },
        { path: 'src/b.js', action: 'created', description: '' },
    ];

    it('fills in descriptions on the run already pushed', () => {
        tl.pushRun({ request: 'r', answer: 'done', files: files() });
        const ok = tl.patchRun([
            { path: 'src/a.js', description: 'the loop' },
            { path: 'src/b.js', description: 'the store' },
        ]);
        expect(ok).toBe(true);
        expect(tl.items[1].files.map(f => f.description)).toEqual(['the loop', 'the store']);
    });

    it('does not add a second run item', () => {
        tl.pushRun({ request: 'r', answer: 'done', files: files() });
        tl.patchRun([{ path: 'src/a.js', description: 'x' }]);
        expect(tl.items.filter(i => i.kind === 'run')).toHaveLength(1);
    });

    it('bumps rev so a keyed renderer redraws the row', () => {
        const run = tl.pushRun({ request: 'r', answer: 'done', files: files() });
        const before = run.rev;
        tl.patchRun([{ path: 'src/a.js', description: 'x' }]);
        expect(run.rev).toBe(before + 1);
    });

    it('patches the LATEST run, not an earlier one', () => {
        tl.pushRun({ request: 'one', answer: 'a', files: [{ path: 'old.js', description: '' }] });
        tl.pushRun({ request: 'two', answer: 'b', files: files() });
        tl.patchRun([{ path: 'old.js', description: 'should not apply' }]);
        const runs = tl.items.filter(i => i.kind === 'run');
        expect(runs[0].files[0].description).toBe('');
    });

    it('ignores paths the run never touched, and empty descriptions', () => {
        tl.pushRun({ request: 'r', answer: 'done', files: files() });
        expect(tl.patchRun([{ path: 'ghost.js', description: 'nope' }])).toBe(false);
        expect(tl.patchRun([{ path: 'src/a.js', description: '' }])).toBe(false);
    });

    it('is a no-op when no run has been pushed yet', () => {
        expect(tl.patchRun([{ path: 'src/a.js', description: 'x' }])).toBe(false);
        expect(tl.items).toHaveLength(0);
    });

    it('survives a replay: buildTimeline applies the patch event', () => {
        const built = buildTimeline([
            { event: 'complete', timestamp: '2026-08-11T00:00:00Z', data: { resultSummary: { request: 'r', answer: 'done', files: files() } } },
            { event: 'result_update', timestamp: '2026-08-11T00:00:05Z', data: { files: [{ path: 'src/b.js', description: 'the store' }] } },
        ]);
        const run = built.items.find(i => i.kind === 'run');
        expect(run.files.find(f => f.path === 'src/b.js').description).toBe('the store');
    });
});

describe('clearLive', () => {
    it('drops the trace but keeps runs and an open question', () => {
        tl.pushRun({ request: 'r', answer: 'a' });
        tl.pushActivity('thought', 't');
        tl.pushAsk({ text: 'q' });
        tl.clearLive();
        expect(kinds(tl)).toEqual(['request', 'run', 'ask']);
    });
});

describe('trimming', () => {
    it('bounds the live trace', () => {
        const small = new TaskTimeline({ maxLive: 5 });
        for (let i = 0; i < 20; i++) small.pushActivity('tool', `line ${i}`);
        expect(small.items.length).toBeLessThanOrEqual(5);
        // The NEWEST lines are the ones kept.
        expect(small.items[small.items.length - 1].text).toBe('line 19');
    });

    it('never trims a completed run or an open question', () => {
        const small = new TaskTimeline({ maxLive: 3 });
        small.pushRun({ request: 'r', answer: 'a' });
        small.pushAsk({ text: 'q' });
        for (let i = 0; i < 20; i++) small.pushActivity('tool', `l${i}`);
        expect(kinds(small)).toContain('run');
        expect(kinds(small)).toContain('ask');
    });

    it('reopens grouping safely when the open group was trimmed away', () => {
        const small = new TaskTimeline({ maxLive: 2 });
        small.pushActivity('thought', 'head');
        for (let i = 0; i < 10; i++) small.pushActivity('tool', `l${i}`);
        expect(() => small.pushActivity('tool', 'after')).not.toThrow();
    });
});

describe('snapshot / restore', () => {
    it('survives a teardown as DATA, not DOM — grouping keeps working after', () => {
        tl.pushActivity('thought', 'head');
        tl.pushActivity('tool', 'a');
        const snap = tl.snapshot();

        const fresh = new TaskTimeline();
        expect(fresh.restore(snap)).toBe(true);
        // The old code stored a DOM node here; after a restore it was detached
        // and every later line silently stopped nesting.
        fresh.pushActivity('tool', 'b');
        const group = fresh.items.find(i => i.kind === 'group');
        expect(group.lines.map(l => l.text)).toEqual(['a', 'b']);
    });

    it('a snapshot is independent of the live timeline', () => {
        tl.pushActivity('thought', 'x');
        const snap = tl.snapshot();
        tl.pushActivity('tool', 'later');
        expect(snap.items[0].lines).toHaveLength(0);
    });

    it('rejects junk', () => {
        expect(tl.restore(null)).toBe(false);
        expect(tl.restore({})).toBe(false);
    });

    it('new ids do not collide with restored ones', () => {
        tl.pushActivity('thought', 'a');
        tl.pushActivity('thought', 'b');
        const fresh = new TaskTimeline();
        fresh.restore(tl.snapshot());
        const added = fresh.pushActivity('thought', 'c');
        expect(fresh.items.map(i => i.id)).toHaveLength(3);
        expect(fresh.items.filter(i => i.id === added.id)).toHaveLength(1);
    });
});

describe('buildTimeline (replay)', () => {
    const complete = (request, answer, ts) => ({
        event: 'complete', timestamp: ts,
        data: { resultSummary: { request, answer, files: [], stats: {} } },
    });

    // The loop keeps emitting after it has broken on a question: long-term
    // memory, learned cards. Those carry `phase: 'teardown'`, and reading them as
    // "a new run is progressing" closed the question the run was paused on.
    const ask = (text) => ({ event: 'status', data: { status: 'waiting', message: text } });
    const teardown = (message) => ({ event: 'status', data: { status: 'running', phase: 'teardown', message } });

    // The Story is rebuilt from stored logs on completion and on reload, and the
    // rebuild draws tool rows from TOOL telemetry ONLY — `tool_call` is a
    // live-only event with no branch here. A call blocked by the user's
    // permission settings emitted `tool_call` and nothing else, so it showed
    // while the run was going and vanished the moment it finished: the one case
    // where the user most needs to see what was attempted.
    const toolLog = (name, request, status) => ({
        event: 'log', timestamp: 1, data: { method: 'TOOL', name, request, status },
    });
    const rowsOf = (logs) => {
        const s = buildTimeline(logs).snapshot();
        return [...(s.live || []), ...(s.items || [])];
    };

    it('replays a call the permission settings blocked', () => {
        const rows = rowsOf([
            { event: 'tool_call', timestamp: 1, data: { name: 'run_command', args: { command: 'rm -rf build' }, status: 'denied' } },
            toolLog('run_command', { command: 'rm -rf build' }, 500),
        ]);
        expect(rows.map(r => r.text).join('\n')).toContain('run_command');
    });

    // The telemetry carried `status: 500` and the line threw it away, so every
    // replayed step wore a tick whether it had worked or not. The Overview feed
    // had been reading that status all along — the same run therefore read as
    // failed in one surface and clean in the other.
    it('distinguishes a failed call from a successful one', () => {
        const ok = rowsOf([toolLog('run_command', { command: 'npm test' }, 200)]);
        const bad = rowsOf([toolLog('run_command', { command: 'npm test' }, 500)]);
        expect(ok[0].type).toBe('tool');
        expect(ok[0].text).toContain('✓');
        expect(bad[0].type).toBe('error');
        expect(bad[0].text).toContain('✗');
    });

    it('keeps an open question when only teardown bookkeeping follows it', () => {
        const tl2 = buildTimeline([ask('この計画で進めてよいですか'), teardown('🧠 学習を記録: 7 件')]);
        const card = tl2.items.find(i => i.kind === 'ask');
        expect(card).toBeTruthy();
        expect(card.answered).toBeFalsy();   // still actionable
    });

    it('still marks the question answered once the run ACTUALLY resumes', () => {
        const tl2 = buildTimeline([
            ask('この計画で進めてよいですか'),
            { event: 'status', data: { status: 'running', message: '計画に沿って実装します' } },
        ]);
        expect(tl2.items.find(i => i.kind === 'ask').answered).toBe(true);
    });

    it('recovers every completed run from stored logs', () => {
        const tl2 = buildTimeline([complete('one', 'a', 't1'), complete('two', 'b', 't2')]);
        // request → run, twice: a replay reconstructs the same shape as the live
        // path, where the request is an item of its own.
        expect(kinds(tl2)).toEqual(['request', 'run', 'request', 'run']);
        expect(tl2.items.filter(i => i.kind === 'request').map(i => i.text)).toEqual(['one', 'two']);
    });

    it('dedupes a replayed completion (the continue/replay double-fire)', () => {
        const tl2 = buildTimeline([complete('one', 'a', 't1'), complete('one', 'a', 't1')]);
        expect(kinds(tl2)).toEqual(['request', 'run']);
    });

    it('shows the request when nothing has completed yet, so the view is never blank', () => {
        const tl2 = buildTimeline([], { prompt: 'compare the sheets' });
        expect(kinds(tl2)).toEqual(['request']);
        expect(tl2.items[0].text).toBe('compare the sheets');
    });

    it('does not add the prompt bubble once a run exists (the run brought its own)', () => {
        const tl2 = buildTimeline([complete('one', 'a', 't1')], { prompt: 'one' });
        expect(kinds(tl2)).toEqual(['request', 'run']);
    });

    it('restores a pending question from a waiting status', () => {
        const tl2 = buildTimeline([
            { event: 'status', data: { status: 'waiting', message: '❓ which sheet?', options: ['A'] } },
        ]);
        const ask = tl2.items.find(i => i.kind === 'ask');
        expect(ask.text).toBe('which sheet?');
        expect(ask.options).toEqual(['A']);
    });

    it('tolerates malformed log entries', () => {
        expect(() => buildTimeline([null, 'x', {}, { event: 'complete' }])).not.toThrow();
        expect(buildTimeline(null).items).toEqual([]);
    });
});

describe('remaining edges', () => {
    it('pushRequest ignores a blank prompt', () => {
        expect(tl.pushRequest('   ')).toBe(null);
        expect(tl.pushRequest(null)).toBe(null);
        expect(tl.items).toHaveLength(0);
    });

    it('pushError records a line, and ignores a blank one', () => {
        expect(tl.pushError('')).toBe(null);
        tl.pushError('boom');
        expect(tl.items[0]).toMatchObject({ kind: 'error', text: 'boom' });
    });

    it('pushConfirm ignores a blank body', () => {
        expect(tl.pushConfirm('')).toBe(null);
    });

    it('pushAsk ignores a blank question', () => {
        expect(tl.pushAsk({ text: '  ' })).toBe(null);
        expect(tl.pushAsk({})).toBe(null);
    });

    it('pushNarration ignores whitespace-only prose', () => {
        expect(tl.pushNarration('   ')).toBe(null);
    });

    it('closeNarration makes the next prose a new item', () => {
        tl.pushNarration('first');
        tl.closeNarration();
        tl.pushNarration('second');
        expect(tl.items.filter(i => i.kind === 'narration')).toHaveLength(2);
    });

    it('a question line routed through pushActivity closes the group and adds nothing', () => {
        tl.pushActivity('thought', 'head');
        expect(tl.pushActivity('question', 'q?')).toBe(null);
        tl.pushActivity('tool', 'after');
        expect(tl.items[0].lines).toHaveLength(0);
    });

    it('liveItems exposes only the in-flight trace', () => {
        tl.pushRun({ request: 'r', answer: 'a' });
        tl.pushActivity('thought', 't');
        expect(tl.liveItems.map(i => i.kind)).toEqual(['group']);
    });

    it('reset() empties everything', () => {
        tl.pushActivity('thought', 'x');
        tl.reset();
        expect(tl.items).toEqual([]);
        expect(tl.pushActivity('tool', 'y').kind).toBe('activity');   // no stale group
    });

    it('restore rebuilds the open narration too', () => {
        tl.pushNarration('prose');
        const fresh = new TaskTimeline();
        fresh.restore(tl.snapshot());
        fresh.pushNarration('prose extended');
        expect(fresh.items.filter(i => i.kind === 'narration')).toHaveLength(1);
    });

    it('buildTimeline keeps the prompt bubble ahead of a restored question', () => {
        const tl2 = buildTimeline(
            [{ event: 'status', data: { status: 'waiting', message: 'q?' } }],
            { prompt: 'do the thing' },
        );
        expect(tl2.items.map(i => i.kind)).toEqual(['request', 'ask']);
    });
});

describe('envelopeText', () => {
    it('reads the payload key each present_result kind actually uses', () => {
        expect(envelopeText({ payload: { md: '# md' } })).toBe('# md');
        expect(envelopeText({ payload: { text: 'plain' } })).toBe('plain');
        // Some callers hand through the schema's own arg name.
        expect(envelopeText({ payload: { markdown: '# alt' } })).toBe('# alt');
    });

    it('renders a file list as lines', () => {
        expect(envelopeText({ payload: { files: [{ path: 'a.js' }, 'b.js'] } })).toBe('- a.js\n- b.js');
    });

    it('falls back to the envelope summary', () => {
        expect(envelopeText({ summary: 'short answer' })).toBe('short answer');
    });

    it('returns empty for junk', () => {
        expect(envelopeText(null)).toBe('');
        expect(envelopeText({})).toBe('');
        expect(envelopeText({ payload: { md: '   ' } })).toBe('');
    });
});

describe('replaying a delivered report', () => {
    it('restores it from the stored result event, so a reload matches the live view', () => {
        const tl2 = buildTimeline([
            { event: 'result', data: { envelope: { kind: 'markdown', payload: { md: '# 保存されたレポート' } } } },
            { event: 'complete', timestamp: 't1', data: { resultSummary: { request: 'r', answer: '完了しました' } } },
        ]);
        expect(kinds(tl2)).toEqual(['request', 'run', 'deliverable']);
        expect(tl2.items[2].text).toContain('保存されたレポート');
    });

    it('ignores a result event with no envelope', () => {
        expect(() => buildTimeline([{ event: 'result', data: {} }])).not.toThrow();
    });
});

describe('replaying a task_progress checklist', () => {
    it('restores it from the stored event, matching the live path', () => {
        const tl2 = buildTimeline([
            { event: 'task_progress', data: { items: [
                { id: '1', title: '調査', status: 'completed' },
                { id: '2', title: '実装', status: 'in_progress' },
            ] } },
        ]);
        const card = tl2.items.find(i => i.kind === 'task_progress');
        expect(card).toBeTruthy();
        expect(card.items).toHaveLength(2);
        expect(card.items[1].status).toBe('in_progress');
    });

    it('collapses repeated updates of the SAME plan into one card', () => {
        const tl2 = buildTimeline([
            { event: 'task_progress', data: { items: [{ id: '1', title: 'a', status: 'pending' }] } },
            { event: 'task_progress', data: { items: [{ id: '1', title: 'a', status: 'completed' }] } },
        ]);
        const cards = tl2.items.filter(i => i.kind === 'task_progress');
        expect(cards).toHaveLength(1);
        expect(cards[0].items[0].status).toBe('completed');
    });

    it('keeps a REPLANNED checklist as its own card after a reload', () => {
        const tl2 = buildTimeline([
            { event: 'task_progress', data: { items: [{ id: '1', title: 'a', status: 'completed' }] } },
            { event: 'task_progress', data: { items: [{ id: 'x', title: 'new', status: 'in_progress' }] } },
        ]);
        const cards = tl2.items.filter(i => i.kind === 'task_progress');
        expect(cards).toHaveLength(2);
        expect(cards[1].items.map(t => t.id)).toEqual(['x']);
    });

    it('ignores a task_progress event with no items array', () => {
        expect(() => buildTimeline([{ event: 'task_progress', data: {} }])).not.toThrow();
        expect(buildTimeline([{ event: 'task_progress', data: {} }]).items).toEqual([]);
    });
});

describe('splitForPanes — the deliverable becomes a document, in place', () => {
    it('features a present_result and takes it out of the stream', () => {
        tl.pushActivity('thought', 'working');
        tl.pushDeliverable('markdown', '# レポート本文');
        const { stream, doc } = splitForPanes(tl.items);

        expect(doc.kind).toBe('document');
        expect(doc.text).toBe('# レポート本文');
        // The document sits IN PLACE, where the agent produced it.
        expect(stream.map(i => i.kind)).toEqual(['group', 'document']);
    });

    it('falls back to the newest run answer, keeping its request in the stream', () => {
        tl.pushRun({ request: 'シートを比較して', answer: '# 比較結果', files: [{ path: 'r.md' }], stats: { steps: 3 } });
        const { stream, doc } = splitForPanes(tl.items);

        expect(doc.text).toBe('# 比較結果');
        expect(doc.files).toHaveLength(1);
        expect(doc.stats.steps).toBe(3);
        // The conversation still reads in order — the request is not swallowed.
        expect(stream.map(i => i.kind)).toEqual(['request', 'document']);
        expect(stream[0].text).toBe('シートを比較して');
    });

    it('prefers the present_result over the run answer', () => {
        tl.pushDeliverable('markdown', 'THE REPORT');
        tl.pushRun({ request: 'r', answer: '作成しました' });
        expect(splitForPanes(tl.items).doc.text).toBe('THE REPORT');
    });

    it('features the NEWEST run and leaves older ones in the stream', () => {
        tl.pushRun({ request: 'one', answer: 'first answer' });
        tl.pushRun({ request: 'two', answer: 'second answer' });
        const { stream, doc } = splitForPanes(tl.items);
        expect(doc.text).toBe('second answer');
        // A divider closes the first exchange before the second one's request.
        // The document replaces the run it came from, in place — nothing is
        // derived, so no request appears twice.
        expect(stream.map(i => i.kind)).toEqual(['request', 'run', 'turn', 'request', 'document']);
    });

    it('has no document when nothing has been delivered', () => {
        tl.pushRequest('do it');
        tl.pushActivity('thought', 'thinking');
        expect(splitForPanes(tl.items).doc).toBe(null);
    });

    it('ignores a run whose answer is empty', () => {
        tl.pushRun({ request: 'r', answer: '   ' });
        expect(splitForPanes(tl.items).doc).toBe(null);
    });

    it('derived ids are stable, so the renderer reuses the document node', () => {
        tl.pushDeliverable('markdown', 'x');
        const a = splitForPanes(tl.items).doc;
        const b = splitForPanes(tl.items).doc;
        expect(a.id).toBe(b.id);
        expect(a.rev).toBe(b.rev);
    });

    it('the document rev tracks its source, so an update re-renders', () => {
        tl.pushDeliverable('markdown', 'draft');
        const before = splitForPanes(tl.items).doc.rev;
        tl.pushDeliverable('markdown', 'final');
        const after = splitForPanes(tl.items).doc;
        expect(after.rev).toBeGreaterThan(before);
        expect(after.text).toBe('final');
    });

    it('tolerates junk input', () => {
        expect(splitForPanes(null)).toEqual({ stream: [], doc: null });
    });
});

describe('step folding lives in the model', () => {
    it('opening a new step folds every earlier one — exactly one stays open', () => {
        tl.pushActivity('thought', 'step 1');
        tl.pushActivity('thought', 'step 2');
        tl.pushActivity('thought', 'step 3');
        const groups = tl.items.filter(i => i.kind === 'group');
        expect(groups.map(g => !!g.collapsed)).toEqual([true, true, false]);
    });

    it('bumps rev on the groups it folds, so the renderer repaints them', () => {
        const first = tl.pushActivity('thought', 'step 1');
        const before = first.rev;
        tl.pushActivity('thought', 'step 2');
        expect(first.rev).toBeGreaterThan(before);
        // Folding an already-folded group must not churn it again.
        const after = first.rev;
        tl.pushActivity('thought', 'step 3');
        expect(first.rev).toBe(after);
    });

    it('a tool line does not reopen an earlier step', () => {
        const first = tl.pushActivity('thought', 'step 1');
        tl.pushActivity('thought', 'step 2');
        tl.pushActivity('tool', 'running something');
        expect(first.collapsed).toBe(true);
    });

    it('the fold survives a snapshot/restore round trip', () => {
        tl.pushActivity('thought', 'a');
        tl.pushActivity('thought', 'b');
        const fresh = new TaskTimeline();
        fresh.restore(tl.snapshot());
        expect(fresh.items.filter(i => i.kind === 'group').map(g => !!g.collapsed)).toEqual([true, false]);
    });
});

describe('step lines carry the file their tool touched', () => {
    it('keeps the tool, path and write flag as fields', () => {
        tl.pushActivity('thought', 'editing');
        tl.pushActivity('tool', '✓ write_file: a.js', { tool: 'write_file', path: 'src/a.js', write: true });
        const line = tl.items[0].lines[0];
        expect(line).toMatchObject({ tool: 'write_file', path: 'src/a.js', write: true });
    });

    it('omits the fields when the tool acted on no file', () => {
        tl.pushActivity('thought', 'building');
        tl.pushActivity('tool', '✓ run_command: npm test', { tool: 'run_command', path: '', write: false });
        const line = tl.items[0].lines[0];
        expect(line.tool).toBe('run_command');
        expect(line.path).toBeUndefined();
        expect(line.write).toBeUndefined();
    });

    it('ignores meta with no tool name', () => {
        tl.pushActivity('thought', 'x');
        tl.pushActivity('tool', 'plain line', { path: 'a.js' });
        expect(tl.items[0].lines[0].path).toBeUndefined();
    });

    it('carries the fields on a standalone line too (before any reasoning)', () => {
        tl.pushActivity('tool', '✓ read_file: a.js', { tool: 'read_file', path: 'a.js' });
        expect(tl.items[0]).toMatchObject({ kind: 'activity', tool: 'read_file', path: 'a.js' });
    });
});

describe('chapters', () => {
    it('lists only the request and the deliverable, each with a one-line peek', () => {
        tl.pushRequest('refactor the dashboard');
        tl.pushActivity('thought', 'first');
        tl.pushActivity('thought', 'second');
        tl.pushAsk({ text: 'which one?' });
        tl.pushRun({ request: 'refactor the dashboard', answer: 'done — everything moved' });

        const cs = chapters(tl.items);
        expect(cs.map(c => c.label)).toEqual([
            'Request · refactor the dashboard',
            'Deliverable · done — everything moved',
        ]);
    });

    it('shows steps/questions/approvals are NOT chapters — only request + outcome', () => {
        tl.pushRequest('do the thing');
        tl.pushActivity('thought', 'first');
        tl.pushAsk({ text: 'which one?' });
        tl.pushRun({ request: 'do the thing', answer: 'done' });

        expect(chapters(tl.items).map(c => c.label))
            .toEqual(['Request · do the thing', 'Deliverable · done']);
    });

    it('an unanswered question alone produces no chapters', () => {
        tl.pushAsk({ text: 'q' });
        expect(chapters(tl.items)).toEqual([]);
    });

    it('skips narration and plain activity lines — they are not chapters', () => {
        tl.pushNarration('thinking out loud');
        tl.pushActivity('tool', 'a tool line');
        expect(chapters(tl.items)).toEqual([]);
    });

    it('strips markdown noise from the peek and caps its length', () => {
        tl.pushRequest('# **Big** `header`\n\n- first\n- second');
        const [c] = chapters(tl.items);
        expect(c.label).toBe('Request · Big header first second');
    });

    it('caps a very long peek at ~60 chars with an ellipsis', () => {
        tl.pushRequest('a'.repeat(200));
        const [c] = chapters(tl.items);
        expect(c.label).toMatch(/^Request · a{60}…$/);
    });

    it('points at real item ids so a jump can find the node', () => {
        tl.pushRequest('hello');
        const [c] = chapters(tl.items);
        expect(tl.items.some(i => i.id === c.id)).toBe(true);
    });

    it('tolerates junk', () => {
        expect(chapters(null)).toEqual([]);
    });
});

describe('replayLineType', () => {
    it('recognises the mechanical lines the live formatter produces', () => {
        expect(replayLineType('⚙ Running: read_file: a.js…')).toBe('tool');
        expect(replayLineType('✓ read_file: a.js')).toBe('tool');
        expect(replayLineType('🤖 [sub:reviewer#1] ✓ run_command')).toBe('tool');
    });

    it('recognises failures and pauses', () => {
        expect(replayLineType('⚠ Error — recovering')).toBe('error');
        expect(replayLineType('↻ retrying')).toBe('error');
        expect(replayLineType('Error: something broke')).toBe('error');
        expect(replayLineType('⏸ Awaiting approval…')).toBe('confirm');
    });

    it('treats anything else as the model reasoning', () => {
        expect(replayLineType('I will read the workbook first.')).toBe('thought');
        expect(replayLineType('')).toBe('thought');
    });
});

describe('replaying a run rebuilds its STEPS', () => {
    // The steps used to live only in the live socket's memory, so any rebuild
    // from logs — including the one completion triggers — erased the story.
    const status = (message) => ({ event: 'status', data: { status: 'running', message } });

    it('reconstructs reasoning steps and their tool lines', () => {
        const tl2 = buildTimeline([
            status('I will look at the config'),
            status('⚙ Running: read_file: a.js…'),
            status('✓ read_file: a.js'),
            status('Now I will check the tests'),
            status('✓ run_command: npm test'),
        ]);
        const groups = tl2.items.filter(i => i.kind === 'group');
        expect(groups).toHaveLength(2);
        expect(groups[0].lines).toHaveLength(2);
        expect(groups[1].lines).toHaveLength(1);
    });

    it('keeps the steps after the completion event', () => {
        const tl2 = buildTimeline([
            status('thinking'),
            status('✓ read_file: a.js'),
            { event: 'complete', timestamp: 't1', data: { resultSummary: { request: 'r', answer: 'done' } } },
        ]);
        expect(tl2.items.map(i => i.kind)).toEqual(['request', 'group', 'run']);
        expect(tl2.items[1].collapsed).toBe(true);
    });

    it('ignores status events with no message', () => {
        expect(() => buildTimeline([{ event: 'status', data: { status: 'running' } }])).not.toThrow();
        expect(buildTimeline([{ event: 'status', data: { status: 'running' } }]).items).toEqual([]);
    });
});

describe('replay does not explode the step count', () => {
    const status = (message) => ({ event: 'status', data: { status: 'running', message } });

    it('treats the view\'s own placeholders as tool lines, not new steps', () => {
        // A 2-step run replayed as a dozen numbered cards because every
        // "Thinking… (step N)" looked like fresh reasoning.
        for (const m of ['Thinking... (step 28)', 'Calling LLM…', 'Receiving…',
            'Searching: --bg-card-solid in src/styles…', 'Presenting result (markdown)',
            'Asking the user: proceed?', 'Running: read_file…', 'Awaiting approval…']) {
            expect(replayLineType(m), m).toBe('tool');
        }
    });

    it('still treats a real sentence as reasoning', () => {
        expect(replayLineType('Running the tests is the fastest way to confirm this.')).toBe('thought');
        expect(replayLineType('分析が完了しました。')).toBe('thought');
    });

    it('a run of placeholders produces ONE step, not one each', () => {
        const tl2 = buildTimeline([
            status('I will review the styles'),
            status('Thinking... (step 1)'),
            status('Searching: mtl-panes…'),
            status('Presenting result (markdown)'),
        ]);
        expect(tl2.items.filter(i => i.kind === 'group')).toHaveLength(1);
    });

    it('replays TOOL telemetry with the file it touched', () => {
        const tl2 = buildTimeline([
            status('I will read the config'),
            { event: 'log', data: { method: 'TOOL', name: 'read_file', request: { path: 'src/a.js' } } },
        ]);
        const line = tl2.items.find(i => i.kind === 'group').lines[0];
        expect(line).toMatchObject({ tool: 'read_file', path: 'src/a.js' });
    });

    it('extracts the agent\'s own step number when a line carries one', () => {
        expect(replayStepNo('Thinking... (step 28)')).toBe(28);
        expect(replayStepNo('no number here')).toBe(null);
    });
});

describe('withTurnDividers', () => {
    const req = (id, text) => ({ id, rev: 0, kind: 'request', text });

    it('does NOT divide before the very first request', () => {
        expect(withTurnDividers([req('i1', 'first')]).map(i => i.kind)).toEqual(['request']);
    });

    it('closes the previous exchange before each later request', () => {
        const out = withTurnDividers([
            { id: 'g1', kind: 'group' }, { id: 'r1', kind: 'run' },
            req('i5', 'second'), { id: 'g2', kind: 'group' },
        ]);
        expect(out.map(i => i.kind)).toEqual(['group', 'run', 'turn', 'request', 'group']);
    });

    it('numbers the exchanges', () => {
        const out = withTurnDividers([req('a', '1'), { id: 'r', kind: 'run' }, req('b', '2')]);
        expect(out.find(i => i.kind === 'turn').n).toBe(2);
    });

    it('divides before a FIRST request that follows earlier content', () => {
        // A continued task can show the previous run before its next request.
        const out = withTurnDividers([{ id: 'r0', kind: 'run' }, req('i9', 'next')]);
        expect(out.map(i => i.kind)).toEqual(['run', 'turn', 'request']);
    });

    it('gives each divider a stable id derived from its request', () => {
        const out = withTurnDividers([req('a', '1'), { id: 'r', kind: 'run' }, req('b', '2')]);
        expect(out.find(i => i.kind === 'turn').id).toBe('turn:b');
    });

    it('leaves a stream with no request untouched', () => {
        const items = [{ id: 'g', kind: 'group' }];
        expect(withTurnDividers(items).map(i => i.kind)).toEqual(['group']);
    });

    it('tolerates junk', () => {
        expect(withTurnDividers(null)).toEqual([]);
    });
});

describe('replayed items keep the REAL time, not the redraw time', () => {
    // `at` is EPOCH MILLISECONDS. It used to be a preformatted "HH:MM:SS", which
    // meant the model held a rendering: it could not be compared or sorted, and
    // an item that inherited another's stamp inherited a plausible-looking lie.
    it('stamps each item from its log entry', () => {
        const tl2 = buildTimeline([
            { event: 'status', timestamp: '2026-07-29T12:19:18Z', data: { status: 'running', message: 'I will look' } },
        ]);
        expect(tl2.items[0].at).toBe(Date.parse('2026-07-29T12:19:18Z'));
        expect(clockText(tl2.items[0].at)).toMatch(/^\d{2}:\d{2}:18$/);   // seconds are timezone-proof
    });

    it('a run carries the completion time, not the moment of the rebuild', () => {
        const tl2 = buildTimeline([
            { event: 'complete', timestamp: '2026-07-29T09:05:07Z', data: { resultSummary: { request: 'r', answer: 'a' } } },
        ]);
        expect(tl2.items.find(i => i.kind === 'run').at).toBe(Date.parse('2026-07-29T09:05:07Z'));
    });

    it('the request carries the time it was SENT, not the run completion', () => {
        // Reported: "the request's clock changes, and it moves below the steps".
        // Both came from deriving the request at the run's position.
        const tl2 = buildTimeline([
            { event: 'status', timestamp: '2026-07-29T09:00:00Z', data: { status: 'running', message: 'I will look' } },
            { event: 'complete', timestamp: '2026-07-29T09:05:07Z', data: { resultSummary: { request: 'r', answer: 'a' } } },
        ]);
        const req = tl2.items.find(i => i.kind === 'request');
        expect(req.at).toBe(Date.parse('2026-07-29T09:00:00Z'));
        // …and it leads the exchange rather than trailing it.
        expect(tl2.items.indexOf(req)).toBe(0);
    });

    it('a live request keeps its own stamp when the run completes', () => {
        tl.setClock('2026-07-29T09:00:00Z');
        const req = tl.pushRequest('do it');
        tl.setClock('2026-07-29T09:04:00Z');
        tl.pushActivity('thought', 'working');
        tl.setClock('2026-07-29T09:09:00Z');
        tl.pushRun({ request: 'do it', answer: 'done' });

        expect(tl.items[0]).toBe(req);                       // the SAME item
        expect(req.at).toBe(Date.parse('2026-07-29T09:00:00Z'));
    });

    it('different log times produce different stamps', () => {
        const tl2 = buildTimeline([
            { event: 'status', timestamp: '2026-07-29T01:00:11Z', data: { status: 'running', message: 'first' } },
            { event: 'status', timestamp: '2026-07-29T01:30:22Z', data: { status: 'running', message: 'second' } },
        ]);
        const [a, b] = tl2.items.map(i => i.at);
        expect(a).not.toBe(b);
    });

    it('setClock(null) returns to wall-clock for the live path', () => {
        tl.setClock('2026-07-29T00:00:00Z');
        tl.setClock(null);
        const item = tl.pushRequest('live now');
        expect(Math.abs(item.at - Date.now())).toBeLessThan(5000);
    });

    it('a log entry with no timestamp falls back rather than rendering blank', () => {
        const tl2 = buildTimeline([{ event: 'status', data: { status: 'running', message: 'x' } }]);
        expect(clockText(tl2.items[0].at)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('clockText says nothing for a stamp it cannot read, rather than "NaN:NaN"', () => {
        expect(clockText(undefined)).toBe('');
        expect(clockText('21:22:14')).toBe('');
    });
});

describe('steps are never trimmed', () => {
    it('keeps every step, however many', () => {
        const small = new TaskTimeline({ maxLive: 5 });
        for (let i = 0; i < 200; i++) small.pushActivity('thought', `step ${i}`);
        expect(small.items.filter(i => i.kind === 'group')).toHaveLength(200);
    });

    it('still bounds the transient lines', () => {
        const small = new TaskTimeline({ maxLive: 5 });
        for (let i = 0; i < 50; i++) small.pushActivity('tool', `line ${i}`);
        expect(small.items.filter(i => i.kind === 'activity').length).toBeLessThanOrEqual(5);
    });
});

describe('a single-request task gets NO divider', () => {
    it('does not divide above the only request', () => {
        // A replayed run renders its steps before its derived request, which used
        // to look like "there is content above me, so I must be a later turn".
        const out = withTurnDividers([
            { id: 'g1', kind: 'group' },
            { id: 'r1:req', kind: 'request', text: 'the only ask' },
            { id: 'r1:doc', kind: 'document', text: 'the answer' },
        ]);
        expect(out.map(i => i.kind)).toEqual(['group', 'request', 'document']);
    });

    it('divides once a run has actually completed', () => {
        const out = withTurnDividers([
            { id: 'r1', kind: 'run' },
            { id: 'i9', kind: 'request', text: 'second ask' },
        ]);
        expect(out.map(i => i.kind)).toEqual(['run', 'turn', 'request']);
    });
});

describe('withExchangeFolds — folding is per exchange, not per story', () => {
    // request → working → outcome, twice.
    const stream = () => [
        { id: 'r1', rev: 0, kind: 'request', text: 'first', at: 1000 },
        { id: 'g1', rev: 1, kind: 'group', head: { text: 'a' }, lines: [], at: 2000 },
        { id: 'g2', rev: 1, kind: 'group', head: { text: 'b' }, lines: [], at: 5000 },
        { id: 'd1', rev: 0, kind: 'run', answer: 'done', at: 9000 },
        { id: 'r2', rev: 0, kind: 'request', text: 'second', at: 10000 },
        { id: 'g3', rev: 0, kind: 'group', head: { text: 'c' }, lines: [], at: 11000 },
    ];

    it('folds ONLY the exchange it was asked to fold', () => {
        // Reported: closing one request closed every request, because the state
        // was a single class on the list.
        const out = withExchangeFolds(stream(), new Set([1]));
        expect(out.map(i => i.kind)).toEqual(['request', 'fold', 'run', 'request', 'group']);
    });

    it('the fold summary says how much working it stands for, and how long', () => {
        const fold = withExchangeFolds(stream(), new Set([1])).find(i => i.kind === 'fold');
        expect(fold.steps).toBe(2);
        expect(fold.at).toBe(2000);
        expect(fold.to).toBe(5000);
        expect(fold.ex).toBe(1);
    });

    it('leaves the outcome, the question and the request visible — only working folds', () => {
        const out = withExchangeFolds([
            { id: 'r1', rev: 0, kind: 'request', at: 1 },
            { id: 'g1', rev: 0, kind: 'group', at: 2 },
            { id: 'a1', rev: 0, kind: 'ask', text: 'q', at: 3 },
            { id: 'g2', rev: 0, kind: 'group', at: 4 },
            { id: 'x1', rev: 0, kind: 'deliverable', text: 'r', at: 5 },
        ], new Set([1]));
        expect(out.map(i => i.kind)).toEqual(['request', 'fold', 'ask', 'fold', 'deliverable']);
    });

    it('marks the request so its toggle can show the state', () => {
        const [req] = withExchangeFolds(stream(), new Set([1]));
        expect(req._ex).toBe(1);
        expect(req._folded).toBe(true);
        expect(withExchangeFolds(stream(), new Set())[0]._folded).toBe(false);
    });

    it('changes nothing when nothing is folded', () => {
        expect(withExchangeFolds(stream(), new Set()).map(i => i.kind))
            .toEqual(['request', 'group', 'group', 'run', 'request', 'group']);
    });

    it('gives the summary a rev that follows its members, so a live count refreshes', () => {
        const a = withExchangeFolds(stream(), new Set([1])).find(i => i.kind === 'fold');
        const busier = stream();
        busier[1].rev = 7;
        const b = withExchangeFolds(busier, new Set([1])).find(i => i.kind === 'fold');
        expect(b.rev).not.toBe(a.rev);
        expect(b.id).toBe(a.id);           // …but the same node is reused
    });

    it('folds working that arrived before any request (ex 0)', () => {
        const out = withExchangeFolds([{ id: 'g', rev: 0, kind: 'group', at: 1 }], new Set([0]));
        expect(out.map(i => i.kind)).toEqual(['fold']);
    });

    it('tolerates junk', () => {
        expect(withExchangeFolds(null)).toEqual([]);
        expect(withExchangeFolds(stream(), null).map(i => i.kind)).toHaveLength(6);
    });
});

describe('exchangeCount', () => {
    it('counts the requests — an exchange opens with one', () => {
        expect(exchangeCount([{ kind: 'request' }, { kind: 'group' }, { kind: 'request' }])).toBe(2);
        expect(exchangeCount([])).toBe(0);
        expect(exchangeCount(null)).toBe(0);
    });
});

describe('a folded exchange folds its RESULT too', () => {
    const stream = () => [
        { id: 'r1', rev: 0, kind: 'request', text: 'first', at: 1000 },
        { id: 'g1', rev: 0, kind: 'group', at: 2000 },
        { id: 'o1', rev: 0, kind: 'run', answer: '# a long report', at: 9000 },
        { id: 'r2', rev: 0, kind: 'request', text: 'second', at: 10000 },
        { id: 'o2', rev: 0, kind: 'document', text: '# another', at: 11000 },
    ];

    it('marks the outcome bodyless rather than dropping it', () => {
        const out = withExchangeFolds(stream(), new Set([1]));
        expect(out.map(i => i.kind)).toEqual(['request', 'fold', 'run', 'request', 'document']);
        const run = out.find(i => i.kind === 'run');
        // `_bodyless` is the whole signal: the renderer draws the header alone and
        // treats it as folded. The fold LOOKUP travels separately (collapsedIds) so
        // items stay reference-stable.
        expect(run._bodyless).toBe(true);
        expect(run.answer).toBe('# a long report');   // the content is still there
    });

    it('carries the exchange, so the folded result can open it', () => {
        expect(withExchangeFolds(stream(), new Set([1])).find(i => i.kind === 'run')._ex).toBe(1);
        expect(withExchangeFolds(stream(), new Set([2])).find(i => i.kind === 'document')._ex).toBe(2);
    });

    it('leaves an OPEN result rendered, but still stamped with its exchange', () => {
        // The header of an open result closes it, and that fold has to go through
        // the exchange state — so it needs to know which exchange it is in.
        const open = withExchangeFolds(stream(), new Set([1])).find(i => i.id === 'o2');
        expect(open._bodyless).toBeUndefined();
        expect(open._ex).toBe(2);
        expect(open.rev).toBe(0);          // unchanged, so the node is not redrawn
    });

    it('folds the WORKING and the RESULT independently', () => {
        // Reading an answer while skimming its steps is the normal case.
        const stepsOnly = withExchangeFolds(stream(), { working: new Set([1]), outcome: new Set() });
        expect(stepsOnly.find(i => i.kind === 'fold')).toBeTruthy();
        expect(stepsOnly.find(i => i.id === 'o1')._bodyless).toBeUndefined();

        const resultOnly = withExchangeFolds(stream(), { working: new Set(), outcome: new Set([1]) });
        expect(resultOnly.find(i => i.kind === 'fold')).toBeUndefined();
        expect(resultOnly.find(i => i.id === 'o1')._bodyless).toBe(true);
    });

    it('a bare Set still folds both — the shorthand for "collapse everything"', () => {
        const out = withExchangeFolds(stream(), new Set([1]));
        expect(out.find(i => i.kind === 'fold')).toBeTruthy();
        expect(out.find(i => i.id === 'o1')._bodyless).toBe(true);
    });

    it('bumps rev on the copy so the renderer redraws when folding changes', () => {
        const open = withExchangeFolds(stream(), new Set()).find(i => i.id === 'o1');
        const shut = withExchangeFolds(stream(), new Set([1])).find(i => i.id === 'o1');
        expect(shut.rev).not.toBe(open.rev);
    });
});


describe('collapsedIds — the fold lookup', () => {
    it('collects the ids the model has folded', () => {
        const tl = new TaskTimeline();
        tl.pushActivity('thought', 'one');
        tl.pushActivity('thought', 'two');     // folds 'one'
        tl.pushActivity('thought', 'three');   // folds 'two'
        const ids = collapsedIds(tl.items);
        const groups = tl.items.filter(i => i.kind === 'group');
        expect(ids.has(groups[0].id)).toBe(true);
        expect(ids.has(groups[1].id)).toBe(true);
        // Exactly the newest stays open.
        expect(ids.has(groups[2].id)).toBe(false);
    });

    it('folds every step once the run completes', () => {
        const tl = new TaskTimeline();
        tl.pushRequest('do it');
        tl.pushActivity('thought', 'one');
        tl.pushRun({ request: 'do it', answer: 'done' });
        const groups = tl.items.filter(i => i.kind === 'group');
        expect(collapsedIds(tl.items).has(groups[0].id)).toBe(true);
    });

    it('reflects setCollapsed both ways', () => {
        const tl = new TaskTimeline();
        const g = tl.pushActivity('thought', 'only');
        expect(collapsedIds(tl.items).has(g.id)).toBe(false);
        expect(tl.setCollapsed(g.id, true)).toBe(true);
        expect(collapsedIds(tl.items).has(g.id)).toBe(true);
        expect(tl.setCollapsed(g.id, false)).toBe(true);
        expect(collapsedIds(tl.items).has(g.id)).toBe(false);
    });

    it('setCollapsed reports NO change when the flag already matches', () => {
        // The caller re-renders on true; a pointless render per click is waste.
        const tl = new TaskTimeline();
        const g = tl.pushActivity('thought', 'only');
        expect(tl.setCollapsed(g.id, false)).toBe(false);
        expect(tl.setCollapsed('nope', true)).toBe(false);
    });

    it('is empty for nothing', () => {
        expect(collapsedIds([]).size).toBe(0);
        expect(collapsedIds(null).size).toBe(0);
    });
});


describe('buildTimeline — a reopened task must not re-ask a dead question', () => {
    // ask_user emits `status: waiting` and then BREAKS the agent loop, so a
    // `complete` always follows. Replay used to rebuild the question as
    // unanswered every time, so any task that had ever asked anything reopened
    // with a highlighted, clickable "answer me" card for a run that was over.
    const ask = (text = 'どちらにしますか') => ({
        event: 'status', data: { status: 'waiting', message: text, options: ['A', 'B'] },
    });
    const running = (message = 'Thinking... (step 1)') => ({
        event: 'status', data: { status: 'running', message },
    });
    const complete = (request = 'req') => ({
        event: 'complete', data: { resultSummary: { request, summary: 'done' } },
    });

    const asks = (tl) => tl.items.filter(i => i.kind === 'ask');

    it('KEEPS the question open when the run only finished its own teardown', () => {
        // Reported: every question showed as "未回答のまま終了しました" with a bare
        // "回答する" button instead of its choices. `complete` was being read as
        // "this question is dead", but ask_user BREAKS the loop — so the run that
        // asked always completes while the task sits parked on the question.
        const tl = buildTimeline([running(), ask(), complete()], {});
        expect(asks(tl)).toHaveLength(1);
        expect(asks(tl)[0].answered).toBeFalsy();
        expect(asks(tl)[0].options).toEqual(['A', 'B']);   // choices still offered
    });

    it('keeps it open across the memory bookkeeping that trails a pause', () => {
        const teardown = { event: 'status', data: { status: 'running', phase: 'teardown', message: '🧠 学習を記録: 3 件' } };
        const tl = buildTimeline([running(), ask(), teardown, complete()], {});
        expect(asks(tl)[0].answered).toBeFalsy();
    });

    it('closes it as unanswered once the task demonstrably moved on', () => {
        // A second completion means another run came and went without the question
        // ever being answered. "↩ (answered)" would be a lie about the user's own
        // history, so it closes as unanswered instead.
        const tl = buildTimeline([running(), ask(), complete(), complete('another request')], {});
        expect(asks(tl)[0].unanswered).toBe(true);
        expect(asks(tl)[0].answer).toBe('');
    });

    it('closes it when the run died outright after asking', () => {
        const tl = buildTimeline([running(), ask(), { event: 'error', data: { terminal: true } }], {});
        expect(asks(tl)[0].unanswered).toBe(true);
    });

    it('drops the card entirely once the user answered and the run resumed', () => {
        // A resumed run means the user replied, and the reply becomes the NEXT run's
        // request — so keeping the question card too would show one exchange twice.
        const tl = buildTimeline([running(), ask(), complete(), running(), complete('A')], {});
        expect(asks(tl)).toHaveLength(0);
        expect(tl.items.some(i => i.kind === 'run')).toBe(true);
    });

    it('never labels an answered question as unanswered', () => {
        // The close-on-completion rule must not fire for a question the user did
        // answer — the run resumed after it, which is the whole distinction.
        const tl = new TaskTimeline();
        tl.pushAsk({ text: 'q' });
        tl.resolveAsk('B');
        const item = tl.items.find(i => i.kind === 'ask');
        expect(item.unanswered).toBeFalsy();
        expect(item.answer).toBe('B');
    });

    it('KEEPS a question open when it is the last thing in the log', () => {
        // Here the run really is paused: no completion followed, so the prompt is
        // still live and must stay actionable.
        const tl = buildTimeline([running(), ask()], {});
        expect(asks(tl)[0].answered).toBe(false);
    });

    it('closes it on a terminal error too', () => {
        const tl = buildTimeline([running(), ask(), { event: 'error', data: { terminal: true } }], {});
        expect(asks(tl)[0].answered).toBe(true);
    });

    it('is stable when the same logs are replayed twice', () => {
        // Reopening the task repeatedly must not accumulate question cards — the
        // reported symptom was that it showed up "every time".
        const logs = [running(), ask(), complete()];
        for (const tl of [buildTimeline(logs, {}), buildTimeline(logs, {})]) {
            expect(asks(tl)).toHaveLength(1);
            // Still open — the run is parked on it (see the teardown rule above).
            // What must not drift is the COUNT, and its state between rebuilds.
            expect(asks(tl)[0].answered).toBeFalsy();
        }
    });
});

describe('buildTimeline — confirm_request', () => {
    const confirmReq = (ts = '2026-07-01T00:00:00Z') => ({
        event: 'confirm_request', timestamp: ts,
        data: { confirmId: 'conf_1', type: 'command_confirm', command: 'rm -rf x', message: 'x', risk: 'dangerous', allowAlways: false },
    });
    const running = (ts = '2026-07-01T00:00:01Z') => ({
        event: 'status', timestamp: ts,
        data: { status: 'running', message: '⚙ Running: read_file…' },
    });
    const complete = (ts = '2026-07-01T00:00:02Z') => ({
        event: 'complete', timestamp: ts,
        data: { resultSummary: { request: 'r', summary: 's' } },
    });

    it('replays a pending command approval into the story', () => {
        // A task reloaded WHILE parked on an approval must re-show the card.
        const tl = buildTimeline([running(), confirmReq()], {});
        expect(kinds(tl)).toContain('confirm');
    });

    it('keeps the approval card when the run is still running', () => {
        const tl = buildTimeline([confirmReq(), running('2026-07-01T00:00:03Z')], {});
        const conf = tl.items.find(i => i.kind === 'confirm');
        expect(conf).toBeTruthy();
        expect(conf.resolved).toBe(false);
    });

    it('drops the card once the run completed (approval is history)', () => {
        const tl = buildTimeline([confirmReq(), running(), complete()], {});
        expect(kinds(tl)).not.toContain('confirm');
    });
});

describe('closeAsk', () => {
    it('closes without claiming an answer', () => {
        const tl = new TaskTimeline();
        tl.pushAsk({ text: 'q' });
        const closed = tl.closeAsk();
        expect(closed.answered).toBe(true);
        expect(closed.unanswered).toBe(true);
    });

    it('is a no-op when nothing is open', () => {
        const tl = new TaskTimeline();
        expect(tl.closeAsk()).toBe(null);
        tl.pushAsk({ text: 'q' });
        tl.resolveAsk('yes');
        // Already answered — closing must not overwrite a real answer.
        expect(tl.closeAsk()).toBe(null);
        expect(tl.items.find(i => i.kind === 'ask').answer).toBe('yes');
    });
});
