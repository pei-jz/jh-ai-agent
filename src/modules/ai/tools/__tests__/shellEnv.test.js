import { describe, it, expect } from 'vitest';
import { shellGuidance, decorateRunCommand } from '../shellEnv.js';

const PS = {
    os: 'windows',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
    display: 'Windows PowerShell 5.1 (powershell.exe)',
};
const SH = { os: 'linux', program: 'sh', args: ['-c'], display: 'POSIX sh' };

describe('shellGuidance', () => {
    it('names the OS, the shell and the exact invocation', () => {
        const g = shellGuidance(PS);
        expect(g).toContain('windows');
        expect(g).toContain('Windows PowerShell 5.1');
        expect(g).toContain('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command');
    });

    it('warns off bash explicitly — the actual failure mode', () => {
        expect(shellGuidance(PS)).toMatch(/do not assume bash/i);
    });

    it('carries the PowerShell traps that break a first attempt', () => {
        const g = shellGuidance(PS);
        expect(g).toContain('&&');           // the #1 chaining mistake
        expect(g).toContain('2>$null');
        expect(g).toContain('$env:');
        expect(g).toMatch(/Get-Content -TotalCount/);
    });

    it('gives sh its own note — POSIX sh is not bash either', () => {
        const g = shellGuidance(SH);
        expect(g).toContain('POSIX');
        expect(g).toContain('bash -c');
        // PowerShell advice must not leak onto a Unix host.
        expect(g).not.toContain('$env:');
    });

    it('treats pwsh like PowerShell', () => {
        expect(shellGuidance({ ...PS, program: 'pwsh' })).toContain('2>$null');
    });

    it('says NOTHING when the shell is unknown, rather than guessing', () => {
        expect(shellGuidance(null)).toBe('');
        expect(shellGuidance({})).toBe('');
        expect(shellGuidance({ program: '  ' })).toBe('');
        expect(shellGuidance('windows')).toBe('');
    });

    it('falls back to the program name when no display name was given', () => {
        expect(shellGuidance({ os: 'linux', program: 'sh' })).toContain('through sh');
    });
});

describe('decorateRunCommand', () => {
    const defs = () => [
        { name: 'read_file', description: 'Read a file.' },
        { name: 'run_command', description: 'Execute a shell command.' },
    ];

    it('extends only run_command, leaving the original text in place', () => {
        const out = decorateRunCommand(defs(), PS);
        expect(out[1].description.startsWith('Execute a shell command.')).toBe(true);
        expect(out[1].description).toContain('Windows PowerShell');
        expect(out[0].description).toBe('Read a file.');
    });

    it('does not mutate the definitions it was given', () => {
        const original = defs();
        decorateRunCommand(original, PS);
        expect(original[1].description).toBe('Execute a shell command.');
    });

    it('is idempotent — a second pass must not double the text or churn the cache', () => {
        const once = decorateRunCommand(defs(), PS);
        const twice = decorateRunCommand(once, PS);
        expect(twice[1].description).toBe(once[1].description);
        expect(twice).toBe(once);   // same array: nothing changed
    });

    it('returns the input untouched when the shell is unknown', () => {
        const input = defs();
        expect(decorateRunCommand(input, null)).toBe(input);
    });

    it('tolerates a missing or non-array input', () => {
        expect(decorateRunCommand(null, PS)).toBe(null);
        expect(decorateRunCommand(undefined, PS)).toBe(undefined);
    });

    it('handles a definition list with no run_command (allowlisted-out task)', () => {
        const input = [{ name: 'read_file', description: 'x' }];
        expect(decorateRunCommand(input, PS)).toBe(input);
    });
});

describe('wording', () => {
    it('drops the executable from the second mention instead of repeating it', () => {
        const g = shellGuidance(PS);
        expect(g).toContain('Write Windows PowerShell 5.1 syntax');
        expect(g.match(/powershell\.exe/g)).toHaveLength(1);
    });

    it('keeps a display name that has no parenthetical intact', () => {
        expect(shellGuidance(SH)).toContain('Write POSIX sh syntax');
    });
});
