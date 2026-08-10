// CompressionMetrics — measures whether history compression is doing its job.
//
// The existing efficiency counters measure VOLUME (how many compressions ran,
// how many chars they removed). That can look great while the agent quietly
// pays the cost back: if compression drops a file's content and the agent then
// RE-READS that file, the "saving" was an illusion.
//
// This module measures QUALITY by attributing every re-read to whether it
// crossed a compression boundary:
//
//   • re-read in the SAME generation  → the agent's own redundancy
//                                       (compression is not at fault)
//   • re-read in a LATER generation   → the content was compressed away and
//                                       had to be fetched again — a
//                                       COMPRESSION-INDUCED re-read
//
// The headline number is `netCharsSaved` = charsSaved − inducedReReadChars.
// If that goes negative, compression is costing more than it saves.
//
// Pure: no DOM, no Tauri, no clock, no I/O. Deterministic → unit-testable.

/** Normalize a file path so "./A\B.js" and "a/b.js" count as the same file. */
export function normalizePath(p) {
    return String(p == null ? '' : p)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
        // "." and "" both mean the workspace root — fold them so the same
        // retrieval spelled either way shares one key.
        .replace(/^\.$/, '')
        .toLowerCase();
}

/**
 * Stable signature for a RETRIEVAL tool call — two calls that would return the
 * same information share a key, so the second one after a compression counts as
 * a re-fetch. Returns '' for tools that are not pure retrieval (notably
 * run_command: re-running a build/test is usually intentional, not waste).
 * @param {string} name tool name
 * @param {object} args tool arguments
 */
export function fetchKey(name, args = {}) {
    const a = args || {};
    switch (name) {
        case 'read_file':
            return `read:${normalizePath(a.path ?? a.file ?? '')}`;
        case 'grep_search':
            return `grep:${String(a.pattern ?? a.query ?? '')}|${normalizePath(a.path ?? '')}`;
        case 'glob':
            return `glob:${String(a.pattern ?? '')}|${normalizePath(a.path ?? '')}`;
        case 'list_files':
            return `list:${normalizePath(a.path ?? '')}`;
        case 'symbol_search':
            return `symbol:${String(a.query ?? '')}|${normalizePath(a.path ?? '')}`;
        default:
            return '';   // not a pure retrieval → not tracked
    }
}

/** Small stable digest of a retrieval's content (FNV-1a). Not cryptographic. */
export function hashContent(s) {
    const str = String(s == null ? '' : s);
    if (!str) return '0';
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

// ── Stage 4: summary fidelity ──────────────────────────────────────────────
// Compression replaces text with a summary. Whether that summary KEPT the
// load-bearing details can be approximated without an LLM: the details an agent
// actually needs are concrete tokens — file paths, identifiers, error codes,
// numbers. Extract them before and after, and measure how many survived.

const FACT_PATTERNS = [
    /[\w./\\-]+\.(?:js|jsx|ts|tsx|rs|py|json|md|toml|yml|yaml|html|css)\b/gi, // file paths
    /\b[A-Za-z_$][\w$]*(?=\s*\()/g,      // identifiers used as calls
    /\bE\d{2,}\b|\b[A-Z][A-Z_]{3,}\b/g,  // error/const codes
    /\b\d{2,}\b/g,                        // multi-digit numbers (line numbers, counts)
];

/**
 * Concrete, checkable tokens in a blob of text.
 * @returns {Set<string>}
 */
export function extractFacts(text) {
    const s = String(text || '');
    const out = new Set();
    for (const re of FACT_PATTERNS) {
        re.lastIndex = 0;
        for (const m of s.matchAll(re)) {
            const t = m[0].trim();
            if (t.length >= 3) out.add(t.toLowerCase());
        }
    }
    return out;
}

/**
 * How much of the pre-compression detail survived into the compressed text.
 * @param {string} before text before compaction/compression
 * @param {string} after  text after
 * @returns {{total:number, kept:number, lost:number, retention:number, lostSamples:string[]}}
 */
export function factRetention(before, after) {
    const factsBefore = extractFacts(before);
    const factsAfter = extractFacts(after);
    const lost = [];
    let kept = 0;
    for (const f of factsBefore) {
        if (factsAfter.has(f)) kept++;
        else lost.push(f);
    }
    const total = factsBefore.size;
    return {
        total,
        kept,
        lost: lost.length,
        // 1 = everything survived. No facts to begin with counts as perfect.
        retention: total === 0 ? 1 : Number((kept / total).toFixed(3)),
        lostSamples: lost.slice(0, 10),
    };
}

export class CompressionMetrics {
    constructor() {
        /** Bumped by every compression/compaction — the "generation" counter. */
        this.generation = 0;
        this.compressions = 0;   // _compressToolResultsInHistory runs
        this.compactions = 0;    // conversationMemory.compactHistory runs
        this.charsSaved = 0;     // chars removed by compaction

        /** normalized path → { reads, lastGen, inducedReads, inducedChars } */
        this.files = new Map();

        this.reads = 0;
        this.reReads = 0;               // any read of an already-read file
        this.sameGenReReads = 0;        // agent redundancy (not compression's fault)
        this.inducedReReads = 0;        // crossed a compression boundary
        this.inducedReReadChars = 0;    // context re-fetched because of compression
        /** tool name → induced re-fetch count (which tool suffers most). */
        this.inducedByKind = {};
        // Stage 3 — CAUSAL attribution. The generation counter can only say "a
        // compression happened in between" (correlation, and it over-attributes
        // when the agent would have re-fetched anyway). When the compressor
        // reports WHICH content it discarded, a later re-fetch of exactly that
        // content is confirmed rather than suspected.
        this.confirmedInduced = 0;   // the dropped content was re-fetched
        this.suspectedInduced = 0;   // crossed a compression, but not confirmed
        this._droppedHashes = new Set();
        // Stage 4 — fidelity of each compaction summary.
        this.retentionSamples = [];
    }

    /**
     * Record a compression event. `kind` is 'compression' (tool-result
     * compression) or 'compaction' (history summarization).
     * @param {string} kind
     * @param {number} charsSaved chars removed (compaction only; 0 otherwise)
     */
    noteCompression(kind, charsSaved = 0, opts = {}) {
        if (kind === 'compaction') this.compactions++;
        else this.compressions++;
        if (Number.isFinite(charsSaved) && charsSaved > 0) this.charsSaved += charsSaved;
        // Stage 3: content the compressor actually discarded, by hash. A later
        // re-fetch matching one of these is CONFIRMED waste.
        for (const h of (opts.droppedHashes || [])) this._droppedHashes.add(h);
        // Stage 4: how much concrete detail the summary preserved.
        if (opts.retention && Number.isFinite(opts.retention.retention)) {
            this.retentionSamples.push(opts.retention);
        }
        this.generation++;
        return this;
    }

    /** Mean fidelity across compactions (1 = nothing concrete was lost). */
    meanRetention() {
        if (this.retentionSamples.length === 0) return null;
        const sum = this.retentionSamples.reduce((n, r) => n + r.retention, 0);
        return Number((sum / this.retentionSamples.length).toFixed(3));
    }

    /**
     * Record a successful RETRIEVAL — a tool call whose result is pure
     * information that ought to still be in the history (read_file,
     * grep_search, glob, list_files).
     *
     * Deliberately NOT used for run_command: re-running a build or a test suite
     * is usually intentional (verify after a fix), so counting it as compression
     * waste would be wrong.
     *
     * @param {string} key stable signature of the fetch, e.g. "read:src/a.js"
     * @param {number} chars size of the content returned
     * @param {string} kind tool name, for the per-tool breakdown
     * @returns {'first'|'re-read'|'induced-re-read'}
     */
    noteFetch(key, chars = 0, kind = 'read_file', content = null) {
        return this._note(String(key || ''), chars, kind, content);
    }

    /** Back-compat shim: a plain file read keyed by its normalized path. */
    noteRead(path, chars = 0) {
        const key = normalizePath(path);
        return this._note(key ? `read:${key}` : '', chars, 'read_file');
    }

    _note(key, chars, kind, content = null) {
        if (!key) return 'first';
        this.reads++;
        const size = Number.isFinite(chars) && chars > 0 ? chars : 0;
        const hash = content == null ? null : hashContent(content);
        const rec = this.files.get(key);
        if (!rec) {
            this.files.set(key, { reads: 1, lastGen: this.generation, inducedReads: 0, inducedChars: 0, kind, hash });
            return 'first';
        }
        rec.reads++;
        this.reReads++;
        // A compression happened between the previous read and this one → the
        // earlier content is gone from the history, so this re-read is its cost.
        const induced = this.generation > rec.lastGen;
        rec.lastGen = this.generation;
        if (induced) {
            this.inducedReReads++;
            this.inducedReReadChars += size;
            rec.inducedReads++;
            rec.inducedChars += size;
            this.inducedByKind[kind] = (this.inducedByKind[kind] || 0) + 1;
            // Confirmed when the compressor told us it discarded exactly the
            // content this key last held.
            const confirmed = rec.hash != null && this._droppedHashes.has(rec.hash);
            if (confirmed) this.confirmedInduced++; else this.suspectedInduced++;
            if (hash != null) rec.hash = hash;
            return confirmed ? 'confirmed-induced-re-read' : 'induced-re-read';
        }
        if (hash != null) rec.hash = hash;
        this.sameGenReReads++;
        return 're-read';
    }

    /**
     * Quality verdict from the induced-re-read share and the net saving.
     * @returns {'good'|'marginal'|'poor'|'n/a'}
     */
    verdict() {
        if (this.compressions + this.compactions === 0) return 'n/a';
        if (this.netCharsSaved() < 0) return 'poor';       // cost more than it saved
        if (this.inducedReReads === 0) return 'good';
        // More than a third of re-reads caused by compression → tune the policy.
        return this.inducedShare() > 0.34 ? 'marginal' : 'good';
    }

    /** Fraction of re-reads that crossed a compression boundary (0..1). */
    inducedShare() {
        return this.reReads === 0 ? 0 : this.inducedReReads / this.reReads;
    }

    /** Chars saved by compaction MINUS chars re-fetched because of it. */
    netCharsSaved() {
        return this.charsSaved - this.inducedReReadChars;
    }

    /** Retrievals that most often had to be re-run after a compression. */
    topInducedFiles(limit = 5) {
        return [...this.files.entries()]
            .filter(([, r]) => r.inducedReads > 0)
            .sort((a, b) => b[1].inducedReads - a[1].inducedReads || b[1].inducedChars - a[1].inducedChars)
            .slice(0, limit)
            .map(([key, r]) => ({ key, tool: r.kind, induced_reads: r.inducedReads, induced_chars: r.inducedChars }));
    }

    /** Flat, log-friendly summary (goes into the 📊 Efficiency Report). */
    report() {
        return {
            compression_events: this.compressions + this.compactions,
            compressions: this.compressions,
            compactions: this.compactions,
            distinct_files_read: this.files.size,
            reads: this.reads,
            re_reads: this.reReads,
            re_reads_same_generation: this.sameGenReReads,
            // ── quality signals ──
            compression_induced_re_reads: this.inducedReReads,
            compression_induced_re_read_chars: this.inducedReReadChars,
            compression_induced_by_tool: this.inducedByKind,
            // Stage 3 — causal vs merely temporal attribution.
            confirmed_induced: this.confirmedInduced,
            suspected_induced: this.suspectedInduced,
            // Stage 4 — did the summaries keep the concrete details?
            summary_retention_mean: this.meanRetention(),
            summary_retention_samples: this.retentionSamples.length,
            induced_share: Number(this.inducedShare().toFixed(3)),
            chars_saved: this.charsSaved,
            net_chars_saved: this.netCharsSaved(),
            quality: this.verdict(),
            top_induced_files: this.topInducedFiles(),
            hint: this._hint(),
        };
    }

    _hint() {
        switch (this.verdict()) {
            case 'poor':
                return 'Compression is NET NEGATIVE — it removed less context than the agent had to re-read back. Raise KEEP_RECENT_RESULTS or widen the read-snapshot preservation budget.';
            case 'marginal':
                return 'A large share of re-reads follow a compression — the policy is dropping content that is still needed. Check read-snapshot preservation.';
            case 'good':
                return 'Compression is retaining what the agent needs.';
            default:
                return 'No compression ran in this task.';
        }
    }
}
