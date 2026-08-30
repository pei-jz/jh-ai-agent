// Styles for the `ask` conversation — the old Chat surface, kept.
//
// Was ChatView.styles.js. When Chat folded into Work as an interaction mode
// (docs/design/information-architecture.md §7 step 3) the first pass took the
// engine but not the look, and an answer came back wearing the task timeline's
// step-line chrome. What was wanted was the conversation surface itself:
// bubbles, one line per tool run, the details closed.
//
// So the stylesheet came back with the components. Only the export name and the
// radius/colour tokens changed (visual-language.md V1/V5); the rules are the
// ones the Chat view shipped with.

export const ASK_STYLES = `
                .chat-view-layout {
                    display: flex;
                    flex-direction: column;
                    /* 24px = .main-content's top+bottom padding (4 + 20). */
                    height: calc(100vh - var(--titlebar-height) - 24px);
                    position: relative;
                }
                
                .chat-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--line);
                    margin-bottom: 16px;
                    flex-shrink: 0;
                }

                .chat-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .chat-models-select {
                    min-width: 220px;
                }

                .chat-body {
                    flex: 1;
                    overflow-y: auto;
                    min-height: 200px;
                    padding-right: 8px;
                    margin-bottom: 16px;
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }

                .chat-empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    flex: 1;
                    opacity: 0.7;
                    padding: 40px;
                }

                .chat-empty-icon {
                    font-size: var(--fs-display);
                    margin-bottom: 16px;
                    filter: drop-shadow(0 0 10px var(--accent-surface));
                }

                .chat-message-row {
                    display: flex;
                    width: 100%;
                    animation: messageEnter 0.25s ease forwards;
                }

                @keyframes messageEnter {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .chat-message-row.msg-user {
                    justify-content: flex-end;
                }

                .chat-message-row.msg-ai {
                    justify-content: flex-start;
                }

                .message-bubble {
                    padding: 12px 16px;
                    border-radius: var(--r-3);
                    background: var(--surface-panel);
                    border: 1px solid var(--line);
                    color: var(--ink);
                    position: relative;
                    max-width: 85%;
                }

                .msg-user .message-bubble {
                    background: var(--accent-surface);
                    border-color: var(--line-focus);
                    border-bottom-right-radius: var(--r-1);
                }

                .msg-ai .message-bubble {
                    background: var(--surface-panel);
                    border-color: var(--line);
                    border-bottom-left-radius: var(--r-1);
                }

                .message-content {
                    font-size: var(--fs-md);
                    line-height: 1.6;
                    word-break: break-word;
                }

                /* Markdown Styles inside Chat */
                .message-content p {
                    margin-bottom: 8px;
                }
                .message-content p:last-child {
                    margin-bottom: 0;
                }
                .message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6 {
                    margin: 12px 0 6px 0;
                    color: var(--accent);
                }
                .message-content h1:first-child, .message-content h2:first-child, .message-content h3:first-child {
                    margin-top: 0;
                }
                .message-content ul, .message-content ol {
                    margin: 8px 0;
                    padding-left: 20px;
                }
                .message-content li {
                    margin-bottom: 4px;
                }
                .message-content blockquote {
                    border-left: 3px solid var(--accent);
                    background: var(--surface-sunken);
                    padding: 6px 12px;
                    margin: 8px 0;
                    color: var(--ink-soft);
                    border-radius: 0 var(--r-2) var(--r-2) 0;
                }
                .message-content table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 12px 0;
                    font-size: var(--fs-md);
                }
                .message-content th, .message-content td {
                    border: 1px solid var(--line);
                    padding: 8px 10px;
                    text-align: left;
                }
                .message-content th {
                    background: var(--surface-sunken);
                    font-weight: 600;
                    color: var(--accent);
                }
                .message-content tr:nth-child(even) {
                    background: hsla(220, 18%, 15%, 0.3);
                }

                .inline-code {
                    font-family: var(--font-mono);
                    font-size: var(--fs-sm);
                    background: var(--surface-sunken);
                    padding: 2px 5px;
                    border-radius: var(--r-2);
                    color: var(--accent);
                }
                .code-block-wrapper {
                    margin: 10px 0;
                    border-radius: var(--r-2);
                    overflow: hidden;
                    border: 1px solid var(--line);
                }
                .code-block-header {
                    background: var(--surface-input);
                    padding: 6px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--line);
                }
                .code-block-lang {
                    font-size: var(--fs-xs);
                    font-family: var(--font-mono);
                    color: var(--ink-soft);
                    text-transform: uppercase;
                }
                .btn-copy-code {
                    background: transparent;
                    border: none;
                    color: var(--accent);
                    font-size: var(--fs-xs);
                    cursor: pointer;
                    font-weight: 500;
                }
                .btn-copy-code:hover {
                    color: var(--accent-hover);
                }
                .code-block-wrapper pre {
                    margin: 0;
                    padding: 12px;
                    background: var(--surface-app);
                    overflow-x: auto;
                }
                .code-block-wrapper code {
                    font-family: var(--font-mono);
                    font-size: var(--fs-sm);
                    /* Token-based so it stays readable in BOTH themes (was #e6edf3,
                       which vanished on the light theme's near-white bg-primary). */
                    color: var(--ink);
                    line-height: 1.5;
                }

                .chat-system-prompt-container {
                    margin-bottom: 12px;
                    flex-shrink: 0;
                }

                .chat-system-prompt-toggle {
                    font-size: var(--fs-sm);
                    color: var(--ink-soft);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    user-select: none;
                    width: fit-content;
                }

                .chat-system-prompt-toggle:hover {
                    color: var(--ink);
                }

                .chat-system-prompt-panel {
                    display: none;
                    margin-top: 6px;
                    background: var(--surface-panel);
                    border: 1px solid var(--line);
                    border-radius: var(--r-3);
                    padding: 12px;
                    animation: slideDown var(--transition-fast) forwards;
                }

                @keyframes slideDown {
                    from { opacity: 0; transform: translateY(-4px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .chat-input-area-wrapper {
                    display: flex;
                    flex-direction: column;
                    background: var(--surface-panel);
                    border: 1px solid var(--line);
                    border-radius: var(--r-3);
                    padding: 8px 12px;
                    flex-shrink: 0;
                    /* Anchor the slash popup (position:absolute; bottom:100%) so it
                       floats ABOVE the input, not below. Enforced in CSS (not only
                       the inline style) so nothing can knock it back to static. */
                    position: relative;
                }

                .chat-input-area-wrapper:focus-within {
                    border-color: var(--accent);
                    box-shadow: 0 0 0 3px var(--accent-surface);
                }

                .chat-input-container {
                    display: flex;
                    gap: 12px;
                    align-items: flex-end;
                    background: transparent;
                    border: none;
                    padding: 0;
                    width: 100%;
                }

                .btn-chat-attach {
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
                    transition: background var(--transition-fast), color var(--transition-fast);
                }

                .btn-chat-attach:hover {
                    color: var(--ink);
                    background: var(--surface-hover);
                }

                .chat-input-previews {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--line-soft);
                }

                /* ── Active-skill chips ── */
                .chat-input-skills {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 8px;
                }
                .skill-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    background: hsla(265, 90%, 65%, 0.12);
                    border: 1px solid hsla(265, 90%, 65%, 0.45);
                    color: var(--ink);
                    border-radius: var(--r-pill);
                    padding: 3px 8px;
                    font-size: var(--fs-xs);
                    font-weight: 500;
                    line-height: 1.4;
                }
                .skill-chip-icon { font-size: var(--fs-xs); }
                .skill-chip-label {
                    max-width: 160px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .skill-chip-remove {
                    background: none;
                    border: none;
                    color: var(--ink-faint);
                    cursor: pointer;
                    padding: 0 0 0 2px;
                    font-size: var(--fs-xs);
                    line-height: 1;
                }
                .skill-chip-remove:hover { color: var(--error); }
                .skill-chip-static { background: hsla(265, 90%, 65%, 0.10); }

                .chat-preview-item {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: var(--surface-sunken);
                    border: 1px solid var(--line);
                    border-radius: var(--r-2);
                    padding: 4px 24px 4px 8px;
                    font-size: var(--fs-xs);
                    color: var(--ink-soft);
                    max-width: 180px;
                }

                .chat-preview-item.preview-image {
                    padding: 4px 24px 4px 4px;
                }

                .chat-jsonmode-toggle {
                    display: inline-flex; align-items: center; gap: 5px;
                    font-size: var(--fs-xs); color: var(--ink-faint); cursor: pointer;
                    user-select: none; white-space: nowrap;
                }
                .chat-jsonmode-toggle input { cursor: pointer; margin: 0; }

                .chat-preview-item img {
                    width: 32px;
                    height: 32px;
                    object-fit: cover;
                    border-radius: var(--r-2);
                }

                .chat-preview-item .file-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 110px;
                }

                .chat-preview-item .btn-remove-preview {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    background: transparent;
                    border: none;
                    color: var(--error);
                    cursor: pointer;
                    font-size: var(--fs-2xs);
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                }

                .chat-preview-item .btn-remove-preview:hover {
                    background: var(--error-surface);
                }

                /* Collapsible Thought Process Styling */
                .thought-process-block {
                    margin: 8px 0;
                    border: 1px solid var(--line-soft);
                    border-radius: var(--r-2);
                    background: hsla(220, 20%, 6%, 0.5);
                    overflow: hidden;
                }

                .thought-process-block summary {
                    padding: 8px 12px;
                    font-size: var(--fs-sm);
                    font-weight: 600;
                    color: var(--ink-soft);
                    cursor: pointer;
                    user-select: none;
                    background: var(--surface-sunken);
                    outline: none;
                }

                .thought-process-block summary:hover {
                    color: var(--ink);
                    background: var(--surface-hover);
                }

                .thought-process-content {
                    padding: 12px;
                    font-size: var(--fs-sm);
                    line-height: 1.5;
                    color: var(--ink-soft);
                    font-family: var(--font-mono);
                    border-top: 1px solid var(--line-soft);
                    white-space: pre-wrap;
                }

                .thought-process-streaming {
                    border-left: 2px solid var(--accent);
                }

                /* ── Mode pill toggle ── */
                .chat-mode-pill.active {
                    background: var(--accent);
                    color: var(--on-accent);
                }
                .chat-mode-pill:hover:not(.active) {
                    background: var(--surface-hover);
                    color: var(--ink);
                }

                /* ── Agent workspace bar ── */

                .chat-textarea {
                    flex: 1;
                    background: transparent;
                    border: none;
                    outline: none;
                    color: var(--ink);
                    font-family: inherit;
                    font-size: var(--fs-md);
                    resize: none;
                    max-height: 150px;
                    height: 24px;
                    line-height: 1.5;
                    padding: 4px 0;
                    margin: 0;
                }

                .chat-textarea::placeholder {
                    color: var(--ink-faint);
                }

                .btn-chat-send {
                    background: var(--accent);
                    color: var(--on-accent);
                    border: none;
                    border-radius: var(--r-3);
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: background var(--transition-fast), transform var(--transition-fast);
                }

                .btn-chat-send:hover {
                    background: var(--accent-hover);
                }

                .btn-chat-send:active {
                    transform: scale(0.95);
                }

                .btn-chat-send.btn-stop {
                    background: var(--error);
                }

                .btn-chat-send.btn-stop:hover {
                    background: hsl(0, 75%, 60%);
                }

                /* ── Slash command popup ── */
                .slash-popup {
                    position: absolute;
                    /* Reset the GLOBAL .slash-popup rule in main.js (top:100% → below).
                       Without this, top AND bottom are both set and the popup stretches
                       into an impossible region → collapses to a 2px sliver BELOW the
                       input (hidden). We want it floating ABOVE the input. */
                    top: auto;
                    bottom: calc(100% + 6px);
                    left: 0;
                    right: 0;
                    background: var(--surface-panel);
                    border: 1px solid var(--line-focus);
                    border-radius: var(--r-3);
                    box-shadow: 0 -4px 20px rgba(0,0,0,0.35);
                    overflow: hidden;
                    z-index: 200;
                    max-height: 260px;
                    display: flex;
                    flex-direction: column;
                }
                .slash-popup-header {
                    padding: 6px 12px;
                    font-size: var(--fs-xs);
                    font-weight: 600;
                    color: var(--ink-faint);
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    background: var(--surface-sunken);
                    border-bottom: 1px solid var(--line-soft);
                    flex-shrink: 0;
                }
                .slash-popup-list {
                    overflow-y: auto;
                    flex: 1;
                }
                .slash-popup-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 8px 12px;
                    cursor: pointer;
                    transition: background var(--transition-fast);
                    font-size: var(--fs-md);
                }
                .slash-popup-item:hover,
                .slash-popup-item.selected {
                    background: var(--surface-hover);
                }
                .slash-popup-item.selected {
                    background: rgba(0,200,255,0.08);
                }
                .slash-popup-icon {
                    font-size: var(--fs-lg);
                    flex-shrink: 0;
                }
                .slash-popup-key {
                    font-family: var(--font-mono);
                    font-size: var(--fs-sm);
                    color: var(--accent);
                    font-weight: 600;
                    min-width: 80px;
                }
                .slash-popup-label {
                    color: var(--ink-soft);
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .slash-popup-type {
                    font-size: var(--fs-2xs);
                    color: var(--ink-faint);
                    background: var(--surface-sunken);
                    border: 1px solid var(--line-soft);
                    border-radius: var(--r-1);
                    padding: 1px 5px;
                    flex-shrink: 0;
                }
                .slash-popup-empty {
                    padding: 12px;
                    text-align: center;
                    font-size: var(--fs-sm);
                    color: var(--ink-faint);
                }

                /* ── Agent Step Display ── */
                /* Structured OBSERVE / PLAN / CALL rows */
                .agent-opc-label.observe { background: #1e3a2f; color: #4ade80; }
                .agent-opc-label.plan    { background: #1e2e45; color: #60a5fa; }
                .agent-opc-label.call    { background: #2e1e3a; color: #c084fc; }

                /* Pulsing generating effect */
                .generating-indicator {
                    display: flex;
                    padding: 10px 14px;
                    min-height: 60px;
                    align-items: center;
                    align-self: flex-start;
                    background: var(--surface-panel);
                    border: 1px solid var(--line);
                    border-radius: var(--r-3);
                    animation: messageEnter 0.2s ease forwards;
                    max-width: 85%;
                }

                .generating-dot {
                    width: 6px;
                    height: 6px;
                    background: var(--accent);
                    border-radius: 50%;
                    animation: pulseDot 1.4s infinite ease-in-out both;
                }

                .generating-dot:nth-child(1) { animation-delay: -0.32s; }
                .generating-dot:nth-child(2) { animation-delay: -0.16s; }

                @keyframes pulseDot {
                    0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
                    40% { transform: scale(1); opacity: 1; }
                }

                /* ── Message bubbles (migrated to Svelte) ─────────────────────
                   These replace inline style="…" attributes that the string
                   renderer wrote out once per message, and once more per
                   attachment inside it. Same appearance, one definition. */
                .chat-row-full { width: 100%; }
                .message-bubble.is-error {
                    border-style: solid; border-color: var(--error); background: var(--error-surface);
                }
                .message-content.is-error { color: var(--error); font-weight: 500; }

                /* A tool call / result reads as one quiet line beside a rule. */
                .chat-tool-activity {
                    display: flex; flex-direction: column; gap: 0;
                    font-size: 12.5px; color: var(--ink-soft);
                    background: transparent;
                    border-left: 2px solid var(--accent);
                    padding: 2px 0 2px 10px; margin: 2px 0;
                }
                .chat-tool-head { display: flex; align-items: center; gap: 7px; }
                .chat-tool-spinner { opacity: 0.85; }
                .chat-tool-names {
                    font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-faint);
                }
                .chat-tool-details { outline: none; margin-top: 2px; }
                .chat-tool-details > summary,
                .chat-tool-activity details > summary {
                    cursor: pointer; user-select: none; list-style: none;
                    font-size: 11px; color: var(--ink-faint);
                }
                .chat-tool-activity details > summary::-webkit-details-marker { display: none; }
                .chat-tool-arg { margin-top: 6px; }
                .chat-tool-arg-name {
                    font-family: var(--font-mono); font-size: 11.5px; font-weight: 600;
                    color: var(--ink-soft);
                }
                .chat-tool-activity pre {
                    margin: 3px 0 0 0; background: var(--surface-app); padding: 6px;
                    border-radius: var(--r-2); overflow-x: auto;
                    font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint);
                    white-space: pre-wrap; max-height: 220px; overflow-y: auto;
                }
                /* A RESULT is quieter than a call — until it fails, at which point it
                   has to stay noticeable: a folded-away failed lookup is how a wrong
                   answer gets trusted. */
                .chat-tool-result {
                    color: var(--ink-faint); border-left-color: var(--line);
                    margin: 2px 0 6px;
                }
                .chat-tool-result.is-error { color: var(--error); border-left-color: var(--error); }
                .chat-tool-res {
                    border-top: 1px solid var(--line-soft); padding-top: 6px; margin-top: 6px;
                }
                .chat-tool-res-name {
                    font-size: 11px; font-weight: 600; color: var(--ink-faint); margin-bottom: 3px;
                }
                .chat-tool-res-name.is-error { color: var(--error); }
                .chat-tool-activity pre.is-error { color: var(--error); }

                /* Attachments inside a bubble. */
                .chat-bubble-images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
                .chat-zoomable-img {
                    max-height: 180px; max-width: 100%; border-radius: var(--r-2);
                    border: 1px solid var(--line); cursor: pointer;
                }
                .chat-bubble-files { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
                .chat-file-chip {
                    display: flex; align-items: center; gap: 8px;
                    background: var(--surface-sunken); border: 1px solid var(--line);
                    padding: 6px 12px; border-radius: var(--r-2); font-size: 12px; width: fit-content;
                }
                .chat-file-name { font-weight: 500; }
                .chat-file-size { color: var(--ink-faint); font-size: 11px; }
                .chat-bubble-skills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

                /* A transient notice — a prop now, so it cannot outlive its turn. */
                .chat-notice {
                    border-color: var(--warning, #f59e0b);
                    background: hsla(38, 92%, 50%, 0.07);
                    max-width: 90%;
                }
                .chat-notice-content { color: var(--warning, #f59e0b); font-size: 13px; }
            `;
