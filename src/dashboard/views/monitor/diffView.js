// diffView — pure helpers for the lightweight diff viewer on changed-file lists.
//
// The viewer shells out to the existing git_diff command (commands/git.rs) and
// colourises its unified-diff output. No diffing happens here: git is the engine.
// These two functions are the only testable parts — turning a git diff string
// into typed lines, and turning an absolute file path into a git-cwd-relative one.

/**
 * Split a unified-diff string into typed lines.
 *
 * `git diff` output is line-oriented and self-describing: `+`/`-`/` ` mark
 * added/removed/context lines, `@@` marks a hunk header, and everything else
 * (`diff --git`, `index`, `---`, `+++`, `new file mode`, …) is metadata. The
 * renderer only needs the type to colour a line, so this keeps the Svelte side
 * free of string-prefix logic.
 *
 * @param {string} text the `git diff` output
 * @returns {Array<{type:'meta'|'hunk'|'add'|'del'|'ctx', text:string}>}
 */
export function parseUnifiedDiff(text) {
    const src = String(text ?? '');
    if (!src.trim()) return [];
    const raw = src.split('\n');
    // Drop the single empty element a trailing newline leaves behind.
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    const out = [];
    for (const rawLine of raw) {
        // CRLF from git on Windows — strip so the prefix test below is exact.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        let type = 'ctx';
        if (/^(diff --git|index |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files|---|\+\+\+)/.test(line)) {
            type = 'meta';
        } else if (line.startsWith('@@')) {
            type = 'hunk';
        } else if (line.startsWith('+')) {
            type = 'add';
        } else if (line.startsWith('-')) {
            type = 'del';
        }
        out.push({ type, text: line });
    }
    return out;
}

/**
 * An absolute file path, relative to the workspace it lives in.
 *
 * `git diff -- <path>` wants the path relative to the repo root (cwd). An
 * absolute path usually works too, but not always (and never for a path with a
 * drive letter), so normalise it here. Falls back to the path unchanged when it
 * is outside the workspace or the workspace is empty.
 *
 * @param {string} filePath absolute path of the changed file
 * @param {string} workspace the repo/workspace root (git cwd)
 * @returns {string} the path git should be asked about
 */
export function relPathFor(filePath, workspace) {
    const f = String(filePath || '').replace(/\\/g, '/');
    const w = String(workspace || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!w) return f;
    if (f.toLowerCase().startsWith(w.toLowerCase() + '/')) return f.slice(w.length + 1);
    return f;
}
