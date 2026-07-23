// Extracted CSS for MonitorView — kept as a template string so render()
// stays readable. Content is byte-identical to the former inline <style>.

export const MONITOR_STYLES = `
                /* ── Layout ────────────────────────────────────── */
                .monitor-layout {
                    display: flex;
                    height: calc(100vh - var(--titlebar-height) - 50px);
                    gap: 12px;
                    padding: 12px 0 0 0;
                }

                /* ── Left Panel ────────────────────────────────── */
                .mpanel-left {
                    width: 240px;
                    min-width: 200px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .mpanel-left-header {
                    padding: 8px 12px;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border);
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-secondary);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .mtask-filter {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    padding: 7px 8px;
                    border-bottom: 1px solid var(--border);
                    background: var(--bg-secondary);
                }
                .mtask-search, .mtask-status {
                    width: 100%;
                    height: 26px;
                    font-size: 11.5px;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: 5px;
                    color: var(--text-primary);
                    padding: 0 8px;
                    outline: none;
                }
                .mtask-search:focus, .mtask-status:focus { border-color: var(--accent); }
                .mtask-status { cursor: pointer; }
                .mgroup-toggle {
                    display: flex;
                    gap: 3px;
                    padding: 6px 8px;
                    border-bottom: 1px solid var(--border);
                    background: var(--bg-secondary);
                }
                .mgroup-btn {
                    flex: 1;
                    padding: 4px 0;
                    font-size: 11px;
                    font-weight: 600;
                    border: 1px solid var(--border);
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                    border-radius: 5px;
                    cursor: pointer;
                    transition: background 0.12s, color 0.12s;
                }
                .mgroup-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
                .mgroup-btn.active { background: var(--accent); color: var(--text-inverse); border-color: var(--accent); }
                .mtask-group-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.02em;
                    color: var(--accent);
                    padding: 9px 8px 5px;
                    position: sticky;
                    top: 0;
                    background: var(--bg-secondary);
                    z-index: 1;
                    cursor: pointer;
                    user-select: none;
                    border-bottom: 1px solid var(--border-light);
                }
                .mtask-group-header:hover { color: var(--accent-hover); }
                .mgroup-chevron { font-size: 9px; width: 11px; flex-shrink: 0; opacity: 0.8; }
                .mgroup-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mgroup-count { font-size: 11px; opacity: 0.6; font-weight: 600; color: var(--text-secondary); }
                .mpanel-left-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .mtask-item {
                    padding: 7px 9px;
                    border-radius: 6px;
                    border: 1px solid transparent;
                    cursor: pointer;
                    transition: background 0.15s;
                }
                .mtask-item:hover { background: var(--bg-hover); }
                .mtask-item.selected {
                    background: var(--accent-glow-lg);
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
                .dot-aborted { background: var(--text-tertiary); }
                @keyframes dotPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
                .mtask-id {
                    font-family: var(--font-mono);
                    font-size: 10.5px;
                    color: var(--text-tertiary);
                }
                .mtask-caller {
                    font-size: 9px;
                    font-weight: 700;
                    color: var(--accent);
                    background: var(--accent-glow);
                    padding: 1px 5px;
                    border-radius: 3px;
                }
                .mtask-time {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    margin-left: auto;
                }
                /* Per-item delete — hidden until the row is hovered, so the list
                   stays clean but deletion is always one hover+click away. */
                .mtask-del {
                    background: none;
                    border: none;
                    color: var(--text-tertiary);
                    cursor: pointer;
                    font-size: 11px;
                    line-height: 1;
                    padding: 2px 3px;
                    border-radius: 4px;
                    opacity: 0;
                    transition: opacity 0.12s, color 0.12s, background 0.12s;
                }
                .mtask-item:hover .mtask-del { opacity: 0.65; }
                .mtask-del:hover { opacity: 1; color: var(--error); background: var(--bg-tertiary); }
                .mtask-prompt {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .mtask-progbar {
                    margin-top: 4px;
                    height: 2px;
                    background: var(--bg-tertiary);
                    border-radius: 1px;
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
                    color: var(--text-tertiary);
                    font-size: 12px;
                }

                /* ── Right Panel ───────────────────────────────── */
                .mpanel-right {
                    flex: 1;
                    min-width: 0;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
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
                    color: var(--text-tertiary);
                }
                .mdetail-empty-icon { font-size: 40px; margin-bottom: 12px; }
                .mdetail-empty h3 { margin: 0 0 6px; font-size: 15px; }
                .mdetail-empty p { font-size: 12px; margin: 0; }

                /* ── Detail Header ─────────────────────────────── */
                .mdetail-header {
                    padding: 8px 14px;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border);
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    flex-shrink: 0;
                    min-width: 0;
                }
                /* Workspace / context bar — prominent so the target project is clear. */
                .mdetail-ws {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    padding: 5px 14px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-light);
                    font-size: 12px;
                    color: var(--accent);
                    font-family: var(--font-mono, monospace);
                    flex-shrink: 0;
                }
                .mdetail-ws-path {
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                    direction: rtl; text-align: left;
                }
                .mdetail-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-primary);
                    font-family: var(--font-mono);
                    flex-shrink: 0;
                }
                .mdetail-prompt-text {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                .mdetail-tokens {
                    font-size: 11px;
                    color: var(--text-tertiary);
                    white-space: nowrap;
                    flex-shrink: 0;
                }
                .mdetail-tokens strong { color: var(--accent); }

                /* ── Progress Row ──────────────────────────────── */
                .mdetail-progress {
                    padding: 6px 14px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-light);
                    flex-shrink: 0;
                }
                .mdetail-progbar-track {
                    height: 3px;
                    background: var(--bg-tertiary);
                    border-radius: 2px;
                    overflow: hidden;
                }
                .mdetail-progbar-fill {
                    height: 100%;
                    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
                    transition: width 0.3s;
                }
                .mdetail-progress-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 10.5px;
                    color: var(--text-tertiary);
                    margin-top: 3px;
                }

                /* ── Filter Bar ────────────────────────────────── */
                .mfilter-bar {
                    display: flex;
                    gap: 2px;
                    padding: 5px 10px;
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-light);
                    flex-shrink: 0;
                    align-items: center;
                }
                .mfilter-btn {
                    padding: 3px 10px;
                    border: none;
                    background: transparent;
                    color: var(--text-tertiary);
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: background 0.12s, color 0.12s;
                }
                .mfilter-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
                .mfilter-btn.active { background: var(--bg-tertiary); color: var(--accent); }

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
                    border-top: 1px dashed var(--border-light);
                }
                /* B: aggregated changed-files bar (sticky at top of the Task scroll).
                   Collapsed = ONE header line; expanded = fixed-height scrollable
                   table (so 100+ files never flood the view). */
                .mresult-files-bar {
                    position: sticky; top: 0; z-index: 6;
                    display: block;
                    background: var(--bg-primary);
                    border-bottom: 1px solid var(--border-light);
                }
                .mfb-header {
                    display: flex; align-items: center; gap: 8px;
                    padding: 7px 12px;
                    cursor: pointer; user-select: none;
                    white-space: nowrap; overflow: hidden;
                }
                .mfb-header:hover { background: var(--bg-secondary); }
                .mfb-toggle { font-size: 9px; color: var(--text-tertiary); flex-shrink: 0; }
                .mresult-files-bar .mfb-label {
                    font-size: 11px; font-weight: 700; color: var(--text-secondary);
                    flex-shrink: 0;
                }
                .mfb-preview {
                    flex: 1; min-width: 0;
                    font-size: 11px; color: var(--text-tertiary);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .mfb-table-wrap {
                    height: 240px;           /* fixed height when open */
                    overflow-y: auto;
                    border-top: 1px solid var(--border-light);
                }
                .mfb-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
                .mfb-table th {
                    position: sticky; top: 0; z-index: 1;
                    background: var(--bg-secondary);
                    text-align: left; padding: 4px 10px;
                    font-size: 10px; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.05em; color: var(--text-tertiary);
                    border-bottom: 1px solid var(--border-light);
                }
                .mfb-table td {
                    padding: 4px 10px; border-top: 1px solid var(--border-light);
                    color: var(--text-primary);
                }
                .mfb-table tbody tr { cursor: pointer; }
                .mfb-table tbody tr:hover { background: var(--bg-tertiary); }
                .mfb-td-name { white-space: nowrap; font-weight: 600; }
                .mfb-dir-row td {
                    background: var(--bg-secondary);
                    font-size: 10.5px; font-weight: 700;
                    color: var(--text-secondary);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                    max-width: 0;
                }
                .mfb-dir-n { font-weight: 400; color: var(--text-tertiary); }
                /* Collapsible directory-grouped file list inside a result bubble. */
                .mrc-files-details { margin-top: 8px; }
                .mrc-files-details summary {
                    cursor: pointer; user-select: none;
                    font-size: 11.5px; font-weight: 700;
                    color: var(--text-secondary);
                    padding: 3px 0;
                }
                .mrc-fd-hint { font-weight: 400; font-size: 10px; color: var(--text-tertiary); }
                .mrc-files-scroll {
                    max-height: 240px;   /* fixed cap; scrolls internally */
                    overflow-y: auto;
                    margin-top: 4px;
                    padding-right: 4px;
                }
                .mrc-fg { margin-bottom: 6px; }
                .mrc-fg-dir {
                    font-size: 10.5px; font-weight: 700;
                    color: var(--text-secondary);
                    margin: 4px 0 3px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .mrc-fg-n {
                    font-weight: 400; color: var(--text-tertiary);
                    background: var(--bg-tertiary);
                    border-radius: 8px; padding: 0 6px; font-size: 10px;
                }
                /* Live region pins to the BOTTOM of the Task scroll so a long
                   request/answer above can't push the progress out of view (it
                   used to get squeezed to a single line). It still sits at the end
                   of the content — chat-like — but stays visible while scrolling. */
                .mresult-live-wrap {
                    display: none;   /* shown by _setWorkingLabel when a run is live */
                    position: sticky;
                    bottom: 0;
                    z-index: 8;
                    background: var(--bg-primary);
                    box-shadow: 0 -8px 14px -8px rgba(0,0,0,0.35);
                }
                /* D: "working now" boundary between settled results and the live feed. */
                .mresult-live-label {
                    display: flex; align-items: center; gap: 7px;
                    margin: 6px 12px 0; padding: 5px 10px;
                    font-size: 11px; font-weight: 700; color: var(--accent);
                    background: var(--accent-glow, rgba(90,150,255,0.10));
                    border-radius: 6px; cursor: pointer; user-select: none;
                }
                .mresult-live-label .mll-dot {
                    width: 7px; height: 7px; border-radius: 50%;
                    background: var(--accent); animation: mlive-pulse 1.2s ease-in-out infinite;
                    flex-shrink: 0;
                }
                .mresult-live-label .mll-text { flex: 1; }
                .mresult-live-label .mll-chev {
                    font-size: 9px; opacity: 0.8; transition: transform 0.12s ease;
                }
                .mresult-live-label.is-folded .mll-chev { transform: rotate(-90deg); }
                /* C: floating "new activity" pill above the steer box. */
                .mresult-jump {
                    position: absolute; left: 50%; transform: translateX(-50%);
                    bottom: 96px; z-index: 20;
                    background: var(--accent); color: var(--text-inverse);
                    border: none; border-radius: 999px;
                    padding: 6px 14px; font-size: 11.5px; font-weight: 700;
                    cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
                }
                .mresult-jump:hover { filter: brightness(1.08); }
                .mtask-feed-item {
                    display: flex;
                    align-items: flex-start;
                    gap: 7px;
                    font-size: 12px;
                    line-height: 1.45;
                    color: var(--text-secondary);
                    cursor: default;
                }
                /* Mechanical trace (tool calls / results) — deliberately quiet so it
                   doesn't compete with the reasoning above it. */
                .mtask-feed-item:not(.is-think):not(.is-question) {
                    color: var(--text-tertiary);
                    font-size: 11.5px;
                }
                /* THE THINKING — the thing worth reading. Prominent: primary colour,
                   a little larger/heavier, and its own indented block so a run reads
                   as "reasoning → the tools it triggered". */
                .mtask-feed-item.is-think {
                    color: var(--text-primary);
                    font-size: 12.5px;
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
                    border-left: 2px solid var(--border-light);
                }
                .mtask-group.collapsed .mtask-group-body { display: none; }
                .mtask-group.collapsed .mtask-group-head { opacity: 0.72; font-weight: 400; }
                .mtask-feed-chev {
                    flex-shrink: 0; margin-left: auto; align-self: flex-start;
                    color: var(--accent); font-size: 9px; opacity: 0.75;
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
                    color: var(--text-primary);
                    background: var(--accent-soft, rgba(90,150,255,0.12));
                    border: 1px solid var(--accent, #5a96ff);
                    border-radius: 8px;
                    padding: 8px 10px;
                    font-weight: 600;
                }
                .mtask-feed-item:last-child { color: var(--text-primary); }
                .mtask-feed-ic { flex-shrink: 0; opacity: 0.9; }
                /* The newest item gets a subtle pulse so it reads as "live". */
                .mtask-feed-item:last-child .mtask-feed-ic { animation: mlive-pulse 1.2s ease-in-out infinite; }
                .mtask-feed-done .mtask-feed-item:last-child .mtask-feed-ic { animation: none; }
                @keyframes mlive-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

                /* ── Loading indicator (historical results fetch in flight) ── */
                .mload {
                    display: flex; align-items: center; justify-content: center; gap: 9px;
                    padding: 18px 12px; font-size: 12px; color: var(--text-tertiary);
                    animation: mfade-in 0.4s ease;
                }
                .mload-spin {
                    width: 14px; height: 14px; flex-shrink: 0;
                    border: 2px solid var(--border);
                    border-top-color: var(--accent);
                    border-radius: 50%;
                    animation: mspin 0.8s linear infinite;
                }
                @keyframes mspin { to { transform: rotate(360deg); } }
                @keyframes mfade-in { from { opacity: 0; } to { opacity: 1; } }

                /* ── Result as a chat conversation (request → answer bubbles) ── */
                .mresult-chat { display: flex; flex-direction: column; gap: 12px; padding: 14px 12px;
                    /* Loaded content eases in instead of popping. */
                    animation: mfade-in 0.25s ease; }
                .mrc-row { display: flex; width: 100%; }
                .mrc-user { justify-content: flex-end; }
                .mrc-ai   { justify-content: flex-start; }
                .mrc-bubble {
                    max-width: 88%;
                    padding: 10px 14px;
                    border-radius: 12px;
                    font-size: 13px;
                    line-height: 1.6;
                    border: 1px solid var(--border-light);
                    word-break: break-word;
                }
                .mrc-user .mrc-bubble {
                    background: var(--accent-glow-lg);
                    border-radius: 12px 12px 2px 12px;
                    white-space: pre-wrap;
                    color: var(--text-primary);
                }
                .mrc-ai .mrc-bubble {
                    background: var(--bg-secondary);
                    border-radius: 12px 12px 12px 2px;
                }
                /* Live narration — the model's in-flight prose. Lighter/dashed so
                   it reads as "being said right now", distinct from a settled
                   answer bubble (which is solid). Replaced by the real result
                   bubble on completion. */
                .mrc-narration { cursor: pointer; }
                .mrc-narration .mrc-bubble {
                    background: transparent;
                    border-style: dashed;
                    border-color: var(--border);
                    color: var(--text-secondary);
                    position: relative;
                    padding-right: 22px;   /* room for the chevron */
                }
                .mrc-narration .mrc-bubble::after {
                    content: '▍';
                    color: var(--accent);
                    animation: mcaret 1s step-end infinite;
                    margin-left: 2px;
                }
                @keyframes mcaret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
                /* Fold/unfold toggle — collapsed shows a single dimmed line so past
                   reasoning stays available but out of the way. */
                .mrc-nar-chev {
                    position: absolute; top: 8px; right: 8px;
                    color: var(--accent); font-size: 9px; opacity: 0.75;
                    transition: transform 0.12s ease;
                }
                .mrc-narration.collapsed { opacity: 0.7; }
                .mrc-narration.collapsed .mrc-nar-chev { transform: rotate(-90deg); }
                .mrc-narration.collapsed .mrc-bubble::after { display: none; }  /* no caret on folded */
                .mrc-narration.collapsed .rv-summary {
                    display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                /* Delivered proposal/result (present_result) — a solid accent-edged
                   card with a header so it stands out from the reasoning trace. */
                .mrc-bubble.mrc-deliverable {
                    border: 1px solid var(--accent);
                    background: var(--bg-secondary);
                }
                .mrc-deliverable-h {
                    font-size: 11px; font-weight: 700; color: var(--accent);
                    margin: -2px 0 8px; letter-spacing: 0.02em;
                }

                /* Attached-image thumbnails inside a request bubble. */
                .mrc-imgs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
                .mrc-img {
                    max-height: 140px; max-width: 100%; border-radius: 6px;
                    border: 1px solid var(--border); cursor: zoom-in; display: block;
                }
                /* #2: collapse an over-long request; click ▸/▾ to expand. */
                .mrc-req { white-space: pre-wrap; }
                .mrc-req.clamped .mrc-req-full { display: none; }
                .mrc-req:not(.clamped) .mrc-req-short { display: none; }
                .mrc-req-toggle {
                    display: inline-block; margin-top: 4px; font-size: 11px; font-weight: 600;
                    color: var(--accent); cursor: pointer; user-select: none;
                }
                /* "thinking…" placeholder shown under the just-sent user message. */
                .mrc-thinking { display: inline-flex; gap: 4px; align-items: center; }
                .mrc-thinking span {
                    width: 6px; height: 6px; border-radius: 50%;
                    background: var(--text-tertiary);
                    animation: mrc-typing 1.2s infinite ease-in-out;
                }
                .mrc-thinking span:nth-child(2) { animation-delay: 0.2s; }
                .mrc-thinking span:nth-child(3) { animation-delay: 0.4s; }
                @keyframes mrc-typing { 0%,60%,100%{opacity:0.3;transform:translateY(0)} 30%{opacity:1;transform:translateY(-3px)} }
                .mrc-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
                .mrc-file {
                    display: inline-flex; align-items: center; gap: 5px;
                    background: var(--bg-tertiary); border: 1px solid var(--border);
                    padding: 3px 8px; border-radius: 6px; font-size: 11.5px; cursor: pointer;
                }
                .mrc-file:hover { border-color: var(--accent); }
                .mrc-file-act { color: var(--text-tertiary); font-size: 10px; }
                .mrc-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
                .mrc-stats span {
                    background: var(--bg-tertiary); color: var(--text-tertiary);
                    padding: 2px 7px; border-radius: 5px; font-size: 10.5px;
                }

                /* Low-GPU / accessibility: honor the OS "reduce motion" setting —
                   drop the pulsing/animation work that is costly to composite on
                   machines without a GPU. */
                @media (prefers-reduced-motion: reduce) {
                    .mresult-live-dot { animation: none; opacity: 0.9; }
                    * { transition: none !important; }
                }

                /* ── Turn divider (between continued exchanges in All Logs) ── */
                .mturn-divider {
                    display: flex; align-items: center; gap: 8px;
                    margin: 12px 2px 8px;
                    color: var(--text-tertiary); font-size: 10.5px;
                    font-weight: 600; letter-spacing: 0.04em;
                }
                .mturn-divider::before, .mturn-divider::after {
                    content: ''; flex: 1; height: 1px; background: var(--border);
                }
                /* Request-boundary divider — stronger than a plain turn divider so a
                   multi-request task is easy to scan. Sticks to the top while its
                   request's steps scroll, so you always know which request you're in. */
                .mturn-request {
                    position: sticky; top: 0; z-index: 5;
                    margin: 14px 0 8px;
                    color: var(--accent); font-size: 11px; font-weight: 700;
                    background: var(--bg-primary); padding: 4px 0;
                }
                .mturn-request::before, .mturn-request::after { background: var(--accent); opacity: 0.4; }
                .mturn-request span { white-space: nowrap; }

                /* ── Console / Log Area ────────────────────────── */
                .mconsole {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px 10px;
                    background: var(--bg-primary);
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    min-height: 0;
                }
                .mconsole-placeholder {
                    font-size: 12px;
                    color: var(--text-tertiary);
                    padding: 20px;
                    text-align: center;
                }

                /* ── Step Container ────────────────────────────── */
                .mstep {
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    overflow: hidden;
                    margin-bottom: 3px;
                    flex-shrink: 0;
                }
                .mstep-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 5px 10px;
                    background: var(--bg-secondary);
                    cursor: pointer;
                    user-select: none;
                    min-height: 30px;
                    transition: background 0.12s;
                    min-width: 0;
                    overflow: hidden;
                }
                .mstep-header:hover { background: var(--bg-hover); }
                .mstep-header.expanded { background: var(--bg-tertiary); }
                .mstep-toggle {
                    font-size: 9px;
                    color: var(--text-tertiary);
                    width: 12px;
                    flex-shrink: 0;
                }
                .mstep-header.expanded .mstep-toggle { color: var(--accent); }
                .mstep-num {
                    font-size: 10.5px;
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
                    font-size: 11px;
                    color: var(--text-secondary);
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
                    color: var(--text-tertiary);
                }
                .mstep-summary.tool-status {
                    color: var(--accent);
                    font-family: var(--font-mono);
                    font-size: 10.5px;
                }
                .mstep-summary.error-status {
                    color: var(--warning);
                }
                .mstep-summary.confirm-status {
                    color: var(--info);
                    font-weight: 500;
                }
                .mstep-time {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    flex-shrink: 0;
                    white-space: nowrap;
                }

                /* ── CHAT button in step header ────────────────── */
                .mstep-chat-btn {
                    flex-shrink: 0;
                    padding: 2px 8px;
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    background: var(--bg-primary);
                    color: var(--accent);
                    font-size: 10px;
                    font-family: var(--font-mono);
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.12s, border-color 0.12s;
                    line-height: 1.5;
                }
                .mstep-chat-btn:hover {
                    background: var(--bg-hover);
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
                    background: var(--bg-primary);
                    border-top: 1px solid var(--border-light);
                }
                .mstep-body.open { display: flex; }

                /* ── Log Line Types ────────────────────────────── */
                .mlog {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    padding: 3px 6px;
                    border-radius: 4px;
                    font-size: 11.5px;
                    line-height: 1.45;
                    min-width: 0;
                }
                .mlog:hover { background: var(--bg-secondary); }
                .mlog-icon {
                    flex-shrink: 0;
                    font-size: 11px;
                    margin-top: 1px;
                    width: 14px;
                    text-align: center;
                }
                .mlog-body { flex: 1; min-width: 0; overflow: hidden; }

                /* Thought */
                .mlog-thought .mlog-body { color: var(--text-secondary); }
                .mlog-thought-summary {
                    color: var(--text-secondary);
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
                .mlog-thought-summary:hover { color: var(--text-primary); }
                .mlog-expand-btn {
                    font-size: 9px;
                    color: var(--text-tertiary);
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
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    font-size: 12px;
                    color: var(--text-secondary);
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
                    font-size: 10.5px;
                    font-weight: 700;
                    color: var(--accent);
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                }
                .thought-field-icon {
                    font-size: 13px;
                    line-height: 1;
                }
                .thought-field-content {
                    font-size: 12.5px;
                    line-height: 1.55;
                    white-space: pre-wrap;
                    word-break: break-word;
                    color: var(--text-primary);
                    padding: 6px 10px;
                    background: var(--bg-secondary);
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
                    background: var(--bg-primary);
                    border-radius: 4px;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                }
                .thought-empty {
                    color: var(--text-tertiary);
                    font-style: italic;
                    font-size: 11px;
                }
                .thought-raw {
                    margin: 0;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                /* Tool call */
                .mlog-tool .mlog-body { font-family: var(--font-mono); min-width: 0; }
                .mlog-tool-name { color: var(--accent); font-weight: 600; font-size: 11px; }
                .mlog-tool-args { color: var(--text-tertiary); font-size: 10.5px; }
                .mlog-tool-result {
                    display: none;
                    margin-top: 6px;
                    padding: 6px 10px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-left: 3px solid var(--accent);
                    border-radius: 4px;
                    font-size: 10.5px;
                    color: var(--text-secondary);
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
                    font-size: 10.5px;
                    color: var(--success);
                }

                /* File / Status rows */
                .mlog-file .mlog-body code,
                .mlog-cmd .mlog-body code {
                    font-size: 10.5px;
                    background: var(--bg-tertiary);
                    padding: 1px 5px;
                    border-radius: 3px;
                    color: var(--text-secondary);
                    word-break: break-all;
                }
                .mlog-read .mlog-icon { color: #339af0; }
                .mlog-write .mlog-icon { color: hsl(340,100%,65%); }
                .mlog-cmd .mlog-icon { color: var(--success); }
                .mlog-success { color: var(--success); }
                .mlog-error { color: var(--error); }
                .mlog-status { color: var(--text-tertiary); }

                /* Inline TOOL telemetry */
                .mlog-telemetry {
                    border: 1px solid var(--border-light);
                    border-radius: 5px;
                    overflow: hidden;
                }
                .mlog-tele-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    background: var(--bg-secondary);
                    cursor: pointer;
                    font-size: 11px;
                    font-family: var(--font-mono);
                }
                .mlog-tele-header:hover { background: var(--bg-hover); }
                .mlog-tele-method { font-weight: 700; color: var(--accent); font-size: 10.5px; }
                .mlog-tele-status-ok { color: var(--success); font-weight: 700; font-size: 10.5px; }
                .mlog-tele-status-err { color: var(--error); font-weight: 700; font-size: 10.5px; }
                .mlog-tele-dur { color: var(--text-tertiary); font-size: 10px; }
                .mlog-tele-usage { margin-left: auto; font-size: 10.5px; color: var(--text-secondary); }
                .mlog-tele-body {
                    display: none;
                    background: var(--bg-primary);
                    border-top: 1px solid var(--border-light);
                }
                .mlog-tele-body.open { display: block; }
                .mlog-tele-tabs {
                    display: flex;
                    gap: 1px;
                    padding: 4px 8px 0;
                    background: var(--bg-secondary);
                }
                .mlog-tele-tab {
                    padding: 2px 10px;
                    font-size: 10.5px;
                    border: none;
                    background: transparent;
                    color: var(--text-tertiary);
                    cursor: pointer;
                    border-radius: 3px 3px 0 0;
                    font-weight: 600;
                }
                .mlog-tele-tab.active { background: var(--bg-primary); color: var(--accent); }
                .mlog-tele-content pre {
                    margin: 0;
                    padding: 8px;
                    font-size: 10.5px;
                    font-family: var(--font-mono);
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    word-break: break-word;
                    max-height: 200px;
                    overflow-y: auto;
                    background: var(--bg-primary);
                }

                /* Confirm boxes */
                .mconfirm-box {
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    padding: 10px 12px;
                    background: var(--bg-secondary);
                    font-size: 12px;
                    margin: 2px 0;
                }
                .mconfirm-box h4 { margin: 0 0 6px; font-size: 12px; color: var(--text-primary); }
                .mconfirm-box pre { margin: 4px 0; font-size: 11px; background: var(--bg-tertiary); padding: 6px; border-radius: 4px; max-height: 120px; overflow-y: auto; }
                .mconfirm-actions { display: flex; gap: 8px; margin-top: 8px; }
                .mconfirm-risk {
                    font-size: 10.5px; font-weight: 700; color: #fff;
                    background: var(--error); border-radius: 4px; padding: 1px 7px; margin-left: 6px;
                }
                .mconfirm-autows {
                    display: flex; align-items: center; gap: 7px;
                    margin-top: 8px; font-size: 11.5px; color: var(--text-secondary); cursor: pointer;
                    user-select: none;
                }
                .mconfirm-autows input { cursor: pointer; }
                .mconfirm-manage { margin-top: 6px; }
                .mconfirm-manage .acm-open { font-size: 11px; color: var(--accent); cursor: pointer; text-decoration: none; }
                .mconfirm-manage .acm-open:hover { text-decoration: underline; }
                .acm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
                    background: var(--bg-tertiary); border: 1px solid var(--border-light); border-radius: 6px; padding: 5px 9px; }
                .acm-row code { font-size: 11.5px; color: var(--text-primary); word-break: break-all; }
                .acm-del { background: none; border: none; color: var(--error); cursor: pointer; font-size: 12px; flex-shrink: 0; }
                .acm-empty { font-size: 11.5px; color: var(--text-tertiary); padding: 4px 2px; }

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
                    box-shadow: 0 0 0 1px var(--accent-glow, rgba(90,150,255,0.25));
                }
                /* ask_user interactive answer card */
                .mresult-ask { flex-shrink: 0; padding: 8px 10px 0; }
                .mask-box {
                    border: 1px solid var(--accent);
                    border-radius: 8px; padding: 10px 12px;
                    background: var(--accent-glow, rgba(90,150,255,0.08));
                }
                .mask-q { font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
                .mask-opts { display: flex; flex-wrap: wrap; gap: 8px; }
                .mask-opts.is-multi { flex-direction: column; gap: 5px; }
                .mask-opt {
                    background: var(--bg-secondary); border: 1px solid var(--border-focus);
                    color: var(--text-primary); border-radius: 6px; padding: 6px 14px;
                    font-size: 12px; cursor: pointer; transition: background 0.12s, border-color 0.12s;
                }
                .mask-opt:hover { background: var(--accent); color: var(--text-inverse); border-color: var(--accent); }
                .mask-check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-primary); cursor: pointer; }
                .mask-actions { margin-top: 8px; }
                .mask-hint { margin-top: 8px; font-size: 10.5px; color: var(--text-tertiary); }

                /* Steering input */
                .msteering-wrapper {
                    display: flex;
                    flex-direction: column;
                    background: var(--bg-secondary);
                    border-top: 1px solid var(--border-light);
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
                    color: var(--text-secondary);
                    font-size: 16px;
                    cursor: pointer;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--radius-sm);
                    transition: background 0.15s, color 0.15s;
                    flex-shrink: 0;
                }
                .steer-btn-icon:hover { color: var(--text-primary); background: hsla(220, 20%, 30%, 0.5); }
                .steer-btn-icon:disabled { opacity: 0.5; cursor: not-allowed; }
                .msteering-wrapper textarea {
                    flex: 1;
                    background: var(--bg-input);
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    color: var(--text-primary);
                    font-family: var(--font-sans);
                    font-size: 12px;
                    padding: 7px 10px;
                    resize: none;
                    min-height: 36px;
                    max-height: 160px;
                    overflow-y: auto;
                    outline: none;
                    transition: border-color 0.15s;
                }
                .msteering-wrapper textarea:focus { border-color: var(--accent); }
                .msteering-wrapper textarea::placeholder { color: var(--text-tertiary); }
                .msteering-wrapper .btn-sm {
                    height: 36px;
                    padding: 0 16px;
                    font-size: 12px;
                    flex-shrink: 0;
                    align-self: flex-end;
                }
            `;
