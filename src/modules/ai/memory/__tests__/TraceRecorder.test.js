// TraceRecorder — the session trace and the cost accounting built on it.
// `costSteps` is the number Step 1 ranks Failure Cards by, so the arithmetic is
// pinned here rather than left to be re-derived when cards are minted.

import { describe, it, expect, vi } from 'vitest';
import { toEvent, summarizeFailures, TraceRecorder } from '../TraceRecorder.js';

const ok = (i, tool, target) => toEvent({ iteration: i, tool, args: { path: target }, result: 'Success', isError: false, ms: 5 });
const fail = (i, tool, target, msg) => toEvent({ iteration: i, tool, args: { path: target }, result: msg, isError: true, ms: 5 });

describe('toEvent', () => {
    it('records a success without a signature (nothing to learn from)', () => {
        const e = ok(3, 'read_file', 'a.js');
        expect(e).toMatchObject({ i: 3, tool: 'read_file', ok: true, target: 'a.js' });
        expect(e.signature).toBeUndefined();
        expect(e.kind).toBeUndefined();
    });

    it('classifies a failure and attaches the signature', () => {
        const e = fail(4, 'multi_replace_file_content', 'Foo.svelte', 'Error: anchor does not match');
        expect(e.ok).toBe(false);
        expect(e.kind).toBe('edit_mismatch');
        expect(e.signature).toBe('multi_replace_file_content|edit_mismatch|.svelte');
    });

    it('redacts the target path and the message', () => {
        const e = toEvent({
            iteration: 1, tool: 'read_file',
            args: { path: 'C:\\Users\\裴京植\\p\\a.js' },
            result: 'Error: File does not exist: C:\\Users\\裴京植\\p\\a.js (token=abcdef123456)',
            isError: true,
        });
        expect(e.target).not.toContain('裴京植');
        expect(e.message).not.toContain('裴京植');
        expect(e.message).not.toContain('abcdef123456');
    });

    it('records the arg SHAPE, not the values', () => {
        const e = toEvent({ iteration: 1, tool: 'write_file', args: { path: 'a.js', content: 'secret body' } });
        expect(e.argShape).toBe('content,path');
        expect(JSON.stringify(e)).not.toContain('secret body');
    });

    it('flags a denied call', () => {
        const e = toEvent({ iteration: 1, tool: 'delete_file', args: {}, result: 'Error: User Denied', isError: true, denied: true });
        expect(e.denied).toBe(true);
        expect(e.kind).toBe('permission_denied');
    });

    it('caps the stored message', () => {
        const e = fail(1, 'run_command', 'a.js', 'Error: build failed ' + 'x'.repeat(2000));
        expect(e.message.length).toBeLessThanOrEqual(300);
    });
});

describe('summarizeFailures', () => {
    it('charges a failure the distance to the success that resolved it', () => {
        const events = [
            fail(3, 'multi_replace_file_content', 'a.svelte', 'Error: anchor does not match'),
            fail(4, 'multi_replace_file_content', 'a.svelte', 'Error: anchor does not match'),
            ok(5, 'read_file', 'a.svelte'),                       // different tool — not the fix
            ok(10, 'multi_replace_file_content', 'a.svelte'),      // this one resolves it
        ];
        const [row] = summarizeFailures(events);
        expect(row.first).toBe(3);
        expect(row.resolvedAt).toBe(10);
        expect(row.costSteps).toBe(7);
        expect(row.attempts).toBe(2);
        expect(row.unresolved).toBe(false);
    });

    it('charges an unresolved failure to the end of the session', () => {
        const events = [
            fail(2, 'write_file', 'a.js', 'Error: User Denied file write.'),
            ok(9, 'read_file', 'b.js'),
        ];
        const [row] = summarizeFailures(events);
        expect(row.unresolved).toBe(true);
        expect(row.resolvedAt).toBeNull();
        expect(row.costSteps).toBe(7); // 9 (last iteration) − 2
    });

    it('does not count a success on a DIFFERENT target as the fix', () => {
        const events = [
            fail(2, 'write_file', 'a.js', 'Error: anchor does not match'),
            ok(3, 'write_file', 'other.js'),
        ];
        expect(summarizeFailures(events)[0].unresolved).toBe(true);
    });

    it('groups by (signature, target) and keeps distinct failures apart', () => {
        const events = [
            fail(1, 'write_file', 'a.js', 'Error: anchor does not match'),
            fail(2, 'write_file', 'b.js', 'Error: anchor does not match'),
            fail(3, 'read_file', 'a.js', 'Error: File does not exist'),
        ];
        expect(summarizeFailures(events)).toHaveLength(3);
    });

    it('ranks the most expensive failure first', () => {
        const events = [
            fail(1, 'read_file', 'a.js', 'Error: File does not exist'),
            ok(2, 'read_file', 'a.js'),                          // cheap: cost 1
            fail(2, 'run_command', 'b.js', 'Error: build failed'),
            ok(12, 'run_command', 'b.js'),                       // expensive: cost 10
        ];
        const rows = summarizeFailures(events);
        expect(rows[0].kind).toBe('build_failure');
        expect(rows[0].costSteps).toBe(10);
    });

    it('carries the denied flag through, so Step 1 can exclude those rows', () => {
        const events = [toEvent({ iteration: 1, tool: 'delete_file', args: { path: 'a.js' }, result: 'Error: User Denied', isError: true, denied: true })];
        expect(summarizeFailures(events)[0].denied).toBe(true);
    });

    it('returns nothing for a clean session', () => {
        expect(summarizeFailures([ok(1, 'read_file', 'a.js')])).toEqual([]);
        expect(summarizeFailures([])).toEqual([]);
        expect(summarizeFailures(null)).toEqual([]);
    });
});

describe('TraceRecorder', () => {
    const make = (over = {}) => {
        const invoke = vi.fn(async () => null);
        return { invoke, rec: new TraceRecorder({ workspacePath: 'C:/ws', sessionId: 's1', invoke, ...over }) };
    };

    it('disables itself when there is nowhere to write', () => {
        const rec = new TraceRecorder({ invoke: vi.fn() });
        expect(rec.enabled).toBe(false);
        expect(rec.record({ iteration: 1, tool: 'read_file' })).toBeNull();
        expect(rec.events).toHaveLength(0);
    });

    it('writes one JSON object per line to .agent/trace/<session>.jsonl', async () => {
        const { invoke, rec } = make();
        rec.record({ iteration: 1, tool: 'read_file', args: { path: 'a.js' }, result: 'Success' });
        rec.record({ iteration: 2, tool: 'write_file', args: { path: 'a.js' }, result: 'Error: File does not exist', isError: true });
        await rec.flush();

        const write = invoke.mock.calls.find(c => c[0] === 'write_file');
        expect(write[1].path).toBe('C:/ws/.agent/trace/s1.jsonl');
        const lines = write[1].content.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[1]).kind).toBe('not_found');
        expect(invoke.mock.calls.some(c => c[0] === 'create_dir')).toBe(true);
    });

    it('flushes automatically once the buffer fills', () => {
        const { invoke, rec } = make({ flushEvery: 2 });
        rec.record({ iteration: 1, tool: 'read_file', args: {}, result: 'ok' });
        expect(invoke).not.toHaveBeenCalled();
        rec.record({ iteration: 2, tool: 'read_file', args: {}, result: 'ok' });
        expect(invoke).toHaveBeenCalled();
    });

    it('never throws when the write fails — a trace must not take a task down', async () => {
        const invoke = vi.fn(async (cmd) => { if (cmd === 'write_file') throw new Error('disk full'); });
        const rec = new TraceRecorder({ workspacePath: 'C:/ws', sessionId: 's1', invoke });
        rec.record({ iteration: 1, tool: 'read_file', args: {}, result: 'ok' });
        await expect(rec.flush()).resolves.toBe(false);
    });

    it('skips the write when nothing changed since the last flush', async () => {
        const { invoke, rec } = make();
        rec.record({ iteration: 1, tool: 'read_file', args: {}, result: 'ok' });
        await rec.flush();
        invoke.mockClear();
        await rec.flush();
        expect(invoke).not.toHaveBeenCalled();
    });

    it('exposes the failure summary for the session', () => {
        const { rec } = make();
        rec.record({ iteration: 1, tool: 'write_file', args: { path: 'a.js' }, result: 'Error: anchor does not match', isError: true });
        rec.record({ iteration: 4, tool: 'write_file', args: { path: 'a.js' }, result: 'Success', isError: false });
        const [row] = rec.summary();
        expect(row.costSteps).toBe(3);
    });
});
