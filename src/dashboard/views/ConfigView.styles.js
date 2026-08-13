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
                        font-size: var(--fs-sm); font-weight: 600;
                        color: var(--accent);
                        text-transform: uppercase; letter-spacing: 0.06em;
                    }
                    .cfg-sec > summary::-webkit-details-marker { display: none; }
                    .cfg-sec > summary:hover { background: var(--bg-tertiary); border-radius: var(--radius-md); }
                    .cfg-sec-chev { margin-left: auto; color: var(--text-tertiary); transition: transform 0.15s; }
                    .cfg-sec:not([open]) .cfg-sec-chev { transform: rotate(-90deg); }
                    .cfg-sec-body { padding: 4px 16px 14px; }
                    .cfg-sec-hint { font-size: var(--fs-xs); color: var(--text-tertiary); margin: 0 0 14px 0; line-height: 1.5; }
                    .cfg-cmd-row {
                        display: flex; align-items: center; gap: 8px;
                        padding: 4px 10px; margin-bottom: 4px;
                        border: 1px solid var(--border-light); border-radius: 5px;
                        font-size: var(--fs-sm); background: var(--bg-primary);
                    }
                    .cfg-cmd-row code {
                        flex: 1; font-family: var(--font-mono, monospace);
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        color: var(--text-primary);
                    }
                    .cfg-cmd-del {
                        background: none; border: none; cursor: pointer;
                        color: var(--text-tertiary); font-size: var(--fs-md); padding: 2px 4px;
                    }
                    .cfg-cmd-del:hover { color: var(--error); }
                    .cfg-cmd-empty { color: var(--text-tertiary); font-size: var(--fs-sm); padding: 2px 0 8px; }
                    .cfg-cmd-add { display: flex; gap: 8px; margin-top: 6px; }

                    /* ── General tab (migrated to Svelte) ─────────────────────
                       These replace inline style="…" attributes that were written
                       once per control inside a 260-line template literal. */
                    .cfg-mono-input, .cfg-mono-area, .cfg-path-area, .cfg-token {
                        font-family: var(--font-mono, monospace);
                    }
                    .cfg-mono-input { flex: 1; font-size: var(--fs-xs); }
                    .cfg-mono-area { font-size: var(--fs-sm); }
                    .cfg-path-area { font-size: var(--fs-xs); resize: vertical; }
                    .cfg-token { background: var(--bg-primary); cursor: default; }
                    .cfg-group-gap { margin-bottom: 12px; }
                    .cfg-group-top { margin-top: 14px; }
                    .cfg-group-top-sm { margin-top: 8px; }
                    .cfg-hint-tight { margin-top: 0; }
                    .cfg-hint-spaced { margin-top: 8px; }
                    /* Licence status line. Tone comes from licenseState.describeLicense. */
                    .cfg-lic-title {
                        margin: 0 0 2px; font-size: var(--fs-sm); font-weight: 600;
                        color: var(--text-primary);
                    }
                    .cfg-lic-title.is-warn { color: var(--warning, #f59e0b); }
                    .cfg-lic-title.is-error { color: var(--error, #ef4444); }
                    .cfg-lic-clear {
                        margin-top: 8px; background: none; border: 0; padding: 0;
                        cursor: pointer; text-decoration: underline;
                        color: var(--text-tertiary); font-size: var(--fs-2xs);
                    }
                    .cfg-lic-clear:hover { color: var(--text-secondary); }
                    .cfg-link { color: var(--accent); }
                    .cfg-row-inline { display: flex; gap: 8px; }
                    .cfg-grow { flex: 1; }
                    .cfg-nowrap { white-space: nowrap; }
                    .cfg-btn-pick {
                        padding: 0 12px; height: 36px;
                        display: flex; align-items: center; justify-content: center;
                        border: 1px solid var(--border);
                    }
                    .cfg-btn-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
                    .cfg-btn-sm { font-size: var(--fs-xs); }
                    .cfg-btn-danger { color: var(--error); border-color: var(--error); }
                    .cfg-storage {
                        font-size: var(--fs-xs); color: var(--text-secondary);
                        background: var(--bg-secondary); border: 1px solid var(--border);
                        border-radius: var(--radius-sm); padding: 12px; line-height: 1.7;
                    }
                    .cfg-muted { color: var(--text-tertiary); }
                    .cfg-ok { color: var(--success); }
                    .cfg-err { color: var(--error); }
                    .cfg-export-box {
                        margin-top: 14px; padding: 12px;
                        background: var(--bg-secondary); border: 1px solid var(--border);
                        border-radius: var(--radius-sm);
                    }
                    .cfg-export-head {
                        display: flex; justify-content: space-between; align-items: center; gap: 12px;
                    }
                    .cfg-export-title { font-size: var(--fs-sm); color: var(--text-primary); }
                    .cfg-export-status { margin-top: 8px; font-size: var(--fs-xs); }

                    /* ── Phase routing: the tier map + savings estimate ──────
                       Boxed and accent-tinted so the number reads as a RESULT of
                       the two tier selects above it, not as another field. */
                    .cfg-phase-box {
                        margin-top: 10px; padding: 10px 12px;
                        background: var(--accent-glow); border: 1px solid var(--accent-dim);
                        border-radius: var(--radius-sm);
                    }
                    .cfg-phase-map {
                        margin: 0; font-size: var(--fs-xs); color: var(--text-secondary);
                        line-height: 1.6;
                    }
                    .cfg-phase-save {
                        margin: 6px 0 0; font-size: var(--fs-xs); color: var(--text-primary);
                        line-height: 1.6;
                    }
                    .cfg-phase-warn { color: var(--warning, #f59e0b); margin-top: 6px; }

                    /* ── Templates / Skills / RAG / Memory tabs (migrated) ──── */
                    .cfg-tab-card { height: 100%; display: flex; flex-direction: column; }
                    .cfg-tab-head {
                        display: flex; justify-content: space-between; align-items: center;
                        margin-bottom: 16px; flex-shrink: 0;
                    }
                    .cfg-tab-head-plain { margin-bottom: 20px; }
                    .cfg-tab-body { flex: 1; overflow-y: auto; }
                    .cfg-gap-12 { gap: 12px; }
                    .cfg-req { color: var(--error); }
                    .cfg-readonly { background: var(--bg-primary); cursor: not-allowed; }
                    .cfg-icon-input { width: 80px; }
                    /* The inline add/edit form both list tabs open above their table. */
                    .cfg-inline-form {
                        background: var(--bg-tertiary); border: 1px solid var(--border-focus);
                        border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px;
                    }
                    .cfg-inline-form-h {
                        margin: 0 0 14px 0; font-size: var(--fs-sm); color: var(--accent);
                    }
                    .cfg-form-actions {
                        display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;
                    }
                    .cfg-empty { padding: 32px; text-align: center; color: var(--text-secondary); }
                    .cfg-empty-ic { font-size: var(--fs-display); display: block; margin-bottom: 12px; }
                    .cfg-col-icon { width: 40px; text-align: center; }
                    .cfg-col-acts { width: 160px; text-align: right; }
                    .cfg-emoji { font-size: var(--fs-lg); }
                    .cfg-cmd { font-family: var(--font-mono); color: var(--accent); }
                    .cfg-prompt-preview {
                        color: var(--text-secondary); max-width: 280px;
                        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                    }
                    .cfg-btn-tiny { padding: 2px 8px; font-size: var(--fs-xs); }

                    /* RAG picker. The dimming of an excluded row was an inline
                       opacity written by a DOM walk; it is a class now. */
                    .cfg-rag-dirs {
                        max-height: 200px; overflow-y: auto;
                        background: var(--bg-secondary); padding: 10px;
                        border: 1px solid var(--border); border-radius: 6px;
                        display: flex; flex-direction: column;
                    }
                    .cfg-rag-dir {
                        display: flex; align-items: center; gap: 8px;
                        font-size: var(--fs-sm); cursor: pointer; margin-bottom: 4px;
                    }
                    .cfg-rag-dir.is-excluded { opacity: 0.5; }
                    .cfg-rag-hint { font-size: var(--fs-sm); color: var(--text-secondary); }
                    .cfg-rag-exts {
                        display: flex; flex-wrap: wrap; gap: 8px;
                        background: var(--bg-secondary); padding: 10px;
                        border: 1px solid var(--border); border-radius: 6px;
                    }
                    .cfg-rag-ext {
                        display: flex; align-items: center; gap: 6px;
                        font-size: var(--fs-sm); cursor: pointer;
                        background: var(--bg-primary); padding: 4px 8px;
                        border: 1px solid var(--border); border-radius: 4px;
                    }
                    .cfg-rag-bar {
                        margin-top: 8px; height: 6px; background: var(--bg-tertiary);
                        border-radius: 4px; overflow: hidden;
                    }
                    .cfg-rag-bar > div {
                        height: 100%; background: var(--accent); transition: width 0.3s;
                    }
                    .cfg-rag-start { display: flex; align-items: center; gap: 12px; margin-top: 8px; }

                    /* Memory tab. */
                    .cfg-mem-hint { color: var(--text-tertiary); font-size: var(--fs-sm); padding: 14px 0; }
                    /* The study control sits under the workspace row: it acts ON
                       that workspace, so it belongs with it rather than in the
                       lists it fills. */
                    .cfg-mem-study {
                        display: flex; align-items: center; gap: 10px; margin-top: 8px;
                    }
                    .cfg-mem-study .cfg-hint { margin: 0; font-size: var(--fs-xs); }
                    .cfg-mem-box {
                        margin-top: 8px; padding: 14px 16px;
                        border: 1px solid var(--border); border-radius: var(--radius-md);
                        background: var(--bg-secondary);
                    }
                    .cfg-mem-head {
                        display: flex; justify-content: space-between; align-items: center;
                        margin-bottom: 8px; gap: 12px;
                    }
                    .cfg-mem-title {
                        font-size: var(--fs-xs); font-weight: 600; color: var(--accent);
                        text-transform: uppercase; letter-spacing: 0.06em;
                    }
                    .cfg-mem-empty { color: var(--text-tertiary); font-size: var(--fs-xs); }
                    .cfg-mem-scroll { max-height: 320px; overflow: auto; }
                    /* The cell borders/padding used to be inherited from .rv-table,
                       whose stylesheet is injected lazily by the Chat/Monitor views —
                       so the table was unstyled until one of those had rendered. */
                    .cfg-mem-table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
                    .cfg-mem-table th, .cfg-mem-table td {
                        border: 1px solid var(--border); padding: 6px 8px;
                        text-align: left; vertical-align: top;
                    }
                    .cfg-mem-table th {
                        background: var(--bg-tertiary); color: var(--text-secondary); font-weight: 600;
                    }
                    .cfg-mem-th { text-align: left; padding: 4px 8px; }
                    .cfg-mem-fact {
                        font-size: var(--fs-xs); line-height: 1.5;
                        overflow-wrap: anywhere; word-break: break-word;
                    }
                    .cfg-mem-meta {
                        white-space: nowrap; font-size: var(--fs-2xs); color: var(--text-tertiary);
                    }
                    .cfg-mem-hits { text-align: center; font-size: var(--fs-2xs); }
                    .cfg-mem-acts { white-space: nowrap; text-align: right; }
                    .cfg-mem-summary {
                        color: var(--text-secondary); font-size: var(--fs-2xs); margin-top: 2px;
                    }
                    .cfg-mem-edit { font-size: var(--fs-xs); }
                    /* Experience cards: which layer / polarity a row is. */
                    .cfg-mem-badge {
                        display: inline-block; margin-right: 6px; padding: 0 6px;
                        border-radius: 999px; font-size: var(--fs-2xs); font-weight: 600;
                        border: 1px solid var(--border); color: var(--text-secondary);
                        text-transform: uppercase; letter-spacing: 0.04em;
                    }
                    .cfg-mem-badge.is-lesson { color: var(--warning, #f59e0b); border-color: currentColor; }
                    .cfg-mem-badge.is-insight,
                    .cfg-mem-badge.is-where { color: var(--success, #22c55e); border-color: currentColor; }
                    .cfg-mem-badge.is-episodic { color: var(--text-tertiary); }
                    .cfg-mem-badge.is-semantic { color: var(--accent); border-color: currentColor; }
                    /* A switched-off card is kept (it may be re-enabled) but reads as inert. */
                    tr.is-off { opacity: 0.45; }
                    .cfg-mem-toggle { display: inline-flex; align-items: center; cursor: pointer; }
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

                /* ── LLM connection table + modal (migrated to Svelte) ────────
                   These replace inline style="…" attributes that were repeated on
                   every row of a template literal. Same appearance, one definition.
                   Kept here rather than in the components' own <style> blocks while
                   the surrounding tab is still vanilla markup — see
                   docs/design/svelte-migration.md §5 on CSS ownership. */
                .cfg-col-default { width: 70px; text-align: center; }
                .cfg-col-actions { width: 180px; text-align: right; }
                .cfg-table-empty {
                    text-align: center; padding: 32px; color: var(--text-secondary);
                }
                /* The row the agent will actually use. */
                tr.is-active { background: rgba(0, 200, 255, 0.04); }
                .cfg-provider-ic { margin-right: 8px; }
                /* An unknown provider id: a typo used to look like a real provider. */
                .cfg-provider.is-unknown { color: var(--warning); }
                /* Checkbox + label on one line, both clickable. */
                .cfg-check {
                    display: flex; align-items: center; gap: 8px;
                    cursor: pointer; font-size: var(--fs-sm); color: var(--text-primary);
                }
                .cfg-inst-name { font-weight: 600; }
                .cfg-active-tag {
                    color: var(--accent); font-size: 10px; font-weight: 600; margin-left: 6px;
                }
                .cfg-model {
                    font-family: var(--font-mono); font-size: 11px;
                    background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;
                }
                .cfg-base-url {
                    color: var(--text-secondary); max-width: 220px;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                .cfg-row-actions {
                    display: flex; gap: 8px; justify-content: flex-end; align-items: center;
                }
                .active-llm-radio { cursor: pointer; accent-color: var(--accent); }

                .cfg-modal { width: 500px; max-width: 90%; }
                .cfg-modal .modal-title { margin-bottom: 20px; }
                .cfg-hint {
                    color: var(--text-secondary); font-size: 11px; margin-top: 4px; display: block;
                }
                .cfg-price-row { display: flex; gap: 8px; }
                /* Every validation problem at once. Refusing to save while saying
                   nothing about which field was wrong was the old behaviour. */
                .cfg-modal-errors {
                    margin-top: 12px; padding: 8px 12px; border-radius: var(--radius-sm);
                    background: rgba(244, 67, 54, 0.1); color: var(--error);
                    font-size: 12px; font-weight: 500; line-height: 1.6;
                }
                .cfg-test-status {
                    margin-top: 12px; font-size: 12px; padding: 8px 12px;
                    border-radius: var(--radius-sm); font-weight: 500;
                    background: var(--bg-tertiary); color: var(--text-secondary);
                }
                .cfg-test-status.is-ok { background: rgba(76, 175, 80, 0.1); color: var(--success); }
                .cfg-test-status.is-fail { background: rgba(244, 67, 54, 0.1); color: var(--error); }
                .cfg-modal-actions {
                    margin-top: 20px; display: flex; justify-content: space-between; gap: 8px;
                }
                .cfg-modal-confirm { display: flex; gap: 8px; }
                .cfg-btn-test {
                    background: transparent; border: 1px solid var(--border);
                    color: var(--text-secondary); width: auto;
                }
            `;

