// updateState — the rules an updater must not get wrong.
//
// The mechanism (signature verification, install) belongs to the plugin. What is tested
// here is the REPORTING, because the failure modes are silent: claiming "up to date"
// after a check that never completed, or offering an update with no version.

import { describe as suite, it, expect } from 'vitest';
import { describe as describe_ } from '../updateState.js';
import {
    PUBKEY_PLACEHOLDER, initialUpdateState, isRealUpdate, describe,
    progressPercent, shouldCheckOnLaunch,
} from '../updateState.js';

suite('initialUpdateState', () => {
    it('starts silent', () => {
        const s = initialUpdateState();
        expect(s.phase).toBe('idle');
        expect(describe(s).title).toBe('');
    });
});

suite('isRealUpdate', () => {
    const cases = [
        ['a newer version', { available: true, version: '0.2.0' }, true],
        ['not newer', { available: false, version: '0.2.0' }, false],
        ['available but unnamed', { available: true, version: '' }, false],
        ['available with a blank version', { available: true, version: '   ' }, false],
        ['no version field', { available: true }, false],
        ['null', null, false],
        ['undefined', undefined, false],
    ];
    for (const [name, result, expected] of cases) {
        it(`${name} -> ${expected}`, () => {
            expect(isRealUpdate(result)).toBe(expected);
        });
    }
});

suite('describe', () => {
    it('never reports a failed check as up to date', () => {
        const failed = describe({ phase: 'failed', error: 'network unreachable' });
        expect(failed.title).not.toContain('最新');
        expect(failed.title).toContain('確認できませんでした');
        // The reason is shown: "it didn't work" with no cause is unactionable.
        expect(failed.detail).toContain('network unreachable');
    });

    it('explains a failure with no error text', () => {
        expect(describe({ phase: 'failed' }).detail).toBeTruthy();
    });

    it('distinguishes unconfigured from failed', () => {
        const unconf = describe({ phase: 'unconfigured' });
        expect(unconf.title).not.toContain('確認できませんでした');
        expect(unconf.title).toContain('設定されていません');
    });

    it('names the version it is offering', () => {
        expect(describe({ phase: 'available', version: '1.4.0' }).title).toContain('1.4.0');
    });

    it('passes release notes through as the detail', () => {
        expect(describe({ phase: 'available', version: '1.0.1', notes: 'Fixed X' }).detail)
            .toBe('Fixed X');
    });

    it('marks only the in-flight phases busy', () => {
        expect(describe({ phase: 'checking' }).busy).toBe(true);
        expect(describe({ phase: 'downloading', progress: 10 }).busy).toBe(true);
        expect(describe({ phase: 'available' }).busy).toBe(false);
        expect(describe({ phase: 'ready' }).busy).toBe(false);
        expect(describe({ phase: 'current' }).busy).toBe(false);
    });

    it('shows progress while downloading', () => {
        expect(describe({ phase: 'downloading', progress: 42 }).title).toContain('42');
    });

    it('says nothing for an unknown or missing phase', () => {
        expect(describe({ phase: 'nonsense' }).title).toBe('');
        expect(describe(null).title).toBe('');
        expect(describe(undefined).title).toBe('');
    });
});

suite('progressPercent', () => {
    const cases = [
        ['half', 50, 100, 50],
        ['none', 0, 100, 0],
        ['all', 100, 100, 100],
        ['rounds', 1, 3, 33],
        // An unknown content length must not become NaN% or Infinity%.
        ['unknown total', 500, 0, 0],
        ['negative total', 500, -1, 0],
        ['overshoot clamps', 200, 100, 100],
        ['negative downloaded clamps', -50, 100, 0],
        ['garbage inputs', null, undefined, 0],
    ];
    for (const [name, d, t, expected] of cases) {
        it(`${name} -> ${expected}`, () => {
            expect(progressPercent(d, t)).toBe(expected);
        });
    }

    it('is always an integer', () => {
        expect(Number.isInteger(progressPercent(7, 9))).toBe(true);
    });
});

suite('shouldCheckOnLaunch', () => {
    const KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6bWluaXNpZ24=';

    it('checks when signed and not opted out', () => {
        expect(shouldCheckOnLaunch({ pubkey: KEY, optedOut: false })).toBe(true);
    });

    it('respects the opt-out even on a signed build', () => {
        // The check is a request to a third-party host, so the user's "no" wins.
        expect(shouldCheckOnLaunch({ pubkey: KEY, optedOut: true })).toBe(false);
    });

    it('does not call out for an unsigned build', () => {
        expect(shouldCheckOnLaunch({ pubkey: '', optedOut: false })).toBe(false);
    });

    it('treats the committed placeholder as unsigned', () => {
        // This is what is in the repo until a real key is generated; accepting it
        // would have the app claim it can verify updates when it cannot.
        expect(shouldCheckOnLaunch({ pubkey: PUBKEY_PLACEHOLDER, optedOut: false })).toBe(false);
    });

    it('defaults to not checking when asked with nothing', () => {
        expect(shouldCheckOnLaunch()).toBe(false);
        expect(shouldCheckOnLaunch({})).toBe(false);
    });

    // The portable build is unzipped wherever the user likes. The updater runs
    // the downloaded installer with /UPDATE and no /D, so it writes to the
    // REGISTERED install directory: the download succeeds, the signature
    // verifies, the new version lands somewhere else, and this copy relaunches
    // unchanged. There is no way to notice that afterwards, so it is never
    // started.
    it('does not check from a portable copy, however well signed', () => {
        expect(shouldCheckOnLaunch({ pubkey: KEY, optedOut: false, installed: false })).toBe(false);
    });

    it('checks from the installed copy', () => {
        expect(shouldCheckOnLaunch({ pubkey: KEY, optedOut: false, installed: true })).toBe(true);
    });

    // The gate exists to suppress an impossible update, not to suppress updates
    // whenever the question cannot be answered — an older build, or a harness
    // with no Tauri command, must not silently stop receiving them.
    it('assumes installed when nobody says otherwise', () => {
        expect(shouldCheckOnLaunch({ pubkey: KEY })).toBe(true);
        expect(shouldCheckOnLaunch({ pubkey: KEY, installed: undefined })).toBe(true);
    });
});

describe('what a portable copy is told', () => {
    it('says updates do not reach it, and where to get the new version', () => {
        const d = describe_({ phase: 'portable' });
        expect(d.title).toBeTruthy();
        expect(d.detail).toBeTruthy();
        expect(d.busy).toBe(false);
    });

    it('is not reported as a failure', () => {
        // "Failed" would send the user looking for a network problem that does
        // not exist.
        expect(describe_({ phase: 'portable' }).title)
            .not.toBe(describe_({ phase: 'failed' }).title);
    });
});
