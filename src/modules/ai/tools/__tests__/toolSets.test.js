// The guard that `run_subtask` needed and did not have.
//
// Grouping the tool lists in one file removed the SECOND place to forget a new
// tool, but not the first: a tool still has to be typed into a group by hand.
// `run_subtask` was wired into the schemas and the dispatcher and into no group,
// so the whole sub-agent engine was invisible in `general` — the default mode —
// and only worked if the user happened to switch to `develop`. Nothing failed;
// the feature was simply never offered.
//
// These tests close both directions: a built-in with no group fails, and a group
// naming a tool that does not exist fails.

import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../toolSchemas.js';
import { ALL_GROUPS, READ_ONLY_TOOLS, READ_TOOLS, toolsOf } from '../toolSets.js';
import { AGENT_MODES } from '../../AgentModes.js';

const builtinNames = TOOL_DEFINITIONS.map(t => t.name);
const groupedNames = new Set(ALL_GROUPS.flat());

describe('toolSets covers every built-in tool', () => {
    it('no built-in belongs to zero groups', () => {
        const orphans = builtinNames.filter(n => !groupedNames.has(n));
        expect(orphans, `add these to a group in tools/toolSets.js: ${orphans.join(', ')}`)
            .toEqual([]);
    });

    it('no group names a tool that does not exist', () => {
        const known = new Set(builtinNames);
        const ghosts = [...groupedNames].filter(n => !known.has(n));
        expect(ghosts, `these are in a group but have no schema: ${ghosts.join(', ')}`)
            .toEqual([]);
    });
});

describe('READ_ONLY_TOOLS really is read-only', () => {
    // The sub-agent roles advertise "read-only" to the orchestrating model. A
    // shell makes that claim false, so the split has to hold.
    it('excludes run_command', () => {
        expect(READ_ONLY_TOOLS).not.toContain('run_command');
    });

    it('excludes every mutating tool', () => {
        const mutating = ['write_file', 'multi_replace_file_content', 'replace_lines',
            'delete_file', 'move_file', 'write_xlsx', 'update_xlsx', 'write_docx',
            'git_commit'];
        for (const n of mutating) expect(READ_ONLY_TOOLS).not.toContain(n);
    });

    it('READ_TOOLS is READ_ONLY_TOOLS plus the shell', () => {
        expect(READ_TOOLS).toEqual([...READ_ONLY_TOOLS, 'run_command']);
    });
});

describe('mode presets offer delegation', () => {
    // The regression this whole file exists for: the sub-agent engine must be
    // reachable from the DEFAULT mode, not only from `develop`.
    it('general offers run_subtask', () => {
        expect(AGENT_MODES.general.behavior.enabled_tools).toContain('run_subtask');
    });

    it('every preset that restricts tools still offers run_subtask', () => {
        for (const [id, mode] of Object.entries(AGENT_MODES)) {
            const list = mode.behavior.enabled_tools;
            if (!list) continue;   // `develop` = no restriction = has everything
            expect(list, `${id} cannot delegate`).toContain('run_subtask');
        }
    });

    it('every preset can terminate, deliver and ask', () => {
        for (const [id, mode] of Object.entries(AGENT_MODES)) {
            const list = mode.behavior.enabled_tools;
            if (!list) continue;
            for (const n of ['finish_task', 'present_result', 'ask_user']) {
                expect(list, `${id} is missing ${n}`).toContain(n);
            }
        }
    });

    it('research still cannot edit source', () => {
        const list = AGENT_MODES.research.behavior.enabled_tools;
        for (const n of ['multi_replace_file_content', 'replace_lines', 'delete_file', 'move_file']) {
            expect(list).not.toContain(n);
        }
    });
});

describe('toolsOf', () => {
    it('de-duplicates while preserving first-seen order', () => {
        expect(toolsOf(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    });
});

// apply_patch was added after the groups existed, which is exactly when the last
// tool went missing. It is a file-mutating tool, so several INDEPENDENT lists
// have to know about it — a plan gate that does not, for instance, would let the
// agent edit files before the user approved anything.
describe('apply_patch is wired into every list that matters', () => {
    it('is a real built-in with a schema', () => {
        expect(builtinNames).toContain('apply_patch');
    });

    it('belongs to EDIT_TOOLS, so presets and write-scope cover it', async () => {
        const { EDIT_TOOLS } = await import('../toolSets.js');
        expect(EDIT_TOOLS).toContain('apply_patch');
    });

    it('is blocked by the plan-first gate', async () => {
        const { PLAN_GATED_TOOLS } = await import('../../agent/SafetyGuards.js');
        expect(PLAN_GATED_TOOLS.has('apply_patch')).toBe(true);
    });

    it('is subject to sub-agent write scope', async () => {
        const { WRITE_ENFORCED_TOOLS } = await import('../../agent/SubagentRoles.js');
        expect(WRITE_ENFORCED_TOOLS.has('apply_patch')).toBe(true);
    });

    it('counts as a WRITE for parallel conflict detection', async () => {
        const { callTargets } = await import('../../agent/ConflictDetector.js');
        const t = callTargets({ name: 'apply_patch', args: { path: 'src/a.js', patch: '@@ -1 +1 @@\n-a\n+b' } });
        expect(t.write).toContain('src/a.js');
    });

    it('is NOT offered to the read-only sub-agent roles', async () => {
        const { resolveRole } = await import('../../agent/SubagentRoles.js');
        expect(resolveRole('reviewer').tools).not.toContain('apply_patch');
        expect(resolveRole('researcher').tools).not.toContain('apply_patch');
    });

    it('counts as an edit for the exploration-cost metric', async () => {
        const { explorationCost } = await import('../../memory/SessionMetrics.js');
        expect(explorationCost([
            { tool: 'read_file' }, { tool: 'grep_search' }, { tool: 'apply_patch' },
        ])).toBe(2);
    });
});
