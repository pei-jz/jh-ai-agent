// PartialReport — the report a run leaves behind when a limit cuts it off.
//
// The case these tests are written from: four read-only researcher sub-agents
// ran for seventeen minutes on this workspace, each hit the 20-step cap, and
// each returned its parent the stop notice and nothing else. Everything they
// had found was in the trail; nothing read it.

import { describe, it, expect } from 'vitest';
import {
    noteThought, noteTools, composePartialReport, hasSubstance, TRAIL_MAX_STEPS,
} from '../PartialReport.js';

const trailOf = (steps) => {
    const trail = [];
    for (const s of steps) {
        if (s.thought) noteThought(trail, { step: s.step, text: s.thought });
        if (s.tools) noteTools(trail, { step: s.step, tools: s.tools });
    }
    return trail;
};

describe('recording', () => {
    it('keeps one entry per step, with the thought and the calls it led to', () => {
        const trail = trailOf([
            { step: 1, thought: 'まず構成を見る', tools: [{ name: 'list_files', hint: 'src' }] },
            { step: 2, tools: [{ name: 'read_file', hint: 'src/a.js' }] },
        ]);
        expect(trail).toHaveLength(2);
        expect(trail[0]).toMatchObject({ step: 1, thought: 'まず構成を見る' });
        expect(trail[0].tools.map(t => t.name)).toEqual(['list_files']);
        expect(trail[1].tools[0].hint).toBe('src/a.js');
    });

    it('ignores empty thoughts and toolless steps rather than storing blanks', () => {
        const trail = [];
        noteThought(trail, { step: 1, text: '   ' });
        noteTools(trail, { step: 1, tools: [] });
        expect(trail).toHaveLength(0);
        expect(hasSubstance(trail)).toBe(false);
    });

    it('is bounded — a long run cannot grow the trail without limit', () => {
        const trail = [];
        for (let i = 1; i <= TRAIL_MAX_STEPS + 40; i++) {
            noteThought(trail, { step: i, text: `step ${i}` });
        }
        expect(trail).toHaveLength(TRAIL_MAX_STEPS);
        // The OLDEST are dropped: what the run was doing when it died is what
        // the reader needs, not how it opened.
        expect(trail[trail.length - 1].step).toBe(TRAIL_MAX_STEPS + 40);
    });

    it('clips a runaway thought instead of carrying a whole file into the report', () => {
        const trail = trailOf([{ step: 1, thought: 'x'.repeat(5000) }]);
        expect(trail[0].thought.length).toBeLessThanOrEqual(400);
        expect(trail[0].thought.endsWith('…')).toBe(true);
    });
});

describe('composePartialReport', () => {
    it('returns nothing when there is nothing to report', () => {
        expect(composePartialReport([])).toBe('');
        expect(composePartialReport(null)).toBe('');
    });

    it("carries the model's own notes and the calls it made", () => {
        const report = composePartialReport(trailOf([
            { step: 6, thought: '114ファイルある。規模の大きい順に読む', tools: [{ name: 'glob', hint: 'src/**/*.js' }] },
            { step: 7, thought: 'Editor.js が中心。CodeMirror の設定を確認', tools: [{ name: 'read_file', hint: 'src/Editor.js' }] },
        ]));
        expect(report).toContain('114ファイルある');
        expect(report).toContain('Editor.js が中心');
        expect(report).toContain('read_file(src/Editor.js)');
        expect(report).toContain('step 7');
    });

    it('says plainly that it was assembled, not written', () => {
        const report = composePartialReport(trailOf([{ step: 1, thought: 'a finding' }]));
        // The one thing worse than no report is a synthesized one that reads
        // like findings, so the label is not optional.
        expect(report).toMatch(/途中経過|Partial progress/);
        expect(report).toMatch(/機械的|mechanically/);
    });

    it('surfaces the errors a failing run died on', () => {
        const report = composePartialReport(trailOf([
            { step: 3, tools: [{ name: 'list_files', hint: 'C:/nope', ok: false, error: '指定されたパスが見つかりません。 (os error 3)' }] },
        ]));
        expect(report).toContain('os error 3');
        expect(report).toContain('list_files(C:/nope) ✗');
    });

    it('addresses the parent when the stopped run was a sub-agent', () => {
        const trail = trailOf([{ step: 1, thought: 'found something' }]);
        expect(composePartialReport(trail, { subagent: true })).toContain('finish_task');
    });

    it('stays bounded — a parent reads this inside its own context window', () => {
        const trail = trailOf(Array.from({ length: 80 }, (_, i) => ({
            step: i + 1,
            thought: 'x'.repeat(400),
            tools: [{ name: 'read_file', hint: 'y'.repeat(80) }],
        })));
        expect(composePartialReport(trail, { maxChars: 1200 }).length).toBeLessThanOrEqual(1200);
    });
});
