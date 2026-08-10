import { describe, it, expect } from 'vitest';
import { looksComplex, looksReadOnly, shouldPlanFirst } from '../TaskComplexity.js';

// The bar: ordinary requests — including polite, multi-sentence Japanese ones —
// must NOT be treated as multi-step change work. That over-firing is what made
// the agent produce a goal/plan/files-to-change document for everything.
describe('looksComplex — ordinary requests are NOT complex', () => {
    const ordinary = [
        'バグを直してください',
        'この関数の名前を変えてください',
        'READMEにインストール手順を追加してください',
        // The exact shape that used to trip the old 60-char Japanese rule.
        'モニター画面のタスク一覧について、先頭以外はデフォルトで閉じた状態にする対応をお願いします',
        'ログイン処理でエラーが出るので確認して修正してください。再現手順は添付のとおりです',
        'Please fix the typo in the header component',
        'add a null check to the parser',
    ];
    for (const p of ordinary) {
        it(`not complex: ${p.slice(0, 32)}…`, () => expect(looksComplex(p)).toBe(false));
    }
});

describe('looksComplex — genuinely multi-step work IS complex', () => {
    it('numbered items', () => {
        expect(looksComplex('1. 認証を実装\n2. テストを追加\n3. ドキュメント更新')).toBe(true);
    });
    it('circled numbers', () => {
        expect(looksComplex('①設計を見直し ②実装 ③検証')).toBe(true);
    });
    it('a bullet list of three or more', () => {
        expect(looksComplex('やること\n- 認証\n- 課金\n- 通知')).toBe(true);
    });
    it('explicit sequencing', () => {
        expect(looksComplex('まず既存の実装を調べて、その後に新しい方式へ置き換えてください')).toBe(true);
        expect(looksComplex('First map the current flow, then migrate it to the new API')).toBe(true);
    });
    it('three or more named files', () => {
        expect(looksComplex('a.js と b.ts と c.rs を直して')).toBe(true);
    });
    it('sweeping scope', () => {
        expect(looksComplex('認証まわりを全面的にリファクタリングしてください')).toBe(true);
        expect(looksComplex('Refactor the storage layer to use the new driver')).toBe(true);
    });
    it('a genuinely long specification', () => {
        expect(looksComplex('あ'.repeat(401))).toBe(true);
    });
    it('two named files is not enough on its own', () => {
        expect(looksComplex('a.js と b.ts を直して')).toBe(false);
    });
});

describe('looksReadOnly — answers, not changes', () => {
    const readOnly = [
        'このプロジェクトの構成を調べて教えてください',
        '現状の課題をレポートにまとめてください',
        'AI-Agentとして評価をお願いします',
        'なぜこのエラーが出るのでしょうか？',
        'run_commandがブロックされているのはなぜですか？',
        'Analyze the current architecture and report the gaps',
        'What does this function do?',
    ];
    for (const p of readOnly) {
        it(`read-only: ${p.slice(0, 32)}…`, () => expect(looksReadOnly(p)).toBe(true));
    }

    it('an edit instruction is NOT read-only even when it mentions investigating', () => {
        expect(looksReadOnly('調べて修正してください')).toBe(false);
        expect(looksReadOnly('原因を調査して実装してください')).toBe(false);
    });

    it('"investigate only" stays read-only', () => {
        expect(looksReadOnly('原因を調査だけしてください')).toBe(true);
    });

    it('empty input is not read-only', () => {
        expect(looksReadOnly('')).toBe(false);
        expect(looksReadOnly(null)).toBe(false);
    });
});

describe('shouldPlanFirst — the gate decision', () => {
    it('does NOT plan for a report request, however detailed', () => {
        const p = '1. 現状の構成を調べる\n2. 問題点を洗い出す\n3. レポートにまとめてください';
        expect(looksComplex(p)).toBe(true);      // it IS multi-step…
        expect(shouldPlanFirst(p)).toBe(false);  // …but nothing gets changed
    });

    it('DOES plan for multi-step change work', () => {
        expect(shouldPlanFirst('1. 認証を実装\n2. テストを追加\n3. ドキュメント更新')).toBe(true);
    });

    it('does not plan for a simple change', () => {
        expect(shouldPlanFirst('タイポを直してください')).toBe(false);
    });

    it('does not plan for a question', () => {
        expect(shouldPlanFirst('この設定は何に使われますか？')).toBe(false);
    });

    it('handles empty input', () => {
        expect(shouldPlanFirst('')).toBe(false);
        expect(shouldPlanFirst(undefined)).toBe(false);
    });
});
