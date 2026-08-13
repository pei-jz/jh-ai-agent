// ProjectOverview — the gist layer.
//
// This is the only memory writer that uses a model, so the tests are mostly
// about keeping it honest: it summarises STRUCTURE (never source), it is capped
// because it rides in every prompt, and it is labelled as generated so it cannot
// be mistaken for the user's own rules.

import { describe, it, expect } from 'vitest';
import {
    structureDigest, buildOverviewPrompt, normalizeOverview, renderOverview,
    isOverviewStale, OVERVIEW_MAX_CHARS, AREA_LIMIT,
} from '../ProjectOverview.js';

const card = (q, target) => ({ q, target });

describe('structureDigest', () => {
    it('groups symbols into the areas they live in, biggest first', () => {
        const areas = structureDigest([
            card('a', 'src/modules/ai/x.js:1'),
            card('b', 'src/modules/ai/y.js:1'),
            card('c', 'src/dashboard/z.js:1'),
        ]);
        expect(areas[0]).toMatchObject({ dir: 'src/modules/ai', files: 2 });
        expect(areas[1]).toMatchObject({ dir: 'src/dashboard', files: 1 });
    });

    it('counts FILES, not symbols — ten exports from one file is one file', () => {
        const areas = structureDigest(
            Array.from({ length: 10 }, (_, i) => card(`n${i}`, 'src/a/one.js:1')));
        expect(areas[0].files).toBe(1);
        expect(areas[0].names).toHaveLength(10);
    });

    it('makes paths relative to the workspace', () => {
        const areas = structureDigest([card('a', 'C:/ws/src/core/x.js:1')], { root: 'C:/ws' });
        expect(areas[0].dir).toBe('src/core');
    });

    it('normalises Windows separators', () => {
        expect(structureDigest([card('a', 'src\\core\\x.js:1')])[0].dir).toBe('src/core');
    });

    it('survives junk', () => {
        expect(structureDigest(null)).toEqual([]);
        expect(structureDigest([{}])).toEqual([]);
    });
});

describe('buildOverviewPrompt', () => {
    const areas = Array.from({ length: 20 }, (_, i) => ({ dir: `src/a${i}`, files: 20 - i, names: ['x', 'y'] }));

    it('describes the structure, and never asks for source', () => {
        const p = buildOverviewPrompt(areas.slice(0, 2), { projectName: 'jh-ai-agent' });
        expect(p).toContain('jh-ai-agent');
        expect(p).toContain('src/a0/');
        expect(p).not.toMatch(/read the (files|source)/i);
    });

    it('caps how many areas it names, and says how many it left out', () => {
        const p = buildOverviewPrompt(areas);
        expect(p).toContain(`…and ${20 - AREA_LIMIT} smaller areas`);
    });

    it('forbids inventing what the structure does not show', () => {
        // The failure mode for a generated overview is confident fiction about
        // business purpose, which then rides in every prompt.
        const p = buildOverviewPrompt(areas.slice(0, 1));
        expect(p).toContain('Do NOT invent');
        expect(p).toContain('appears to');
    });

    it('keeps the note short enough to be standing context', () => {
        expect(buildOverviewPrompt(areas.slice(0, 1))).toMatch(/UNDER \d+ characters/);
    });
});

describe('normalizeOverview', () => {
    it('strips a code fence the model wrapped it in', () => {
        expect(normalizeOverview('```markdown\n- a bullet\n```')).toBe('- a bullet');
    });

    it('drops a lead-in line that is not part of the note', () => {
        expect(normalizeOverview('Here is the orientation note:\n- a bullet')).toBe('- a bullet');
    });

    it('keeps a first line that IS a bullet', () => {
        expect(normalizeOverview('- first\n- second')).toBe('- first\n- second');
    });

    it('enforces the standing-context cap', () => {
        const out = normalizeOverview('- ' + 'x'.repeat(5000));
        expect(out.length).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS);
        expect(out.endsWith('…')).toBe(true);
    });

    it('returns empty for nothing', () => {
        expect(normalizeOverview('')).toBe('');
        expect(normalizeOverview(null)).toBe('');
    });
});

describe('renderOverview', () => {
    it('labels the block as generated and possibly stale', () => {
        // It sits next to the user's own instructions.md, which is normative.
        // Reading as equally authoritative is the thing to prevent.
        const b = renderOverview('- a bullet', { generatedAt: '2026-08-13T00:00:00Z' });
        expect(b).toContain('<project_overview');
        expect(b).toContain('2026-08-13');
        expect(b).toMatch(/Auto-generated/);
        expect(b).toMatch(/prefer what you read in the files/);
    });

    it('emits nothing when there is no note — no empty block in the prompt', () => {
        expect(renderOverview('')).toBe('');
        expect(renderOverview('   ')).toBe('');
    });
});

describe('isOverviewStale', () => {
    const now = Date.parse('2026-08-13T00:00:00Z');

    it('is stale when there is none', () => {
        expect(isOverviewStale(null, { now })).toBe(true);
        expect(isOverviewStale({ generatedAt: '' }, { now })).toBe(true);
    });

    it('is fresh within the window and stale past it', () => {
        expect(isOverviewStale({ generatedAt: '2026-08-01T00:00:00Z' }, { now })).toBe(false);
        expect(isOverviewStale({ generatedAt: '2026-06-01T00:00:00Z' }, { now })).toBe(true);
    });
});
