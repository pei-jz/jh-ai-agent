// storyExchanges — the Story at the grain of an EXCHANGE (a request through to
// its answer or its open question).
//
// Two rules, both about what the reader takes away from an exchange at a glance:
//
// 1. A run that stopped on a question has not produced a RESULT. Its closing
//    report says where things stand ("found the existing deck, asking which way
//    to go"), and showing it as "結果" — above the question, with a green frame —
//    read as "done, and also here is a question". The report is folded into the
//    question as "ここまでの報告", and the question ends the exchange.
//
// 2. A folded exchange is ONE line: status, request, the path its chapters took
//    (調査 → 変更 → 検証), the outcome in a sentence, and how long it took.
//    It used to be three stacked boxes (request band, "9 steps", "Agent · Final")
//    — the card look the Story moved away from, and three rows per exchange.
//
// PURE: items in, items out. Runs on the chaptered stream (storyChapters.js),
// before the live task_progress card is pinned.

import { spanLabel } from './timelineItems.js';

/** An outcome the run produced itself (not a present_result deliverable). */
const isRunReport = (i) => i.kind === 'run' || (i.kind === 'document' && i.fromRun);
const OUTCOME = new Set(['run', 'deliverable', 'document']);
/** A question nobody has answered: still open, or closed by the run ending. */
export const isOpenAsk = (i) => i?.kind === 'ask' && (!i.answered || !!i.unanswered);

/** Split a stream into exchanges. Index 0 holds anything before the first request. */
function exchangesOf(items) {
    const out = [{ ex: 0, items: [] }];
    let ex = 0;
    for (const item of items) {
        if (item?.kind === 'request') { ex += 1; out.push({ ex, items: [] }); }
        out[out.length - 1].items.push(item);
    }
    return out;
}

/**
 * The plan sits at the TOP of its exchange, once, in its latest state.
 *
 * The checklist card used to sit wherever the plan first registered, then get
 * pinned to the bottom while the run was live — below the chapter actually being
 * written, which pushed the "now" marker and the Working bar away from each
 * other. A replan also left the old card standing, so two checklists showed.
 * Under the request is where a plan reads as the plan; and lifting it out of the
 * flow means it no longer splits one phase into two "調査" chapters.
 */
export function withPlanOnTop(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    for (const { items: xs } of exchangesOf(list)) {
        const plans = xs.filter(i => i?.kind === 'task_progress');
        if (!plans.length) { out.push(...xs); continue; }
        const plan = plans[plans.length - 1];
        const rest = xs.filter(i => i?.kind !== 'task_progress');
        const at = rest[0]?.kind === 'request' ? 1 : 0;
        rest.splice(at, 0, plan);
        out.push(...rest);
    }
    return out;
}

/**
 * Rule 1: an exchange that ends on an open question shows no result.
 *
 * The run's closing report moves INTO the last open question (`_interim`), and
 * that question moves to the end of the exchange.
 */
export function withInterimReports(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    for (const { items: xs } of exchangesOf(list)) {
        const asks = xs.filter(isOpenAsk);
        if (!asks.length) { out.push(...xs); continue; }
        const last = asks[asks.length - 1];
        const reports = xs.filter(isRunReport);
        const rest = xs.filter(i => i !== last && !reports.includes(i));
        const report = reports[reports.length - 1];
        rest.push(report ? {
            ...last,
            _interim: {
                text: report.text ?? report.answer ?? '',
                files: report.files || [],
                stats: report.stats || {},
            },
        } : last);
        out.push(...rest);
    }
    return out;
}

/** Markdown → one plain sentence. */
function plain(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Emphasis goes with no gap: a space in its place split "**19枚**に" in two.
        .replace(/(\*\*|__|~~|\*)(\S(?:.*?\S)?)\1/g, '$2')
        .replace(/[*_~>#|]+/g, ' ')
        .replace(/^\s*[-+]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const RESULT_HEAD = /^#{1,6}\s*(結果|成果|まとめ|要約|結論|Result|Results|Summary|Outcome|Conclusion)(?![A-Za-z])/i;   // not \b: it never matches after 結果

/**
 * The one sentence an exchange's outcome comes down to.
 *
 * Closing reports are usually sectioned (依頼内容 / 実施内容 / 結果), so the
 * first line of the report is the REQUEST restated. The first line under a
 * result-like heading is the answer; failing that, the first line that is not
 * a heading.
 */
export function outcomeLine(text, max = 90) {
    const lines = String(text || '').split(/\r?\n/);
    const s = plain(lines[leadIndex(lines)] || '');
    return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

/** Index of the line outcomeLine picks, or -1. */
function leadIndex(lines) {
    const isBody = (l) => l.trim() && !/^\s*#/.test(l);
    const under = lines.findIndex(l => RESULT_HEAD.test(l.trim()));
    if (under >= 0) {
        const i = lines.findIndex((l, k) => k > under && isBody(l));
        if (i >= 0) return i;
    }
    return lines.findIndex(isBody);
}

/**
 * The outcome sentence, and the report WITHOUT it.
 *
 * The Story's result leads with that sentence, so leaving it in the body too
 * printed it twice. A result heading left with nothing under it goes as well.
 *
 * @returns {{lead: string, rest: string}}
 */
export function splitLead(text) {
    const lines = String(text || '').split(/\r?\n/);
    const i = leadIndex(lines);
    if (i < 0) return { lead: '', rest: String(text || '') };
    const lead = plain(lines[i]);
    const rest = lines.slice(0, i).concat(lines.slice(i + 1));
    // The heading it sat under, if that section is now empty.
    let h = i - 1;
    while (h >= 0 && !rest[h].trim()) h--;
    if (h >= 0 && /^\s*#/.test(rest[h])) {
        const next = rest.slice(h + 1).find(l => l.trim());
        if (next === undefined || /^\s*#/.test(next)) rest.splice(h, 1);
    }
    return { lead, rest: rest.join('\n').trim() };
}

/** Chapter path for the digest: roles in order, repeats collapsed. */
function pathOf(xs) {
    const path = [];
    for (const i of xs) {
        const step = i.kind === 'phase' ? i.role
            : (i.kind === 'ask' || i.kind === 'confirm') ? 'decide' : null;
        if (step && path[path.length - 1] !== step) path.push(step);
    }
    return path.length > 5 ? [...path.slice(0, 4), '…'] : path;
}

function statusOf(xs) {
    if (xs.some(isOpenAsk)) return 'waiting';
    if (xs.some(i => i.live)) return 'running';
    if (xs.some(i => OUTCOME.has(i.kind))) return 'done';
    if (xs.some(i => i.kind === 'error')) return 'failed';
    return 'stopped';
}

/** One folded exchange as a single row. */
export function digestOf(ex, xs) {
    const req = xs.find(i => i.kind === 'request');
    const status = statusOf(xs);
    const ask = [...xs].reverse().find(isOpenAsk);
    const report = [...xs].reverse().find(i => OUTCOME.has(i.kind));
    const outcome = status === 'waiting' && ask
        ? plain(ask.text)
        : outcomeLine(report ? (report.text ?? report.answer) : '');
    const times = xs.flatMap(i => [i.at, i.to]).filter(Number.isFinite);
    return {
        id: `digest:${req?.id ?? ex}`,
        rev: xs.reduce((n, i) => n + (i.rev || 0), 0),
        kind: 'digest',
        ex,
        text: plain(req?.text),
        status,
        path: pathOf(xs),
        outcome,
        at: times.length ? Math.min(...times) : undefined,
        to: times.length ? Math.max(...times) : undefined,
        live: status === 'running',
    };
}

/**
 * A finished run's numbers as words for one quiet line under the result, the
 * way a chapter lists what it did — not as chips in a header band.
 *
 * @param {object} stats run stats ({steps, tools, tokens, durationMs})
 * @param {Function} t i18n lookup
 * @returns {string[]}
 */
export function resultStats(stats = {}, t = (k) => k) {
    const s = stats || {};
    const parts = [];
    if (s.steps) parts.push(t('story.stat.steps', { n: s.steps }));
    const tools = Object.values(s.tools || {}).reduce((a, c) => a + (c || 0), 0);
    if (tools) parts.push(t('story.stat.tools', { n: tools }));
    if (s.tokens) parts.push(`${s.tokens >= 1000 ? (s.tokens / 1000).toFixed(1) + 'k' : s.tokens} tok`);
    const dur = spanLabel(Math.round((s.durationMs || 0) / 1000));
    if (dur) parts.push(dur);
    return parts;
}

/**
 * Rule 2: a folded exchange is one digest row.
 *
 * Replaces withExchangeFolds on the Story path. The halves still fold apart
 * while an exchange is OPEN (the result's own header folds it to one line), but
 * folding the working — the request's marker, or "collapse all" — folds the
 * whole exchange into its digest.
 *
 * @param {Array<object>} items chaptered stream
 * @param {{working?: Set<number>, outcome?: Set<number>}} folds 1-based exchange numbers
 */
export function withStoryFolds(items, folds = {}) {
    const list = Array.isArray(items) ? items : [];
    const working = folds?.working instanceof Set ? folds.working : new Set();
    const outcome = folds?.outcome instanceof Set ? folds.outcome : new Set();
    const out = [];
    for (const { ex, items: xs } of exchangesOf(list)) {
        if (ex > 0 && working.has(ex)) {
            out.push(digestOf(ex, xs));
            continue;
        }
        for (const item of xs) {
            // Turn dividers only separate OPEN exchanges; a digest row is its own
            // boundary.
            if (item.kind === 'turn' && out[out.length - 1]?.kind === 'digest') continue;
            if (item.kind === 'request') {
                out.push({ ...item, _ex: ex, _folded: false });
            } else if (OUTCOME.has(item.kind)) {
                out.push(outcome.has(ex)
                    ? { ...item, _ex: ex, _bodyless: true, rev: (item.rev || 0) + 1 }
                    : { ...item, _ex: ex, _story: true });
            } else {
                out.push(item);
            }
        }
    }
    // A divider right after a digest was skipped above; one right BEFORE a
    // digest separates nothing either.
    return out.filter((it, i) => !(it.kind === 'turn' && out[i + 1]?.kind === 'digest'));
}
