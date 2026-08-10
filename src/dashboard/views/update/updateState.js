// updateState — what the app should SAY about an available update.
//
// The plugin handles the mechanism (fetch the manifest, verify the minisign
// signature, install). What is easy to get wrong is the reporting, so that part is a
// pure state machine with tests:
//
//   • an update the user has not asked for must never install itself;
//   • a FAILED check is not "you are up to date" — the most likely cause is no
//     network or an unreachable release host, and telling someone they are current
//     when nothing was actually checked is the one lie an updater must not tell;
//   • an updater that has not been configured (no signing key yet, a private build)
//     must say so rather than reporting a permanent error.

import { t } from '../../../i18n/index.js';

/** The placeholder shipped in tauri.conf.json until a real key is generated. */
export const PUBKEY_PLACEHOLDER = 'REPLACE_WITH_YOUR_MINISIGN_PUBLIC_KEY';

/**
 * @typedef {'idle'|'checking'|'available'|'current'|'downloading'|'ready'|'failed'|'unconfigured'} UpdatePhase
 */

/** The starting state. */
export function initialUpdateState() {
    return { phase: 'idle', version: null, notes: '', error: '', progress: 0 };
}

/**
 * Is this a real, installable update?
 *
 * The plugin reports `available: false` when the manifest version is not newer, but a
 * manifest can also arrive with no version at all — treating that as available would
 * offer the user an update it cannot name.
 */
export function isRealUpdate(result) {
    return !!(result && result.available && String(result.version || '').trim());
}

/**
 * What to show for a given phase. Kept here so the wording of "you are up to date"
 * cannot drift from the condition that earns it.
 */
export function describe(state) {
    switch (state?.phase) {
        case 'checking':
            return { title: t('update.checking'), detail: '', busy: true };
        case 'available':
            return {
                title: t('update.available', { version: state.version }),
                detail: state.notes || '',
                busy: false,
            };
        case 'downloading':
            return {
                title: t('update.downloading', { percent: state.progress }),
                detail: t('update.downloading.detail'),
                busy: true,
            };
        case 'ready':
            return {
                title: t('update.ready', { version: state.version }),
                detail: t('update.ready.detail'),
                busy: false,
            };
        case 'current':
            return { title: t('update.current'), detail: '', busy: false };
        case 'failed':
            // Deliberately NOT "up to date": nothing was verified.
            return {
                title: t('update.failed'),
                detail: state.error || t('update.failed.detail'),
                busy: false,
            };
        case 'unconfigured':
            return {
                title: t('update.unconfigured'),
                detail: t('update.unconfigured.detail'),
                busy: false,
            };
        default:
            return { title: '', detail: '', busy: false };
    }
}

/** Progress percentage from the plugin's byte counters, clamped and integral. */
export function progressPercent(downloaded, total) {
    const d = Number(downloaded) || 0;
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((d / t) * 100)));
}

/**
 * May the app check automatically on launch?
 *
 * Checking is a network call to a third party, so it is opt-out-able and it is NEVER
 * an install — the most a launch check does is tell the user something exists. An
 * unconfigured updater is not worth a request at all.
 */
export function shouldCheckOnLaunch({ pubkey = '', optedOut = false } = {}) {
    if (optedOut) return false;
    if (!pubkey || pubkey === PUBKEY_PLACEHOLDER) return false;
    return true;
}
