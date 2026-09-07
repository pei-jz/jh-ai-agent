// What a recipe may and may not do.
//
// The interesting tests here are the refusals. A recipe is a file that can be
// sent between people and then run unattended on a timer, so the questions that
// matter are "where can a credential end up", "what runs", and "is it still the
// file that was approved" — not whether the happy path substitutes a string.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    normalizeRecipe, validateRecipe, resolveConfig, applySecrets, recipeHosts,
    missingRequired, secretFieldIn, defaultValues,
} from '../recipes/recipeFormat.js';
import {
    scriptRefusal, buildScriptEnv, buildScriptStdin, parseScriptOutput,
    approvalMatches,
} from '../recipes/scriptContract.js';
import { BUILTIN_RECIPES } from '../recipes/builtinRecipes.js';
import { RecipeRegistry } from '../RecipeRegistry.js';
import { WatcherManager } from '../WatcherManager.js';

const T0 = 1_700_000_000_000;

/** A minimal HTTP recipe with one plain field and one secret. */
function httpRecipe(overrides = {}) {
    return normalizeRecipe({
        name: 'CI',
        engine: 'http',
        fields: [
            { key: 'repo', label: 'repo', type: 'text', required: true },
            { key: 'token', label: 'token', type: 'secret' },
        ],
        config: {
            url: 'https://api.example.com/{{repo}}/runs',
            headerName: 'Authorization',
            headerValue: 'Bearer {{token}}',
            watchPath: 'runs.0.conclusion',
        },
        defaults: { eventName: 'ci.failed' },
        ...overrides,
    }, 'ci');
}

describe('a recipe cannot put a credential where it would leave the machine', () => {
    it('refuses a secret referenced from the URL', () => {
        const r = httpRecipe({
            config: { url: 'https://x/?key={{token}}', headerName: '', headerValue: '' },
        });
        expect(validateRecipe(r).join(' ')).toMatch(/url/);
    });

    it('refuses a secret referenced from a command line', () => {
        const r = normalizeRecipe({
            name: 'S', engine: 'command',
            fields: [{ key: 'token', label: 't', type: 'secret' }],
            config: { command: 'curl -H "auth: {{token}}" https://x', cwd: 'C:/w' },
            defaults: { eventName: 'e' },
        }, 's');
        expect(validateRecipe(r).join(' ')).toMatch(/command/);
    });

    it('allows one in a request header, which is the point', () => {
        expect(validateRecipe(httpRecipe())).toEqual([]);
    });

    it('allows one in a script environment variable', () => {
        const r = normalizeRecipe({
            name: 'S', engine: 'script',
            fields: [{ key: 'token', label: 't', type: 'secret' }],
            config: { command: 'python check.py', cwd: 'C:/w', env: { API_TOKEN: '{{token}}' } },
            defaults: { eventName: 'e' },
        }, 's');
        expect(validateRecipe(r)).toEqual([]);
    });

    it('refuses a placeholder that names no field at all', () => {
        const r = httpRecipe({ config: { url: 'https://x/{{nope}}' } });
        expect(validateRecipe(r).join(' ')).toMatch(/nope/);
    });
});

describe('a recipe cannot reach past its own config', () => {
    it('drops keys that are not the engine’s to set', () => {
        const r = normalizeRecipe({
            name: 'X', engine: 'folder',
            config: { path: 'C:/w', baseline: { pretend: 'established' }, enabled: true },
            defaults: { eventName: 'e' },
        }, 'x');
        // `baseline` is what suppresses the first run. A recipe that could set
        // it could make switching a watcher on file one task per existing file.
        expect(r.config.baseline).toBeUndefined();
        expect(r.config.enabled).toBeUndefined();
    });

    it('takes its id from the file, not from the header', () => {
        const r = normalizeRecipe({ id: 'other', name: 'X', engine: 'folder' }, 'mine');
        expect(r.id).toBe('mine');
    });
});

describe('filling a recipe in', () => {
    it('keeps the type when a value is the whole field', () => {
        const r = normalizeRecipe({
            name: 'F', engine: 'folder',
            fields: [{ key: 'dir', type: 'path' }, { key: 'deep', type: 'boolean' }],
            config: { path: '{{dir}}', recursive: '{{deep}}' },
            defaults: { eventName: 'e' },
        }, 'f');
        const cfg = resolveConfig(r, { dir: 'C:/w', deep: false });
        // The string "false" is truthy; a checkbox the user cleared would have
        // gone on scanning subfolders.
        expect(cfg.recursive).toBe(false);
        expect(cfg.path).toBe('C:/w');
    });

    it('leaves an unfilled field visible rather than blanking it', () => {
        const cfg = resolveConfig(httpRecipe(), {});
        expect(cfg.url).toContain('{{repo}}');
    });

    it('never substitutes a secret until the last step', () => {
        const cfg = resolveConfig(httpRecipe(), { repo: 'a/b', token: 'LEAK' });
        expect(JSON.stringify(cfg)).not.toContain('LEAK');
        const withSecret = applySecrets(cfg, httpRecipe(), { token: 'SECRET' });
        expect(withSecret.headerValue).toBe('Bearer SECRET');
    });

    it('will not substitute a secret into a slot it is not allowed in', () => {
        const r = httpRecipe();
        const cfg = { ...resolveConfig(r, { repo: 'a/b' }), url: 'https://x/{{token}}' };
        // The validator already refuses this recipe; this is the second line,
        // for a file swapped after it was read.
        expect(applySecrets(cfg, r, { token: 'SECRET' }).url).toBe('https://x/{{token}}');
    });

    it('reports a stored secret as satisfying a required field', () => {
        const r = httpRecipe({
            fields: [{ key: 'token', label: 't', type: 'secret', required: true }],
            config: { url: 'https://x', headerValue: '{{token}}' },
        });
        expect(missingRequired(r, {}, new Set())).toHaveLength(1);
        expect(missingRequired(r, {}, new Set(['token']))).toHaveLength(0);
    });

    it('names the hosts it will talk to', () => {
        expect(recipeHosts(httpRecipe(), { repo: 'a/b' })).toEqual(['api.example.com']);
    });

    it('finds which field holds the mailbox password', () => {
        const mail = BUILTIN_RECIPES.find(r => r.id === 'mail');
        expect(secretFieldIn(normalizeRecipe(mail, 'mail'), 'password')).toBe('password');
    });
});

describe('every built-in recipe is a valid recipe', () => {
    // The shipped set goes through the same door a user's file does. If the
    // format could not express the four cases the app already had, it could not
    // express anyone else's either.
    it.each(BUILTIN_RECIPES.map(r => [r.id, r]))('%s', (id, raw) => {
        expect(validateRecipe(normalizeRecipe(raw, id))).toEqual([]);
    });

    it('gives every field a starting value', () => {
        for (const raw of BUILTIN_RECIPES) {
            const r = normalizeRecipe(raw, raw.id);
            expect(Object.keys(defaultValues(r)).sort()).toEqual(r.fields.map(f => f.key).sort());
        }
    });
});

describe('a script runs unattended, so it does not get a confirmation dialog', () => {
    it('refuses a destructive command outright', () => {
        expect(scriptRefusal('rm -rf C:/work')).toMatch(/破壊的/);
        expect(scriptRefusal('')).toBeTruthy();
    });

    it('allows an ordinary check', () => {
        expect(scriptRefusal('python check.py')).toBeNull();
    });
});

describe('the script contract', () => {
    const watcher = { id: 'w1', name: 'nightly' };

    it('keeps secrets out of stdin and puts them in the environment', () => {
        const stdin = buildScriptStdin({
            watcher, config: { type: 'script', command: 'x', repo: 'a/b', env: { T: 'SECRET' } },
            state: { seen: 1 }, firstRun: false,
        });
        expect(stdin).not.toContain('SECRET');
        expect(JSON.parse(stdin).config).toEqual({ repo: 'a/b' });
        expect(JSON.parse(stdin).state).toEqual({ seen: 1 });

        const env = buildScriptEnv({ watcher, secrets: { token: 'SECRET' }, firstRun: true });
        expect(env.JH_SECRET_TOKEN).toBe('SECRET');
        expect(env.JH_WATCHER_FIRST_RUN).toBe('1');
    });

    it('will not let a recipe redefine the app’s own variables', () => {
        const env = buildScriptEnv({
            watcher, env: { JH_WATCHER_FIRST_RUN: '0', OK: 'yes' }, firstRun: true,
        });
        // A recipe that could pin FIRST_RUN to 1 would suppress its own events
        // for ever while looking perfectly healthy.
        expect(env.JH_WATCHER_FIRST_RUN).toBe('1');
        expect(env.OK).toBe('yes');
    });

    it('separates the state line from the events', () => {
        const out = [
            '{"state":{"cursor":42}}',
            '{"event":"found","key":"k1","payload":{"n":1}}',
        ].join('\n');
        const r = parseScriptOutput({ id: 'w1', eventName: 'e' }, out, T0);
        expect(r.hasState).toBe(true);
        expect(r.state).toEqual({ cursor: 42 });
        expect(r.events).toHaveLength(1);
        expect(r.events[0].key).toBe('k1');
    });

    it('still reads plain lines, so an old command script keeps working', () => {
        const r = parseScriptOutput({ id: 'w1', eventName: 'line.matched' }, 'a\nb', T0);
        expect(r.events).toHaveLength(2);
        expect(r.hasState).toBe(false);
    });
});

describe('approval covers what the user actually read', () => {
    it('does not match once the recipe changes', () => {
        const approval = { hash: 'aaa', hosts: ['api.example.com'] };
        expect(approvalMatches(approval, { hash: 'aaa', hosts: ['api.example.com'] })).toBe(true);
        expect(approvalMatches(approval, { hash: 'bbb', hosts: ['api.example.com'] })).toBe(false);
    });

    it('does not match once a new host appears', () => {
        const approval = { hash: 'aaa', hosts: ['api.example.com'] };
        expect(approvalMatches(approval, { hash: 'aaa', hosts: ['evil.example.com'] })).toBe(false);
    });

    it('never matches when there is nothing recorded', () => {
        expect(approvalMatches(null, { hash: 'aaa', hosts: [] })).toBe(false);
    });
});

describe('a watcher will not poll a recipe it has not approved', () => {
    let store;
    const storage = {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
    };

    beforeEach(() => { store = {}; });

    /** A registry holding one recipe and nothing on disk. */
    function registryWith(recipe) {
        const reg = new RecipeRegistry({ storage, invoker: async () => [] });
        reg.recipes.set(recipe.id, recipe);
        // No WebCrypto in the test environment, so fingerprint() would be null
        // and every poll would refuse. Stubbed to the thing being tested: does
        // the manager consult the approval at all.
        reg.fingerprint = async () => 'HASH';
        return reg;
    }

    it('refuses, and says so, when nothing was approved', async () => {
        const recipe = httpRecipe();
        const calls = [];
        const w = { id: 'w1', recipeId: 'ci', values: { repo: 'a/b' }, eventName: 'e' };
        const m = new WatcherManager({
            storage, triggers: { onEvent: () => [] }, recipes: registryWith(recipe),
            invoker: async (cmd, args) => { calls.push(cmd); return ''; },
        });
        const events = await m.poll(w, T0);
        expect(events).toEqual([]);
        expect(w.lastOk).toBe(false);
        expect(w.lastError).toMatch(/確認/);
        expect(calls).not.toContain('fetch_url');
    });

    it('polls once the approval matches', async () => {
        const recipe = httpRecipe();
        const reg = registryWith(recipe);
        await reg.approve('w1', recipe, { repo: 'a/b' });
        const calls = [];
        const m = new WatcherManager({
            storage, triggers: { onEvent: () => [] }, recipes: reg,
            invoker: async (cmd, args) => {
                calls.push({ cmd, args });
                if (cmd === 'get_watcher_secret') return 'TOK';
                return JSON.stringify({ status: 200, body: '{"runs":[{"conclusion":"success"}]}' });
            },
        });
        const w = { id: 'w1', recipeId: 'ci', values: { repo: 'a/b' }, eventName: 'e' };
        await m.poll(w, T0);
        expect(w.lastOk).toBe(true);

        const fetched = calls.find(c => c.cmd === 'fetch_url');
        expect(fetched.args.url).toBe('https://api.example.com/a/b/runs');
        // The credential is read per FIELD, and lands only in the header.
        expect(fetched.args.headers).toEqual([['Authorization', 'Bearer TOK']]);
        expect(calls.find(c => c.cmd === 'get_watcher_secret').args.id)
            .toBe('watcher-field:w1:token');
    });
});

describe('a script watcher takes a baseline like every other kind', () => {
    let store;
    const storage = {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
    };

    beforeEach(() => { store = {}; });

    function scriptSetup(stdout) {
        const recipe = normalizeRecipe({
            name: 'S', engine: 'script',
            fields: [],
            config: { command: 'python check.py', cwd: 'C:/work' },
            defaults: { eventName: 'found' },
        }, 's');
        const reg = new RecipeRegistry({ storage, invoker: async () => [] });
        reg.recipes.set('s', recipe);
        reg.fingerprint = async () => 'HASH';
        const calls = [];
        const m = new WatcherManager({
            storage, triggers: { onEvent: () => [] }, recipes: reg,
            invoker: async (cmd, args) => { calls.push({ cmd, args }); return stdout; },
        });
        return { m, reg, recipe, calls };
    }

    it('emits nothing on the first poll, whatever the script says', async () => {
        const out = '{"state":{"cursor":7}}\n{"event":"found","key":"k1","payload":{}}';
        const { m, reg, recipe, calls } = scriptSetup(out);
        await reg.approve('w1', recipe, {});
        const w = { id: 'w1', recipeId: 's', values: {}, eventName: 'found' };

        const first = await m.poll(w, T0);
        // THE rule: a watcher switched on must not file a task per thing that
        // was already there. Enforced here, not trusted to the script.
        expect(first).toEqual([]);
        expect(w.lastNote).toBe('baseline');
        expect(w.baseline.state).toEqual({ cursor: 7 });
        expect(calls[0].cmd).toBe('run_watcher_script');
        expect(calls[0].args.cwd).toBe('C:/work');
        expect(JSON.parse(calls[0].args.stdinData).firstRun).toBe(true);

        const second = await m.poll(w, T0 + 1000);
        expect(second).toHaveLength(1);
        expect(JSON.parse(calls[1].args.stdinData).state).toEqual({ cursor: 7 });
    });

    it('refuses a destructive command before running anything', async () => {
        const recipe = normalizeRecipe({
            name: 'S', engine: 'script',
            config: { command: 'rm -rf C:/work', cwd: 'C:/work' },
            defaults: { eventName: 'e' },
        }, 's');
        const reg = new RecipeRegistry({ storage, invoker: async () => [] });
        reg.recipes.set('s', recipe);
        reg.fingerprint = async () => 'HASH';
        await reg.approve('w1', recipe, {});
        const calls = [];
        const m = new WatcherManager({
            storage, triggers: { onEvent: () => [] }, recipes: reg,
            invoker: async (cmd) => { calls.push(cmd); return ''; },
        });
        const w = { id: 'w1', recipeId: 's', values: {}, eventName: 'e' };
        await m.poll(w, T0);
        expect(calls).toEqual([]);
        expect(w.lastError).toMatch(/破壊的/);
    });
});

describe('the four types that predate recipes are untouched', () => {
    it('polls a plain folder watcher with no recipe involved', async () => {
        const calls = [];
        const m = new WatcherManager({
            storage: { getItem: () => null, setItem: () => {} },
            triggers: { onEvent: () => [] },
            recipes: { get: () => { throw new Error('must not be consulted'); } },
            invoker: async (cmd, args) => { calls.push({ cmd, args }); return { files: [] }; },
        });
        const w = { id: 'w1', type: 'folder', path: 'C:/w', eventName: 'file.changed' };
        await m.poll(w, T0);
        expect(calls[0].cmd).toBe('scan_dir_mtimes');
        expect(calls[0].args.path).toBe('C:/w');
        expect(w.lastOk).toBe(true);
    });
});
