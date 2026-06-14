// icons — small inline-SVG icon set for UI chrome (replaces emoji icons so the
// look is consistent across platforms/fonts and themable via currentColor).
//
// Usage: `icon('memory')` → an <svg> string sized 1em that inherits the text
// colour. Pass a size (px) to override: `icon('memory', 18)`.
// All glyphs are 20×20 viewBox, stroke-based, currentColor.

const PATHS = {
    // LLM / model — a chip/CPU
    llm: `<rect x="6" y="6" width="8" height="8" rx="1.5"/><rect x="8.5" y="8.5" width="3" height="3" rx="0.5"/>
        <path d="M8 6V3M12 6V3M8 17v-3M12 17v-3M6 8H3M6 12H3M17 8h-3M17 12h-3"/>`,
    // MCP / connections — linked nodes
    mcp: `<circle cx="5" cy="5" r="2.2"/><circle cx="15" cy="15" r="2.2"/><circle cx="15" cy="5" r="2.2"/>
        <path d="M6.6 6.6l6.8 6.8M7.2 5h5.6"/>`,
    // General / settings — 8-tooth cog (solid gear silhouette, not a thin sun)
    gear: `<path d="M18.28 8.09 L18.28 11.91 L15.90 11.92 L15.52 12.81 L17.21 14.50 L14.50 17.21 L12.81 15.52 L11.92 15.90 L11.91 18.28 L8.09 18.28 L8.08 15.90 L7.19 15.52 L5.50 17.21 L2.79 14.50 L4.48 12.81 L4.10 11.92 L1.72 11.91 L1.72 8.09 L4.10 8.08 L4.48 7.19 L2.79 5.50 L5.50 2.79 L7.19 4.48 L8.08 4.10 L8.09 1.72 L11.91 1.72 L11.92 4.10 L12.81 4.48 L14.50 2.79 L17.21 5.50 L15.52 7.19 L15.90 8.08 Z"/>
        <circle cx="10" cy="10" r="2.7"/>`,
    // Templates — document with lines
    template: `<rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M7 6.5h6M7 10h6M7 13.5h4"/>`,
    // Skills — lightning bolt
    bolt: `<path d="M11 2.5L4.5 11h4l-1 6.5L15 9h-4l0-6.5z"/>`,
    // RAG / search — magnifier
    search: `<circle cx="8.5" cy="8.5" r="5"/><line x1="12.2" y1="12.2" x2="17" y2="17"/>`,
    // Memory — stacked database (long-term store)
    memory: `<ellipse cx="10" cy="5" rx="6" ry="2.5"/>
        <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5"/>
        <path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>`,
    // Develop mode — code brackets </>
    code: `<polyline points="7,6 3,10 7,14"/><polyline points="13,6 17,10 13,14"/><line x1="11.5" y1="4" x2="8.5" y2="16"/>`,
    // Calendar — date grouping
    calendar: `<rect x="3" y="4.5" width="14" height="13" rx="1.5"/><line x1="3" y1="8" x2="17" y2="8"/>
        <line x1="7" y1="2.5" x2="7" y2="6"/><line x1="13" y1="2.5" x2="13" y2="6"/>`,
    // Folder — workspace grouping
    folder: `<path d="M2.5 6.5a1.5 1.5 0 011.5-1.5h3l2 2h5a1.5 1.5 0 011.5 1.5v6a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 14V6.5z"/>`,
};

/** Return an inline SVG string for `name`, sized `size` px (default 1em). */
export function icon(name, size) {
    const body = PATHS[name];
    if (!body) return '';
    const dim = size ? `${size}px` : '1em';
    return `<svg class="ui-icon ui-icon-${name}" viewBox="0 0 20 20" fill="none" stroke="currentColor" ` +
        `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
        `style="width:${dim};height:${dim};display:inline-block;vertical-align:-0.15em;flex-shrink:0;">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
