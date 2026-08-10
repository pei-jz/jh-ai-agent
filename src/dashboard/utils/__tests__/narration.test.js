import { describe, it, expect } from 'vitest';
import { extractNarration } from '../narration.js';

describe('extractNarration', () => {
    it('returns plain prose untouched', () => {
        expect(extractNarration('Canvas.jsx を読んで描画ロジックを確認します。'))
            .toBe('Canvas.jsx を読んで描画ロジックを確認します。');
    });

    it('stops at a code fence (no code in the narration)', () => {
        expect(extractNarration('まず設定を確認します。\n```json\n{"a":1}\n```'))
            .toBe('まず設定を確認します。');
    });

    it('stops at an XML-ish tool call from a broken native model', () => {
        expect(extractNarration('ファイルを探します。<tool_call><function=grep_search>'))
            .toBe('ファイルを探します。');
    });

    it('stops at an inline JSON envelope', () => {
        expect(extractNarration('確認します。{"thought":"x","tool_calls":[]}'))
            .toBe('確認します。');
    });

    it('stops at a brace opening a line', () => {
        expect(extractNarration('調べます。\n{\n  "tool_calls": []\n}'))
            .toBe('調べます。');
    });

    it('a pure JSON reply (JSON-mode model) yields NOTHING — no leak', () => {
        expect(extractNarration('{"thought":"t","tool_calls":[{"name":"read_file"}]}')).toBe('');
        expect(extractNarration('```json\n{"tool_calls":[]}\n```')).toBe('');
    });

    it('a pure XML tool call yields nothing', () => {
        expect(extractNarration('<tool_call><function=task_progress></function></tool_call>')).toBe('');
    });

    it('trims a trailing partial marker mid-stream', () => {
        expect(extractNarration('読み込みます。``')).toBe('読み込みます。');
        expect(extractNarration('確認します。<')).toBe('確認します。');
    });

    it('handles empty/null', () => {
        expect(extractNarration('')).toBe('');
        expect(extractNarration(null)).toBe('');
        expect(extractNarration(undefined)).toBe('');
    });

    it('keeps multi-sentence prose before the call', () => {
        expect(extractNarration('README を読みます。\nプロジェクトの目的を把握するためです。\n```json\n{}\n```'))
            .toBe('README を読みます。\nプロジェクトの目的を把握するためです。');
    });
});
