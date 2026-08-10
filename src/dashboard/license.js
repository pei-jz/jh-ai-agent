// license — hold the current entitlement and let the app ask about it.
//
// Deliberately small. The interesting decisions are elsewhere and tested:
//   • whether a key is genuine        -> src-tauri/src/commands/license.rs (Ed25519)
//   • whether it is still valid       -> modules/license/licenseState.js
//   • what an edition unlocks         -> modules/license/editions.js
//
// This module only stores the key, refreshes the evaluation, and answers questions.
// Note that gating is OFF by default (editions.js ENFORCEMENT_ENABLED) — `can()`
// therefore returns true for everything today. See docs/design/licensing.md §6.

import { evaluateLicense, advanceLastSeen } from '../modules/license/licenseState.js';
import { hasFeature } from '../modules/license/editions.js';

/** The key itself. Signed, so not a secret — but still never logged or transmitted. */
const KEY_STORAGE = 'jhai_license_key';
/** Newest date ever observed. Makes a clock set backwards detectable (offline). */
const SEEN_STORAGE = 'jhai_license_seen';

/** Current evaluation. Starts as the free tier so nothing has to await a load. */
let current = evaluateLicense({});

const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    remove(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

/** Ask Rust whether a key is genuine. Returns the shape license.rs defines. */
async function verify(key) {
    if (!key) return { verified: false, payload: null, reason: 'empty' };
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('verify_license', { key });
    } catch (_) {
        // No Tauri (browser/dev): we cannot verify, so we must not claim to have.
        return { verified: false, payload: null, reason: 'unavailable' };
    }
}

/**
 * Re-evaluate the stored key. Call at boot and after activation.
 *
 * Advances the stored clock guard as a side effect — that is the only way an offline
 * check can notice a rewound clock at all.
 */
export async function refreshLicense() {
    const key = ls.get(KEY_STORAGE);
    const { verified, payload } = await verify(key);

    const now = Date.now();
    const lastSeen = Number(ls.get(SEEN_STORAGE)) || 0;
    current = evaluateLicense({ license: payload, verified, now, lastSeen });
    ls.set(SEEN_STORAGE, String(advanceLastSeen(lastSeen, now)));

    return current;
}

/**
 * Store and evaluate a key the user pasted.
 *
 * A key that does not verify is NOT stored: leaving a bad key behind would make
 * Settings show an error on every launch with no obvious way to clear it.
 */
export async function activateLicense(key) {
    const trimmed = String(key || '').trim();
    const { verified, payload } = await verify(trimmed);
    if (!verified) {
        return evaluateLicense({ license: payload, verified: false });
    }
    ls.set(KEY_STORAGE, trimmed);
    return refreshLicense();
}

/** Forget the stored key and fall back to the free tier. */
export async function clearLicense() {
    ls.remove(KEY_STORAGE);
    return refreshLicense();
}

/** The current evaluation, without a round trip. */
export function licenseState() {
    return current;
}

/** Is a licence key stored at all? (Used to choose between "activate" and "change".) */
export function hasStoredKey() {
    return !!ls.get(KEY_STORAGE);
}

/** Does this build have an issuing key compiled in? */
export async function licensingConfigured() {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return !!(await invoke('license_configured'));
    } catch (_) {
        return false;
    }
}

/**
 * May the current edition use `feature`?
 *
 * The single question the rest of the app should ever ask. Fails open — see
 * hasFeature() for why a licence check must never deny a paying customer mid-task.
 */
export function can(feature) {
    return hasFeature(current.edition, feature);
}
