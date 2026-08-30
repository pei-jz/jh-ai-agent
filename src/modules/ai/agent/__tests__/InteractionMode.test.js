// InteractionMode — the "asked vs given a job" axis.
//
// docs/design/information-architecture.md §3. The property that matters most is
// that this is ORTHOGONAL to the agent mode: `ask` must SUBTRACT from whatever
// the mode allowed and never add to it, or "ask" becomes a privilege-escalation
// path around a mode the user deliberately narrowed.

import { describe, it, expect } from 'vitest';
import {
    ASK, BUILD, ASK_TOOLS, normalizeInteraction, interactionOf, isAsk,
    askAllowlist, runShape,
} from '../InteractionMode.js';
import { EDIT_TOOLS, OUTPUT_TOOLS } from '../../tools/toolSets.js';

describe('normalizeInteraction', () => {
    it('recognises ask', () => expect(normalizeInteraction('ask')).toBe(ASK));

    // The safer reading of an unknown value: an unrecognised field must not
    // silently drop plan-first and the write tools.
    it.each([undefined, null, '', 'build', 'BUILD', 'chat', 42, {}])(
        'treats %p as build', (v) => expect(normalizeInteraction(v)).toBe(BUILD));

    it('reads the field off a behavior block', () => {
        expect(interactionOf({ interaction: 'ask' })).toBe(ASK);
        expect(isAsk({ interaction: 'ask' })).toBe(true);
        expect(isAsk({})).toBe(false);
    });
});

describe('ASK_TOOLS', () => {
    it('has no way to change a file', () => {
        for (const t of [...EDIT_TOOLS, ...OUTPUT_TOOLS]) {
            expect(ASK_TOOLS).not.toContain(t);
        }
    });

    // run_command can write. Dropping the approval friction for `ask` is only
    // defensible because an ask run genuinely cannot mutate anything.
    it('has no shell', () => expect(ASK_TOOLS).not.toContain('run_command'));

    it('cannot delegate or plan — both are work shapes', () => {
        expect(ASK_TOOLS).not.toContain('run_subtask');
        expect(ASK_TOOLS).not.toContain('task_progress');
    });

    it('can still read, search, look things up and end the turn', () => {
        for (const t of ['read_file', 'grep_search', 'read_office', 'fetch_url',
                         'finish_task', 'present_result', 'ask_user']) {
            expect(ASK_TOOLS).toContain(t);
        }
    });
});

describe('askAllowlist — subtracts, never adds', () => {
    it('narrows a mode allowlist to what a conversation may call', () => {
        const develop = ['read_file', 'write_file', 'run_command', 'grep_search'];
        expect(askAllowlist(develop).sort()).toEqual(['grep_search', 'read_file']);
    });

    it('does not grant a tool the mode had already removed', () => {
        // research without web access stays without web access when asked.
        const narrowed = ['read_file'];
        expect(askAllowlist(narrowed)).toEqual(['read_file']);
        expect(askAllowlist(narrowed)).not.toContain('fetch_url');
    });

    it('falls back to the ask set when the mode allows everything (null)', () => {
        expect(askAllowlist(null)).toEqual(ASK_TOOLS);
        expect(askAllowlist([])).toEqual(ASK_TOOLS);
    });
});

describe('runShape', () => {
    it('a build run is unchanged — this axis must be inert by default', () => {
        const s = runShape({ enabled_tools: ['read_file', 'write_file'] });
        expect(s).toMatchObject({
            interaction: BUILD, isAsk: false,
            planFirst: true, includeTaskTools: true,
            allowDelegation: true, routePhases: true,
            enabledTools: ['read_file', 'write_file'],
        });
    });

    it('an ask run drops the plan, the checklist, delegation and phase routing', () => {
        const s = runShape({ interaction: 'ask' });
        expect(s).toMatchObject({
            isAsk: true,
            planFirst: false,
            includeTaskTools: false,
            allowDelegation: false,
            routePhases: false,
        });
    });

    it('an ask run keeps the mode allowlist as a ceiling', () => {
        const s = runShape({ interaction: 'ask', enabled_tools: ['read_file', 'write_file'] });
        expect(s.enabledTools).toEqual(['read_file']);
    });

    it('an empty behavior is a build run', () => {
        expect(runShape({}).isAsk).toBe(false);
        expect(runShape().isAsk).toBe(false);
    });
});
