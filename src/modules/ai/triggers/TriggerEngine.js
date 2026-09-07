// TriggerEngine — the decision half of "run when something happens outside".
//
// Deliberately PURE: no timers, no fetch, no storage, and `now` comes in as an
// argument. Everything interesting here is time-dependent — debounce windows,
// cooldowns, an hourly cap — and time-dependent logic that owns its own
// setTimeout can only be tested by actually waiting. The host (TriggerManager)
// keeps the clock and does the I/O.
//
// The engine is mostly GUARDS. Firing a task when an event arrives is one line;
// what makes an autonomous trigger safe to leave switched on is that three
// saves do not start three runs, a re-delivered webhook does not start a second
// one, and a broken event source stops instead of filing 400 tasks overnight.
// See docs/design/autonomy-triggers.md.

/** Defaults applied to any field a trigger leaves out. */
export const TRIGGER_DEFAULTS = {
    enabled: false,          // never live the moment it is created
    debounceMs: 2000,
    cooldownMs: 0,
    dedupeWindowMs: 60000,
    maxPerHour: 20,
    concurrency: 'skip',
};

/** Reasons an event did not become a run. These are shown to the user. */
export const DROP = {
    disabled:    'トリガーが無効',
    duplicate:   '同じイベントの重複',
    cooldown:    'クールダウン中',
    running:     '前の実行がまだ走っている',
    rateLimited: '1時間あたりの上限に達したためトリガーを停止しました',
};

/**
 * Read a dotted path out of an object. Returns undefined for a missing leaf —
 * distinct from a leaf that is genuinely null.
 */
export function dig(obj, path) {
    return String(path).split('.').reduce(
        (o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Does `event` satisfy `match`?
 *
 * An EMPTY match object matches everything, and that is deliberate: a trigger
 * with no conditions is a legitimate thing to want ("anything from this MCP
 * server"). It is also part of why new triggers start disabled.
 */
export function matches(match, event) {
    const m = match || {};
    if (m.source && m.source !== event.source) return false;
    if (m.server && m.server !== event.server) return false;
    // Which watcher produced it. This is what lets a job be attached to a
    // SOURCE rather than to a name, so two watchers may safely emit the
    // same event name.
    if (m.watcherId && m.watcherId !== event.watcherId) return false;
    if (m.event && m.event !== event.event) return false;
    if (m.eventPrefix && !String(event.event || '').startsWith(m.eventPrefix)) return false;
    for (const [path, want] of Object.entries(m.where || {})) {
        // Compared as strings: a webhook's JSON gives 200 where a hand-typed
        // condition gives "200", and refusing to match those would be a puzzle
        // with no error message anywhere.
        if (String(dig(event.payload, path)) !== String(want)) return false;
    }
    return true;
}

/**
 * A stable identity for "the same event again".
 *
 * The source may supply its own `key` (a delivery id, a commit sha) — always
 * better than anything derivable here. Otherwise fall back to the shape of the
 * event, which catches the honest re-delivery case.
 */
export function eventKey(event) {
    if (event.key) return String(event.key);
    let payload = '';
    try { payload = JSON.stringify(event.payload ?? null); } catch (_) { payload = '?'; }
    return `${event.source}|${event.server || ''}|${event.event}|${payload}`;
}

/**
 * Fill a prompt template from an event.
 *
 * A key that resolves to nothing is LEFT AS WRITTEN rather than replaced with
 * an empty string: a prompt that silently loses half its content produces a run
 * that fails for reasons nobody can see, while `{{payload.branch}}` sitting in
 * the prompt says exactly what was expected and missing.
 */
export function renderPrompt(template, event, count = 1) {
    return String(template || '').replace(/\{\{([^}]+)\}\}/g, (whole, expr) => {
        const key = expr.trim();
        if (key === 'count') return String(count);
        if (key === 'event') {
            try { return JSON.stringify(event, null, 2); } catch (_) { return whole; }
        }
        const v = key.startsWith('payload.') || key.startsWith('event.')
            ? dig({ payload: event.payload, event }, key)
            : dig(event, key);
        if (v === undefined || v === null) return whole;
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
}


/**
 * Placeholders `renderPrompt` could not fill.
 *
 * `renderPrompt` leaves an unresolved `{{payload.x}}` visible rather than
 * blanking it, so a prompt never silently loses half its content. That is right
 * for reading and wrong for RUNNING: a task whose instructions still contain
 * `{{payload.value}}` cannot be carried out, and an agent given one does the
 * only honest thing — spends a hundred seconds establishing that it cannot
 * invent the number, then asks. The cost is real and the answer was knowable
 * before the model was called.
 */
export function unresolvedPlaceholders(rendered) {
    return [...String(rendered || '').matchAll(/\{\{([^}]+)\}\}/g)]
        .map(m => m[1].trim());
}

export class TriggerEngine {
    constructor() {
        this.triggers = [];
        /** @type {Map<string, object>} per-trigger runtime state, id -> state */
        this.state = new Map();
        /** Everything the engine decided, newest last. The audit trail. */
        this.journal = [];
    }

    setTriggers(list) {
        this.triggers = (Array.isArray(list) ? list : [])
            .map(t => ({ ...TRIGGER_DEFAULTS, ...t }));
        // Drop state for triggers that no longer exist; keep the rest, so
        // editing a trigger's prompt does not reset its cooldown.
        const ids = new Set(this.triggers.map(t => t.id));
        for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
        return this.triggers;
    }

    _stateOf(id) {
        if (!this.state.has(id)) {
            this.state.set(id, {
                seen: new Map(),      // event key -> last seen ms
                firedAt: [],          // ms timestamps, for the hourly cap
                lastFired: 0,
                running: false,
                pending: null,        // { event, count, fireAt }
            });
        }
        return this.state.get(id);
    }

    _note(entry) {
        this.journal.push(entry);
        // The journal is an aid, not the record of account — the runs
        // themselves are persisted. Bounded so a chatty source cannot grow it
        // without limit.
        if (this.journal.length > 500) this.journal.splice(0, this.journal.length - 500);
        return entry;
    }

    /**
     * Take one event. Returns what happened to it, per matching trigger.
     *
     * Nothing fires here — a match opens (or extends) a debounce window, and
     * `due()` is what hands back the runs whose windows have closed.
     */
    accept(event, now = Date.now()) {
        const results = [];
        for (const trigger of this.triggers) {
            if (!matches(trigger.match, event)) continue;      // not addressed to it
            const why = this._guard(trigger, event, now);
            if (why) {
                results.push(this._note({ at: now, triggerId: trigger.id, dropped: why, event }));
                continue;
            }
            const st = this._stateOf(trigger.id);
            st.seen.set(eventKey(event), now);
            // Extend, don't restart the count: a burst becomes one run carrying
            // the number of events it stands for.
            const count = (st.pending?.count || 0) + 1;
            st.pending = { event, count, fireAt: now + (trigger.debounceMs || 0) };
            results.push(this._note({
                at: now, triggerId: trigger.id, accepted: true, count,
                fireAt: st.pending.fireAt, event,
            }));
        }
        return results;
    }

    /** The guards, ordered so the reason given is the most honest one. */
    _guard(trigger, event, now) {
        if (!trigger.enabled) return DROP.disabled;
        const st = this._stateOf(trigger.id);

        const key = eventKey(event);
        const seenAt = st.seen.get(key);
        if (seenAt != null && now - seenAt < (trigger.dedupeWindowMs || 0)) return DROP.duplicate;
        // Forget old keys, or a long-lived trigger accumulates one entry per
        // event for the life of the process.
        for (const [k, at] of st.seen) {
            if (now - at > (trigger.dedupeWindowMs || 0)) st.seen.delete(k);
        }

        // The hourly cap is checked BEFORE cooldown so a runaway source is
        // reported as a runaway, not as "you are going too fast".
        st.firedAt = st.firedAt.filter(t => now - t < 3600000);
        if (trigger.maxPerHour > 0 && st.firedAt.length >= trigger.maxPerHour) {
            // Stop, and say so. A trigger that silently discards events looks
            // exactly like one whose event source has gone quiet.
            trigger.enabled = false;
            trigger.disabledReason = DROP.rateLimited;
            trigger.disabledAt = now;
            return DROP.rateLimited;
        }
        if (trigger.cooldownMs > 0 && now - st.lastFired < trigger.cooldownMs) return DROP.cooldown;
        if (st.running && trigger.concurrency === 'skip') return DROP.running;
        return null;
    }

    /**
     * Debounce windows that have closed. Each is a run the host should start.
     *
     * The concurrency guard runs AGAIN here: the window opened some seconds
     * ago, and whether the previous run is still going is only knowable now.
     */
    due(now = Date.now()) {
        const out = [];
        for (const trigger of this.triggers) {
            const st = this.state.get(trigger.id);
            if (!st?.pending || now < st.pending.fireAt) continue;
            const { event, count } = st.pending;
            st.pending = null;
            if (st.running && trigger.concurrency === 'skip') {
                this._note({ at: now, triggerId: trigger.id, dropped: DROP.running, event });
                continue;
            }
            out.push({ trigger, event, count, prompt: renderPrompt(trigger.prompt, event, count) });
        }
        return out;
    }

    /** When, in ms from `now`, does the engine next need looking at? */
    nextWakeIn(now = Date.now()) {
        let soonest = Infinity;
        for (const st of this.state.values()) {
            if (st.pending) soonest = Math.min(soonest, Math.max(0, st.pending.fireAt - now));
        }
        return soonest;
    }

    noteFired(triggerId, now = Date.now()) {
        const st = this._stateOf(triggerId);
        st.lastFired = now;
        st.firedAt.push(now);
        st.running = true;
    }

    noteFinished(triggerId) {
        const st = this.state.get(triggerId);
        if (st) st.running = false;
    }
}
