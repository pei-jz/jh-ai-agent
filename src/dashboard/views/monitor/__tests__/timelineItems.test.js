// The VOCABULARY of a timeline item: what kind of moment it is, what it should be
// labelled, what a step did, and how a line breaks into prose plus a file.
//
// The rendering these used to assert on moved to
// dashboard/svelte/monitor/__tests__/TimelineItem.test.js. Splitting them apart is
// the point: the classification rules below are the part with real decisions in
// them, and they need no DOM.

import { describe, it, expect } from 'vitest';
import {
    esc, spanOf, spanLabel, lineIconName, deliverableLabel, statChips,
    toolChipList, stepLineParts, chapterKind, chapterTag, itemClass, wordCount,
} from '../timelineItems.js';

describe('esc', () => {
    it('neutralises the five characters that break HTML', () => {
        expect(esc('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    });

    it('treats null and undefined as empty', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
    });
});

describe('spanOf / spanLabel', () => {
    it('measures a span in whole seconds', () => {
        expect(spanOf(1000, 21000)).toBe(20);
    });

    it('refuses a span it cannot measure', () => {
        expect(spanOf(undefined, 5000)).toBe(null);
        expect(spanOf(5000, undefined)).toBe(null);
        // A backwards or zero-length span is not a duration.
        expect(spanOf(5000, 5000)).toBe(null);
        expect(spanOf(9000, 5000)).toBe(null);
    });

    it('labels a duration without making the reader do arithmetic', () => {
        expect(spanLabel(18)).toBe('18s');
        expect(spanLabel(200)).toBe('3m 20s');
        expect(spanLabel(60)).toBe('1m 0s');
    });

    it('says nothing about a non-duration', () => {
        expect(spanLabel(0)).toBe('');
        expect(spanLabel(null)).toBe('');
    });
});

describe('lineIconName', () => {
    it('maps a line type to an icon in the shared set', () => {
        expect(lineIconName('tool')).toBe('tool');
        expect(lineIconName('error')).toBe('alert');
        expect(lineIconName('confirm')).toBe('pause');
        expect(lineIconName('thought')).toBe('thought');
    });

    it('falls back rather than rendering nothing for an unknown type', () => {
        expect(lineIconName('something-new')).toBe('tool');
        expect(lineIconName(undefined)).toBe('tool');
    });
});

describe('deliverableLabel', () => {
    it('titles each envelope kind for what it IS', () => {
        expect(deliverableLabel('markdown')).toEqual({ icon: 'report', label: 'Proposal' });
        expect(deliverableLabel('table')).toEqual({ icon: 'table', label: 'Result' });
        expect(deliverableLabel('file-list')).toEqual({ icon: 'folder', label: 'Files' });
        expect(deliverableLabel('code-edit')).toEqual({ icon: 'edit', label: 'Changes' });
    });

    it('uses the fallback the caller supplies for an unknown kind', () => {
        expect(deliverableLabel('brand-new', 'Deliverable').label).toBe('Deliverable');
        expect(deliverableLabel(undefined).label).toBe('Result');
    });
});

describe('statChips', () => {
    it('reports each statistic it has', () => {
        const chips = statChips({ steps: 6, tools: { read_file: 3, glob: 1 }, tokens: 12400, durationMs: 18400 });
        expect(chips.map(c => c.text)).toEqual(['6 steps', '4', '12.4k tok', '18s']);
    });

    it('omits what it does not have rather than showing zeros', () => {
        expect(statChips({ steps: 2 }).map(c => c.text)).toEqual(['2 steps']);
        expect(statChips({})).toEqual([]);
        expect(statChips()).toEqual([]);
    });

    it('keeps small token counts exact', () => {
        expect(statChips({ tokens: 940 })[0].text).toBe('940 tok');
    });
});

describe('toolChipList — what a folded step DID', () => {
    const lines = (...tools) => tools.map(t => ({ tool: t, text: t }));

    it('names the distinct tools, in first-use order', () => {
        const { chips } = toolChipList(lines('read_file', 'grep_search', 'read_file'));
        expect(chips.map(c => c.tool)).toEqual(['read_file', 'grep_search']);
    });

    it('marks a WRITE differently from a read — that is the whole point', () => {
        const { chips } = toolChipList(lines('read_file', 'write_file'));
        expect(chips.find(c => c.tool === 'read_file').write).toBe(false);
        expect(chips.find(c => c.tool === 'write_file').write).toBe(true);
    });

    it('picks a meaningful icon per tool', () => {
        const { chips } = toolChipList(lines('grep_search', 'run_command', 'delete_file'));
        expect(chips.map(c => c.icon)).toEqual(['search', 'code', 'trash']);
    });

    it('shows three and counts the rest', () => {
        const { chips, more } = toolChipList(lines('a', 'b', 'c', 'd', 'e'));
        expect(chips).toHaveLength(3);
        expect(more).toBe(2);
    });

    it('says nothing for lines that ran no tools', () => {
        expect(toolChipList([{ text: 'thinking' }]).chips).toEqual([]);
        expect(toolChipList([]).chips).toEqual([]);
        expect(toolChipList(undefined).chips).toEqual([]);
    });
});

describe('stepLineParts', () => {
    it('offers the file as its own part, with the basename to show', () => {
        const p = stepLineParts({ type: 'tool', text: 'Read: MonitorView.js', path: 'C:/p/src/MonitorView.js', write: false });
        expect(p.path).toBe('C:/p/src/MonitorView.js');
        expect(p.base).toBe('MonitorView.js');
    });

    it('strips a trailing ": basename" so the name is not said twice', () => {
        const p = stepLineParts({ text: 'Read: a.js', path: 'src/a.js' });
        expect(p.prose).toBe('Read');
    });

    it('leaves prose alone when it does not end with the basename', () => {
        const p = stepLineParts({ text: 'Wrote 3 hunks into a.js successfully', path: 'src/a.js' });
        expect(p.prose).toBe('Wrote 3 hunks into a.js successfully');
    });

    it('flags a write so the row can be marked', () => {
        expect(stepLineParts({ text: 'x', path: 'a.js', write: true }).write).toBe(true);
        expect(stepLineParts({ text: 'x', path: 'a.js' }).write).toBe(false);
    });

    it('clamps a long line ONLY when there is no file to offer', () => {
        const long = 'x'.repeat(200);
        expect(stepLineParts({ text: long }).clampable).toBe(true);
        // With a file, the row already has a second element; clamping it too made
        // the link jump around as it opened.
        expect(stepLineParts({ text: long, path: 'a.js' }).clampable).toBe(false);
        expect(stepLineParts({ text: 'short' }).clampable).toBe(false);
    });

    it('ignores a whitespace-only path — it is not a file', () => {
        const p = stepLineParts({ text: 'x', path: '   ' });
        expect(p.path).toBe('');
        expect(p.base).toBe('');
    });

    it('marks an error line', () => {
        expect(stepLineParts({ type: 'error', text: 'boom' }).isError).toBe(true);
        expect(stepLineParts({ type: 'tool', text: 'ok' }).isError).toBe(false);
    });

    it('survives an empty line object', () => {
        const p = stepLineParts();
        expect(p.text).toBe('');
        expect(p.icon).toBe('tool');
    });
});

describe('chapterKind — the vocabulary the rail speaks', () => {
    it('names each kind of moment', () => {
        expect(chapterKind({ kind: 'request' })).toBe('request');
        expect(chapterKind({ kind: 'turn' })).toBe('turn');
        expect(chapterKind({ kind: 'group' })).toBe('step');
        expect(chapterKind({ kind: 'narration' })).toBe('note');
        expect(chapterKind({ kind: 'confirm' })).toBe('approval');
        expect(chapterKind({ kind: 'run' })).toBe('final');
        expect(chapterKind({ kind: 'error' })).toBe('error');
        expect(chapterKind({ kind: 'deliverable' })).toBe('deliverable');
        expect(chapterKind({ kind: 'document' })).toBe('deliverable');
    });

    it('distinguishes an OPEN question from an answered one', () => {
        expect(chapterKind({ kind: 'ask' })).toBe('question');
        expect(chapterKind({ kind: 'ask', answered: true })).toBe('answered');
    });

    it('treats a fragment as bare, not as a chapter', () => {
        // A line that arrived before the run's first reasoning. Framing it as a
        // numbered step produced empty "STEP" boxes with nothing in them.
        expect(chapterKind({ kind: 'activity' })).toBe('bare');
        expect(chapterKind({ kind: 'fold' })).toBe('bare');
    });

    it('falls back to step for anything unrecognised', () => {
        expect(chapterKind({ kind: 'who-knows' })).toBe('step');
        expect(chapterKind()).toBe('step');
    });
});

describe('chapterTag — which chapters get a heading row', () => {
    it('labels the chapters that carry one', () => {
        expect(chapterTag({ kind: 'request' })).toBe('Request');
        expect(chapterTag({ kind: 'ask' })).toBe('Question');
        expect(chapterTag({ kind: 'ask', answered: true })).toBe('Answered');
        expect(chapterTag({ kind: 'run' })).toBe('Agent · Final');
        expect(chapterTag({ kind: 'confirm' })).toBe('Approval');
    });

    it('gives a STEP no heading — its number and time are inside the card', () => {
        // A separate "21:23:05 STEP 08" strip above every step doubled the
        // vertical cost of the most repeated element on the page.
        expect(chapterTag({ kind: 'group' })).toBe('');
    });

    it('gives a bare line and a turn divider no heading either', () => {
        expect(chapterTag({ kind: 'activity' })).toBe('');
        expect(chapterTag({ kind: 'fold' })).toBe('');
        expect(chapterTag({ kind: 'turn' })).toBe('');
    });

    it('gives a folded RESULT none — it is one line by design', () => {
        expect(chapterTag({ kind: 'run', _bodyless: true })).toBe('');
        expect(chapterTag({ kind: 'deliverable', _bodyless: true })).toBe('');
    });
});

describe('itemClass', () => {
    it('marks every item as a chapter, with its kind', () => {
        expect(itemClass({ kind: 'group' })).toBe('tl-chapter tl-step');
        expect(itemClass({ kind: 'run' })).toBe('tl-chapter tl-final');
    });

    it('marks a live item', () => {
        expect(itemClass({ kind: 'group', live: true })).toContain('is-live');
    });

    it('does NOT carry the interactive state classes', () => {
        // `collapsed` / `is-open` are owned by the component: the items are plain
        // objects, so deriving those here would not re-render on a click.
        expect(itemClass({ kind: 'group', collapsed: true })).not.toContain('collapsed');
    });
});

describe('wordCount', () => {
    it('counts words for the one-line summary of a folded result', () => {
        expect(wordCount('one two three')).toBe(3);
        expect(wordCount('  padded   out  ')).toBe(2);
    });

    it('is zero for nothing', () => {
        expect(wordCount('')).toBe(0);
        expect(wordCount('   ')).toBe(0);
        expect(wordCount(null)).toBe(0);
    });
});
