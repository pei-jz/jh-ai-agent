// steps — what first-run setup still needs, and whether to ask at all.
//
// The productization report's P0: a new user has to start LocalAI, pick a model and
// set a workspace on their own, with no guidance. For the audience this product aims
// at — "a business user who is not deep in AI" — that is where they stop.
//
// Two decisions are encoded here rather than in the UI, because both are easy to get
// subtly wrong and neither is visible when it is:
//
//   1. The wizard asks whether it is NEEDED, not whether it has run. A stored
//      "onboarded: true" flag drifts from reality — a user whose only connection is
//      later deleted is a new user again, and one who configured everything by hand
//      before opening it should never see it. So the trigger is the actual config.
//
//   2. A SKIP is remembered, a completion is not. Someone who dismissed the wizard
//      chose to set things up themselves, and re-opening it every launch would be
//      nagging. Completion needs no flag: finishing it satisfies condition 1.

import { t } from '../../../i18n/index.js';

/** localStorage key holding an explicit dismissal. */
export const SKIP_KEY = 'jhai_onboarding_skipped';

/**
 * @typedef {object} SetupState
 * @property {boolean} hasConnection  at least one usable LLM connection
 * @property {boolean} hasWorkspace   at least one approved project folder
 * @property {boolean} skipped        the user dismissed the wizard before
 */

/**
 * Read setup state out of the saved config.
 *
 * A connection counts only when it could actually run: a provider, a model, and a key
 * unless the provider is keyless. Counting a half-filled row would send the user
 * straight into a failing agent run, which is a worse first experience than the
 * wizard.
 *
 * @param {object} config the ai_config object
 * @param {(id: string) => boolean} isKeyless providerInfo(id).keyless
 * @param {Storage} [storage]
 */
export function readSetupState(config, isKeyless = () => false, storage = null) {
    const instances = Array.isArray(config?.llm_instances) ? config.llm_instances : [];
    const hasConnection = instances.some(i =>
        i && String(i.provider || '').trim() && String(i.model || '').trim()
        && (isKeyless(i.provider) || String(i.api_key || '').trim()));

    const projects = Array.isArray(config?.approved_projects) ? config.approved_projects : [];
    const hasWorkspace = projects.some(p => typeof p === 'string' && p.trim());

    let skipped = false;
    try { skipped = storage?.getItem(SKIP_KEY) === '1'; } catch (_) { /* private mode */ }

    return { hasConnection, hasWorkspace, skipped };
}

/**
 * Should the wizard open on launch?
 *
 * Only when there is no usable connection — the one thing nothing else in the app can
 * work without. A missing workspace is worth prompting for INSIDE the wizard but is
 * not on its own a reason to interrupt someone: plenty of real work (chat, research, a
 * document) needs no project folder at all.
 */
export function shouldShowOnboarding(state) {
    if (!state) return false;
    if (state.skipped) return false;
    return !state.hasConnection;
}

/**
 * The steps, in order. Exported so the UI never invents its own list.
 *
 * Title and blurb are GETTERS, not strings: the catalog is consulted when the wizard
 * renders, so switching language does not require reloading this module (a plain
 * string would freeze whatever locale was active at import time).
 */
export const STEPS = [
    {
        id: 'connect',
        get title() { return t('onboarding.step.connect'); },
        get blurb() { return t('onboarding.step.connect.blurb'); },
    },
    {
        id: 'workspace',
        get title() { return t('onboarding.step.workspace'); },
        get blurb() { return t('onboarding.step.workspace.blurb'); },
    },
    {
        id: 'ready',
        get title() { return t('onboarding.step.ready'); },
        get blurb() { return t('onboarding.step.ready.blurb'); },
    },
];

/**
 * Which step to open on.
 *
 * RESUMES rather than always starting at one: a user who added a connection and then
 * quit should not be walked through it again. The last step is a summary, never a
 * resume target — landing there would say "done" to someone who is not.
 */
export function initialStep(state) {
    if (!state?.hasConnection) return 0;
    if (!state.hasWorkspace) return 1;
    return STEPS.length - 1;
}

/** Can this step be left? The first one gates on the thing nothing works without. */
export function canAdvance(stepIndex, state) {
    if (stepIndex === 0) return !!state?.hasConnection;
    return true;
}

/** Remember an explicit dismissal so the wizard stops asking. */
export function rememberSkip(storage) {
    try { storage?.setItem(SKIP_KEY, '1'); } catch (_) { /* private mode */ }
}

/** Forget the dismissal — used by the "run setup again" entry point. */
export function clearSkip(storage) {
    try { storage?.removeItem(SKIP_KEY); } catch (_) { /* private mode */ }
}
