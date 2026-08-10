// ToolRelevance — PURE selection logic for MCP tool pruning.
//
// Problem: an MCP server like Backlog exposes 50+ tools; sending every full
// schema to the LLM each step costs 10–20K tokens AND degrades tool-choice
// accuracy. Strategy (user-specified):
//   • Built-in (native) tools: always sent in full — unchanged.
//   • MCP tools: only the top-N most relevant to the task prompt are sent;
//     the rest are omitted for that run.
//   • External app callers are exempt (they already scope tools via intents).
//
// Relevance reuses the memory layer's textUnits (latin words + CJK character
// bigrams), so Japanese prompts rank correctly.

import { textUnits } from '../memory/MemoryScoring.js';

/** Fraction of query units found in the tool's name+description (0–1). */
export function scoreToolRelevance(tool, queryUnits) {
    if (!queryUnits || queryUnits.size === 0) return 0;
    const hay = `${tool.name || ''} ${tool.description || ''}`.toLowerCase();
    let hits = 0;
    for (const u of queryUnits) if (hay.includes(u)) hits++;
    return hits / queryUnits.size;
}

/**
 * Split MCP tools into { loaded, deferred }.
 *   loaded   → sent with FULL schemas, plus any in `alwaysInclude` by name.
 *   deferred → NOT sent this run.
 *
 * Two selection modes:
 *   • Top-N (default): the `top` most relevant tools (count-gated — pruning is
 *     skipped when there's no query or ≤ `minCount` tools).
 *   • Score threshold (`minScore` > 0): ONLY tools scoring ≥ `minScore`, capped
 *     at `top`. Used by Simple chat to avoid sending irrelevant MCP tools at all
 *     — if nothing is relevant, NONE are sent (no wasted tokens). `minCount` is
 *     ignored in this mode (we always score-prune).
 */
export function selectMcpTools(tools, query, { top = 5, alwaysInclude = new Set(), minCount = 8, minScore = 0 } = {}) {
    if (!Array.isArray(tools) || tools.length === 0) return { loaded: [], deferred: [] };
    if (!query) return { loaded: tools.slice(), deferred: [] };
    if (minScore <= 0 && tools.length <= minCount) return { loaded: tools.slice(), deferred: [] };

    const qUnits = textUnits(query);
    const ranked = tools
        .map((t, idx) => ({ t, idx, score: scoreToolRelevance(t, qUnits) }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);

    const picked = (minScore > 0)
        ? ranked.filter(r => r.score >= minScore).slice(0, top)
        : ranked.slice(0, top);
    const loadedSet = new Set(picked.map(r => r.t));
    for (const t of tools) {
        if (alwaysInclude.has(t.name)) loadedSet.add(t);
    }

    return {
        loaded: tools.filter(t => loadedSet.has(t)),
        deferred: tools.filter(t => !loadedSet.has(t)),
    };
}

