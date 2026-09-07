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
    // General / settings — 6-tooth cog. Machine-generated (tip r=8.3, root r=6.3)
    // so the teeth are actually even; the 8-tooth polygon this replaces was
    // plotted by hand and its unevenness was visible at 13px, where most of
    // these are rendered. Six teeth, not eight: fewer and larger survives at
    // small sizes. Same path as the sidebar's config glyph, deliberately.
    gear: `<path d="M7.64 4.16 L7.85 1.98 L12.15 1.98 L12.36 4.16 L13.88 5.04 L15.87 4.13 L18.02 7.85 L16.24 9.12 L16.24 10.88 L18.02 12.15 L15.87 15.87 L13.88 14.96 L12.36 15.84 L12.15 18.02 L7.85 18.02 L7.64 15.84 L6.12 14.96 L4.13 15.87 L1.98 12.15 L3.76 10.88 L3.76 9.12 L1.98 7.85 L4.13 4.13 L6.12 5.04 Z"/>
        <circle cx="10" cy="10" r="2.6"/>`,
    // Templates — document with lines
    template: `<rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M7 6.5h6M7 10h6M7 13.5h4"/>`,
    // Skills — lightning bolt. Redrawn symmetric about the diagonal: the old
    // path had a flat `l0 -6.5` right edge against a sloped left one, so the
    // glyph leaned.
    bolt: `<path d="M11.4 2.2L4.2 11.2h4.3l-.9 6.6 7.2-9h-4.3z"/>`,
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
    // Sun — switch to light theme
    sun: `<circle cx="10" cy="10" r="3.5"/>
        <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>`,
    // Moon — switch to dark theme
    moon: `<path d="M16.5 12.2A7 7 0 018.2 3.6a7 7 0 108.3 8.6z"/>`,
    // New chat — document with a plus
    'doc-plus': `<path d="M11.5 2.5H5.5A1.5 1.5 0 004 4v12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0016 16V7z"/>
        <path d="M11.5 2.5V7H16M10 10v4M8 12h4"/>`,
    // History — clock with a back arrow
    history: `<path d="M3.5 10a6.5 6.5 0 103-5.5"/><path d="M3.5 2.5v3.2h3.2"/><path d="M10 6.5V10l2.5 1.8"/>`,
    // Trash / delete
    trash: `<path d="M3.5 5.5h13M8 5.5V4a1 1 0 011-1h2a1 1 0 011 1v1.5M5 5.5l.8 10.3A1.5 1.5 0 007.3 17.2h5.4a1.5 1.5 0 001.5-1.4l.8-10.3"/>
        <path d="M8.2 8.5v6M11.8 8.5v6"/>`,
    // Plus — create / add
    plus: `<path d="M10 4v12M4 10h12"/>`,
    // Minus — minimise / collapse
    minus: `<path d="M4 10h12"/>`,
    // Palette — the theme picker. A dished board with three wells and a thumb
    // hole. Three elements, 20px grid, like the rest of the set.
    palette: `<path d="M10 2.6c4.1 0 7.4 2.9 7.4 6.5 0 2.1-1.7 3.3-3.4 3.3h-1.4c-1 0-1.8.8-1.8 1.8 0 .5.2.9.5 1.2.3.4.5.8.5 1.3 0 1-.8 1.7-1.8 1.7-4.1 0-7.4-3.3-7.4-7.9S5.9 2.6 10 2.6z"/><circle cx="7.2" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="11.2" cy="6.4" r="1.05" fill="currentColor" stroke="none"/>`,
    // Pin / unpin — whether the request holds the top of the reading column.
    // A drawing pin seen from the side: head, shaft, point. Three elements.
    pin: `<path d="M7.2 2.8h5.6l-1 3.4 2.6 2.6-4 .6-2.4 3.4-.6-3.8-3.8-.6 3.4-2.4z"/><path d="M9.4 12.4L8.2 17.2"/>`,
    'pin-off': `<path d="M7.2 2.8h5.6l-1 3.4 2.6 2.6-4 .6-2.4 3.4-.6-3.8-3.8-.6 3.4-2.4z" opacity=".45"/><path d="M9.4 12.4L8.2 17.2" opacity=".45"/><path d="M3.2 3.2l13.6 13.6"/>`,
    // Plug — generic connection / API
    plug: `<path d="M7 3v4M13 3v4M5.5 7h9v3a4.5 4.5 0 01-9 0z"/><path d="M10 14.5V17"/>`,
    // Sparkle — Gemini / "ask AI"
    sparkle: `<path d="M10 2.5l1.7 5.1 5.1 1.7-5.1 1.7L10 16.1l-1.7-5.1-5.1-1.7 5.1-1.7z"/>
        <path d="M16 14.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" stroke-width="1"/>`,
    // Bot — OpenAI GPT / generic robot
    bot: `<rect x="4" y="7" width="12" height="8.5" rx="2"/><circle cx="7.8" cy="11" r="0.9" fill="currentColor" stroke="none"/>
        <circle cx="12.2" cy="11" r="0.9" fill="currentColor" stroke="none"/><path d="M10 7V4.2M10 4.2a1.2 1.2 0 10-.01 0z"/>`,
    // Brain — Anthropic Claude / memory-adjacent
    brain: `<path d="M8.8 3.2a2.6 2.6 0 00-2.5 2 2.7 2.7 0 00-1.8 4.3 2.7 2.7 0 001.3 4.3 2.6 2.6 0 004.2 1.6V4.6a2.6 2.6 0 00-1.2-1.4z"/>
        <path d="M11.2 3.2a2.6 2.6 0 012.5 2 2.7 2.7 0 011.8 4.3 2.7 2.7 0 01-1.3 4.3 2.6 2.6 0 01-4.2 1.6V4.6a2.6 2.6 0 011.2-1.4z"/>`,
    // Shield — safety limits
    shield: `<path d="M10 2.5l6 2.2v4.6c0 3.6-2.5 6.4-6 8.2-3.5-1.8-6-4.6-6-8.2V4.7z"/><path d="M7.5 10l1.8 1.8 3.2-3.6"/>`,
    // Clipboard — copy
    clipboard: `<rect x="5" y="4" width="10" height="13.5" rx="1.5"/><path d="M7.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1"/><path d="M7.5 8.5h5M7.5 11.5h5M7.5 14.5h3"/>`,
    // Stop — abort a run
    stop: `<rect x="5" y="5" width="10" height="10" rx="1.5"/>`,
    // Save — floppy disk. The body is now a real rounded rect with a clipped
    // corner instead of a square path nudged sideways by a transform, which is
    // why the old one sat half a pixel left of everything beside it.
    save: `<path d="M4.5 3h8.2L16.5 6.8V16a1.5 1.5 0 01-1.5 1.5H4.5A1.5 1.5 0 013 16V4.5A1.5 1.5 0 014.5 3z"/>
        <path d="M6.6 3v4.2h6V3"/><path d="M6.1 17.5v-5.6h7.8v5.6"/>`,
    // Edit — pencil
    edit: `<path d="M13.5 3.5l3 3L7 16l-3.8.8L4 13z"/><path d="M11.8 5.2l3 3"/>`,
    // Cloud — Azure / hosted
    cloud: `<path d="M6 15.5a3.5 3.5 0 01-.4-7A4.5 4.5 0 0114.3 9a3.3 3.3 0 01-.3 6.5z"/>`,
    // Server — local model host (Ollama etc.)
    server: `<rect x="3.5" y="3.5" width="13" height="5.5" rx="1.2"/><rect x="3.5" y="11" width="13" height="5.5" rx="1.2"/>
        <circle cx="6.5" cy="6.2" r="0.8" fill="currentColor" stroke="none"/><circle cx="6.5" cy="13.7" r="0.8" fill="currentColor" stroke="none"/>`,

    // Paper theme — a ruled sheet with a folded corner
    paper: `<path d="M4.5 2.5h8L16 6v11.5a1 1 0 01-1 1H4.5a1 1 0 01-1-1v-14a1 1 0 011-1z"/>
        <path d="M12.2 2.6V6.2h3.7"/><path d="M6 9.5h7M6 12h7M6 14.5h4.5"/>`,

    // Bamboo slip theme — a bound bundle of slats (two binding cords)
    bamboo: `<path d="M6 3v14M10 3v14M14 3v14"/><path d="M4.5 7h11M4.5 13h11"/>`,

    // Monitor / Task view — a screen with a live pulse, matching the sidebar's
    // monitor glyph. The chart-on-a-baseline it replaces filled only 9 of the
    // 20 grid (every other glyph fills ~15) and duplicated the analytics idea.
    // Home — back to the start screen. A roof over a door, on the same 20×20
    // grid as the rest: the eaves sit at y=9 so it optically matches `monitor`
    // and `folder` when the two sit side by side in the rail header.
    home: `<path d="M3 9.4 L10 3.4 L17 9.4"/>
        <path d="M4.9 8.5V16.4h10.2V8.5"/>
        <path d="M8.3 16.4v-4.3h3.4v4.3"/>`,

    monitor: `<rect x="2.3" y="3.6" width="15.4" height="12.8" rx="2.4"/>
        <path d="M5.2 10h2.1l1.5-3.1 2.3 6.2 1.4-3.1h2.3"/>`,

    // ── Task-view content icons ────────────────────────────────────────────
    // These replace the emoji the Task view used to draw with. Emoji render in
    // whatever emoji font the machine happens to have — the reason the same task
    // looked different on another PC — and they cannot take the theme colour.
    /** A tool call — wrench. */
    tool: `<path d="M15.5 5.2a3.6 3.6 0 01-4.7 4.7l-5.2 5.2a1.6 1.6 0 01-2.3-2.3l5.2-5.2a3.6 3.6 0 014.7-4.7l-2.2 2.2 1.9 1.9z"/>`,
    /** A reasoning step — speech/thought bubble. */
    thought: `<path d="M4 5.5h12a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 01-1.5 1.5H8.5L5 16.5V14H4a1.5 1.5 0 01-1.5-1.5v-5A1.5 1.5 0 014 5.5z"/>`,
    /** An unanswered question. */
    question: `<circle cx="10" cy="10" r="7.2"/><path d="M8.2 8a1.9 1.9 0 013.6.8c0 1.3-1.8 1.6-1.8 3"/><circle cx="10" cy="14.2" r="0.85" fill="currentColor" stroke="none"/>`,
    /** A failure. */
    alert: `<path d="M10 3.2l7 12.3H3z"/><path d="M10 8v3.4"/><circle cx="10" cy="13.6" r="0.8" fill="currentColor" stroke="none"/>`,
    /** Awaiting approval — pause. */
    pause: `<rect x="6" y="4.5" width="3" height="11" rx="1"/><rect x="11" y="4.5" width="3" height="11" rx="1"/>`,
    /** A delivered result — document with lines. */
    report: `<path d="M5 3.5h6.5L15.5 7v9.5a1 1 0 01-1 1h-9a1 1 0 01-1-1v-12a1 1 0 011-1z"/>
        <path d="M11.2 3.6V7.2h3.9"/><path d="M7.2 10.5h5.6M7.2 13.2h4"/>`,
    /** Tabular output. */
    table: `<rect x="3" y="4.5" width="14" height="11" rx="1.3"/><path d="M3 8.2h14M8.2 8.2v7.3"/>`,
    /** A single file. */
    file: `<path d="M5.5 3h6L15 6.5v10a1 1 0 01-1 1H5.5a1 1 0 01-1-1v-12a1 1 0 011-1z"/><path d="M11.2 3.1V6.7h3.7"/>`,
    /** Work in progress — clock. */
    clock: `<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.7"/>`,
    /** Steps taken — a pin. */
    steps: `<path d="M10 17.5s5.2-5 5.2-8.4a5.2 5.2 0 10-10.4 0C4.8 12.5 10 17.5 10 17.5z"/><circle cx="10" cy="9.1" r="1.9"/>`,
    /** Token / compute count — a coin (ring in a disc). Replaces a circle with a
     *  plus in it, which is the universal "add" glyph and read as a button.
     *  Not a side-on stack: that is already the `memory` cylinder. */
    tokens: `<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.1"/>`,
    /** Done — a checkmark. Used by the task_progress checklist. */
    check: `<path d="M4 10.5l4 4 8-9"/>`,
    /** Pending — an empty ring. Used by the task_progress checklist. */
    circle: `<circle cx="10" cy="10" r="7"/>`,
    /** In progress — a ring with a pulsing dot. Used by the task_progress checklist. */
    pulse: `<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.4" fill="currentColor" stroke="none"/>`,
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
