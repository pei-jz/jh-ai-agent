// timelineStyles — the Task view's narrative timeline and inspector.
//
// Kept out of MonitorView.styles.js because that file is one 1,200-line template
// literal, and appending to it has already broken the module once.
//
// The visual language follows the accepted design direction: proposal C's
// vertical rail of chapters (a run reads as a story) plus proposal A's inspector
// column (everything you look UP lives beside the reading surface, not in it).

export const TIMELINE_STYLES = `
    /* ── Chapters on a rail ─────────────────────────────────────────────── */
    /* The marker colour says what kind of moment this is before a word is read. */
    .mtl { position: relative; padding-left: 30px; }
    .mtl::before {
        content: ''; position: absolute; left: 9px; top: 8px; bottom: 8px; width: 2px;
        background: linear-gradient(180deg, var(--border), var(--accent-glow) 40%, var(--border));
    }
    /* Steps are the most repeated element, so they get the tightest rhythm;
       the chapters that mark a change of phase keep their breathing room. */
    .tl-chapter { position: relative; margin-bottom: var(--space-4); }
    /* Folded steps are the densest part of the story — dozens in a row. They sit
       almost flush, so a long run reads as one list instead of a column of
       floating cards. (Off the 4px scale on purpose: this is a hairline.) */
    .tl-step { margin-bottom: 3px; }
    .tl-step + .tl-step { margin-top: 0; }
    /* The rail's centre is 10px from .mtl's left edge (left:9px + half of 2px),
       and the chapter box starts at 30px. A marker is centred on the rail when
       its own centre lands there: 10 - 30 - width/2. Both markers were a few
       pixels light, which read as a wobble down the whole column. */
    .tl-chapter::before {
        content: ''; position: absolute; left: -25px; top: 4px;
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--bg-secondary); border: 2px solid var(--border);
        transition: background var(--transition-fast), border-color var(--transition-fast);
    }
    .tl-chapter.is-live::before { box-shadow: 0 0 8px var(--accent-glow); }
    .tl-step.is-live::before,
    .tl-note.is-live::before { background: var(--accent); border-color: var(--accent); }
    /* The request's marker is a REAL button, so it can be clicked; the shared
       pseudo-marker is suppressed for this kind to avoid two dots. */
    .tl-request::before { display: none; }
    .tl-story-toggle {
        position: absolute; left: -27px; top: 3px; z-index: 3;
        width: 14px; height: 14px; padding: 0;
        border-radius: 50%; cursor: pointer;
        background: var(--text-tertiary); border: 2px solid var(--text-tertiary);
        transition: background var(--transition-fast), border-color var(--transition-fast);
    }
    .tl-story-toggle:hover { background: var(--accent); border-color: var(--accent); }
    /* Hollow = this exchange's working is folded. */
    .tl-story-toggle.is-folded { background: var(--bg-secondary); }

    /* ── A folded exchange, standing in for its steps ────────────────────── */
    .tl-fold-bar {
        display: flex; align-items: center; gap: var(--space-2); width: 100%;
        padding: var(--space-2) var(--space-3);
        font-size: var(--fs-xs); color: var(--text-tertiary);
        text-align: left; cursor: pointer;
        background: var(--bg-secondary); border: 1px dashed var(--border);
        border-radius: var(--radius-md);
    }
    .tl-fold-bar:hover { border-color: var(--accent); color: var(--text-secondary); }
    .tl-fold-n { font-weight: 600; color: var(--text-secondary); }
    .tl-fold-dur { font-family: var(--font-mono); }
    .tl-fold-hint { margin-left: auto; opacity: .7; }

    /* Boundary between exchanges. */
    .tl-turn { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-5) 0 var(--space-4); }
    .tl-turn::before, .tl-turn::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--border); }
    .tl-turn-label {
        flex-shrink: 0; font-size: var(--fs-2xs); font-weight: 700;
        letter-spacing: .08em; text-transform: uppercase; color: var(--text-tertiary);
    }
    .tl-turn.tl-chapter::before { position: static; width: auto; height: 1px; border: 0; border-radius: 0; }
    .tl-deliverable::before,
    .tl-final::before { background: var(--success); border-color: var(--success); }
    .tl-question::before,
    .tl-approval::before { background: var(--warning); border-color: var(--warning); }
    .tl-error::before { background: var(--error); border-color: var(--error); }

    .tl-when { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
    .tl-clock { font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-tertiary); }
    .tl-tag {
        font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em;
        text-transform: uppercase; padding: 2px 8px; border-radius: 10px;
        background: var(--bg-tertiary); color: var(--text-secondary);
    }
    .tl-tag-step { background: var(--accent-glow-lg); color: var(--accent); }
    .tl-tag-note { background: var(--bg-tertiary); color: var(--text-tertiary); }
    .tl-tag-question, .tl-tag-approval { background: var(--warning-bg); color: var(--warning); }
    .tl-tag-deliverable, .tl-tag-final { background: var(--success-bg); color: var(--success); }
    .tl-tag-error { background: var(--error-bg); color: var(--error); }

    /* ── Cards ──────────────────────────────────────────────────────────── */
    .tl-card {
        background: var(--bg-card-solid); border: 1px solid var(--border);
        border-radius: var(--radius-md); padding: var(--space-3) var(--space-4);
    }
    .tl-card-request { background: var(--accent-glow-lg); border-color: var(--accent-glow); }
    .tl-q-label {
        font-size: var(--fs-2xs); font-weight: 700; color: var(--accent);
        text-transform: uppercase; letter-spacing: .08em; margin-bottom: 1px;
    }
    /* The request is a HEADING for the exchange, not the content of it. At body
       size it cost most of a screen each, which is why three folded exchanges
       would not fit — the thing folding is supposed to buy. */
    .tl-q-text { font-size: var(--fs-sm); font-weight: 500; line-height: 1.45; }

    /* ── The current request stays in view while you read its working ────── */
    /* Each request sticks at the top of the panel; the next one to arrive paints
       over it (later in the DOM wins at the same z-index), so what you see
       pinned is always the exchange you are inside. */
    .tl-request {
        position: sticky; top: 0; z-index: 2;
        background: var(--bg-primary);
        padding-bottom: var(--space-1);
    }
    .tl-request .tl-card-request { padding: var(--space-2) var(--space-3); cursor: pointer; }
    /* CLAMPED, not cut off. A max-height simply hid the rest with no way to get
       at it; a line clamp keeps the pinned header a predictable size AND opens
       on click. The fade says there is more without costing a row. */
    .tl-request:not(.is-open) .tl-q-text {
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
        overflow: hidden;
        -webkit-mask-image: linear-gradient(180deg, #000 60%, rgba(0,0,0,.35) 100%);
                mask-image: linear-gradient(180deg, #000 60%, rgba(0,0,0,.35) 100%);
    }
    .tl-request.is-open .tl-card-request { max-height: 40vh; overflow-y: auto; }
    .tl-card-note { background: transparent; border-style: dashed; }
    .tl-note-label { font-size: var(--fs-2xs); color: var(--text-tertiary); margin-bottom: var(--space-1); }
    .tl-card-deliverable { border-color: var(--success); border-left-width: 3px; }
    .tl-card-h {
        display: flex; align-items: center; gap: var(--space-2);
        font-size: var(--fs-md); font-weight: 600; color: var(--success);
        padding-bottom: var(--space-2); margin-bottom: var(--space-3);
        border-bottom: 1px solid var(--border-light);
    }
    .tl-card-final { border-left: 3px solid var(--success); }
    /* A foldable card header. */
    .tl-fold-h { cursor: pointer; user-select: none; }
    .tl-fold-h:hover { color: var(--accent); }
    .tl-card-chev { margin-left: auto; font-size: var(--fs-2xs); color: var(--text-tertiary); }
    .tl-chapter.collapsed .tl-card-body { display: none; }
    .tl-chapter.collapsed .tl-card-h { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
    .tl-chapter.collapsed .tl-card-chev { transform: rotate(-90deg); }
    .tl-card-error { border-color: var(--error); }

    /* A step card opens from its FIRST LINE. */
    .tl-card-step { padding: 0; overflow: hidden; }
    .tl-step-title {
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-3); cursor: pointer; user-select: none;
    }
    .tl-step-title:hover { background: var(--bg-hover); }
    .tl-step-num {
        font-family: var(--font-mono); font-size: var(--fs-2xs); font-weight: 600;
        color: var(--text-tertiary); border: 1px solid var(--border);
        padding: 1px 7px; border-radius: var(--radius-sm); flex-shrink: 0;
    }
    .tl-step-num.is-live { color: var(--accent); border-color: var(--accent); background: var(--accent-glow-lg); }
    .tl-step-sum {
        flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tl-step-count {
        flex-shrink: 0; font-family: var(--font-mono);
        font-size: var(--fs-2xs); color: var(--text-tertiary);
        min-width: 14px; text-align: right;
    }
    .tl-step-at { flex-shrink: 0; font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-tertiary); }
    .tl-step-chev { flex-shrink: 0; font-size: var(--fs-2xs); color: var(--text-tertiary); }

    /* What the step did, readable while it is folded. */
    .tl-step-tools { display: inline-flex; gap: var(--space-1); flex-shrink: 0; }
    .tl-tchip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 6px; border-radius: var(--radius-sm);
        background: var(--bg-tertiary); border: 1px solid var(--border-light);
        font-family: var(--font-mono); font-size: var(--fs-2xs);
        color: var(--text-secondary); white-space: nowrap;
    }
    .tl-tchip.is-write { color: var(--warning); border-color: var(--warning-bg); }
    .tl-tchip.is-more { color: var(--text-tertiary); }

    /* A line that arrived before the run's first reasoning: part of the flow,
       not a chapter of its own. */
    .tl-bare { margin-bottom: var(--space-2); }
    .tl-bare::before { width: 6px; height: 6px; left: -23px; top: 7px; }
    .tl-bare-line {
        border-left: 1px solid var(--border-light);
        padding: 2px 0 2px var(--space-3);
    }
    .tl-step-body { padding: 0 var(--space-3) var(--space-2) 34px; }
    .tl-chapter.collapsed .tl-step-body { display: none; }
    .tl-chapter.collapsed .tl-step-chev { transform: rotate(-90deg); }

    /* Folding is per EXCHANGE and lives in the MODEL: a folded exchange's steps
       are not in the rendered list at all (withExchangeFolds), replaced by one
       summary bar. There is deliberately no CSS rule that hides them — a class
       on the whole list is what made one request fold every request. */

    /* What a step read or wrote — openable from the step itself. */
    .mstep-file {
        display: inline-flex; align-items: center; gap: var(--space-1);
        margin-left: auto; padding: 0 var(--space-2);
        border: 1px solid var(--border-light); border-radius: var(--radius-sm);
        font-family: var(--font-mono); font-size: var(--fs-2xs);
        color: var(--text-secondary); cursor: pointer;
        max-width: 260px; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; flex-shrink: 0;
    }
    .mstep-file:hover { color: var(--accent); border-color: var(--border-focus); }
    .mstep-file.is-write { color: var(--warning); border-color: var(--warning-bg); }

    /* ── Inspector ──────────────────────────────────────────────────────── */
    /* A sibling of the story panel with its OWN scroll: a reference column that
       scrolls away with the content is not a reference column. */
    .mtl-insp {
        flex: 0 0 264px; width: 264px;
        display: flex; flex-direction: column;
        overflow-y: auto; overscroll-behavior: contain;
        background: var(--bg-secondary);
        border: 1px solid var(--border); border-radius: var(--radius-lg);
        padding: var(--space-3);
        font-size: var(--fs-xs);
    }
    .insp-sec { margin-bottom: var(--space-4); }
    /* The workspace moved here out of its own fixed row above the story. Full path,
       wrapped rather than ellipsised — in a reference column you want to READ it. */
    .insp-ws {
        display: flex; align-items: flex-start; gap: var(--space-2);
        color: var(--text-secondary); font-size: var(--fs-2xs);
    }
    .insp-ws-path { font-family: var(--font-mono); word-break: break-all; line-height: 1.5; }
    .insp-h {
        font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .06em;
        text-transform: uppercase; color: var(--text-tertiary); margin-bottom: var(--space-2);
    }
    .insp-n { color: var(--text-tertiary); font-weight: 400; }
    .insp-row { display: flex; justify-content: space-between; gap: var(--space-2); padding: 2px 0; }
    .insp-k { color: var(--text-tertiary); }
    .insp-v { color: var(--text-primary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* Cost sits between the label and the token count: money is the secondary
       reading of the same row, so it gets the quieter colour and pushes right
       against the figure it prices. */
    .insp-cost {
        margin-left: auto; color: var(--text-tertiary); font-family: var(--font-mono);
        font-size: var(--fs-2xs); font-variant-numeric: tabular-nums;
    }
    .insp-row:last-child .insp-cost { color: var(--warning); }
    /* Footnote under the totals: how the figure was arrived at. */
    .insp-note {
        margin-top: 2px; color: var(--text-tertiary); font-size: var(--fs-2xs);
        text-align: right;
    }
    .insp-file, .insp-act, .insp-chap {
        display: flex; align-items: center; gap: var(--space-2);
        width: 100%; text-align: left; padding: 3px var(--space-1);
        background: none; border: 0; border-radius: var(--radius-sm);
        color: var(--text-secondary); font-size: var(--fs-xs); cursor: pointer;
    }
    .insp-act { border: 1px solid var(--border); padding: 6px var(--space-2); margin-bottom: var(--space-1); }
    .insp-file:hover, .insp-act:hover, .insp-chap:hover { background: var(--bg-hover); color: var(--accent); }
    .insp-file-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .insp-file-a { margin-left: auto; font-size: var(--fs-2xs); color: var(--text-tertiary); }

    /* Changed files as a TREE. The flat list of basenames it replaced could not
       answer "which part of the project did this touch?" — twelve rows all reading
       index.js say nothing. Indentation is inline (per depth) so the rail can stay
       a single flat node list and keep the keyed diff cheap. */
    .insp-tree { max-height: 340px; overflow-y: auto; margin: 0 calc(var(--space-1) * -1); }
    /* A directory row is a real <button> now: it folds its subtree. */
    .insp-tree-dir {
        display: flex; align-items: center; gap: var(--space-1);
        width: 100%; text-align: left;
        padding: 2px var(--space-1);
        background: none; border: 0; cursor: pointer;
        color: var(--text-tertiary); font-size: var(--fs-2xs);
        font-weight: 600; letter-spacing: .01em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .insp-tree-dir:hover { background: var(--bg-hover); color: var(--accent); }
    .insp-tree-chev { flex-shrink: 0; width: 8px; opacity: 0.7; }
    .insp-tree-n { overflow: hidden; text-overflow: ellipsis; }
    /* The file count is what keeps a FOLDED directory informative. */
    .insp-tree-count {
        margin-left: auto; flex-shrink: 0; padding-left: var(--space-1);
        font-weight: 400; opacity: 0.75;
    }
    /* A file row is indented past its directory's icon, so the names line up in a
       column instead of stepping with the folder glyphs. */
    .insp-tree-file { padding-top: 2px; padding-bottom: 2px; }
    .insp-tree-more {
        padding: var(--space-1); color: var(--text-tertiary); font-size: var(--fs-2xs);
    }
    .insp-chap-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
    .insp-chap.is-active { color: var(--accent); }
    .insp-chap.is-active .insp-chap-dot { background: var(--accent); }
    .insp-chap-question .insp-chap-dot { background: var(--warning); }
    .insp-chap-deliverable .insp-chap-dot { background: var(--success); }

    /* Token usage per step — where the budget actually went. */
    .insp-spark { display: flex; align-items: flex-end; gap: 3px; height: 46px; margin-bottom: var(--space-1); }
    /* Each bar is stacked out / cache / in from the top, so the colour tells you
       WHY a step was expensive, not just that it was. */
    .insp-bar {
        flex: 1 1 0; min-width: 3px; border-radius: 2px 2px 0 0; overflow: hidden;
        display: flex; flex-direction: column;
    }
    .insp-bar.is-last { outline: 1px solid var(--accent); outline-offset: 1px; }
    .insp-seg { display: block; width: 100%; }
    .insp-seg.is-in { background: var(--accent-dim); }
    .insp-seg.is-cache { background: var(--success); opacity: .75; }
    .insp-seg.is-out { background: var(--warning); }
    .insp-lg.is-in { color: var(--accent-dim); }
    .insp-lg.is-cache { color: var(--success); }
    .insp-lg.is-out { color: var(--warning); }
    .insp-spark-legend {
        display: flex; justify-content: space-between; gap: var(--space-2);
        font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-tertiary);
    }

    /* ── Detail header ──────────────────────────────────────────────────── */
    /* The request leads, then the vital signs, then the ids. The whole block is
       deliberately TIGHT: it is fixed furniture above a scrolling story, and at
       its previous rhythm it ate the top third of the panel — leaving a screenful
       of chrome above a few lines of the thing the user came to read.
       The workspace row and the changed-files bar that used to sit under it now
       live in the inspector, which is where reference material belongs. */
    /* SOLE owner of the header's styling (it used to be split with
       MonitorView.styles.js, where the winner depended on injection order).
       The header and the context bar are ONE band: the border belongs under the
       pair, not between them — the context bar is a header field, not a section. */
    .mdetail-header {
        display: flex; align-items: flex-start; gap: var(--space-2);
        padding: 3px 12px 2px;
        background: var(--bg-tertiary);
        border-bottom: none;
        flex-shrink: 0; min-width: 0;
    }
    /* Abort / Delete. Sized here instead of with inline styles on the element,
       which is what the template string had to do. */
    .mdh-act { height: 26px; padding: 0 10px; font-size: var(--fs-xs); flex-shrink: 0; }
    .mdh-act-del { color: var(--error); border-color: var(--error); }
    .mdh-icon {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: var(--radius-sm);
        display: flex; align-items: center; justify-content: center;
        background: var(--accent-glow-lg); color: var(--accent);
    }
    .mdh-main { flex: 1 1 auto; min-width: 0; }
    /* ONE line. A two-line title pushed the whole story down on every task with
       a long prompt, which is most of them. */
    .mdh-title {
        font-size: var(--fs-base); font-weight: 700; color: var(--text-primary);
        line-height: 1.3;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* .mdh-sub (task id · caller) was REMOVED from the header — the inspector on
       the right carries both, so the line only repeated what was already on
       screen while costing a row of the panel's fixed furniture. */
    .mdh-meta {
        display: flex; align-items: center; gap: var(--space-2);
        margin-top: 2px; flex-wrap: wrap;
        font-size: var(--fs-xs); color: var(--text-tertiary);
    }
    .mdh-chip b { color: var(--text-primary); font-family: var(--font-mono); font-weight: 600; }
    .mdh-tokens-bd { font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-tertiary); }
    .mdh-ctx {
        display: flex; align-items: center; gap: var(--space-2);
        margin: 0; padding: 0 12px 5px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }
    .mdh-ctx-label { font-size: var(--fs-2xs); color: var(--text-tertiary); flex-shrink: 0; }
    /* Both are <span>s, and an inline element ignores width/height — which is why
       the fill never moved even though the percentage next to it did. */
    .mdh-ctx-track {
        display: block; flex: 1 1 auto; height: 4px; border-radius: 2px;
        background: var(--bg-tertiary); overflow: hidden;
    }
    .mdh-ctx-fill {
        display: block; height: 100%; width: 0; border-radius: 2px;
        background: linear-gradient(90deg, var(--success), var(--warning) 70%, var(--error));
        transition: width var(--transition-normal);
    }
    /* Nearly full: history trimming is imminent, and this is the last moment a
       reader can do something about it. Was an inline style.background set from
       JS; a class is the honest expression of a state. */
    .mdh-ctx-fill.is-danger { background: var(--error); }
    .mdh-ctx-pct {
        flex-shrink: 0; font-family: var(--font-mono);
        font-size: var(--fs-2xs); color: var(--text-secondary);
    }

    /* Tabs are furniture above a scrolling story — they get the tightest band
       the touch targets allow. */
    .mfilter-bar { padding: 3px 10px; }

    /* ── Markdown inside a card ─────────────────────────────────────────── */
    /* A report is mostly headings, lists and code. Rendered at one weight and one
       size it reads as a wall; the hierarchy has to be visible before it is read. */
    .tl-card .rv-summary { font-size: var(--fs-md); line-height: 1.7; color: var(--text-secondary); }
    .tl-card .rv-summary > *:first-child { margin-top: 0; }
    .tl-card .rv-summary > *:last-child { margin-bottom: 0; }
    .tl-card .rv-summary h1,
    .tl-card .rv-summary h2,
    .tl-card .rv-summary h3,
    .tl-card .rv-summary h4 {
        color: var(--text-primary); font-weight: 700; line-height: 1.35;
        margin: var(--space-5) 0 var(--space-2);
    }
    .tl-card .rv-summary h1 {
        font-size: var(--fs-lg);
        padding-bottom: var(--space-2);
        border-bottom: 1px solid var(--border);
    }
    /* h2 is the workhorse in a report, so it gets the one strong signal: a rule
       above it. A coloured left bar on every h2 competed with the rail itself. */
    .tl-card .rv-summary h2 {
        font-size: var(--fs-base);
        padding-top: var(--space-3);
        border-top: 1px solid var(--border-light);
    }
    .tl-card .rv-summary h3 { font-size: var(--fs-md); color: var(--text-primary); }
    .tl-card .rv-summary h4 { font-size: var(--fs-sm); color: var(--text-secondary); text-transform: uppercase; letter-spacing: .05em; }
    .tl-card .rv-summary p { margin: var(--space-2) 0; }
    .tl-card .rv-summary ul,
    .tl-card .rv-summary ol { margin: var(--space-2) 0; padding-left: var(--space-5); }
    .tl-card .rv-summary li { margin: var(--space-1) 0; }
    .tl-card .rv-summary li::marker { color: var(--text-tertiary); }
    .tl-card .rv-summary strong { color: var(--text-primary); font-weight: 600; }
    /* On a dark surface a bordered chip per inline code turns a paragraph into a
       dotted line of boxes — the report read as noise. Tint instead of outline,
       and let the accent carry the emphasis. */
    .tl-card .rv-summary code {
        font-family: var(--font-mono); font-size: var(--fs-sm);
        background: var(--accent-glow-lg); border: 0;
        border-radius: var(--radius-sm); padding: 1px 5px; color: var(--accent);
    }
    :root[data-theme="light"] .tl-card .rv-summary code {
        background: var(--bg-tertiary); color: var(--text-primary);
    }
    /* Paper keeps JHEditor's own code treatment: red-pen ink on a faint wash. */
    :root[data-theme="paper"] .tl-card .rv-summary code {
        background: rgba(178, 58, 72, 0.08); color: #93313c;
        border: 1px solid rgba(178, 58, 72, 0.20);
    }
    /* Emphasis is for emphasis. Bold + a background made every other phrase
       shout, which is the same as none of them shouting. */
    .tl-card .rv-summary em { color: var(--text-tertiary); font-style: italic; }
    .tl-card .rv-summary a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    .tl-card .rv-summary pre {
        background: var(--bg-input); border: 1px solid var(--border);
        border-radius: var(--radius-sm); padding: var(--space-3);
        overflow-x: auto; margin: var(--space-3) 0;
    }
    .tl-card .rv-summary pre code { border: 0; background: none; padding: 0; font-size: var(--fs-xs); }
    .tl-card .rv-summary blockquote {
        margin: var(--space-3) 0; padding: var(--space-1) var(--space-3);
        border-left: 3px solid var(--border); color: var(--text-tertiary);
    }
    .tl-card .rv-summary table { border-collapse: collapse; margin: var(--space-3) 0; font-size: var(--fs-sm); }
    .tl-card .rv-summary th,
    .tl-card .rv-summary td { border: 1px solid var(--border); padding: var(--space-1) var(--space-2); }
    .tl-card .rv-summary th { background: var(--bg-tertiary); color: var(--text-primary); font-weight: 600; }
    .tl-card .rv-summary hr { border: 0; border-top: 1px solid var(--border); margin: var(--space-4) 0; }

    /* ── An unanswered question, made impossible to miss ────────────────── */
    /* The STICKY element has to be the slot, not the banner inside it: a sticky
       box only stays put while its PARENT's box is on screen, and the parent was
       exactly as tall as the banner — so it scrolled away with it, which is the
       reported "the question disappears when I scroll up". The slot's parent is
       the whole panel, so this one actually holds. */
    #task-pending-ask { position: sticky; top: 0; z-index: 3; }
    .mask-pending {
        display: flex; align-items: center; gap: var(--space-2);
        margin-bottom: var(--space-3);
        padding: var(--space-2) var(--space-3);
        background: var(--warning-bg); border: 1px solid var(--warning);
        border-radius: var(--radius-md);
        color: var(--warning); font-size: var(--fs-sm); font-weight: 600;
        cursor: pointer;
    }
    .mask-pending:hover { background: var(--bg-hover); }
    .mask-pending-go { margin-left: auto; font-size: var(--fs-xs); opacity: .8; }

    /* ── Panel collapse ─────────────────────────────────────────────────── */
    /* Fold-all sits with the tabs but is not one: it acts on the Story, so it
       reads as a tool rather than a place. */
    .mfold-all {
        margin-left: var(--space-3);
        background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
        color: var(--text-tertiary); cursor: pointer;
        padding: 2px 8px; font-size: var(--fs-2xs); line-height: 1.4;
    }
    .mfold-all:hover { color: var(--accent); border-color: var(--border-focus); }

    .mpanel-toggle {
        background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
        color: var(--text-tertiary); cursor: pointer;
        padding: 2px 7px; font-size: var(--fs-2xs); line-height: 1.4;
    }
    .mpanel-toggle:hover { color: var(--accent); border-color: var(--border-focus); }
    /* An open panel has to LOOK open: the toggle carried the active class but
       nothing styled it, so the button never showed the state. */
    .mpanel-toggle.active {
        color: var(--accent); border-color: var(--accent);
        background: var(--accent-glow-lg);
    }

    @media (max-width: 1100px) {
        .mtl-insp { display: none !important; }
    }
`;
