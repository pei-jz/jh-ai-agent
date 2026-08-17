// @vitest-environment jsdom
//
// Tests for monitor/confirmCards.js — approval-card markup + auto-approve
// helpers extracted from MonitorView.js (P4 split). jsdom is required because
// the auto-approve helpers read/write localStorage.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    fmtConfirm, renderSimpleDiff, isWsAutoApprove, setWsAutoApprove,
    normWsPath, readAutoApproveWorkspaces, writeAutoApproveWorkspaces,
} from '../confirmCards.js';

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
        expect(html).toContain('Dangerous command');
        expect(html).not.toContain('btn-approve-always');
    });

    it('adds the auto-approve checkbox when a workspace is provided and not dangerous', () => {
        const html = fmtConfirm({
            confirmId: 'c3', type: 'command_confirm', message: 'm', command: 'dir',
            allowAlways: false,
        }, 'confirm', true, 'C:/work');
        expect(html).toContain('cb-autows');
        expect(html).toContain('checked');
    });

    it('renders a diff_review card with the diff', () => {
        const html = fmtConfirm({
            confirmId: 'c4', type: 'diff_review', path: 'a.txt',
            oldContent: 'old\n', newContent: 'new\n',
        }, 'confirm');
        expect(html).toContain('File Modification');
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
