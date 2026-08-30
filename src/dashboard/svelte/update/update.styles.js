// Styles for the update banner. A corner card, not a modal — an update is news.
export const UPDATE_STYLES = `
    .upd-banner {
        position: fixed; right: 18px; bottom: 18px; z-index: 8500;
        width: 380px; max-width: calc(100vw - 36px);
        display: flex; align-items: flex-start; gap: 11px;
        padding: 13px 14px;
        background: var(--surface-panel);
        border: 1px solid var(--accent);
        border-radius: var(--r-3);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    }
    .upd-banner.is-failed { border-color: var(--warning, #f59e0b); }
    .upd-ic { flex-shrink: 0; color: var(--accent); margin-top: 1px; }
    .upd-banner.is-failed .upd-ic { color: var(--warning, #f59e0b); }
    .upd-ic.is-busy { animation: updSpin 1.4s linear infinite; }
    @keyframes updSpin { to { transform: rotate(360deg); } }

    .upd-body { flex: 1; min-width: 0; }
    .upd-title {
        font-size: var(--fs-sm); font-weight: 600; color: var(--ink); line-height: 1.4;
    }
    .upd-detail {
        margin-top: 3px; font-size: var(--fs-xs); color: var(--ink-soft);
        line-height: 1.55; max-height: 4.6em; overflow-y: auto; white-space: pre-wrap;
    }
    .upd-bar {
        margin-top: 8px; height: 4px; border-radius: var(--r-1);
        background: var(--surface-sunken); overflow: hidden;
    }
    .upd-bar > div { height: 100%; background: var(--accent); transition: width 0.2s; }

    .upd-actions { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
    .upd-link {
        background: none; border: 0; cursor: pointer; padding: 0;
        color: var(--ink-faint); font-size: var(--fs-2xs); text-decoration: underline;
    }
    .upd-link:hover { color: var(--ink-soft); }
    .upd-close {
        background: none; border: 0; cursor: pointer; padding: 0 2px;
        color: var(--ink-faint); font-size: var(--fs-sm);
    }
    .upd-close:hover { color: var(--ink); }
`;
