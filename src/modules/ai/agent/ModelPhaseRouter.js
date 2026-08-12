// ModelPhaseRouter — which tier a run should be on RIGHT NOW.
//
// The Fast/Deep tier settings already existed, but a run picked ONE of them at
// the start and (apart from the blunt mid-run escalation) stayed there. In
// practice that means the whole task runs on one price point: either you pay
// deep-tier rates to apply an edit the cheap model could have applied, or you
// plan a refactor with a model that cannot plan it.
//
// The observation this module encodes is that a task's phases have very
// different reasoning requirements, and cost follows the reasoning, not the
// token count:
//
//   plan     — read the code, decide what to change. Few tokens, high stakes.
//              A bad plan is paid for by every step after it. → DEEP
//   execute  — apply the decided changes. Most of the tokens, little judgement
//              once the plan is concrete. → FAST
//   review   — check the result against the request. Few tokens, high stakes
//              again: this is the step that catches a wrong implementation. → DEEP
//
// So the expensive model is bought for the two short phases where it changes
// the outcome, and the long middle runs cheap. With the user's own example
// rates — Kimi K3 at $3/M in, DeepSeek Flash at $0.3/M in — that is roughly a
// 3-4× reduction on a typical run, NOT because anything got smarter but because
// the token mass moved to the cheap tier.
//
// Everything here is pure: no config reads, no LLM, no I/O. AgentController owns
// the events; this owns the policy. That split is deliberate — the policy is the
// part with opinions in it, and opinions need tests.

/** The phases of a run, in the order a task normally passes through them. */
export const PHASES = ['plan', 'execute', 'review'];

/**
 * Phase → tier. The whole policy, in one table.
 *
 * Deliberately not user-configurable (yet): three more selects would let someone
 * build "plan on the cheap model, execute on the expensive one", which is the
 * exact inversion of the point. If per-phase control is ever wanted, it belongs
 * here as an override merged over this table, so the default stays honest.
 */
export const PHASE_TIER = { plan: 'deep', execute: 'fast', review: 'deep' };

/**
 * How many steps the PLAN phase may hold the deep model without a plan-first
 * approval gate forcing the issue.
 *
 * A plan needs a few read-only steps to be concrete (read the file, grep the
 * caller, list the directory). It does not need twenty — past that the model is
 * not planning, it is working, and it should be working on the cheap tier. When
 * plan-first mode IS active the gate governs instead and this cap does not apply:
 * the run physically cannot edit anything until the user approves.
 */
export const PLAN_PHASE_MAX_STEPS = 5;

/**
 * Share of a run's tokens the plan + review phases account for, used ONLY by the
 * settings-screen estimate.
 *
 * This is an assumption, and the UI says so. It is on the conservative side
 * (i.e. it under-states the saving): plan and review are short, but they re-read
 * the same context, so calling them a quarter of the volume is safer than the
 * tenth a step count alone would suggest.
 */
export const DEEP_PHASE_TOKEN_SHARE = 0.25;

/**
 * Where a run starts.
 *
 * A run only opens in `plan` when there is genuinely something to plan AND this
 * is the turn that would do the planning:
 *
 *   • `freshTurn` — a continuation turn (the user answering ask_user, a steering
 *     reply) arrives with the plan already made. Re-entering the plan phase there
 *     would put the deep model on what is really execution, which is the
 *     expensive mistake this module exists to avoid.
 *   • `planFirst` or `complex` — otherwise there is no plan step to pay for; a
 *     one-line fix should not touch the deep tier at all.
 *
 * @param {{enabled?: boolean, freshTurn?: boolean, planFirst?: boolean, complex?: boolean}} o
 * @returns {'plan'|'execute'}
 */
export function initialPhase({ enabled = false, freshTurn = true, planFirst = false, complex = false } = {}) {
    if (!enabled) return 'execute';
    if (!freshTurn) return 'execute';
    return (planFirst || complex) ? 'plan' : 'execute';
}

/**
 * Advance the phase in response to something the run just did.
 *
 * Events, and why each one moves the phase:
 *   'step'        — a loop iteration began. Ends the plan phase on the step cap.
 *   'mutation'    — a file-modifying tool ran. Whatever the model called it, this
 *                   is execution: planning does not write files.
 *   'plan-done'   — the plan was registered (task_progress) or approved.
 *   'finish'      — finish_task was called; what follows is verification.
 *   'reopen'      — a review sent the task back (review FAIL, deliverable nudge).
 *                   Back to execute: the fixes are execution, and leaving the run
 *                   pinned to deep after one bounce would quietly undo the saving.
 *
 * Unknown events and no-op transitions return the current phase unchanged, so a
 * caller can fire events freely without guarding each one.
 *
 * @param {'plan'|'execute'|'review'} phase
 * @param {'step'|'mutation'|'plan-done'|'finish'|'reopen'} event
 * @param {{iteration?: number, planFirstPending?: boolean}} [ctx]
 * @returns {'plan'|'execute'|'review'}
 */
export function advancePhase(phase, event, ctx = {}) {
    const { iteration = 0, planFirstPending = false } = ctx;
    switch (event) {
        case 'finish':
            return 'review';
        case 'reopen':
            return 'execute';
        case 'mutation':
        case 'plan-done':
            // A mutation during a pending plan-first gate is a blocked call, not
            // real progress — the gate rejects it, so the run is still planning.
            return (phase === 'plan' && planFirstPending) ? 'plan' : 'execute';
        case 'step':
            if (phase !== 'plan') return phase;
            if (planFirstPending) return 'plan';
            return iteration > PLAN_PHASE_MAX_STEPS ? 'execute' : 'plan';
        default:
            return phase;
    }
}

/**
 * The model id to run this phase on, or null for "leave the caller's choice".
 *
 * Falls back across tiers rather than failing: someone who configured only a
 * Deep tier still gets phase routing, it just has one price point. Returning
 * null when nothing is configured is what keeps this feature off by omission
 * instead of silently pinning a model.
 *
 * @param {'plan'|'execute'|'review'} phase
 * @param {{fast?: string|null, deep?: string|null}} tiers
 * @param {{enabled?: boolean, escalated?: boolean}} [opts] `escalated` = the
 *        long-run escalation fired, so EXECUTE is promoted to deep for the rest
 *        of the run. Plan/review are already deep, so it changes nothing there.
 * @returns {string|null}
 */
export function modelForPhase(phase, tiers = {}, opts = {}) {
    const { enabled = false, escalated = false } = opts;
    if (!enabled) return null;
    const fast = tiers.fast || null;
    const deep = tiers.deep || null;
    if (!fast && !deep) return null;
    let tier = PHASE_TIER[phase] || 'fast';
    if (phase === 'execute' && escalated) tier = 'deep';
    return tier === 'deep' ? (deep || fast) : (fast || deep);
}

/** Human label for a phase, for status lines. `ja` first: the status feed is Japanese. */
export function phaseLabel(phase) {
    return ({ plan: '計画 / plan', execute: '実装 / execute', review: '検収 / review' })[phase] || String(phase);
}

// ── Cost estimate for the settings screen ────────────────────────────────────

/**
 * Per-1M rates for each configured connection, keyed by the `id:model` composite
 * the routing selects speak.
 *
 * A connection with no rates entered is omitted rather than defaulted to zero —
 * a zero rate would render as "100% cheaper", which is worse than no estimate.
 * Cache-read falls back to a tenth of input, which is the common provider ratio
 * and is what the backend's cost table assumes too.
 *
 * @param {Array<object>} instances config.llm_instances
 * @returns {Record<string, {label: string, input: number, cacheRead: number, output: number}>}
 */
export function modelRates(instances) {
    const out = {};
    for (const inst of (Array.isArray(instances) ? instances : [])) {
        const input = Number(inst?.cost_per_1m_input);
        const output = Number(inst?.cost_per_1m_output);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        if (input <= 0 && output <= 0) continue;
        const cacheRaw = Number(inst?.cost_per_1m_cache_read);
        out[`${inst.id}:${inst.model}`] = {
            label: `${inst.name} (${inst.model})`,
            input,
            cacheRead: Number.isFinite(cacheRaw) && cacheRaw > 0 ? cacheRaw : input * 0.1,
            output,
        };
    }
    return out;
}

/**
 * Blended $/1M for a model, at the input/output mix an agent run actually has.
 *
 * Agent runs are overwhelmingly input — the history is re-sent every step, the
 * completions are a few hundred tokens of tool call. Pricing a run at the output
 * rate (the number people quote) would badly misrank two models whose input
 * rates differ but whose output rates are similar.
 */
export const RUN_OUTPUT_SHARE = 0.05;

/** @param {{input: number, output: number}} r */
export function blendedRate(r) {
    if (!r) return 0;
    return r.input * (1 - RUN_OUTPUT_SHARE) + r.output * RUN_OUTPUT_SHARE;
}

/**
 * What phase routing would cost against what a single-model run costs.
 *
 * Compared against the DEEP model, because that is the honest baseline: someone
 * who cares about the quality of their plans is running the whole task on the
 * good model today, and this feature's claim is that they can keep the good
 * plans and stop paying for the good model to apply diffs.
 *
 * Returns null when the estimate cannot be made honestly — no rates entered, or
 * only one tier configured. The UI shows a "enter your $/M rates" prompt then,
 * rather than a number with nothing behind it.
 *
 * @param {{fast?: string|null, deep?: string|null}} tiers
 * @param {Record<string, object>} rates from modelRates()
 * @returns {{baseline: number, routed: number, savedPct: number,
 *            fastRate: number, deepRate: number, fastLabel: string, deepLabel: string}|null}
 */
export function estimateSavings(tiers, rates) {
    const fastRate = rates?.[tiers?.fast];
    const deepRate = rates?.[tiers?.deep];
    if (!fastRate || !deepRate) return null;

    const f = blendedRate(fastRate);
    const d = blendedRate(deepRate);
    if (!(d > 0)) return null;

    // Per 1M tokens of run: the deep phases keep their share, the rest moves.
    const baseline = d;
    const routed = d * DEEP_PHASE_TOKEN_SHARE + f * (1 - DEEP_PHASE_TOKEN_SHARE);
    return {
        baseline,
        routed,
        savedPct: Math.round((1 - routed / baseline) * 100),
        fastRate: f,
        deepRate: d,
        fastLabel: fastRate.label,
        deepLabel: deepRate.label,
    };
}
