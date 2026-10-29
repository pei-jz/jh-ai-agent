import { describe, it, expect } from 'vitest';
import { withInterimReports, withStoryFolds, outcomeLine, digestOf, isOpenAsk, withPlanOnTop, resultStats, splitLead } from '../storyExchanges.js';

describe('splitLead — the conclusion, and the report without it', () => {
    it('takes the line out of the body and keeps the rest of its section', () => {
        const { lead, rest } = splitLead('## 依頼\n- deck\n\n## 結果\n- **19枚**に更新\n- 警告0件');
        expect(lead).toBe('19枚に更新');
        expect(rest).toBe('## 依頼\n- deck\n\n## 結果\n- 警告0件');
    });
    it('drops a result heading left with nothing under it', () => {
        expect(splitLead('## 結果\n更新しました\n\n## 詳細\n- a').rest).toBe('## 詳細\n- a');
        expect(splitLead('## 結果\n更新しました').rest).toBe('');
    });
    it('falls back to the first body line', () => {
        expect(splitLead('Done.\nMore here')).toEqual({ lead: 'Done.', rest: 'More here' });
    });
});

const req = (id, text = 'make a deck') => ({ id, kind: 'request', text, at: 1000 });
const phase = (id, role, at = 2000, to = 30000) => ({ id, kind: 'phase', role, at, to });
const ask = (id, extra = {}) => ({ id, kind: 'ask', text: 'Update the existing deck or make a new one?', options: ['new', 'update'], ...extra });
const doc = (id, text, extra = {}) => ({ id, kind: 'document', fromRun: true, text, stats: { steps: 2 }, files: [], ...extra });
const kinds = (xs) => xs.map(i => i.kind);

describe('withInterimReports — a run that stopped on a question has no result yet', () => {
    it('folds the closing report into the open question and puts the question last', () => {
        const out = withInterimReports([req('r1'), phase('p1', 'investigate'), doc('d1', '## 結果\n- waiting'), ask('a1')]);
        expect(kinds(out)).toEqual(['request', 'phase', 'ask']);
        expect(out[2]._interim.text).toMatch(/waiting/);
        expect(out[2]._interim.stats).toEqual({ steps: 2 });
    });

    it('moves the question below the report even when the report came after it', () => {
        const out = withInterimReports([req('r1'), ask('a1'), doc('d1', 'report')]);
        expect(kinds(out)).toEqual(['request', 'ask']);
    });

    it('leaves an exchange alone once its question was answered', () => {
        const xs = [req('r1'), ask('a1', { answered: true, answer: 'update' }), doc('d1', 'done')];
        expect(kinds(withInterimReports(xs))).toEqual(['request', 'ask', 'document']);
    });

    it('treats a question closed by the run ending as still open', () => {
        const out = withInterimReports([req('r1'), doc('d1', 'x'), ask('a1', { answered: true, unanswered: true })]);
        expect(kinds(out)).toEqual(['request', 'ask']);
    });

    it('keeps a present_result deliverable: a proposal to approve IS the thing to judge', () => {
        const deliv = { id: 'v1', kind: 'deliverable', text: 'plan' };
        expect(kinds(withInterimReports([req('r1'), deliv, ask('a1')]))).toEqual(['request', 'deliverable', 'ask']);
    });

    it('only touches the exchange with the open question', () => {
        const xs = [req('r1'), doc('d0', 'first done'), req('r2'), doc('d1', 'x'), ask('a1')];
        expect(kinds(withInterimReports(xs))).toEqual(['request', 'document', 'request', 'ask']);
    });
});

describe('outcomeLine — the sentence an outcome comes down to', () => {
    it('prefers the first line under a result heading over the restated request', () => {
        const md = '## 依頼内容\n- Gitの説明資料を作成\n\n## 結果\n- 新規デッキの作成はなし。\n- 回答待ち';
        expect(outcomeLine(md)).toBe('新規デッキの作成はなし。');
    });
    it('falls back to the first non-heading line, stripped of markdown', () => {
        expect(outcomeLine('# Title\nUpdated **17 → 19** slides in `deck.html`')).toBe('Updated 17 → 19 slides in deck.html');
    });
    it('clips long lines', () => {
        expect(outcomeLine('a'.repeat(200), 10)).toBe('aaaaaaaaaa…');
    });
});

describe('withStoryFolds — a folded exchange is one line', () => {
    const stream = [
        req('r1', 'Make a Git deck'), phase('p1', 'investigate'), ask('a1', { answered: true, unanswered: true }),
        { id: 't2', kind: 'turn' },
        req('r2', 'Update the existing one'), phase('p2', 'investigate'), phase('p3', 'change'), phase('p4', 'verify'),
        doc('d2', '## Summary\nDeck updated to 19 slides'),
    ];

    it('replaces a folded exchange with its digest and drops the divider next to it', () => {
        const out = withStoryFolds(stream, { working: new Set([1]), outcome: new Set([1]) });
        expect(kinds(out)).toEqual(['digest', 'request', 'phase', 'phase', 'phase', 'document']);
        const d = out[0];
        expect(d.ex).toBe(1);
        expect(d.status).toBe('waiting');
        expect(d.path).toEqual(['investigate', 'decide']);
        expect(d.outcome).toMatch(/existing deck/);
    });

    it('a finished exchange digests to its path and result sentence', () => {
        const out = withStoryFolds(stream, { working: new Set([2]), outcome: new Set() });
        const d = out[out.length - 1];
        expect(d.kind).toBe('digest');
        expect(d.status).toBe('done');
        expect(d.path).toEqual(['investigate', 'change', 'verify']);
        expect(d.outcome).toBe('Deck updated to 19 slides');
    });

    it('an open exchange keeps its parts; only the result half folds', () => {
        const out = withStoryFolds(stream, { working: new Set(), outcome: new Set([2]) });
        const last = out[out.length - 1];
        expect(last._bodyless).toBe(true);
        expect(last._ex).toBe(2);
        expect(out.find(i => i.id === 'r2')._ex).toBe(2);
    });

    it('a live exchange reads as running', () => {
        const d = digestOf(3, [req('r3'), { ...phase('p9', 'change'), live: true }]);
        expect(d.status).toBe('running');
    });

    it('isOpenAsk', () => {
        expect(isOpenAsk(ask('a'))).toBe(true);
        expect(isOpenAsk(ask('a', { answered: true }))).toBe(false);
    });
});

describe('withPlanOnTop — one plan, under its request', () => {
    const tp = (id, done) => ({ id, kind: 'task_progress', items: [{ id: '1', status: done ? 'completed' : 'pending' }] });

    it('keeps only the latest plan and puts it right after the request', () => {
        const out = withPlanOnTop([req('r1'), phase('p1', 'investigate'), tp('t1', false), phase('p2', 'investigate'), tp('t2', true)]);
        expect(out.map(i => i.id)).toEqual(['r1', 't2', 'p1', 'p2']);
    });

    it('leaves another exchange’s plan where it belongs', () => {
        const out = withPlanOnTop([req('r1'), tp('t1'), phase('p1', 'change'), req('r2'), phase('p2', 'investigate'), tp('t2')]);
        expect(out.map(i => i.id)).toEqual(['r1', 't1', 'p1', 'r2', 't2', 'p2']);
    });
});

describe('the open result is marked as the Story’s', () => {
    it('stamps an unfolded outcome so it renders in the chapters’ shape', () => {
        const out = withStoryFolds([req('r1'), phase('p1', 'change'), doc('d1', 'done')], {});
        expect(out[2]._story).toBe(true);
        expect(out[2]._bodyless).toBeUndefined();
    });
    it('a folded outcome is not', () => {
        const out = withStoryFolds([req('r1'), doc('d1', 'done')], { outcome: new Set([1]) });
        expect(out[1]._story).toBeUndefined();
    });
    it('resultStats reads the numbers as one line of words', () => {
        const t = (k, p) => `${k}:${p.n}`;
        expect(resultStats({ steps: 12, tools: { a: 2, b: 3 }, tokens: 4200, durationMs: 125000 }, t))
            .toEqual(['story.stat.steps:12', 'story.stat.tools:5', '4.2k tok', '2m 5s']);
        expect(resultStats(undefined, t)).toEqual([]);
    });
});
