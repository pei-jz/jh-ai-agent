// Extracted CSS for MonitorView — kept as a template string so render()
// stays readable.
//
// The Task view's timeline + inspector live in monitor/timelineStyles.js and are
// appended below: this file is one very long template literal, and editing near
// its closing backtick has broken the module before.

import { TIMELINE_STYLES } from './monitor/timelineStyles.js';

const BASE_STYLES = `
                /* ── Layout ────────────────────────────────────── */
                .monitor-layout {
                    display: flex;
                    /* Bottom whitespace trimmed to match the top band (8px).
                       .main-content leaves 20px of bottom padding; we extend the
                       layout 12px into it (height +12) and pull the following
                       flow back up with a -12px margin, so the bottom gap is
                       20 - 12 = 8px and .main-content does not overflow. The
                       top stays 8px = .main-content's 4px + this element's 4px. */
                    height: calc(100vh - var(--titlebar-height) - 16px);
                    margin-bottom: -12px;
                    /* The pane dividers live IN the gaps: each divider is a
                       12px hit area with -6px margins, so it needs 6px of gap
                       on each side to reconstruct the original 12px spacing. */
                    /* No gap: the columns meet at their rules. The dividers
                       still overlay the seam as invisible 12px hit areas. */
                    gap: 0;
                    padding: 0;
                    /* Transparent, so the window's ground — and the theme's
                       texture on it — reaches the whole screen. Painting
                       --surface-panel here covered the body and every theme's
                       pattern with it, which is why none of them showed. The
                       layout is a REGION of the ground, not a surface on it;
                       that is the same rule the columns follow. */
                    background: transparent;
	                /* border-top: 1px solid var(--line);*/
                }

                /* ── Pane dividers (drag edges) ───────────────────── */
                /* Invisible full-height hit areas centered in the 12px gap
                   between the three panes. The user drags them to resize the
                   task list / inspector columns; the widths persist in
                   localStorage (jhai_monitor_left_width / _insp_width). */
                .mpane-divider {
                    flex: 0 0 12px;
                    margin: 0 -6px;
                    align-self: stretch;
                    position: relative;
                    cursor: col-resize;
                    z-index: 20;
                    background: transparent;
                }
                .mpane-divider::after {
                    content: '';
                    position: absolute; left: 50%; top: 0; bottom: 0;
                    width: 2px; transform: translateX(-50%);
                    background: transparent;
                    transition: background 0.15s;
                }
                .mpane-divider:hover::after { background: var(--accent); opacity: 0.5; }
                body.resizing-panes { cursor: col-resize; user-select: none; }
                body.resizing-panes .mpane-divider::after { background: var(--accent); opacity: 0.8; }

                /* ── Left Panel ────────────────────────────────── */
                .mpanel-left {
                    width: var(--mpane-left-w, 240px);
                    min-width: 200px;
                    /* 640 matches PANE_W_MAX in MonitorView.js — the drag
                       clamps to the same range the CSS allows. */
                    max-width: 640px;
                    /* ONE line, not a card.
                       Three bordered, rounded, filled panels sitting on the app
                       ground read as three objects stacked on a surface — which
                       is what "flat" is not. The columns are regions of one
                       screen, so they are separated the way regions are: a rule.
                       docs/design/visual-language.md §1. */
                    background: transparent;
                    border: none;
                    border-right: 1px solid var(--line);
                    border-radius: 0;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .mpanel-left-header {
                    padding: 8px 12px;
                    background: var(--surface-sunken);
                    border-bottom: 1px solid var(--line);
                    font-size: var(--fs-xs);
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--ink-soft);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                }
                /* Home + New. Home only appears with a task open — with nothing
                   selected you are already on the start screen. */
                .mpl-actions {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    flex: none;
                }
                /* Smaller than New: New starts something, Home just goes back —
                   and the header row is 8px of padding, so weight here crowds
                   the count beside it. */
                .mpl-home {
                    text-transform: none;
                    letter-spacing: 0;
                    white-space: nowrap;
                    padding: 3px 8px;
                    font-size: var(--fs-xs);
                    font-weight: 600;
                    gap: 4px;
                }
                /* ── Composer (svelte/monitor/Composer.svelte) ──────────────
                   The prompt box at the top of the list. Sized to sit ABOVE the
                   search field without competing with it: same input treatment,
                   one step more contrast on the surface so the two rows do not
                   read as one filter block. */
                /* ── Composer (svelte/monitor/Composer.svelte) ──────────────
                   One input, one row of two controls, one line of text. The six
                   controls that used to share a row inside a 240px column are
                   why this was rewritten — see the component's file comment. */
                .mcomp {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    padding: 10px 10px 8px;
                    background: var(--surface-sunken);
                    border-bottom: 1px solid var(--line);
                }
                .mcomp-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-1);
                }
                .mcomp-chips:empty { display: none; }
                /* The popup is absolutely positioned against this. */
                .mcomp-ta-wrap { position: relative; }
                .mcomp-ta {
                    width: 100%;
                    /* Matches MAX_H in Composer.svelte: past this it scrolls
                       rather than growing without end. A dragged box may exceed
                       it — that is the user's call, not the auto-grow's. */
                    max-height: 420px;
                    /* Draggable in both directions. The start screen is mostly
                       empty space and a long request is easier to check in a
                       box the shape of what you are writing. */
                    resize: both;
                    min-width: 240px;
                    font-family: inherit;
                    font-size: var(--fs-md);
                    line-height: 1.55;
                    color: var(--ink);
                    background: var(--surface-input);
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    padding: 7px 10px;
                    outline: none;
                    transition: height 0.12s ease, border-color var(--transition-fast);
                }
                .mcomp-ta:focus { border-color: var(--accent); }
                .mcomp-ta:disabled { opacity: 0.6; }
                .mcomp-ta::placeholder { color: var(--ink-faint); }
                .mcomp-slash { display: none; }

                /* Exactly two things: which kind of run, and go. */
                .mcomp-row {
                    display: flex;
                    align-items: center;
                    gap: var(--space-2);
                }
                .mcomp-int {
                    display: flex;
                    flex: 0 0 auto;
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    overflow: hidden;
                }
                .mcomp-int-btn {
                    height: 26px;
                    font-size: var(--fs-xs);
                    font-weight: 600;
                    color: var(--ink-faint);
                    background: var(--surface-panel);
                    border: none;
                    padding: 0 11px;
                    cursor: pointer;
                    transition: color var(--transition-fast), background var(--transition-fast);
                }
                .mcomp-int-btn + .mcomp-int-btn { border-left: 1px solid var(--line); }
                .mcomp-int-btn:hover { color: var(--ink); }
                .mcomp-int-btn[aria-pressed="true"] {
                    color: var(--on-accent);
                    background: var(--accent);
                }
                .mcomp-send {
                    margin-left: auto;
                    height: 26px;
                    font-size: var(--fs-xs);
                    font-weight: 700;
                    color: var(--on-accent);
                    background: var(--accent);
                    border: 1px solid var(--accent);
                    border-radius: var(--r-2);
                    padding: 0 12px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                }
                /* The key that does the same thing, on the thing it does.
                   A shortcut is only useful if you find out it exists. */
                .mcomp-kbd {
                    font-family: var(--font-mono);
                    font-size: 10px;
                    font-weight: 600;
                    letter-spacing: 0;
                    padding: 1px 5px;
                    border-radius: var(--r-1);
                    background: color-mix(in srgb, var(--on-accent) 18%, transparent);
                    border: 1px solid color-mix(in srgb, var(--on-accent) 28%, transparent);
                    opacity: 0.85;
                }
                .mcomp-send:hover:not(:disabled) { background: var(--accent-hover); }
                .mcomp-send:disabled { opacity: 0.5; cursor: default; }

                /* Where it will run and how — read far more often than set, so it
                   reads as a sentence and opens the picker when pressed. */
                /* ── The composer in the middle of an empty Work screen ─────
                   Same component, different room (the place prop). It
                   is wider, quieter — no tinted band, because there is nothing
                   here to separate it from — and it does not collapse, because
                   it is the only thing on the screen. */
                .mwelcome {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: var(--space-5);
                    overflow-y: auto;
                    padding: var(--space-5) var(--space-4);
                    min-height: 0;
                }
                .mcomp.mcomp-hero {
                    /* The width comes from .wel now (the composer is rendered
                       inside Welcome, between the lede and the templates), so
                       this only has to fill it. */
                    width: 100%;
                    background: transparent;
                    border-bottom: none;
                    padding: 0;
                    gap: var(--space-2);
                }
                .mcomp-hero .mcomp-ta {
                    font-size: var(--fs-base);
                    padding: 12px 14px;
                }
                .mcomp-hero .mcomp-int-btn,
                .mcomp-hero .mcomp-send { height: 30px; }
                .mcomp-hero .mcomp-send { padding: 0 22px; }

                .mcomp-ctx {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    width: 100%;
                    min-width: 0;
                    font-family: var(--font-mono);
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    background: none;
                    border: none;
                    border-radius: var(--r-1);
                    padding: 3px 4px;
                    margin: -1px 0 0 -4px;
                    cursor: pointer;
                    text-align: left;
                }
                .mcomp-ctx:hover { color: var(--ink-soft); background: var(--surface-hover); }
                .mcomp-ctx-ws {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 45%;
                }
                .mcomp-ctx-sep { opacity: 0.5; }
                .mcomp-ctx-mode { white-space: nowrap; }
                .mcomp-ctx-more { margin-left: auto; opacity: 0.7; }

                .mtask-filter {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    padding: 7px 8px;
                    border-bottom: 1px solid var(--line);
                    background: var(--surface-panel);
                }
                .mtask-search {
                    width: 100%;
                    height: 26px;
                    font-size: var(--fs-xs);
                    background: var(--surface-input);
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    color: var(--ink);
                    padding: 0 8px;
                    outline: none;
                }
                .mtask-search:focus { border-color: var(--accent); }
                .mtask-status-bar {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 3px;
                }
                .mtask-status-btn {
                    flex: 1 1 auto;
                    min-width: 48px;
                    padding: 3px 6px;
                    font-size: var(--fs-2xs);
                    font-weight: 600;
                    text-transform: capitalize;
                    border: 1px solid var(--line);
                    background: var(--surface-sunken);
                    color: var(--ink-soft);
                    border-radius: var(--r-2);
                    cursor: pointer;
                    transition: background 0.12s, color 0.12s, border-color 0.12s;
                }
                .mtask-status-btn:hover { background: var(--surface-hover); color: var(--ink); }
                .mtask-status-btn.active {
                    background: var(--accent);
                    color: var(--on-accent);
                    border-color: var(--accent);
                }
                .mgroup-toggle {
                    display: flex;
                    gap: 3px;
                    padding: 6px 8px;
                    border-bottom: 1px solid var(--line);
                    background: var(--surface-panel);
                }
                .mgroup-btn {
                    flex: 1;
                    padding: 4px 0;
                    font-size: var(--fs-xs);
                    font-weight: 600;
                    border: 1px solid var(--line);
                    background: var(--surface-sunken);
                    color: var(--ink-soft);
                    border-radius: var(--r-2);
                    cursor: pointer;
                    transition: background 0.12s, color 0.12s;
                }
                .mgroup-btn:hover { background: var(--surface-hover); color: var(--ink); }
                .mgroup-btn.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
                .mtask-group-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: var(--fs-sm);
                    font-weight: 700;
                    letter-spacing: 0.02em;
                    color: var(--accent);
                    padding: 9px 8px 5px;
                    position: sticky;
                    top: 0;
                    background: var(--surface-panel);
                    z-index: 1;
                    cursor: pointer;
                    user-select: none;
                    border-bottom: 1px solid var(--line-soft);
                }
                .mtask-group-header:hover { color: var(--accent-hover); }
                .mgroup-chevron { font-size: var(--fs-2xs); width: 11px; flex-shrink: 0; opacity: 0.8; }
                .mgroup-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mgroup-count { font-size: var(--fs-xs); opacity: 0.6; font-weight: 600; color: var(--ink-soft); }
                .mgroup-add {
                    flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
                    width: 18px; height: 18px; padding: 0; border: none; border-radius: var(--r-2);
                    background: transparent; color: var(--ink-faint); cursor: pointer;
                    opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s;
                }
                .mtask-group-header:hover .mgroup-add { opacity: 1; }
                .mgroup-add:hover { background: var(--accent); color: #fff; }
                /* TaskList.svelte's mount host. It is the flex child that must
                   grow to fill the pane; without an explicit flex:1/min-height:0
                   the inner .mpanel-left-list's own scroll never gets a bounded
                   height, so a long history overflows the pane instead of
                   scrolling (overflow:hidden on .mpanel-left then clips it). */
                #mtask-list {
                    flex: 1;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .mtask-filter,
                .mgroup-toggle { flex-shrink: 0; }
                .mpanel-left-list {
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .mtask-item {
                    padding: 7px 9px;
                    border-radius: var(--r-2);
                    border: 1px solid transparent;
                    cursor: pointer;
                    transition: background 0.15s;
                }
                .mtask-item:hover { background: var(--surface-hover); }
                .mtask-item.selected {
                    background: var(--accent-surface);
                    border-color: var(--accent);
                }
                .mtask-top {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    margin-bottom: 3px;
                }
                .mtask-dot {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .dot-running { background: var(--accent); box-shadow: 0 0 4px var(--accent); animation: dotPulse 1s infinite; }
                .dot-completed { background: var(--success); }
                .dot-failed { background: var(--error); }
                .dot-aborted { background: var(--ink-faint); }
                @keyframes dotPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
                .mtask-id {
                    font-family: var(--font-mono);
                    font-size: var(--fs-xs);
                    color: var(--ink-faint);
                }
                .mtask-caller {
                    font-size: var(--fs-2xs);
                    font-weight: 700;
                    color: var(--accent);
                    background: var(--accent-surface);
                    padding: 1px 5px;
                    border-radius: var(--r-1);
                }
                .mtask-time {
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    margin-left: auto;
                }
                /* Per-item delete — hidden until the row is hovered, so the list
                   stays clean but deletion is always one hover+click away. */
                .mtask-del {
                    background: none;
                    border: none;
                    color: var(--ink-faint);
                    cursor: pointer;
                    font-size: var(--fs-xs);
                    line-height: 1;
                    padding: 2px 3px;
                    border-radius: var(--r-2);
                    opacity: 0;
                    transition: opacity 0.12s, color 0.12s, background 0.12s;
                }
                .mtask-item:hover .mtask-del { opacity: 0.65; }
                .mtask-del:hover { opacity: 1; color: var(--error); background: var(--surface-sunken); }
                .mtask-prompt {
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .mtask-progbar {
                    margin-top: 4px;
                    height: 2px;
                    background: var(--surface-sunken);
                    border-radius: var(--r-1);
                    overflow: hidden;
                }
                .mtask-progbar > div {
                    height: 100%;
                    background: var(--accent);
                    transition: width 0.3s;
                }
                .mtask-empty {
                    padding: 20px;
                    text-align: center;
                    color: var(--ink-faint);
                    font-size: var(--fs-sm);
                }

                /* ── Right Panel ───────────────────────────────── */
                .mpanel-right {
                    flex: 1;
                    min-width: 0;
                    /* The reading column IS the ground — nothing is layered on
                       top of it, so it carries no border of its own. */
                    background: transparent;
                    border: none;
                    border-radius: 0;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    position: relative;   /* anchor for the floating "new activity" pill */
                }
                .mdetail-empty {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    color: var(--ink-faint);
                }
                .mdetail-empty-icon { font-size: var(--fs-display); margin-bottom: 12px; }
                .mdetail-empty h3 { margin: 0 0 6px; font-size: var(--fs-base); }
                .mdetail-empty p { font-size: var(--fs-sm); margin: 0; }

                /* ── Detail Header ─────────────────────────────── */
                /* MOVED OUT. Every .mdetail-header / .mdh-* rule now lives in
                   monitor/timelineStyles.js, which owns the header's design.
                   Two definitions used to sit here AND there, and which one won
                   depended on stylesheet injection order — that ambiguity is why
                   the header's spacing kept regressing whenever either file was
                   touched. One owner per component; this is the CSS half of the
                   Svelte migration (docs/design/svelte-migration.md).
                   The .mdetail-ws rules are gone entirely with the row itself —
                   the workspace is in the inspector now. */

                /* ── Progress Row ──────────────────────────────── */

                /* ── Filter Bar ────────────────────────────────── */
                .mfilter-bar {
                    display: flex;
                    gap: 2px;
                    padding: 5px 10px;
                    background: var(--surface-panel);
                    border-bottom: 1px solid var(--line-soft);
                    flex-shrink: 0;
                    align-items: center;
                }
                .mfilter-btn {
                    padding: 3px 10px;
                    border: none;
                    background: transparent;
                    color: var(--ink-faint);
                    font-size: var(--fs-xs);
                    font-weight: 600;
                    cursor: pointer;
                    border-radius: var(--r-2);
                    transition: background 0.12s, color 0.12s;
                }
                .mfilter-btn:hover { background: var(--surface-hover); color: var(--ink-soft); }
                .mfilter-btn.active { background: var(--surface-sunken); color: var(--accent); }

                /* ── Live-activity FEED (chat-style, flows inside the Task scroll) ── */
                .mresult-live {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    padding: 10px 14px;
                    /* Bound the streaming activity log so it can't grow endlessly:
                       fixed max-height with its own scroll. The newest item is kept
                       in view (auto-scroll on append). */
                    max-height: 40vh;
                    overflow-y: auto;
                    border-top: 1px dashed var(--line-soft);
                }
                /* B: aggregated changed-files bar (sticky at top of the Task scroll).
                   Collapsed = ONE header line; expanded = fixed-height scrollable
                   table (so 100+ files never flood the view). */
                /* Collapsible directory-grouped file list inside a result bubble.
                   The toggle is a <button> now, not <details>/<summary>: the open
                   state has to be controlled (it depends on how many files there
                   are), and a <details> whose openness is set from script fights
                   the browser's own toggling. */
                .mrc-files-details { margin-top: 8px; }
                .mrc-files-summary {
                    display: block; width: 100%; text-align: left;
                    background: none; border: 0;
                    cursor: pointer; user-select: none;
                    font-size: var(--fs-xs); font-weight: 700;
                    color: var(--ink-soft);
                    padding: 3px 0;
                }
                .mrc-files-summary:hover { color: var(--accent); }
                .mrc-fd-hint { font-weight: 400; font-size: var(--fs-2xs); color: var(--ink-faint); }
                .mrc-files-scroll {
                    max-height: 240px;   /* fixed cap; scrolls internally */
                    overflow-y: auto;
                    margin-top: 4px;
                    padding-right: 4px;
                }
                .mrc-fg { margin-bottom: 6px; }
                .mrc-fg-dir {
                    font-size: var(--fs-xs); font-weight: 700;
                    color: var(--ink-soft);
                    margin: 4px 0 3px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .mrc-fg-n {
                    font-weight: 400; color: var(--ink-faint);
                    background: var(--surface-sunken);
                    border-radius: var(--r-3); padding: 0 6px; font-size: var(--fs-2xs);
                }
                /* Live region pins to the BOTTOM of the Task scroll so a long
                   request/answer above can't push the progress out of view (it
                   used to get squeezed to a single line). It still sits at the end
                   of the content — chat-like — but stays visible while scrolling. */
                /* D: "working now" boundary between settled results and the live feed. */
                .mresult-live-label {
                    display: flex; align-items: center; gap: 7px;
                    margin: 6px 12px 0; padding: 5px 10px;
                    font-size: var(--fs-xs); font-weight: 700; color: var(--accent);
                    background: var(--accent-surface));
                    border-radius: var(--r-2); cursor: pointer; user-select: none;
                }
                .mresult-live-label .mll-dot {
                    width: 7px; height: 7px; border-radius: 50%;
                    background: var(--accent); animation: mlive-pulse 1.2s ease-in-out infinite;
                    flex-shrink: 0;
                }
                .mresult-live-label .mll-text { flex: 1; }
                .mresult-live-label .mll-chev {
                    font-size: var(--fs-2xs); opacity: 0.8; transition: transform 0.12s ease;
                }
                .mresult-live-label.is-folded .mll-chev { transform: rotate(-90deg); }
                /* C: floating "new activity" pill above the steer box. */
                .mresult-jump {
                    position: absolute; left: 50%; transform: translateX(-50%);
                    bottom: 96px; z-index: 20;
                    background: var(--accent); color: var(--on-accent);
                    border: none; border-radius: var(--r-pill);
                    padding: 6px 14px; font-size: var(--fs-xs); font-weight: 700;
                    cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
                }
                .mresult-jump:hover { filter: brightness(1.08); }
                .mtask-feed-item {
                    display: flex;
                    align-items: flex-start;
                    gap: 7px;
                    font-size: var(--fs-sm);
                    line-height: 1.45;
                    color: var(--ink-soft);
                    cursor: default;
                }
                /* Mechanical trace (tool calls / results) — deliberately quiet so it
                   doesn't compete with the reasoning above it. */
                .mtask-feed-item:not(.is-think):not(.is-question) {
                    color: var(--ink-faint);
                    font-size: var(--fs-xs);
                }
                /* THE THINKING — the thing worth reading. Prominent: primary colour,
                   a little larger/heavier, and its own indented block so a run reads
                   as "reasoning → the tools it triggered". */
                .mtask-feed-item.is-think {
                    color: var(--ink);
                    font-size: var(--fs-sm);
                    font-weight: 500;
                    line-height: 1.6;
                    margin: 6px 0 2px;
                    padding-left: 8px;
                    border-left: 2px solid var(--accent);
                }
                /* ── Reasoning GROUP: header (the reasoning) + body (the tool lines
                   it triggered). Click the header to fold the whole block; a new
                   reasoning auto-folds the prior groups. Header stays visible full;
                   body hides when collapsed. ── */
                .mtask-group { display: flex; flex-direction: column; }
                .mtask-group-head { cursor: pointer; }
                .mtask-group-head .mtask-feed-tx { -webkit-line-clamp: unset; }   /* header shown in full */
                .mtask-group-body {
                    display: flex; flex-direction: column; gap: 5px;
                    margin: 5px 0 4px 3px; padding-left: 12px;
                    border-left: 2px solid var(--line-soft);
                }
                .mtask-group.collapsed .mtask-group-body { display: none; }
                .mtask-group.collapsed .mtask-group-head { opacity: 0.72; font-weight: 400; }
                .mtask-feed-chev {
                    flex-shrink: 0; margin-left: auto; align-self: flex-start;
                    color: var(--accent); font-size: var(--fs-2xs); opacity: 0.75;
                    transition: transform 0.12s ease; padding-top: 3px;
                }
                .mtask-group.collapsed .mtask-group-head .mtask-feed-chev { transform: rotate(-90deg); }
                /* Each entry is clamped to 2 lines so one long thought doesn't sprawl.
                   Click to toggle the full text (title also carries it for hover). */
                .mtask-feed-tx {
                    word-break: break-word;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .mtask-feed-item.clampable { cursor: pointer; }
                .mtask-feed-item.expanded .mtask-feed-tx { -webkit-line-clamp: unset; }
                /* The ask_user question is important — always show it in full. */
                .mtask-feed-item.is-question .mtask-feed-tx { -webkit-line-clamp: unset; }
                .mtask-feed-item.is-error { color: var(--error); }
                /* ask_user: highlighted "answer me" card so the pause is unmistakable. */
                .mtask-feed-item.is-question {
                    color: var(--ink);
                    background: var(--accent-surface);
                    border: 1px solid var(--accent);
                    border-radius: var(--r-3);
                    padding: 8px 10px;
                    font-weight: 600;
                }
                .mtask-feed-item:last-child { color: var(--ink); }
                .mtask-feed-ic { flex-shrink: 0; opacity: 0.9; }
                /* The newest item gets a subtle pulse so it reads as "live". */
                .mtask-feed-item:last-child .mtask-feed-ic { animation: mlive-pulse 1.2s ease-in-out infinite; }
                .mtask-feed-done .mtask-feed-item:last-child .mtask-feed-ic { animation: none; }
                @keyframes mlive-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

                /* ── Loading indicator (historical results fetch in flight) ── */
                .mload {
                    display: flex; align-items: center; justify-content: center; gap: 9px;
                    padding: 18px 12px; font-size: var(--fs-sm); color: var(--ink-faint);
                    animation: mfade-in 0.4s ease;
                }
                .mload-spin {
                    width: 14px; height: 14px; flex-shrink: 0;
                    border: 2px solid var(--line);
                    border-top-color: var(--accent);
                    border-radius: 50%;
                    animation: mspin 0.8s linear infinite;
                }
                @keyframes mspin { to { transform: rotate(360deg); } }
                @keyframes mfade-in { from { opacity: 0; } to { opacity: 1; } }

                /* ── Result as a chat conversation (request → answer bubbles) ── */
                /* Live narration — the model's in-flight prose. Lighter/dashed so
                   it reads as "being said right now", distinct from a settled
                   answer bubble (which is solid). Replaced by the real result
                   bubble on completion. */
                @keyframes mcaret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
                /* Fold/unfold toggle — collapsed shows a single dimmed line so past
                   reasoning stays available but out of the way. */
                .mrc-narration.collapsed { opacity: 0.7; }
                .mrc-narration.collapsed .mrc-nar-chev { transform: rotate(-90deg); }
                .mrc-narration.collapsed .mrc-bubble::after { display: none; }  /* no caret on folded */
                .mrc-narration.collapsed .rv-summary {
                    display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                /* Delivered proposal/result (present_result) — a solid accent-edged
                   card with a header so it stands out from the reasoning trace. */

                /* Attached-image thumbnails inside a request bubble. */
                .mrc-imgs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
                .mrc-img {
                    max-height: 140px; max-width: 100%; border-radius: var(--r-2);
                    border: 1px solid var(--line); cursor: zoom-in; display: block;
                }
                /* An over-long request is clamped by the
                   .tl-request:not(.is-open) .tl-q-text rule in
                   monitor/timelineStyles.js, and the whole card opens on click.
                   The .mrc-req rules that used to live here rendered the text
                   TWICE — a short copy and a full one — and swapped which was
                   displayed; the migration dropped that for one copy plus a
                   line-clamp. */
                /* "thinking…" placeholder shown under the just-sent user message. */
                @keyframes mrc-typing { 0%,60%,100%{opacity:0.3;transform:translateY(0)} 30%{opacity:1;transform:translateY(-3px)} }
                .mrc-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
                .mrc-file {
                    display: inline-flex; align-items: center; gap: 5px;
                    background: var(--surface-sunken); border: 1px solid var(--line);
                    padding: 3px 8px; border-radius: var(--r-2); font-size: var(--fs-xs); cursor: pointer;
                }
                .mrc-file:hover { border-color: var(--accent); }
                .mrc-file-act { color: var(--ink-faint); font-size: var(--fs-2xs); }
                .mrc-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
                .mrc-stats span {
                    background: var(--surface-sunken); color: var(--ink-faint);
                    padding: 2px 7px; border-radius: var(--r-2); font-size: var(--fs-xs);
                }

                /* Low-GPU / accessibility: honor the OS "reduce motion" setting —
                   drop the pulsing/animation work that is costly to composite on
                   machines without a GPU. */
                @media (prefers-reduced-motion: reduce) {
                    * { transition: none !important; }
                }

                /* ── Turn divider (between continued exchanges in All Logs) ── */
                .mturn-divider {
                    display: flex; align-items: center; gap: 8px;
                    margin: 12px 2px 8px;
                    color: var(--ink-faint); font-size: var(--fs-xs);
                    font-weight: 600; letter-spacing: 0.04em;
                }
                .mturn-divider::before, .mturn-divider::after {
                    content: ''; flex: 1; height: 1px; background: var(--line);
                }
                /* Request-boundary divider — stronger than a plain turn divider so a
                   multi-request task is easy to scan. Sticks to the top while its
                   request's steps scroll, so you always know which request you're in. */
                .mturn-request {
                    position: sticky; top: 0; z-index: 5;
                    margin: 14px 0 8px;
                    color: var(--accent); font-size: var(--fs-xs); font-weight: 700;
                    background: var(--surface-app); padding: 4px 0;
                }
                .mturn-request::before, .mturn-request::after { background: var(--accent); opacity: 0.4; }
                .mturn-request span { white-space: nowrap; }

                /* ── Console / Log Area ────────────────────────── */
                .mconsole {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px 10px;
                    background: var(--surface-app);
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    min-height: 0;
                }
                .mconsole-placeholder {
                    font-size: var(--fs-sm);
                    color: var(--ink-faint);
                    padding: 20px;
                    text-align: center;
                }

                /* ── Step Container ────────────────────────────── */
                .mstep {
                    border: 1px solid var(--line-soft);
                    border-radius: var(--r-2);
                    overflow: hidden;
                    margin-bottom: 3px;
                    flex-shrink: 0;
                }
                .mstep-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 5px 10px;
                    background: var(--surface-panel);
                    cursor: pointer;
                    user-select: none;
                    min-height: 30px;
                    transition: background 0.12s;
                    min-width: 0;
                    overflow: hidden;
                }
                .mstep-header:hover { background: var(--surface-hover); }
                .mstep-header.expanded { background: var(--surface-sunken); }
                .mstep-toggle {
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    width: 12px;
                    flex-shrink: 0;
                }
                .mstep-header.expanded .mstep-toggle { color: var(--accent); }
                .mstep-num {
                    font-size: var(--fs-xs);
                    font-weight: 700;
                    color: var(--accent);
                    font-family: var(--font-mono);
                    flex-shrink: 0;
                    white-space: nowrap;
                }
                .mstep-pulse {
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    background: var(--accent);
                    animation: dotPulse 1s infinite;
                    flex-shrink: 0;
                }
                .mstep-summary {
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                /* Live (in-flight) status — italic + dimmer to distinguish from
                   a finalized thought/tool summary */
                .mstep-summary.live-status {
                    font-style: italic;
                    color: var(--ink-faint);
                }
                .mstep-summary.tool-status {
                    color: var(--accent);
                    font-family: var(--font-mono);
                    font-size: var(--fs-xs);
                }
                .mstep-summary.error-status {
                    color: var(--warning);
                }
                .mstep-summary.confirm-status {
                    color: var(--info);
                    font-weight: 500;
                }
                .mstep-time {
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    flex-shrink: 0;
                    white-space: nowrap;
                }

                /* ── CHAT button in step header ────────────────── */
                .mstep-chat-btn {
                    flex-shrink: 0;
                    padding: 2px 8px;
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    background: var(--surface-app);
                    color: var(--accent);
                    font-size: var(--fs-2xs);
                    font-family: var(--font-mono);
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.12s, border-color 0.12s;
                    line-height: 1.5;
                }
                .mstep-chat-btn:hover {
                    background: var(--surface-hover);
                    border-color: var(--accent);
                }
                .mstep-chat-btn.err {
                    color: var(--error);
                    border-color: rgba(255,80,80,0.4);
                }

                /* ── Step Body ─────────────────────────────────── */
                .mstep-body {
                    display: none;
                    flex-direction: column;
                    gap: 2px;
                    padding: 5px 6px;
                    background: var(--surface-app);
                    border-top: 1px solid var(--line-soft);
                }
                .mstep-body.open { display: flex; }

                /* ── Log Line Types ────────────────────────────── */
                .mlog {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    padding: 3px 6px;
                    border-radius: var(--r-2);
                    font-size: var(--fs-xs);
                    line-height: 1.45;
                    min-width: 0;
                }
                .mlog:hover { background: var(--surface-panel); }
                .mlog-icon {
                    flex-shrink: 0;
                    font-size: var(--fs-xs);
                    margin-top: 1px;
                    width: 14px;
                    text-align: center;
                }
                .mlog-body { flex: 1; min-width: 0; overflow: hidden; }

                /* Thought */
                .mlog-thought .mlog-body { color: var(--ink-soft); }
                .mlog-thought-summary {
                    color: var(--ink-soft);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    min-width: 0;
                }
                .mlog-thought-summary span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    flex: 1;
                    min-width: 0;
                }
                .mlog-thought-summary:hover { color: var(--ink); }
                .mlog-expand-btn {
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0 2px;
                    flex-shrink: 0;
                }
                .mlog-thought-detail {
                    display: none;
                    margin-top: 6px;
                    padding: 10px 12px;
                    background: var(--surface-sunken);
                    border: 1px solid var(--line-soft);
                    border-radius: var(--r-2);
                    font-size: var(--fs-sm);
                    color: var(--ink-soft);
                    max-height: 360px;
                    overflow-y: auto;
                }
                .mlog-thought-detail.open { display: block; }

                /* ── Friendly multi-field thought detail layout ── */
                .thought-detail-formatted {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .thought-field {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .thought-field-label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: var(--fs-xs);
                    font-weight: 700;
                    color: var(--accent);
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                }
                .thought-field-icon {
                    font-size: var(--fs-md);
                    line-height: 1;
                }
                .thought-field-content {
                    font-size: var(--fs-sm);
                    line-height: 1.55;
                    white-space: pre-wrap;
                    word-break: break-word;
                    color: var(--ink);
                    padding: 6px 10px;
                    background: var(--surface-panel);
                    border-left: 2px solid var(--accent-dim);
                    border-radius: 0 4px 4px 0;
                }
                .thought-field-content .thought-list {
                    margin: 0;
                    padding-left: 18px;
                }
                .thought-field-content .thought-list li {
                    margin-bottom: 4px;
                }
                .thought-field-content .thought-list li:last-child {
                    margin-bottom: 0;
                }
                .thought-nested {
                    margin: 4px 0 0 0;
                    padding: 6px 8px;
                    background: var(--surface-app);
                    border-radius: var(--r-2);
                    font-family: var(--font-mono);
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    white-space: pre-wrap;
                    word-break: break-word;
                }
                .thought-empty {
                    color: var(--ink-faint);
                    font-style: italic;
                    font-size: var(--fs-xs);
                }
                .thought-raw {
                    margin: 0;
                    font-family: var(--font-mono);
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                /* Tool call */
                .mlog-tool .mlog-body { font-family: var(--font-mono); min-width: 0; }
                .mlog-tool-name { color: var(--accent); font-weight: 600; font-size: var(--fs-xs); }
                .mlog-tool-args { color: var(--ink-faint); font-size: var(--fs-xs); }
                .mlog-tool-result {
                    display: none;
                    margin-top: 6px;
                    padding: 6px 10px;
                    background: var(--surface-sunken);
                    border: 1px solid var(--line-soft);
                    border-left: 3px solid var(--accent);
                    border-radius: var(--r-2);
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    max-height: 300px;
                    overflow: auto;
                }
                .mlog-tool-result.open { display: block; }
                .mlog-tool-row {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    cursor: pointer;
                    min-width: 0;
                    overflow: hidden;
                }
                .mlog-tool-row:hover .mlog-tool-name { text-decoration: underline; }
                .mlog-tool-result-preview {
                    flex: 1;
                    min-width: 0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-size: var(--fs-xs);
                    color: var(--success);
                }

                /* File / Status rows */
                .mlog-file .mlog-body code,
                .mlog-cmd .mlog-body code {
                    font-size: var(--fs-xs);
                    background: var(--surface-sunken);
                    padding: 1px 5px;
                    border-radius: var(--r-1);
                    color: var(--ink-soft);
                    word-break: break-all;
                }
                .mlog-read .mlog-icon { color: #339af0; }
                .mlog-write .mlog-icon { color: hsl(340,100%,65%); }
                .mlog-cmd .mlog-icon { color: var(--success); }
                .mlog-success { color: var(--success); }
                /* A run cut short by a safety limit. Not an error — the work is real
                   and resumable — but it must not read as a clean finish. */
                .mlog-warn { color: var(--warning, #f59e0b); }
                .mlog-error { color: var(--error); }
                .mlog-status { color: var(--ink-faint); }

                /* Inline TOOL telemetry */
                .mlog-telemetry {
                    border: 1px solid var(--line-soft);
                    border-radius: var(--r-2);
                    overflow: hidden;
                }
                .mlog-tele-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    background: var(--surface-panel);
                    cursor: pointer;
                    font-size: var(--fs-xs);
                    font-family: var(--font-mono);
                }
                .mlog-tele-header:hover { background: var(--surface-hover); }
                .mlog-tele-method { font-weight: 700; color: var(--accent); font-size: var(--fs-xs); }
                .mlog-tele-status-ok { color: var(--success); font-weight: 700; font-size: var(--fs-xs); }
                .mlog-tele-status-err { color: var(--error); font-weight: 700; font-size: var(--fs-xs); }
                .mlog-tele-dur { color: var(--ink-faint); font-size: var(--fs-2xs); }
                .mlog-tele-usage { margin-left: auto; font-size: var(--fs-xs); color: var(--ink-soft); }
                .mlog-tele-body {
                    display: none;
                    background: var(--surface-app);
                    border-top: 1px solid var(--line-soft);
                }
                .mlog-tele-body.open { display: block; }
                .mlog-tele-tabs {
                    display: flex;
                    gap: 1px;
                    padding: 4px 8px 0;
                    background: var(--surface-panel);
                }
                .mlog-tele-tab {
                    padding: 2px 10px;
                    font-size: var(--fs-xs);
                    border: none;
                    background: transparent;
                    color: var(--ink-faint);
                    cursor: pointer;
                    border-radius: var(--r-1) 3px 0 0;
                    font-weight: 600;
                }
                .mlog-tele-tab.active { background: var(--surface-app); color: var(--accent); }
                .mlog-tele-content pre {
                    margin: 0;
                    padding: 8px;
                    font-size: var(--fs-xs);
                    font-family: var(--font-mono);
                    color: var(--ink-soft);
                    white-space: pre-wrap;
                    word-break: break-word;
                    max-height: 200px;
                    overflow-y: auto;
                    background: var(--surface-app);
                }

                /* Confirm boxes */
                .mconfirm-box {
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    padding: 10px 12px;
                    background: var(--surface-panel);
                    font-size: var(--fs-sm);
                    margin: 2px 0;
                }
                .mconfirm-box h4 { margin: 0 0 6px; font-size: var(--fs-sm); color: var(--ink); }
                .mconfirm-box pre { margin: 4px 0; font-size: var(--fs-xs); background: var(--surface-sunken); padding: 6px; border-radius: var(--r-2); max-height: 120px; overflow-y: auto; }
                .mconfirm-actions { display: flex; gap: 8px; margin-top: 8px; }
                .mconfirm-risk {
                    font-size: var(--fs-xs); font-weight: 700; color: #fff;
                    background: var(--error); border-radius: var(--r-2); padding: 1px 7px; margin-left: 6px;
                }
                .mconfirm-autows {
                    display: flex; align-items: center; gap: 7px;
                    margin-top: 8px; font-size: var(--fs-xs); color: var(--ink-soft); cursor: pointer;
                    user-select: none;
                }
                .mconfirm-autows input { cursor: pointer; }
                .mconfirm-manage { margin-top: 6px; }
                .mconfirm-manage .acm-open { font-size: var(--fs-xs); color: var(--accent); cursor: pointer; text-decoration: none; }
                .mconfirm-manage .acm-open:hover { text-decoration: underline; }
                .acm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
                    background: var(--surface-sunken); border: 1px solid var(--line-soft); border-radius: var(--r-2); padding: 5px 9px; }
                .acm-row code { font-size: var(--fs-xs); color: var(--ink); word-break: break-all; }
                .acm-del { background: none; border: none; color: var(--error); cursor: pointer; font-size: var(--fs-sm); flex-shrink: 0; }
                .acm-empty { font-size: var(--fs-xs); color: var(--ink-faint); padding: 4px 2px; }

                /* Task-view approval slot — pinned above the steer box, accented so
                   a pending approval reads as "act on me now". */
                .mresult-confirm {
                    flex-shrink: 0;
                    padding: 8px 10px 0;
                    max-height: 42vh;
                    overflow-y: auto;
                }
                .mresult-confirm .mconfirm-box {
                    border-color: var(--accent);
                    box-shadow: 0 0 0 1px var(--accent-surface));
                }
                /* ask_user interactive answer card */
                .mask-box {
                    border: 1px solid var(--accent);
                    border-radius: var(--r-3); padding: 10px 12px;
                    background: var(--accent-surface));
                }
                .mask-q { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); margin-bottom: 8px; }
                .mask-opts { display: flex; flex-wrap: wrap; gap: 8px; }
                .mask-opts.is-multi { flex-direction: column; gap: 5px; }
                .mask-opt {
                    background: var(--surface-panel); border: 1px solid var(--line-focus);
                    color: var(--ink); border-radius: var(--r-2); padding: 6px 14px;
                    font-size: var(--fs-sm); cursor: pointer; transition: background 0.12s, border-color 0.12s;
                }
                .mask-opt:hover { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
                .mask-check { display: flex; align-items: center; gap: 7px; font-size: var(--fs-sm); color: var(--ink); cursor: pointer; }
                .mask-actions { margin-top: 8px; }
                .mask-hint { margin-top: 8px; font-size: var(--fs-xs); color: var(--ink-faint); }
                /* Plan-revision input (the ✏️ option on the approval card). */
                .mask-revise { margin-top: 10px; }
                .mask-revise-label { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); margin-bottom: 6px; }
                .mask-revise-input {
                    width: 100%; min-height: 64px; resize: vertical;
                    background: var(--surface-panel); color: var(--ink);
                    border: 1px solid var(--line-focus); border-radius: var(--r-2);
                    padding: 8px 10px; font-size: var(--fs-sm); line-height: 1.5;
                    box-sizing: border-box;
                }
                .mask-revise-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-surface)); }
                .mask-revise .mask-actions { display: flex; gap: 8px; justify-content: flex-end; }
                .mask-revise-cancel { background: var(--surface-sunken); border: 1px solid var(--line); color: var(--ink-soft); }

                /* Steering input */
                .msteering-wrapper {
                    display: flex;
                    flex-direction: column;
                    background: var(--surface-panel);
                    border-top: 1px solid var(--line-soft);
                    flex-shrink: 0;
                    padding: 8px 10px;
                    position: relative;
                }
                .msteering-top {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .msteering-previews {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-bottom: 6px;
                }
                .msteering-skills {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 6px;
                }
                .msteering-input-row {
                    display: flex;
                    gap: 8px;
                    align-items: flex-end;
                }
                .steer-btn-icon {
                    background: transparent;
                    border: none;
                    color: var(--ink-soft);
                    font-size: var(--fs-lg);
                    cursor: pointer;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--r-2);
                    transition: background 0.15s, color 0.15s;
                    flex-shrink: 0;
                }
                .steer-btn-icon:hover { color: var(--ink); background: hsla(220, 20%, 30%, 0.5); }
                .steer-btn-icon:disabled { opacity: 0.5; cursor: not-allowed; }
                .msteering-wrapper textarea {
                    flex: 1;
                    background: var(--surface-input);
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    color: var(--ink);
                    font-family: var(--font-sans);
                    font-size: var(--fs-sm);
                    padding: 7px 10px;
                    resize: none;
                    min-height: 36px;
                    max-height: 160px;
                    overflow-y: auto;
                    outline: none;
                    transition: border-color 0.15s;
                }
                .msteering-wrapper textarea:focus { border-color: var(--accent); }
                .msteering-wrapper textarea::placeholder { color: var(--ink-faint); }
                .msteering-wrapper .btn-sm {
                    height: 36px;
                    padding: 0 16px;
                    font-size: var(--fs-sm);
                    flex-shrink: 0;
                    align-self: flex-end;
                }


                /* ── Timeline (monitor/taskTimeline.js) ─────────────────────────────────── */
                /* One ordered stream replaced the eight stacked slots. Items keep their old
                   inner classes, so only the wrappers need rules. */
                .mtl { display: flex; flex-direction: column; gap: 6px; }
                .mtl-group { display: flex; flex-direction: column; gap: 2px; }
                .mtl-group.collapsed .mtask-group-body { display: none; }
                /* The step count needs a fixed right edge, so the label text has
                   to take the slack — otherwise the counts sat at a different x
                   on every row (the ragged edge the counts showed). */
                .mtask-group-head .mtask-feed-tx { flex: 1 1 auto; min-width: 0; }
                .mtask-group-n {
                    flex: 0 0 auto;
                    padding: 0 var(--space-2);
                    font-size: var(--fs-2xs); color: var(--ink-faint);
                    white-space: nowrap; font-variant-numeric: tabular-nums;
                }
                .mtl-group.collapsed .mtask-feed-chev { transform: rotate(-90deg); }
                .mask-box.is-answered { opacity: .72; }
                .mask-answered { margin-top: 4px; font-size: var(--fs-sm); color: var(--ink-soft); }
                /* Closed without a reply — quieter than a real answer, so history
                   does not read as a conversation that happened. */
                .mask-answered.is-none { color: var(--ink-faint); font-style: italic; }
                .mresult-earlier { text-align: center; padding: 6px 0; }
                .mresult-earlier .btn { font-size: var(--fs-sm); }
                .mresult-earlier-note { margin-top: var(--space-1); font-size: var(--fs-xs); color: var(--ink-faint); }
                /* ── B: connected apps (AI-Hub) ─────────────────────────────── */
                .hub-strip {
                    padding: var(--space-2) 0 var(--space-3);
                    border-bottom: 1px solid var(--line-soft);
                    margin-bottom: var(--space-3);
                }
                .hub-strip-inner { display: flex; flex-wrap: wrap; gap: var(--space-3); }
                .hub-app { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); }
                .hub-app-name {
                    display: inline-flex; align-items: center; gap: var(--space-1);
                    font-size: var(--fs-2xs); font-weight: 600;
                    color: var(--ink-soft); text-transform: uppercase;
                    letter-spacing: .04em; margin-right: var(--space-1);
                }
                .hub-chip {
                    display: inline-flex; align-items: center; gap: var(--space-1);
                    font-size: var(--fs-xs);
                    padding: 2px var(--space-2);
                    border: 1px solid var(--line);
                    border-radius: var(--r-pill);
                    background: var(--surface-sunken);
                    color: var(--ink-soft);
                    cursor: pointer;
                    max-width: 220px; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap;
                }
                .hub-chip:hover { color: var(--accent); border-color: var(--line-focus); }
                .hub-intent { border-style: solid; }
                .hub-res { border-style: dashed; }
                /* The run indicator is a status STRIP pinned to the bottom edge,
                   not a header above a feed. Once everything became one stream,
                   a divider in the middle of the scroll just read as stale. */
                .mresult-live-label {
                    position: sticky; bottom: 0; z-index: 2;
                }

                /* ── B: connected apps (AI-Hub) ─────────────────────────────── */
                .hub-strip {
                    padding: var(--space-2) 0 var(--space-3);
                    border-bottom: 1px solid var(--line-soft);
                    margin-bottom: var(--space-3);
                }
                .hub-strip-inner { display: flex; flex-wrap: wrap; gap: var(--space-3); }
                .hub-app { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); }
                .hub-app-name {
                    display: inline-flex; align-items: center; gap: var(--space-1);
                    font-size: var(--fs-2xs); font-weight: 600;
                    color: var(--ink-soft); text-transform: uppercase;
                    letter-spacing: .04em; margin-right: var(--space-1);
                }
                .hub-chip {
                    display: inline-flex; align-items: center; gap: var(--space-1);
                    font-size: var(--fs-xs);
                    padding: 2px var(--space-2);
                    border: 1px solid var(--line);
                    border-radius: var(--r-pill);
                    background: var(--surface-sunken);
                    color: var(--ink-soft);
                    cursor: pointer;
                    max-width: 220px; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap;
                }
                .hub-chip:hover { color: var(--accent); border-color: var(--line-focus); }
                .hub-intent { border-style: solid; }
                .hub-res { border-style: dashed; }

            
    /* An approval nobody can answer any more. Stated, not hidden: the request
       really was made, and the person is owed the reason it is now inert. */
    .mconfirm-stale { color: var(--ink-faint); font-size: var(--fs-sm); }
`;

export const MONITOR_STYLES = BASE_STYLES + TIMELINE_STYLES;
