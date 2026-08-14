// timelineItems — the VOCABULARY of a timeline item.
//
// What kind of moment an item is, what it should be labelled, what a step DID,
// and how a line breaks into prose plus an openable file. All pure: every export
// takes an item and returns data.
//
// The rendering moved to svelte/monitor/Timeline*.svelte (region 3 of the
// migration). What lived here before was ~340 lines of string concatenation plus
// a 72-line `bindItem` that re-attached listeners to freshly-written innerHTML
// after every render — the single largest instance of the pattern that produced
// the dead-button bugs.
//
// Icons are named here rather than chosen in the components, because the naming
// is a decision ("a write reads differently from a read") and not markup. They
// come from the shared inline-SVG set, never emoji: emoji render in whatever
// emoji font the machine has — the reason a task looked different on another PC —
// and cannot take the theme colour.

/**
 * Minimal escaping for text interpolated into HTML.
 *
 * Still exported because hubStrip.js is not migrated yet. Components must NOT use
 * it: Svelte escapes interpolations itself, and calling esc() there would show
 * literal `&amp;` to the user.
 */
export function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Elapsed seconds between two epoch stamps, or null when either is missing. */
export function spanOf(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return Math.round((to - from) / 1000);
}

/** "3m 20s" / "18s" — a duration a reader can size up without doing arithmetic. */
export function spanLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
}

/** Feed-line type → icon name in the shared SVG set. */
const LINE_ICON = { tool: 'tool', error: 'alert', confirm: 'pause', thought: 'thought', live: 'thought' };
export const lineIconName = (type) => LINE_ICON[type] || 'tool';

/** Deliverable kind → {icon, label}. */
const DELIVERABLE_LABEL = {
    markdown: ['report', 'Proposal'],
    table: ['table', 'Result'],
    'file-list': ['folder', 'Files'],
    'code-edit': ['edit', 'Changes'],
};

/**
 * How a deliverable should be titled.
 * @param {string} envKind present_result envelope kind
 * @param {string} [fallback] label when the kind is unknown
 */
export function deliverableLabel(envKind, fallback = 'Result') {
    const hit = DELIVERABLE_LABEL[envKind];
    return hit ? { icon: hit[0], label: hit[1] } : { icon: 'report', label: fallback };
}

/** Icon for a tool chip: writing tools read differently from reading ones. */
const CHIP_ICON = {
    read_file: 'file', read_office: 'file', list_files: 'folder', glob: 'folder',
    grep_search: 'search', symbol_search: 'search', web_search: 'search',
    write_file: 'edit', multi_replace_file_content: 'edit', replace_lines: 'edit',
    write_xlsx: 'edit', create_artifact: 'edit', update_artifact: 'edit',
    delete_file: 'trash', move_file: 'edit', run_command: 'code',
    verify_syntax: 'shield', fetch_url: 'plug', read_resource: 'plug',
};
const WRITE_CHIPS = new Set(['write_file', 'multi_replace_file_content', 'replace_lines',
    'write_xlsx', 'create_artifact', 'update_artifact', 'delete_file', 'move_file']);

/** Chips for a completed run's stats: steps, tool count, tokens, duration. */
export function statChips(stats = {}) {
    const chips = [];
    if (stats.steps) chips.push({ icon: 'steps', text: `${stats.steps} steps` });
    const toolTotal = Object.values(stats.tools || {}).reduce((a, c) => a + (c || 0), 0);
    if (toolTotal) chips.push({ icon: 'tool', text: String(toolTotal) });
    if (stats.tokens) {
        const t = stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1)}k` : String(stats.tokens);
        chips.push({ icon: 'tokens', text: `${t} tok` });
    }
    if (stats.durationMs) chips.push({ icon: 'clock', text: `${Math.round(stats.durationMs / 1000)}s` });
    return chips;
}

/**
 * What a step DID, as chips for its first line: read? searched? wrote?
 *
 * A folded step is the normal state, so its one visible line has to answer "what
 * happened here" without being opened.
 *
 * @returns {{chips: Array<{tool,icon,write}>, more: number}}
 */
export function toolChipList(lines) {
    const seen = [];
    for (const l of (lines || [])) {
        if (!l.tool || seen.includes(l.tool)) continue;
        seen.push(l.tool);
    }
    const shown = seen.slice(0, 3);
    return {
        chips: shown.map(t => ({ tool: t, icon: CHIP_ICON[t] || 'tool', write: WRITE_CHIPS.has(t) })),
        more: seen.length - shown.length,
    };
}

/**
 * One line inside a reasoning step, broken into its parts.
 *
 * When the line carries the file its tool acted on, that file becomes its own
 * control rather than staying inside the sentence — being able to open what a
 * step touched, from the step itself, is the thing a terminal transcript cannot
 * do. The prose then drops a trailing ": basename" so the name is not said twice.
 *
 * @returns {{text, prose, path, base, write, clampable, icon, isError}}
 */
export function stepLineParts(line = {}) {
    const text = String(line.text ?? '');
    const path = (typeof line.path === 'string' && line.path.trim()) ? line.path : '';
    const base = path ? path.replace(/[\/]+$/, '').split(/[\/]/).pop() : '';
    const prose = (base && text.endsWith(`: ${base}`))
        ? text.slice(0, -1 * (base.length + 2))
        : text;
    return {
        text,
        prose,
        path,
        base,
        write: !!line.write,
        // A long line with no file to offer is clamped and opens on click.
        clampable: !path && prose.length > 90,
        icon: lineIconName(line.type),
        isError: line.type === 'error',
    };
}

/**
 * The chapter each item belongs to. This is the vocabulary the rail speaks: a
 * reader should be able to tell what part of the story they are looking at from
 * the marker colour alone, without reading a word.
 */
export function chapterKind(item) {
    switch (item?.kind) {
        case 'request':   return 'request';
        case 'turn':      return 'turn';
        case 'group':     return 'step';
        // A folded exchange's working, standing in for the steps it replaced.
        case 'fold':      return 'bare';
        // A line that arrived before the run's first reasoning. It is a fragment,
        // not a chapter — giving it a numbered frame produced the empty "STEP"
        // boxes with nothing in them.
        case 'activity':  return 'bare';
        case 'narration': return 'note';
        case 'task_progress': return 'progress';
        case 'ask':       return item.answered ? 'answered' : 'question';
        case 'confirm':   return 'approval';
        case 'document':
        case 'deliverable': return 'deliverable';
        case 'run':       return 'final';
        case 'error':     return 'error';
        default:          return 'step';
    }
}

const CHAPTER_TAG = {
    request: 'Request',
    step: 'Step',
    note: 'Note',
    progress: 'Progress',
    question: 'Question',
    answered: 'Answered',
    approval: 'Approval',
    deliverable: 'Deliverable',
    final: 'Agent · Final',
    error: 'Error',
};

/**
 * The kind tag that heads a chapter, or '' when the chapter gets no heading row.
 *
 * STEPS get none: their number and time live inside the card's own first line. A
 * separate "21:23:05 STEP 08" strip above every step doubled the vertical cost of
 * the most repeated element on the page for no added meaning. A folded result is
 * one line by design, so a heading above it would double its cost for nothing.
 */
export function chapterTag(item) {
    const kind = chapterKind(item);
    if (kind === 'step' || kind === 'bare' || kind === 'turn') return '';
    if (item?._bodyless) return '';
    return CHAPTER_TAG[kind] || '';
}

/**
 * Base CSS classes for the item's wrapper row.
 *
 * Every item is a CHAPTER on the rail; the kind drives the marker colour and the
 * card treatment, so one class carries both.
 *
 * The INTERACTIVE state classes (`collapsed`, `is-open`) are deliberately NOT
 * here. They are owned by TimelineItem.svelte, which seeds them from the model
 * and writes back to it. Deriving them from the model here instead would not
 * re-render on a click: the items are plain objects, not `$state`, so mutating
 * `item.collapsed` is invisible to Svelte.
 */
export function itemClass(item) {
    return `tl-chapter tl-${chapterKind(item)}` + (item.live ? ' is-live' : '');
}

/** Word count for a folded result's one-line summary. */
export function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
