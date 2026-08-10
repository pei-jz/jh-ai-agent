// Validation for the Templates and Skills tabs.
//
// Both create something addressable as a SLASH COMMAND, so the name is not
// cosmetic: an invalid one produces a command that can never be invoked, and the old
// flow only discovered that after saving. The rules were inline in two click
// handlers, which is why they had drifted (skills accepted a name the template tab
// would have rejected).

import { describe, it, expect } from 'vitest';
import { commandNameRefusal, templateRefusal, skillRefusal } from '../lists.js';

describe('commandNameRefusal', () => {
    it('accepts what can actually be typed as a /command', () => {
        for (const ok of ['backlog', 'backlog-register', 'run_tests', 'v2', 'A-b_9']) {
            expect(commandNameRefusal(ok), ok).toBe(null);
        }
    });

    it('refuses characters a slash command cannot carry', () => {
        for (const bad of ['has space', 'slash/es', 'dot.ted', 'paren(s)', '日本語', 'a@b']) {
            expect(commandNameRefusal(bad), bad).toBeTruthy();
        }
    });

    it('refuses an empty name', () => {
        expect(commandNameRefusal('')).toBeTruthy();
        expect(commandNameRefusal('   ')).toBeTruthy();
        expect(commandNameRefusal(undefined)).toBeTruthy();
    });
});

describe('templateRefusal', () => {
    const ok = { key: 'backlog', label: 'Backlog', prompt: 'Register this task' };

    it('accepts a complete template', () => {
        expect(templateRefusal(ok)).toBe(null);
    });

    it('checks the command name first — it is the hardest to fix later', () => {
        expect(templateRefusal({ ...ok, key: 'has space' })).toContain('letters');
    });

    it('requires a display name and a prompt body', () => {
        expect(templateRefusal({ ...ok, label: '  ' })).toContain('display name');
        expect(templateRefusal({ ...ok, prompt: '   ' })).toContain('prompt');
    });
});

describe('skillRefusal', () => {
    const ok = { name: 'backlog-register', content: '# Register' };

    it('accepts a complete skill', () => {
        expect(skillRefusal(ok)).toBe(null);
    });

    it('applies the SAME name rule as templates', () => {
        // These two checks had drifted apart while they lived in separate handlers.
        expect(skillRefusal({ ...ok, name: 'has space' })).toContain('letters');
    });

    it('requires content', () => {
        expect(skillRefusal({ ...ok, content: '   ' })).toContain('content');
    });

    it('skips the name check when EDITING — the name is the file', () => {
        // The form does not even show the field, so there is nothing to validate.
        expect(skillRefusal({ content: '# x' }, true)).toBe(null);
        expect(skillRefusal({ name: '', content: '# x' }, true)).toBe(null);
    });
});
