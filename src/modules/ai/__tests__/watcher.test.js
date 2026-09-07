// Watchers — the app looking for itself, instead of asking Task Scheduler to.
//
// The rule these tests exist for is the first-run baseline: switching on a
// folder watcher must not file one task per file that was already sitting
// there. "It went berserk the moment I turned it on" is the failure a feature
// like this does not get to make twice.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../triggers/TriggerManager.js', () => ({ triggerManager: { onEvent: () => [] } }));

const {
    isDue, nextDueIn, isFirstRun, diffFolder, diffMail, diffHttp, pick,
    aggregate, excludeEntries, breakdown, eventsFromOutput, payloadFieldsFor, COMMON_FIELDS,
    WATCHER_DEFAULTS, HARD_EVENT_CAP,
} = await import('../triggers/WatcherEngine.js');
const { WatcherManager, secretIdFor, authSecretIdFor } = await import('../triggers/WatcherManager.js');

const T0 = 1_700_000_000_000;
const scan = (files, truncated = false) => ({ files, truncated });
const f = (path, modified, size = 10) => ({ path, modified, size });

describe('when a watcher runs', () => {
    it('is due once its interval has passed, and never while disabled', () => {
        const w = { enabled: true, everySeconds: 60, lastRunAt: T0 };
        expect(isDue(w, T0 + 59_000)).toBe(false);
        expect(isDue(w, T0 + 60_000)).toBe(true);
        expect(isDue({ ...w, enabled: false }, T0 + 999_999)).toBe(false);
    });

    it('is due immediately when it has never run', () => {
        expect(isDue({ enabled: true, everySeconds: 300 }, T0)).toBe(true);
    });

    // A 1-second interval typed by hand should not become a busy loop.
    it('will not poll faster than every 5 seconds', () => {
        const w = { enabled: true, everySeconds: 1, lastRunAt: T0 };
        expect(isDue(w, T0 + 4_000)).toBe(false);
        expect(isDue(w, T0 + 5_000)).toBe(true);
    });

    it('reports when the next one is due, and Infinity when none are on', () => {
        expect(nextDueIn([{ enabled: true, everySeconds: 60, lastRunAt: T0 }], T0)).toBe(60_000);
        expect(nextDueIn([{ enabled: false, everySeconds: 60 }], T0)).toBe(Infinity);
        expect(nextDueIn([], T0)).toBe(Infinity);
    });
});

describe('the first poll establishes what is already there', () => {
    const w = { eventName: 'file.changed' };

    it('emits nothing and records the baseline', () => {
        const files = Array.from({ length: 500 }, (_, i) => f(`C:/w/f${i}.txt`, T0));
        const r = diffFolder(w, scan(files), T0);
        expect(r.events, '500 tasks is what this rule exists to prevent').toEqual([]);
        expect(Object.keys(r.baseline)).toHaveLength(500);
        expect(r.note).toBe('baseline');
    });

    it('is what isFirstRun reports', () => {
        expect(isFirstRun(w)).toBe(true);
        expect(isFirstRun({ ...w, baseline: {} })).toBe(false);
    });
});

describe('after the baseline, only the difference is reported', () => {
    const base = { 'C:/w/a.txt': T0, 'C:/w/b.txt': T0 };
    const w = { eventName: 'file.changed', baseline: base };

    it('says nothing when nothing moved', () => {
        const r = diffFolder(w, scan([f('C:/w/a.txt', T0), f('C:/w/b.txt', T0)]), T0);
        expect(r.events).toEqual([]);
    });

    it('reports a changed file, a new one, and a deleted one — each once', () => {
        const r = diffFolder(w, scan([f('C:/w/a.txt', T0 + 5), f('C:/w/c.txt', T0 + 9)]), T0 + 10);
        const kinds = Object.fromEntries(r.events.map(e => [e.payload.name, e.payload.kind]));
        expect(kinds).toEqual({ 'a.txt': 'changed', 'c.txt': 'created', 'b.txt': 'deleted' });
    });

    // The key is what stops a poll every 30s from re-firing the same edit.
    it('keys an edit by path and mtime, so re-seeing it is the same event', () => {
        const r1 = diffFolder(w, scan([f('C:/w/a.txt', T0 + 5), f('C:/w/b.txt', T0)]), T0);
        const r2 = diffFolder(w, scan([f('C:/w/a.txt', T0 + 5), f('C:/w/b.txt', T0)]), T0 + 60_000);
        expect(r1.events[0].key).toBe(r2.events[0].key);
        // A second edit is a different event.
        const r3 = diffFolder(w, scan([f('C:/w/a.txt', T0 + 99), f('C:/w/b.txt', T0)]), T0);
        expect(r3.events[0].key).not.toBe(r1.events[0].key);
    });

    it('stops at the per-poll cap rather than filing a hundred tasks', () => {
        const many = Array.from({ length: 100 }, (_, i) => f(`C:/w/n${i}.txt`, T0 + 1));
        const r = diffFolder({ ...w, maxEventsPerPoll: 5 }, scan(many), T0);
        expect(r.events).toHaveLength(5);
    });

    it('will not exceed the hard cap however the watcher is configured', () => {
        const many = Array.from({ length: 400 }, (_, i) => f(`C:/w/n${i}.txt`, T0 + 1));
        const r = diffFolder({ ...w, maxEventsPerPoll: 9999 }, scan(many), T0);
        expect(r.events).toHaveLength(HARD_EVENT_CAP);
    });
});

describe('a command watcher reads its own output', () => {
    const w = { id: 'wch_1', eventName: 'mail.received' };

    it('takes a JSON line as the event it declares itself to be', () => {
        const out = eventsFromOutput(w, '{"event":"ci.failed","key":"run-7","payload":{"repo":"jh"}}');
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ source: 'watcher', event: 'ci.failed', key: 'run-7' });
        expect(out[0].payload.repo).toBe('jh');
    });

    it('takes a plain line as the watcher event, keyed by the line itself', () => {
        const out = eventsFromOutput(w, 'ERROR: disk full\n\nERROR: disk full\n');
        expect(out).toHaveLength(2);
        expect(out[0].event).toBe('mail.received');
        // Same text, same key: the same finding next poll does not run twice.
        expect(out[0].key).toBe(out[1].key);
    });

    it('ignores plain output when the watcher names no event', () => {
        expect(eventsFromOutput({ id: 'x' }, 'some noise')).toEqual([]);
    });

    it('does not guess at a broken JSON line', () => {
        const out = eventsFromOutput(w, '{"event":"x"  <- truncated');
        // Falls through to the plain-line form rather than inventing fields.
        expect(out[0].payload.line).toContain('truncated');
    });
});

describe('the manager', () => {
    let mgr, invoker, triggers, seen;
    const storage = (seed = {}) => {
        const map = new Map(Object.entries(seed));
        return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        seen = [];
        triggers = { onEvent: (e) => { seen.push(e); return []; } };
        invoker = vi.fn(async () => scan([f('C:/w/a.txt', T0)]));
        mgr = new WatcherManager({
            storage: storage({
                jh_watchers: JSON.stringify([{
                    id: 'wch_1', name: 'docs', type: 'folder', enabled: true,
                    path: 'C:/w', everySeconds: 60, eventName: 'file.changed',
                }]),
            }),
            triggers, invoker,
        });
        mgr.reload();
    });

    it('takes a baseline on the first tick and starts nothing', async () => {
        await mgr.tick(T0);
        expect(seen).toEqual([]);
        expect(mgr.watchers[0].baseline).toBeTruthy();
        expect(mgr.watchers[0].lastOk).toBe(true);
    });

    it('feeds the difference to the trigger rules on the next one', async () => {
        await mgr.tick(T0);
        invoker.mockResolvedValue(scan([f('C:/w/a.txt', T0 + 500)]));
        await mgr.tick(T0 + 60_000);
        expect(seen).toHaveLength(1);
        expect(seen[0].payload.path).toBe('C:/w/a.txt');
    });

    // A watcher failing for two days looks exactly like a quiet one unless the
    // failure is kept and shown.
    it('records a failure instead of throwing or going silent', async () => {
        invoker.mockRejectedValue(new Error('not a directory: C:/gone'));
        await mgr.tick(T0);
        const w = mgr.watchers[0];
        expect(w.lastOk).toBe(false);
        expect(w.lastError).toContain('not a directory');
        expect(seen).toEqual([]);
    });

    it('polls one at a time', async () => {
        let release;
        invoker.mockImplementation(() => new Promise(r => { release = () => r(scan([])); }));
        const first = mgr.tick(T0);
        const second = await mgr.tick(T0);      // must not start a second poll
        expect(second).toEqual([]);
        release();
        await first;
        expect(invoker).toHaveBeenCalledTimes(1);
    });

    it('arms no timer while every watcher is off', () => {
        mgr.setEnabled('wch_1', false);
        expect(mgr._timer).toBeNull();
    });

    // Off for a week, then on: it should not report the whole week at once.
    it('re-takes the baseline when switched back on', async () => {
        await mgr.tick(T0);
        expect(mgr.watchers[0].baseline).toBeTruthy();
        mgr.setEnabled('wch_1', false);
        expect(mgr.watchers[0].baseline).toBeUndefined();
    });

    it('creates new watchers disabled', () => {
        const w = mgr.upsert({ name: 'x', type: 'folder', path: 'C:/y' });
        expect(w.enabled).toBe(false);
        expect(WATCHER_DEFAULTS.enabled).toBe(false);
    });
});

describe('mail', () => {
    const w = { eventName: 'mail.received' };
    const m = (id, subject) => ({ id, from: 'a@b.c', to: 'me@x.y', subject, date: 'now', body: 'hi' });

    // Forty unread messages in the inbox must not become forty tasks the moment
    // the watcher is switched on. Same rule as the folder watcher, same reason.
    it('starts nothing on the first check, however full the inbox is', () => {
        const many = Array.from({ length: 40 }, (_, i) => m(`<${i}@x>`, `s${i}`));
        const r = diffMail(w, { messages: many });
        expect(r.events).toEqual([]);
        expect(Object.keys(r.baseline)).toHaveLength(40);
        expect(r.note).toBe('baseline');
    });

    it('reports only what arrived since', () => {
        const base = { events: [], baseline: { '<1@x>': 1 } };
        const r = diffMail({ ...w, baseline: base.baseline }, { messages: [m('<1@x>', 'old'), m('<2@x>', 'new')] });
        expect(r.events).toHaveLength(1);
        expect(r.events[0].payload.subject).toBe('new');
    });

    // An unread mail is seen again on every poll; the Message-ID is what stops
    // it starting a task each time.
    it('keys on the Message-ID, so an unread mail fires once', () => {
        const first = diffMail({ ...w, baseline: {} }, { messages: [m('<7@x>', 's')] });
        expect(first.events[0].key).toBe('<7@x>');
        const second = diffMail({ ...w, baseline: first.baseline }, { messages: [m('<7@x>', 's')] });
        expect(second.events).toEqual([]);
    });

    // Otherwise the id set grows for the life of the watcher.
    it('forgets ids that no longer match', () => {
        const r = diffMail({ ...w, baseline: { '<old@x>': 1 } }, { messages: [m('<new@x>', 's')] });
        expect(r.baseline).toEqual({ '<new@x>': 1 });
    });

    it('respects the per-poll cap', () => {
        const many = Array.from({ length: 50 }, (_, i) => m(`<n${i}@x>`, 's'));
        const r = diffMail({ ...w, baseline: {}, maxEventsPerPoll: 3 }, { messages: many });
        expect(r.events).toHaveLength(3);
    });
});

describe('http', () => {
    const w = { id: 'wch_h', eventName: 'http.changed', watchPath: 'status' };

    it('reads a nested value by path', () => {
        expect(pick({ a: { b: { c: 5 } } }, 'a.b.c')).toBe(5);
        expect(pick({ a: 1 }, 'a.missing.deep')).toBeNull();
    });

    it('says nothing on the first look, then reports a change once', () => {
        const first = diffHttp(w, { body: '{"status":"green"}' });
        expect(first.events).toEqual([]);

        const changed = diffHttp({ ...w, baseline: first.baseline }, { body: '{"status":"red"}' });
        expect(changed.events).toHaveLength(1);
        expect(changed.events[0].payload).toMatchObject({ value: 'red', previous: 'green' });

        const same = diffHttp({ ...w, baseline: changed.baseline }, { body: '{"status":"red"}' });
        expect(same.events).toEqual([]);
    });

    // A timestamp elsewhere in the payload must not make every poll look like news.
    it('watches only the path it was given', () => {
        const a = diffHttp(w, { body: '{"status":"green","checkedAt":1}' });
        const b = diffHttp({ ...w, baseline: a.baseline }, { body: '{"status":"green","checkedAt":2}' });
        expect(b.events).toEqual([]);
    });

    // Firing every poll while a build stays red is how one broken build becomes
    // two hundred tasks overnight.
    it('fires a condition on the transition, not for as long as it holds', () => {
        const cw = { ...w, equals: 'failure', eventName: 'ci.failed' };
        const base = diffHttp(cw, { body: '{"status":"success"}' });
        expect(base.events).toEqual([]);

        const broke = diffHttp({ ...cw, baseline: base.baseline }, { body: '{"status":"failure"}' });
        expect(broke.events).toHaveLength(1);

        const stillBroken = diffHttp({ ...cw, baseline: broke.baseline }, { body: '{"status":"failure"}' });
        expect(stillBroken.events).toEqual([]);

        // Recovered, then broke again: that IS news.
        const fixed = diffHttp({ ...cw, baseline: stillBroken.baseline }, { body: '{"status":"success"}' });
        const again = diffHttp({ ...cw, baseline: fixed.baseline }, { body: '{"status":"failure"}' });
        expect(again.events).toHaveLength(1);
    });

    it('handles a plain-text response without pretending it is JSON', () => {
        const tw = { id: 'x', watchPath: null, eventName: 'page.changed' };
        const a = diffHttp(tw, { body: 'v1.0.0' });
        const b = diffHttp({ ...tw, baseline: a.baseline }, { body: 'v1.0.1' });
        expect(b.events[0].payload.value).toBe('v1.0.1');
    });
});

describe('the mailbox password never travels with the settings', () => {
    it('is addressed by id, and the id has one definition', () => {
        expect(secretIdFor('wch_9')).toBe('watcher:wch_9');
    });

    it('is not in what the watcher asks the backend for', async () => {
        const calls = [];
        const mgr = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            invoker: async (cmd, args) => { calls.push({ cmd, args }); return { messages: [] }; },
        });
        await mgr.poll({
            id: 'wch_9', type: 'mail', host: 'imap.x', user: 'me',
            password: 'SHOULD-NEVER-BE-SENT', eventName: 'mail.received',
        }, T0);

        expect(calls[0].cmd).toBe('imap_check');
        expect(calls[0].args.query.secretId).toBe('watcher:wch_9');
        expect(JSON.stringify(calls[0].args)).not.toContain('SHOULD-NEVER-BE-SENT');
    });
});

// The shape of a real GitHub release, because that is the endpoint this was
// built for and the one whose quirks matter. `latest.json` is not a download —
// its counter goes up every time an INSTALLED copy checks for an update.
const GH_RELEASE = {
    tag_name: 'v0.1.0',
    assets: [
        { name: 'J.H.AI.Agent_0.1.0_x64-portable.zip', download_count: 1 },
        { name: 'J.H.AI.Agent_0.1.0_x64-setup.exe', download_count: 3 },
        { name: 'J.H.AI.Agent_0.1.0_x64-setup.exe.sig', download_count: 0 },
        { name: 'latest.json', download_count: 4 },
    ],
};
const gh = (mutate) => {
    const copy = JSON.parse(JSON.stringify(GH_RELEASE));
    if (mutate) mutate(copy);
    return { body: JSON.stringify(copy) };
};

describe('watching a list, not a single value', () => {
    // Written without a dot before the brackets, the way anyone types it.
    it('maps over an array with []', () => {
        expect(pick(GH_RELEASE, 'assets[].download_count')).toEqual([1, 3, 0, 4]);
        expect(pick(GH_RELEASE, 'assets[].name')).toHaveLength(4);
    });

    it('still indexes with a number', () => {
        expect(pick(GH_RELEASE, 'assets.1.download_count')).toBe(3);
    });

    it('reduces to the number being watched', () => {
        expect(aggregate([1, 3, 0, 4], 'sum')).toBe(8);
        expect(aggregate([1, 3, 0, 4], 'count')).toBe(4);
        expect(aggregate([1, 3, 0, 4], 'max')).toBe(4);
        expect(aggregate([1, 3], undefined)).toEqual([1, 3]);
    });

    it('drops the entries that are not downloads', () => {
        const kept = excludeEntries(GH_RELEASE.assets, 'name', 'latest.json,.sig');
        expect(kept.map(a => a.download_count)).toEqual([1, 3]);
    });
});

describe('GitHub download counts, end to end', () => {
    const w = {
        id: 'wch_gh', eventName: 'release.downloaded',
        watchPath: 'assets[].download_count', aggregate: 'sum',
        filterField: 'name', filterExclude: 'latest.json,.sig',
    };

    it('counts the installer and the portable build, and nothing else', () => {
        const first = diffHttp(w, gh());
        expect(first.events).toEqual([]);              // first look is a baseline
        expect(first.baseline.stamp).toBe('4');        // 3 + 1, not 8
    });

    it('fires once when someone actually downloads, carrying both numbers', () => {
        const base = diffHttp(w, gh()).baseline;
        const r = diffHttp({ ...w, baseline: base }, gh(d => { d.assets[1].download_count = 4; }));
        expect(r.events).toHaveLength(1);
        // Both numbers. The same quantity must not come back as two types.
        expect(r.events[0].payload).toMatchObject({ value: 5, previous: 4 });
        expect(typeof r.events[0].payload.previous).toBe('number');
    });

    // THE case this filter exists for. Without it, every installed copy
    // checking for updates moves the number, and every move starts a task.
    it('does not fire when only the update-check counter moves', () => {
        const base = diffHttp(w, gh()).baseline;
        const r = diffHttp({ ...w, baseline: base }, gh(d => { d.assets[3].download_count = 99; }));
        expect(r.events).toEqual([]);
    });

    it('does not fire when nothing moved', () => {
        const base = diffHttp(w, gh()).baseline;
        expect(diffHttp({ ...w, baseline: base }, gh()).events).toEqual([]);
    });

    // A new release adds assets; the total jumps. That IS news.
    it('fires when a new release adds a downloadable asset', () => {
        const base = diffHttp(w, gh()).baseline;
        const r = diffHttp({ ...w, baseline: base },
            gh(d => d.assets.push({ name: 'v0.1.1.exe', download_count: 2 })));
        expect(r.events).toHaveLength(1);
        expect(r.events[0].payload.value).toBe(6);
    });
});

describe('a watcher says what it produces', () => {
    // A documented field that is not emitted is worse than no documentation:
    // the prompt keeps the placeholder instead of the value, and the run reads
    // as if the watcher had failed. So the list is checked against what the
    // diff functions actually put in `payload`.
    const emitted = {
        folder: diffFolder(
            { eventName: 'e', baseline: {} },
            { files: [{ path: 'C:/w/a.txt', modified: 2, size: 9 }] },
        ).events[0].payload,
        mail: diffMail(
            { eventName: 'e', baseline: {} },
            { messages: [{ id: '<1@x>', from: 'a', to: 'b', subject: 's', date: 'd', body: 'z' }] },
        ).events[0].payload,
        http: diffHttp(
            { id: 'w', eventName: 'e', baseline: { stamp: 'old', value: 'old' }, url: 'http://x' },
            { body: 'new' },
        ).events[0].payload,
        command: eventsFromOutput({ id: 'w', eventName: 'e' }, 'a line')[0].payload,
    };

    // Two producers, so two checks. The diff functions own the type-specific
    // fields; the manager stamps the common ones on the way out (one place, so
    // no diff function has to remember). A field listed but produced by
    // NEITHER is the failure this guards against — the prompt would keep the
    // placeholder and the run would read as if the watcher had failed.
    it.each(Object.keys(emitted))('every type-specific field listed for %s is emitted', (type) => {
        const common = COMMON_FIELDS.map(f => f[0]);
        for (const [name] of payloadFieldsFor(type)) {
            if (common.includes(name)) continue;      // added by the manager
            expect(Object.keys(emitted[type]), `${type}.${name}`).toContain(name);
        }
    });

    it('lists something for every type the manager handles', () => {
        for (const type of ['folder', 'mail', 'http', 'command']) {
            expect(payloadFieldsFor(type).length, type).toBeGreaterThan(0);
        }
        expect(payloadFieldsFor('nonsense')).toEqual([]);
    });
});

describe('the last event is kept so it can be shown', () => {
    it('records the payload of what actually fired', async () => {
        const mgr = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            invoker: async () => ({ files: [{ path: 'C:/w/a.txt', modified: 5, size: 1 }] }),
        });
        const w = { id: 'w1', type: 'folder', path: 'C:/w', eventName: 'file.changed', baseline: {} };
        await mgr.poll(w, T0);
        expect(w.lastSample).toMatchObject({ path: 'C:/w/a.txt', name: 'a.txt', kind: 'created' });
    });

    it('leaves it alone when a poll found nothing', async () => {
        const mgr = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            invoker: async () => ({ files: [] }),
        });
        const w = { id: 'w2', type: 'folder', path: 'C:/w', eventName: 'file.changed', baseline: {} };
        await mgr.poll(w, T0);
        expect(w.lastSample).toBeUndefined();
        expect(w.lastCount).toBe(0);
    });
});

describe('"check now" cannot report nothing when nothing was checked', () => {
    let mgr, invoker;
    const storage = (seed = {}) => {
        const map = new Map(Object.entries(seed));
        return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    };
    const W = {
        id: 'wch_1', name: 'gh', type: 'http', enabled: true, everySeconds: 1800,
        url: 'https://x/y', eventName: 'release.downloaded',
    };

    beforeEach(() => {
        invoker = vi.fn(async () => JSON.stringify({ status: 200, body: '{"n":1}' }));
        mgr = new WatcherManager({
            storage: storage({ jh_watchers: JSON.stringify([W]) }),
            triggers: { onEvent: () => [] },
            invoker,
        });
        mgr.reload();
    });

    // The reported symptom: a dialog showing 0, a watcher with no trace of
    // having run, and no way to tell those two facts apart.
    it('throws rather than returning an empty result for a watcher it does not have', async () => {
        await expect(mgr.runNow('nope')).rejects.toThrow(/読み込まれていません/);
    });

    // A first look finds nothing BY DESIGN. Saying "0" for it is
    // indistinguishable from a poll that saw no change.
    it('says the first look was a baseline', async () => {
        const r = await mgr.runNow('wch_1');
        expect(r.note).toBe('baseline');
        expect(r.events).toEqual([]);
        expect(mgr.watchers[0].lastRunAt, 'a poll always leaves a trace').toBeTruthy();
    });

    it('says nothing changed on a second identical look', async () => {
        await mgr.runNow('wch_1');
        const r = await mgr.runNow('wch_1');
        expect(r.note).toBeFalsy();
        expect(r.events).toEqual([]);
    });

    it('reports the change when there is one', async () => {
        await mgr.runNow('wch_1');
        invoker.mockResolvedValue(JSON.stringify({ status: 200, body: '{"n":2}' }));
        const r = await mgr.runNow('wch_1');
        expect(r.events).toHaveLength(1);
    });

    it('reports a failure as a failure, not as zero', async () => {
        invoker.mockRejectedValue(new Error('host unreachable'));
        const r = await mgr.runNow('wch_1');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('host unreachable');
    });
});

describe('a value that cannot be read is never "no change"', () => {
    const W = {
        id: 'w', type: 'http', enabled: true, everySeconds: 1800,
        url: 'https://api.example.com/x', eventName: 'release.downloaded',
        watchPath: 'assets[].download_count', aggregate: 'sum',
    };
    const PAYLOAD = JSON.stringify({ assets: [{ name: 'a.exe', download_count: 4 }] });
    const store = (seed) => {
        const map = new Map(Object.entries(seed));
        return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    };
    const mk = (envelope) => {
        const m = new WatcherManager({
            storage: store({ jh_watchers: JSON.stringify([W]) }),
            triggers: { onEvent: () => [] },
            invoker: vi.fn(async () => envelope),
        });
        m.reload();
        return m;
    };

    it('asks the backend for the raw envelope, not the readable form', async () => {
        const m = mk(JSON.stringify({ status: 200, body: PAYLOAD }));
        await m.runNow('w');
        expect(m._invoke.mock.calls[0][1].raw).toBe(true);
    });

    it('reads the number out of the body', async () => {
        const m = mk(JSON.stringify({ status: 200, body: PAYLOAD }));
        const r = await m.runNow('w');
        expect(r.note).toBe('baseline');
        expect(m.watchers[0].baseline).toMatchObject({ stamp: '4', value: 4 });
        // It sums a list, so it also records what the terms were.
        expect(m.watchers[0].baseline.parts).toEqual([['a.exe', 4]]);
    });

    // THE bug: a status line in front of the body made JSON.parse fail, every
    // path resolved to null, and a baseline of the string "null" never changes
    // — so the watcher ran on schedule and reported "no change" for ever.
    it('fails loudly on a body it cannot parse, instead of storing null', async () => {
        const m = mk('HTTP 200 OK — Content-Type: application/json\n\n' + PAYLOAD);
        const r = await m.runNow('w');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('assets[].download_count');
        expect(m.watchers[0].baseline, 'nothing was stored').toBeUndefined();
    });

    // A 404 page whose HTML parses to nothing is indistinguishable from "no
    // change" unless the status is looked at.
    it('treats a non-2xx response as a failure', async () => {
        const m = mk(JSON.stringify({ status: 404, body: '<html>not found</html>' }));
        const r = await m.runNow('w');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('404');
    });

    it('says which path was not found', async () => {
        const m = mk(JSON.stringify({ status: 200, body: '{"other":1}' }));
        const r = await m.runNow('w');
        expect(r.error).toContain('assets[].download_count');
    });

    // Watching a whole plain-text response is legitimate — no path, no fault.
    it('still allows watching the response as a whole', async () => {
        const m = new WatcherManager({
            storage: store({ jh_watchers: JSON.stringify([{ ...W, watchPath: '', aggregate: '' }]) }),
            triggers: { onEvent: () => [] },
            invoker: async () => JSON.stringify({ status: 200, body: 'v1.0.0' }),
        });
        m.reload();
        const r = await m.runNow('w');
        expect(r.ok).toBe(true);
        expect(m.watchers[0].baseline.stamp).toBe('v1.0.0');
    });
});

describe('a change from an unknown previous value', () => {
    const w = { id: 'w', eventName: 'e', watchPath: 'n', url: 'u' };

    // The state a broken poll left behind: a baseline with no usable value.
    // "It changed from unknown to 5" is not information, and a job told to
    // write `{{payload.previous}}` cannot fill it — so the run is refused and
    // the person sees a failure for something that is merely unknown.
    it('re-takes the baseline instead of reporting a change nobody can use', () => {
        const r = diffHttp({ ...w, baseline: { stamp: 'null', value: null } }, { body: '{"n":5}' });
        expect(r.events).toEqual([]);
        expect(r.note).toBe('baseline');
        expect(r.baseline).toEqual({ stamp: '5', value: 5 });
    });

    it('reports normally from the next change on', () => {
        const first = diffHttp({ ...w, baseline: { stamp: 'null', value: null } }, { body: '{"n":5}' });
        const r = diffHttp({ ...w, baseline: first.baseline }, { body: '{"n":6}' });
        expect(r.events[0].payload).toMatchObject({ value: 6, previous: 5 });
    });
});

describe('what every event carries, whatever produced it', () => {
    it('is two fields, and they lead the list for every type', () => {
        expect(COMMON_FIELDS.map(f => f[0])).toEqual(['watcher', 'at']);
        for (const type of ['folder', 'mail', 'http', 'command']) {
            expect(payloadFieldsFor(type).slice(0, 2).map(f => f[0]), type)
                .toEqual(['watcher', 'at']);
        }
    });

    // The rest is per-type and has to be: flattening a mail and a file into one
    // shape would mean calling a file's path `value`.
    it('leaves the type-specific fields alone', () => {
        expect(payloadFieldsFor('mail').map(f => f[0])).toContain('subject');
        expect(payloadFieldsFor('folder').map(f => f[0])).toContain('path');
        expect(payloadFieldsFor('http').map(f => f[0])).toContain('previous');
    });

    it('stamps them on the way out, so no diff function has to remember', async () => {
        const seen = [];
        const m = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: (e) => { seen.push(e); return []; } },
            invoker: async () => ({ files: [{ path: 'C:/w/a.txt', modified: 9, size: 1 }] }),
        });
        await m.poll({ id: 'w9', name: 'docs', type: 'folder', path: 'C:/w',
                       eventName: 'file.changed', baseline: {} }, T0);
        expect(seen[0].payload.watcher).toBe('docs');
        expect(seen[0].payload.at).toBe(T0);
    });
});

describe('not everything a URL returns is JSON', () => {
    const RSS = '<rss><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>';
    const w = { id: 'w', eventName: 'feed.changed', url: 'http://x/rss',
                watchRegex: '<title>([^<]+)</title>' };

    // XML, HTML, a plain version file. Parsing each properly would mean a
    // parser per format, and what is being watched is almost always ONE value
    // inside it.
    it('takes the first capture group out of XML', () => {
        const a = diffHttp(w, { body: RSS });
        expect(a.baseline).toEqual({ stamp: 'A', value: 'A' });
        expect(a.events).toEqual([]);
    });

    it('reports a change in that value', () => {
        const a = diffHttp(w, { body: RSS });
        const b = diffHttp({ ...w, baseline: a.baseline },
            { body: RSS.replace('<title>A</title>', '<title>Z</title>') });
        expect(b.events[0].payload).toMatchObject({ value: 'Z', previous: 'A' });
    });

    it('fails loudly when the pattern matches nothing', () => {
        expect(() => diffHttp(w, { body: '<rss></rss>' })).toThrow(/一致しませんでした/);
    });

    it('says so when the pattern itself is invalid', () => {
        expect(() => diffHttp({ ...w, watchRegex: '([' }, { body: RSS }))
            .toThrow(/正規表現が不正/);
    });

    // The regex route and the JSON route share the compare-and-emit step, so a
    // condition behaves the same in both.
    it('fires a condition on the transition, as the JSON route does', () => {
        const cw = { ...w, equals: 'Z' };
        const base = diffHttp(cw, { body: RSS });
        const hit = diffHttp({ ...cw, baseline: base.baseline },
            { body: RSS.replace('<title>A</title>', '<title>Z</title>') });
        expect(hit.events).toHaveLength(1);
        const still = diffHttp({ ...cw, baseline: hit.baseline },
            { body: RSS.replace('<title>A</title>', '<title>Z</title>') });
        expect(still.events).toEqual([]);
    });
});

describe('the HTTP auth header is a credential', () => {
    // It used to be saved in `jh_watchers` — localStorage: synced, backed up,
    // and readable by anything that can open the profile.
    it('is fetched from the credential store, never from the watcher', async () => {
        const calls = [];
        const m = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            invoker: async (cmd, args) => {
                calls.push({ cmd, args });
                if (cmd === 'get_watcher_secret') return 'Bearer SECRET';
                return JSON.stringify({ status: 200, body: '{"n":1}' });
            },
        });
        await m.poll({
            id: 'w1', type: 'http', url: 'http://x', eventName: 'e',
            headerName: 'Authorization', headerValue: 'SHOULD-NOT-BE-USED',
        }, T0);

        const secret = calls.find(c => c.cmd === 'get_watcher_secret');
        expect(secret.args.id).toBe('watcher-auth:w1');
        const fetch = calls.find(c => c.cmd === 'fetch_url');
        expect(fetch.args.headers).toEqual([['Authorization', 'Bearer SECRET']]);
    });

    it('sends no header at all when none is configured', async () => {
        const calls = [];
        const m = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            invoker: async (cmd, args) => {
                calls.push({ cmd, args });
                return JSON.stringify({ status: 200, body: '{"n":1}' });
            },
        });
        await m.poll({ id: 'w2', type: 'http', url: 'http://x', eventName: 'e' }, T0);
        expect(calls[0].args.headers).toBeNull();
    });
});

describe('the total shows its terms', () => {
    // "Is the exclusion even working?" could only be answered by fetching the
    // API by hand and doing the arithmetic. A total that cannot show its terms
    // is a number you have to take on trust.
    const w = {
        id: 'w', eventName: 'e', url: 'u',
        watchPath: 'assets[].download_count', aggregate: 'sum',
        filterField: 'name', filterExclude: 'latest.json,.sig',
    };

    it('records what each surviving entry contributed', () => {
        const r = diffHttp(w, gh());
        expect(r.baseline.value).toBe(4);
        expect(r.baseline.parts).toEqual([
            ['J.H.AI.Agent_0.1.0_x64-portable.zip', 1],
            ['J.H.AI.Agent_0.1.0_x64-setup.exe', 3],
        ]);
    });

    // The excluded ones must be absent from the breakdown too — otherwise the
    // list would not answer the question it exists for.
    it('leaves the excluded entries out of the breakdown', () => {
        const names = diffHttp(w, gh()).baseline.parts.map(p => p[0]);
        expect(names.join(' ')).not.toContain('latest.json');
        expect(names.join(' ')).not.toContain('.sig');
    });

    it('says nothing for a watcher that reads a single field', () => {
        expect(breakdown({ status: 'ok' }, { watchPath: 'status' })).toBeNull();
        expect(breakdown({ a: [] }, { aggregate: 'sum' })).toBeNull();
    });

    // A long list is for checking, not for dumping into localStorage.
    it('caps how much it keeps', () => {
        const many = { assets: Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, download_count: 1 })) };
        const parts = breakdown(many, { watchPath: 'assets[].download_count', aggregate: 'sum' });
        expect(parts.length).toBeLessThanOrEqual(12);
    });
});
