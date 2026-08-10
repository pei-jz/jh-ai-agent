import { describe, it, expect } from 'vitest';
import { scoreToolRelevance, selectMcpTools } from '../ToolRelevance.js';
import { textUnits } from '../../memory/MemoryScoring.js';

const mkTools = (n, prefix = 't') =>
    Array.from({ length: n }, (_, i) => ({ name: `${prefix}_${i}`, description: `tool number ${i}`, _serverName: 'srv' }));

describe('scoreToolRelevance', () => {
    it('scores fraction of query units found in name+description', () => {
        const tool = { name: 'add_issue', description: 'Create a new Backlog issue (課題を追加)' };
        expect(scoreToolRelevance(tool, textUnits('issue add'))).toBe(1);
        expect(scoreToolRelevance(tool, textUnits('wiki page'))).toBe(0);
    });
    it('matches Japanese queries via bigrams', () => {
        const tool = { name: 'add_issue', description: '課題を追加する' };
        expect(scoreToolRelevance(tool, textUnits('課題を追加してください'))).toBeGreaterThan(0);
    });
    it('returns 0 for empty query units', () => {
        expect(scoreToolRelevance({ name: 'x', description: 'y' }, new Set())).toBe(0);
    });
});

describe('selectMcpTools', () => {
    it('loads everything when there is no query (pruning off)', () => {
        const tools = mkTools(20);
        const { loaded, deferred } = selectMcpTools(tools, null);
        expect(loaded).toHaveLength(20);
        expect(deferred).toHaveLength(0);
    });
    it('loads everything when the set is small (≤ minCount)', () => {
        const tools = mkTools(6);
        const { loaded, deferred } = selectMcpTools(tools, 'some query');
        expect(loaded).toHaveLength(6);
        expect(deferred).toHaveLength(0);
    });
    it('keeps top-5 by relevance and defers the rest', () => {
        const tools = [
            ...mkTools(10, 'noise'),
            { name: 'add_issue', description: 'create a backlog issue', _serverName: 'backlog' },
        ];
        const { loaded, deferred } = selectMcpTools(tools, 'create issue in backlog');
        expect(loaded).toHaveLength(5);
        expect(loaded.some(t => t.name === 'add_issue')).toBe(true);
        expect(deferred).toHaveLength(6);
    });
    it('honors alwaysInclude names on top of the top-5', () => {
        const tools = mkTools(12);
        const { loaded } = selectMcpTools(tools, 'unrelated query text', {
            alwaysInclude: new Set(['t_11']),
        });
        expect(loaded.some(t => t.name === 't_11')).toBe(true);
        expect(loaded.length).toBeLessThanOrEqual(6); // top-5 + 1 always-included
    });
    it('handles empty/invalid input', () => {
        expect(selectMcpTools([], 'q')).toEqual({ loaded: [], deferred: [] });
        expect(selectMcpTools(null, 'q')).toEqual({ loaded: [], deferred: [] });
    });

    it('minScore mode sends ONLY tools at/above the threshold (none when irrelevant)', () => {
        const tools = [
            { name: 'add_issue', description: 'create a backlog issue 課題' },
            ...mkTools(10, 'noise'),
        ];
        // Relevant query → only the matching tool passes the threshold.
        const r1 = selectMcpTools(tools, 'create issue', { minScore: 0.2, top: 5 });
        expect(r1.loaded.map(t => t.name)).toEqual(['add_issue']);
        // Unrelated query → nothing scores above threshold → send NONE.
        const r2 = selectMcpTools(tools, '天気を教えて', { minScore: 0.2, top: 5 });
        expect(r2.loaded).toEqual([]);
    });

    it('minScore mode ignores the small-set minCount bypass', () => {
        const tools = mkTools(3); // ≤ minCount would normally send all
        const r = selectMcpTools(tools, 'totally unrelated', { minScore: 0.5 });
        expect(r.loaded).toEqual([]); // score-pruned anyway
    });
});
