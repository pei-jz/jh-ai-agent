// runFeed — the Dashboard's compact view of a running task.
//
// This is the file that could easily have become a SECOND step renderer. It is
// not one: every line of text it produces comes from Monitor's own formatters —
// `toolLineText` / `toolTarget` for tool calls, `replayLineType` / `replayStepNo`
// for status lines. If the wording of a tool line changes in Monitor it changes
// here, because there is only one place it is written.
//
// What differs is the SHAPE, and legitimately so: Monitor builds a grouped,
// foldable, per-exchange timeline of a whole task. The Dashboard shows the last
// handful of lines of the one run that is happening now. Those are different
// products of the same data, not two renderings of it.
//
// Everything here is a pure reduction over the log array the WebSocket delivers,
// so it is testable without a socket, a task or a DOM.

import { toolLineText, toolTarget } from '../monitor/toolLine.js';
import { replayLineType, replayStepNo } from '../monitor/taskTimeline.js';
import { costOf, per1m } from '../monitor/inspector.js';

/** Lines kept in the compact feed. Enough to see what it is doing, not a log. */
export const FEED_LIMIT = 6;
/** Recalled-memory entries kept. The brief is 3; a long run adds a few more. */
export const RECALL_LIMIT = 4;

/** The phases a run passes through, in order — drives the rail's layout. */
export const PHASES = ['plan', 'execute', 'review'];

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * The events `reduceRun` actually consumes.
 *
 * Everything else on the socket leaves its result identical, and the Run pane
 * used to be rebuilt for all of them — `stream` fires ONCE PER TOKEN and
 * `command_chunk` once per line of stdout, so a generating task rebuilt the
 * whole run object and re-rendered the pane dozens of times a second. That is
 * what made the tab flicker, and on a long task it was quadratic as well: every
 * one of those packets walked the entire log array again.
 *
 * Kept next to the switch below so the two cannot drift: a new `case` there
 * needs a name here or its events will be dropped.
 */
export const RUN_EVENTS = new Set([
    'log', 'status', 'phase', 'memory_recall', 'token_usage',
    'confirm', 'ask_user', 'complete', 'error',
]);

/** Can this packet change what the Run pane shows? */
export function affectsRun(packet) {
    return RUN_EVENTS.has(packet?.event);
}

/**
 * Reduce a task's log array into everything the Run tab draws.
 *
 * One pass, one reducer. The alternative — a function per widget, each walking
 * the same array — is how the meters and the feed would end up disagreeing
 * about which step the run is on.
 *
 * @param {object[]} logs  ws packets: { event, data, timestamp }
 * @returns {{steps:object[], step:number, phase:string|null, phaseModel:string|null,
 *            phaseSeen:object, escalated:boolean, recalls:object[], tokens:object,
 *            files:Set<string>, awaiting:boolean, question:string, finished:boolean}}
 */
export function reduceRun(logs) {
    const out = {
        steps: [],
        step: 0,
        phase: null,
        phaseModel: null,
        /** phase → { model, tokens } for the phases seen so far. */
        phaseSeen: {},
        escalated: false,
        recalls: [],
        tokens: { prompt: 0, completion: 0, cacheRead: 0 },
        byModel: {},
        /** Every phase event that carried a reason: { phase, model, from, reason, at }. */
        switches: [],
        files: new Set(),
        awaiting: false,
        question: '',
        finished: false,
    };

    for (const l of arr(logs)) {
        if (!l || typeof l !== 'object') continue;
        const d = l.data || {};
        switch (l.event) {
            case 'log': {
                // Tool telemetry carries the ARGUMENTS, so the line can name the
                // file it touched. A status line only ever has the basename.
                if (d.method === 'TOOL' && d.name) {
                    const t = toolTarget(d.name, d.request);
                    out.steps.push({
                        n: out.step,
                        kind: d.status >= 400 || d.isError ? 'error' : 'tool',
                        text: toolLineText(d.name, d.request),
                        target: t.path || '',
                    });
                    if (t.write && t.path) out.files.add(t.path);
                }
                break;
            }
            case 'status': {
                if (d.status === 'aborted' || d.status === 'completed') out.finished = true;
                if (!d.message) break;
                const n = replayStepNo(d.message);
                if (n) {
                    out.step = n;
                    // A step boundary means a run is WORKING, so any earlier
                    // completion belonged to a previous turn. See the note on
                    // `finished` below: without this, a continued task looked
                    // finished for as long as its replay lasted.
                    out.finished = false;
                }
                const kind = replayLineType(d.message);
                // "Thinking… (step 12)" is bookkeeping, not activity. Monitor
                // classifies it as 'tool' for the same reason; here it only
                // advances the counter.
                if (/^(Thinking|Calling LLM|Receiving)/i.test(d.message.trim())) break;
                out.steps.push({ n: out.step, kind, text: d.message });
                break;
            }
            case 'phase': {
                // Phase routing only happens inside a live run.
                out.finished = false;
                out.phase = d.phase || out.phase;
                out.phaseModel = d.model || out.phaseModel;
                out.escalated = !!d.escalated;
                if (d.phase) {
                    out.phaseSeen[d.phase] = {
                        model: d.model || '',
                        tokens: (d.tokens && d.tokens[d.phase]) || 0,
                        reason: d.reason || '',
                    };
                }
                // Carry the token split for the phases already finished, so the
                // rail can price them without a second event per phase.
                for (const [p, tok] of Object.entries(d.tokens || {})) {
                    if (out.phaseSeen[p]) out.phaseSeen[p].tokens = tok;
                }
                // Every phase event that carries a reason — the opening pick and
                // each actual switch — is a decision the user asked to see: when
                // the model changed, and on what trigger.
                if (d.model && d.reason) {
                    out.switches.push({
                        phase: d.phase,
                        model: d.model,
                        from: d.from || null,
                        reason: d.reason,
                        at: l.timestamp || '',
                    });
                }
                break;
            }
            case 'memory_recall': {
                for (const c of arr(d.cards)) {
                    out.recalls.push({ ...c, at: d.at || out.step, source: d.source || '' });
                }
                break;
            }
            case 'token_usage': {
                out.tokens.prompt += d.prompt_tokens || 0;
                out.tokens.completion += d.completion_tokens || 0;
                out.tokens.cacheRead += d.cache_read_input_tokens || 0;
                if (d.model) {
                    const m = out.byModel[d.model] || { prompt: 0, completion: 0, cacheRead: 0 };
                    m.prompt += d.prompt_tokens || 0;
                    m.completion += d.completion_tokens || 0;
                    m.cacheRead += d.cache_read_input_tokens || 0;
                    out.byModel[d.model] = m;
                }
                break;
            }
            case 'confirm':
            case 'ask_user': {
                out.awaiting = true;
                out.question = d.question || d.message || out.question;
                break;
            }
            // ── The end of a run — not necessarily the end of the TASK ──────
            //
            // A continued task's log holds one of these per previous turn, and
            // the server replays the whole log on connect. Setting this and never
            // clearing it meant a task that was actively running read as finished
            // the moment its replay reached an old completion.
            //
            // The Dashboard acts on `finished`: it closes the socket, reloads and
            // clears the pane's tab. With the task still running it reopened the
            // socket, replayed, and did it again — a loop that reset the tab about
            // once a second, so choosing Memory or Stats snapped straight back to
            // Run. The two cases above clear the flag when work resumes, which
            // makes this mean "the last thing that happened was the end".
            case 'complete':
            case 'error':
                out.finished = true;
                break;
            default:
                break;
        }
    }

    // Newest last, capped. Taking the TAIL rather than the head: a run 40 steps
    // in should show step 40, not step 1.
    out.steps = out.steps.slice(-FEED_LIMIT);
    out.recalls = out.recalls.slice(-RECALL_LIMIT);
    return out;
}

/**
 * The phase rail: one cell per phase, with which model ran it.
 *
 * Always three cells even before the run reaches them — the point of the rail
 * is that you can see where the run IS in a sequence, and a rail that grows a
 * cell at a time cannot show that.
 *
 * @param {object} run from reduceRun
 */
export function phaseRail(run) {
    if (!run?.phase) return [];
    const order = PHASES.indexOf(run.phase);
    return PHASES.map((p, i) => ({
        phase: p,
        model: run.phaseSeen[p]?.model || '',
        tokens: run.phaseSeen[p]?.tokens || 0,
        state: i < order ? 'done' : (i === order ? 'now' : 'todo'),
    }));
}

/**
 * Cost so far, priced per model.
 *
 * Same rule as the spend panel, and through the same arithmetic: `costOf` is the
 * one place that decides whether a provider's cache reads are inside its prompt
 * count (OpenAI-compatible — DeepSeek, Kimi, Gemini) or beside it (Anthropic).
 * Subtracting unconditionally, as this used to, is wrong for the second kind.
 *
 * Returns null when nothing can be priced, so the caller shows no figure at all
 * rather than a confident "$0.00" for a run that has certainly cost something.
 */
export function runCost(run, rates) {
    if (!rates) return null;
    const byBare = {};
    for (const [k, r] of Object.entries(rates)) byBare[k.slice(k.indexOf(':') + 1)] = r;

    let total = 0;
    let priced = false;
    for (const [model, u] of Object.entries(run?.byModel || {})) {
        const r = rates[model] || byBare[model];
        if (!r) continue;
        // reduceRun accumulates under its own field names; costOf reads the
        // provider's.
        const c = costOf({
            prompt_tokens: u.prompt,
            completion_tokens: u.completion,
            cache_read_input_tokens: u.cacheRead,
            total_tokens: u.prompt + u.completion,
        }, per1m(r));
        if (!c) continue;
        priced = true;
        total += c.total;
    }
    return priced ? Math.max(0, total) : null;
}

/**
 * Per-model token + cost rows for the Run pane.
 *
 * `runCost` reduces the same data to one total; this keeps the rows so the pane
 * can show WHICH model spent the tokens and what each slice cost. Returns
 * `{ rows, total }` where `total` equals `runCost`'s result (null when nothing
 * is priced) and each row is
 * `{ model, label, prompt, completion, cacheRead, tokens, cost, priced }`.
 */
export function runCostBreakdown(run, rates) {
    const rows = [];
    const byBare = {};
    if (rates) {
        for (const [k, r] of Object.entries(rates)) byBare[k.slice(k.indexOf(':') + 1)] = r;
    }
    const bareName = (m) => {
        const s = String(m || '');
        const i = s.indexOf(':');
        return i >= 0 ? s.slice(i + 1) : (s || '(unknown)');
    };

    let total = 0;
    let priced = false;
    for (const [model, u] of Object.entries(run?.byModel || {})) {
        const r = rates ? (rates[model] || byBare[model]) : null;
        const tokens = (u.prompt || 0) + (u.completion || 0);
        let cost = null;
        if (r) {
            const c = costOf({
                prompt_tokens: u.prompt,
                completion_tokens: u.completion,
                cache_read_input_tokens: u.cacheRead,
                total_tokens: tokens,
            }, per1m(r));
            if (c) { cost = c.total; priced = true; total += cost; }
        }
        rows.push({
            model,
            label: r?.label || bareName(model),
            prompt: u.prompt || 0,
            completion: u.completion || 0,
            cacheRead: u.cacheRead || 0,
            tokens,
            cost,
            priced: !!r,
        });
    }
    rows.sort((a, b) => (b.tokens - a.tokens) || (a.model < b.model ? -1 : 1));
    return { rows, total: priced ? Math.max(0, total) : null };
}
