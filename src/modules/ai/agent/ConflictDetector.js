// ConflictDetector — detect conflicts between PARALLEL tool calls in one step
// (P5, "並列コール競合検出" from Report_20260815 §3 table 3).
//
// The agent loop runs every "Allow" call of a step in parallel via Promise.all.
// Most tools are independent (two reads, a read + a write to DIFFERENT files),
// but two calls that MUTATE the same file race: the last write wins, a replace
// can be applied to the wrong base content, and the error is silent because both
// calls reported success. The loop already serializes sub-agents by write-scope;
// this closes the same hole for ordinary tools.
//
// The strategy is conservative but cheap:
//   • extract the file(s) a call targets from its args (path / file_path /
//     from/to for move_file, path+sheet for the xlsx tools…),
//   • normalize paths (forward slashes, trailing separators),
//   • any two MUTATING calls targeting the SAME path ⇒ conflict.
//
// A conflicted call is pulled OUT of the parallel batch and run sequentially
// AFTER it (the loop keeps its existing sequential executor path). Reads never
// conflict with anything; move_file conflicts with both its source and target.

/** Normalize a path for conflict comparison: forward slashes, no trailing slash. */
export function normalizeConflictPath(p) {
    if (typeof p !== 'string') return '';
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The file path(s) a tool call writes/reads. Returns an array of normalized
 * paths (possibly empty for tools that don't target files).
 *
 * @param {object} call {name, args}
 * @returns {{ write: string[], read: string[] }}
 */
export function callTargets(call) {
    const a = (call && typeof call.args === 'object' && call.args !== null) ? call.args : {};
    const pick = (...keys) => {
        for (const k of keys) {
            const v = a[k];
            if (typeof v === 'string' && v.trim()) return normalizeConflictPath(v);
        }
        return '';
    };

    const name = call?.name || '';
    switch (name) {
        // File mutation tools — target paths are WRITE (they change the file).
        case 'write_file':
        case 'multi_replace_file_content':
        case 'replace_lines':
        case 'delete_file':
        case 'write_xlsx':
        case 'update_xlsx':
        case 'write_docx':
        case 'move_file': {
            const from = pick('from');
            const to = pick('to', 'path');
            // move_file reads (removes) the source and writes the destination.
            return from ? { write: to ? [to] : [], read: [from] } : { write: to ? [to] : [], read: [] };
        }
        // Read-only tools — never conflict, but still reported for completeness.
        case 'read_file':
        case 'read_office':
        case 'verify_syntax':
            return { write: [], read: pick('path') ? [pick('path')] : [] };
        default:
            return { write: [], read: [] };
    }
}

/**
 * Is a call "mutating" in the conflict sense (it can clobber a file)?
 */
function isMutating(targets) {
    return targets.write.length > 0;
}

/**
 * Detect conflicts in a batch of tool calls that the loop is about to run in
 * parallel.
 *
 * @param {Array<{name:string,args:object}>} calls
 * @returns {Set<object>} the calls that MUST be serialized (they conflict with
 *   an earlier call in the batch). Order matters: when call A then B both write
 *   the same path, B is flagged — A keeps its parallel slot.
 */
export function detectParallelConflicts(calls) {
    const flagged = new Set();
    if (!Array.isArray(calls) || calls.length < 2) return flagged;
    const seenWrites = new Map(); // path -> set of prior calls
    for (const call of calls) {
        const { write } = callTargets(call);
        const conflicts = write.some(p => seenWrites.has(p));
        if (conflicts) flagged.add(call);
        for (const p of write) {
            if (!seenWrites.has(p)) seenWrites.set(p, new Set());
            seenWrites.get(p).add(call);
        }
    }
    return flagged;
}

/**
 * Partition a batch into { parallel, serial } for safe execution.
 *
 * IDENTITY MATTERS: both arrays hold the ORIGINAL call objects, never copies.
 * The loop correlates a result back to its native tool_call id through an
 * identity Map (callIdOf), so a cloned call would resolve to `id: undefined` —
 * the tool result would then lose its tool_call_id and be downgraded to a plain
 * user note on every provider that speaks the native protocol. Conflict paths
 * are therefore reported alongside, not attached to the call.
 *
 * @param {Array<{name:string,args:object}>} calls
 * @returns {{parallel:Array, serial:Array, conflicts:Array<{call:object, paths:string[]}>}}
 *   parallel — safe to run via Promise.all
 *   serial   — must run one-at-a-time AFTER the parallel batch (same objects)
 *   conflicts — {call, paths} for each serialized call (debug/UI)
 */
export function partitionParallelCalls(calls) {
    const flagged = detectParallelConflicts(Array.isArray(calls) ? calls : []);
    const parallel = [];
    const serial = [];
    const conflicts = [];
    for (const call of Array.isArray(calls) ? calls : []) {
        if (flagged.has(call)) {
            serial.push(call);
            conflicts.push({ call, paths: callTargets(call).write.filter(Boolean) });
        } else {
            parallel.push(call);
        }
    }
    return { parallel, serial, conflicts };
}

/**
 * A human-readable note explaining the serialization, injected into the status
 * so the user sees WHY one call ran after the others. Empty when nothing was
 * serialized.
 */
export function serializationNotice(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return '';
    const names = calls.map(c => c.name).join(', ');
    return `⚠️ 同一ファイルへの並列アクセスを検出し、${names} を順次実行に変更しました。`;
}
