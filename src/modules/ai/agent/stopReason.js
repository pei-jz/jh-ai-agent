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
//
// The wording goes through the i18n catalog. These strings were hard-coded Japanese,
// which made them the most-read untranslatable text in the product: switching the UI
// to English changed the buttons and left every explanation of why a run stopped in
// Japanese. Each `t()` call passes the original Japanese as its fallback, so a missing
// key degrades to exactly what it printed before rather than to a key name.

import { t } from '../../../i18n/index.js';

/** @typedef {'step_limit'|'token_budget'|'wall_clock'} StopKind */

/**
 * Where each limit is changed. Naming the exact setting beats "adjust your settings".
 * The path itself is UI chrome, so it is translated too.
 */
const SETTING_KEY = {
    step_limit: 'stop.setting.steps',
    token_budget: 'stop.setting.tokens',
    wall_clock: 'stop.setting.wallClock',
};

const SETTING_FALLBACK = {
    step_limit: 'Settings → General → Agent Safety Limits → Max Agent Steps',
    token_budget: 'Settings → General → Agent Safety Limits → Token Budget',
    wall_clock: 'Settings → General → Agent Safety Limits → Wall-clock Timeout',
};

/**
 * A SUB-AGENT's step limit is a different setting from the run's.
 *
 * The child's cap is `subtask_max_steps`, and pointing its stop notice at "Max
 * Agent Steps" was simply false: raising that field changed nothing about the
 * child, which is the field someone would go and raise after reading this.
 *
 * Only `step_limit` differs. A child inherits a SLICE of the parent's token
 * budget and runs inside the parent's wall clock, so for those two the parent's
 * setting is genuinely the one to change.
 */
const SUB_SETTING_KEY = { step_limit: 'stop.setting.subSteps' };
const SUB_SETTING_FALLBACK = {
    step_limit: 'Settings → General → Agent Safety Limits → Max Sub-agent Steps',
};

/** Where this stop's limit is changed, given who stopped. */
function settingText(kind, subagent) {
    const key = (subagent && SUB_SETTING_KEY[kind]) || SETTING_KEY[kind];
    const fallback = (subagent && SUB_SETTING_FALLBACK[kind]) || SETTING_FALLBACK[kind];
    return key ? t(key, null, fallback) : '';
}

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
            return t('stop.status.steps', { limit }, `ステップ上限 (${limit}) に到達 — 自動停止します。`);
        case 'token_budget':
            return t('stop.status.tokens', { limit }, `トークン予算 (${limit}) に到達 — 自動停止します。`);
        case 'wall_clock':
            return t('stop.status.wallClock', { limit }, `実行時間の上限 (${limit} 分) に到達 — 自動停止します。`);
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
export function stopNotice(reason, opts = {}) {
    if (!reason) return '';
    const subagent = !!opts.subagent;
    const limit = reason.limit == null ? '' : Number(reason.limit).toLocaleString();
    // "Send this task a message to continue" is the parent's escape hatch. A
    // sub-agent has no task to message — it is one tool call inside its parent's
    // run — so telling the parent to message it describes a door that is not
    // there. What the parent CAN do is re-delegate with a narrower brief.
    const resume = subagent
        ? t('stop.resume.sub', null,
            'この報告は途中経過です。続きが必要なら、範囲を絞って再度サブタスクに出してください。')
        : t('stop.resume', null, 'このタスクにメッセージを送ると、ここから続行できます。');
    const setting = settingText(reason.kind, subagent);
    const where = setting ? t('stop.where', { setting }, `上限は ${setting} で変更できます。`) : '';

    switch (reason.kind) {
        case 'step_limit':
            if (subagent) {
                return '\n\n' + t('stop.notice.steps.sub', { limit, resume, where },
                    `⚠️ **サブエージェントは finish_task に到達しないまま停止しました。** `
                    + `ステップ数がサブエージェントの上限 ${limit} に達したためです`
                    + `（失敗ではありません）。${resume}${where}`);
            }
            return '\n\n' + t('stop.notice.steps', { limit, resume, where },
                `⚠️ **未完了のまま停止しました。** 実行ステップ数が上限 ${limit} に到達したためです`
                + `（タスクが失敗したわけではありません）。${resume}${where}`);
        case 'token_budget':
            return '\n\n' + t('stop.notice.tokens', { limit, resume, where },
                `⚠️ **未完了のまま停止しました。** 累積トークン数（サブエージェント分を含む）が`
                + `予算 ${limit} に到達したためです。${resume}${where}`);
        case 'wall_clock':
            return '\n\n' + t('stop.notice.wallClock', { limit, resume, where },
                `⚠️ **未完了のまま停止しました。** 実行時間が上限 ${limit} 分に到達したためです。`
                + `${resume}${where}`);
        default:
            return '';
    }
}

/** True when the run was cut short rather than finishing on its own terms. */
export function wasInterrupted(reason) {
    return !!reason && !!SETTING_KEY[reason.kind];
}

/**
 * The Raw Log entry for a limit stop.
 *
 * A limit was, until now, only ever a `status` line in the live feed — which is
 * exactly the surface that does NOT survive. The Raw Log is rebuilt from stored
 * telemetry, and a sub-agent's status lines are not forwarded to its parent at
 * all, so the one place a user goes to find out why a run stopped was the one
 * place that never said. This is a first-class entry so the answer is on record:
 * which limit, what the value was, how far the run got, and where to change it.
 *
 * `method: 'LIMIT'` — its own kind, not CHAT (which the log renders as a
 * step-header button covering token usage) and not an error (nothing failed).
 *
 * @param {{kind:string, limit:any, used:any}} reason
 * @param {{subagent?:boolean, iterations?:number, label?:string}} [opts]
 */
export function stopLogEntry(reason, opts = {}) {
    if (!reason) return null;
    const subagent = !!opts.subagent;
    return {
        method: 'LIMIT',
        status: 200,
        stepLabel: t('stop.log.label', null, '⚠️ 上限到達で停止'),
        response: {
            kind: reason.kind,
            limit: reason.limit,
            used: reason.used ?? opts.iterations ?? null,
            scope: subagent ? 'subagent' : 'run',
            message: stopStatusMessage(reason),
            setting: settingText(reason.kind, subagent),
        },
    };
}
