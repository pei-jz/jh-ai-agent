// Extracted CSS for ChatView — kept as a template string so render()
// stays readable. Content is byte-identical to the former inline <style>.

export const CHAT_STYLES = `
                .chat-view-layout {
                    display: flex;
                    flex-direction: column;
                    height: calc(100vh - var(--titlebar-height) - 34px);
                    position: relative;
                }
                
                .chat-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--border);
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
                    font-size: 48px;
                    margin-bottom: 16px;
                    filter: drop-shadow(0 0 10px var(--accent-glow));
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
                    border-radius: 12px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    color: var(--text-primary);
                    position: relative;
                    max-width: 85%;
                }

                .msg-user .message-bubble {
                    background: var(--accent-glow-lg);
                    border-color: var(--border-focus);
                    border-bottom-right-radius: 2px;
                }

                .msg-ai .message-bubble {
                    background: var(--bg-secondary);
                    border-color: var(--border);
                    border-bottom-left-radius: 2px;
                }

                .message-content {
                    font-size: 13.5px;
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
                    background: var(--bg-tertiary);
                    padding: 6px 12px;
                    margin: 8px 0;
                    color: var(--text-secondary);
                    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
                }
                .message-content table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 12px 0;
                    font-size: 13px;
                }
                .message-content th, .message-content td {
                    border: 1px solid var(--border);
                    padding: 8px 10px;
                    text-align: left;
                }
                .message-content th {
                    background: var(--bg-tertiary);
                    font-weight: 600;
                    color: var(--accent);
                }
                .message-content tr:nth-child(even) {
                    background: hsla(220, 18%, 15%, 0.3);
                }

                .inline-code {
                    font-family: var(--font-mono);
                    font-size: 12px;
                    background: var(--bg-tertiary);
                    padding: 2px 5px;
                    border-radius: 4px;
                    color: var(--accent);
                }
                .code-block-wrapper {
                    margin: 10px 0;
                    border-radius: 6px;
                    overflow: hidden;
                    border: 1px solid var(--border);
                }
                .code-block-header {
                    background: var(--bg-input);
                    padding: 6px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--border);
                }
                .code-block-lang {
                    font-size: 11px;
                    font-family: var(--font-mono);
                    color: var(--text-secondary);
                    text-transform: uppercase;
                }
                .btn-copy-code {
                    background: transparent;
                    border: none;
                    color: var(--accent);
                    font-size: 11px;
                    cursor: pointer;
                    font-weight: 500;
                }
                .btn-copy-code:hover {
                    color: var(--accent-hover);
                }
                .code-block-wrapper pre {
                    margin: 0;
                    padding: 12px;
                    background: var(--bg-primary);
                    overflow-x: auto;
                }
                .code-block-wrapper code {
                    font-family: var(--font-mono);
                    font-size: 12.5px;
                    /* Token-based so it stays readable in BOTH themes (was #e6edf3,
                       which vanished on the light theme's near-white bg-primary). */
                    color: var(--text-primary);
                    line-height: 1.5;
                }

                .chat-system-prompt-container {
                    margin-bottom: 12px;
                    flex-shrink: 0;
                }

                .chat-system-prompt-toggle {
                    font-size: 12px;
                    color: var(--text-secondary);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    user-select: none;
                    width: fit-content;
                }

                .chat-system-prompt-toggle:hover {
                    color: var(--text-primary);
                }

                .chat-system-prompt-panel {
                    display: none;
                    margin-top: 6px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-md);
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
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-lg);
                    padding: 8px 12px;
                    flex-shrink: 0;
                    /* Anchor the slash popup (position:absolute; bottom:100%) so it
                       floats ABOVE the input, not below. Enforced in CSS (not only
                       the inline style) so nothing can knock it back to static. */
                    position: relative;
                }

                .chat-input-area-wrapper:focus-within {
                    border-color: var(--accent);
                    box-shadow: 0 0 0 3px var(--accent-glow);
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
                    color: var(--text-secondary);
                    font-size: 16px;
                    cursor: pointer;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--radius-sm);
                    transition: background var(--transition-fast), color var(--transition-fast);
                }

                .btn-chat-attach:hover {
                    color: var(--text-primary);
                    background: var(--bg-hover);
                }

                .chat-input-previews {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--border-light);
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
                    color: var(--text-primary);
                    border-radius: 999px;
                    padding: 3px 8px;
                    font-size: 11.5px;
                    font-weight: 500;
                    line-height: 1.4;
                }
                .skill-chip-icon { font-size: 11px; }
                .skill-chip-label {
                    max-width: 160px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .skill-chip-remove {
                    background: none;
                    border: none;
                    color: var(--text-tertiary);
                    cursor: pointer;
                    padding: 0 0 0 2px;
                    font-size: 11px;
                    line-height: 1;
                }
                .skill-chip-remove:hover { color: var(--error); }
                .skill-chip-static { background: hsla(265, 90%, 65%, 0.10); }

                .chat-preview-item {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: var(--radius-sm);
                    padding: 4px 24px 4px 8px;
                    font-size: 11px;
                    color: var(--text-secondary);
                    max-width: 180px;
                }

                .chat-preview-item.preview-image {
                    padding: 4px 24px 4px 4px;
                }

                .chat-jsonmode-toggle {
                    display: inline-flex; align-items: center; gap: 5px;
                    font-size: 11px; color: var(--text-tertiary); cursor: pointer;
                    user-select: none; white-space: nowrap;
                }
                .chat-jsonmode-toggle input { cursor: pointer; margin: 0; }

                .chat-preview-item img {
                    width: 32px;
                    height: 32px;
                    object-fit: cover;
                    border-radius: 4px;
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
                    font-size: 10px;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                }

                .chat-preview-item .btn-remove-preview:hover {
                    background: var(--error-bg);
                }

                /* Collapsible Thought Process Styling */
                .thought-process-block {
                    margin: 8px 0;
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-sm);
                    background: hsla(220, 20%, 6%, 0.5);
                    overflow: hidden;
                }

                .thought-process-block summary {
                    padding: 8px 12px;
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-secondary);
                    cursor: pointer;
                    user-select: none;
                    background: var(--bg-tertiary);
                    outline: none;
                }

                .thought-process-block summary:hover {
                    color: var(--text-primary);
                    background: var(--bg-hover);
                }

                .thought-process-content {
                    padding: 12px;
                    font-size: 12px;
                    line-height: 1.5;
                    color: var(--text-secondary);
                    font-family: var(--font-mono);
                    border-top: 1px solid var(--border-light);
                    white-space: pre-wrap;
                }

                .thought-process-streaming {
                    border-left: 2px solid var(--accent);
                }

                /* ── Mode pill toggle ── */
                .chat-mode-pills {
                    display: flex;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 3px;
                    gap: 2px;
                }
                .chat-mode-pill {
                    padding: 5px 14px;
                    border-radius: 6px;
                    border: none;
                    cursor: pointer;
                    font-size: 12.5px;
                    font-weight: 500;
                    transition: background var(--transition-fast), color var(--transition-fast);
                    background: transparent;
                    color: var(--text-secondary);
                    white-space: nowrap;
                }
                .chat-mode-pill.active {
                    background: var(--accent);
                    color: var(--text-inverse);
                }
                .chat-mode-pill:hover:not(.active) {
                    background: var(--bg-hover);
                    color: var(--text-primary);
                }

                /* ── Agent workspace bar ── */
                .agent-workspace-bar {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    background: var(--accent-glow-lg);
                    border: 1px solid var(--border-focus);
                    border-radius: var(--radius-md);
                    margin-bottom: 12px;
                    flex-shrink: 0;
                }
                .agent-workspace-bar label {
                    font-size: 11.5px;
                    color: var(--accent);
                    font-weight: 600;
                    white-space: nowrap;
                }

                .chat-textarea {
                    flex: 1;
                    background: transparent;
                    border: none;
                    outline: none;
                    color: var(--text-primary);
                    font-family: inherit;
                    font-size: 13.5px;
                    resize: none;
                    max-height: 150px;
                    height: 24px;
                    line-height: 1.5;
                    padding: 4px 0;
                    margin: 0;
                }

                .chat-textarea::placeholder {
                    color: var(--text-tertiary);
                }

                .btn-chat-send {
                    background: var(--accent);
                    color: var(--text-inverse);
                    border: none;
                    border-radius: var(--radius-md);
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
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-focus);
                    border-radius: var(--radius-md);
                    box-shadow: 0 -4px 20px rgba(0,0,0,0.35);
                    overflow: hidden;
                    z-index: 200;
                    max-height: 260px;
                    display: flex;
                    flex-direction: column;
                }
                .slash-popup-header {
                    padding: 6px 12px;
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--text-tertiary);
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    background: var(--bg-tertiary);
                    border-bottom: 1px solid var(--border-light);
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
                    font-size: 13px;
                }
                .slash-popup-item:hover,
                .slash-popup-item.selected {
                    background: var(--bg-hover);
                }
                .slash-popup-item.selected {
                    background: rgba(0,200,255,0.08);
                }
                .slash-popup-icon {
                    font-size: 16px;
                    flex-shrink: 0;
                }
                .slash-popup-key {
                    font-family: var(--font-mono);
                    font-size: 12px;
                    color: var(--accent);
                    font-weight: 600;
                    min-width: 80px;
                }
                .slash-popup-label {
                    color: var(--text-secondary);
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .slash-popup-type {
                    font-size: 10px;
                    color: var(--text-tertiary);
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-light);
                    border-radius: 3px;
                    padding: 1px 5px;
                    flex-shrink: 0;
                }
                .slash-popup-empty {
                    padding: 12px;
                    text-align: center;
                    font-size: 12px;
                    color: var(--text-tertiary);
                }

                /* ── Agent Step Display ── */
                .agent-steps-container {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    margin-bottom: 10px;
                }
                .agent-step-block {
                    border: 1px solid var(--border-light);
                    border-radius: 6px;
                    overflow: hidden;
                    background: var(--bg-tertiary);
                    font-size: 12px;
                }
                .agent-step-block > summary {
                    padding: 6px 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    user-select: none;
                    background: var(--bg-secondary);
                    outline: none;
                    list-style: none;
                }
                .agent-step-block > summary::-webkit-details-marker { display: none; }
                .agent-step-block > summary:hover { background: var(--bg-hover); }
                .agent-step-num {
                    font-size: 10px;
                    font-weight: 700;
                    background: var(--accent);
                    color: var(--text-inverse);
                    border-radius: 3px;
                    padding: 1px 5px;
                    flex-shrink: 0;
                }
                .agent-step-label {
                    color: var(--text-secondary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                }
                .agent-step-body {
                    padding: 8px 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    border-top: 1px solid var(--border-light);
                }
                .agent-thought-text {
                    font-size: 11.5px;
                    color: var(--text-secondary);
                    white-space: pre-wrap;
                    font-family: var(--font-mono);
                    max-height: 220px;
                    overflow-y: auto;
                    line-height: 1.5;
                }
                /* Structured OBSERVE / PLAN / CALL rows */
                .agent-opc {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .agent-opc-row {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    font-size: 11.5px;
                    line-height: 1.5;
                }
                .agent-opc-label {
                    font-size: 9.5px;
                    font-weight: 700;
                    letter-spacing: 0.05em;
                    border-radius: 3px;
                    padding: 2px 5px;
                    flex-shrink: 0;
                    margin-top: 1px;
                    text-transform: uppercase;
                }
                .agent-opc-label.observe { background: #1e3a2f; color: #4ade80; }
                .agent-opc-label.plan    { background: #1e2e45; color: #60a5fa; }
                .agent-opc-label.call    { background: #2e1e3a; color: #c084fc; }
                .agent-opc-text {
                    color: var(--text-primary);
                    flex: 1;
                    font-family: var(--font-mono);
                }
                .agent-tool-badge {
                    font-size: 11px;
                    background: var(--bg-primary);
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    padding: 2px 8px;
                    color: var(--accent);
                    font-family: var(--font-mono);
                    align-self: flex-start;
                }
                .agent-final-content {
                    border-top: 1px solid var(--border-light);
                    padding-top: 10px;
                    margin-top: 4px;
                }

                /* Pulsing generating effect */
                .generating-indicator {
                    display: flex;
                    padding: 10px 14px;
                    min-height: 60px;
                    align-items: center;
                    align-self: flex-start;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border);
                    border-radius: 12px;
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
            `;
