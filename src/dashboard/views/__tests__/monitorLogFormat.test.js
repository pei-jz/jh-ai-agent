// monitorLogFormat — the pure HTML formatters for the Monitor 'All Logs' view.
// fmtReview is the 🔎 independent-review card: it must show the reviewer's
// ACTUAL words (why it passed / what to fix), not just the verdict.

import { describe, it, expect } from 'vitest';
import { fmtReview, fmtEfficiency, isChatLog } from '../monitorLogFormat.js';

describe('fmtReview', () => {
    it('shows the verdict with the reason', () => {
        const html = fmtReview({ method: 'REVIEW', response: { verdict: 'pass', reason: 'explicit-verdict' } });
        expect(html).toContain('Review:');
        expect(html).toContain('✅');
        expect(html).toContain('pass');
        expect(html).toContain('explicit-verdict');
    });

    it('renders the reviewer summary line (the actual report words)', () => {
        const html = fmtReview({
            method: 'REVIEW',
            response: {
                verdict: 'pass',
                reason: 'no-blocking-findings',
                summary: '問題なし — レビューアは変更を確認し、ブロッキングな指摘はありませんでした',
            },
        });
        expect(html).toContain('問題なし');
        expect(html).toContain('no-blocking-findings');
    });

    it('falls back to a clipped findings snippet when no summary is present', () => {
        const html = fmtReview({
            method: 'REVIEW',
            response: {
                verdict: 'fail',
                reason: 'blocking-tag-heuristic',
                findings: 'FINDINGS:\n- [BUG] a.js:10 — off-by-one in the loop bound',
            },
        });
        expect(html).toContain('❌');
        expect(html).toContain('[BUG] a.js:10 — off-by-one');
    });

    it('escapes HTML in the reviewer text', () => {
        const html = fmtReview({
            method: 'REVIEW',
            response: { verdict: 'pass', summary: '<script>alert(1)</script> looks fine' },
        });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('shows an unknown verdict with the question icon and no crash', () => {
        const html = fmtReview({ method: 'REVIEW', response: {} });
        expect(html).toContain('❔');
        expect(html).toContain('Review:');
    });
});

describe('fmtEfficiency', () => {
    it('renders the step-reduction chips', () => {
        const html = fmtEfficiency({
            method: 'METRICS',
            response: { steps: 8, prompt_tokens: 118400, completion_tokens: 8100, distinct_files_read: 2, re_reads: 1, re_read_chars_approx: 4000, hint: 'Re-read volume nominal.' },
        });
        expect(html).toContain('Efficiency Report');
        expect(html).toContain('8 steps');
        expect(html).toContain('118.4k');
        expect(html).toContain('2 files read');
        expect(html).toContain('Re-read volume nominal.');
    });
});

describe('isChatLog', () => {
    it('classifies typed cards (TOOL / METRICS / REVIEW) as non-chat', () => {
        expect(isChatLog({ method: 'TOOL' })).toBe(false);
        expect(isChatLog({ method: 'METRICS' })).toBe(false);
        expect(isChatLog({ method: 'REVIEW' })).toBe(false);
        expect(isChatLog({ method: 'POST' })).toBe(true);
    });
});
