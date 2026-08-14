// Dashboard styles.
//
// Split out of OverviewView when the page became a two-column cockpit — the
// view was carrying ~200 lines of CSS in a template literal, which is where the
// timelineStyles backtick bug came from (a backquote inside a CSS comment closes
// the literal; vite builds it, vitest dies with "Expected a semicolon").
//
// RULE FOR THIS FILE: never write a backtick inside these strings, including in
// comments. Refer to CSS classes as .like-this.

export const OVERVIEW_STYLES = `
/* ── Shell ────────────────────────────────────────────────── */
.dash {
    display: flex; flex-direction: column; gap: var(--space-3);
    /* Fills the viewport; the two columns scroll internally so the page itself
       never does. A dashboard you have to scroll is a dashboard you skim. */
    height: calc(100vh - var(--titlebar-height) - 34px);
    min-height: 420px;
}
.dash-head { display: flex; align-items: baseline; gap: var(--space-3); flex-shrink: 0; }
.dash-title { margin: 0; font-size: var(--fs-2xl); letter-spacing: -0.015em; }
.dash-status {
    font-family: var(--font-mono); font-size: var(--fs-2xs); letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--text-tertiary);
}
.dash-status b { color: var(--text-primary); font-weight: 700; }
.dash-head-link {
    margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: var(--fs-xs); color: var(--text-tertiary); text-decoration: none;
}
.dash-head-link:hover { color: var(--accent); }

.dash-cols { display: flex; gap: var(--space-3); flex: 1; min-height: 0; }
.dash-left {
    width: 300px; flex-shrink: 0; display: flex; flex-direction: column;
    gap: var(--space-2); min-height: 0;
}
.dash-right {
    flex: 1; min-width: 0; background: var(--bg-secondary);
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    display: flex; flex-direction: column; overflow: hidden;
}
@media (max-width: 1000px) {
    .dash { height: auto; }
    .dash-cols { flex-direction: column; }
    .dash-left { width: auto; }
    .dash-right { min-height: 420px; }
}

/* ── Launcher ─────────────────────────────────────────────── */
.dl {
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 9px 10px;
    display: flex; flex-direction: column; gap: 7px; flex-shrink: 0;
    transition: border-color var(--transition-fast);
}
.dl:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow-lg); }
.dl-input {
    border: 0; background: transparent; outline: 0; resize: none;
    color: var(--text-primary); font-family: inherit; font-size: var(--fs-md);
    line-height: 1.5; min-height: 40px; max-height: 150px; padding: 2px;
}
.dl-input::placeholder { color: var(--text-tertiary); }
.dl-row {
    display: flex; align-items: center; gap: 7px;
    border-top: 1px solid var(--border-light); padding-top: 7px;
}
.dl-ws {
    flex: 1; min-width: 0; background: var(--bg-input);
    border: 1px solid var(--border-light); border-radius: var(--radius-sm);
    color: var(--text-secondary); font-family: var(--font-mono);
    font-size: var(--fs-2xs); padding: 4px 7px; outline: 0;
}
.dl-ws:focus { border-color: var(--accent); color: var(--text-primary); }
.dl-browse { padding: 0 9px; height: 28px; flex-shrink: 0; }
.dl-go { padding: 0 13px; height: 28px; font-size: var(--fs-xs); flex-shrink: 0; }

/* ── Recipes ──────────────────────────────────────────────── */
.dr { flex-shrink: 0; }
.dr-lab { display: block; margin-bottom: 5px; }
.dr-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.dr-chip {
    background: var(--bg-tertiary); border: 1px solid var(--border-light);
    border-radius: 999px; color: var(--text-secondary); font-family: inherit;
    font-size: var(--fs-2xs); padding: 3px 10px; cursor: pointer;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px;
}
.dr-chip:hover { border-color: var(--accent); color: var(--text-primary); }
.dr-chip .n { font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary); }
.dr-chip.is-add { color: var(--text-tertiary); }

/* ── Queue ────────────────────────────────────────────────── */
.dq { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.dq-lab { margin: 8px 0 2px; display: block; }
.dq-lab:first-child { margin-top: 0; }
.dq-empty { font-size: var(--fs-xs); color: var(--text-tertiary); padding: 4px 2px; }
.dqi {
    display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm);
    padding: 6px 9px; border-radius: var(--radius-sm); cursor: pointer;
    border: 1px solid transparent; text-decoration: none; color: inherit;
    background: none; font-family: inherit; text-align: left; width: 100%;
}
.dqi:hover { background: var(--bg-hover); }
.dqi.is-sel { background: var(--bg-secondary); border-color: var(--accent); }
.dqi .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dqi .t { font-size: var(--fs-2xs); color: var(--text-tertiary); flex-shrink: 0; }
.dq-more { font-size: var(--fs-2xs); color: var(--text-tertiary); text-decoration: none; padding: 4px 9px; }
.dq-more:hover { color: var(--accent); }

/* ── Spend ────────────────────────────────────────────────── */
.ds {
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg-secondary); padding: 8px 11px; flex-shrink: 0;
}
.ds-top { display: flex; align-items: baseline; gap: 8px; }
.ds-v { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
/* The window picker — Today / 7d / 30d. Small segmented control beside the
   total so the number's meaning is always the range it was summed over. */
.ds-range { margin-left: auto; display: inline-flex; gap: 2px; }
.ds-range-btn {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.05em;
    color: var(--text-tertiary); background: var(--bg-tertiary);
    border: 1px solid var(--border-light); border-radius: 4px;
    padding: 2px 7px; cursor: pointer;
}
.ds-range-btn:hover { color: var(--text-primary); border-color: var(--accent); }
.ds-range-btn.is-on { color: var(--accent); border-color: var(--accent); background: var(--accent-glow); }
.ds-k {
    font-size: 9px; color: var(--text-tertiary); font-family: var(--font-mono);
    letter-spacing: 0.08em; text-transform: uppercase; margin-top: 2px;
}
.ds-bar {
    height: 5px; background: var(--bg-primary); border-radius: 3px;
    overflow: hidden; margin: 7px 0 5px; display: flex;
}
.ds-bar > i { display: block; height: 100%; }
.ds-lg { font-size: var(--fs-2xs); color: var(--text-secondary); display: flex; gap: 10px; flex-wrap: wrap; }
.ds-lg span { display: inline-flex; align-items: center; gap: 4px; }
.ds-sw { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
.ds-tip { margin: 6px 0 0; font-size: var(--fs-2xs); color: var(--text-tertiary); line-height: 1.5; }

/* ── Right pane tabs ──────────────────────────────────────── */
.dt-bar {
    display: flex; align-items: center; gap: 2px; padding: 6px 10px 0;
    background: var(--bg-tertiary); border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.dt-tab {
    font-size: var(--fs-xs); font-weight: 600; color: var(--text-tertiary);
    padding: 6px 12px 7px; border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    display: inline-flex; align-items: center; gap: 6px;
    font-family: inherit; background: transparent; border: 0; cursor: pointer;
}
.dt-tab:hover { color: var(--text-secondary); }
.dt-tab.is-on {
    background: var(--bg-secondary); color: var(--text-primary);
    box-shadow: 0 1px 0 var(--bg-secondary);
}
.dt-tab[disabled] { opacity: 0.45; cursor: default; }
.dt-cnt {
    font-family: var(--font-mono); font-size: 9px; background: var(--accent-glow-lg);
    color: var(--accent); padding: 1px 5px; border-radius: 3px;
}
.dt-note {
    margin-left: auto; font-size: var(--fs-2xs); color: var(--text-tertiary);
    padding-bottom: 6px; font-family: var(--font-mono);
}
.dt-ws {
    margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
    padding-bottom: 4px;
}
.dt-ws-input {
    width: 170px; background: var(--bg-input);
    border: 1px solid var(--border-light); border-radius: var(--radius-sm);
    color: var(--text-secondary); font-family: var(--font-mono);
    font-size: var(--fs-2xs); padding: 3px 6px; outline: 0;
}
.dt-ws-input:focus { border-color: var(--accent); color: var(--text-primary); }
.dt-ws-browse {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 20px; padding: 0; flex-shrink: 0;
    background: var(--bg-tertiary); border: 1px solid var(--border-light);
    border-radius: var(--radius-sm); color: var(--text-tertiary); cursor: pointer;
}
.dt-ws-browse:hover { border-color: var(--accent); color: var(--text-primary); }
.dt-pane { flex: 1; min-height: 0; overflow-y: auto; }

/* ── Memory pane ──────────────────────────────────────────── */
.dm { padding: 11px 13px; display: flex; flex-direction: column; gap: 11px; }
.dm-layers {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px;
    background: var(--border-light); border: 1px solid var(--border-light);
    border-radius: var(--radius-sm); overflow: hidden;
}
.dm-layers > div { background: var(--bg-secondary); padding: 7px 9px; }
.dm-layers .k {
    font-size: 9px; color: var(--text-tertiary); font-family: var(--font-mono);
    letter-spacing: 0.06em; display: block;
}
.dm-layers .v { font-size: var(--fs-lg); font-weight: 700; font-variant-numeric: tabular-nums; display: block; }
.dm-layers .s { font-size: 9px; color: var(--text-tertiary); display: block; }

.dm-box { border: 1px solid var(--border-light); border-radius: var(--radius-sm); overflow: hidden; }
.dm-h {
    padding: 7px 11px; background: var(--bg-tertiary); font-size: var(--fs-xs);
    font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 7px;
}
.dm-h .more { margin-left: auto; font-weight: 400; font-size: var(--fs-2xs); color: var(--text-tertiary); text-decoration: none; }
.dm-h .more:hover { color: var(--accent); }
.dm-h .badge {
    font-family: var(--font-mono); font-size: 9px; background: var(--warning-bg);
    color: var(--warning); padding: 1px 6px; border-radius: 3px;
}

.dm-bar { display: flex; height: 8px; margin: 9px 11px 3px; border-radius: 4px; overflow: hidden; background: var(--bg-primary); }
.dm-bar > i { display: block; height: 100%; }
.dm-lg { display: flex; gap: 13px; padding: 3px 11px 9px; font-size: var(--fs-2xs); color: var(--text-secondary); flex-wrap: wrap; }
.dm-lg span { display: inline-flex; align-items: center; gap: 5px; }
.dm-lg b { font-weight: 700; color: var(--text-primary); }
.dm-sw { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
.dm-fail { border-top: 1px solid var(--border-light); padding: 8px 11px; }
.dm-fail-t { font-size: var(--fs-2xs); color: var(--error); margin-bottom: 5px; font-weight: 600; }
.dm-frow { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); padding: 3px 0; }
.dm-frow .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-rate { font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--error); }

.dm-row { display: flex; gap: 9px; padding: 8px 11px; border-top: 1px solid var(--border-light); align-items: flex-start; }
.dm-row:first-of-type { border-top: 0; }
.dm-badge {
    font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.06em;
    text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
    font-weight: 700; flex-shrink: 0; margin-top: 1px;
}
.dm-badge.is-lesson { background: var(--error-bg); color: var(--error); }
.dm-badge.is-insight { background: var(--success-bg); color: var(--success); }
.dm-badge.is-where { background: var(--accent-glow-lg); color: var(--accent); }
.dm-badge.is-semantic { background: var(--accent-glow-lg); color: var(--accent); }
.dm-badge.is-episodic { background: var(--bg-tertiary); color: var(--text-tertiary); }
.dm-row .body { flex: 1; min-width: 0; }
.dm-row .hl { font-size: var(--fs-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-row .dt { font-size: var(--fs-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.dm-row .mt { font-size: 9px; color: var(--text-tertiary); font-family: var(--font-mono); margin-top: 3px; }
.dm-row.is-off .hl, .dm-row.is-off .dt { color: var(--text-tertiary); text-decoration: line-through; }

/* The switch. A checkbox so it is keyboard-reachable and announces its state;
   the visual is drawn on the label. */
.dm-toggle { position: relative; width: 30px; height: 17px; flex-shrink: 0; }
.dm-toggle input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.dm-toggle i {
    display: block; width: 100%; height: 100%; border-radius: 9px;
    background: var(--success); transition: background var(--transition-fast); pointer-events: none;
}
.dm-toggle i::after {
    content: ''; position: absolute; top: 2px; right: 2px; width: 13px; height: 13px;
    border-radius: 50%; background: #fff; transition: all var(--transition-fast);
}
.dm-toggle input:not(:checked) + i { background: var(--text-tertiary); }
.dm-toggle input:not(:checked) + i::after { right: auto; left: 2px; }
.dm-toggle input:focus-visible + i { box-shadow: 0 0 0 3px var(--accent-glow); }

.dm-search {
    display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-light);
    border-radius: var(--radius-sm); background: var(--bg-input); padding: 7px 11px;
}
.dm-search input {
    flex: 1; min-width: 0; border: 0; background: transparent; outline: 0;
    color: var(--text-primary); font-family: inherit; font-size: var(--fs-sm);
}
.dm-search input::placeholder { color: var(--text-tertiary); }
.dm-search .sc {
    font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
    border: 1px solid var(--border-light); border-radius: 3px; padding: 1px 5px; white-space: nowrap;
}
.dm-results { display: flex; flex-direction: column; }
/* One-click workspace switches in the memory pane. Chips because a list of
   paths is reference material, not a form — and the current one is marked. */
.dm-wschips { display: flex; gap: 4px; flex-wrap: wrap; }
.dm-wschip {
    font-family: var(--font-mono); font-size: var(--fs-2xs);
    color: var(--text-secondary); background: var(--bg-tertiary);
    border: 1px solid var(--border-light); border-radius: 999px;
    padding: 2px 9px; cursor: pointer; max-width: 180px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dm-wschip:hover { border-color: var(--accent); color: var(--text-primary); }
.dm-wschip.is-on { color: var(--accent); border-color: var(--accent); background: var(--accent-glow); }
.dm-note { font-size: var(--fs-xs); color: var(--text-tertiary); padding: 10px 11px; line-height: 1.6; }
/* Why a section is there, beside its heading — the sections answer different
   questions and the count alone does not say which. */
.dm-note-inline { font-size: var(--fs-2xs); color: var(--text-tertiary); font-weight: 400; }
/* Arrived since the panel was last opened. The rows it marks are shown either
   way — a "new" flag should draw the eye, not gate the content. */
.dm-new {
    font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.04em;
    color: var(--accent); align-self: flex-start; margin-top: 1px;
}

/* Per-model tokens + cost. The bar above it gives the split; this gives the
   figures, which is what "how much is this model costing me" actually needs. */
.ds-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: var(--fs-2xs); }
.ds-tbl th {
    text-align: right; font-weight: 600; color: var(--text-tertiary);
    padding: 2px 0 4px; border-bottom: 1px solid var(--border);
}
.ds-tbl th:first-child, .ds-tbl td:first-child { text-align: left; }
.ds-tbl td {
    padding: 3px 0; text-align: right; color: var(--text-secondary);
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
}
.ds-tbl td:first-child { font-family: inherit; color: var(--text-primary); }
/* An estimated row is still a row — dimming it says "this number is softer"
   without hiding the spend, which is the one thing that must not be hidden. */
.ds-tbl tr.is-est td { color: var(--text-tertiary); }
.ds-est { margin-left: 2px; cursor: help; }
.dm-note code { font-family: var(--font-mono); }

/* ── Run pane: phase rail ─────────────────────────────────── */
.dp-rail {
    display: flex; border: 1px solid var(--border-light);
    border-radius: var(--radius-sm); overflow: hidden;
}
.dp-ph { flex: 1; min-width: 0; padding: 7px 10px; border-right: 1px solid var(--border-light); }
.dp-ph:last-child { border-right: 0; }
.dp-ph .n {
    display: block; font-family: var(--font-mono); font-size: 9px;
    letter-spacing: 0.1em; color: var(--text-tertiary);
}
.dp-ph .m {
    display: block; font-size: var(--fs-xs); margin-top: 1px; color: var(--text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dp-ph.is-done .n { color: var(--text-secondary); }
.dp-ph.is-now { background: var(--accent-glow-lg); }
.dp-ph.is-now .n { color: var(--accent); font-weight: 700; }
.dp-ph.is-now .m { color: var(--text-primary); font-weight: 600; }
.dp-ph.is-todo .m { color: var(--text-tertiary); }

/* ── Run pane: model switch log ───────────────────────────── */
/* Why the run moved models, with the trigger spelled out. Newest first. */
.dp-switch {
    display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
    padding: 4px 11px; font-size: var(--fs-xs);
}
.dp-switch-m { font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--accent); font-weight: 700; }
.dp-switch-from { font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-tertiary); }
.dp-switch-r { color: var(--text-secondary); line-height: 1.5; }

/* ── Run pane: step feed ──────────────────────────────────── */
.dp-steps { padding: 6px 5px; display: flex; flex-direction: column; }
.dp-step { display: flex; gap: 9px; padding: 4px 7px; font-size: var(--fs-sm); align-items: baseline; }
.dp-step .n {
    font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
    width: 20px; flex-shrink: 0; text-align: right;
}
.dp-step .tx {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--text-secondary);
}
.dp-step.is-error .tx { color: var(--error); }
.dp-step.is-thought .tx { font-style: italic; }
.dp-step.is-live .tx { color: var(--text-primary); font-weight: 500; }

/* ── Run pane: memory in play ─────────────────────────────── */
.dp-inplay {
    border: 1px solid var(--accent-dim); border-radius: var(--radius-sm);
    background: var(--accent-glow-lg); padding: 8px 11px;
}
.dp-inplay-h {
    display: flex; align-items: center; gap: 6px; margin-bottom: 5px;
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--accent);
}
.dp-inplay-h .more {
    margin-left: auto; text-transform: none; letter-spacing: 0;
    font-family: var(--font-sans); color: var(--text-tertiary); font-size: var(--fs-2xs);
    background: none; border: 0; cursor: pointer; padding: 0;
}
.dp-inplay-h .more:hover { color: var(--accent); }
.dp-inplay-l {
    display: flex; gap: 8px; align-items: baseline; padding: 2px 0;
    font-size: var(--fs-xs); color: var(--text-secondary);
}
.dp-inplay-l b { color: var(--text-primary); font-weight: 600; }
.dp-inplay-l .at {
    font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
    flex-shrink: 0; min-width: 44px;
}
.dp-inplay-l > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Empty / first run ────────────────────────────────────── */
.dash-empty {
    text-align: center; padding: var(--space-6) var(--space-4);
    color: var(--text-secondary); font-size: var(--fs-md);
}
.dash-empty h3 { margin: 0 0 6px; font-size: var(--fs-lg); color: var(--text-primary); }
.dash-empty p { margin: 0 auto; max-width: 44ch; }
.dash-empty-ico { color: var(--accent); display: flex; justify-content: center; margin-bottom: var(--space-2); }

/* ── Stats pane ───────────────────────────────────────────── */
/* The cut switcher — month / week / day / model / workspace.
   Same segmented-control look as the spend-range picker. */
.ds-st-toolbar { display: flex; gap: 4px; flex-wrap: wrap; }
.ds-st-cut {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.05em;
    color: var(--text-tertiary); background: var(--bg-tertiary);
    border: 1px solid var(--border-light); border-radius: 4px;
    padding: 3px 9px; cursor: pointer;
}
.ds-st-cut:hover { color: var(--text-primary); border-color: var(--accent); }
.ds-st-cut.is-on { color: var(--accent); border-color: var(--accent); background: var(--accent-glow); }

/* Visual divider between the period and status condition groups. */
.ds-st-sep {
    width: 1px; align-self: stretch; margin: 2px 4px;
    background: var(--border-light);
}

/* One row per bucket: label · proportional bar · tokens · cost. */
.ds-st-list { padding: 4px 11px 10px; display: flex; flex-direction: column; gap: 5px; }
.ds-st-row { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); }
.ds-st-label {
    width: 110px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--text-primary);
}
.ds-st-bar {
    flex: 1; height: 6px; background: var(--bg-primary); border-radius: 3px;
    overflow: hidden; min-width: 30px;
}
.ds-st-bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.ds-st-tok {
    width: 76px; flex-shrink: 0; text-align: right;
    font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-secondary);
}
.ds-st-cost {
    width: 62px; flex-shrink: 0; text-align: right;
    font-family: var(--font-mono); font-size: var(--fs-xs); font-weight: 600;
    color: var(--text-primary); font-variant-numeric: tabular-nums;
}

/* Model × (fresh in / cache / out) split — the same ↑⚡↓ notation as the
   Monitor inspector, so a number read here means the same thing there. */
.ds-st-mlist { gap: 2px; }
.ds-st-mrow {
    display: flex; align-items: baseline; gap: 8px;
    padding: 2px 0; font-size: var(--fs-2xs);
}
.ds-st-mrow .ds-st-label { width: 110px; font-size: var(--fs-xs); }
.ds-st-mtok {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: var(--font-mono); color: var(--text-secondary);
}
.ds-st-mrow .ds-st-tok { width: 76px; text-align: right; }

/* The task sample under the breakdown — one row per task, tapping through
   to Monitor. Same queue-row look as the left column. */
.ds-st-tasks { padding: 2px 6px 8px; display: flex; flex-direction: column; }
.ds-st-task {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 5px; border-radius: 4px;
    color: var(--text-secondary); text-decoration: none;
}
.ds-st-task:hover { background: var(--bg-hover); }
.ds-st-task .grow {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-primary); font-size: var(--fs-xs);
}
.ds-st-task-tok {
    font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
}
.ds-st-task-models {
    color: var(--text-tertiary); opacity: 0.75;
}
.ds-st-task-cost {
    font-family: var(--font-mono); font-size: 10px; font-weight: 600;
    color: var(--text-secondary); font-variant-numeric: tabular-nums;
    min-width: 44px; text-align: right;
}
.ds-st-task-when {
    font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
    min-width: 34px; text-align: right;
}
`;
