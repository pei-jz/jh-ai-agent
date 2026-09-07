// TriggerManager — the I/O half: storage, the clock, and starting the task.
//
// Everything that decides ANYTHING lives in TriggerEngine, which is pure. This
// file only carries events in, timers, and `POST /tasks` out. Split that way
// because the interesting behaviour is all time-dependent, and time-dependent
// logic wrapped around a fetch can only be tested by waiting.
//
// Modelled on ScheduleManager, which does the same job for the clock-driven
// half of autonomy. Same storage shape, same firing call, same run records —
// the difference is only what decides to fire.

import { buildBehavior, DEFAULT_MODE_ID } from '../AgentModes.js';
import { TriggerEngine, TRIGGER_DEFAULTS, unresolvedPlaceholders } from './TriggerEngine.js';

const TRIGGERS_KEY = 'jh_triggers';

/** Never wake sooner than this, however short a debounce is configured. */
const MIN_WAKE_MS = 50;

/** Runs kept per trigger. Enough to answer "why did this run?", not a log. */
const RUN_HISTORY = 50;

export class TriggerManager {
    constructor({ engine = new TriggerEngine(), storage = null, client = null } = {}) {
        this.engine = engine;
        // Injected in tests; in the app these are the real globals.
        this._storage = storage;
        this._client = client;
        this.triggers = [];
        this._tickTimer = null;
        this._unsubscribe = [];
    }

    get storage() { return this._storage ?? globalThis.localStorage; }
    get client() { return this._client ?? globalThis.window?.apiClient; }

    init() {
        this.reload();
        // No polling. The only thing that can make a window close is an event
        // having opened one, so the timer is set when that happens and there is
        // nothing running while the app sits idle — a 2 Hz wakeup that exists
        // to notice nothing is how a desktop app ends up in a battery report.
        return this;
    }

    /**
     * Wake exactly once, when the soonest pending window closes.
     *
     * Always clears first and always leaves `_tickTimer` telling the truth
     * about whether anything is armed — an already-fired handle left lying in
     * the field reads as "a wakeup is coming" to everything that looks at it.
     */
    _schedule() {
        clearTimeout(this._tickTimer);
        this._tickTimer = null;
        const wait = this.engine.nextWakeIn(Date.now());
        if (!Number.isFinite(wait)) return;          // nothing pending
        this._tickTimer = setTimeout(() => {
            this._tickTimer = null;
            this.tick();
        }, Math.max(MIN_WAKE_MS, wait));
    }

    destroy() {
        clearTimeout(this._tickTimer);
        this._tickTimer = null;
        for (const off of this._unsubscribe) { try { off(); } catch (_) { /* best effort */ } }
        this._unsubscribe = [];
    }

    reload() {
        let list = [];
        try { list = JSON.parse(this.storage?.getItem(TRIGGERS_KEY) || '[]'); } catch (_) { list = []; }
        this.triggers = this.engine.setTriggers(Array.isArray(list) ? list : []);
        return this.triggers;
    }

    save() {
        try { this.storage?.setItem(TRIGGERS_KEY, JSON.stringify(this.triggers)); } catch (_) { /* best effort */ }
        globalThis.window?.dispatchEvent?.(new CustomEvent('jh-triggers-updated'));
    }

    /**
     * An event arrived from somewhere outside. Sources call only this.
     *
     * Returns the engine's decisions so a caller (or a test) can see what
     * happened to the event, including when the answer is "nothing".
     */
    onEvent(event) {
        if (!event || !event.event) return [];
        const decisions = this.engine.accept(event, Date.now());
        // The rate cap can switch a trigger off; that has to survive a reload.
        if (decisions.some(d => d.dropped && this.triggers.some(t => !t.enabled && t.disabledReason))) {
            this.save();
        }
        // An accepted event opened or extended a window; that is the only
        // thing that ever needs waking up for.
        if (decisions.some(d => d.accepted)) this._schedule();
        return decisions;
    }

    /** Start whatever debounce windows have closed. */
    async tick() {
        const due = this.engine.due(Date.now());
        for (const item of due) await this._fire(item);
        if (due.length) this.save();
        // A burst can leave a second window still open behind the one that just
        // closed; re-arm rather than waiting for the next event to do it.
        this._schedule();
    }

    async _fire({ trigger, event, count, prompt }) {
        const at = new Date().toISOString();
        const record = { at, event: event.event, source: event.source, count };

        // A prompt that still carries `{{payload.x}}` is a prompt the event
        // could not fill, and no model call changes that. Starting the task
        // anyway is what produced a 100-second run that ended by asking the
        // user for the number the placeholder was supposed to be. Refused
        // here, with the field named, so the fix is one edit away — to the
        // prompt, or to the watcher that was supposed to supply it.
        const missing = unresolvedPlaceholders(prompt);
        if (missing.length) {
            record.status = 'failed';
            record.error = `プロンプトの ${missing.map(m => `{{${m}}}`).join(', ')} `
                + `が今回のイベントに含まれていません。イベントの中身は「監視」の詳細で確認できます。`;
            this.engine.noteFinished(trigger.id);
            const stored0 = this.triggers.find(t => t.id === trigger.id);
            if (stored0) stored0.runs = [...(stored0.runs || []), record].slice(-RUN_HISTORY);
            return record;
        }

        try {
            const client = this.client;
            if (!client) throw new Error('API client not ready');
            // Explicit [] when nothing is picked: an empty list means "no MCP
            // tools" while an omitted list would mean "all servers", so a
            // server connecting mid-task would leak its tools in.
            const mcpServers = trigger.mcpServers?.length ? trigger.mcpServers : [];
            const behavior = {
                mode: 'iterative_agent',
                ...buildBehavior(trigger.agentModeId || DEFAULT_MODE_ID),
                mcp_servers: mcpServers,
                // What set this off, carried into the run itself. An autonomous
                // execution that cannot explain why it happened is just an
                // unpredictable app.
                mcp_context: {
                    trigger: { id: trigger.id, name: trigger.name || trigger.id, count },
                    event,
                },
            };
            const task = await client.request('/tasks', {
                method: 'POST',
                body: JSON.stringify({
                    prompt,
                    workspace_path: trigger.workspacePath || null,
                    caller: 'Trigger',
                    behavior,
                }),
            });
            record.taskId = task.task_id || task.id;
            record.status = 'started';
            this.engine.noteFired(trigger.id, Date.now());
        } catch (err) {
            record.status = 'failed';
            record.error = err?.message || String(err);
            // A trigger whose runs cannot start is not "quiet", it is broken —
            // and the run record is the only place that shows the difference.
            this.engine.noteFinished(trigger.id);
        }
        const stored = this.triggers.find(t => t.id === trigger.id);
        if (stored) {
            stored.runs = [...(stored.runs || []), record].slice(-RUN_HISTORY);
        }
        return record;
    }

    /** A run started by `triggerId` has ended — release the concurrency guard. */
    onTaskFinished(triggerId) {
        this.engine.noteFinished(triggerId);
    }

    // ── CRUD, so the UI has one place to go through ──────────────────────
    upsert(trigger) {
        const t = { ...TRIGGER_DEFAULTS, id: `trg_${Date.now()}`, ...trigger };
        const i = this.triggers.findIndex(x => x.id === t.id);
        if (i >= 0) this.triggers[i] = { ...this.triggers[i], ...t };
        else this.triggers.push(t);
        this.engine.setTriggers(this.triggers);
        this.save();
        return t;
    }

    remove(id) {
        this.triggers = this.triggers.filter(t => t.id !== id);
        this.engine.setTriggers(this.triggers);
        this.save();
    }

    setEnabled(id, enabled) {
        const t = this.triggers.find(x => x.id === id);
        if (!t) return null;
        t.enabled = !!enabled;
        // Re-enabling by hand is the acknowledgement that the runaway was seen.
        if (enabled) { delete t.disabledReason; delete t.disabledAt; }
        this.engine.setTriggers(this.triggers);
        this.save();
        return t;
    }
}

export const triggerManager = new TriggerManager();
