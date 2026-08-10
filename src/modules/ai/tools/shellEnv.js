// shellEnv — tell the model which shell it is actually writing for.
//
// run_command spawns PowerShell on Windows and POSIX sh elsewhere, but the tool
// description said only "execute a shell command". The model defaulted to bash,
// the first command failed on syntax, and it retried in PowerShell — a wasted
// step and a wasted confirmation on nearly every task that touched the shell.
//
// So the description is generated from the backend's own `get_shell_info`, and
// carries the handful of differences that actually cause first-attempt failures
// rather than a general "you are on Windows" note.
//
// Pure: the caller fetches the info over the Tauri bridge and passes it in.

/** PowerShell 5.1 traps, in rough order of how often they bite. */
const POWERSHELL_NOTES = [
    '`&&` and `||` are PARSE ERRORS here (Windows PowerShell 5.1, not pwsh 7) — use `;` to chain, or `A; if ($?) { B }` to run B only on success',
    'Unix tools do not exist: head/tail → `Get-Content -TotalCount N` / `-Tail N`; which → `(Get-Command x).Source`; wc -l → `(Get-Content f | Measure-Object -Line).Lines`; rm -rf → `Remove-Item -Recurse -Force`; mkdir -p → `New-Item -ItemType Directory -Force`; touch → `New-Item -ItemType File`',
    '`2>/dev/null` → `2>$null`; env vars are `$env:NAME` (no `export`); no ternary or `??`',
    'Quote paths containing spaces, and call an executable by path with `& "C:\\path\\app.exe"`',
    'Non-interactive: never use Read-Host, `git rebase -i`, or anything that opens an editor or prompts',
];

const SH_NOTES = [
    'This is POSIX `sh`, not bash — `[[ ]]`, arrays and `source` may fail. Use POSIX syntax, or run `bash -c "…"` explicitly when you need bash',
];

/**
 * The sentence(s) appended to run_command's description.
 * @param {{os?:string, program?:string, args?:string[], display?:string}} info
 * @returns {string} '' when the shell is unknown (never guess at it)
 */
export function shellGuidance(info) {
    if (!info || typeof info !== 'object') return '';
    const program = String(info.program || '').trim();
    if (!program) return '';

    const os = String(info.os || 'unknown');
    const display = String(info.display || program).trim() || program;
    const argv = [program, ...(Array.isArray(info.args) ? info.args : [])].join(' ');
    const notes = program === 'powershell' || program === 'pwsh' ? POWERSHELL_NOTES : SH_NOTES;

    // "Windows PowerShell 5.1 (powershell.exe)" → "Windows PowerShell 5.1" for
    // the second mention; repeating the executable reads as noise.
    const short = display.replace(/\s*\([^)]*\)\s*$/, '') || display;

    return ` SHELL: commands run on ${os} through ${display} — invoked as \`${argv} <your command>\`.`
        + ` Write ${short} syntax from the FIRST attempt; do not assume bash.`
        + ` ${notes.map(n => `• ${n}`).join(' ')}`;
}

/**
 * Return `defs` with run_command's description extended for the live shell.
 * The array and every other entry are left untouched (identity preserved), so
 * this can sit in the hot path without churning the prompt cache.
 */
export function decorateRunCommand(defs, info) {
    const extra = shellGuidance(info);
    if (!extra || !Array.isArray(defs)) return defs;
    let changed = false;
    const out = defs.map(t => {
        if (!t || t.name !== 'run_command') return t;
        // Idempotent: decorating twice would double the text and break caching.
        if (typeof t.description === 'string' && t.description.includes(' SHELL: commands run on ')) return t;
        changed = true;
        return { ...t, description: `${t.description || ''}${extra}` };
    });
    return changed ? out : defs;
}
