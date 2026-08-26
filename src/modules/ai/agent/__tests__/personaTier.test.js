// Which kind of agent a task's prompt describes.
//
// This replaced a two-way branch in ContextBuilder ("does the allowlist contain any
// editing tool?") that produced either an elite software engineer or a one-paragraph
// helper. The effect was that a task which reads a workbook and writes a report got
// the SLIM prompt — because slim was originally an optimisation for tiny app-intent
// calls, not a description of a general-purpose agent.

import { describe, it, expect } from 'vitest';
import { personaTier, personaFor, wantsEditingRules, PERSONA_TIERS } from '../personaTier.js';

describe('personaTier', () => {
    it('is develop when the task can edit AND run', () => {
        expect(personaTier(['read_file', 'write_file', 'run_command'])).toBe('develop');
    });

    it('is develop for shell work even without editing tools', () => {
        // An automation task acts on the machine and has to verify what it did —
        // that is the same loop, not a general-purpose one.
        expect(personaTier(['read_file', 'run_command'])).toBe('develop');
    });

    it('is general when it can produce a deliverable but not run commands', () => {
        expect(personaTier(['read_file', 'read_office', 'write_xlsx', 'finish_task'])).toBe('general');
        expect(personaTier(['read_file', 'write_docx'])).toBe('general');
        expect(personaTier(['read_file', 'write_file'])).toBe('general');
        expect(personaTier(['read_office', 'update_xlsx'])).toBe('general');
    });

    it('is scoped for a read-only lookup or a single app intent', () => {
        expect(personaTier(['read_file', 'grep_search', 'finish_task'])).toBe('scoped');
        expect(personaTier(['get_buffer', 'finish_task'])).toBe('scoped');
        expect(personaTier([])).toBe('scoped');
        expect(personaTier(null)).toBe('scoped');
    });

    it('lets an explicit tier win over the inference', () => {
        // A general-purpose task can say so even when it happens to hold editing tools.
        expect(personaTier(['write_file', 'run_command'], 'general')).toBe('general');
        expect(personaTier([], 'develop')).toBe('develop');
    });

    it('ignores a bogus explicit tier rather than trusting it', () => {
        expect(personaTier(['write_file', 'run_command'], 'wizard')).toBe('develop');
        expect(personaTier(['read_file'], '')).toBe('scoped');
    });
});

describe('personaFor', () => {
    it('names the language requirement in every tier', () => {
        for (const tier of PERSONA_TIERS) {
            expect(personaFor(tier, 'Japanese'), tier).toContain('Japanese');
        }
    });

    it('describes a software engineer for develop', () => {
        const p = personaFor('develop', 'English');
        expect(p).toContain('software engineer');
        expect(p).toContain('Verify after every change');
    });

    // Reported by the user: the agent fixes the thing that was pointed at and
    // nothing else. The prompt said so — "prefer doing the work over lengthy
    // introspection" — and scoped root-cause thinking to failures only, so a
    // symptom named in a REQUEST was simply a symptom fixed.
    it('asks develop for the cause, not just the symptom it was handed', () => {
        const p = personaFor('develop', 'English');
        expect(p).toContain('Find the cause, not just the symptom');
        expect(p).toContain('same fault exists elsewhere');
        expect(p).not.toMatch(/over lengthy introspection/);
    });

    // The line it replaced was aimed at over-deliberation, and that aim was
    // right — the fix must not turn the agent into a commentator.
    it('still tells develop to act rather than narrate', () => {
        expect(personaFor('develop', 'English')).toContain('Prefer acting over narrating');
    });

    // The same honesty the general tier already required. A gap left unmentioned
    // reads as a gap that was missed.
    it('asks develop to state what it did NOT do', () => {
        expect(personaFor('develop', 'English')).toContain('did NOT do');
    });

    it('describes GENERAL work on its own terms, not as a smaller develop', () => {
        // The old slim prompt told a report-writing agent nothing about how to do its
        // job. These are the four things it actually needs.
        const p = personaFor('general', 'Japanese');
        expect(p).not.toContain('software engineer');
        expect(p).toContain('read_office');        // never shell out at a workbook
        expect(p).toContain('write_docx');         // the artefact to produce
        expect(p).toContain('Check your own work');
        expect(p).toContain('could not determine'); // say what is missing
    });

    it('keeps scoped short — it is one call, and length is pure cost', () => {
        const scoped = personaFor('scoped', 'English');
        expect(scoped.length).toBeLessThan(personaFor('general', 'English').length / 2);
    });
});

describe('wantsEditingRules', () => {
    it('is develop only', () => {
        // The heavy block is about editing source and running commands; on a
        // report-writing task it is noise the model has to read past.
        expect(wantsEditingRules('develop')).toBe(true);
        expect(wantsEditingRules('general')).toBe(false);
        expect(wantsEditingRules('scoped')).toBe(false);
    });
});
