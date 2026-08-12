// stopReason — why a run ended when it was not the agent's decision.
//
// A run can stop for four reasons. Only one of them means "the work is done":
//
//   finish_task    the agent decided it was finished          → a real completion
//   step_limit     it ran out of allowed steps                → INTERRUPTED
//   token_budget   it ran out of budgeted tokens              → INTERRUPTED
//   wall_clock     it ran out of allowed minutes              → INTERRUPTED
//
// The three interruptions used to be reported by appending a parenthetical to the
// final summary and then completing normally. That is why a capped run looked like
// "the processing just stopped": the task went green, and the only trace of the
// reason was a sentence at the end of a summary the user had no reason to re-read.
//
// So the reason is a value now. It travels with the result (TaskBridge puts it on the
// `complete` event), the wording lives here so all three sites agree, and every
// message says the two things a user actually needs: which limit, and how to carry on.

/** @typedef {'step_limit'|'token_budget'|'wall_clock'} StopKind */

/** Where each limit is changed. Naming the exact setting beats "adjust your settings". */
const SETTING = {
    step_limit: 'Settings → General → Agent Safety Limits → Max Agent Steps',
    token_budget: 'Settings → General → Agent Safety Limits → Token Budget',
    wall_clock: 'Settings → General → Agent Safety Limits → Wall-clock Timeout',
};

/**
 * Build a stop reason.
 *
 * @param {StopKind} kind
 * @param {{limit?: number|string, used?: number|string}} [facts]
 */
export function stopReason(kind, facts = {}) {
    return { kind, limit: facts.limit ?? null, used: facts.used ?? null };
}

/** Short line for the live status feed, so the stop is visible as it happens. */
export function stopStatusMessage(reason) {
    if (!reason) return '';
    const limit = reason.limit == null ? '' : Number(reason.limit).toLocaleString();
    switch (reason.kind) {
        case 'step_limit':
            return `ステップ上限 (${limit}) に到達 — 自動停止します。`;
        case 'token_budget':
            return `トークン予算 (${limit}) に到達 — 自動停止します。`;
        case 'wall_clock':
            return `実行時間の上限 (${limit} 分) に到達 — 自動停止します。`;
        default:
            return '';
    }
}

/**
 * The note appended to the final summary.
 *
 * Every variant ends with how to resume, because the run is interrupted rather than
 * failed: the work so far is intact and sending another message continues it. Without
 * that sentence the honest reading of "停止しました" is "start over".
 */
export function stopNotice(reason) {
    if (!reason) return '';
    const limit = reason.limit == null ? '' : Number(reason.limit).toLocaleString();
    const resume = 'このタスクにメッセージを送ると、ここから続行できます。';
    const setting = SETTING[reason.kind];
    const where = setting ? `上限は ${setting} で変更できます。` : '';

    switch (reason.kind) {
        case 'step_limit':
            return `\n\n⚠️ **未完了のまま停止しました。** 実行ステップ数が上限 ${limit} に到達したためです`
                + `（タスクが失敗したわけではありません）。${resume}${where}`;
        case 'token_budget':
            return `\n\n⚠️ **未完了のまま停止しました。** 累積トークン数（サブエージェント分を含む）が`
                + `予算 ${limit} に到達したためです。${resume}${where}`;
        case 'wall_clock':
            return `\n\n⚠️ **未完了のまま停止しました。** 実行時間が上限 ${limit} 分に到達したためです。`
                + `${resume}${where}`;
        default:
            return '';
    }
}

/** True when the run was cut short rather than finishing on its own terms. */
export function wasInterrupted(reason) {
    return !!reason && !!SETTING[reason.kind];
}
