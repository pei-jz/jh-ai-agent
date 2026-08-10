// updater — drive the signed update flow.
//
// The plugin does the security-critical part: it fetches the manifest, verifies a
// minisign signature over the bundle against the public key compiled into the app, and
// refuses to install anything that does not verify. Nothing here should try to be
// clever about that.
//
// What this module owns is the POLICY:
//   • a launch check only ever TELLS the user something exists; installing is a click;
//   • a failed check says so, rather than "you are up to date" (see updateState.js);
//   • the check is opt-out-able, because it is a request to a third-party host.

import Updater from './svelte/update/UpdateBanner.svelte';
import { UPDATE_STYLES } from './svelte/update/update.styles.js';
import { mountComponent, destroyComponent } from './svelte/mount.svelte.js';
import {
    initialUpdateState, isRealUpdate, progressPercent, shouldCheckOnLaunch,
} from './views/update/updateState.js';

const HOST_ID = 'jhai-updater';
/** Opt-out flag. Checked before any network call. */
export const OPT_OUT_KEY = 'jhai_update_check_disabled';

let state = initialUpdateState();
/** The plugin's handle for the update it found, kept for the install step. */
let pending = null;

function ensureStyles() {
    if (document.getElementById('upd-styles')) return;
    const el = document.createElement('style');
    el.id = 'upd-styles';
    el.textContent = UPDATE_STYLES;
    document.head.appendChild(el);
}

function host() {
    let el = document.getElementById(HOST_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = HOST_ID;
        document.body.appendChild(el);
    }
    return el;
}

function paint() {
    ensureStyles();
    mountComponent(Updater, host(), {
        state,
        onInstall: () => install(),
        onDismiss: () => dismiss(),
        onDisable: () => {
            try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch (_) { /* private mode */ }
            dismiss();
        },
    });
}

function dismiss() {
    state = initialUpdateState();
    pending = null;
    destroyComponent(document.getElementById(HOST_ID));
    document.getElementById(HOST_ID)?.remove();
}

/** The public key compiled into this build, or '' when the plugin is unavailable. */
async function configuredPubkey() {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Exposed by our own command rather than read from the config file, so a
        // packaged build reports what it was actually built with.
        return await invoke('updater_pubkey') || '';
    } catch (_) {
        return '';
    }
}

/**
 * Can this build verify signed updates at all?
 *
 * Used by Settings to decide between offering a check and saying plainly that this
 * build has no update channel — rather than showing a button that always fails.
 */
export async function isUpdaterConfigured() {
    const pubkey = await configuredPubkey();
    return shouldCheckOnLaunch({ pubkey, optedOut: false });
}

/**
 * Check for an update.
 *
 * @param {{silent?: boolean}} opts silent:true suppresses the "you are up to date"
 *        and failure states — a launch check should not interrupt with either.
 */
export async function checkForUpdate({ silent = false } = {}) {
    let optedOut = false;
    try { optedOut = localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (_) {}
    const pubkey = await configuredPubkey();

    if (!shouldCheckOnLaunch({ pubkey, optedOut })) {
        if (!silent) {
            state = { ...initialUpdateState(), phase: optedOut ? 'idle' : 'unconfigured' };
            if (state.phase !== 'idle') paint();
        }
        return state;
    }

    state = { ...initialUpdateState(), phase: 'checking' };
    if (!silent) paint();

    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (isRealUpdate(result)) {
            pending = result;
            state = {
                ...initialUpdateState(),
                phase: 'available',
                version: result.version,
                notes: String(result.body || '').slice(0, 400),
            };
            paint();                       // always surfaced: this is the point
        } else {
            pending = null;
            state = { ...initialUpdateState(), phase: 'current' };
            if (silent) dismiss(); else paint();
        }
    } catch (e) {
        pending = null;
        // NOT "up to date" — nothing was verified.
        state = { ...initialUpdateState(), phase: 'failed', error: String(e?.message || e) };
        if (silent) dismiss(); else paint();
    }
    return state;
}

/**
 * Download and install the pending update, then relaunch.
 *
 * Only reachable from an explicit click. The signature check happens inside
 * `downloadAndInstall`; if it fails the plugin throws and nothing is installed.
 */
async function install() {
    if (!pending) return;
    state = { ...state, phase: 'downloading', progress: 0 };
    paint();

    let total = 0;
    let downloaded = 0;
    try {
        await pending.downloadAndInstall((event) => {
            if (event.event === 'Started') {
                total = event.data?.contentLength || 0;
            } else if (event.event === 'Progress') {
                downloaded += event.data?.chunkLength || 0;
                state = { ...state, progress: progressPercent(downloaded, total) };
                paint();
            } else if (event.event === 'Finished') {
                state = { ...state, phase: 'ready', progress: 100 };
                paint();
            }
        });

        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
    } catch (e) {
        state = { ...state, phase: 'failed', error: String(e?.message || e) };
        paint();
    }
}

/**
 * The launch check. Silent: it speaks up only when there IS an update.
 *
 * Deliberately not awaited by the boot sequence — an unreachable release host must
 * never delay the app starting.
 */
export function checkForUpdateOnLaunch() {
    checkForUpdate({ silent: true }).catch(e => console.warn('Update check failed:', e));
}
