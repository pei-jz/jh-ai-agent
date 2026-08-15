// Plan-first approval wording + revision detection.
//
// Split out of AgentController.js so these helpers can be unit-tested without
// loading the whole agent stack (LLMService & co. touch Tauri at import time).
//
// The approval question and its choices are built by the AGENT (they are part of
// the plan-first prompt), but the UI renders them as clickable buttons. The
// ✏️-prefixed option is special: the UI recognizes it and, instead of sending the
// option text verbatim, shows a "enter your changes" box and sends the user's
// typed revision as the answer. The prefix is what lets the UI tell the two
// options apart without hard-coding a language.

import { getLocale } from '../../../i18n/index.js';

/** The marker prefix on the plan-revision option / answer. */
export const PLAN_REVISE_PREFIX = '✏️';

/**
 * The ask_user question + options for the plan-first approval gate, in the
 * UI display language (getLocale) so the buttons match the rest of the app.
 */
export function planApprovalQuestion() {
    const locale = getLocale();
    if (locale === 'en') {
        return {
            question: 'Shall I proceed with this plan?\n\nTo approve, choose “Yes, proceed with this plan”.\nTo revise the plan, choose “✏️ Request changes” and type what you want changed.',
            options: ['Yes, proceed with this plan', '✏️ Request changes'],
        };
    }
    return {
        question: 'この計画で実装を進めてよろしいですか？\n\n承認する場合は「はい、この計画で進めてください」を選んでください。\n計画を修正したい場合は「✏️ 修正を指示する」を選び、修正内容を入力してください。',
        options: ['はい、この計画で進めてください', '✏️ 修正を指示する'],
    };
}

/**
 * True when a continuation/steering text is a plan-revision request (the user
 * picked the ✏️ option and typed what they want changed). Such a reply must
 * RE-OPEN the plan-first gate instead of letting the run proceed to edit.
 */
export function isPlanRevision(text) {
    const s = String(text || '');
    return s.includes(PLAN_REVISE_PREFIX)
        || /計画(を|の)?修正|プラン修正|revise\s+the\s+plan|request\s+changes|plan\s+revision/i.test(s);
}

/**
 * Strip the revision marker line from a typed revision so only the user's own
 * words reach the agent ("✏️ 計画修正: 変更対象ファイルを絞る" → "変更対象ファイルを絞る").
 */
export function stripPlanRevisionMarker(text) {
    return String(text || '').replace(/^\s*✏️[^\n]*\n?/, '').trim();
}
