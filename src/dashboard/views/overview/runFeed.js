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

/** Lines kept in the compact feed. Enough to see what it is doing, not a log. */
export const FEED_LIMIT = 6;
/** Recalled-memory entries kept. The brief is 3; a long run adds a few more. */
export const RECALL_LIMIT = 4;

/** The phases a run passes through, in order — drives the rail's layout. */
export const PHASES = ['plan', 'execute', 'review'];

const arr = (v) => (Array.isArray(v) ? v : []);

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
                if (n) out.step = n;
                const kind = replayLineType(d.message);
                // "Thinking… (step 12)" is bookkeeping, not activity. Monitor
                // classifies it as 'tool' for the same reason; here it only
                // advances the counter.
                if (/^(Thinking|Calling LLM|Receiving)/i.test(d.message.trim())) break;
                out.steps.push({ n: out.step, kind, text: d.message });
                break;
            }
            case 'phase': {
                out.phase = d.phase || out.phase;
                out.phaseModel = d.model || out.phaseModel;
                out.escalated = !!d.escalated;
                if (d.phase) {
                    out.phaseSeen[d.phase] = {
                        model: d.model || '',
                        tokens: (d.tokens && d.tokens[d.phase]) || 0,
                    };
                }
                // Carry the token split for the phases already finished, so the
                // rail can price them without a second event per phase.
                for (const [p, tok] of Object.entries(d.tokens || {})) {
                    if (out.phaseSeen[p]) out.phaseSeen[p].tokens = tok;
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
 * Same rule as the spend panel: each model's tokens at that model's own rates.
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
        priced = true;
        total += (u.prompt - u.cacheRead) / 1e6 * r.input
            + u.cacheRead / 1e6 * r.cacheRead
            + u.completion / 1e6 * r.output;
    }
    return priced ? Math.max(0, total) : null;
}
