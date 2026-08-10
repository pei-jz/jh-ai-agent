// taskTimeline — ONE ordered model of a task's conversation.
//
// The Task view used to keep the same conversation in eight separate DOM slots
// (runs / pending / live-deliverable / narration / activity feed / confirm /
// ask / files-bar), each mutated by its own handler with innerHTML and
// show/hide. Nothing owned the order, so the bugs were all of one family:
// content appearing twice, vanishing on completion, or landing in the wrong
// place after navigating away and back.
//
// This module is the single source of truth. Events go in; an ordered list of
// typed items comes out. It is PURE — no DOM, no Tauri — so the ordering rules
// are unit-testable, which the old imperative version could not be.
//
// The same reducer serves BOTH the live socket and a page reload (replaying
// stored logs through it). That is deliberate: the previous code had separate
// live and reload paths, and a run could show up in one but not the other.
//
// Item shapes (all carry `id` and `rev`; `rev` bumps on mutation so a renderer
// can tell "same item, changed" from "new item"):
//   {kind:'request',     text}
//   {kind:'group',       head:{type,text}, lines:[{type,text}]}   reasoning + its steps
//   {kind:'activity',    type, text}                              line before any reasoning
//   {kind:'narration',   text}                                    streamed prose
//   {kind:'deliverable', envKind, text}                           present_result
//   {kind:'ask',         text, options[], multi}                  ask_user — question AND choices
//   {kind:'confirm',     text, payload}                           pending approval
//   {kind:'run',         request, answer, files[], stats}         a completed exchange
//   {kind:'error',       text}

import { toolTarget, toolLineText } from './toolLine.js';

/**
 * The human-readable body of a present_result envelope.
 * Shared so the live socket and a replay of stored `result` events extract the
 * SAME text — they used to have separate copies of this rule.
 */
export function envelopeText(env) {
    const p = env?.payload || {};
    if (typeof p.md === 'string' && p.md.trim()) return p.md;
    if (typeof p.text === 'string' && p.text.trim()) return p.text;
    if (typeof p.markdown === 'string' && p.markdown.trim()) return p.markdown;
    if (Array.isArray(p.files) && p.files.length) {
        return p.files.map(f => `- ${f?.path || f}`).join('\n');
    }
    return String(env?.summary || '').trim();
}

/**
 * Item timestamps are stored as EPOCH MILLISECONDS, not as "HH:MM:SS".
 *
 * They were a formatted string, which meant the model held a rendering: it could
 * not be compared, sorted, or re-derived, and an item that inherited another's
 * `at` inherited a display value with no way to tell it was wrong. Formatting
 * happens at render time (see clockText).
 */
export function clockNow(d = new Date()) {
    return d.getTime();
}

/** Epoch ms from a stored log timestamp, so a replay keeps the real times. */
export function clockOf(ts) {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
}

/** HH:MM:SS for display. */
export function clockText(at) {
    if (!Number.isFinite(at)) return '';
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Recover a replayed status line's TYPE from its own text.
 *
 * The stored log keeps the rendered message but not the type the live path
 * passed alongside it, so the distinction has to be read back out of the
 * prefixes that formatter produces: "⚙ Running: …" / "✓ tool: …" are mechanical,
 * "⚠"/"↻" are failures, and anything else is the model's reasoning.
 */
export function replayLineType(message) {
    const m = String(message || '').trim();
    if (/^[⚠↻]/.test(m) || /^Error/i.test(m)) return 'error';
    if (/^[⚙✓]/.test(m) || /^🤖/.test(m)) return 'tool';
    if (/^⏸/.test(m)) return 'confirm';
    // Machine chatter, not reasoning. Treating these as thoughts opened a new
    // step for each one — a 29-step run replayed as 112 numbered cards. Matched
    // on the exact phrasings the view emits (with their trailing ellipsis or
    // colon), so a real sentence that merely starts with "Running" is untouched.
    if (/^(Thinking\.{3}|Thinking…|Calling LLM|Receiving|Searching:|Presenting result|Asking the user:|Running:|Awaiting)/i.test(m)) {
        return 'tool';
    }
    return 'thought';
}

/** The agent's own step number, when a status line carries one. */
export function replayStepNo(message) {
    const m = String(message || '').match(/\(step (\d+)\)/);
    return m ? Number(m[1]) : null;
}

/** Feed line types that open a new reasoning group. */
const THINK_TYPES = new Set(['thought', 'live']);

/** Cap on retained live items so a long run can't grow without bound. */
const DEFAULT_MAX_LIVE = 40;

export class TaskTimeline {
    constructor({ maxLive = DEFAULT_MAX_LIVE } = {}) {
        this._maxLive = maxLive;
        this.reset();
    }

    reset() {
        /** @type {Array<object>} ordered items */
        this._items = [];
        this._seq = 0;
        this._group = null;      // open reasoning group, if any
        this._narration = null;  // open narration item, if any
        this._clock = null;      // replay clock; null = wall-clock (live)
        this._stepNo = 0;        // monotonic step counter for the rail
    }

    get items() { return this._items; }

    /** Items still belonging to the in-flight run (dropped when it completes). */
    get liveItems() {
        return this._items.filter(i => i.live);
    }

    _add(item) {
        this._seq += 1;
        // Every chapter is stamped. During a REPLAY the clock must come from the
        // log, not from now — otherwise a whole run reads as having happened in
        // the second it took to redraw. setClock() supplies it.
        const full = { id: `i${this._seq}`, rev: 0, live: false, at: this._clock || clockNow(), ...item };
        this._items.push(full);
        return full;
    }

    /**
     * Use `ts` as the timestamp for items added from here on.
     * @param {string|null} ts an ISO timestamp from a log entry; null returns to
     *   wall-clock time (the live path).
     */
    setClock(ts) {
        this._clock = ts ? clockOf(ts) : null;
        return this;
    }

    /** Mutating an item must bump `rev` or the renderer will skip it. */
    _touch(item) {
        item.rev += 1;
        return item;
    }

    /**
     * Trim live items to the cap. Runs, requests and asks are never trimmed —
     * losing the question or a finished exchange is far worse than a long feed.
     */
    _trim() {
        // Only the TRANSIENT items are capped. Steps are the story — a long run
        // has to show all of them, and folded they cost one line each — so they
        // are never trimmed, however many there are.
        const live = this._items.filter(i => i.live && (i.kind === 'activity' || i.kind === 'narration'));
        const excess = live.length - this._maxLive;
        if (excess <= 0) return;
        const doomed = new Set(live.slice(0, excess).map(i => i.id));
        this._items = this._items.filter(i => !doomed.has(i.id));
        if (this._group && doomed.has(this._group.id)) this._group = null;
        if (this._narration && doomed.has(this._narration.id)) this._narration = null;
    }

    // ── Producers ──────────────────────────────────────────────────────────

    /**
     * The user's message that starts (or continues) a run.
     *
     * `images` are the data URLs of anything attached to it. They ride on the item
     * so the attachment stays visible after sending — previously the thumbnails
     * lived in a separate pending-bubble slot and were lost the moment the run
     * produced its first line.
     */
    pushRequest(text, images = null) {
        const t = String(text || '').trim();
        if (!t) return null;
        const item = { kind: 'request', text: t, live: true };
        if (Array.isArray(images) && images.length) item.images = images.slice(0, 8);
        return this._add(item);
    }

    /**
     * One line of live activity. A reasoning line opens a group; everything
     * after it nests inside until the next reasoning line.
     *
     * `meta` carries the structured target of a tool call ({tool, path, write}),
     * so a step can offer the file it touched as a link instead of burying the
     * path inside prose.
     */
    pushActivity(type, text, meta = null) {
        const t = String(text ?? '').trim();
        if (!t) return null;
        const kind = String(type || 'live');

        if (kind === 'question') {
            // A question ends the current reasoning — it is not part of it.
            this._group = null;
            return null;   // the ask item carries the question; see pushAsk()
        }
        if (THINK_TYPES.has(kind)) {
            // Folding lives in the MODEL, not as a class the view pokes onto a
            // node after rendering: a DOM-side pass raced with re-renders and
            // left more than one group open. Opening a new step folds every
            // earlier one, so exactly the current step is expanded.
            for (const g of this._items) {
                if (g.kind === 'group' && !g.collapsed) { g.collapsed = true; this._touch(g); }
            }
            // Step numbers are assigned once, at creation. Deriving them at
            // render time would renumber the whole story whenever an earlier
            // item was trimmed.
            this._stepNo = (this._stepNo || 0) + 1;
            this._group = this._add({
                kind: 'group', head: { type: kind, text: t }, lines: [],
                collapsed: false, live: true, _stepNo: this._stepNo,
            });
            this._narration = null;
            this._trim();
            return this._group;
        }
        const line = { type: kind, text: t };
        if (meta && meta.tool) {
            line.tool = String(meta.tool);
            if (meta.path) line.path = String(meta.path);
            if (meta.write) line.write = true;
        }
        if (this._group) {
            this._group.lines.push(line);
            return this._touch(this._group);
        }
        // Before the first reasoning of a run.
        const item = this._add({ kind: 'activity', ...line, live: true });
        this._trim();
        return item;
    }

    /** Streamed prose. Repeated calls REPLACE the open narration, not append. */
    pushNarration(text) {
        const t = String(text ?? '');
        if (!t.trim()) return null;
        if (this._narration) {
            this._narration.text = t;
            return this._touch(this._narration);
        }
        this._narration = this._add({ kind: 'narration', text: t, live: true });
        this._trim();
        return this._narration;
    }

    /** End the open narration so the next prose starts a new bubble. */
    closeNarration() {
        this._narration = null;
    }

    /**
     * A present_result envelope. Only ONE live deliverable is kept: models
     * sometimes emit a good envelope then an empty one, and the empty follow-up
     * must not replace real content.
     */
    pushDeliverable(envKind, text) {
        const t = String(text ?? '').trim();
        const existing = this._items.find(i => i.kind === 'deliverable' && i.live);
        if (existing) {
            if (!t) return existing;                 // keep the good one
            existing.envKind = envKind || existing.envKind;
            existing.text = t;
            return this._touch(existing);
        }
        if (!t) return null;
        return this._add({ kind: 'deliverable', envKind: envKind || 'markdown', text: t, live: true });
    }

    /**
     * ask_user. The question text and the choices live in ONE item, so a
     * renderer cannot put them in two places — the reported "where is the
     * question?" problem, which was worst for free-text asks where the question
     * had no card at all and only lived inside a collapsed activity feed.
     */
    pushAsk({ text, options = [], multi = false } = {}) {
        const q = String(text || '').replace(/^❓\s*/, '').trim();
        if (!q) return null;
        this._group = null;
        const opts = (Array.isArray(options) ? options : []).filter(o => typeof o === 'string' && o.trim());
        const open = this._items.find(i => i.kind === 'ask' && !i.answered);
        if (open) {
            open.text = q;
            open.options = opts;
            open.multi = !!multi;
            return this._touch(open);
        }
        return this._add({ kind: 'ask', text: q, options: opts, multi: !!multi, answered: false, live: true });
    }

    /**
     * Mark the open question answered. It stays visible until the run it belongs
     * to completes — at which point the run's own `request` carries the answer,
     * so keeping the card would show the same exchange twice. Replaying stored
     * logs reconstructs only UNANSWERED questions, so this also keeps the live
     * view and a reloaded one identical.
     */
    resolveAsk(answer = '') {
        const open = this._items.find(i => i.kind === 'ask' && !i.answered);
        if (!open) return null;
        open.answered = true;
        open.answer = String(answer || '');
        return this._touch(open);
    }

    /** A pending approval. Only one can be outstanding. */
    pushConfirm(text, payload = null) {
        const t = String(text || '').trim();
        if (!t) return null;
        const open = this._items.find(i => i.kind === 'confirm' && !i.resolved);
        if (open) {
            open.text = t;
            open.payload = payload;
            return this._touch(open);
        }
        return this._add({ kind: 'confirm', text: t, payload, resolved: false, live: true });
    }

    resolveConfirm() {
        const open = this._items.find(i => i.kind === 'confirm' && !i.resolved);
        if (!open) return null;
        open.resolved = true;
        this._items = this._items.filter(i => i !== open);
        return open;
    }

    pushError(text) {
        const t = String(text || '').trim();
        if (!t) return null;
        return this._add({ kind: 'error', text: t, live: true });
    }

    /**
     * Fold or unfold one card, by item id.
     *
     * The MODEL owns this flag — it flips it itself (opening a step folds the earlier
     * ones; a completed run folds them all), so the renderer must never keep its own
     * copy. This is the only way in from the view.
     *
     * @returns {boolean} true when something changed (caller should re-render)
     */
    setCollapsed(id, collapsed) {
        const item = this._items.find(i => i.id === id);
        if (!item) return false;
        const next = !!collapsed;
        if (!!item.collapsed === next) return false;
        item.collapsed = next;
        this._touch(item);
        return true;
    }

    /**
     * Settle the open live request WITHOUT a run summary to fold it into.
     *
     * `pushRun` is the normal way a request stops being live, but a run can end
     * with no summary at all (a mid-run steer that folded into the current run, or
     * a completion carrying only a message). Left live, the request is a candidate
     * for `_trim` and for `clearLive` — which is how a just-sent follow-up could
     * disappear from the view the moment the run ended.
     *
     * @returns {boolean} true when something was settled (caller should re-render)
     */
    settleRequest() {
        const liveReq = this._items.find(i => i.kind === 'request' && i.live);
        if (!liveReq) return false;
        liveReq.live = false;
        this._touch(liveReq);
        return true;
    }

    /**
     * A run finished. The completed exchange REPLACES the live trace it
     * produced — that is what makes the view settle instead of accumulating
     * two representations of the same work.
     *
     * An UNANSWERED question survives: ask_user pausing the agent also ends a
     * run, and dropping the question there would strand the user.
     */
    pushRun(summary) {
        if (!summary) return null;
        const answer = String(summary.answer || summary.summary || '');

        // Where this exchange BEGAN, captured before anything is settled. The
        // request belongs at the head of its own exchange, stamped with the time
        // it was sent. It used to be derived from `summary.request` at the run's
        // own position, which put the user's message after the steps it caused
        // and gave it the run's COMPLETION time — the reported "the request moved
        // below the steps, and its clock changed".
        const startIdx = this._items.findIndex(i => i.live);
        const startAt = startIdx >= 0 ? this._items[startIdx].at : (this._clock || clockNow());

        // A deliverable the answer does NOT contain must survive. The agent can
        // present a report and then pause on a question, in which case the run's
        // `answer` is only its closing thought — dropping the deliverable made
        // the report the user had been reading disappear on completion.
        const kept = this._items.filter(i =>
            i.live && i.kind === 'deliverable' && i.text && !answer.includes(i.text.slice(0, 200)));
        for (const d of kept) d.live = false;

        // The reasoning steps SURVIVE, folded. They are how the run got to its
        // answer, and throwing them away on completion meant the story could only
        // be read while it was still being written. Folded they cost one line
        // each, which is a fair price for keeping the record.
        for (const g of this._items) {
            if (g.kind !== 'group') continue;
            g.live = false;
            if (!g.collapsed) { g.collapsed = true; }
            this._touch(g);
        }

        // A still-open question belongs AFTER the exchange that produced it: the
        // run carries the original request, so leaving the question above it read
        // as "answer this — and here, below, is what you asked for" — backwards.
        const pendingAsk = this._items.filter(i => i.kind === 'ask' && !i.answered);

        // Settle the LIVE request in place instead of synthesising a new one:
        // it already sits ahead of the steps with the right timestamp, so simply
        // marking it finished puts the exchange in chronological order for free.
        const liveReq = this._items.find(i => i.kind === 'request' && i.live);
        if (liveReq) {
            liveReq.live = false;
            this._touch(liveReq);
        } else if (String(summary.request || '').trim()) {
            // A REPLAY has no live request item — the text exists only on the
            // summary — so materialise one at the head of the exchange.
            this._seq += 1;
            const at = startIdx >= 0 ? startAt : (this._clock || clockNow());
            this._items.splice(startIdx >= 0 ? startIdx : this._items.length, 0, {
                id: `i${this._seq}`, rev: 0, live: false, at,
                kind: 'request', text: String(summary.request).trim(),
            });
        }

        const settled = this._items.filter(i =>
            !i.live && !kept.includes(i) && !pendingAsk.includes(i));

        this._group = null;
        this._narration = null;
        // A COPY: _add() pushes onto this._items, and reusing the same array
        // reference below would list the new run twice.
        this._items = [...settled];

        const added = this._add({
            kind: 'run',
            request: String(summary.request || ''),
            answer,
            files: Array.isArray(summary.files) ? summary.files : [],
            stats: summary.stats || {},
            plan: String(summary.plan || ''),
        });
        // …run, then anything it delivered but did not restate, then the question.
        this._items = [...settled, added, ...kept, ...pendingAsk];
        return added;
    }

    /** Drop the live trace without recording a run (abort / error teardown). */
    clearLive() {
        this._items = this._items.filter(i => !i.live || (i.kind === 'ask' && !i.answered));
        this._group = null;
        this._narration = null;
    }

    /** Serializable snapshot — survives a view teardown without DOM references. */
    snapshot() {
        return { items: JSON.parse(JSON.stringify(this._items)), seq: this._seq };
    }

    restore(snap) {
        if (!snap || !Array.isArray(snap.items)) return false;
        this._items = snap.items;
        this._seq = Number(snap.seq) || this._items.length;
        // Node references cannot survive a snapshot, so re-derive the open group
        // from the data. The old code kept a DOM node here, which went stale and
        // silently un-grouped every subsequent line.
        const lastGroup = [...this._items].reverse().find(i => i.kind === 'group' && i.live);
        this._group = lastGroup || null;
        // Continue numbering from the highest step already in the story.
        this._stepNo = this._items.reduce((m, i) => Math.max(m, i._stepNo || 0), 0);
        this._narration = [...this._items].reverse().find(i => i.kind === 'narration' && i.live) || null;
        return true;
    }
}

/**
 * Replay stored logs into a timeline. Same reducer the live socket drives, so
 * a reloaded task and a live one cannot disagree.
 *
 * @param {Array<{event:string,data:object,timestamp?:string}>} logs
 * @param {{prompt?:string, maxLive?:number}} opts task prompt, shown before the first run
 */
export function buildTimeline(logs, opts = {}) {
    const tl = new TaskTimeline({ maxLive: opts.maxLive });
    const seenRun = new Set();

    for (const l of (Array.isArray(logs) ? logs : [])) {
        if (!l || typeof l !== 'object') continue;
        const d = l.data || {};
        tl.setClock(l.timestamp);
        if (l.event === 'complete' && d.resultSummary) {
            // Dedup on the same key the old rebuild used: a continue/replay can
            // deliver the same completion twice.
            const key = `${l.timestamp || ''}|${String(d.resultSummary.request || '').slice(0, 120)}`;
            if (seenRun.has(key)) continue;
            seenRun.add(key);
            tl.pushRun(d.resultSummary);
        } else if (l.event === 'log' && d.method === 'TOOL' && d.name) {
            // Tool telemetry carries the ARGUMENTS, so a replayed step can offer
            // the file it touched — a status line only ever had the basename.
            const t = toolTarget(d.name, d.request);
            tl.pushActivity('tool', toolLineText(d.name, d.request), t);
        } else if (l.event === 'status' && d.status === 'running' && d.message) {
            // Replay the run's ACTIVITY, not just its outcome. Without this the
            // steps existed only in the live socket's memory, so the moment
            // anything rebuilt from logs — including completion — the whole
            // story collapsed to "request, question, deliverable".
            tl.pushActivity(replayLineType(d.message), d.message);
        } else if (l.event === 'result' && d.envelope) {
            // Replaying these keeps a delivered report visible after a reload,
            // the same way the live path does.
            tl.pushDeliverable(d.envelope.kind, envelopeText(d.envelope));
        } else if (l.event === 'ask' || (l.event === 'status' && d.status === 'waiting')) {
            tl.pushAsk({ text: d.message, options: d.options, multi: d.multiSelect });
        }
    }

    // Nothing completed yet → show what was asked, so the view is never blank.
    if (!tl.items.some(i => i.kind === 'run') && opts.prompt) {
        const req = tl.pushRequest(opts.prompt);
        if (req) {
            // Keep the request ahead of any live trace already collected.
            tl._items = [req, ...tl._items.filter(i => i !== req)];
        }
    }
    return tl;
}

/**
 * Split the timeline into the CONVERSATION stream and the DOCUMENT to feature.
 *
 * The Task view used to be one scroll of chat bubbles, which is the shape a
 * terminal agent has — and it buried the thing the user actually asked for
 * among the trace. The deliverable is a document: it gets its own pane, full
 * width, with the files and stats that belong to it.
 *
 * The document is the newest `present_result` if there is one, otherwise the
 * newest completed run that produced an answer. It replaces its source in
 * place; the request that opened the exchange is its own item further up, where
 * it happened.
 *
 * @param {Array<object>} items
 * @returns {{stream: Array<object>, doc: object|null}}
 */
export function splitForPanes(items) {
    const list = Array.isArray(items) ? items : [];
    const back = [...list].reverse();
    const source = back.find(i => i.kind === 'deliverable')
        || back.find(i => i.kind === 'run' && String(i.answer || '').trim());
    if (!source) return { stream: list, doc: null };

    const fromRun = source.kind === 'run';
    const doc = {
        // Derived ids stay stable across renders, so the keyed renderer reuses
        // the node instead of rebuilding the document on every activity line.
        id: `${source.id}:doc`,
        rev: source.rev,
        kind: 'document',
        text: fromRun ? source.answer : source.text,
        envKind: fromRun ? 'markdown' : source.envKind,
        files: fromRun ? (source.files || []) : [],
        stats: fromRun ? (source.stats || {}) : {},
        request: fromRun ? source.request : '',
    };

    // The document REPLACES its source IN PLACE. Appending it to the end put the
    // deliverable after a question the agent asked *about* it, which read as
    // "answer this, then here is what you are answering about".
    // The request is a REAL item now (pushRun settles it in place), so deriving
    // one here would show the user's message twice — once at the time they sent
    // it, once carrying the run's completion time.
    const stream = list.map(i => (i === source ? doc : i));
    return { stream: withTurnDividers(stream), doc };
}

/**
 * Put a boundary before every request that is not the first.
 *
 * A continued task shows the previous run's steps and then the next request. The
 * order is right, but with nothing between them the trace reads as the working
 * FOR that request — reported twice as "the steps are above my request". The
 * divider closes the previous exchange.
 *
 * Dividers are real items with their own ids, so the keyed renderer treats them
 * like anything else instead of needing the surrounding nodes rebuilt.
 */
export function withTurnDividers(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    let turn = 0;
    let runsSeen = 0;
    for (const item of list) {
        if (item.kind === 'request') {
            turn += 1;
            // A divider marks the end of an EXCHANGE, and an exchange ends with a
            // completed run. Keying it off "is there anything above me" put a
            // divider over the only request of a single-run task, because a
            // replayed run's steps are rendered before its derived request.
            if (runsSeen > 0) {
                out.push({ id: `turn:${item.id}`, rev: 0, kind: 'turn', n: turn, live: false });
            }
        }
        if (item.kind === 'run' || item.kind === 'document') runsSeen += 1;
        out.push(item);
    }
    return out;
}

/** The items that are the agent's WORKING — the part an exchange folds away. */
const WORKING = new Set(['group', 'narration', 'activity']);

/** What an exchange PRODUCED. Folded, these keep their header and lose their body. */
const OUTCOME = new Set(['run', 'deliverable', 'document']);

/** How many exchanges a stream contains (an exchange opens with a request). */
export function exchangeCount(items) {
    return (Array.isArray(items) ? items : []).filter(i => i.kind === 'request').length;
}

/**
 * Number each item's exchange, and fold away the working of the collapsed ones.
 *
 * Folding used to be a single class on the whole list, so collapsing one request
 * collapsed every request. An EXCHANGE — a request through to the answer or the
 * next question — is the unit a reader thinks in, and it is the unit that makes
 * a long task readable: three folded exchanges fit on a screen where three
 * unfolded ones do not fit at all.
 *
 * Collapsed working is REMOVED from the list rather than hidden with CSS. The
 * keyed renderer then drops the nodes, which is also what makes a story of
 * hundreds of steps cheap to redraw.
 *
 * The WORKING and the RESULT fold independently: wanting to skim the steps of an
 * exchange whose answer you are reading is at least as common as the reverse, so
 * one flag for both would always be wrong half the time.
 *
 * @param {Array<object>} items
 * @param {Set<number>|{working?:Set<number>, outcome?:Set<number>}} folds
 *   exchange numbers to fold (1-based). A bare Set folds both.
 */
export function withExchangeFolds(items, folds = null) {
    const list = Array.isArray(items) ? items : [];
    const both = folds instanceof Set ? folds : null;
    const set = both || (folds?.working instanceof Set ? folds.working : new Set());
    const outSet = both || (folds?.outcome instanceof Set ? folds.outcome : new Set());
    const out = [];
    let ex = 0;
    let batch = null;

    const flush = () => {
        if (!batch) return;
        out.push({
            id: `fold:${batch.firstId}`, rev: batch.rev, kind: 'fold', live: false,
            ex: batch.ex, n: batch.n, steps: batch.steps, at: batch.from, to: batch.to,
        });
        batch = null;
    };

    for (const item of list) {
        if (item.kind === 'request') { flush(); ex += 1; }
        const folded = set.has(ex);
        const outFolded = outSet.has(ex);

        if (folded && WORKING.has(item.kind)) {
            if (!batch) batch = { firstId: item.id, rev: 0, ex, n: 0, steps: 0, from: item.at, to: item.at };
            batch.n += 1;
            // The summary's rev tracks its members', so a step changing while the
            // exchange is folded still refreshes the count above it.
            batch.rev += (item.rev || 0);
            if (item.kind === 'group') batch.steps += 1;
            batch.to = item.at;
            continue;
        }

        flush();
        // Only the request carries the fold state: it owns the toggle.
        if (item.kind === 'request') {
            out.push({ ...item, _ex: ex, _folded: folded, rev: (item.rev || 0) + (folded ? 1 : 0) });
            continue;
        }
        // A folded exchange folds its RESULT too — and folding it means not
        // rendering the body at all, not hiding it with CSS. Parsing the markdown
        // of every past exchange is what made opening a long task slow; the
        // header alone is what a folded exchange needs to show.
        if (OUTCOME.has(item.kind)) {
            // Stamped either way, so an OPEN result's header knows which exchange
            // it closes — the fold has to survive the next render, and a class
            // poked onto the node does not.
            out.push(outFolded
                ? { ...item, _ex: ex, _bodyless: true, rev: (item.rev || 0) + 1 }
                : { ...item, _ex: ex });
            continue;
        }
        // BY REFERENCE, deliberately.
        //
        // A spread here would allocate a new object per item per render and hand the
        // renderer fresh props every time, so an unchanged step could not be skipped —
        // on a long run that is the difference between a few milliseconds and thirty.
        // The fold state travels separately (see collapsedIds below) precisely so these
        // stay stable.
        out.push(item);
    }
    flush();
    return out;
}

/**
 * The ids of every card the MODEL currently has folded.
 *
 * A separate lookup rather than a flag stamped onto each item, for two reasons that
 * pull the same way:
 *   • the model flips `collapsed` itself (opening a step folds the earlier ones; a
 *     completed run folds them all), so a renderer must never cache its own copy;
 *   • passing it separately lets the items themselves stay reference-stable, which is
 *     what keeps a streaming render cheap.
 */
export function collapsedIds(items) {
    const set = new Set();
    for (const i of (Array.isArray(items) ? items : [])) {
        if (i && i.collapsed) set.add(i.id);
    }
    return set;
}

/**
 * Chapter markers for the navigation rail.
 *
 * A long run is a story with parts — the request, each reasoning step, a
 * question, the deliverable. Listing them lets the reader jump instead of
 * scrolling, which is the whole point of giving the trace a spine.
 *
 * @param {Array<object>} items
 * @returns {Array<{id:string, kind:string, label:string, n:number}>}
 */
export function chapters(items) {
    const out = [];
    let step = 0;
    for (const i of (Array.isArray(items) ? items : [])) {
        switch (i.kind) {
            case 'request':
                out.push({ id: i.id, kind: 'request', label: 'Request', n: 0 });
                break;
            case 'group':
                step += 1;
                out.push({ id: i.id, kind: 'step', label: `Step ${String(step).padStart(2, '0')}`, n: step });
                break;
            case 'ask':
                out.push({ id: i.id, kind: 'ask', label: i.answered ? 'Answered' : 'Question', n: 0 });
                break;
            case 'confirm':
                out.push({ id: i.id, kind: 'confirm', label: 'Approval', n: 0 });
                break;
            case 'run':
            case 'document':
                out.push({ id: i.id, kind: 'deliverable', label: 'Deliverable', n: 0 });
                break;
            default:
                break;   // narration / activity lines are not chapter-worthy
        }
    }
    return out;
}
