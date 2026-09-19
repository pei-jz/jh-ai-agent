// PartialReport — what a run has to show for itself when a limit cuts it off.
//
// A run that stops on `finish_task` hands back a report the model wrote. A run
// that stops on a LIMIT hands back whatever `finalResponse` happened to hold,
// and on the common path that is the empty string: the model was mid-tool-call
// when the step counter ran out, so it never wrote a summary. The caller then
// receives the stop notice alone.
//
// For a sub-agent that is the whole result. Its parent gets
// "⚠️ 未完了のまま停止しました" and not one sentence of what the child read,
// found or concluded — four read-only researchers can spend twenty minutes and
// return nothing at all, which is the failure this module exists to prevent.
//
// So the loop keeps a TRAIL: the model's own per-step `thought` text and the
// tool calls it made. When a limit ends the run with no deliverable, the trail
// is folded into a clearly-labelled partial report. It is deliberately
// mechanical — assembled from what was recorded, never generated — because the
// one thing worse than no report is a synthesized one that reads like findings.
//
// Pure: no I/O, no LLM, no `this`. The controller records into the array and
// composes from it; everything here is testable on plain data.

import { t } from '../../../i18n/index.js';

/** Steps kept in the trail. Older entries fall off the front (ring buffer). */
export const TRAIL_MAX_STEPS = 80;

/** Per-thought clip. Long enough for a finding, short enough for twenty of them. */
const THOUGHT_MAX = 400;
/** Per-error clip — the reason a call failed, not its stack. */
const ERROR_MAX = 200;
/** Thought entries shown, newest-biased but printed in run order. */
const THOUGHTS_SHOWN = 10;
/** Steps of tool activity shown. */
const STEPS_SHOWN = 15;
/** Hard ceiling on the composed report. */
export const REPORT_MAX_CHARS = 6000;

const clip = (s, n) => {
    const text = String(s ?? '').replace(/\s+/g, ' ').trim();
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
};

/**
 * Find (or create) the trail entry for a step.
 *
 * One entry per step rather than one per event: a step is what the reader
 * counts in ("止まった 20 ステップで何をしたのか"), and the thought and the
 * tool calls it led to belong to the same line.
 */
function entryFor(trail, step) {
    const n = Number(step) || 0;
    let e = trail.length && trail[trail.length - 1].step === n
        ? trail[trail.length - 1]
        : null;
    if (!e) {
        e = { step: n, thought: '', tools: [] };
        trail.push(e);
        while (trail.length > TRAIL_MAX_STEPS) trail.shift();
    }
    return e;
}

/**
 * Record the model's own words for this step.
 *
 * The `thought` is the closest thing to a finding the loop ever sees on a step
 * that is not the last one — it is the model narrating what it just learned.
 */
export function noteThought(trail, { step, text } = {}) {
    if (!Array.isArray(trail)) return trail;
    const thought = clip(text, THOUGHT_MAX);
    if (!thought) return trail;
    entryFor(trail, step).thought = thought;
    return trail;
}

/**
 * Record what the step actually did.
 *
 * @param {Array} trail
 * @param {{step:number, tools:Array<{name:string, hint?:string, ok?:boolean, error?:string}>}} o
 */
export function noteTools(trail, { step, tools } = {}) {
    if (!Array.isArray(trail) || !Array.isArray(tools) || tools.length === 0) return trail;
    const e = entryFor(trail, step);
    for (const tool of tools) {
        if (!tool || !tool.name) continue;
        const row = { name: String(tool.name), hint: clip(tool.hint, 80), ok: tool.ok !== false };
        if (!row.ok && tool.error) row.error = clip(tool.error, ERROR_MAX);
        e.tools.push(row);
    }
    return trail;
}

/** One "read_file(src/a.js)" / "glob(src/**) ✗" line fragment. */
function toolText(tool) {
    const call = tool.hint ? `${tool.name}(${tool.hint})` : tool.name;
    return tool.ok ? call : `${call} ✗`;
}

/**
 * Is there anything here worth printing?
 *
 * A trail of nothing but successful `list_files` calls and no thoughts says
 * less than the stop notice already does, so it is not worth the tokens.
 */
export function hasSubstance(trail) {
    if (!Array.isArray(trail)) return false;
    return trail.some(e => e.thought || (e.tools && e.tools.length));
}

/**
 * Fold the trail into a partial report.
 *
 * Returns '' when there is nothing to say, so the caller can append
 * unconditionally.
 *
 * @param {Array} trail
 * @param {{subagent?:boolean, maxChars?:number}} [opts]
 * @returns {string} markdown, or ''
 */
export function composePartialReport(trail, opts = {}) {
    if (!hasSubstance(trail)) return '';
    const maxChars = opts.maxChars || REPORT_MAX_CHARS;

    const heading = t('partial.heading', null,
        '### 途中経過（自動生成 — 上限で打ち切られたため、モデル自身の最終レポートはありません）');
    const preamble = opts.subagent
        ? t('partial.preamble.sub', null,
            'このサブエージェントは finish_task に到達しませんでした。以下は実行記録から機械的に組み立てたもので、'
            + '要約ではなく「各ステップでモデルが述べたこと」と「実際に行った操作」そのものです。')
        : t('partial.preamble', null,
            '以下は実行記録から機械的に組み立てたものです（要約ではありません）。'
            + '各ステップでモデルが述べたことと、実際に行った操作です。');

    const withThoughts = trail.filter(e => e.thought).slice(-THOUGHTS_SHOWN);
    const withTools = trail.filter(e => e.tools && e.tools.length).slice(-STEPS_SHOWN);

    const parts = [heading, preamble];

    if (withThoughts.length) {
        parts.push(t('partial.notes', null, '**作業メモ（モデル自身の記述）**') + '\n'
            + withThoughts.map(e => `- step ${e.step}: ${e.thought}`).join('\n'));
    }

    if (withTools.length) {
        parts.push(t('partial.actions', null, '**実行した操作**') + '\n'
            + withTools.map(e => `- step ${e.step}: ${e.tools.map(toolText).join(', ')}`).join('\n'));
    }

    // Errors last and only if they happened: a run that died with a wall of
    // failing calls stopped for a reason its parent can act on, and that reason
    // is invisible in the tool list above (which shows only a ✗).
    const errors = [];
    for (const e of withTools) {
        for (const tool of e.tools) {
            if (tool.error) errors.push(`- step ${e.step} ${tool.name}: ${tool.error}`);
        }
    }
    if (errors.length) {
        parts.push(t('partial.errors', null, '**エラー**') + '\n' + errors.slice(-5).join('\n'));
    }

    const report = parts.join('\n\n');
    return report.length > maxChars ? report.slice(0, maxChars - 1) + '…' : report;
}
