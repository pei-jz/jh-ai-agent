// editions — the ONE place that defines what is paid.
//
// Every gating decision reads this table. The alternative (an `if (edition === 'pro')`
// wherever a feature happens to live) means nobody can answer "what does Pro get?"
// without grepping the whole app, and the answer drifts from the price list.
//
// Read docs/design/licensing.md before changing anything here. The short version:
// this repository ships under MIT OR Apache-2.0 — both permissive — so a client-side
// gate is removable by anyone who recompiles. That is a consequence of the licence we
// chose, not a bug to be patched. The gate exists to identify paying customers and to
// make the commercial boundary explicit, not to be an unbreakable wall.

/** Ordered from least to most capable. Order matters: `atLeast` relies on it. */
export const EDITIONS = ['community', 'pro', 'enterprise'];

/**
 * Master switch for feature gating.
 *
 * FALSE on purpose. The machinery (signature verification, expiry, this table, the
 * Settings UI) is complete and flipping this to `true` makes it bite. It is off
 * because the commercial decision has not been made, and gating Office generation
 * today would cost more adoption than it could earn — see licensing.md §8.
 *
 * This is "not switched on yet", not "not finished".
 */
export const ENFORCEMENT_ENABLED = false;

/**
 * Feature id -> the lowest edition that includes it.
 *
 * A feature that is NOT listed here is free, for everyone, always. That default is
 * deliberate: forgetting to add an entry must fail open, never closed.
 */
export const FEATURE_MINIMUM = {
    // Office authoring. Reading is free — a document you were sent is not our product.
    office_write: 'pro',
    // Unattended runs.
    scheduled_tasks: 'pro',
    // Parallel delegation to subagents.
    subagents: 'pro',
    // Serving the AI-Hub to other applications.
    hub_server: 'pro',
    // Organisation features.
    policy_management: 'enterprise',
    audit_export: 'enterprise',
};

/**
 * Things that must NEVER appear in FEATURE_MINIMUM. Asserted by the tests.
 *
 * Gating any of these would be a product defect, not a pricing choice:
 *   • safety machinery — "pay to be safe" is not a business model;
 *   • the user's own data — a licence lapse must not lock someone out of their
 *     history, their files, or their settings;
 *   • anything already created — a spreadsheet written under Pro has to keep opening.
 */
export const NEVER_GATED = [
    'approval_flow', 'write_scope', 'command_allowlist',
    'task_history', 'read_files', 'office_read', 'settings',
    'export_own_data',
];

/** Rank of an edition, or -1 when unknown. */
export function editionRank(edition) {
    return EDITIONS.indexOf(String(edition || '').toLowerCase());
}

/** Is `edition` at least `required`? Unknown editions rank below everything. */
export function atLeast(edition, required) {
    const have = editionRank(edition);
    const need = editionRank(required);
    if (need < 0) return true;          // unknown requirement gates nothing
    return have >= need;
}

/**
 * Would this edition be allowed this feature IF enforcement were on?
 *
 * Separate from `hasFeature` so the gating rules are testable while the master switch
 * is off. Otherwise the day someone flips ENFORCEMENT_ENABLED is the first day this
 * logic ever runs — and finding out then which features close is far too late.
 *
 * Fails OPEN for an unlisted feature: forgetting a table entry must never lock
 * something, because a licence check that denies a paying customer their tool
 * mid-task is worse than one that lets a free user through.
 */
export function featureAllowed(edition, feature) {
    const required = FEATURE_MINIMUM[feature];
    if (!required) return true;
    return atLeast(edition, required);
}

/**
 * May this edition use this feature? The question the app should ask.
 *
 * Returns true for everything while ENFORCEMENT_ENABLED is false — see that constant.
 */
export function hasFeature(edition, feature) {
    if (!ENFORCEMENT_ENABLED) return true;
    return featureAllowed(edition, feature);
}

/** Which features an edition unlocks beyond the free baseline. For the UI. */
export function featuresOf(edition) {
    return Object.keys(FEATURE_MINIMUM)
        .filter(f => atLeast(edition, FEATURE_MINIMUM[f]))
        .sort();
}

/** Display name for an edition. Unknown values fall back to the free tier's name. */
export function editionLabel(edition) {
    switch (String(edition || '').toLowerCase()) {
        case 'pro': return 'Pro';
        case 'enterprise': return 'Enterprise';
        default: return 'Community';
    }
}
