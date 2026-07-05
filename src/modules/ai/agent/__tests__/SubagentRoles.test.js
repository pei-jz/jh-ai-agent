import { describe, it, expect } from 'vitest';
import {
    SUBAGENT_ROLES, resolveRole, clipText, composeSubtaskPrompt,
    buildReviewBrief, parseReviewVerdict, childTokenBudget,
    isPathInScope, scopesOverlap, WRITE_ENFORCED_TOOLS, TESTER_WRITE_PATTERNS,
    SUBTASK_MAX_PARALLEL, SUBTASK_MAX_PER_RUN, SUBTASK_MAX_STEPS_CAP
} from '../SubagentRoles.js';
import { normalizeSafetyLimits, SAFETY_DEFAULTS } from '../SafetyLimits.js';

describe('resolveRole', () => {
    it('resolves known roles', () => {
        expect(resolveRole('reviewer').id).toBe('reviewer');
        expect(resolveRole('TESTER').id).toBe('tester');
        expect(resolveRole('  researcher ').id).toBe('researcher');
    });

    it('falls back to generic for unknown / empty / null', () => {
        expect(resolveRole('boss').id).toBe('generic');
        expect(resolveRole('').id).toBe('generic');
        expect(resolveRole(null).id).toBe('generic');
        expect(resolveRole(undefined).id).toBe('generic');
    });

    it('reviewer and researcher presets contain no edit tools', () => {
        const edits = ['write_file', 'multi_replace_file_content', 'replace_lines', 'delete_file', 'move_file'];
        for (const role of ['reviewer', 'researcher']) {
            for (const t of SUBAGENT_ROLES[role].tools) {
                expect(edits).not.toContain(t);
            }
        }
    });

    it('no preset ever includes run_subtask (recursion ban)', () => {
        for (const def of Object.values(SUBAGENT_ROLES)) {
            if (def.tools) expect(def.tools).not.toContain('run_subtask');
        }
    });

    it('budget constants are sane', () => {
        expect(SUBTASK_MAX_PARALLEL).toBeGreaterThan(0);
        expect(SUBTASK_MAX_PER_RUN).toBeGreaterThanOrEqual(SUBTASK_MAX_PARALLEL);
        for (const def of Object.values(SUBAGENT_ROLES)) {
            expect(def.maxIterations).toBeLessThanOrEqual(SUBTASK_MAX_STEPS_CAP);
        }
    });
});

describe('clipText', () => {
    it('returns short strings untouched', () => {
        expect(clipText('abc', 10)).toBe('abc');
    });
    it('clips long strings with a marker', () => {
        const out = clipText('x'.repeat(100), 10);
        expect(out.startsWith('x'.repeat(10))).toBe(true);
        expect(out).toContain('[truncated]');
    });
    it('tolerates null/undefined', () => {
        expect(clipText(null, 5)).toBe('');
        expect(clipText(undefined, 5)).toBe('');
    });
});

describe('composeSubtaskPrompt', () => {
    it('embeds the brief and role label', () => {
        const p = composeSubtaskPrompt('Do X in src/a.js', SUBAGENT_ROLES.reviewer);
        expect(p).toContain('Do X in src/a.js');
        expect(p).toContain('Reviewer');
    });
});

describe('buildReviewBrief', () => {
    it('contains goal, summary and file list', () => {
        const b = buildReviewBrief({ goal: 'add feature', summary: 'done it', files: ['src/a.js', 'src/b.js'] });
        expect(b).toContain('add feature');
        expect(b).toContain('done it');
        expect(b).toContain('- src/a.js');
        expect(b).toContain('- src/b.js');
        expect(b).toContain('VERDICT');
    });
    it('handles missing summary/files', () => {
        const b = buildReviewBrief({ goal: 'g', summary: '', files: [] });
        expect(b).toContain('(no summary provided)');
        expect(b).toContain('(none listed)');
    });
    it('clips a huge goal', () => {
        const b = buildReviewBrief({ goal: 'g'.repeat(10000), summary: 's', files: [] });
        expect(b).toContain('[truncated]');
    });
});

describe('parseReviewVerdict', () => {
    it('parses PASS', () => {
        const { verdict } = parseReviewVerdict('all good\nVERDICT: PASS\nFINDINGS: none');
        expect(verdict).toBe('pass');
    });
    it('parses FAIL and extracts findings', () => {
        const { verdict, findings } = parseReviewVerdict(
            'report…\nVERDICT: FAIL\nFINDINGS:\n- [BUG] a.js:10 — broken');
        expect(verdict).toBe('fail');
        expect(findings).toContain('[BUG] a.js:10');
    });
    it('last VERDICT wins (template restatements ignored)', () => {
        const { verdict } = parseReviewVerdict(
            'template says "VERDICT: PASS or VERDICT: FAIL"…\nreal answer:\nVERDICT: FAIL\nFINDINGS: none');
        expect(verdict).toBe('fail');
    });
    it('is case-insensitive', () => {
        expect(parseReviewVerdict('verdict: pass').verdict).toBe('pass');
    });
    it('no verdict → unknown (gate must not deadlock)', () => {
        const { verdict, findings } = parseReviewVerdict('I looked around, seems fine.');
        expect(verdict).toBe('unknown');
        expect(findings).toContain('seems fine');
    });
    it('tolerates empty/null input', () => {
        expect(parseReviewVerdict('').verdict).toBe('unknown');
        expect(parseReviewVerdict(null).verdict).toBe('unknown');
    });
});

describe('childTokenBudget', () => {
    it('no parent budget → 0 (inherit global config)', () => {
        expect(childTokenBudget(0, 0)).toBe(0);
        expect(childTokenBudget(null, 123)).toBe(0);
        expect(childTokenBudget(-5, 0)).toBe(0);
    });
    it('20% of the parent budget when plenty remains', () => {
        expect(childTokenBudget(100000, 0)).toBe(20000);
        expect(childTokenBudget(100000, 50000)).toBe(20000);
    });
    it('capped by the unspent remainder', () => {
        expect(childTokenBudget(100000, 90000)).toBe(10000);
    });
    it('floors at 5000 so a child is never starved', () => {
        expect(childTokenBudget(10000, 0)).toBe(5000);       // 20% = 2000 → floor
        expect(childTokenBudget(100000, 99000)).toBe(5000);  // remainder 1000 → floor
    });
});

describe('isPathInScope', () => {
    const WS = 'C:\\ws\\proj';

    it('empty/null scope = unrestricted', () => {
        expect(isPathInScope('C:/ws/proj/src/a.js', null, WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/src/a.js', [], WS)).toBe(true);
    });

    it('workspace-relative dir prefix', () => {
        expect(isPathInScope('C:/ws/proj/src/mod/a.js', ['src/mod'], WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/src/other/a.js', ['src/mod'], WS)).toBe(false);
    });

    it('exact relative file entry', () => {
        expect(isPathInScope('C:/ws/proj/docs/x.md', ['docs/x.md'], WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/docs/y.md', ['docs/x.md'], WS)).toBe(false);
    });

    it('absolute prefix + windows backslashes + case-insensitive', () => {
        expect(isPathInScope('C:\\ws\\proj\\SRC\\a.js', ['C:/ws/proj/src'], WS)).toBe(true);
        expect(isPathInScope('D:/elsewhere/a.js', ['C:/ws/proj/src'], WS)).toBe(false);
    });

    it('glob patterns', () => {
        expect(isPathInScope('C:/ws/proj/src/x/__tests__/a.test.js', ['**/__tests__/**'], WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/src/a.test.js', ['**/*.test.*'], WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/src/a.js', ['**/*.test.*'], WS)).toBe(false);
        expect(isPathInScope('C:/ws/proj/docs/x.md', ['docs/*.md'], WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/docs/deep/x.md', ['docs/*.md'], WS)).toBe(false); // * ≠ across dirs
    });

    it('tester default patterns allow test files, block implementation', () => {
        expect(isPathInScope('C:/ws/proj/src/modules/__tests__/Foo.test.js', TESTER_WRITE_PATTERNS, WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/tests/e2e/run.spec.ts', TESTER_WRITE_PATTERNS, WS)).toBe(true);
        expect(isPathInScope('C:/ws/proj/src/modules/Foo.js', TESTER_WRITE_PATTERNS, WS)).toBe(false);
    });

    it('WRITE_ENFORCED_TOOLS covers the mutating tools and not read tools', () => {
        expect(WRITE_ENFORCED_TOOLS.has('write_file')).toBe(true);
        expect(WRITE_ENFORCED_TOOLS.has('delete_file')).toBe(true);
        expect(WRITE_ENFORCED_TOOLS.has('move_file')).toBe(true);
        expect(WRITE_ENFORCED_TOOLS.has('read_file')).toBe(false);
        expect(WRITE_ENFORCED_TOOLS.has('run_command')).toBe(false);
    });
});

describe('scopesOverlap', () => {
    it('disjoint dir prefixes do not overlap', () => {
        expect(scopesOverlap(['src/a'], ['src/b'])).toBe(false);
        expect(scopesOverlap(['src/a', 'docs'], ['src/b'])).toBe(false);
    });
    it('nested prefixes overlap', () => {
        expect(scopesOverlap(['src'], ['src/a'])).toBe(true);
        expect(scopesOverlap(['src/a/deep'], ['src/a'])).toBe(true);
    });
    it('identical entries overlap', () => {
        expect(scopesOverlap(['docs/x.md'], ['docs/x.md'])).toBe(true);
    });
    it('null/empty claim = claims everything', () => {
        expect(scopesOverlap(null, ['src/a'])).toBe(true);
        expect(scopesOverlap([], ['src/a'])).toBe(true);
        expect(scopesOverlap(null, null)).toBe(true);
    });
    it('globs are conservatively overlapping', () => {
        expect(scopesOverlap(['**/*.test.*'], ['src/a'])).toBe(true);
        expect(scopesOverlap(TESTER_WRITE_PATTERNS, ['src/mod'])).toBe(true);
    });
    it('absolute vs relative suffix heuristic', () => {
        expect(scopesOverlap(['C:/ws/proj/src/a'], ['src/a'])).toBe(true);
        expect(scopesOverlap(['C:/ws/proj/src/a'], ['src/b'])).toBe(false);
    });
});

describe('SafetyLimits subagent_review', () => {
    it('defaults to off', () => {
        expect(SAFETY_DEFAULTS.subagentReview).toBe('off');
        expect(normalizeSafetyLimits({}).subagentReview).toBe('off');
    });
    it('accepts on/off, rejects junk', () => {
        expect(normalizeSafetyLimits({ subagent_review: 'on' }).subagentReview).toBe('on');
        expect(normalizeSafetyLimits({ subagent_review: 'off' }).subagentReview).toBe('off');
        expect(normalizeSafetyLimits({ subagent_review: 'maybe' }).subagentReview).toBe('off');
        expect(normalizeSafetyLimits({ subagent_review: 1 }).subagentReview).toBe('off');
    });
});
