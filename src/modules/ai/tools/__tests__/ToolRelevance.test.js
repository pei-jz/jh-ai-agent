import { describe, it, expect } from 'vitest';
import { scoreToolRelevance, scoreServerRelevance, selectMcpTools } from '../ToolRelevance.js';
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

// A server that spreads one job over many tools whose own descriptions share
// few words with the request (jh-presentation: guide → create → write → check).
const deckTools = () => [
    { name: 'get_guide', description: '書き方・部品カタログ', _serverName: 'jh-presentation' },
    { name: 'list_themes', description: 'テーマ一覧', _serverName: 'jh-presentation' },
    { name: 'create_deck', description: '新しいデッキを作る', _serverName: 'jh-presentation' },
    { name: 'write_deck', description: 'デッキに書き込む', _serverName: 'jh-presentation' },
    { name: 'audit_deck', description: 'レイアウトを検査する', _serverName: 'jh-presentation' },
    { name: 'open_deck', description: 'ブラウザで開く', _serverName: 'jh-presentation' },
];
const deckInstructions = new Map([['jh-presentation',
    'プレゼンテーション資料 (スライド・発表資料) を HTML で作成・確認する道具。スライドを作る前に必ず get_guide を呼び、問題があれば直してから完了を伝える。']]);

describe('scoreServerRelevance', () => {
    it('scores the topic words of the request against the server description', () => {
        const ins = deckInstructions.get('jh-presentation');
        expect(scoreServerRelevance('jh-presentation', ins, textUnits('スライドを作って'))).toBe(1);
        expect(scoreServerRelevance('jh-presentation', ins, textUnits('発表資料を作成したい'))).toBeGreaterThan(0.5);
    });
    it('ignores hiragana-only units (particles and verb endings match anything)', () => {
        const ins = deckInstructions.get('jh-presentation');
        // 「この」「して」「直し」 all appear in the description — none is a topic.
        expect(scoreServerRelevance('jh-presentation', ins, textUnits('このバグを直して'))).toBe(0);
    });
    it('is 0 for a server without instructions', () => {
        expect(scoreServerRelevance('srv', '', textUnits('スライド'))).toBe(0);
    });
});

describe('selectMcpTools — server relevance', () => {
    it('loads the whole server when the request is plainly about it, even in minScore mode', () => {
        const tools = [...deckTools(), ...mkTools(10, 'noise')];
        const before = selectMcpTools(tools, 'スライドを作って', { minScore: 0.12, top: 5 });
        expect(before.loaded.map(t => t.name)).not.toContain('get_guide');
        const { loaded } = selectMcpTools(tools, 'スライドを作って', { minScore: 0.12, top: 5, serverInstructions: deckInstructions });
        expect(loaded.filter(t => t._serverName === 'jh-presentation')).toHaveLength(deckTools().length);
        expect(loaded.some(t => t.name.startsWith('noise'))).toBe(false);
    });
    it('loads only the top tools of a partially matching server', () => {
        const tools = [...deckTools(), ...mkTools(10, 'noise')];
        // topic units: git 基本 新人 人向 発表 表資 資料 → 3/7 ≈ 0.43 (between 0.2 and 0.5)
        const { loaded } = selectMcpTools(tools, 'Gitの基本について新人向けに発表資料を作って', {
            minScore: 0.12, top: 5, serverInstructions: deckInstructions, serverTop: 2,
        });
        expect(loaded.filter(t => t._serverName === 'jh-presentation')).toHaveLength(2);
    });
    it('adds nothing for a request about another server', () => {
        const tools = [...deckTools(), { name: 'find_issue', description: '課題を検索する', _serverName: 'backlog' }];
        const opts = { minScore: 0.12, top: 5 };
        const without = selectMcpTools(tools, 'Backlogの課題を検索して', opts).loaded;
        const withHints = selectMcpTools(tools, 'Backlogの課題を検索して', { ...opts, serverInstructions: deckInstructions }).loaded;
        expect(withHints).toEqual(without);
        expect(withHints.map(t => t.name)).toContain('find_issue');
    });
});
