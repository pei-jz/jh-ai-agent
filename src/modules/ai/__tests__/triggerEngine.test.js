// TriggerEngine — the guards, which are the whole point.
//
// "Run a task when an event arrives" is one line. What makes a trigger safe to
// leave switched on overnight is that three saves do not start three runs, a
// re-delivered webhook does not start a second one, and a broken source stops
// itself instead of filing hundreds of tasks. Each test below is one of those.
import { describe, it, expect, beforeEach } from 'vitest';
import {
    TriggerEngine, TRIGGER_DEFAULTS, DROP,
    matches, eventKey, renderPrompt, dig,
} from '../triggers/TriggerEngine.js';

const T0 = 1_700_000_000_000;

const trigger = (over = {}) => ({
    id: 't1', name: 'CI', enabled: true, prompt: 'fix it',
    match: { event: 'ci.failed' },
    ...over,
});
const ev = (over = {}) => ({
    source: 'webhook', event: 'ci.failed', payload: { repo: 'jh', status: 'failure' },
    ...over,
});

let e;
beforeEach(() => { e = new TriggerEngine(); });

describe('matching', () => {
    it('an empty match takes everything from that source', () => {
        expect(matches({}, ev())).toBe(true);
        expect(matches({ source: 'mcp' }, ev())).toBe(false);
    });

    it('matches on the event name, a prefix, and payload fields', () => {
        expect(matches({ event: 'ci.failed' }, ev())).toBe(true);
        expect(matches({ event: 'ci.passed' }, ev())).toBe(false);
        expect(matches({ eventPrefix: 'ci.' }, ev())).toBe(true);
        expect(matches({ where: { repo: 'jh' } }, ev())).toBe(true);
        expect(matches({ where: { repo: 'other' } }, ev())).toBe(false);
    });

    // A webhook's JSON gives the number 200; a person typing a condition gives
    // the string "200". Refusing to match those is a puzzle with no error.
    it('compares payload conditions as strings', () => {
        expect(matches({ where: { code: '200' } }, ev({ payload: { code: 200 } }))).toBe(true);
    });

    it('reads nested payload fields', () => {
        const event = ev({ payload: { head: { branch: 'master' } } });
        expect(matches({ where: { 'head.branch': 'master' } }, event)).toBe(true);
        expect(dig(event.payload, 'head.branch')).toBe('master');
        expect(dig(event.payload, 'head.missing.deep')).toBeUndefined();
    });
});

describe('a trigger is not live the moment it is created', () => {
    it('defaults to disabled', () => {
        expect(TRIGGER_DEFAULTS.enabled).toBe(false);
        e.setTriggers([{ id: 'a', prompt: 'x', match: {} }]);
        expect(e.accept(ev(), T0)[0].dropped).toBe(DROP.disabled);
    });
});

describe('a burst of events is one run', () => {
    it('collapses three saves into a single run carrying the count', () => {
        e.setTriggers([trigger({ debounceMs: 2000, dedupeWindowMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.accept(ev({ key: 'b' }), T0 + 500);
        e.accept(ev({ key: 'c' }), T0 + 900);

        // The window is extended by each event, so nothing is due yet.
        expect(e.due(T0 + 2100)).toEqual([]);

        const due = e.due(T0 + 2901);
        expect(due).toHaveLength(1);
        expect(due[0].count).toBe(3);
    });

    it('reports when the engine next needs looking at', () => {
        e.setTriggers([trigger({ debounceMs: 2000 })]);
        expect(e.nextWakeIn(T0)).toBe(Infinity);
        e.accept(ev(), T0);
        expect(e.nextWakeIn(T0)).toBe(2000);
        expect(e.nextWakeIn(T0 + 5000)).toBe(0);
    });
});

describe('the same event twice is one run', () => {
    it('drops a re-delivery inside the dedupe window', () => {
        e.setTriggers([trigger({ dedupeWindowMs: 60000 })]);
        expect(e.accept(ev({ key: 'delivery-1' }), T0)[0].accepted).toBe(true);
        expect(e.accept(ev({ key: 'delivery-1' }), T0 + 5000)[0].dropped).toBe(DROP.duplicate);
    });

    it('takes it again once the window has passed', () => {
        e.setTriggers([trigger({ dedupeWindowMs: 10000 })]);
        e.accept(ev({ key: 'd' }), T0);
        expect(e.accept(ev({ key: 'd' }), T0 + 10001)[0].accepted).toBe(true);
    });

    // Without a supplied key, identical content is still the same event.
    it('falls back to the shape of the event when no key is given', () => {
        expect(eventKey(ev())).toBe(eventKey(ev()));
        expect(eventKey(ev())).not.toBe(eventKey(ev({ event: 'ci.passed' })));
        e.setTriggers([trigger()]);
        e.accept(ev(), T0);
        expect(e.accept(ev(), T0 + 1000)[0].dropped).toBe(DROP.duplicate);
    });
});

describe('a runaway source stops instead of filing hundreds of tasks', () => {
    it('disables the trigger at the hourly cap and records why', () => {
        e.setTriggers([trigger({ maxPerHour: 3, dedupeWindowMs: 0, debounceMs: 0 })]);
        for (let i = 0; i < 3; i++) {
            expect(e.accept(ev({ key: `k${i}` }), T0 + i)[0].accepted, `event ${i}`).toBe(true);
            e.noteFired('t1', T0 + i);
            e.noteFinished('t1');
        }
        const fourth = e.accept(ev({ key: 'k3' }), T0 + 10);
        expect(fourth[0].dropped).toBe(DROP.rateLimited);

        // Stopped, not silently discarding — the difference between a broken
        // source you find out about and one you do not.
        const t = e.triggers[0];
        expect(t.enabled).toBe(false);
        expect(t.disabledReason).toBe(DROP.rateLimited);
        expect(t.disabledAt).toBe(T0 + 10);
    });

    it('lets the cap lapse after an hour', () => {
        e.setTriggers([trigger({ maxPerHour: 1, dedupeWindowMs: 0, debounceMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.noteFired('t1', T0);
        e.noteFinished('t1');
        expect(e.accept(ev({ key: 'b' }), T0 + 3600001)[0].accepted).toBe(true);
    });
});

describe('cooldown and concurrency', () => {
    it('holds off inside the cooldown', () => {
        e.setTriggers([trigger({ cooldownMs: 30000, dedupeWindowMs: 0, debounceMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.noteFired('t1', T0);
        e.noteFinished('t1');
        expect(e.accept(ev({ key: 'b' }), T0 + 1000)[0].dropped).toBe(DROP.cooldown);
        expect(e.accept(ev({ key: 'c' }), T0 + 31000)[0].accepted).toBe(true);
    });

    // A slow task plus a chatty source is how you get a pile-up, so skipping is
    // the default rather than something to remember to switch on.
    it('skips while the previous run is still going', () => {
        e.setTriggers([trigger({ dedupeWindowMs: 0, debounceMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.noteFired('t1', T0);
        expect(e.accept(ev({ key: 'b' }), T0 + 100)[0].dropped).toBe(DROP.running);
        e.noteFinished('t1');
        expect(e.accept(ev({ key: 'c' }), T0 + 200)[0].accepted).toBe(true);
    });

    // The window opened seconds ago; whether the earlier run is still going can
    // only be known when it closes.
    it('re-checks concurrency when the window closes, not only when it opens', () => {
        e.setTriggers([trigger({ debounceMs: 1000, dedupeWindowMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.noteFired('t1', T0);          // a different, earlier run starts meanwhile
        expect(e.due(T0 + 1001)).toEqual([]);
        expect(e.journal.at(-1).dropped).toBe(DROP.running);
    });
});

describe('the prompt carries the event', () => {
    it('fills in the event, its fields, and the collapsed count', () => {
        const out = renderPrompt(
            '{{payload.repo}} が落ちました ({{count}}件)\n{{event}}',
            ev(), 3);
        expect(out).toContain('jh が落ちました (3件)');
        expect(out).toContain('"status": "failure"');
    });

    // A prompt that silently loses half its content produces a run that fails
    // for reasons nobody can see.
    it('leaves an unresolved placeholder visible rather than blanking it', () => {
        expect(renderPrompt('branch={{payload.branch}}', ev())).toBe('branch={{payload.branch}}');
    });
});

describe('editing a trigger does not reset its guards', () => {
    it('keeps runtime state across setTriggers, and drops it for deleted ones', () => {
        e.setTriggers([trigger({ cooldownMs: 30000, dedupeWindowMs: 0, debounceMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.noteFired('t1', T0);
        e.noteFinished('t1');

        e.setTriggers([trigger({ cooldownMs: 30000, dedupeWindowMs: 0, debounceMs: 0, prompt: 'edited' })]);
        expect(e.accept(ev({ key: 'b' }), T0 + 1000)[0].dropped).toBe(DROP.cooldown);

        e.setTriggers([]);
        expect(e.state.size).toBe(0);
    });
});

describe('the journal says why', () => {
    it('records both what fired and what was dropped', () => {
        e.setTriggers([trigger({ dedupeWindowMs: 60000, debounceMs: 0 })]);
        e.accept(ev({ key: 'a' }), T0);
        e.accept(ev({ key: 'a' }), T0 + 10);
        expect(e.journal).toHaveLength(2);
        expect(e.journal[0].accepted).toBe(true);
        expect(e.journal[1].dropped).toBe(DROP.duplicate);
        expect(e.journal[1].event.key).toBe('a');
    });

    it('stays bounded under a chatty source', () => {
        e.setTriggers([trigger({ dedupeWindowMs: 0, debounceMs: 0, maxPerHour: 0 })]);
        for (let i = 0; i < 600; i++) e.accept(ev({ key: `k${i}` }), T0 + i);
        expect(e.journal.length).toBe(500);
    });
});
