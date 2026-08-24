// taskCaller — the caller-name classification that gates the OS completion toast.
//
// The notification gate must suppress the toast for external tools (JHEditor /
// JHER / …) but keep it for JHAI's own interactive tasks. This pins that split
// against the INTERACTIVE_CALLERS list the agent loop already uses.

import { describe, it, expect } from 'vitest';
import { INTERACTIVE_CALLERS, isExternalCaller } from '../taskCaller.js';

describe('isExternalCaller', () => {
    it('treats every JHAI interactive caller as internal', () => {
        for (const caller of INTERACTIVE_CALLERS) {
            expect(isExternalCaller(caller)).toBe(false);
        }
    });

    it('treats external tools as external', () => {
        expect(isExternalCaller('JHEditor')).toBe(true);
        expect(isExternalCaller('JHER')).toBe(true);
        expect(isExternalCaller('JHProjectManager')).toBe(true);
        expect(isExternalCaller('JH Task Manager')).toBe(true);
    });

    it('treats a missing caller as internal (fail-safe: keep notifying)', () => {
        expect(isExternalCaller(null)).toBe(false);
        expect(isExternalCaller(undefined)).toBe(false);
        expect(isExternalCaller('')).toBe(false);
    });
});
