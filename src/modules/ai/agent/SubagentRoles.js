// SubagentRoles — pure logic for the run_subtask sub-agent engine:
// role presets (persona + tool allowlist + budget defaults), brief/prompt
// composition, and reviewer-verdict parsing. No I/O — unit-testable.
//
// Design: the ENGINE is generic
// (one run_subtask tool); roles are thin PRESETS of defaults on top. The
// guarantees that matter (reviewer can't write, budgets, no recursion) are
// enforced in code via the tool allowlist — not by the persona text.

/** Max sub-tasks running concurrently (per parent run). */
export const SUBTASK_MAX_PARALLEL = 3;
/** Max sub-tasks spawned in one parent run (cost guard). */
export const SUBTASK_MAX_PER_RUN = 8;
/** Max characters of a child's report returned to the parent. */
export const SUBTASK_REPORT_MAX_CHARS = 8000;
/** Hard cap on a child's max_steps regardless of args/preset. */
export const SUBTASK_MAX_STEPS_CAP = 20;

// Shared with AgentModes — see tools/toolSets.js for why they live in one place.
import { READ_TOOLS, READ_ONLY_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS, WEB_TOOLS } from '../tools/toolSets.js';

/**
 * Tools whose writes are checked against the sub-agent's write scope (Step 3).
 *
 * This was `new Set(EDIT_TOOLS)`, i.e. the source-editing five — which left the
 * document writers (write_xlsx / update_xlsx / write_docx) unchecked, so a child
 * confined to `src/moduleA` could still drop a workbook anywhere in the
 * workspace. The scope is meant to prevent two parallel children colliding, and
 * a collision on a spreadsheet is a collision.
 */
export const WRITE_ENFORCED_TOOLS = new Set([...EDIT_TOOLS, ...OUTPUT_TOOLS]);

/** Default write scope for the tester role: test files/dirs only. */
export const TESTER_WRITE_PATTERNS = [
    '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/tests/**', '**/test/**',
];

const COMMON_PERSONA_RULES = `
## Sub-agent ground rules
- You are an ISOLATED sub-agent: you have NO access to the parent conversation. Everything you need is in the brief above — if something is genuinely missing, state the assumption you made in your report (ask_user is NOT available to you; never wait for a human).
- Work strictly INSIDE the scope given in the brief. Do not expand scope.
- End by calling finish_task with your COMPLETE report in \`summary\` (the parent only receives that report).`;

export const SUBAGENT_ROLES = {
    reviewer: {
        id: 'reviewer',
        label: 'Reviewer',
        // READ_ONLY_TOOLS, not READ_TOOLS. This said "read-only by construction —
        // cannot edit" while handing over READ_TOOLS, which contains
        // `run_command` — and a shell can write files, so the claim was false and
        // the run_subtask schema repeated it to the orchestrating model as a
        // safety property. Reviewing does not need a shell: git_status/git_diff/
        // git_log are in READ_ONLY_TOOLS and are what the persona asks for.
        tools: [...READ_ONLY_TOOLS],
        maxIterations: 8,
        tier: 'fast',
        persona: `## Role: Independent Code Reviewer
You review changes made by another agent. You NEVER fix anything yourself — you only report findings.
- Inspect the changes (in a git workspace, the \`git_diff\` / \`git_status\` tools are the fastest way; otherwise read the listed files).
- Judge ONLY against the acceptance criteria in the brief plus objective defects (bugs, syntax errors, broken behavior, unmet requirements).
- Classify every finding as [CRITERIA-VIOLATION], [BUG], or [STYLE]. STYLE findings are informational and must NOT fail the review.
- Your report MUST end with this exact block:
VERDICT: PASS
(or VERDICT: FAIL)
FINDINGS:
- [BUG] path/file.js:123 — description…
- [STYLE] …
(no findings → "FINDINGS: none")
${COMMON_PERSONA_RULES}`,
    },
    auditor: {
        id: 'auditor',
        label: 'Auditor',
        // Read-only, like the reviewer — an auditor that could edit would be
        // marking its own homework.
        tools: [...READ_ONLY_TOOLS],
        maxIterations: 10,
        tier: 'fast',
        persona: `## Role: Investigation Auditor
You audit an INVESTIGATION another agent completed. It changed no code, so there is no diff to read: its deliverable is a CLAIM, and you judge whether the claim holds.
- You NEVER fix anything and you never continue the investigation for its own sake — you verify and report.
- Your first duty is the LAYER CHECK. An answer that explains behaviour using only the layer it was asked about — the screen, the page, the template, the client code — is incomplete when the behaviour is actually decided further in: a request mapping, a controller or servlet, a configuration file, an environment variable, a database row, a build profile. Take the values the answer cites and look for where they are SET, not only where they are read. If the trace stops at a boundary, that is a [CRITERIA-VIOLATION] even when everything stated is true.
- Second: is each load-bearing claim anchored to a file (ideally file:line) you can check? Unanchored assertions are [BUG].
- Third: is inference labelled as inference? "Probably X" is fine; a guess written in the same voice as a verified fact is not.
- Judge the question that was ASKED. Do not demand work it did not need.
- Classify every finding as [CRITERIA-VIOLATION], [BUG], or [STYLE]. STYLE never fails an audit.
- Your report MUST end with this exact block:
VERDICT: PASS
(or VERDICT: FAIL)
FINDINGS:
- [BUG] path/file.ext:123 — description…
(no findings → "FINDINGS: none")
${COMMON_PERSONA_RULES}`,
    },
    tester: {
        id: 'tester',
        label: 'Tester',
        tools: [...READ_TOOLS, ...EDIT_TOOLS],
        maxIterations: 15,
        tier: 'fast',
        persona: `## Role: Test Engineer
You verify a requirement by writing and/or running tests. You must NOT modify implementation code — only create/modify TEST files (and test configuration), and run them.
- Prefer the project's existing test runner and conventions (look at existing tests first).
- Report: which cases you covered, the run results (pass/fail with output), and any defects found (with file:line).
${COMMON_PERSONA_RULES}`,
    },
    researcher: {
        id: 'researcher',
        label: 'Researcher',
        // Also READ_ONLY_TOOLS — the schema advertises this role as "read-only
        // investigation (+web)", and that has to be true. `open_question` is a
        // run-local note, not a workspace write, so it does not break that claim
        // — and this is the role that most needs to carry an untraced dependency
        // forward instead of dropping it.
        tools: [...READ_ONLY_TOOLS, ...WEB_TOOLS, 'open_question'],
        maxIterations: 10,
        tier: 'fast',
        persona: `## Role: Researcher
You investigate and report — you never modify files.
- Answer the brief's questions with evidence: file paths, line numbers, quotes, or URLs.
- When reading raises a question the answer depends on — a flag whose origin you have not seen, a config key nothing has shown you the source of, a request that leaves the layer you are in — record it with \`open_question\` and come back to it. Finishing with one silently dropped is what turns a partial trace into a confident wrong answer.
- Structure the report: conclusion first, then supporting findings, then what you could NOT verify.
${COMMON_PERSONA_RULES}`,
    },
    generic: {
        id: 'generic',
        label: 'Generic',
        tools: null,                      // caller substitutes: all built-ins minus run_subtask
        maxIterations: 12,
        tier: 'fast',
        persona: `## Role: General Sub-agent
Complete the brief exactly as scoped.
${COMMON_PERSONA_RULES}`,
    },
};

/** Resolve a role name to its preset; unknown/empty → generic. */
export function resolveRole(role) {
    const key = String(role || '').trim().toLowerCase();
    return SUBAGENT_ROLES[key] || SUBAGENT_ROLES.generic;
}

/** Clip text to `max` chars with a truncation marker. */
export function clipText(s, max) {
    const str = String(s || '');
    if (str.length <= max) return str;
    return str.slice(0, max) + '\n…[truncated]';
}

/**
 * Compose the child's user prompt from the parent-written brief.
 * (The role persona goes into the child's extra_instructions, not here.)
 */
export function composeSubtaskPrompt(brief, roleDef) {
    return `[Sub-task brief from the orchestrating agent — role: ${roleDef.label}]\n${brief}`;
}

/**
 * Build the Step-1 review brief for the pre-finish review gate.
 * @param {object} p { goal, summary, files: string[] }
 */
export function buildReviewBrief({ goal, summary, files }) {
    const fileList = (files || []).map(f => `- ${f}`).join('\n') || '(none listed)';
    return `Review the changes another agent just made, against the acceptance criteria below.

## Original request (acceptance criteria)
${clipText(goal, 4000)}

## What the implementer claims was done
${clipText(summary || '(no summary provided)', 3000)}

## Files modified this run
${fileList}

## What to do
1. Inspect the actual changes (try \`git diff\` first; otherwise read the files above).
2. Check ONLY: does the change satisfy the request? Are there bugs / syntax errors / broken behavior?
3. Report findings classified as [CRITERIA-VIOLATION] / [BUG] / [STYLE], and end with the mandatory VERDICT block. STYLE issues alone must NOT produce a FAIL.`;
}

// ── Write-scope enforcement (Step 3: parallel-edit ownership) ───────────────

/** Normalize a path/scope entry for comparison: forward slashes, collapsed,
 *  no trailing slash, lowercase (Windows-insensitive). */
function normPath(s) {
    return String(s || '')
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

/** Convert a normalized glob to an anchored RegExp. `**​/` matches zero or more
 *  directories; `**` any chars; `*` any chars within one segment. */
function globToRegex(glob) {
    let re = '';
    let g = glob;
    // Escape regex specials except our wildcards.
    g = g.replace(/[.+^${}()|[\]]/g, '\\$&');
    g = g.replace(/\*\*\//g, '§DIRS§').replace(/\*\*/g, '§ALL§').replace(/\*/g, '§SEG§');
    re = g.replace(/§DIRS§/g, '(?:.*/)?').replace(/§ALL§/g, '.*').replace(/§SEG§/g, '[^/]*');
    return new RegExp(`^${re}$`);
}

/**
 * Is `path` (absolute or workspace-relative) inside one of the `scopes`?
 * Scope entries may be: absolute prefixes, workspace-relative prefixes, or
 * globs (`*` / `**`). Empty/null scopes = unrestricted (returns true).
 */
export function isPathInScope(path, scopes, workspaceRoot = '') {
    if (!Array.isArray(scopes) || scopes.length === 0) return true;
    const p = normPath(path);
    const root = normPath(workspaceRoot);
    const rel = root && p.startsWith(root + '/') ? p.slice(root.length + 1) : null;
    for (const raw of scopes) {
        const e = normPath(raw);
        if (!e) continue;
        if (e === '**') return true;
        if (e.includes('*')) {
            const re = globToRegex(e);
            if (re.test(p) || (rel !== null && re.test(rel))) return true;
        } else {
            const isAbs = /^([a-z]:\/|\/)/.test(e);
            const full = isAbs ? e : (root ? `${root}/${e}` : e);
            if (p === full || p.startsWith(full + '/')) return true;
            // Relative entry with no root context — suffix/containment match.
            if (!isAbs && (p === e || p.endsWith('/' + e) || p.includes('/' + e + '/'))) return true;
        }
    }
    return false;
}

/**
 * Do two write-claims overlap? Used by the parent's ownership registry to
 * SERIALIZE parallel sub-tasks whose edit scopes could collide.
 * Conservative: any glob entry is treated as potentially overlapping
 * everything (better to serialize than to corrupt). Prefix entries overlap
 * when one contains the other (with a relative/absolute suffix heuristic).
 */
export function scopesOverlap(a, b) {
    const A = (Array.isArray(a) && a.length > 0) ? a : ['**'];
    const B = (Array.isArray(b) && b.length > 0) ? b : ['**'];
    const entryOverlap = (x, y) => {
        const e1 = normPath(x);
        const e2 = normPath(y);
        if (!e1 || !e2) return false;
        if (e1.includes('*') || e2.includes('*')) return true;   // conservative
        if (e1 === e2 || e1.startsWith(e2 + '/') || e2.startsWith(e1 + '/')) return true;
        // absolute vs relative heuristic: does one END with the other?
        return e1.endsWith('/' + e2) || e2.endsWith('/' + e1);
    };
    for (const x of A) for (const y of B) if (entryOverlap(x, y)) return true;
    return false;
}

/**
 * Compute the token-budget slice handed to one child.
 * Parent has no budget (0) → child gets 0 (= inherit global config).
 * Otherwise: 20% of the parent budget, capped by what's still unspent, with a
 * 5000-token floor so a child is never spawned too starved to do anything
 * (the parent's own cap still stops the run right after, so the floor cannot
 * meaningfully overshoot the total).
 */
export function childTokenBudget(parentBudget, alreadySpent) {
    const budget = Number(parentBudget) || 0;
    if (budget <= 0) return 0;
    const remaining = Math.max(0, budget - (Number(alreadySpent) || 0));
    return Math.max(5000, Math.min(Math.floor(budget * 0.2), remaining));
}

/** Findings block = from the FINDINGS: marker if present, else the whole report. */
function extractFindings(s) {
    const fIdx = s.search(/FINDINGS\s*:/i);
    return (fIdx >= 0 ? s.slice(fIdx) : s).trim();
}

/**
 * Remove the persona's own template example lines so a report that merely echoes
 * the instructions (e.g. the "- [BUG] path/file.js:123 — description…" sample)
 * doesn't get mistaken for a real blocking finding by the tag heuristic.
 */
function stripTemplateLegend(s) {
    return String(s)
        .replace(/\(or VERDICT:\s*FAIL\)/gi, '')
        .replace(/\[BUG\]\s*path\/file\.[a-z]+:\d+\s*—\s*description[.…]*/gi, '')
        .replace(/\[STYLE\]\s*…/gi, '')
        .replace(/no findings\s*→\s*"FINDINGS:\s*none"/gi, '');
}

const FAIL_TOKEN = /fail|不合格|却下/i;
const mapVerdictToken = (t) => (FAIL_TOKEN.test(String(t)) ? 'fail' : 'pass');

/**
 * Parse a reviewer report into { verdict: 'pass'|'fail'|'unknown', findings, reason }.
 *
 * Multi-tier detection — designed so a reviewer that inspected the changes but
 * forgot the exact "VERDICT:" block does NOT collapse to the ambiguous "unknown"
 * state (which showed up in the UI as "レビュー結果不明" and left the run without a
 * clean review outcome). Only a genuinely empty/garbage report is 'unknown'.
 *
 * Priority:
 *   1. Explicit `VERDICT: PASS/FAIL` (or 合格/不合格/承認/却下) — LAST wins.
 *   2. A standalone verdict token on its own line (PASS / FAIL / 合格 / 不合格).
 *   3. A real report that lists blocking findings ([CRITERIA-VIOLATION]/[BUG]) → fail.
 *   4. Explicit "all good" language (no issues / 問題なし / LGTM / FINDINGS: none) → pass.
 *   5. A substantive report with no blocking tags and no fail language → pass
 *      (the reviewer looked and reported nothing blocking; a missing VERDICT line
 *      must never deadlock the implementer).
 *   6. Empty / trivial report → unknown.
 */
export function parseReviewVerdict(text) {
    const s = String(text || '');
    const trimmed = s.trim();

    // 1) Explicit verdict — the authoritative signal; last occurrence wins.
    const explicit = [...s.matchAll(/VERDICT\s*[:：]?\s*\**\s*(PASS|FAIL|合格|不合格|承認|却下)\b/gi)];
    if (explicit.length > 0) {
        return { verdict: mapVerdictToken(explicit[explicit.length - 1][1]), findings: extractFindings(s), reason: 'explicit-verdict' };
    }

    // 2) Standalone verdict token on its own line.
    const standalone = [...s.matchAll(/(?:^|\n)\s*\**\s*(PASS|FAIL|合格|不合格)\s*\**\s*(?=$|\n)/gi)];
    if (standalone.length > 0) {
        return { verdict: mapVerdictToken(standalone[standalone.length - 1][1]), findings: extractFindings(s), reason: 'standalone-token' };
    }

    // 6) Genuinely empty / trivial → unknown (only remaining unknown path).
    if (trimmed.length < 12) return { verdict: 'unknown', findings: trimmed, reason: 'empty-report' };

    // 3) Blocking finding tags in a real report (template legend stripped first).
    if (/\[(CRITERIA-VIOLATION|BUG)\]/i.test(stripTemplateLegend(s))) {
        return { verdict: 'fail', findings: extractFindings(s), reason: 'blocking-tag-heuristic' };
    }

    // 4) Conservative "all clear" language.
    if (/(no (?:blocking |critical )?(?:issues|problems|defects|bugs)(?: (?:found|detected))?|問題(?:は)?(?:あり|有り)ません|問題な(?:し|い)|指摘(?:事項)?(?:は)?(?:あり|有り)ません|looks good|\blgtm\b|承認|approved|合格|all (?:criteria|requirements)(?: are)? (?:met|satisfied)|FINDINGS\s*:\s*none)/i.test(s)) {
        return { verdict: 'pass', findings: extractFindings(s), reason: 'pass-phrase-heuristic' };
    }

    // 5) Substantive report, nothing blocking → pass (never deadlock the implementer).
    return { verdict: 'pass', findings: extractFindings(s), reason: 'no-blocking-findings' };
}

/**
 * Condense a reviewer's raw report into a couple of log lines, so the user
 * sees WHAT the reviewer said (problem / no-problem reasons), not just the
 * verdict. Prefers the FINDINGS: block; falls back to the first meaningful
 * prose line. Always kept short — the full text still goes to the model.
 */
export function summarizeReview(verdict, findings) {
    const raw = String(findings || '').replace(/^FINDINGS\s*:\s*/i, '').trim();
    const lines = raw
        .split(/\r?\n/)
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .filter(l => l && !/^(VERDICT|FINDINGS)\b/i.test(l));
    const head = lines.length ? lines[0] : '';
    const n = lines.length;
    const summary = head
        ? (n > 1 ? `${head}（他 ${n - 1} 件）` : head)
        : (verdict === 'pass'
            ? '問題なし — レビューアは変更を確認し、ブロッキングな指摘はありませんでした'
            : '（レビュー文言なし — 判定のみ）');
    // Cap INCLUDING the truncation marker, so the logged line never exceeds
    // MAX chars total (clipText appends its own "…[truncated]" on top).
    const MAX = 220;
    const MARKER = '\n…[truncated]';
    if (summary.length > MAX) return summary.slice(0, MAX - MARKER.length) + MARKER;
    return summary;
}
