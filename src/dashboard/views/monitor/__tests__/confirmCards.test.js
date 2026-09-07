// @vitest-environment jsdom
//
// Tests for monitor/confirmCards.js — approval-card markup + auto-approve
// helpers extracted from MonitorView.js (P4 split). jsdom is required because
// the auto-approve helpers read/write localStorage.

import { describe, it, expect, beforeEach } from 'vitest';
import { t } from '../../../../i18n/index.js';
import { fmtConfirm, renderSimpleDiff, isWsAutoApprove, setWsAutoApprove, normWsPath, readAutoApproveWorkspaces, writeAutoApproveWorkspaces, resolvedConfirmIds, fmtConfirmResolved, fmtConfirmStale } from '../confirmCards.js';

beforeEach(() => {
    try { localStorage.clear(); } catch (_) {}
});

describe('fmtConfirm', () => {
    it('renders a command_confirm card with approve/reject buttons', () => {
        const html = fmtConfirm({
            confirmId: 'c1', type: 'command_confirm',
            message: 'run this?', command: 'npm test', allowAlways: true,
        }, 'confirm');
        expect(html).toContain('data-confirm-card="c1"');
        expect(html).toContain('id="confirm-c1"');
        expect(html).toContain('npm test');
        expect(html).toContain('btn-approve');
        expect(html).toContain('btn-reject');
        expect(html).toContain('btn-approve-always');
    });

    it('marks dangerous commands and omits always-allow', () => {
        const html = fmtConfirm({
            confirmId: 'c2', type: 'command_confirm', risk: 'dangerous',
            message: 'm', command: 'rm -rf /', allowAlways: false,
        }, 'confirm');
        expect(html).toContain(t('confirm.danger'));
        expect(html).not.toContain('btn-approve-always');
    });

    it('adds the auto-approve checkbox when a workspace is provided and not dangerous', () => {
        const html = fmtConfirm({
            confirmId: 'c3', type: 'command_confirm', message: 'm', command: 'dir',
            risk: 'normal', allowAlways: false,
        }, 'confirm', true, 'C:/work');
        expect(html).toContain('cb-autows');
        expect(html).toContain('checked');
    });

    // Every approval-gated tool sends type:'command_confirm', so a write_xlsx
    // looks like a command from here. Only run_command carries `risk`, and only
    // run_command consults the auto-approve list — the write tools always ask.
    // Offering the checkbox on their cards promised something nothing honours:
    // the next write asked again, which reads as the run being stuck.
    it('does NOT offer to auto-approve on a card that is not a terminal command', () => {
        const html = fmtConfirm({
            confirmId: 'c4', type: 'command_confirm', message: 'm',
            command: 'write_xlsx C:/work/a.xlsx',
        }, 'confirm', false, 'C:/work');
        expect(html).not.toContain('cb-autows');
        expect(html).not.toContain('acm-open');
        // It is still an approval, with the same buttons.
        expect(html).toContain('btn-approve');
        expect(html).toContain('btn-reject');
    });

    it('renders a diff_review card with the diff', () => {
        const html = fmtConfirm({
            confirmId: 'c4', type: 'diff_review', path: 'a.txt',
            oldContent: 'old\n', newContent: 'new\n',
        }, 'confirm');
        expect(html).toContain(t('confirm.diff'));
        expect(html).toContain('- old');
        expect(html).toContain('+ new');
    });
});

describe('renderSimpleDiff', () => {
    it('shows unchanged, removed and added lines', () => {
        const html = renderSimpleDiff('a\nb\n', 'a\nc\n');
        expect(html).toContain('  a');
        expect(html).toContain('- b');
        expect(html).toContain('+ c');
    });

    it('escapes HTML in the diff', () => {
        const html = renderSimpleDiff('<script>', '');
        expect(html).toContain('&lt;script&gt;');
    });

    it('handles empty inputs', () => {
        expect(renderSimpleDiff('', '')).toContain('</div>');
    });
});

describe('auto-approve workspaces (localStorage)', () => {
    it('normalizes path separators and trailing slashes', () => {
        expect(normWsPath('C:\\work\\proj\\')).toBe('C:/work/proj');
    });

    it('round-trips set → is', () => {
        expect(isWsAutoApprove('C:/work')).toBe(false);
        setWsAutoApprove('C:/work', true);
        expect(isWsAutoApprove('C:/work')).toBe(true);
        // Separator-tolerant read
        expect(isWsAutoApprove('C:\\work')).toBe(true);
        // Remove
        setWsAutoApprove('C:/work', false);
        expect(isWsAutoApprove('C:/work')).toBe(false);
    });

    it('survives corrupt storage', () => {
        try { localStorage.setItem('jhai_autoapprove_workspaces', 'not-json'); } catch (_) {}
        expect(readAutoApproveWorkspaces()).toEqual([]);
        writeAutoApproveWorkspaces(['a']);
        expect(readAutoApproveWorkspaces()).toEqual(['a']);
    });
});

// Reported symptom: an approval the user had already granted came back as a
// live, clickable card every time the task was opened in the Raw Log — and
// clicking it did nothing, because the bridge had long since dropped that
// confirmId. Meanwhile the run it belonged to was away doing the work, so the
// UI showed a question for something already in progress.
describe('resolvedConfirmIds', () => {
    const req = (id) => ({ event: 'confirm_request', data: { confirmId: id, command: 'npm test' } });
    const res = (id, approved) => ({ event: 'confirm_resolved', data: { confirmId: id, approved } });
    const work = () => ({ event: 'log', data: { method: 'TOOL', name: 'run_command', status: 200 } });

    it('treats an explicitly resolved approval as settled', () => {
        expect([...resolvedConfirmIds([req('c1'), res('c1', true)])]).toEqual(['c1']);
    });

    // The case the old heuristic could never get right: a denial that ends the
    // run has no work after it, so "was there later activity?" said "still
    // pending" forever.
    it('settles a DENIAL even though no work follows it', () => {
        expect([...resolvedConfirmIds([req('c1'), res('c1', false)])]).toEqual(['c1']);
    });

    it('falls back to later activity for logs written before the event existed', () => {
        expect([...resolvedConfirmIds([req('c1'), work()])]).toEqual(['c1']);
    });

    it('leaves a genuinely open approval open', () => {
        expect([...resolvedConfirmIds([req('c1')])]).toEqual([]);
    });

    it('settles every earlier request — only the last one can still be open', () => {
        const ids = resolvedConfirmIds([req('c1'), req('c2')]);
        expect(ids.has('c1')).toBe(true);
        expect(ids.has('c2')).toBe(false);
    });

    it('survives junk', () => {
        expect([...resolvedConfirmIds(null)]).toEqual([]);
        expect([...resolvedConfirmIds([{}, { event: 'confirm_request' }])]).toEqual([]);
    });
});

describe('fmtConfirmResolved', () => {
    it('renders history with nothing left to click', () => {
        const html = fmtConfirmResolved({ command: 'npm run build' }, true);
        expect(html).toContain('npm run build');
        expect(html).not.toContain('<button');
        expect(html).not.toContain('data-confirm-id');
    });

    it('distinguishes an approval from a refusal', () => {
        expect(fmtConfirmResolved({ command: 'x' }, true)).toContain('✅');
        expect(fmtConfirmResolved({ command: 'x' }, false)).toContain('🚫');
    });

    it('escapes the command it shows', () => {
        expect(fmtConfirmResolved({ command: '<img src=x onerror=1>' }, true)).not.toContain('<img');
    });
});

describe('an answered approval is known to be answered', () => {
    const req = (id) => ({ event: 'confirm_request', data: { confirmId: id } });
    const res = (id, approved = true) => ({ event: 'confirm_resolved', data: { confirmId: id, approved } });

    // The record is authoritative — which is why dropping it from the stored
    // log (as the client used to) made every re-opened task offer buttons for
    // questions that had already been settled.
    it('reads the resolution record when it is there', () => {
        expect(resolvedConfirmIds([req('c1'), res('c1')]).has('c1')).toBe(true);
    });

    it('leaves a genuinely open one open', () => {
        expect(resolvedConfirmIds([req('c1')]).has('c1')).toBe(false);
    });

    // Older logs have no record; work happening afterwards is the only signal.
    it('falls back to "work happened after it" for logs without the record', () => {
        const done = resolvedConfirmIds([req('c1'), { event: 'tool_call', data: {} }]);
        expect(done.has('c1')).toBe(true);
    });

    it('treats every earlier request as settled by definition', () => {
        const done = resolvedConfirmIds([req('c1'), req('c2')]);
        expect(done.has('c1')).toBe(true);
        expect(done.has('c2'), 'only the last can still be open').toBe(false);
    });
});

describe('an approval nobody can answer any more', () => {
    // A button that does nothing is worse than no button: the next thing a
    // person tries is clicking it again.
    it('renders without buttons, and says why', () => {
        const html = fmtConfirmStale({ command: 'npm test' }, 'この実行はもう動いていません。');
        expect(html).not.toContain('<button');
        expect(html).toContain('npm test');
        expect(html).toContain('もう動いていません');
    });

    it('escapes what it shows', () => {
        const html = fmtConfirmStale({ command: '<img src=x onerror=1>' }, 'x');
        expect(html).not.toContain('<img');
    });
});
