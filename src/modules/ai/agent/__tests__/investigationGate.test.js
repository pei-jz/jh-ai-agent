import { describe, it, expect } from 'vitest';
import {
    citationsIn, evidenceCheck, frontierCheck, isInvestigation, buildAuditBrief,
    ANALYSIS_MIN_CHARS, MIN_CITATIONS, MIN_INSPECTIONS,
} from '../InvestigationGate.js';
import { OpenQuestions, renderQuestions, MAX_QUESTIONS } from '../OpenQuestions.js';

// These cover the gap that let a read-only run finish unchecked: the review gate
// is conditioned on changed files, so an investigation reached no gate at all.
// The observed failure was an answer about a screen that never traced the
// backend configuration governing it — delivered fast, and confidently.

// Long enough to clear ANALYSIS_MIN_CHARS with room to spare, so raising that
// threshold does not quietly turn these tests into no-ops.
const long = (extra = '') => 'この画面は入力値を検証してから送信します。'.repeat(60) + extra;
/** A run that actually looked at the codebase. */
const traced = { hasReviewableChanges: false, inspections: MIN_INSPECTIONS };

describe('citationsIn', () => {
    it('finds file references across languages, not just this project’s', () => {
        // The failure being addressed happened on a Java/JSP codebase. A checker
        // that only understood .js would have scored that investigation as
        // well-supported at exactly the point it was weakest.
        const text = 'Rendered by web/order/list.jsp:42, mapped in WEB-INF/web.xml, '
            + 'defaulted from config/app.properties, handled by com/acme/OrderServlet.java:118.';
        expect(citationsIn(text)).toEqual([
            'web/order/list.jsp:42',
            'WEB-INF/web.xml',
            'config/app.properties',
            'com/acme/OrderServlet.java:118',
        ]);
    });

    it('counts configuration files, where backend state actually lives', () => {
        // Asserting the exact value, not just "found something". A length check
        // passed while `web.config` was being returned as `web.conf`: the
        // extension alternation matched a PREFIX, so a real citation came back
        // as a filename that does not exist — and the test could not see it.
        for (const f of ['app.properties', 'settings.yaml', 'pom.xml', 'web.config',
            '.env', 'application.yml', 'config.toml', 'schema.sql', 'Dockerfile.md']) {
            expect(citationsIn(`see ${f} for this`)).toEqual([f]);
        }
    });

    it('never returns a truncated filename', () => {
        // `c`, `conf`, `js` and `m` are all valid extensions and all prefixes of
        // longer ones. Without an explicit end-of-token assertion the shorter
        // alternative wins and the citation silently names the wrong file.
        expect(citationsIn('web.config')).toEqual(['web.config']);
        expect(citationsIn('list.jsp')).toEqual(['list.jsp']);
        expect(citationsIn('app.jsonl')).toEqual([]);      // not a known extension
        expect(citationsIn('main.mjs')).toEqual(['main.mjs']);
    });

    it('de-duplicates repeats but keeps distinct line references', () => {
        const t = 'src/a.js and src/a.js again, plus src/a.js:10';
        expect(citationsIn(t)).toEqual(['src/a.js', 'src/a.js:10']);
    });

    it('does not mistake ordinary prose for a citation', () => {
        expect(citationsIn('The value is set elsewhere. It depends on the mode.')).toEqual([]);
        // A sentence ending in a word that looks like an extension must not count.
        expect(citationsIn('We reviewed the config. Then the code.')).toEqual([]);
    });

    it('reads a reference inside backticks or parentheses', () => {
        expect(citationsIn('see `src/a.js:12`').length).toBe(1);
        expect(citationsIn('(WEB-INF/web.xml)').length).toBe(1);
    });

    it('reads a reference that follows CJK punctuation', () => {
        // Found by the loop test, not by reasoning about it. The pattern used to
        // require one of a LISTED set of delimiters in front of a path, and that
        // list was the punctuation of one language: `…が描画し、WEB-INF/web.xml`
        // did not count, because an ideographic comma was not on it. Reports here
        // are written in Japanese, so the evidence check fired hardest on exactly
        // the well-cited answers it should have passed.
        expect(citationsIn('web/order/list.jsp:42 が描画し、WEB-INF/web.xml:31 で切替'))
            .toEqual(['web/order/list.jsp:42', 'WEB-INF/web.xml:31']);
        expect(citationsIn('設定は（config/app.properties）。次に src/a.js を見る'))
            .toEqual(['config/app.properties', 'src/a.js']);
        expect(citationsIn('起点は「src/main.js」、続いて src/b.js'))
            .toEqual(['src/main.js', 'src/b.js']);
    });

    it('does not treat a URL path as a file the run read', () => {
        // A citation is meant to be something the reader can open in the repo.
        expect(citationsIn('see https://example.com/a.js for more')).toEqual([]);
    });
});

describe('evidenceCheck', () => {
    it('asks for sources when a long answer cites none', () => {
        const r = evidenceCheck(long());
        expect(r.needed).toBe(true);
        expect(r.reason).toBe('uncited');
    });

    it('accepts an answer that shows where it looked', () => {
        const r = evidenceCheck(long(' 詳細は src/a.js:10 と WEB-INF/web.xml。'));
        expect(r.needed).toBe(false);
        expect(r.citations).toHaveLength(2);
    });

    it('still asks when the citations are too thin to support the length', () => {
        const r = evidenceCheck(long(' src/only.js を参照。'));
        expect(r.needed).toBe(true);
        expect(r.reason).toBe('thin');
        expect(MIN_CITATIONS).toBeGreaterThan(1);
    });

    it('leaves short answers alone', () => {
        // "The file is at src/x.js" is a complete answer to some questions, and
        // demanding a bibliography for it would just add a round trip.
        const r = evidenceCheck('設定は config/app.properties にあります。');
        expect(r.needed).toBe(false);
        expect(r.reason).toBe('too-short-to-judge');
    });
});

describe('frontierCheck', () => {
    const open = [{ id: 'q1', question: 'where is featureFlag set?', status: 'open', why: '' }];

    it('flags a run walking away from a question it raised itself', () => {
        const r = frontierCheck(open, long());
        expect(r.needed).toBe(true);
        expect(r.reason).toBe('dropped-silently');
    });

    it('accepts an answer that declares what it could not verify', () => {
        // Declaring is as good as resolving — the failure is silence, not
        // incompleteness. An investigation is allowed to have limits.
        for (const marker of ['未確認です', 'could not verify this', 'Open question:', 'unverified']) {
            expect(frontierCheck(open, long(` ${marker}`)).needed).toBe(false);
        }
    });

    it('is quiet when the frontier is empty', () => {
        expect(frontierCheck([], long()).needed).toBe(false);
        expect(frontierCheck([{ id: 'q1', status: 'resolved' }], long()).needed).toBe(false);
    });
});

describe('isInvestigation', () => {
    it('never fires on a run that changed code — that one gets the reviewer', () => {
        // The two gates are complements on purpose: a run either changed code
        // (reviewer) or it did not (auditor). Nothing may reach both or neither.
        expect(isInvestigation({ ...traced, hasReviewableChanges: true, deliverable: long() })).toBe(false);
        expect(isInvestigation({ ...traced, deliverable: long() })).toBe(true);
    });

    it('ignores a run that produced no analysis to audit', () => {
        expect(isInvestigation({ ...traced, deliverable: 'done' })).toBe(false);
        expect(isInvestigation({ ...traced, deliverable: '' })).toBe(false);
    });

    it('ignores a long answer the run never looked anything up for', () => {
        // Length alone fired on essentially every substantive read-only answer.
        // Auditing one composed out of context spends a sub-agent confirming
        // that nobody read a file — the cost of a false positive here is paid
        // on every ordinary question, so the trigger needs both signals.
        expect(isInvestigation({ ...traced, inspections: 0, deliverable: long() })).toBe(false);
        expect(isInvestigation({ ...traced, inspections: MIN_INSPECTIONS - 1, deliverable: long() })).toBe(false);
        expect(isInvestigation({ ...traced, inspections: MIN_INSPECTIONS, deliverable: long() })).toBe(true);
    });

    it('sets the analysis bar above the "produced anything" bar', () => {
        // DELIVERABLE_MIN_CHARS is 400. Sitting at it made this gate fire
        // wherever that one did, which is not what it is for.
        expect(ANALYSIS_MIN_CHARS).toBeGreaterThan(400);
    });
});

describe('buildAuditBrief', () => {
    const brief = buildAuditBrief({
        goal: 'この画面の挙動を説明して',
        report: 'JSP が値を描画しています。',
        openQuestions: [{ id: 'q1', question: 'flag の設定元', status: 'open', why: '表示が変わる' }],
        filesRead: ['web/order/list.jsp', 'web/common/header.jsp'],
    });

    it('asks for the layer check by name, not just "review this"', () => {
        // Handing an investigation to the CODE reviewer's criteria produced
        // "no changes to review — PASS", which is how the gap stayed invisible.
        expect(brief).toMatch(/layer boundary/i);
        expect(brief).toMatch(/where the values it cites are SET/i);
    });

    it('shows the auditor what was read, so a one-layer trace is visible', () => {
        expect(brief).toContain('web/order/list.jsp');
        expect(brief).toContain('web/common/header.jsp');
    });

    it('passes the open questions through so silence can be caught', () => {
        expect(brief).toContain('flag の設定元');
    });

    it('demands the verdict block the parser expects', () => {
        expect(brief).toMatch(/VERDICT:\s*PASS/);
        expect(brief).toMatch(/FINDINGS:/);
    });

    it('survives a missing frontier and an unrecorded read list', () => {
        const bare = buildAuditBrief({ goal: 'g', report: 'r' });
        expect(bare).toContain('(the investigator recorded none)');
        expect(bare).toContain('(not recorded)');
    });
});

describe('OpenQuestions', () => {
    it('records a determinant and hands back an id', () => {
        const q = new OpenQuestions();
        const { id, duplicate } = q.add('where is the flag set?', 'the screen changes');
        expect(id).toBe('q1');
        expect(duplicate).toBe(false);
        expect(q.unresolved()).toHaveLength(1);
    });

    it('does not inflate the frontier when a loop re-reads the same file', () => {
        const q = new OpenQuestions();
        q.add('Where is the flag set?');
        const again = q.add('  where is THE FLAG set?  ');
        expect(again.duplicate).toBe(true);
        expect(again.id).toBe('q1');
        expect(q.size).toBe(1);
    });

    it('refuses to close a question with nothing to show for it', () => {
        // "Resolved" with no answer is how a frontier gets cleared without being
        // investigated — which would make the mechanism worse than not having it.
        const q = new OpenQuestions();
        const { id } = q.add('where is the flag set?');
        expect(q.resolve(id, '').ok).toBe(false);
        expect(q.resolve(id, '   ').ok).toBe(false);
        expect(q.unresolved()).toHaveLength(1);

        expect(q.resolve(id, 'WEB-INF/web.xml:31 sets it').ok).toBe(true);
        expect(q.unresolved()).toHaveLength(0);
    });

    it('reports an unknown id rather than silently doing nothing', () => {
        const q = new OpenQuestions();
        const r = q.resolve('q9', 'found it');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/no open question/);
    });

    it('caps the frontier', () => {
        const q = new OpenQuestions();
        for (let i = 0; i < MAX_QUESTIONS; i++) q.add(`question ${i}`);
        expect(q.add('one more').capped).toBe(true);
        expect(q.size).toBe(MAX_QUESTIONS);
    });

    it('ignores an empty question', () => {
        const q = new OpenQuestions();
        expect(q.add('   ').id).toBe('');
        expect(q.size).toBe(0);
    });
});

describe('renderQuestions', () => {
    it('shows status and the answer a resolved question carries', () => {
        const q = new OpenQuestions();
        const { id } = q.add('where is the flag set?', 'display depends on it');
        q.resolve(id, 'WEB-INF/web.xml:31');
        const text = renderQuestions(q.snapshot());
        expect(text).toContain('[resolved]');
        expect(text).toContain('display depends on it');
        expect(text).toContain('WEB-INF/web.xml:31');
    });

    it('says so plainly when there are none', () => {
        expect(renderQuestions([])).toMatch(/none/i);
    });
});
