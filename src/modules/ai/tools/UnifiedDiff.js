// UnifiedDiff — PURE parsing and application of unified-diff hunks.
//
// Why a fourth editing tool exists at all.
//
// `multi_replace_file_content` asks the model to reproduce the text it wants to
// replace, exactly, including whitespace. That is a transcription task, and models
// are bad at it: the executor carries a three-strikes recovery path
// (`_handleMultiReplaceFailure`) that re-reads the file and prints the closest
// matching region purely because this fails so often. `replace_lines` avoids the
// transcription but needs line numbers that are still correct at the moment of the
// call, so any earlier edit in the same turn invalidates them.
//
// A unified diff sidesteps both. The model writes context lines it can copy from
// `read_file` output, and the hunk header's line number is a HINT rather than an
// address — the matcher searches outward from it, so a hunk still applies when the
// file has shifted. That is the property that makes patches survive; it is also
// why this module deliberately does NOT trust `@@ -a,b +c,d @@` as an address.
//
// No I/O, no Tauri, no DOM.

/** How far from the hinted line to search for a hunk's context, in lines. */
export const SEARCH_RADIUS = 200;

/**
 * Parse a unified diff into hunks.
 *
 * Accepts (and ignores) `---`/`+++` file headers and `diff --git` lines, because
 * models emit them out of habit even when the tool takes the path separately.
 *
 * @param {string} patch
 * @returns {{ok: true, hunks: Array} | {ok: false, error: string}}
 */
/**
 * Drop a markdown code fence wrapping the whole patch.
 *
 * Models fence diffs out of habit — ```` ```diff ```` is how a diff is written
 * everywhere else. Unfenced, the closing ``` landed INSIDE the last hunk and was
 * rejected as "not a diff marker", so a patch that was otherwise perfectly valid
 * failed on punctuation the model added for readability.
 *
 * Only an opening fence on the FIRST line with a matching close on the last is
 * removed: a stray ``` in the middle is content, and guessing at it would be the
 * kind of cleverness that corrupts a file.
 */
export function stripFence(text) {
    const lines = text.split('\n');
    let a = 0;
    let b = lines.length - 1;
    while (a < lines.length && lines[a].trim() === '') a++;
    while (b > a && lines[b].trim() === '') b--;
    if (a >= b) return text;
    if (!/^```/.test(lines[a].trim()) || lines[b].trim() !== '```') return text;
    return lines.slice(a + 1, b).join('\n');
}

export function parsePatch(patch) {
    const text = stripFence(String(patch ?? '').replace(/\r\n/g, '\n'));
    if (!text.trim()) return { ok: false, error: 'the patch is empty' };

    const lines = text.split('\n');
    const hunks = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^@@/.test(line)) {
            const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
            // A header with no usable line numbers ("@@", "@@ @@") is accepted
            // rather than rejected. This module's whole premise is that the
            // numbers are a HINT and the hunk is found by its context — so
            // demanding a hint it never trusts was inconsistent, and it turned
            // the `*** Update File:` envelope style (which writes a bare @@)
            // into a hard failure over something the matcher does not use.
            // `oldStart: null` means "no hint": search the whole file.
            if (!m && !/^@@\s*@?@?\s*$/.test(line.trim())) {
                return { ok: false, error: `malformed hunk header on line ${i + 1}: "${line}"` };
            }
            current = { oldStart: m ? parseInt(m[1], 10) : null, lines: [], header: line };
            hunks.push(current);
            continue;
        }

        // Everything before the first @@ is a file header we do not need.
        if (!current) continue;

        // A totally empty line inside a hunk is a context line whose trailing
        // space was stripped — by an editor, by JSON round-tripping, or by the
        // model. Treating it as "end of hunk" silently truncates the patch, so
        // it is read as an empty context line instead.
        if (line === '') {
            // Unless it is trailing filler after the last hunk.
            const rest = lines.slice(i + 1);
            if (rest.every(l => l === '' || /^@@/.test(l))) continue;
            current.lines.push({ kind: ' ', text: '' });
            continue;
        }

        // Envelope lines from the `*** Begin Patch` dialect. They carry nothing
        // this tool needs — the path arrives as its own argument — but the
        // TRAILING one lands inside the last hunk, so a patch that was otherwise
        // fine died on its own terminator. Matched against the known keywords
        // only: an unrecognised `***` line is still a body line missing its
        // marker, which is a real error worth reporting.
        if (/^\*\*\* (Begin Patch|End Patch|Update File:|Add File:|Delete File:|End of File)/.test(line)) {
            continue;
        }

        const marker = line[0];
        if (marker === ' ' || marker === '+' || marker === '-') {
            current.lines.push({ kind: marker, text: line.slice(1) });
        } else if (marker === '\\') {
            continue;   // "\ No newline at end of file"
        } else {
            return {
                ok: false,
                error: `line ${i + 1} starts with "${marker}", which is not a diff marker `
                    + `(expected " ", "+", "-"): "${line}". Every line inside a hunk must carry a marker.`,
            };
        }
    }

    if (hunks.length === 0) {
        // Name what WAS sent. The bare "needs at least one" left the model to
        // guess which of its habits was wrong, and the three shapes that land
        // here need three different corrections.
        const body = lines.filter(l => l.trim() !== '');
        const marked = body.filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
        let hint;
        if (marked > 0) {
            hint = `The patch has ${marked} +/- line(s) but no "@@" header, so there is nothing `
                + 'saying WHERE they go. Put "@@ -<line>,<count> +<line>,<count> @@" above them '
                + 'and include 2-3 unchanged context lines (each prefixed with a space) around the change.';
        } else if (body.some(l => /^(\+\+\+|---|diff --git)/.test(l))) {
            hint = 'Only file headers were sent — the "---"/"+++" lines are ignored and the hunks are missing. '
                + 'Every change needs an "@@" header followed by its context and +/- lines.';
        } else {
            hint = 'This looks like file CONTENT rather than a diff. To replace a file wholesale use '
                + 'write_file; apply_patch takes a unified diff whose lines each start with " ", "+" or "-".';
        }
        return { ok: false, error: `no @@ hunk headers found. ${hint}` };
    }
    for (const h of hunks) {
        if (h.lines.length === 0) {
            return { ok: false, error: `hunk "${h.header}" has no body` };
        }
        if (!h.lines.some(l => l.kind !== ' ')) {
            return { ok: false, error: `hunk "${h.header}" changes nothing (context only)` };
        }
    }
    return { ok: true, hunks };
}

/** The lines a hunk expects to find in the file, in order. */
function expectedLines(hunk) {
    return hunk.lines.filter(l => l.kind === ' ' || l.kind === '-').map(l => l.text);
}

/** The lines a hunk leaves behind. */
function resultLines(hunk) {
    return hunk.lines.filter(l => l.kind === ' ' || l.kind === '+').map(l => l.text);
}

/**
 * Find where `needle` sits in `haystack`, searching outward from `hint`.
 *
 * Two passes, and the order matters. An EXACT match anywhere in the radius beats
 * a whitespace-insensitive match nearer the hint: relaxing whitespace is a
 * concession to a model that re-indented while copying, and it must never be
 * preferred over a place where the text genuinely matches.
 *
 * @returns {{index: number, exact: boolean} | null}
 */
export function locateHunk(haystack, needle, hint, radius = SEARCH_RADIUS) {
    if (needle.length === 0) return null;
    const limit = haystack.length - needle.length;
    if (limit < 0) return null;

    const start = Math.max(0, Math.min(hint, limit));
    const at = (i, compare) => {
        for (let k = 0; k < needle.length; k++) {
            if (!compare(haystack[i + k], needle[k])) return false;
        }
        return true;
    };
    const exact = (a, b) => a === b;
    const loose = (a, b) => a.trim() === b.trim();

    for (const compare of [exact, loose]) {
        if (at(start, compare)) return { index: start, exact: compare === exact };
        for (let d = 1; d <= radius; d++) {
            const lo = start - d;
            const hi = start + d;
            if (lo >= 0 && at(lo, compare)) return { index: lo, exact: compare === exact };
            if (hi <= limit && at(hi, compare)) return { index: hi, exact: compare === exact };
        }
    }
    return null;
}

/**
 * Apply parsed hunks to `content`.
 *
 * Hunks are applied in order and each subsequent search starts after the previous
 * hunk's result, so two hunks cannot match the same region — the failure that
 * makes a patch look like it applied while quietly doubling a block.
 *
 * @param {string} content  the file as it is now
 * @param {Array} hunks     from parsePatch
 * @returns {{ok: true, content: string, applied: number, fuzzy: number}
 *          |{ok: false, error: string}}
 */
export function applyHunks(content, hunks) {
    const eol = /\r\n/.test(content) && (content.match(/\r\n/g) || []).length
        >= (content.match(/(?<!\r)\n/g) || []).length ? '\r\n' : '\n';
    const hadTrailingNewline = /\n$/.test(content);
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (hadTrailingNewline) lines.pop();   // trailing '' is an artefact of the split

    let cursor = 0;
    let fuzzy = 0;
    let out = lines;

    for (let n = 0; n < hunks.length; n++) {
        const hunk = hunks[n];
        const want = expectedLines(hunk);
        const give = resultLines(hunk);
        // The header counts from 1 and is only a hint; never search behind the
        // previous hunk's result.
        const hint = Math.max(cursor, (hunk.oldStart || 1) - 1);
        // No hint at all ⇒ search the whole file. The radius exists to stop a
        // hunk matching a similar-looking block far from where the model SAID it
        // was; with nothing said there is no "far from" to guard, and a window
        // would just fail on any file longer than the radius.
        const radius = hunk.oldStart === null ? Infinity : SEARCH_RADIUS;

        const found = locateHunk(out, want, hint, radius);
        if (!found) {
            const preview = want.slice(0, 3).map(l => `  |${l}`).join('\n');
            return {
                ok: false,
                error: `hunk ${n + 1} of ${hunks.length} ("${hunk.header}") does not match the file. `
                    + `Its context could not be found within ${SEARCH_RADIUS} lines of the hinted position.\n`
                    + `Expected to find:\n${preview}${want.length > 3 ? '\n  |…' : ''}\n`
                    + `Re-read the file and rebuild the patch from its CURRENT content — `
                    + `do not adjust the @@ line numbers and retry, they are only a hint.`,
            };
        }
        if (!found.exact) fuzzy++;

        out = [...out.slice(0, found.index), ...give, ...out.slice(found.index + want.length)];
        cursor = found.index + give.length;
    }

    let joined = out.join(eol);
    if (hadTrailingNewline) joined += eol;
    return { ok: true, content: joined, applied: hunks.length, fuzzy };
}

/**
 * Parse and apply in one step.
 * @returns same shape as applyHunks, with parse errors reported the same way
 */
export function applyPatch(content, patch) {
    const parsed = parsePatch(patch);
    if (!parsed.ok) return { ok: false, error: `could not parse the patch: ${parsed.error}` };
    return applyHunks(content, parsed.hunks);
}
