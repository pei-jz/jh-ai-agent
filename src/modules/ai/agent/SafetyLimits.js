// SafetyLimits — PURE normalization of the agent's safety-limit config.
// Extracted from AgentController._loadSafetyLimits (Phase 1). The Tauri config
// READ stays in AgentController; this module just sanitizes the raw object so it
// can be unit-tested without a backend.

export const SAFETY_DEFAULTS = {
    maxSteps: 0,                 // 0 / invalid ⇒ unlimited
    tokenBudget: 0,
    wallClockMinutes: 0,
    noProgressWindow: 15,
    identicalCallThreshold: 5,   // soft warn at N×, hard stop at 3N×
    cycleDetectionMinRepeats: 3,
    historyBudgetRatio: 0.7,     // fraction of context window history may use
    historyCompressRatio: 0.5,   // compress old tool results only above this window fraction (keeps prefix cacheable below it)
    agentTemperature: 0.2,       // low temp → fewer transcription typos
    planMode: 'auto',            // 'off' | 'auto' (plan-gate complex tasks) | 'always'
    // 'off' | 'on' — pre-finish independent sub-agent review of file changes.
    //
    // ON, changed from off. The reported symptom was that the agent fixes what it
    // was pointed at and nothing else, and the reviewer is the one part of the
    // loop positioned to notice: it reads the diff with a CLEAN context, so it is
    // not carrying the thirty steps of history that made the narrow fix look
    // complete to the agent that wrote it. That asymmetry — not extra
    // intelligence — is what a second opinion is for.
    //
    // It was already built, guarded and tested, and simply never switched on.
    // The guards are why turning it on is defensible: read-only tools by
    // construction, its own step cap, once per run, skipped for report-only
    // changes and for models in JSON-tool mode, and STYLE findings can never
    // block a finish. The cost is real — roughly 10-20% more tokens on tasks
    // that change files — and is stated in the Settings hint.
    subagentReview: 'on',
    // 'on' | 'off' | 'auto' — whether learned cards are RECALLED into the run.
    // Learning continues either way, so a run without recall is a control
    // session, not a wasted one (docs/design/agent-memory-layers.md §6).
    //
    // Defaults to 'on'. It defaulted to 'auto', which withholds memory from
    // CONTROL_GROUP_SHARE (half) of all runs to build a control group. The
    // statistics behind that are sound and the measurement is still worth having
    // — but running it silently, by default, on someone who just wants the agent
    // to work is not a defensible thing to ship. The user is told the workspace
    // has learned something and then, on a coin flip, does not get it, with no
    // indication why. That is an experiment on a user who never agreed to one.
    //
    // 'auto' remains available in Settings for anyone who wants the answer, and
    // the comparison it feeds (SessionMetrics.compareArms, shown in Settings)
    // still works — it just has to be opted into now.
    memoryRecall: 'on',
    // Step at which a run on the Fast tier is promoted to Deep. 0 ⇒ never.
    //
    // Default OFF. It used to read `safety.maxIterations`, a field this module
    // has never returned (it is `maxSteps`), so the expression fell through to
    // `30 * 0.5` and **every run escalated at step 15** no matter how the step
    // limit was configured — including unlimited runs, where "half the budget"
    // means nothing. A switch also throws away the prompt cache for the whole
    // remainder of the run, so it is not something to do on a guessed threshold.
    escalateAtStep: 0,
    // 'off' | 'on' — inject summaries of PAST SESSIONS into the system prompt.
    //
    // Off by default (docs/design/agent-memory-layers.md §7). Episodes were the
    // heaviest injected layer and the only one built from the model's own account
    // of what happened rather than from observation; what they uniquely carried
    // (outcome, files touched) is now held by Experience cards. journal.md still
    // records everything, so this is a prompt-cost decision, not a data one.
    episodeInjection: 'off',
    // 'off' | 'on' — move the run between the Fast and Deep tiers as it passes
    // through plan → execute → review, instead of picking one tier up front.
    // Off by default: it changes which model answers, and that is not a change
    // to make behind someone's back. See agent/ModelPhaseRouter.js.
    phaseRouting: 'off',
    // 'off' | 'on' — inject the extracted per-file-kind procedure (Step 6).
    //
    // Off by default, and not because it is unfinished. Its own precondition is
    // unmet: the plan gates Playbook on the follow-through LIFT being positive,
    // and at 89 runs the lift is +3.8pt against a 50% base rate — i.e. nothing.
    // Advice shaped as a tool ordering is currently not changing what the agent
    // does, and a playbook is advice shaped as a tool ordering.
    //
    // Turning it on now would also confound the measurement in flight: the v2
    // injection rework is being measured right now, and a third simultaneous
    // change would make the result unattributable. Enable it as its own
    // generation once v2 has an answer. See memory/Playbook.js.
    playbook: 'off',
};

const PLAN_MODES = new Set(['off', 'auto', 'always']);
const SUBAGENT_REVIEW_MODES = new Set(['off', 'on']);
const MEMORY_RECALL_MODES = new Set(['off', 'on', 'auto']);
const PHASE_ROUTING_MODES = new Set(['off', 'on']);
const PLAYBOOK_MODES = new Set(['off', 'on']);
const EPISODE_INJECTION_MODES = new Set(['off', 'on']);

/**
 * Share of sessions held back as the control group under 'auto'.
 *
 * 0.5, not the 0.1 this started at. The control arm is the bottleneck of the
 * whole comparison, and 0.1 made it a bottleneck ten runs wide: with the
 * exploration cost measured on this workspace (mean 22.1, sd 13.1), detecting a
 * 25% improvement needs ~89 runs per arm, which at a 10% control share is ~890
 * runs total. At 0.5 it is ~178 — five times sooner, because the requirement is
 * set by the SMALLER arm and an even split is where that arm is largest.
 *
 * The cost is real: half the runs will not see their memory. That is the price
 * of finding out whether the memory is worth having, and it is why 'auto' is no
 * longer the DEFAULT — a user who never asked to be measured should not pay it.
 * It applies only when someone selects 'auto' in Settings.
 */
export const CONTROL_GROUP_SHARE = 0.5;

/**
 * Decide whether THIS run recalls memory.
 *
 * 'auto' assigns the arm at random rather than leaving it to the user to toggle.
 * That is not just convenience: a human flipping the switch would flip it by
 * mood or by task type, so the two arms would differ in what they were asked to
 * do — and the comparison would measure the tasks, not the memory.
 *
 * @param {string} mode  normalized memoryRecall
 * @param {() => number} rand  injectable for tests
 */
export function resolveRecallArm(mode, rand = Math.random) {
    if (mode === 'off') return false;
    if (mode === 'auto') return rand() >= CONTROL_GROUP_SHARE;
    return true;
}

/**
 * Normalize a raw ai_config object into sanitized numeric safety limits.
 * Convention for the integer fields: null/undefined/''/negative/non-numeric ⇒
 * the default (0 ⇒ "disabled / unlimited"). Ratio ∈ (0,1], temperature ∈ [0,2].
 *
 * @param {object} cfg  raw config (e.g. from get_ai_config); missing ⇒ all defaults
 * @returns {typeof SAFETY_DEFAULTS}
 */
export function normalizeSafetyLimits(cfg = {}) {
    const d = SAFETY_DEFAULTS;
    const num = (v, fallback) => {
        if (v === null || v === undefined || v === '') return fallback;
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return fallback;
        return n;
    };

    const ratioRaw = Number(cfg.history_budget_ratio);
    const historyBudgetRatio = (Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1)
        ? ratioRaw : d.historyBudgetRatio;

    const compressRaw = Number(cfg.history_compress_ratio);
    const historyCompressRatio = (Number.isFinite(compressRaw) && compressRaw > 0 && compressRaw <= 1)
        ? compressRaw : d.historyCompressRatio;

    const tempRaw = Number(cfg.agent_temperature);
    const agentTemperature = (Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 2)
        ? tempRaw : d.agentTemperature;

    const planMode = PLAN_MODES.has(cfg.plan_mode) ? cfg.plan_mode : d.planMode;
    const subagentReview = SUBAGENT_REVIEW_MODES.has(cfg.subagent_review) ? cfg.subagent_review : d.subagentReview;

    return {
        maxSteps:                 num(cfg.max_steps,                   d.maxSteps),
        tokenBudget:              num(cfg.token_budget,                d.tokenBudget),
        wallClockMinutes:         num(cfg.wall_clock_minutes,          d.wallClockMinutes),
        noProgressWindow:         num(cfg.no_progress_window,          d.noProgressWindow),
        identicalCallThreshold:   num(cfg.identical_call_threshold,    d.identicalCallThreshold),
        cycleDetectionMinRepeats: num(cfg.cycle_detection_min_repeats, d.cycleDetectionMinRepeats),
        historyBudgetRatio,
        historyCompressRatio,
        agentTemperature,
        planMode,
        subagentReview,
        escalateAtStep:           num(cfg.escalate_at_step,             d.escalateAtStep),
        memoryRecall: MEMORY_RECALL_MODES.has(cfg.memory_recall) ? cfg.memory_recall : d.memoryRecall,
        phaseRouting: PHASE_ROUTING_MODES.has(cfg.phase_routing) ? cfg.phase_routing : d.phaseRouting,
        playbook: PLAYBOOK_MODES.has(cfg.playbook) ? cfg.playbook : d.playbook,
        episodeInjection: EPISODE_INJECTION_MODES.has(cfg.episode_injection) ? cfg.episode_injection : d.episodeInjection,
    };
}
