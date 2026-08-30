// The channel an async failure takes to reach a person.
//
// There was none: no `unhandledrejection`, no `window.onerror`, and no devtools
// in a release build — so a rejected promise inside an effect or a socket
// handler vanished, leaving a blank panel and no explanation.
//
// What is pinned here is what makes it USABLE rather than merely present: a
// failing loop must not bury everything else in toasts, and a broken toast or a
// failing log write must not become a second failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { report, install, describeError, recentErrors, _reset } from '../errorReporter.js';

beforeEach(() => { _reset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('describeError', () => {
    it('keeps the stack of a real Error — that is the part a report needs', () => {
        const e = new Error('boom');
        expect(describeError(e)).toContain('boom');
    });

    // A Tauri command rejects with a plain string; an HTTP layer with an object.
    it('handles the things a rejected promise actually carries', () => {
        expect(describeError('just a string')).toBe('just a string');
        expect(describeError({ status: 500 })).toContain('500');
        expect(describeError(null)).toBe('Unknown error');
        expect(describeError(undefined)).toBe('Unknown error');
    });

    it('does not throw on a circular value', () => {
        const a = {}; a.self = a;
        expect(() => describeError(a)).not.toThrow();
    });
});

describe('report', () => {
    it('toasts the first line and logs the whole thing', () => {
        const toast = vi.fn();
        const write = vi.fn();
        report(new Error('first line\nsecond line'), 'test', { toast, write });
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('first line'));
        expect(toast.mock.calls[0][0]).not.toContain('second line');
        expect(write.mock.calls[0][0].text).toContain('second line');
    });

    // A failing interval raises the same error many times a second. Reporting
    // each one buries everything else that happened.
    it('suppresses an identical error inside the dedupe window', () => {
        const toast = vi.fn();
        let t = 1000;
        const now = () => t;
        expect(report('same', 'test', { toast, now })).toBe(true);
        t = 1500;
        expect(report('same', 'test', { toast, now })).toBe(false);
        expect(toast).toHaveBeenCalledTimes(1);
    });

    it('reports it again once the window has passed', () => {
        let t = 1000;
        const now = () => t;
        report('same', 'test', { now });
        t = 9000;
        expect(report('same', 'test', { now })).toBe(true);
    });

    it('does not suppress a DIFFERENT error that arrives immediately after', () => {
        const toast = vi.fn();
        report('one', 'test', { toast });
        report('two', 'test', { toast });
        expect(toast).toHaveBeenCalledTimes(2);
    });

    // The console entry is the one output that cannot itself fail, so a broken
    // toast or a failing write must not take the whole report down with it.
    it('survives a toast that throws', () => {
        const write = vi.fn();
        expect(() => report('x', 'test', {
            toast: () => { throw new Error('toast is broken'); }, write,
        })).not.toThrow();
        expect(write).toHaveBeenCalled();
    });

    it('survives a log write that throws', () => {
        expect(() => report('x', 'test', {
            write: () => { throw new Error('disk full'); },
        })).not.toThrow();
    });

    it('keeps a ring for the diagnostics copy', () => {
        for (let i = 0; i < 5; i++) report(`e${i}`, 'test');
        expect(recentErrors().map(e => e.text)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    });

    it('caps the ring rather than growing without bound', () => {
        for (let i = 0; i < 80; i++) report(`e${i}`, 'test');
        expect(recentErrors().length).toBeLessThanOrEqual(50);
        expect(recentErrors().at(-1).text).toBe('e79');
    });
});

describe('install', () => {
    const fakeTarget = () => {
        const handlers = {};
        return {
            handlers,
            addEventListener: (k, fn) => { (handlers[k] ||= []).push(fn); },
            removeEventListener: (k, fn) => { handlers[k] = (handlers[k] || []).filter(f => f !== fn); },
        };
    };

    it('catches an unhandled rejection', () => {
        const toast = vi.fn();
        const target = fakeTarget();
        install({ target, toast });
        target.handlers.unhandledrejection[0]({ reason: new Error('async boom') });
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('async boom'));
    });

    it('catches a window error', () => {
        const toast = vi.fn();
        const target = fakeTarget();
        install({ target, toast });
        target.handlers.error[0]({ error: new Error('sync boom') });
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('sync boom'));
    });

    // main.js is the spotlight window's bundle too, so it can run twice.
    it('is idempotent — two installs must not double every report', () => {
        const target = fakeTarget();
        install({ target });
        install({ target });
        expect(target.handlers.unhandledrejection).toHaveLength(1);
    });

    it('detaches', () => {
        const target = fakeTarget();
        const off = install({ target });
        off();
        expect(target.handlers.unhandledrejection).toHaveLength(0);
    });
});
