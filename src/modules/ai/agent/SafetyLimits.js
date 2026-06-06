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
    agentTemperature: 0.2,       // low temp → fewer transcription typos
    planMode: 'auto',            // 'off' | 'auto' (plan-gate complex tasks) | 'always'
};

const PLAN_MODES = new Set(['off', 'auto', 'always']);

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

    const tempRaw = Number(cfg.agent_temperature);
    const agentTemperature = (Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 2)
        ? tempRaw : d.agentTemperature;

    const planMode = PLAN_MODES.has(cfg.plan_mode) ? cfg.plan_mode : d.planMode;

    return {
        maxSteps:                 num(cfg.max_steps,                   d.maxSteps),
        tokenBudget:              num(cfg.token_budget,                d.tokenBudget),
        wallClockMinutes:         num(cfg.wall_clock_minutes,          d.wallClockMinutes),
        noProgressWindow:         num(cfg.no_progress_window,          d.noProgressWindow),
        identicalCallThreshold:   num(cfg.identical_call_threshold,    d.identicalCallThreshold),
        cycleDetectionMinRepeats: num(cfg.cycle_detection_min_repeats, d.cycleDetectionMinRepeats),
        historyBudgetRatio,
        agentTemperature,
        planMode,
    };
}
