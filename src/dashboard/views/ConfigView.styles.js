// Extracted CSS for ConfigView — byte-identical to the former inline
// <style> blocks (section list + modal). Kept as template strings.

export const CONFIG_SECTION_STYLES = `
                    .cfg-sec {
                        border: 1px solid var(--border);
                        border-radius: var(--radius-md);
                        background: var(--bg-secondary);
                        margin-bottom: 10px;
                    }
                    .cfg-sec > summary {
                        list-style: none;
                        cursor: pointer; user-select: none;
                        display: flex; align-items: center; gap: 7px;
                        padding: 11px 14px;
                        font-size: 12px; font-weight: 600;
                        color: var(--accent);
                        text-transform: uppercase; letter-spacing: 0.06em;
                    }
                    .cfg-sec > summary::-webkit-details-marker { display: none; }
                    .cfg-sec > summary:hover { background: var(--bg-tertiary); border-radius: var(--radius-md); }
                    .cfg-sec-chev { margin-left: auto; color: var(--text-tertiary); transition: transform 0.15s; }
                    .cfg-sec:not([open]) .cfg-sec-chev { transform: rotate(-90deg); }
                    .cfg-sec-body { padding: 4px 16px 14px; }
                    .cfg-sec-hint { font-size: 11.5px; color: var(--text-tertiary); margin: 0 0 14px 0; line-height: 1.5; }
                    .cfg-cmd-row {
                        display: flex; align-items: center; gap: 8px;
                        padding: 4px 10px; margin-bottom: 4px;
                        border: 1px solid var(--border-light); border-radius: 5px;
                        font-size: 12px; background: var(--bg-primary);
                    }
                    .cfg-cmd-row code {
                        flex: 1; font-family: var(--font-mono, monospace);
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        color: var(--text-primary);
                    }
                    .cfg-cmd-del {
                        background: none; border: none; cursor: pointer;
                        color: var(--text-tertiary); font-size: 13px; padding: 2px 4px;
                    }
                    .cfg-cmd-del:hover { color: var(--error); }
                    .cfg-cmd-empty { color: var(--text-tertiary); font-size: 12px; padding: 2px 0 8px; }
                `;

export const CONFIG_MODAL_STYLES = `
                .settings-tab-btn:hover {
                    color: var(--text-primary) !important;
                    background: var(--bg-hover) !important;
                }
                .settings-tab-btn.active:hover {
                    color: var(--accent) !important;
                    background: var(--bg-tertiary) !important;
                }
            `;

