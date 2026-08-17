// RunState — the facts about a run that outlive a single loop iteration.
//
// `AgentController.run()` was one 1,788-line method: 516 lines of setup, an
// 1,143-line loop and a 129-line teardown, all sharing one scope. Nothing could
// be lifted out because everything closed over the same twenty-odd variables.
// Splitting it into `_prepareRun` / loop / `_finishRun` needed somewhere for the
// values that cross those boundaries to live. This is that place.
//
// SCOPE, deliberately narrow: this holds what the PHASES share — the step
// ceiling, when the run began, the conversation — plus the derived predicates
// the loop asks about. It does NOT hold the loop's own counters (repeatCount,
// textOnlyCount, the warning latches, …). Those are read and written on nearly
// every line of the loop body and are meaningless outside it; moving ~200
// references onto `st.` would be a large diff through the agent's core loop that
// changes nothing anyone can read or test. They move here when the loop body
// itself becomes `_stepOnce(st)`, which is the remaining step — and this file
// grows then, rather than shipping fields today that nothing reads.
//
// Also deliberately DUMB. Every real decision (is a budget exceeded, is a loop a
// loop) stays in SafetyGuards, which is pure and tested. A state object that
// started making decisions would just be the monolith again, smaller.

export class RunState {
    /**
     * @param {object} opts
     * @param {number} [opts.maxIterations] 0 / negative ⇒ unlimited
     * @param {number} [opts.startedAt] epoch ms; injectable for tests
     */
    constructor({ maxIterations = 0, startedAt = Date.now() } = {}) {
        /**
         * Step counter, owned here because the loop CONDITION reads it. The body
         * keeps a mirror for the ~40 places that report or record the step number.
         * Incremented at the top of each iteration, so it is 1-based in the body:
         * every "step N" message means this.
         */
        this.iteration = 0;
        /** 0 or less ⇒ no step ceiling; the token/wall-clock budgets still apply. */
        this.maxIterations = maxIterations;
        /** Injectable so the wall-clock budget can be tested without waiting. */
        this.startedAt = startedAt;
        /** The conversation. Built by `_prepareRun`, appended to by the loop. */
        this.history = [];
    }

    /** No step ceiling configured. */
    get isUnlimited() {
        return this.maxIterations <= 0;
    }

    /** The loop condition. */
    hasStepsLeft() {
        return this.isUnlimited || this.iteration < this.maxIterations;
    }

    /** Milliseconds since the run began. */
    elapsedMs(now = Date.now()) {
        return now - this.startedAt;
    }

    /**
     * Progress for the UI bar.
     *
     * An unlimited run has no real ratio, so it gets a soft asymptotic curve that
     * creeps forward without ever claiming completion: 0.5 at step 50, ~0.66 at
     * 100, ~0.8 at 200. Reporting 100% and then continuing is worse than
     * reporting nothing.
     */
    progress() {
        return this.isUnlimited
            ? (1 - 50 / (this.iteration + 50))
            : this.iteration / this.maxIterations;
    }

    /** Begin the next step. Returns the new 1-based iteration number. */
    nextIteration() {
        this.iteration += 1;
        return this.iteration;
    }
}
