// storageUsage — what the app is keeping on disk and in localStorage.
//
// Extracted from ConfigView._renderStorageUsage, which built this HTML and wrote
// it straight into `#cfg-storage-usage` — an element INSIDE SettingsGeneral's
// own subtree — while the `storageUsage` prop it was meant to feed was never
// assigned and so was always ''. Writing into a mounted component's DOM is the
// one thing mount.svelte.js says not to do; it only held because the component
// happened to leave that div empty when the prop was falsy.

import { t } from '../../../i18n/index.js';

/** Bytes as B / KB / MB. */
export function fmtBytes(b) {
    const n = Number(b) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
}

/** Size of one localStorage entry, in bytes (UTF-16, so 2 per char). */
export function entrySize(key, storage = globalThis.localStorage) {
    try {
        const v = storage?.getItem(key);
        return v ? v.length * 2 : 0;
    } catch (_) { return 0; }
}

/** Total size of everything in localStorage, keys included. */
export function totalSize(storage = globalThis.localStorage) {
    let total = 0;
    try {
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            total += (k.length + (storage.getItem(k) || '').length) * 2;
        }
    } catch (_) { /* private mode */ }
    return total;
}

/**
 * The panel body.
 *
 * @param {object} server what `get_storage_usage` returned ({} when unavailable)
 * @param {Storage} [storage] injectable for tests
 */
export function storageUsageHtml(server = {}, storage = globalThis.localStorage) {
    const chat = entrySize('direct_ai_sessions', storage);
    const apiLogs = entrySize('jh_api_logs', storage);
    const scheds = entrySize('jh_schedules', storage);

    return `
        <div class="cfg-storage-h">${t('storage.local')}</div>
        · ${t('storage.chat')} (direct_ai_sessions): ${fmtBytes(chat)}<br>
        · ${t('storage.apiLogs')} (jh_api_logs): ${fmtBytes(apiLogs)} ${apiLogs > 0 ? `<span class="cfg-muted">${t('storage.retired')}</span>` : ''}<br>
        · ${t('storage.schedules')} (jh_schedules): ${fmtBytes(scheds)}<br>
        · ${t('storage.localTotal')}: <strong>${fmtBytes(totalSize(storage))}</strong>
        <div class="cfg-storage-h">${t('storage.server')}</div>
        · task_history.json: ${fmtBytes(server.task_history_bytes)}<br>
        · task_logs/ (${server.task_logs_count || 0} ${t('storage.taskLogs')}): ${fmtBytes(server.task_logs_bytes)}<br>
        · ${t('storage.commLog')} ai_communication.log: ${fmtBytes(server.comm_log_bytes)} ${server.log_dir ? '' : `<span class="cfg-muted">${t('storage.notSet')}</span>`}
    `;
}
