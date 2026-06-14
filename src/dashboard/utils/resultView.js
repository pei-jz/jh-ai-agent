// Shared rendering for the post-run "execution result" view.
//
// Used by both MonitorView (the "Result" tab) and ChatView (the modified-files
// list under a completed agent turn). The PURE markdown/result/file renderers
// now live in ./markdown.js (unit-tested); this module re-exports them and adds
// the DOM/IPC glue (file-open handlers + style injection).

import { invoke } from '@tauri-apps/api/core';
export {
    escapeHtml, renderMarkdown, renderResultSummary, renderFileList, filesFromModified
} from './markdown.js';

/**
 * Wire up file-open links inside `rootEl`. Clicking a [data-open-path] element
 * opens that file with the OS default application. Idempotent per element.
 * @param {HTMLElement} rootEl
 */
export function attachFileOpenHandlers(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll('[data-open-path]').forEach(el => {
        if (el._rvBound) return;
        el._rvBound = true;
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            const path = el.getAttribute('data-open-path');
            if (!path) return;
            try {
                await invoke('open_path_default', { path });
            } catch (err) {
                console.error('Failed to open path:', path, err);
                el.classList.add('rv-open-error');
                el.title = `Could not open: ${err}`;
            }
        });
    });
}

/**
 * Shared CSS for the result view. Injected once per document.
 */
export function ensureResultViewStyles() {
    if (document.getElementById('rv-styles')) return;
    const style = document.createElement('style');
    style.id = 'rv-styles';
    style.textContent = `
        .rv-summary, .rv-files-title { color: var(--text-primary); }
        .rv-summary { line-height: 1.6; font-size: 13px; margin-bottom: 16px; }
        .rv-summary .rv-h { margin: 12px 0 6px; font-weight: 600; }
        .rv-summary h1.rv-h { font-size: 18px; } .rv-summary h2.rv-h { font-size: 16px; }
        .rv-summary h3.rv-h { font-size: 14px; }
        .rv-summary .rv-p { margin: 6px 0; }
        .rv-summary .rv-list { margin: 6px 0 6px 20px; }
        .rv-summary .rv-code { background: var(--bg-tertiary); padding: 10px; border-radius: 6px;
            overflow-x: auto; font-family: var(--font-mono); font-size: 12px; margin: 8px 0; }
        .rv-summary code { background: var(--bg-tertiary); padding: 1px 5px; border-radius: 4px;
            font-family: var(--font-mono); font-size: 12px; }
        .rv-summary .rv-quote { border-left: 3px solid var(--accent); padding-left: 10px;
            color: var(--text-secondary); margin: 8px 0; }
        .rv-summary .rv-hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
        .rv-table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
        .rv-table th, .rv-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left;
            vertical-align: top; }
        .rv-table th { background: var(--bg-tertiary); color: var(--text-secondary); font-weight: 600; }
        .rv-files-title { font-weight: 600; font-size: 13px; margin: 14px 0 6px; }
        .rv-file-link { color: var(--accent); text-decoration: none; cursor: pointer;
            font-family: var(--font-mono); }
        .rv-file-link:hover { text-decoration: underline; }
        .rv-file-link.rv-open-error { color: var(--error, #e06c75); }
        .rv-action { white-space: nowrap; }
        .rv-empty { color: var(--text-tertiary); font-size: 12px; padding: 8px 0; }
        /* Sectioned result view */
        .rv-section-label { font-weight: 700; font-size: 12px; color: var(--text-secondary);
            text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0 6px; }
        .rv-answer { font-size: 13.5px; }
        .rv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
        .rv-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
            color: var(--text-secondary); background: var(--bg-tertiary);
            border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
        .rv-details { margin: 6px 0 14px; border: 1px solid var(--border); border-radius: 6px;
            background: var(--bg-secondary, transparent); }
        .rv-details > summary { cursor: pointer; padding: 7px 10px; font-size: 12px; font-weight: 600;
            color: var(--text-secondary); user-select: none; list-style: revert; }
        .rv-details[open] > summary { border-bottom: 1px solid var(--border); }
        .rv-details > .rv-summary, .rv-details > .rv-detail-h { padding: 0 10px; }
        .rv-detail-h { font-weight: 600; font-size: 12px; color: var(--text-secondary); margin: 10px 0 4px; }
    `;
    document.head.appendChild(style);
}
