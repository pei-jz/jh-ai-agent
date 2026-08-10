// commandPolicy — risk classification + approval-pattern matching for run_command.
//
// The whole point is a SAFE-by-construction balance between security and the
// friction of approving every command:
//
//   • 'dangerous' → ALWAYS require explicit confirmation. This is the hard
//     safety boundary: it is checked FIRST and can never be auto-approved by the
//     safe-list, the user's "always allow" patterns, or the workspace
//     auto-approve toggle. Destructive / irreversible / exfiltration commands.
//   • 'safe'      → read-only commands (allow-LIST, not deny-list) that may be
//     auto-run without a prompt. Conservative: if we're not sure, it's 'normal'.
//   • 'normal'    → everything else. Prompted, but the user can add an approval
//     PATTERN ("always allow") or enable per-workspace auto-approve.
//
// Pure & unit-tested (commandPolicy.test.js) — no I/O, no DOM.

// ── Dangerous: matched anywhere in the command (case-insensitive). ──────────
// Deliberately broad; a false "dangerous" only costs one extra confirmation,
// whereas a miss could auto-run something destructive.
const DANGEROUS_PATTERNS = [
    // File/dir deletion (POSIX + Windows + PowerShell)
    /(^|[\s;&|(])(rm|rmdir|del|erase|rd|unlink|rimraf)(\s|$)/i,
    /\bremove-item\b/i,
    /(^|[\s;&|(])ri\s+-/i,                       // PS Remove-Item alias with args
    // Disk / filesystem
    /(^|[\s;&|(])dd\s+/i,
    /\b(mkfs\w*|fdisk|diskpart|format)\b/i,
    // Power / process control
    /\b(shutdown|reboot|halt|poweroff|logoff|restart-computer|stop-computer)\b/i,
    /\b(stop-process|taskkill|pkill|killall)\b/i,
    /(^|[\s;&|(])kill\s+/i,
    // Destructive git
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\b/i,
    /\bgit\s+push\b[^\n]*\s(--force|-f|--force-with-lease)\b/i,
    /\bgit\s+(filter-branch|filter-repo)\b/i,
    /\bgit\s+checkout\s+--\s/i,
    // Permissions / ownership / registry
    /\b(chmod|chown|icacls|takeown|attrib)\b/i,
    /\breg\s+(delete|add|import)\b/i,
    // Arbitrary code exec via pipe / eval / download-and-run
    /\b(iex|invoke-expression)\b/i,
    /\|\s*(bash|sh|zsh|iex|invoke-expression)\b/i,
    /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n]*\|\s*(sh|bash|zsh|iex)/i,
    // Package publish / global install (supply-chain / system mutation)
    /\bnpm\s+(publish|unpublish)\b/i,
    /\bnpm\s+(install|i)\b[^\n]*\s(-g|--global)\b/i,
];

// ── Safe: read-only executables (allow-list). Lower-cased first token. ──────
const SAFE_CMDS = new Set([
    // POSIX-ish
    'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'echo', 'find', 'findstr',
    'grep', 'egrep', 'fgrep', 'wc', 'tree', 'whoami', 'hostname', 'date', 'which',
    'where', 'env', 'printenv', 'uname', 'df', 'du', 'stat', 'file', 'basename',
    'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut',
    // PowerShell cmdlets + common aliases (read-only)
    'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls',
    'select-object', 'select', 'sort-object', 'where-object', 'measure-object',
    'measure', 'format-table', 'ft', 'format-list', 'fl', 'format-wide',
    'test-path', 'resolve-path', 'split-path', 'get-location', 'gl', 'get-item',
    'gi', 'get-itemproperty', 'get-date', 'get-command', 'gcm', 'get-help',
    'out-string', 'get-process', 'get-service', 'get-alias', 'get-variable',
    'convertto-json', 'convertfrom-json', 'get-member', 'gm',
]);

// git read-only sub-commands — auto-safe only WITHOUT destructive flags.
const GIT_SAFE_SUB = new Set([
    'status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files', 'rev-parse',
    'describe', 'blame', 'shortlog', 'reflog', 'whatchanged', 'name-rev',
    'count-objects', 'ls-tree', 'cat-file', 'grep', 'tag',
]);
const GIT_DESTRUCTIVE_FLAG = /(^|\s)(-d|-D|--delete|-f|--force|--hard|--unset|--prune|-m|--move)\b/i;

// Shell metacharacters that make static reasoning unsafe → never auto-'safe'.
// (Redirection can overwrite files; ; && || chain arbitrary commands; $() `` eval.)
const UNSAFE_SHELL = /[>`]|\$\(|&&|\|\||;/;

function firstToken(segment) {
    return String(segment).trim().split(/\s+/)[0]?.toLowerCase() || '';
}

/**
 * Classify a shell command's risk: 'dangerous' | 'safe' | 'normal'.
 * @param {string} cmd
 * @returns {'dangerous'|'safe'|'normal'}
 */
export function classifyCommand(cmd) {
    const c = String(cmd || '').trim();
    if (!c) return 'normal';

    // 1) Dangerous wins over everything.
    if (DANGEROUS_PATTERNS.some(re => re.test(c))) return 'dangerous';

    // 2) Safe = read-only, no risky shell metachars. Allow a pipeline where
    //    EVERY segment is itself a safe read-only command.
    if (UNSAFE_SHELL.test(c)) return 'normal';
    const segments = c.split('|');
    const allSafe = segments.every(seg => {
        const tok = firstToken(seg);
        if (SAFE_CMDS.has(tok)) return true;
        if (tok === 'git') {
            const sub = String(seg).trim().split(/\s+/)[1]?.toLowerCase() || '';
            return GIT_SAFE_SUB.has(sub) && !GIT_DESTRUCTIVE_FLAG.test(seg);
        }
        return false;
    });
    if (allSafe) return 'safe';

    // 3) Everything else needs a decision (prompt / whitelist / auto-toggle).
    return 'normal';
}

/**
 * Suggest an "always allow" PATTERN for a command. We generalize to the first
 * one or two tokens + a wildcard so repeated variants (e.g. `git status -s`)
 * don't re-prompt, while staying specific enough to be meaningful.
 * Returns a trimmed exact command when it's a single token.
 * @param {string} cmd
 * @returns {string} pattern (glob-ish, '*' = any suffix)
 */
export function suggestApprovalPattern(cmd) {
    const c = String(cmd || '').trim();
    if (!c) return '';
    const toks = c.split(/\s+/);
    if (toks.length === 1) return toks[0];
    // git / npm / npx / node / docker etc. → keep 2 tokens (verb + subcommand).
    const twoTokenLeads = new Set(['git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'docker', 'cargo', 'pip', 'python', 'dotnet', 'kubectl']);
    const keep = twoTokenLeads.has(toks[0].toLowerCase()) ? 2 : 1;
    return toks.slice(0, keep).join(' ') + ' *';
}

/**
 * Does `cmd` match any of the user's approved patterns?
 * A pattern ending in ' *' (or '*') matches by prefix; otherwise exact (trimmed).
 * @param {string} cmd
 * @param {Iterable<string>} patterns
 * @returns {boolean}
 */
export function isApprovedByPatterns(cmd, patterns) {
    const c = String(cmd || '').trim();
    if (!c || !patterns) return false;
    for (const p of patterns) {
        const pat = String(p || '').trim();
        if (!pat) continue;
        if (pat.endsWith('*')) {
            const prefix = pat.slice(0, -1).trim();
            if (prefix === '' ) continue;                 // refuse a bare '*' (would allow everything)
            if (c === prefix || c.startsWith(prefix + ' ') || c.startsWith(prefix)) return true;
        } else if (c === pat) {
            return true;
        }
    }
    return false;
}
