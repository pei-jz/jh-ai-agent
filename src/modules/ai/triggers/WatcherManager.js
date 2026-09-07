// WatcherManager — the I/O half: the clock, the Tauri calls, and handing what
// it found to the trigger rules.
//
// This is what makes the autonomy self-contained. Before it, "run when mail
// arrives" meant a Python script registered in Windows Task Scheduler — the app
// owned a scheduler and still outsourced the watching. Now the app's own timer
// does the looking.
//
// All decisions live in WatcherEngine (pure); everything here is invoke(),
// setTimeout and persistence, mirroring the split TriggerEngine/TriggerManager
// already use.

import { invoke } from '@tauri-apps/api/core';
import {
    WATCHER_DEFAULTS, isDue, nextDueIn, diffFolder, diffMail, diffHttp,
    eventsFromOutput, isFirstRun, pollOutcome,
} from './WatcherEngine.js';
import { SlackConnection } from './SlackSocket.js';
import { recipeRegistry } from './RecipeRegistry.js';
import { resolveConfig, applySecrets, secretFieldIn } from './recipes/recipeFormat.js';
import {
    scriptRefusal, buildScriptEnv, buildScriptStdin, parseScriptOutput,
    SCRIPT_TIMEOUT_SECS,
} from './recipes/scriptContract.js';
// The watcher does not care who consumes its events; the JOB registry is
// what decides now. Still injectable, which is how the tests avoid the
// singleton.
import { jobManager } from '../jobs/JobManager.js';

const WATCHERS_KEY = 'jh_watchers';

/** Never wake sooner than this, whatever interval is configured. */
const MIN_WAKE_MS = 1000;

/** A command watcher's own ceiling. A poll that outlives its interval is stuck. */
const COMMAND_TIMEOUT_SECS = 60;


/**
 * The credential-store account for a watcher's password.
 *
 * One function so the reader and the writer cannot disagree — a mismatch here
 * fails as "no password stored" on a watcher the user definitely gave one to,
 * which is a puzzle with no evidence in it.
 */
export function secretIdFor(watcherId) {
    return `watcher:${watcherId}`;
}

/**
 * The credential-store account for a watcher's HTTP auth header value.
 *
 * Separate from the mailbox password so one watcher could, in principle, need
 * both — and so neither can be read by asking for the other.
 */
export function authSecretIdFor(watcherId) {
    return `watcher-auth:${watcherId}`;
}

/**
 * The credential-store account for one RECIPE FIELD of a watcher.
 *
 * Per field rather than per watcher, because a recipe may want two — an API key
 * and a webhook signing secret — and because the field name is what the form,
 * the script's environment and this id all have to agree on. Sharing one
 * account would make the second secret overwrite the first with no error
 * anywhere.
 */
export function fieldSecretId(watcherId, fieldKey) {
    return `watcher-field:${watcherId}:${fieldKey}`;
}

export class WatcherManager {
    constructor({ storage = null, triggers = null, invoker = null, recipes = null } = {}) {
        this._storage = storage;
        this._triggers = triggers;
        this._invoke = invoker;
        this._recipes = recipes;
        this.watchers = [];
        this._timer = null;
        this._running = false;
        /** @type {Map<string, SlackConnection>} live push connections, by watcher id */
        this._connections = new Map();
    }

    get storage() { return this._storage ?? globalThis.localStorage; }
    get triggers() { return this._triggers ?? jobManager; }
    get invoke() { return this._invoke ?? invoke; }
    get recipes() { return this._recipes ?? recipeRegistry; }

    init() {
        this.reload();
        // Loaded, not awaited: a recipe that is slow to read off disk must not
        // hold up the timer, and `resolve()` loads on demand for the watcher
        // that actually needs one.
        this.recipes.refresh().catch(() => { /* reported per watcher on poll */ });
        this._schedule();
        this.syncConnections();
        return this;
    }

    destroy() {
        clearTimeout(this._timer);
        this._timer = null;
        for (const c of this._connections.values()) c.stop();
        this._connections.clear();
    }

    /**
     * Watchers that hold a connection instead of being polled.
     *
     * Slack pushes: there is no interval and nothing to compare, so `isDue` and
     * the baseline machinery do not apply. Kept in the same store and the same
     * list all the same — from the user's side it is one more thing being
     * watched, and splitting the UI by transport would be the mistake the job
     * redesign just undid.
     */
    static PUSH_TYPES = new Set(['slack']);

    /**
     * Bring the live connections in line with the watcher list.
     *
     * Stopping matters as much as starting: a watcher switched off that keeps
     * its socket open keeps answering, which is the most surprising way for a
     * disabled thing to behave.
     */
    syncConnections() {
        const want = new Set(
            this.watchers
                .filter(w => w.enabled && WatcherManager.PUSH_TYPES.has(w.type))
                .map(w => w.id));

        for (const [id, conn] of [...this._connections]) {
            if (!want.has(id)) { conn.stop(); this._connections.delete(id); }
        }
        for (const w of this.watchers) {
            if (!want.has(w.id) || this._connections.has(w.id)) continue;
            const conn = new SlackConnection({
                watcher: w,
                getToken: () => this.invoke('get_watcher_secret', { id: secretIdFor(w.id) }),
                onEvent: (ev) => {
                    ev.payload = { watcher: w.name || w.id, ...ev.payload };
                    Object.assign(w, pollOutcome(
                        { ok: true, count: 1, sample: ev.payload }, Date.now()));
                    this.save();
                    try { this.triggers.onEvent(ev); }
                    catch (e) { console.warn('[WatcherManager] trigger intake failed:', e?.message || e); }
                },
                onStatus: (s) => {
                    // A connection refused for two days looks exactly like a
                    // quiet channel unless this is recorded and shown.
                    w.connected = !!s.connected;
                    if (!s.ok) Object.assign(w, pollOutcome({ ok: false, error: s.error }, Date.now()));
                    this.save();
                },
            });
            this._connections.set(w.id, conn);
            conn.start().catch(() => { /* start() reports through onStatus */ });
        }
        return this._connections.size;
    }

    reload() {
        let list = [];
        try { list = JSON.parse(this.storage?.getItem(WATCHERS_KEY) || '[]'); } catch (_) { list = []; }
        this.watchers = (Array.isArray(list) ? list : []).map(w => ({ ...WATCHER_DEFAULTS, ...w }));
        return this.watchers;
    }

    save() {
        try { this.storage?.setItem(WATCHERS_KEY, JSON.stringify(this.watchers)); } catch (_) { /* best effort */ }
        globalThis.window?.dispatchEvent?.(new CustomEvent('jh-watchers-updated'));
    }

    /** Wake when the soonest enabled watcher is due. No polling while all are off. */
    _schedule() {
        clearTimeout(this._timer);
        this._timer = null;
        const wait = nextDueIn(this.watchers, Date.now());
        if (!Number.isFinite(wait)) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.tick();
        }, Math.max(MIN_WAKE_MS, wait));
    }

    /** Poll every watcher that is due. */
    async tick(now = Date.now()) {
        // One poll at a time. A slow IMAP server plus a short interval would
        // otherwise stack polls until the app is doing nothing else.
        if (this._running) return [];
        this._running = true;
        const fired = [];
        try {
            for (const w of this.watchers) {
                if (WatcherManager.PUSH_TYPES.has(w.type)) continue;   // pushed, not polled
                if (!isDue(w, now)) continue;
                const events = await this.poll(w, now);
                fired.push(...events);
            }
        } finally {
            this._running = false;
            this.save();
            this._schedule();
        }
        return fired;
    }

    /**
     * What this watcher actually polls, once its recipe is applied.
     *
     * A watcher with no `recipeId` is returned as it is — the four types that
     * predate recipes keep working with nothing changed, which is the whole
     * reason recipes resolve to the SAME object shape the engines already take.
     *
     * Throws rather than returning a marker: every reason to refuse (a missing
     * recipe, a file that changed since it was approved, a dangerous command)
     * has to end up in `lastError` where the panel shows it, and `poll` already
     * does exactly that with anything thrown.
     */
    async resolve(watcher) {
        if (!watcher?.recipeId) return { ...watcher };

        let recipe = this.recipes.get(watcher.recipeId);
        if (!recipe) {
            // A recipe added since the app started, or a first poll before the
            // background load finished.
            await this.recipes.refresh().catch(() => {});
            recipe = this.recipes.get(watcher.recipeId);
        }
        const values = watcher.values || {};
        const blocked = await this.recipes.blockedReason(watcher, recipe, values);
        if (blocked) throw new Error(blocked);

        // The mailbox password is the exception: it never enters JavaScript.
        // The backend reads it from the credential store by id, so what travels
        // is the ACCOUNT NAME, not the secret.
        const mailPasswordField = recipe.engine === 'mail' ? secretFieldIn(recipe, 'password') : null;
        const secrets = {};
        for (const f of recipe.fields) {
            if (f.type !== 'secret' || f.key === mailPasswordField) continue;
            try {
                secrets[f.key] = await this.invoke('get_watcher_secret',
                    { id: fieldSecretId(watcher.id, f.key) }) || '';
            } catch (_) { secrets[f.key] = ''; }
        }

        const config = applySecrets(resolveConfig(recipe, values), recipe, secrets);
        const eff = { ...watcher, ...config, type: recipe.engine, recipe };
        if (mailPasswordField) {
            eff.secretId = fieldSecretId(watcher.id, mailPasswordField);
            delete eff.password;
        }
        // Kept off the persisted watcher: `eff` is derived per poll and thrown
        // away, and this is the only place a credential is allowed to sit.
        eff.secretValues = secrets;
        return eff;
    }

    /**
     * Run one watcher and feed whatever it found to the trigger rules.
     *
     * Returns the events for the caller's benefit (tests, a "test now" button);
     * the real delivery is the triggerManager call.
     */
    async poll(watcher, now = Date.now()) {
        let events = [];
        let note = null;
        try {
            const eff = await this.resolve(watcher);
            if (eff.type === 'folder') {
                const scan = await this.invoke('scan_dir_mtimes', {
                    path: eff.path,
                    recursive: eff.recursive !== false,
                    maxEntries: 5000,
                });
                const r = diffFolder(eff, scan, now);
                events = r.events;
                watcher.baseline = r.baseline;
                note = r.note || (scan?.truncated ? 'truncated' : null);
            } else if (eff.type === 'command') {
                const stdout = await this.invoke('run_command', {
                    command: eff.command,
                    cwd: eff.cwd || null,
                    timeoutSecs: COMMAND_TIMEOUT_SECS,
                });
                events = eventsFromOutput(eff, stdout, now);
                // A command watcher has no baseline of its own — its script is
                // expected to report only what is new. Marking it established
                // anyway keeps `isFirstRun` meaningful for the UI.
                watcher.baseline = watcher.baseline || { established: now };
            } else if (eff.type === 'mail') {
                // The password is NOT here and never passes through this layer:
                // the backend reads it from the OS credential store by id, so
                // the settings JSON — which is synced, backed up and screen-
                // shared — never carries it.
                const result = await this.invoke('imap_check', {
                    query: {
                        host: eff.host,
                        port: Number(eff.port) || 993,
                        user: eff.user,
                        secretId: eff.secretId || secretIdFor(watcher.id),
                        folder: eff.folder || 'INBOX',
                        from: eff.mailFrom || null,
                        subject: eff.mailSubject || null,
                        unseenOnly: eff.unseenOnly !== false,
                        maxMessages: 25,
                    },
                });
                const r = diffMail(eff, result, now);
                events = r.events;
                watcher.baseline = r.baseline;
                note = r.note || (result?.truncated ? 'truncated' : null);
            } else if (eff.type === 'http') {
                // `raw` — status and body as separate fields. Without it the
                // response arrives with a status line in front of the body,
                // JSON.parse fails on it, and every watched path resolves to
                // null: a value that never changes, so the watcher reports "no
                // change" for ever while the number it watches moves.
                // The header VALUE is a credential — a bearer token, an API
                // key — and it lived in `jh_watchers`, which is localStorage:
                // synced, backed up, and readable by anything that can open the
                // profile. It goes to the OS credential store like the mailbox
                // password, and only its NAME stays in the settings.
                let headers = null;
                if (eff.recipe && eff.headerValue) {
                    // A recipe carries its own header value: the secret has
                    // already been put there by applySecrets, into the ONE slot
                    // SECRET_SLOTS allows it in.
                    //
                    // Gated on `recipe` and not on the value alone, because a
                    // watcher SAVED BEFORE the header value moved to the
                    // credential store still has the old plaintext field in
                    // localStorage. Trusting it here would quietly restore the
                    // leak this split exists to end.
                    headers = [[eff.headerName || 'Authorization', eff.headerValue]];
                } else if (eff.headerName) {
                    let value = '';
                    try {
                        value = await this.invoke('get_watcher_secret',
                            { id: authSecretIdFor(watcher.id) }) || '';
                    } catch (_) { value = ''; }
                    headers = [[eff.headerName, value]];
                }
                const envelope = await this.invoke('fetch_url', {
                    url: eff.url,
                    headers,
                    raw: true,
                });
                let status = 0;
                let body = envelope;
                try {
                    const parsed = JSON.parse(envelope);
                    // Only an object that actually CARRIES a body is an
                    // envelope. Taking `parsed.body` from any JSON that happens
                    // to parse turns a plain JSON response into `undefined` —
                    // the same silent nothing this whole fix is about.
                    if (parsed && typeof parsed === 'object' && typeof parsed.body === 'string') {
                        status = Number(parsed.status) || 0;
                        body = parsed.body;
                    }
                } catch (_) { /* not JSON at all: it is the body */ }
                // A 404 whose HTML parses to nothing is indistinguishable from
                // "nothing changed" unless the status is checked here.
                if (status && (status < 200 || status >= 300)) {
                    throw new Error(`${eff.url} が HTTP ${status} を返しました。`);
                }
                const r = diffHttp(eff, { body }, now);
                events = r.events;
                watcher.baseline = r.baseline;
                note = r.note || null;
            } else if (eff.type === 'script') {
                // A script the user wrote, run unattended. Everything that
                // makes that safe is here or one call away: the dangerous-
                // command refusal (below), the approval check (`resolve`), the
                // mandatory working directory and the path guard (the backend),
                // and the first-run rule (this branch, not the script).
                const refusal = scriptRefusal(eff.command);
                if (refusal) throw new Error(refusal);
                const firstRun = isFirstRun(watcher);
                const stdout = await this.invoke('run_watcher_script', {
                    command: eff.command,
                    // The recipe's own folder is the default: a bundled script
                    // is meant to run beside its files, and an empty cwd is
                    // refused by the backend rather than silently inheriting
                    // whatever the app happened to be started in.
                    cwd: eff.cwd || eff.recipe?.dir || '',
                    env: buildScriptEnv({
                        watcher, secrets: eff.secretValues, env: eff.env, firstRun,
                    }),
                    stdinData: buildScriptStdin({
                        watcher, config: eff, state: watcher.baseline?.state, firstRun,
                    }),
                    timeoutSecs: SCRIPT_TIMEOUT_SECS,
                });
                const r = parseScriptOutput(eff, stdout, now);
                watcher.baseline = {
                    state: r.hasState ? r.state : (watcher.baseline?.state ?? null),
                    established: watcher.baseline?.established || now,
                };
                // THE rule, and it is enforced here rather than trusted to the
                // script: the first poll records state and emits nothing. A
                // script that ignores JH_WATCHER_FIRST_RUN still cannot file
                // five hundred tasks the moment it is switched on.
                events = firstRun ? [] : r.events;
                note = firstRun ? 'baseline' : null;
            } else {
                throw new Error(`unknown watcher type: ${eff.type}`);
            }
            Object.assign(watcher, pollOutcome({
                ok: true, count: events.length, note,
                sample: events[0]?.payload || null,
            }, now));
        } catch (e) {
            // Recorded, not thrown. A watcher that has been failing for two days
            // looks exactly like a quiet one unless the failure is kept and
            // shown; the app must not go silent about work it promised to do.
            Object.assign(watcher, pollOutcome({ ok: false, error: e?.message || e }, now));
            return [];
        }

        for (const ev of events) {
            // Two facts every event carries, whatever produced it: WHEN, and
            // WHICH watcher. The rest of the payload is necessarily per-type —
            // a mail has a subject, a file has a path — but a prompt should
            // never have to know the type to say where something came from.
            ev.payload = { watcher: watcher.name || watcher.id, at: now, ...ev.payload };
            try { this.triggers.onEvent(ev); }
            catch (err) { console.warn('[WatcherManager] trigger intake failed:', err?.message || err); }
        }
        return events;
    }

    /**
     * Poll one watcher now, regardless of its interval. For the "check now"
     * button.
     *
     * Throws when the watcher is not in this manager's list. It used to return
     * `[]`, which the button reported as "0 found" — identical to a poll that
     * ran and saw nothing, and identical again to a first poll taking its
     * baseline. Three different situations, one number, and no way to tell
     * which had happened.
     */
    async runNow(id) {
        const w = this.watchers.find(x => x.id === id);
        if (!w) {
            throw new Error(`監視 ${id} が読み込まれていません。画面を開き直してください。`);
        }
        const events = await this.poll(w, Date.now());
        this.save();
        // The caller needs to distinguish "nothing changed" from "this was the
        // first look", and only the watcher's own state says which.
        return { events, note: w.lastNote, ok: w.lastOk !== false, error: w.lastError };
    }

    // ── CRUD ─────────────────────────────────────────────────────────────
    upsert(watcher) {
        const w = { ...WATCHER_DEFAULTS, id: `wch_${Date.now()}`, ...watcher };
        const i = this.watchers.findIndex(x => x.id === w.id);
        if (i >= 0) this.watchers[i] = { ...this.watchers[i], ...w };
        else this.watchers.push(w);
        this.save();
        this._schedule();
        this.syncConnections();
        return w;
    }

    remove(id) {
        this.watchers = this.watchers.filter(w => w.id !== id);
        this.save();
        this._schedule();
        this.syncConnections();
    }

    setEnabled(id, enabled) {
        const w = this.watchers.find(x => x.id === id);
        if (!w) return null;
        w.enabled = !!enabled;
        // Switching off and on again re-takes the baseline, so a watcher that
        // was off for a week does not wake up and report the whole week at once.
        if (!enabled) delete w.baseline;
        this.save();
        this._schedule();
        this.syncConnections();
        return w;
    }
}

export const watcherManager = new WatcherManager();
