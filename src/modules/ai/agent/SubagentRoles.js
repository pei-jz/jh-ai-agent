// SubagentRoles — pure logic for the run_subtask sub-agent engine:
// role presets (persona + tool allowlist + budget defaults), brief/prompt
// composition, and reviewer-verdict parsing. No I/O — unit-testable.
//
// Design (docs/design/subagent-architecture.md): the ENGINE is generic
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

// Read-only investigation set (run_command included: the command policy
// auto-approves read-only commands like `git diff` and prompts for the rest).
const READ_TOOLS = ['read_file', 'list_files', 'grep_search', 'glob', 'verify_syntax', 'run_command'];
const EDIT_TOOLS = ['write_file', 'multi_replace_file_content', 'replace_lines', 'delete_file', 'move_file'];
const WEB_TOOLS = ['fetch_url', 'web_search'];

/** File-mutating tools subject to write-scope enforcement (Step 3). */
export const WRITE_ENFORCED_TOOLS = new Set(EDIT_TOOLS);

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
        tools: [...READ_TOOLS],           // read-only by construction — cannot edit
        maxIterations: 8,
        tier: 'fast',
        persona: `## Role: Independent Code Reviewer
You review changes made by another agent. You NEVER fix anything yourself — you only report findings.
- Inspect the changes (in a git workspace, \`git diff\` / \`git status\` via run_command is the fastest way; otherwise read the listed files).
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
        tools: [...READ_TOOLS, ...WEB_TOOLS],
        maxIterations: 10,
        tier: 'fast',
        persona: `## Role: Researcher
You investigate and report — you never modify files.
- Answer the brief's questions with evidence: file paths, line numbers, quotes, or URLs.
- Structure the report: conclusion first, then supporting findings, then open questions.
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

/**
 * Parse a reviewer report into { verdict: 'pass'|'fail'|'unknown', findings }.
 * The LAST "VERDICT:" occurrence wins (models sometimes restate the template).
 * No verdict found → 'unknown' (the gate treats unknown as pass — a broken
 * reviewer must never deadlock the implementer).
 */
export function parseReviewVerdict(text) {
    const s = String(text || '');
    const matches = [...s.matchAll(/VERDICT\s*:\s*(PASS|FAIL)/gi)];
    if (matches.length === 0) return { verdict: 'unknown', findings: s.trim() };
    const verdict = matches[matches.length - 1][1].toLowerCase() === 'fail' ? 'fail' : 'pass';
    // Findings = everything from the FINDINGS: marker if present, else whole report.
    const fIdx = s.search(/FINDINGS\s*:/i);
    const findings = (fIdx >= 0 ? s.slice(fIdx) : s).trim();
    return { verdict, findings };
}
