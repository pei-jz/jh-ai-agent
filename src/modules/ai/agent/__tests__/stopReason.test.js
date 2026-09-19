// stopReason — a run cut short must say so, and say how to carry on.
import { describe as suite, it, expect } from 'vitest';
import {
    stopReason, stopStatusMessage, stopNotice, wasInterrupted, stopLogEntry,
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

suite('a sub-agent stops against a different setting', () => {
    // The bug: a child capped at 20 steps told the user to raise
    // Settings → Max Agent Steps. That field is the PARENT's step ceiling and
    // changing it does nothing to a sub-agent — so the one actionable sentence
    // in the notice sent the reader to the wrong box.
    it('names the sub-agent cap, not the run-wide one', () => {
        const notice = stopNotice(stopReason('step_limit', { limit: 20 }), { subagent: true });
        expect(notice).toContain('Max Sub-agent Steps');
        expect(notice).not.toContain('Max Agent Steps');
    });

    it('does not offer to resume a child that cannot be messaged', () => {
        // A sub-agent is one tool call inside its parent's run: there is no task
        // to send a message to.
        const notice = stopNotice(stopReason('step_limit', { limit: 20 }), { subagent: true });
        expect(notice).not.toContain('このタスクにメッセージ');
        expect(notice).toContain('サブタスク');
    });

    it('still points a child at the PARENT setting for budget and time', () => {
        // Those two really are the parent's: the child spends a slice of the
        // parent's tokens and runs inside its wall clock.
        expect(stopNotice(stopReason('token_budget', { limit: 5 }), { subagent: true }))
            .toContain('Token Budget');
        expect(stopNotice(stopReason('wall_clock', { limit: 5 }), { subagent: true }))
            .toContain('Wall-clock Timeout');
    });

    it('leaves the ordinary run untouched', () => {
        expect(stopNotice(stopReason('step_limit', { limit: 300 })))
            .toContain('Max Agent Steps');
    });
});

suite('stopLogEntry', () => {
    // A limit used to exist only as a live status line: not in the Raw Log, and
    // for a sub-agent not anywhere at all (its status feed is not forwarded).
    it('is its own kind of entry, so the log does not read it as an LLM call', () => {
        expect(stopLogEntry(stopReason('step_limit', { limit: 20, used: 20 })).method).toBe('LIMIT');
    });

    it('records which limit, how far it got, and where to change it', () => {
        const entry = stopLogEntry(stopReason('step_limit', { limit: 20, used: 20 }), {
            subagent: true,
        });
        expect(entry.response).toMatchObject({ kind: 'step_limit', limit: 20, used: 20, scope: 'subagent' });
        expect(entry.response.setting).toContain('Max Sub-agent Steps');
        expect(entry.response.message).toBeTruthy();
    });

    it('falls back to the run\'s step count when the reason carries no usage', () => {
        const entry = stopLogEntry(stopReason('wall_clock', { limit: 30 }), { iterations: 12 });
        expect(entry.response.used).toBe(12);
        expect(entry.response.scope).toBe('run');
    });

    it('is null for a normal finish', () => {
        expect(stopLogEntry(null)).toBe(null);
    });
});
