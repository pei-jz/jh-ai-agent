// LoopDetector — PURE detection of repeating tool-call cycles (anti-loop).
// Extracted from AgentController (Phase 1) for isolated unit testing.

/**
 * Detect a repeating 2- or 3-cycle in the tail of the tool-call history.
 * Catches "ABAB…" / "ABCABC…" oscillation where the agent isn't repeating ONE
 * call enough to trip the identical-call stop but is spinning a small fixed set.
 *
 * @param {Array<{name:string, argsStr:string}>} history  full tool-call history
 * @param {number} minRepeats  consecutive repeats required (0 ⇒ disabled)
 * @returns {null | { pattern:string, length:2|3, repeats:number }}
 *
 * 2-cycle needs 2·minRepeats matching tail calls; 3-cycle needs 3·max(2,minRepeats).
 */
export function detectCycle(history, minRepeats = 3) {
    if (!Array.isArray(history)) return null;
    if (!Number.isFinite(minRepeats) || minRepeats <= 0) return null; // disabled
    const min3 = Math.max(2, minRepeats);

    const sig = c => `${c.name}(${c.argsStr})`;

    // ── 2-cycle (ABAB…) ──
    const need2 = 2 * minRepeats;
    if (history.length >= need2) {
        const tail = history.slice(-need2).map(sig);
        const a = tail[0], b = tail[1];
        if (a !== b) {
            let ok = true;
            for (let i = 0; i < tail.length; i++) {
                if (tail[i] !== (i % 2 === 0 ? a : b)) { ok = false; break; }
            }
            if (ok) {
                const calls = history.slice(-need2);
                return { pattern: `${calls[0].name}→${calls[1].name}`, length: 2, repeats: minRepeats };
            }
        }
    }

    // ── 3-cycle (ABCABC…) ──
    const need3 = 3 * min3;
    if (history.length >= need3) {
        const tail = history.slice(-need3).map(sig);
        const a = tail[0], b = tail[1], c = tail[2];
        if (new Set([a, b, c]).size === 3) {
            let ok = true;
            for (let i = 0; i < tail.length; i++) {
                const expected = i % 3 === 0 ? a : i % 3 === 1 ? b : c;
                if (tail[i] !== expected) { ok = false; break; }
            }
            if (ok) {
                const calls = history.slice(-need3);
                return { pattern: `${calls[0].name}→${calls[1].name}→${calls[2].name}`, length: 3, repeats: min3 };
            }
        }
    }

    return null;
}
