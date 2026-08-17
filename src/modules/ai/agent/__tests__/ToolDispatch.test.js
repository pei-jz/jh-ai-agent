// Tests for agent/ToolDispatch.js — pure tool-call dispatch helpers (P3 split).

import { describe, it, expect, vi } from 'vitest';
import {
    executeOneCall, isErrorResult, summarizeForStatus, routeProducedImages,
} from '../ToolDispatch.js';

describe('executeOneCall', () => {
    it('runs the executor and records duration', async () => {
        const executor = { executeTool: vi.fn(async () => 'ok') };
        const { call, result, duration } = await executeOneCall({
            call: { name: 'read_file', args: { path: 'a' } },
            executor,
            onStatus: vi.fn(),
            onConfirm: vi.fn(),
        });
        expect(call.name).toBe('read_file');
        expect(result).toBe('ok');
        expect(duration).toBeGreaterThanOrEqual(0);
        expect(executor.executeTool).toHaveBeenCalledTimes(1);
    });
});

describe('isErrorResult', () => {
    it('detects "Error" prefixed strings only', () => {
        expect(isErrorResult('Error: boom')).toBe(true);
        expect(isErrorResult('ok')).toBe(false);
        expect(isErrorResult(42)).toBe(false);
        expect(isErrorResult(null)).toBe(false);
    });
});

describe('summarizeForStatus', () => {
    it('truncates long strings and passes short/objects through', () => {
        expect(summarizeForStatus('x'.repeat(500))).toBe('x'.repeat(300) + '...');
        expect(summarizeForStatus('short')).toBe('short');
        expect(summarizeForStatus({ a: 1 })).toEqual({ a: 1 });
    });
});

describe('routeProducedImages', () => {
    it('attaches when the model supports vision', () => {
        const r = routeProducedImages({ producedImages: [{ data: 'x' }], activeModel: 'm', modelSupportsVision: () => true });
        expect(r.attached).toBe(true);
        expect(r.notice).toBe('');
    });

    it('drops with a notice when vision is unsupported', () => {
        const r = routeProducedImages({ producedImages: [{ data: 'x' }], activeModel: 'm', modelSupportsVision: () => false });
        expect(r.attached).toBe(false);
        expect(r.notice).toContain('no vision support');
    });

    it('no-op with no images', () => {
        const r = routeProducedImages({ producedImages: [], activeModel: 'm', modelSupportsVision: () => true });
        expect(r.attached).toBe(false);
        expect(r.notice).toBe('');
    });
});
