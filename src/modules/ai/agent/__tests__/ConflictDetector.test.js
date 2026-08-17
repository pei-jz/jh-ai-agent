// ConflictDetector — parallel tool-call conflict detection (P5).
//
// The loop runs "Allow" calls of one step in parallel. Two calls that MUTATE
// the same file race silently (last-write-wins, replace applied to stale base).
// This module finds those pairs so the loop can serialize them — the file-level
// sibling of the write-scope serialization that already exists for sub-agents.

import { describe, it, expect } from 'vitest';
import {
    normalizeConflictPath, callTargets, detectParallelConflicts,
    partitionParallelCalls, serializationNotice,
} from '../ConflictDetector.js';

describe('normalizeConflictPath', () => {
    it('converts backslashes and drops trailing separators', () => {
        expect(normalizeConflictPath('C:\\proj\\src\\a.js')).toBe('C:/proj/src/a.js');
        expect(normalizeConflictPath('C:/proj/src/a.js/')).toBe('C:/proj/src/a.js');
    });
});

describe('callTargets', () => {
    it('write_file targets its path as a WRITE', () => {
        const t = callTargets({ name: 'write_file', args: { path: 'C:/a.js', content: 'x' } });
        expect(t.write).toEqual(['C:/a.js']);
        expect(t.read).toEqual([]);
    });

    it('move_file reads its source and writes its destination', () => {
        const t = callTargets({ name: 'move_file', args: { from: 'C:/a.js', to: 'C:/b.js' } });
        expect(t.read).toEqual(['C:/a.js']);
        expect(t.write).toEqual(['C:/b.js']);
    });

    it('read_file is a READ, never a conflict source', () => {
        const t = callTargets({ name: 'read_file', args: { path: 'C:/a.js' } });
        expect(t.write).toEqual([]);
        expect(t.read).toEqual(['C:/a.js']);
    });

    it('non-file tools have no targets', () => {
        expect(callTargets({ name: 'web_search', args: { query: 'x' } })).toEqual({ write: [], read: [] });
    });

    it('handles missing or null args safely', () => {
        expect(callTargets({ name: 'write_file', args: null })).toEqual({ write: [], read: [] });
        expect(callTargets({ name: 'write_file' })).toEqual({ write: [], read: [] });
    });
});

describe('detectParallelConflicts', () => {
    it('flags two writes to the same file', () => {
        const a = { name: 'write_file', args: { path: 'C:/a.js' } };
        const b = { name: 'multi_replace_file_content', args: { path: 'C:/a.js' } };
        const flagged = detectParallelConflicts([a, b]);
        expect(flagged.has(a)).toBe(false);  // first call keeps its slot
        expect(flagged.has(b)).toBe(true);   // second is serialized
    });

    it('does NOT flag reads or writes to different files', () => {
        const a = { name: 'write_file', args: { path: 'C:/a.js' } };
        const b = { name: 'write_file', args: { path: 'C:/b.js' } };
        const c = { name: 'read_file', args: { path: 'C:/a.js' } };
        expect(detectParallelConflicts([a, b, c]).size).toBe(0);
    });

    it('flags move_file against BOTH its source and its destination', () => {
        const move = { name: 'move_file', args: { from: 'C:/a.js', to: 'C:/b.js' } };
        const writeB = { name: 'write_file', args: { path: 'C:/b.js' } };
        const readA = { name: 'read_file', args: { path: 'C:/a.js' } };
        // move comes first: writeB conflicts (same destination).
        expect(detectParallelConflicts([move, writeB]).has(writeB)).toBe(true);
        // readA does NOT conflict — reads never do.
        expect(detectParallelConflicts([move, readA]).has(readA)).toBe(false);
    });

    it('is a no-op for a single call or empty batch', () => {
        expect(detectParallelConflicts([]).size).toBe(0);
        expect(detectParallelConflicts([{ name: 'write_file', args: { path: 'C:/a' } }]).size).toBe(0);
    });
});

describe('partitionParallelCalls', () => {
    it('keeps order: the first writer stays parallel, later ones serialize', () => {
        const a = { name: 'write_file', args: { path: 'C:/a.js' } };
        const b = { name: 'write_file', args: { path: 'C:/a.js' } };
        const c = { name: 'read_file', args: { path: 'C:/x.js' } };
        const { parallel, serial, conflicts } = partitionParallelCalls([a, b, c]);
        expect(parallel.map(x => x.name)).toEqual(['write_file', 'read_file']);
        expect(parallel[0]).toBe(a);
        expect(serial).toHaveLength(1);
        // IDENTITY, not shape: the loop looks the call up in an identity Map to
        // recover its native tool_call id. A copy here silently drops that id.
        expect(serial[0]).toBe(b);
        expect(conflicts[0].call).toBe(b);
        expect(conflicts[0].paths).toEqual(['C:/a.js']);
    });

    it('chains: three writers to the same file serialize the last two', () => {
        const a = { name: 'write_file', args: { path: 'C:/a.js' } };
        const b = { name: 'write_file', args: { path: 'C:/a.js' } };
        const c = { name: 'write_file', args: { path: 'C:/a.js' } };
        const { parallel, serial } = partitionParallelCalls([a, b, c]);
        expect(parallel).toEqual([a]);
        expect(serial).toEqual([b, c]);
    });

    it('never reorders the original calls', () => {
        const calls = [
            { name: 'read_file', args: { path: 'C:/a.js' } },
            { name: 'write_file', args: { path: 'C:/b.js' } },
            { name: 'web_search', args: { query: 'q' } },
        ];
        const { parallel } = partitionParallelCalls(calls);
        expect(parallel).toEqual(calls);
    });
});

describe('serializationNotice', () => {
    it('is empty when nothing was serialized', () => {
        expect(serializationNotice([])).toBe('');
    });

    it('names the serialized calls when there are any', () => {
        const notice = serializationNotice([{ name: 'write_file' }, { name: 'update_xlsx' }]);
        expect(notice).toContain('write_file');
        expect(notice).toContain('update_xlsx');
    });
});
