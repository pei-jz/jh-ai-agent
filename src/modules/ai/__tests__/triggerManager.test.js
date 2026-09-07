// TriggerManager — the I/O half. Storage, the clock, and starting the task.
//
// The decisions are TriggerEngine's and are tested there. What matters here is
// that a decision actually becomes a run, that the run says WHY it happened,
// and that a failed start is recorded as a failure rather than as silence.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../AgentModes.js', () => ({
    DEFAULT_MODE_ID: 'standard',
    buildBehavior: () => ({ enabled_tools: null }),
}));

const { TriggerManager } = await import('../triggers/TriggerManager.js');
const { TriggerEngine } = await import('../triggers/TriggerEngine.js');

const T0 = 1_700_000_000_000;

/** A localStorage stand-in, so nothing here touches a real one. */
function fakeStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        _raw: map,
    };
}

const TRIGGER = {
    id: 'trg_ci', name: 'CI failed', enabled: true,
    match: { event: 'ci.failed' },
    prompt: '{{payload.repo}} の CI が落ちました ({{count}}件)',
    workspacePath: 'C:/work', debounceMs: 0, dedupeWindowMs: 0,
};

const EVENT = { source: 'webhook', event: 'ci.failed', payload: { repo: 'jh-ai-agent' }, key: 'k1' };

let mgr, client, calls;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    calls = [];
    client = {
        request: vi.fn(async (path, opts) => {
            calls.push({ path, body: JSON.parse(opts.body) });
            return { task_id: 'task-1' };
        }),
    };
    mgr = new TriggerManager({
        engine: new TriggerEngine(),
        storage: fakeStorage({ jh_triggers: JSON.stringify([TRIGGER]) }),
        client,
    });
    mgr.reload();
});

describe('an event becomes a run', () => {
    it('starts a task with the rendered prompt and the trigger workspace', async () => {
        mgr.onEvent(EVENT);
        await mgr.tick();

        expect(client.request).toHaveBeenCalledTimes(1);
        const { path, body } = calls[0];
        expect(path).toBe('/tasks');
        expect(body.prompt).toBe('jh-ai-agent の CI が落ちました (1件)');
        expect(body.workspace_path).toBe('C:/work');
        // Visible as a trigger run in the task list, not as something the user typed.
        expect(body.caller).toBe('Trigger');
    });

    // An autonomous run that cannot say why it happened is just an
    // unpredictable app.
    it('carries what set it off into the run itself', async () => {
        mgr.onEvent(EVENT);
        await mgr.tick();
        const ctx = calls[0].body.behavior.mcp_context;
        expect(ctx.trigger).toMatchObject({ id: 'trg_ci', name: 'CI failed', count: 1 });
        expect(ctx.event.event).toBe('ci.failed');
    });

    it('records the run against the trigger, with the task id', async () => {
        mgr.onEvent(EVENT);
        await mgr.tick();
        const runs = mgr.triggers[0].runs;
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: 'started', taskId: 'task-1', count: 1, event: 'ci.failed' });
    });

    // Explicit [] means "no MCP tools"; an omitted list would mean "all
    // servers", letting one that connects mid-task leak its tools in.
    it('sends an explicit empty MCP server list when none is chosen', async () => {
        mgr.onEvent(EVENT);
        await mgr.tick();
        expect(calls[0].body.behavior.mcp_servers).toEqual([]);
    });
});

describe('nothing fires that should not', () => {
    it('ignores an event no trigger matches', async () => {
        mgr.onEvent({ source: 'webhook', event: 'ci.passed', payload: {} });
        await mgr.tick();
        expect(client.request).not.toHaveBeenCalled();
    });

    it('ignores an event with no name at all', () => {
        expect(mgr.onEvent({ source: 'webhook', payload: {} })).toEqual([]);
        expect(mgr.onEvent(null)).toEqual([]);
    });

    it('waits out the debounce window before starting anything', async () => {
        mgr.reload();
        mgr.engine.setTriggers([{ ...TRIGGER, debounceMs: 2000 }]);
        mgr.onEvent({ ...EVENT, key: 'a' });
        await mgr.tick();
        expect(client.request).not.toHaveBeenCalled();

        vi.setSystemTime(T0 + 2500);
        await mgr.tick();
        expect(client.request).toHaveBeenCalledTimes(1);
    });
});

describe('a start that fails is recorded as a failure', () => {
    it('keeps the error and frees the trigger to try again', async () => {
        client.request = vi.fn(async () => { throw new Error('server not ready'); });
        mgr.onEvent(EVENT);
        await mgr.tick();

        const run = mgr.triggers[0].runs.at(-1);
        expect(run.status).toBe('failed');
        expect(run.error).toBe('server not ready');

        // Not left holding its own concurrency slot — a trigger that can never
        // run again, with nothing on screen to say so, is the worse failure.
        expect(mgr.engine.state.get('trg_ci').running).toBe(false);
    });
});

describe('the concurrency slot', () => {
    it('is held for the run and given back when the task ends', async () => {
        mgr.onEvent({ ...EVENT, key: 'a' });
        await mgr.tick();
        expect(mgr.engine.state.get('trg_ci').running).toBe(true);

        // A second event while the first run is still going.
        mgr.onEvent({ ...EVENT, key: 'b' });
        await mgr.tick();
        expect(client.request).toHaveBeenCalledTimes(1);

        mgr.onTaskFinished('trg_ci');
        mgr.onEvent({ ...EVENT, key: 'c' });
        await mgr.tick();
        expect(client.request).toHaveBeenCalledTimes(2);
    });
});

describe('editing', () => {
    it('creates new triggers disabled, whatever the caller passed for the rest', () => {
        const t = mgr.upsert({ name: 'new one', prompt: 'x', match: {} });
        expect(t.enabled).toBe(false);
        expect(mgr.triggers.some(x => x.id === t.id)).toBe(true);
    });

    it('re-enabling clears the reason a runaway was stopped for', () => {
        mgr.triggers[0].enabled = false;
        mgr.triggers[0].disabledReason = 'rate';
        mgr.setEnabled('trg_ci', true);
        expect(mgr.triggers[0].enabled).toBe(true);
        expect(mgr.triggers[0].disabledReason).toBeUndefined();
    });

    it('removes', () => {
        mgr.remove('trg_ci');
        expect(mgr.triggers).toHaveLength(0);
        expect(mgr.engine.triggers).toHaveLength(0);
    });
});

describe('nothing runs while the app is idle', () => {
    // A 2 Hz wakeup that exists to notice nothing is how a desktop app ends up
    // in a battery report. The only thing that can make a window close is an
    // event having opened one.
    //
    // Asserted on the manager's OWN handle rather than vi.getTimerCount():
    // fake timers are global, so the count also carries whatever the rest of
    // the suite left behind.
    it('arms no timer until an event arrives, and disarms once it has fired', async () => {
        mgr.init();
        mgr.engine.setTriggers([{ ...TRIGGER, debounceMs: 2000 }]);
        expect(mgr._tickTimer).toBeNull();

        mgr.onEvent(EVENT);
        expect(mgr._tickTimer).not.toBeNull();

        vi.setSystemTime(T0 + 2500);
        await mgr.tick();
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(mgr._tickTimer, 'nothing left pending').toBeNull();
    });

    it('stops its timer on destroy', () => {
        mgr.engine.setTriggers([{ ...TRIGGER, debounceMs: 5000 }]);
        mgr.onEvent(EVENT);
        expect(mgr._tickTimer).not.toBeNull();
        mgr.destroy();
        expect(mgr._tickTimer).toBeNull();
    });
});

describe('a prompt the event could not fill never becomes a task', () => {
    // What actually happened: a trigger prompt asking for
    // `{{payload.previous}} → {{payload.value}}` fired on an event without
    // them. The task ran for 100 seconds and finished by asking the user for
    // the numbers. No model call could have answered it, and the answer was
    // knowable before the call.
    it('records a failed run naming the placeholder, and starts nothing', async () => {
        mgr.engine.setTriggers([{
            ...TRIGGER,
            prompt: 'ダウンロードが {{payload.previous}} → {{payload.value}} に増えました',
        }]);
        mgr.onEvent(EVENT);              // payload: { repo: 'jh-ai-agent' }
        await mgr.tick();

        expect(client.request, 'no task').not.toHaveBeenCalled();
        const run = mgr.triggers[0].runs.at(-1);
        expect(run.status).toBe('failed');
        expect(run.error).toContain('{{payload.previous}}');
        expect(run.error).toContain('{{payload.value}}');
    });

    it('does not leave the trigger holding its concurrency slot', async () => {
        mgr.engine.setTriggers([{ ...TRIGGER, prompt: '{{payload.nope}}' }]);
        mgr.onEvent(EVENT);
        await mgr.tick();
        expect(mgr.engine.state.get('trg_ci').running).toBe(false);
    });

    it('still runs when every placeholder resolves', async () => {
        mgr.engine.setTriggers([{ ...TRIGGER, prompt: '{{payload.repo}} を見て' }]);
        mgr.onEvent(EVENT);
        await mgr.tick();
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(calls[0].body.prompt).toBe('jh-ai-agent を見て');
    });
});
