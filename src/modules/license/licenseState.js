// licenseState — decide what a verified licence actually entitles someone to today.
//
// Signature verification is Rust's job (commands/license.rs); it answers "did we
// sign this?". This module answers the part that is easy to get wrong and easy to
// get cruel: is it still valid, what happens when it is not, and what do we say.
//
// The rules, from docs/design/licensing.md §4:
//   • an expired licence DEGRADES to community — it never locks the app or the
//     user's own data;
//   • there is a real grace period, because a renewal held up by an invoice cycle
//     is not piracy;
//   • the clock can be turned back and we cannot stop that offline, so we only
//     detect the obvious case rather than pretending to enforce.

import { EDITIONS, editionRank, editionLabel } from './editions.js';
import { t } from '../../i18n/index.js';

/** Days after `expires` during which paid features still work, with a warning. */
export const GRACE_DAYS = 14;

/** @typedef {'none'|'invalid'|'active'|'grace'|'expired'} LicenseStatus */

const DAY_MS = 86400000;

/** Parse a YYYY-MM-DD (or ISO) date to a UTC timestamp, or null. */
export function parseDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    // Date-only strings are read as UTC midnight so a licence does not expire an
    // afternoon early for someone in Tokyo and late for someone in São Paulo.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    // Not named `t` — that is the imported translate function, and shadowing it here
    // would be a trap for the next person who adds a message to this file.
    const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * The date to judge against.
 *
 * If the machine's clock is behind the newest date we have ever seen, we use the
 * remembered date instead. This catches a clock set backwards; it does not stop
 * someone determined, and it is not meant to — the honest fix requires a network
 * call, which would cost the offline and privacy guarantees that matter more.
 */
export function effectiveNow(now, lastSeen) {
    const n = Number(now) || 0;
    const seen = Number(lastSeen) || 0;
    return seen > n ? seen : n;
}

/**
 * Evaluate a licence.
 *
 * @param {object} opts
 * @param {object|null} opts.license verified payload from Rust: {edition, expires, ...}
 * @param {boolean} opts.verified did the signature check pass?
 * @param {number} opts.now Date.now()
 * @param {number} opts.lastSeen newest timestamp previously observed (clock guard)
 * @returns {{edition: string, status: LicenseStatus, daysLeft: number|null,
 *            licensee: string, expires: string, warn: boolean}}
 */
export function evaluateLicense({ license = null, verified = false, now = Date.now(), lastSeen = 0 } = {}) {
    const free = {
        edition: 'community', status: 'none', daysLeft: null,
        licensee: '', expires: '', warn: false,
    };

    if (!license) return free;
    // A key that does not verify is treated exactly like no key at all, except that
    // we say so — silently running as free would look like the app "lost" a licence
    // the customer paid for.
    if (!verified) return { ...free, status: 'invalid' };

    const claimed = String(license.edition || '').toLowerCase();
    // An unknown edition string means a key minted by a newer issuer than this build
    // understands. Do not guess upwards.
    const edition = EDITIONS.includes(claimed) ? claimed : 'community';

    const licensee = String(license.licensee || '');
    const expiresRaw = String(license.expires || '');
    const expires = parseDate(expiresRaw);
    const today = effectiveNow(now, lastSeen);

    // A licence with no expiry is perpetual. That is a legitimate thing to sell, so
    // do not treat a missing field as expired.
    if (!expires) {
        return { edition, status: 'active', daysLeft: null, licensee, expires: '', warn: false };
    }

    const daysLeft = Math.ceil((expires - today) / DAY_MS);

    if (daysLeft >= 0) {
        return {
            edition, status: 'active', daysLeft, licensee, expires: expiresRaw,
            // Nudge in the last two weeks rather than surprising someone on the day.
            warn: daysLeft <= GRACE_DAYS,
        };
    }

    if (-daysLeft <= GRACE_DAYS) {
        // Still the paid edition: renewals slip, and stopping someone's work over
        // paperwork is not enforcement, it is spite.
        return { edition, status: 'grace', daysLeft, licensee, expires: expiresRaw, warn: true };
    }

    // Degrade — never lock. The app keeps working; only the paid extras close.
    return {
        edition: 'community', status: 'expired', daysLeft, licensee,
        expires: expiresRaw, warn: true,
    };
}

/** What to show in Settings. Wording lives with the conditions that earn it. */
export function describeLicense(state) {
    const s = state || {};
    const edition = editionLabel(s.edition);
    switch (s.status) {
        case 'active':
            return {
                title: t('license.active', { edition }),
                detail: s.expires
                    ? (s.warn
                        ? t('license.active.expiring', { date: s.expires, days: s.daysLeft })
                        : t('license.active.expires', { date: s.expires }))
                    : t('license.active.perpetual'),
                tone: s.warn ? 'warn' : 'ok',
            };
        case 'grace':
            return {
                title: t('license.grace', { edition }),
                // daysLeft is negative here, so this is what remains OF the grace.
                detail: t('license.grace.detail', {
                    date: s.expires, days: GRACE_DAYS + s.daysLeft,
                }),
                tone: 'warn',
            };
        case 'expired':
            return {
                title: t('license.expired'),
                detail: t('license.expired.detail', { date: s.expires }),
                tone: 'warn',
            };
        case 'invalid':
            return {
                title: t('license.invalid'),
                detail: t('license.invalid.detail'),
                tone: 'error',
            };
        default:
            return {
                title: t('license.community'),
                detail: t('license.community.detail'),
                tone: 'ok',
            };
    }
}

/** True when this state should still open paid features. */
export function isEntitled(state) {
    return state?.status === 'active' || state?.status === 'grace';
}

/** Highest of two timestamps — used to advance the stored clock guard. */
export function advanceLastSeen(lastSeen, now) {
    return Math.max(Number(lastSeen) || 0, Number(now) || 0);
}

/** Sanity helper for the UI: is `edition` a tier we know how to display? */
export function isKnownEdition(edition) {
    return editionRank(edition) >= 0;
}
