// Tests for agent/LLMTurn.js — pure native/JSON tool-call formatting (P3 split).

import { describe, it, expect } from 'vitest';
import { formatNativeToolCalls, looksLikeToolTextCall, stripThoughtWrapper } from '../LLMTurn.js';

const F = '<function=';
const TC = '<tool_' + 'call>';
const T_OPEN = '<thought>';
const T_CLOSE = '</thought>';

describe('formatNativeToolCalls', () => {
    it('formats provider entries with nested function objects', () => {
        const out = formatNativeToolCalls([
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ]);
        expect(out).toEqual([{ name: 'read_file', args: { path: 'a' } }]);
    });

    it('tolerates flattened entries and empty argument strings', () => {
        const out = formatNativeToolCalls([
            { name: 'write_file', arguments: '{"path":"b"}' },
            { name: 'no_args', arguments: '' },
        ]);
        expect(out).toEqual([
            { name: 'write_file', args: { path: 'b' } },
            { name: 'no_args', args: {} },
        ]);
    });

    it('drops entries without a name and object args pass through', () => {
        const out = formatNativeToolCalls([
            { args: { x: 1 } },
            { function: { name: 'ok', arguments: { path: 'c' } } },
        ]);
        expect(out).toEqual([{ name: 'ok', args: { path: 'c' } }]);
    });

    it('throws SyntaxError on malformed JSON arguments', () => {
        expect(() => formatNativeToolCalls([{ function: { name: 'a', arguments: '{bad' } }]))
            .toThrow(SyntaxError);
    });
});

describe('looksLikeToolTextCall', () => {
    it('detects CALL: / angle-bracket tool invocations', () => {
        expect(looksLikeToolTextCall('CALL: read_file')).toBe(true);
        expect(looksLikeToolTextCall(F + 'read_file>')).toBe(true);
        expect(looksLikeToolTextCall(TC + 'x' + '</' + 'tool_' + 'call>')).toBe(true);
    });

    it('accepts plain prose', () => {
        expect(looksLikeToolTextCall('Here is my answer.')).toBe(false);
        expect(looksLikeToolTextCall('')).toBe(false);
        expect(looksLikeToolTextCall(null)).toBe(false);
    });

    it('detects a known tool name combined with PLAN:', () => {
        expect(looksLikeToolTextCall('PLAN: use read_file next', ['read_file'])).toBe(true);
        expect(looksLikeToolTextCall('PLAN: continue', ['read_file'])).toBe(false);
    });
});

describe('stripThoughtWrapper', () => {
    it('extracts the inner text of a thought wrapper', () => {
        expect(stripThoughtWrapper('pre ' + T_OPEN + 'OBSERVE x' + T_CLOSE + ' post')).toBe('OBSERVE x');
    });

    it('returns raw text when no wrapper is present', () => {
        expect(stripThoughtWrapper('plain')).toBe('plain');
        expect(stripThoughtWrapper('')).toBe('');
    });
});

describe('formatNativeToolCalls — injected parser', () => {
    it('uses the supplied parser for the arguments string', () => {
        // The agent injects its REPAIRING parser here; wiring the module version
        // with the default JSON.parse would silently drop that recovery.
        const repaired = formatNativeToolCalls(
            [{ function: { name: 'read_file', arguments: '{"path": "a.js",}' } }],
            (s) => JSON.parse(s.replace(/,\s*}/g, '}')),
        );
        expect(repaired[0].args).toEqual({ path: 'a.js' });
    });

    it('still throws SyntaxError when the injected parser cannot recover', () => {
        expect(() => formatNativeToolCalls(
            [{ function: { name: 'read_file', arguments: '{oops' } }],
            (s) => JSON.parse(s),
        )).toThrow(SyntaxError);
    });

    it('defaults to strict JSON.parse when no parser is given', () => {
        expect(formatNativeToolCalls([{ function: { name: 'x', arguments: '{"a":1}' } }])[0].args).toEqual({ a: 1 });
    });
});
