// InvestigationGate — the finish checks a read-only run gets.
//
// The asymmetry this closes. When a run CHANGES code, AgentController runs an
// independent reviewer before accepting the finish, and a FAIL sends the work
// back. When a run only READS, none of that applies: the review gate is
// conditioned on `hasReviewableChanges`, so an investigation is accepted the
// moment the model says it is done, and the only other check (`Deliverable
// Missing`) asks whether text exists, not whether the text is supported.
//
// So the machinery that makes writing trustworthy did not cover investigating —
// and an investigation's deliverable IS its claim. The observed failure: a
// question about a screen answered entirely from the frontend, with the backend
// configuration that actually governed the behaviour never traced, delivered
// confidently and fast. Nothing in the loop was in a position to notice.
//
// Three checks, all deliberately SOFT and one-shot, matching the deliverable
// nudge already in the loop: the model is told once and then trusted. Hard
// blocking would deadlock a run whose model cannot satisfy the check, and the
// existing design chose "trust the model, catch the common failure" — this
// follows it rather than inventing a second policy.
//
// Pure logic; AgentController does the I/O.

/**
 * A deliverable shorter than this is a note, not an analysis — no checks.
 *
 * Deliberately well above DELIVERABLE_MIN_CHARS (400, the bar for "produced
 * anything at all"). Set at that bar, the gate fired on essentially every
 * substantive read-only answer, which is not what it is for: the cost of a
 * miss here is one shallow answer, and the cost of a false positive is two
 * extra round trips and a sub-agent on every ordinary question.
 */
export const ANALYSIS_MIN_CHARS = 900;

/**
 * Inspections a run must have made before its answer is treated as an
 * investigation of the codebase.
 *
 * Length alone was not enough of a discriminator: a long answer composed from
 * context is not a trace, and auditing it just spends tokens confirming that
 * nobody looked anything up. An investigation deep enough to go wrong the way
 * the Java/JSP one did reads far more than this.
 */
export const MIN_INSPECTIONS = 4;

/** Below this many citations, an analysis of that length is asserting, not showing. */
export const MIN_CITATIONS = 2;

/**
 * Source and configuration file extensions, for spotting citations.
 *
 * Deliberately NOT limited to the languages this project happens to be written
 * in. The failure being addressed was on a Java/JSP codebase, and the evidence
 * that mattered there lived in .xml and .properties — a config-blind citation
 * check would have scored that investigation as well-supported precisely where
 * it was weakest.
 */
const EXT = [
    // JVM / web
    'java', 'jsp', 'jspf', 'tag', 'tld', 'kt', 'scala', 'groovy', 'gradle',
    // scripting
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'svelte', 'vue', 'py', 'rb', 'php', 'pl',
    // systems
    'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'm',
    // markup / style
    'html', 'htm', 'xhtml', 'css', 'scss', 'less',
    // configuration — where "backend state" usually actually lives
    'xml', 'json', 'yaml', 'yml', 'properties', 'ini', 'conf', 'config', 'cfg', 'toml', 'env',
    // data / build / docs
    'sql', 'sh', 'bat', 'ps1', 'md', 'txt', 'lock', 'gitignore',
];

/** Config files that are ALL extension — no basename in front of the dot. */
const DOTFILES = ['env', 'gitignore', 'npmrc', 'editorconfig', 'htaccess'];

// Built by concatenation rather than a template literal: `String.raw` still
// interpolates ${…}, so writing the extension group inline would have made the
// pattern reference a variable that does not exist.
//
// The trailing (?![\w-]) is load-bearing, not tidiness. Without it the extension
// alternation matches a PREFIX: `web.config` came back as `web.c` because `c` is
// a valid extension and nothing said the match had to end there. That turns a
// real citation into a wrong one and lets ordinary prose score as evidence.
//
// The leading assertion is a LOOKBEHIND, not a list of delimiters. Listing them
// meant listing the punctuation of one language: `…が描画し、WEB-INF/web.xml` was
// not a citation, because an ideographic comma was not on the list. Reports here
// are written in Japanese, so that made a well-cited answer score as uncited and
// bounced it — the check firing hardest on the reports it should have passed.
// Asking instead "is this the START of a token" needs no such list.
const CITATION_RE = new RegExp(
    '(?<![\\w@~/\\\\.-])'               // not mid-token — any language, any punctuation
    + '((?:[\\w.@~-]+[/\\\\])*'         // optional directories
    + '(?:'
    + '[\\w.@-]+\\.(?:' + EXT.join('|') + ')'   // name.ext
    + '|\\.(?:' + DOTFILES.join('|') + ')'      // .env and friends
    + '))'
    + '(?![\\w-])'                      // …and the extension ends HERE
    + '(:\\d+(?:-\\d+)?)?',             // optional :line or :line-line
    'gi',
);

/**
 * Every file reference in a piece of text, de-duplicated, in order.
 * A reference with a line number counts as the same file as one without —
 * what is being measured is "did they show where", not how many times.
 */
export function citationsIn(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(CITATION_RE)) {
        const file = m[1];
        const ref = file + (m[2] || '');
        const k = ref.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(ref);
    }
    return out;
}

/**
 * Did the run investigate rather than build?
 *
 * "Changed no code or config" is the same condition the review gate already uses
 * to SKIP itself (`hasReviewableChanges`), read the other way round: exactly the
 * runs that fall through the code review are the ones that land here. Reports
 * written to .md/.txt do not count as changes — a research task that writes its
 * findings to a file is still a research task.
 */
export function isInvestigation({ hasReviewableChanges, deliverable, inspections = 0 }) {
    if (hasReviewableChanges) return false;
    if (String(deliverable || '').trim().length < ANALYSIS_MIN_CHARS) return false;
    return Number(inspections || 0) >= MIN_INSPECTIONS;
}

/**
 * Does an investigation's deliverable show its work?
 *
 * Length is the trigger, not the subject: a long analysis with no file
 * references is a set of assertions, and the reader cannot tell which parts were
 * read and which were inferred. This does not judge whether the citations are
 * CORRECT — only that the claim is anchored to something checkable.
 *
 * @returns {{needed: boolean, citations: string[], reason: string}}
 */
export function evidenceCheck(deliverable) {
    const text = String(deliverable || '');
    const citations = citationsIn(text);
    if (text.trim().length < ANALYSIS_MIN_CHARS) {
        return { needed: false, citations, reason: 'too-short-to-judge' };
    }
    if (citations.length >= MIN_CITATIONS) {
        return { needed: false, citations, reason: 'cited' };
    }
    return { needed: true, citations, reason: citations.length ? 'thin' : 'uncited' };
}

/** Phrases that mark a deliverable as already declaring what it did NOT verify. */
const UNKNOWNS_RE = /(open question|unverified|not verified|unconfirmed|could not (?:verify|confirm|determine)|未確認|未確定|未検証|確認できませんでした|추정|assumption|assumed)/i;

/**
 * Is the run finishing with a frontier it never dealt with?
 *
 * Two ways to deal with one: resolve it, or say plainly in the deliverable that
 * it is unresolved. Silently dropping it is the one outcome this catches — that
 * is precisely how a partial trace gets presented as a complete answer.
 *
 * @returns {{needed: boolean, open: object[], reason: string}}
 */
export function frontierCheck(openItems, deliverable) {
    const open = (Array.isArray(openItems) ? openItems : []).filter(i => i && i.status === 'open');
    if (open.length === 0) return { needed: false, open, reason: 'frontier-empty' };
    if (UNKNOWNS_RE.test(String(deliverable || ''))) {
        return { needed: false, open, reason: 'declared-in-deliverable' };
    }
    return { needed: true, open, reason: 'dropped-silently' };
}

/**
 * The brief for the auditor sub-agent.
 *
 * Note what it does NOT ask for: a code review. The deliverable of an
 * investigation is a CLAIM, so the question is whether the claim is supported
 * and whether the trace stopped at a layer boundary — not whether any code is
 * good. Handing this to the code reviewer's criteria produced "no changes to
 * review, PASS", which is how the gap stayed invisible.
 */
export function buildAuditBrief({ goal, report, openQuestions = [], filesRead = [] }) {
    const clip = (s, n) => {
        const t = String(s || '');
        return t.length <= n ? t : t.slice(0, n) + '\n…[truncated]';
    };
    const open = openQuestions.filter(i => i && i.status === 'open');
    const openBlock = open.length
        ? open.map(i => `- ${i.question}${i.why ? ` — ${i.why}` : ''}`).join('\n')
        : '(the investigator recorded none)';
    const readBlock = filesRead.length
        ? filesRead.slice(0, 60).map(f => `- ${f}`).join('\n')
        : '(not recorded)';

    return `Audit an INVESTIGATION another agent just completed. It changed no code — its deliverable is a claim, and your job is to judge whether that claim is supported.

## The question that was asked
${clip(goal, 3000)}

## The answer that was given
${clip(report, 7000)}

## Questions the investigator left open
${openBlock}

## Files the investigator actually read
${readBlock}

## What to check
1. **Is every load-bearing claim anchored?** A statement about what the system DOES needs a file (and ideally a line) behind it. Flag claims that are asserted with nothing to check them against.
2. **Did the trace stop at a layer boundary?** This is the failure that matters most. If the answer explains behaviour using only one layer — the screen, the template, the client code — but the behaviour is actually decided further in (a request mapping, a servlet or controller, a configuration file, an environment variable, a database row, a build profile), then the answer is incomplete even if everything in it is true. Spot-check by looking for where the values it cites are SET, not just where they are read.
3. **Is inference labelled as inference?** An investigator is allowed to say "probably X". It is not allowed to present a guess in the same voice as a verified fact.
4. **Are the open questions above either answered in the report, or declared in it as unresolved?** Silently dropping one is a finding.

Do NOT report style, wording or formatting opinions. Do NOT ask for more work that the original question did not need.

Classify each finding as [CRITERIA-VIOLATION] (the question was not actually answered), [BUG] (a claim is wrong or unsupported), or [STYLE] (informational only — never blocks).

Your report MUST end with:
VERDICT: PASS
(or VERDICT: FAIL)
FINDINGS:
- [BUG] path/file.ext:123 — description…
(no findings → "FINDINGS: none")`;
}
