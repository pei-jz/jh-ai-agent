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
 *   loaded   → sent with FULL schemas (top-`top` by relevance to `query`,
 *              plus any in `alwaysInclude` by name).
 *   deferred → NOT sent this run.
 * Pruning is skipped (everything loaded) when there's no query or the tool
 * count is at most `minCount` (small sets aren't worth pruning).
 */
export function selectMcpTools(tools, query, { top = 5, alwaysInclude = new Set(), minCount = 8 } = {}) {
    if (!Array.isArray(tools) || tools.length === 0) return { loaded: [], deferred: [] };
    if (!query || tools.length <= minCount) return { loaded: tools.slice(), deferred: [] };

    const qUnits = textUnits(query);
    const ranked = tools
        .map((t, idx) => ({ t, idx, score: scoreToolRelevance(t, qUnits) }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);

    const loadedSet = new Set(ranked.slice(0, top).map(r => r.t));
    for (const t of tools) {
        if (alwaysInclude.has(t.name)) loadedSet.add(t);
    }

    return {
        loaded: tools.filter(t => loadedSet.has(t)),
        deferred: tools.filter(t => !loadedSet.has(t)),
    };
}

