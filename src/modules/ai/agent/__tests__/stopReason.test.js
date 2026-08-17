// stopReason — a run cut short must say so, and say how to carry on.
import { describe as suite, it, expect } from 'vitest';
import {
    stopReason, stopStatusMessage, stopNotice, wasInterrupted,
} from '../stopReason.js';
import { setLocale } from '../../../../i18n/index.js';

const KINDS = ['step_limit', 'token_budget', 'wall_clock'];

suite('stopReason', () => {
    it('records the limit that was hit', () => {
        const r = stopReason('step_limit', { limit: 300, used: 300 });
        expect(r).toEqual({ kind: 'step_limit', limit: 300, used: 300 });
    });

    it('tolerates missing facts', () => {
        expect(stopReason('wall_clock')).toEqual({ kind: 'wall_clock', limit: null, used: null });
    });

    it('keeps a zero limit rather than nulling it', () => {
        // `?? null` not `|| null`: 0 is a real configured value.
        expect(stopReason('step_limit', { limit: 0, used: 0 }).limit).toBe(0);
    });
});

suite('wasInterrupted', () => {
    it('is true for every limit', () => {
        for (const kind of KINDS) expect(wasInterrupted(stopReason(kind))).toBe(true);
    });

    it('is false for a normal finish', () => {
        // A completed run has no stopReason at all.
        expect(wasInterrupted(null)).toBe(false);
        expect(wasInterrupted(undefined)).toBe(false);
        expect(wasInterrupted({ kind: 'finish_task' })).toBe(false);
    });
});

suite('stopStatusMessage', () => {
    it('names the limit in the live feed', () => {
        expect(stopStatusMessage(stopReason('step_limit', { limit: 300 }))).toContain('300');
        expect(stopStatusMessage(stopReason('token_budget', { limit: 1000000 })))
            .toContain('1,000,000');
        expect(stopStatusMessage(stopReason('wall_clock', { limit: 30 }))).toContain('30');
    });

    it('says something for every kind', () => {
        for (const kind of KINDS) {
            expect(stopStatusMessage(stopReason(kind, { limit: 1 })).length).toBeGreaterThan(0);
        }
    });

    it('is empty for a normal finish or an unknown kind', () => {
        expect(stopStatusMessage(null)).toBe('');
        expect(stopStatusMessage({ kind: 'finish_task' })).toBe('');
    });
});

suite('stopNotice', () => {
    it('says the run is INCOMPLETE for every limit', () => {
        // The defect this replaced: a capped run reported as a normal completion, so
        // the user saw work stop with no stated reason.
        for (const kind of KINDS) {
            expect(stopNotice(stopReason(kind, { limit: 10 })), kind).toContain('未完了');
        }
    });

    it('always tells the user how to resume', () => {
        // Without this the honest reading of "停止しました" is "start over", which
        // would throw away work that is intact.
        for (const kind of KINDS) {
            expect(stopNotice(stopReason(kind, { limit: 10 })), kind).toContain('続行');
        }
    });

    it('names the exact setting to change', () => {
        expect(stopNotice(stopReason('step_limit', { limit: 300 })))
            .toContain('Max Agent Steps');
        expect(stopNotice(stopReason('token_budget', { limit: 5 })))
            .toContain('Token Budget');
        expect(stopNotice(stopReason('wall_clock', { limit: 5 })))
            .toContain('Wall-clock Timeout');
    });

    it('does not blame the agent or call it a failure', () => {
        const notice = stopNotice(stopReason('step_limit', { limit: 300 }));
        expect(notice).toContain('失敗したわけではありません');
    });

    it('formats large numbers readably', () => {
        expect(stopNotice(stopReason('token_budget', { limit: 2500000 })))
            .toContain('2,500,000');
    });

    it('is empty for a normal finish', () => {
        expect(stopNotice(null)).toBe('');
        expect(stopNotice({ kind: 'finish_task' })).toBe('');
    });
});

// These strings were hard-coded Japanese, which made the agent's explanation of
// why it stopped the largest untranslatable surface in the app: an English UI
// relabelled the buttons and still said 未完了のまま停止しました.
suite('stopReason — follows the UI language', () => {
    it('speaks English when the UI is English', () => {
        setLocale('en');
        try {
            const r = stopReason('step_limit', { limit: 300 });
            expect(stopStatusMessage(r)).toContain('Step limit');
            expect(stopNotice(r)).toContain('Stopped before finishing');
            expect(stopNotice(r)).toContain('Send a message to this task');
        } finally {
            setLocale('ja');
        }
    });

    it('speaks Japanese when the UI is Japanese', () => {
        setLocale('ja');
        const r = stopReason('wall_clock', { limit: 30 });
        expect(stopStatusMessage(r)).toContain('実行時間の上限');
        expect(stopNotice(r)).toContain('未完了のまま停止しました');
    });

    it('names a setting the user can actually find on screen', () => {
        // The Settings form's field labels are literal English in BOTH locales,
        // so a fully-translated pointer would name a label that is not there.
        for (const loc of ['ja', 'en']) {
            setLocale(loc);
            expect(stopNotice(stopReason('step_limit', { limit: 1 }))).toContain('Max Agent Steps');
            expect(stopNotice(stopReason('token_budget', { limit: 1 }))).toContain('Token Budget');
            expect(stopNotice(stopReason('wall_clock', { limit: 1 }))).toContain('Wall-clock Timeout');
        }
        setLocale('ja');
    });

    it('still carries the limit and the resume hint in every locale', () => {
        for (const loc of ['ja', 'en']) {
            setLocale(loc);
            for (const kind of KINDS) {
                const notice = stopNotice(stopReason(kind, { limit: 1234 }));
                expect(notice, `${loc}/${kind}`).toContain('1,234');
                expect(notice, `${loc}/${kind}`).not.toContain('{');
            }
        }
        setLocale('ja');
    });
});
