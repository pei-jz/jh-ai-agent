import { describe, it, expect } from 'vitest';
import { sanitizeXmlTags, relevanceScore, scoreMessageImportance, textUnits, conceptUnits } from '../MemoryScoring.js';

describe('sanitizeXmlTags', () => {
    it('neutralizes active tags', () => {
        expect(sanitizeXmlTags('<active_file>x</active_file>')).toBe('[active_file]x[/active_file]');
        expect(sanitizeXmlTags('<artifact id="1">y</artifact>')).toBe('[artifact id="1"]y[/artifact]');
    });
    it('leaves unrelated tags and non-strings alone', () => {
        expect(sanitizeXmlTags('<div>z</div>')).toBe('<div>z</div>');
        expect(sanitizeXmlTags(null)).toBeNull();
        expect(sanitizeXmlTags(42)).toBe(42);
    });
});

describe('relevanceScore', () => {
    it('returns 0.5 with no usable query', () => {
        expect(relevanceScore({ summary: 'x' }, '')).toBe(0.5);
        expect(relevanceScore({ summary: 'x' }, '?? !!')).toBe(0.5);
    });
    it('scores keyword overlap across fields', () => {
        const entry = { topic: 'auth login', summary: 'fixed token bug', actions: ['edit auth'], keyFiles: ['auth.js'] };
        expect(relevanceScore(entry, 'auth token')).toBe(1);     // both words hit
        expect(relevanceScore(entry, 'auth missing')).toBe(0.5); // 1 of 2
        expect(relevanceScore(entry, 'unrelated stuff')).toBe(0);
    });
    it('matches Japanese queries via character bigrams', () => {
        const entry = { topic: '認証バグ修正', summary: 'ログイン時のトークン検証エラーを修正した' };
        const related = relevanceScore(entry, 'ログインの認証エラー');
        const unrelated = relevanceScore(entry, '帳票印刷のレイアウト調整');
        expect(related).toBeGreaterThan(0.5);
        expect(unrelated).toBeLessThan(related);
    });
});

describe('textUnits', () => {
    it('extracts latin words and CJK bigrams together', () => {
        const units = textUnits('auth.jsの認証処理');
        expect(units.has('auth.js')).toBe(true);
        expect(units.has('認証')).toBe(true);
        expect(units.has('証処')).toBe(true);
    });
    it('keeps a lone CJK char as a unit', () => {
        expect(textUnits('値').has('値')).toBe(true);
    });
    it('returns empty set for punctuation-only input', () => {
        expect(textUnits('?? !!').size).toBe(0);
    });
});

describe('scoreMessageImportance', () => {
    it('rewards plans highly', () => {
        expect(scoreMessageImportance({ role: 'assistant', content: 'see plan.md for steps' })).toBeGreaterThanOrEqual(5);
    });
    it('rewards errors and file mods', () => {
        expect(scoreMessageImportance({ role: 'assistant', content: 'Error: failed to compile foo.ts' })).toBeGreaterThan(0);
        expect(scoreMessageImportance({ role: 'assistant', content: 'write_file to src/a.js' })).toBeGreaterThan(0);
    });
    it('rewards genuine user instructions', () => {
        const userMsg = scoreMessageImportance({ role: 'user', content: 'please refactor the parser' });
        const sysMsg = scoreMessageImportance({ role: 'user', content: '[System] notice' });
        expect(userMsg).toBeGreaterThan(sysMsg);
    });
    it('penalizes tool-result dumps and system nudges', () => {
        expect(scoreMessageImportance({ role: 'user', content: 'Tool Execution Results:\n[...]' })).toBeLessThanOrEqual(0);
        expect(scoreMessageImportance({ role: 'user', content: '[System] keep going' })).toBeLessThan(0);
    });
    it('handles empty/missing content', () => {
        expect(scoreMessageImportance({})).toBe(0);
        expect(scoreMessageImportance({ role: 'assistant', content: '' })).toBe(0);
    });
});

// ── Cross-language recall ─────────────────────────────────────────────────
//
// Memory cards are minted from tool names and error text, so they are English
// ("write_file|edit_mismatch|.svelte"). Prompts in this product are usually
// Japanese. The two describe the same work and share no character, so unit
// overlap scored exactly 0 and the whole memory layer was invisible from the
// language most of its users write in.
describe('relevanceScore — a Japanese prompt can reach an English card', () => {
    const card = (summary) => ({ summary });

    it('scores above the injection floor for a matching concept', () => {
        // MEMORY_MIN_RELEVANCE is 0.08; this used to be a flat 0.
        const s = relevanceScore(card('run_command failed: test suite did not pass'), 'テストを追加してください');
        expect(s).toBeGreaterThan(0.08);
    });

    it('still scores 0 when the concepts genuinely differ', () => {
        // The guard against a glossary that makes everything look relevant.
        const s = relevanceScore(card('git commit and branch handling'), 'エクセルの集計表を作って');
        expect(s).toBe(0);
    });

    it('matches an English prompt against an English card at least as well', () => {
        const c = card('run_command failed: test suite did not pass');
        expect(relevanceScore(c, 'add a test')).toBeGreaterThan(0.08);
    });

    it('does not let a concept match outrank a literal one', () => {
        const literal = card('MonitorView.js render loop');
        const conceptOnly = card('test suite');
        const q = 'MonitorView.js';
        expect(relevanceScore(literal, q)).toBeGreaterThan(relevanceScore(conceptOnly, q));
    });
});

describe('textUnits — identifiers and width folding', () => {
    it('splits camelCase so a card about MonitorView matches "monitor"', () => {
        const u = textUnits('MonitorView.js');
        expect(u.has('monitor')).toBe(true);
        expect(u.has('view')).toBe(true);
    });

    it('splits snake_case tool names', () => {
        const u = textUnits('multi_replace_file_content');
        expect(u.has('replace')).toBe(true);
        expect(u.has('file')).toBe(true);
    });

    it('folds full-width ASCII, which Japanese IMEs produce for filenames', () => {
        const u = textUnits('ＭｏｎｉｔｏｒＶｉｅｗ．ｊｓ');
        expect(u.has('monitor')).toBe(true);
    });

    it('still produces CJK bigrams', () => {
        expect(textUnits('タスク一覧').has('タス')).toBe(true);
    });
});

describe('conceptUnits', () => {
    it('reads concepts out of Japanese without word boundaries', () => {
        const c = conceptUnits('テストを修正して');
        expect(c.has('test')).toBe(true);
        expect(c.has('edit')).toBe(true);
    });

    it('reads the same concepts out of English', () => {
        const c = conceptUnits('fix the failing test');
        expect(c.has('test')).toBe(true);
        expect(c.has('edit')).toBe(true);
    });

    it('does not match a latin term inside an unrelated word', () => {
        // "add" inside "address" — the reason latin terms are checked against
        // extracted words rather than by substring.
        expect(conceptUnits('the address parser').has('add')).toBe(false);
    });

    it('is empty for text with no domain terms', () => {
        expect(conceptUnits('こんにちは').size).toBe(0);
    });
});
