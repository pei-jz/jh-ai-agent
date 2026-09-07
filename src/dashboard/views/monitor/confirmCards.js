// One implementation for all of these — see utils/html.js for what the
// nine local copies disagreed about.
import { escapeHtml } from '../../utils/html.js';
import { t } from '../../../i18n/index.js';

// confirmCards — pure formatters for the Monitor's approval cards (P4 split
// from MonitorView.js). None of these touch the DOM or view state; every input
// arrives as an argument. Kept behaviourally identical to the former methods.



/** Normalize a workspace path for the auto-approve comparison. */
export function normWsPath(ws) {
    return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Read the auto-approve workspace list from localStorage (safe). */
export function readAutoApproveWorkspaces() {
    try {
        const arr = JSON.parse(localStorage.getItem('jhai_autoapprove_workspaces') || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

/** Write the auto-approve workspace list to localStorage (safe). */
export function writeAutoApproveWorkspaces(arr) {
    try { localStorage.setItem('jhai_autoapprove_workspaces', JSON.stringify(arr)); } catch (_) {}
}

/** Is this workspace in the auto-approve set? */
export function isWsAutoApprove(ws) {
    const norm = normWsPath(ws);
    return readAutoApproveWorkspaces().some(p => normWsPath(p) === norm);
}

/** Add/remove a workspace from the auto-approve set. */
export function setWsAutoApprove(ws, on) {
    const norm = normWsPath(ws);
    let arr = readAutoApproveWorkspaces();
    arr = arr.filter(p => normWsPath(p) !== norm);
    if (on) arr.push(ws);
    writeAutoApproveWorkspaces(arr);
}

/**
 * Line-based simple diff. Returns the full diff HTML (pure function of the two
 * texts, so the behaviour is testable without a DOM).
 */
export function renderSimpleDiff(oldText, newText) {
    const ol = (oldText || '').split('\n');
    const nl = (newText || '').split('\n');
    let html = '<div style="font-family:monospace;font-size:10.5px;background:#0f1419;padding:8px;border-radius:var(--r-2);overflow-x:auto;max-height:200px;border:1px solid var(--line);">';
    let i = 0, j = 0;
    while (i < ol.length || j < nl.length) {
        if (i < ol.length && j < nl.length) {
            if (ol[i] === nl[j]) {
                html += `<div style="color:#666;padding:1px 4px;white-space:pre">  ${escapeHtml(ol[i])}</div>`; i++; j++;
            } else {
                html += `<div style="color:#ff5555;background:rgba(255,85,85,0.1);padding:1px 4px;white-space:pre">- ${escapeHtml(ol[i++])}</div>`;
                html += `<div style="color:#50fa7b;background:rgba(80,250,123,0.1);padding:1px 4px;white-space:pre">+ ${escapeHtml(nl[j++])}</div>`;
            }
        } else if (i < ol.length) {
            html += `<div style="color:#ff5555;background:rgba(255,85,85,0.1);padding:1px 4px;white-space:pre">- ${escapeHtml(ol[i++])}</div>`;
        } else {
            html += `<div style="color:#50fa7b;background:rgba(80,250,123,0.1);padding:1px 4px;white-space:pre">+ ${escapeHtml(nl[j++])}</div>`;
        }
    }
    return html + '</div>';
}

/**
 * Which approvals in this log have already been answered?
 *
 * Two sources, because one of them cannot see the past. `confirm_resolved` is
 * emitted the moment a confirmation settles and is authoritative — but tasks
 * recorded before that event existed have none, so a request followed by
 * further work is read as answered too. That fallback is what the Story panel
 * had been doing inline; making it a rule both surfaces call is the point, since
 * the Raw Log was not doing it at all and kept re-rendering settled approvals as
 * live, clickable cards for the life of the task.
 *
 * @param {Array} logs the task's log entries
 * @returns {Set<string>} confirmIds that must NOT render as actionable
 */
export function resolvedConfirmIds(logs) {
    const list = Array.isArray(logs) ? logs : [];
    const done = new Set();
    for (const l of list) {
        if (l?.event === 'confirm_resolved' && l.data?.confirmId) done.add(l.data.confirmId);
    }
    // Fallback for logs written before confirm_resolved existed: work happening
    // after the request means it was answered. Only the LAST request can still
    // be genuinely open, so every earlier one is settled by definition.
    let lastOpen = -1;
    for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l?.event !== 'confirm_request' || !l.data?.confirmId) continue;
        if (lastOpen >= 0) done.add(list[lastOpen].data.confirmId);
        lastOpen = i;
    }
    if (lastOpen >= 0 && !done.has(list[lastOpen].data.confirmId)) {
        const moved = list.slice(lastOpen + 1).some(l =>
            l?.event === 'tool_call' || l?.event === 'log' || l?.event === 'complete');
        if (moved) done.add(list[lastOpen].data.confirmId);
    }
    return done;
}

/** A settled approval, as history: legible, and with nothing left to click. */
export function fmtConfirmResolved(data, approved) {
    const what = data?.command || data?.path || data?.message || '';
    const icon = approved === false ? '🚫' : '✅';
    const label = approved === false ? '承認されませんでした' : '承認済み';
    return `<div class="mlog mlog-status log-status"><span class="mlog-icon">${icon}</span>`
        + `<span class="mlog-body"><strong>${label}:</strong> ${escapeHtml(String(what).slice(0, 160))}</span></div>`;
}

/**
 * An approval that was never answered, on a run that has stopped.
 *
 * Not the same as settled: nobody said yes or no. But the promise it would have
 * resolved died with the run, so the buttons cannot work — and offering them
 * produces the worst version of this, where clicking does nothing at all and
 * the card comes back looking live the next time the task is opened.
 */
export function fmtConfirmStale(data, note) {
    const what = data?.command || data?.path || data?.message || '';
    return `<div class="mlog mlog-status log-status"><span class="mlog-icon">⏸</span>`
        + `<span class="mlog-body"><strong>${escapeHtml(String(what).slice(0, 160))}</strong>`
        + `<br><span class="mconfirm-stale">${escapeHtml(note)}</span></span></div>`;
}

/**
 * Build the approval-card markup. Pure — the caller supplies everything the
 * card needs (the workspace's auto-approve state and its toggles).
 *
 * @param {object} data  {confirmId, type, message, command, risk, path, oldContent, newContent, allowAlways}
 * @param {string} idPrefix
 * @param {boolean} wsAutoApprove whether this workspace auto-approves commands
 * @param {string} ws the workspace path (for the auto-approve checkbox)
 */
export function fmtConfirm(data, idPrefix = 'confirm', wsAutoApprove = false, ws = '') {
    const cid = data.confirmId;
    let inner = '';
    let alwaysBtn = '';
    let autoWs = '';
    if (data.type === 'command_confirm') {
        const dangerous = data.risk === 'dangerous';
        const riskBadge = dangerous
            ? `<span class="mconfirm-risk">${t('confirm.danger')}</span>`
            : '';
        inner = `<h4>${t('confirm.title')} ${riskBadge}</h4><p>${escapeHtml(data.message || '')}</p><pre><code>${escapeHtml(data.command || '')}</code></pre>`;
        // "Always allow" recurs for normal commands; dangerous can never be
        // whitelisted (allowAlways is false for them from the handler).
        if (data.allowAlways) {
            alwaysBtn = `<button class="btn btn-secondary btn-approve-always" data-confirm-id="${cid}" title="${t('confirm.always.title')}">${t('confirm.always')}</button>`;
        }
        // Per-workspace auto-approve toggle — for TERMINAL COMMANDS only.
        //
        // Every approval-gated tool sends type:'command_confirm', so this card
        // is also what a write_xlsx or a delete_file looks like. Only
        // run_command carries `risk`, and only run_command consults the
        // auto-approve list (ToolExecutor._isCommandApproved); the write tools
        // always prompt. Offering the checkbox on their cards promised
        // something nothing would honour — the next write asked again, and a
        // user who had ticked it read that as the run being stuck.
        const isTerminalCommand = !!data.risk;
        if (isTerminalCommand && !dangerous && ws) {
            const on = wsAutoApprove;
            autoWs = `<label class="mconfirm-autows"><input type="checkbox" class="cb-autows" data-ws="${escapeHtml(ws)}" ${on ? 'checked' : ''}> ${t('confirm.autoWs')}</label>`;
        }
        if (isTerminalCommand) {
            autoWs += `<div class="mconfirm-manage"><a class="acm-open" title="${t('confirm.manage.title')}">${t('confirm.manage')}</a></div>`;
        }
    } else if (data.type === 'diff_review') {
        inner = `<h4>${t('confirm.diff')}</h4><p><code>${escapeHtml(data.path || '')}</code></p><p>${escapeHtml(data.message || '')}</p>${renderSimpleDiff(data.oldContent || '', data.newContent || '')}`;
    }
    return `
        <div class="mconfirm-box log-confirm-request" id="${idPrefix}-${cid}" data-confirm-card="${cid}">
            ${inner}
            ${autoWs}
            <div class="mconfirm-actions">
                <button class="btn btn-success btn-approve" data-confirm-id="${cid}">${t('confirm.approve')}</button>
                ${alwaysBtn}
                <button class="btn btn-error btn-reject" data-confirm-id="${cid}">${t('confirm.reject')}</button>
            </div>
        </div>
    `;
}
