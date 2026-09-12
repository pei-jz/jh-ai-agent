// Unit tests for the plan-first approval wording + revision detection.
//
// planApprovalQuestion() builds the ask_user question/options in the UI display
// language; isPlanRevision() tells whether a continuation/steering text is a
// plan-revision request (the user picked the ✏️ "Request changes" option).

import { describe, it, expect, afterEach } from 'vitest';
import { planApprovalQuestion, isPlanRevision, isPlanApproval, stripPlanRevisionMarker } from '../agent/PlanFirstApproval.js';
import { __setLocaleForTest } from '../../../i18n/index.js';

afterEach(() => __setLocaleForTest('ja'));

describe('planApprovalQuestion', () => {
    it('renders Japanese by default', () => {
        __setLocaleForTest('ja');
        const q = planApprovalQuestion();
        expect(q.question).toContain('この計画');
        expect(q.options).toHaveLength(2);
        // The revise option carries the ✏️ marker the UI keys off.
        expect(q.options[1]).toContain('✏️');
        expect(q.options[0]).not.toContain('✏️');
    });

    it('renders English when the UI locale is en', () => {
        __setLocaleForTest('en');
        const q = planApprovalQuestion();
        expect(q.question).toContain('this plan');
        expect(q.options[1]).toContain('✏️');
    });
});

describe('isPlanRevision', () => {
    it('detects the ✏️ marker in a revision reply', () => {
        expect(isPlanRevision('✏️ 計画修正: 変更対象ファイルを絞って')).toBe(true);
        expect(isPlanRevision('✏️ Request changes: narrow the files')).toBe(true);
    });

    it('detects a Japanese plan-revision phrase', () => {
        expect(isPlanRevision('計画を修正してください')).toBe(true);
        expect(isPlanRevision('プラン修正して')).toBe(true);
    });

    it('detects an English plan-revision phrase', () => {
        expect(isPlanRevision('Please revise the plan')).toBe(true);
        expect(isPlanRevision('I request changes to the approach')).toBe(true);
    });

    it('does NOT flag an approval reply', () => {
        expect(isPlanRevision('はい、実装して')).toBe(false);
        expect(isPlanRevision('Yes, proceed')).toBe(false);
        expect(isPlanRevision('')).toBe(false);
    });

    it('does NOT flag ordinary continuation text', () => {
        expect(isPlanRevision('続けてください')).toBe(false);
        expect(isPlanRevision('please continue')).toBe(false);
    });
});

// The phase router asks this to tell an approval turn (which already has its
// plan) from every other continuation (which does not, and must be judged on its
// own request). A false positive here silently demotes real work to the fast
// model, so the bar is the button text or a bare yes - not any sentence with
// "進めて" somewhere in it.
describe('isPlanApproval', () => {
    it('accepts the approval option in both languages', () => {
        expect(isPlanApproval('はい、この計画で進めてください')).toBe(true);
        expect(isPlanApproval('Yes, proceed with this plan')).toBe(true);
    });

    it('accepts a bare approval', () => {
        expect(isPlanApproval('はい、進めて')).toBe(true);
        expect(isPlanApproval('承認')).toBe(true);
    });

    it('rejects a revision request, which re-opens the gate instead', () => {
        expect(isPlanApproval('✏️ 計画修正: 対象を絞って')).toBe(false);
    });

    it('rejects a NEW request that merely sounds agreeable', () => {
        expect(isPlanApproval('ログ出力を直してから進めてください。そのあと CI も直して、テストを全部通してください')).toBe(false);
        expect(isPlanApproval('')).toBe(false);
    });
});
