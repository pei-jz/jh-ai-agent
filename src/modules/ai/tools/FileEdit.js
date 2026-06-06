// FileEdit — PURE text primitives for content-based file editing.
// Extracted from ToolExecutor's multi_replace_file_content handler (Phase 3).
// These are the matching/transform building blocks where corruption bugs hide,
// so isolating + unit-testing them is high value. No Tauri / DOM / I/O.

/** Detect a file's dominant line ending ('\r\n' if CRLF outnumbers bare LF, else '\n'). */
export function detectLineEnding(content) {
    const crlf = (content.match(/\r\n/g) || []).length;
    const lf = (content.match(/(?<!\r)\n/g) || []).length;
    return crlf > lf ? '\r\n' : '\n';
}

/** Normalize CRLF→LF for matching. Non-strings pass through. */
export function normalizeLE(s) {
    return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s;
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let n = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        n++;
        idx += needle.length;
    }
    return n;
}

/** Replace EVERY literal occurrence of `needle` with `replacement`. */
export function replaceAllLiteral(haystack, needle, replacement) {
    let out = '';
    let idx = 0, prev = 0;
    while ((idx = haystack.indexOf(needle, prev)) !== -1) {
        out += haystack.slice(prev, idx) + replacement;
        prev = idx + needle.length;
    }
    out += haystack.slice(prev);
    return out;
}

const tokenize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase().split(' ').filter(Boolean);
const lineTokenSet = (line) => new Set(tokenize(line));
function dice(aSet, bSet) {
    if (aSet.size === 0 && bSet.size === 0) return 1;
    if (aSet.size === 0 || bSet.size === 0) return 0;
    let inter = 0;
    for (const t of aSet) if (bSet.has(t)) inter++;
    return (2 * inter) / (aSet.size + bSet.size);
}

/**
 * Find the region in `content` most similar to `target` using order-respecting
 * per-line Dice similarity over a sliding window. Returns
 * { startLine, endLine, content, score } or null (no ≥0.4 match / whitespace-only).
 * Used to power the "Closest matching region" hint on a not-found edit.
 */
export function findClosestRegion(content, target) {
    const fileLines = content.split('\n');
    const targetLines = target.split('\n');
    const n = targetLines.length;
    if (n === 0) return null;

    const targetSets = targetLines.map(lineTokenSet);
    const targetTokenTotal = targetSets.reduce((s, set) => s + set.size, 0);
    if (targetTokenTotal === 0) return null; // target is all whitespace

    const fileSets = fileLines.map(lineTokenSet);

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < fileLines.length; i++) {
        const windowLen = Math.min(n, fileLines.length - i);
        let sum = 0;
        for (let k = 0; k < windowLen; k++) {
            sum += dice(targetSets[k], fileSets[i + k]);
        }
        const score = sum / n; // divide by full target length → penalize short tail windows
        if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0 || bestScore < 0.4) return null;
    const endIdx = Math.min(fileLines.length, bestIdx + n);
    return {
        startLine: bestIdx + 1,
        endLine: endIdx,
        content: fileLines.slice(bestIdx, endIdx).join('\n'),
        score: Math.min(1, bestScore),
    };
}

/** Visualize whitespace so tab-vs-space diffs are visible (· = space, → = tab). */
export function visualizeWS(s) {
    return s.replace(/\t/g, '→').replace(/ /g, '·');
}
