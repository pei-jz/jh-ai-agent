// Guards against the failure that produced this module: a tool gets added to
// the schemas and the dispatcher, but nobody remembers the hand-written
// allowlists — so an agent in research mode had `run_command` and no
// `read_office`, and tried to parse spreadsheets through PowerShell.

import { describe, it, expect } from 'vitest';
import { READ_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS, WEB_TOOLS, TASK_TOOLS, toolsOf } from '../toolSets.js';
import { TOOL_DEFINITIONS } from '../toolSchemas.js';
import { AGENT_MODES } from '../../AgentModes.js';
import { SUBAGENT_ROLES } from '../../agent/SubagentRoles.js';

const ALL = new Set(TOOL_DEFINITIONS.map(t => t.name));
const GROUPS = { READ_TOOLS, EDIT_TOOLS, OUTPUT_TOOLS, WEB_TOOLS, TASK_TOOLS };

describe('toolSets are real tools', () => {
    it.each(Object.entries(GROUPS))('%s only names tools that exist', (_name, group) => {
        for (const t of group) expect(ALL.has(t), `${t} is not a registered tool`).toBe(true);
    });

    it('no tool appears in two groups (a name has one meaning)', () => {
        const seen = new Set();
        for (const group of Object.values(GROUPS)) {
            for (const t of group) {
                expect(seen.has(t), `${t} is in more than one group`).toBe(false);
                seen.add(t);
            }
        }
    });

    it('READ_TOOLS cannot modify a file', () => {
        for (const t of READ_TOOLS) {
            expect(EDIT_TOOLS).not.toContain(t);
            expect(OUTPUT_TOOLS).not.toContain(t);
        }
    });
});

describe('toolsOf', () => {
    it('merges groups and drops duplicates, keeping first-seen order', () => {
        expect(toolsOf(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('handles an empty call', () => {
        expect(toolsOf()).toEqual([]);
    });
});

// ── The anti-rot checks ────────────────────────────────────────────────────
// Any preset that can read source files must also be able to read the OTHER
// file types a real project stores its content in. Without this, adding a
// reader silently leaves every preset blind to it.
const READER_COMPANIONS = ['read_office', 'symbol_search'];

describe('presets stay in sync with the read group', () => {
    const modePresets = Object.entries(AGENT_MODES)
        .filter(([, m]) => Array.isArray(m.behavior.enabled_tools))
        .map(([id, m]) => [`mode:${id}`, m.behavior.enabled_tools]);
    const rolePresets = Object.entries(SUBAGENT_ROLES)
        .filter(([, r]) => Array.isArray(r.tools))
        .map(([id, r]) => [`role:${id}`, r.tools]);
    const presets = [...modePresets, ...rolePresets];

    it('there ARE presets to check (a rename must not silently empty this suite)', () => {
        expect(presets.length).toBeGreaterThanOrEqual(4);
    });

    it.each(presets)('%s: whatever can read_file can also read Office and symbols', (_id, tools) => {
        if (!tools.includes('read_file')) return;
        for (const companion of READER_COMPANIONS) {
            expect(tools, `missing ${companion}`).toContain(companion);
        }
    });

    it.each(presets)('%s: a preset with run_command is never left without read_office', (_id, tools) => {
        // The exact shape of the reported bug: shell available, reader absent.
        if (tools.includes('run_command')) expect(tools).toContain('read_office');
    });

    it.each(presets)('%s: only names registered tools', (_id, tools) => {
        for (const t of tools) expect(ALL.has(t), `${t} is not a registered tool`).toBe(true);
    });
});

describe('mode presets', () => {
    it('develop stays unrestricted — narrowing it would be a regression', () => {
        expect(AGENT_MODES.develop.behavior.enabled_tools).toBeUndefined();
    });

    it('research can read and report but cannot edit source', () => {
        const tools = AGENT_MODES.research.behavior.enabled_tools;
        expect(tools).toContain('read_office');
        expect(tools).toContain('write_xlsx');       // a spreadsheet deliverable
        expect(tools).toContain('write_file');       // the report file
        expect(tools).not.toContain('multi_replace_file_content');
        expect(tools).not.toContain('delete_file');
    });

    it('automation keeps its shell-plus-files character', () => {
        const tools = AGENT_MODES.automation.behavior.enabled_tools;
        expect(tools).toEqual(expect.arrayContaining(['run_command', 'read_office', ...EDIT_TOOLS]));
    });
});
