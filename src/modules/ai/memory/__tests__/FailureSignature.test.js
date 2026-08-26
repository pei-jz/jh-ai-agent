// FailureSignature — the rules that decide "is this the same failure as last
// time?". Pinned by tests because a signature that silently drifts turns the
// whole memory layer into noise: cards stop matching, or worse, match the wrong
// failure. Error strings below are copied from the real handlers.

import { describe, it, expect } from 'vitest';
import {
    redact, errorKind, extractLoc, normalizeMessage, normalizeError,
    signatureOf, extOf, targetOf, argShapeOf, fingerprint, relativeTarget,
    SECRET_PATTERNS, ERROR_KINDS,
} from '../FailureSignature.js';

describe('redact', () => {
    it('masks API keys, bearer tokens and JWTs', () => {
        expect(redact('key sk-abcdefghij0123456789 used')).toContain('[REDACTED:key]');
        expect(redact('Authorization: Bearer abcdef1234567890')).toContain('[REDACTED:bearer]');
        expect(redact('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:key]');
        expect(redact('tok eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJ')).toContain('[REDACTED:jwt]');
    });

    it('masks connection strings and inline URL credentials', () => {
        expect(redact('postgres://u:p@host:5432/db')).toBe('[REDACTED:connstr]');
        expect(redact('https://user:pass@example.com/x')).toBe('[REDACTED:urlcreds]');
    });

    it('masks secret-ish assignments but keeps the field name', () => {
        const out = redact('api_key=hunter2secret, password: "correct horse"');
        expect(out).toContain('api_key=[REDACTED:secret]');
        expect(out).not.toContain('hunter2secret');
    });

    it('does NOT mask ordinary settings that merely contain "token"', () => {
        // max_tokens is a parameter, not a credential — masking it would destroy
        // the very error text we want to classify.
        expect(redact('{"max_tokens": 4096}')).toBe('{"max_tokens": 4096}');
    });

    it('masks the home-directory account name, including non-ASCII ones', () => {
        // The account name on this project is Japanese; an [A-Za-z] name class
        // would leave it in the file.
        const out = redact('C:\\Users\\裴京植\\proj\\a.js not found');
        expect(out).toContain('C:\\Users\\[REDACTED:user]');
        expect(out).not.toContain('裴京植');
        expect(redact('/home/tanaka/src/a.js')).toContain('/home/[REDACTED:user]');
    });

    it('masks email addresses', () => {
        expect(redact('sent to a.b@example.co.jp ok')).toContain('[REDACTED:email]');
    });

    it('leaves clean text untouched and never throws on non-strings', () => {
        expect(redact('plain error message')).toBe('plain error message');
        expect(redact(null)).toBe('');
        expect(redact(undefined)).toBe('');
    });

    it('every pattern is global (a second occurrence must also be masked)', () => {
        for (const { re } of SECRET_PATTERNS) expect(re.flags).toContain('g');
    });
});

describe('errorKind', () => {
    const cases = [
        ['Error: File deletion denied — target is outside the workspace and was not approved.', 'permission_denied'],
        ['Error: Execution blocked by user permission settings (Deny).', 'permission_denied'],
        ['[❌ SYNTAX GATE — invalid JSON after this edit (line 12)]: Unexpected token }', 'syntax_gate'],
        ['error[E0412]: cannot find type `Foo` in this scope', 'build_failure'],
        ['Tests: 2 failed | 5 passed', 'test_failure'],
        ['Error: anchor does not match — the file changed since it was read', 'edit_mismatch'],
        ['Error: Invalid line range 900-950', 'invalid_range'],
        ['File does not exist: C:\\x\\y.js', 'not_found'],
        ['Destination already exists: out.txt (pass overwrite=true to replace)', 'conflict'],
        ["Invalid regex 'foo(': unclosed group", 'invalid_pattern'],
        ['Error: symbol_search requires a non-empty "query" (the symbol name to find).', 'invalid_args'],
        ['Error: Command timed out after 60 seconds and was killed.', 'timeout'],
        ['fetch failed: ECONNREFUSED 127.0.0.1:1430', 'network'],
        ['Error: run_subtask is not available in this context.', 'unavailable'],
        ['something entirely unexpected happened', 'unknown'],
    ];
    it.each(cases)('classifies %j as %s', (text, kind) => {
        expect(errorKind(text)).toBe(kind);
    });

    it('puts permission_denied ahead of everything else', () => {
        // A refusal that also mentions a missing file must not be filed as
        // not_found — the agent would learn to "fix" the user's decision.
        expect(errorKind('User Denied file write. File does not exist yet.')).toBe('permission_denied');
        expect(ERROR_KINDS[0].kind).toBe('permission_denied');
    });
});

describe('extractLoc', () => {
    it('pulls file:line out of a message', () => {
        expect(extractLoc('anchor mismatch at C:\\p\\ConfigView.js:816 (expected)')).toBe('ConfigView.js:816');
    });
    it('falls back to a bare line number', () => {
        expect(extractLoc('invalid JSON after this edit (line 12)')).toBe('line 12');
    });
    it('returns empty when there is no location', () => {
        expect(extractLoc('network down')).toBe('');
    });
});

describe('normalizeMessage', () => {
    it('replaces absolute paths', () => {
        expect(normalizeMessage('cannot read C:\\a\\b\\c.js now')).toBe('cannot read <path> now');
        expect(normalizeMessage('cannot read /var/log/app.log now')).toBe('cannot read <path> now');
    });
    it('replaces hashes and timestamps', () => {
        expect(normalizeMessage('at 2026-08-10T12:00:00Z rev 2cdc7bc9')).toBe('at <ts> rev <hash>');
    });
    it('masks volatile offsets but KEEPS small meaningful numbers', () => {
        // Blanket digit-stripping would merge "expected 3 args" with
        // "expected 5 args" — different failures.
        expect(normalizeMessage('JSON at position 4213: expected 3 args')).toBe('JSON at position <n>: expected 3 args');
    });
    it('collapses whitespace', () => {
        expect(normalizeMessage('a   b\n c')).toBe('a b c');
    });
});

describe('signatureOf / normalizeError', () => {
    it('is stable across differing paths and line numbers', () => {
        const a = normalizeError('anchor does not match at C:\\x\\Foo.svelte:12');
        const b = normalizeError('anchor does not match at D:\\other\\Bar.svelte:998');
        const sigA = signatureOf({ tool: 'multi_replace_file_content', kind: a.kind, ext: '.svelte' });
        const sigB = signatureOf({ tool: 'multi_replace_file_content', kind: b.kind, ext: '.svelte' });
        expect(sigA).toBe(sigB);
        expect(sigA).toBe('multi_replace_file_content|edit_mismatch|.svelte');
    });

    it('separates different tools, kinds and file types', () => {
        const base = { tool: 'write_file', kind: 'edit_mismatch', ext: '.js' };
        expect(signatureOf(base)).not.toBe(signatureOf({ ...base, tool: 'replace_lines' }));
        expect(signatureOf(base)).not.toBe(signatureOf({ ...base, kind: 'not_found' }));
        expect(signatureOf(base)).not.toBe(signatureOf({ ...base, ext: '.rs' }));
    });

    it('redacts before classifying, so no secret can reach the signature path', () => {
        const { message } = normalizeError('auth failed with sk-abcdefghij0123456789');
        expect(message).not.toContain('sk-abcdefghij');
    });

    it('keeps the location out of the signature but available separately', () => {
        const n = normalizeError('anchor does not match at Foo.svelte:12');
        expect(n.loc).toBe('Foo.svelte:12');
        expect(signatureOf({ tool: 't', kind: n.kind, ext: '.svelte' })).not.toContain('12');
    });
});

describe('extOf / targetOf / argShapeOf', () => {
    it('extracts a lowercased extension', () => {
        expect(extOf('C:\\a\\B.SVELTE')).toBe('.svelte');
        expect(extOf('/a/b/Makefile')).toBe('');
        expect(extOf('')).toBe('');
    });
    it('finds the acted-on path under any of the usual arg names', () => {
        expect(targetOf({ path: 'a.js' })).toBe('a.js');
        expect(targetOf({ from: 'a.js', to: 'b.js' })).toBe('a.js');
        expect(targetOf({ pattern: 'x' })).toBe('');
        expect(targetOf(null)).toBe('');
    });
    it('describes argument SHAPE, never values', () => {
        expect(argShapeOf({ path: 'secret/path', anchor: 'x' })).toBe('anchor,path');
        expect(argShapeOf({ path: 'p', unused: null })).toBe('path');
    });
});

// The same file arrives named three ways, because a tool call carries whatever
// the model happened to write. Stored raw, the store grows one card per spelling
// — measured on the real store, 18 files existed under two or three names.
describe('relativeTarget', () => {
    it('gives one spelling to every way of naming the same file', () => {
        for (const p of ['C:/ws/src/a.js', 'C:\\ws\\src\\a.js', 'src/a.js', 'src\\a.js']) {
            expect(relativeTarget(p, 'C:/ws')).toBe('src/a.js');
        }
    });

    it('matches the workspace case-insensitively, as Windows does', () => {
        expect(relativeTarget('c:\\WS\\src\\a.js', 'C:/ws')).toBe('src/a.js');
    });

    it('preserves the file\'s OWN casing — it still has to be openable', () => {
        expect(relativeTarget('C:/ws/src/MemoryTab.svelte', 'C:/ws')).toBe('src/MemoryTab.svelte');
    });

    it('leaves a path outside the workspace absolute rather than mangling it', () => {
        expect(relativeTarget('D:/other/x.js', 'C:/ws')).toBe('D:/other/x.js');
    });

    it('tolerates a trailing separator on the workspace', () => {
        expect(relativeTarget('C:/ws/src/a.js', 'C:/ws/')).toBe('src/a.js');
    });

    it('is a no-op without a workspace, and survives junk', () => {
        expect(relativeTarget('C:/ws/src/a.js')).toBe('C:/ws/src/a.js');
        expect(relativeTarget(null, 'C:/ws')).toBe('');
        expect(relativeTarget('src/a.js', null)).toBe('src/a.js');
    });

    // The target reaches this function through redact(); the workspace root does
    // not. For a workspace under the user's home directory — the ordinary
    // layout — the two therefore never matched, and every locator card kept an
    // absolute path. It went unnoticed because THIS project's workspace sits
    // outside the home directory, the one arrangement where it cannot happen.
    it('still matches when the target was redacted and the root was not', () => {
        const target = redact('C:\\Users\\alice\\projects\\foo\\src\\a.js');
        expect(target).toContain('[REDACTED:user]');
        expect(relativeTarget(target, 'C:\\Users\\alice\\projects\\foo')).toBe('src/a.js');
    });

    it('does not treat a same-prefixed sibling as inside the workspace', () => {
        // "C:/ws2/..." starts with "C:/ws" as a STRING but is a different folder.
        expect(relativeTarget('C:/ws2/src/a.js', 'C:/ws')).toBe('C:/ws2/src/a.js');
    });
});

describe('fingerprint', () => {
    it('is deterministic and fixed-width', () => {
        expect(fingerprint('abc')).toBe(fingerprint('abc'));
        expect(fingerprint('abc')).toHaveLength(8);
        expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    });
});
