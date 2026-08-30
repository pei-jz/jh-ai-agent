// Styles for the first-run wizard.
//
// Kept in its own module (not a component <style>) for the same reason the rest of the
// dashboard's CSS is: the wizard reuses .input / .btn / .cfg-modal-errors from the
// global sheet, and a scoped block cannot reach those. When the shell stops being
// vanilla this can move into the component.
export const ONBOARDING_STYLES = `
    .ob-overlay {
        position: fixed; inset: 0; z-index: 9000;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.55);
    }
    .ob-panel {
        width: 620px; max-width: 100%; max-height: 90vh; overflow-y: auto;
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-3);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
        padding: 22px 24px;
    }
    .ob-head { display: flex; align-items: flex-start; gap: 16px; }
    .ob-title { flex: 1; min-width: 0; }
    .ob-title h2 { margin: 0 0 6px; font-size: var(--fs-xl); color: var(--ink); }
    .ob-title p { margin: 0; font-size: var(--fs-sm); color: var(--ink-soft); line-height: 1.6; }
    /* Always reachable, and quiet: an escape hatch, not a call to action. */
    .ob-skip {
        flex-shrink: 0; background: none; border: 0; cursor: pointer;
        color: var(--ink-faint); font-size: var(--fs-xs); text-decoration: underline;
        padding: 2px 0;
    }
    .ob-skip:hover { color: var(--ink-soft); }

    .ob-rail {
        display: flex; gap: 8px; margin: 18px 0 0; padding: 0; list-style: none;
    }
    .ob-rail-item {
        flex: 1; display: flex; align-items: center; gap: 7px;
        padding: 7px 10px; border-radius: var(--r-2);
        background: var(--surface-sunken); border: 1px solid var(--line);
        font-size: var(--fs-xs); color: var(--ink-faint);
    }
    .ob-rail-item.is-current {
        border-color: var(--accent); color: var(--accent); background: var(--accent-surface);
        font-weight: 600;
    }
    .ob-rail-item.is-done { color: var(--success); border-color: var(--success); }
    .ob-rail-num {
        flex-shrink: 0; width: 17px; height: 17px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--surface-app); font-size: var(--fs-2xs); font-weight: 700;
    }
    .ob-rail-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .ob-body { padding: 18px 0 4px; display: flex; flex-direction: column; gap: 12px; }
    .ob-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .ob-muted { font-size: var(--fs-sm); color: var(--ink-faint); line-height: 1.7; margin: 0; }
    .ob-ok {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-radius: var(--r-2);
        background: rgba(76, 175, 80, 0.1); color: var(--success);
        font-size: var(--fs-sm); font-weight: 500;
    }

    .ob-ws-list { display: flex; flex-direction: column; gap: 5px; }
    .ob-ws-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: var(--r-2);
        background: var(--surface-app); border: 1px solid var(--line-soft);
        font-size: var(--fs-sm);
    }
    .ob-ws-row code {
        flex: 1; font-family: var(--font-mono, monospace);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ob-ws-del {
        background: none; border: 0; cursor: pointer;
        color: var(--ink-faint); font-size: var(--fs-md); padding: 0 2px;
    }
    .ob-ws-del:hover { color: var(--error); }

    .ob-ready { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
    .ob-ready li { font-size: var(--fs-sm); color: var(--ink-soft); line-height: 1.6; }
    .ob-ready strong { color: var(--ink); }

    .ob-foot {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-top: 14px; padding-top: 14px;
        border-top: 1px solid var(--line-soft);
    }
    .ob-count { font-size: var(--fs-xs); color: var(--ink-faint); font-variant-numeric: tabular-nums; }
`;
