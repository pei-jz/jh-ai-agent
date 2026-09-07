// scriptContract — what a watcher script is given, and what it may say back.
//
// The `command` watcher was already the escape hatch, and it was already the
// right idea: a cheap check runs in a script, and only the expensive judgement
// goes to the agent. But it had two holes that made anything real impossible:
//
//   • no way to receive a credential — so a token had to be typed into the
//     command line, which lands in `jh_watchers`, which is localStorage: synced,
//     backed up, screen-shared. Exactly what docs/design/secrets.md exists to
//     stop.
//   • no way to keep state — so every script grew its own temp file, and with
//     it its own re-implementation of "do not fire on the first run", which is
//     the rule that decides whether switching a watcher on files one task or
//     five hundred.
//
// Both are closed here, and closed in the direction that keeps the dangerous
// half in the app: the script REPORTS state, the app DECIDES what to do with it.
// A script that ignores the first-run flag still cannot fire on its first poll.
//
// PURE. See docs/design/watcher-recipes.md.

import { classifyCommand } from '../../tools/commandPolicy.js';
import { eventsFromOutput } from '../WatcherEngine.js';

/** Prefix for the environment variables carrying a recipe's secret fields. */
export const SECRET_ENV_PREFIX = 'JH_SECRET_';

/** A script's own ceiling. A poll that outlives its interval is stuck. */
export const SCRIPT_TIMEOUT_SECS = 60;

/**
 * Refuse a script the app must not run unattended.
 *
 * `run_command` from the agent has a third option — ask the user — because
 * somebody is watching. A watcher fires at 03:00 on a timer, so the choice is
 * binary: run it, or refuse and say why. Anything `commandPolicy` calls
 * dangerous is refused, and (unlike the agent's path) that cannot be waived by
 * a saved approval pattern, because the approval was given for a session with a
 * person in it.
 *
 * @returns {string|null} the reason to refuse, or null when it may run
 */
export function scriptRefusal(command) {
    const cmd = String(command || '').trim();
    if (!cmd) return 'コマンドが空です。';
    if (classifyCommand(cmd) === 'dangerous') {
        return '破壊的と判定されるコマンドは、無人で動く監視では実行できません。'
            + '（監視は誰も見ていない時刻に走るので、確認ダイアログという逃げ道がありません）';
    }
    return null;
}

/**
 * The JSON a script reads on stdin.
 *
 * Secrets are NOT in it. They go through the environment, so that a script that
 * dumps its input while being debugged — the most ordinary thing in the world —
 * does not put a token in a log file.
 */
export function buildScriptStdin({ watcher, config, state, firstRun }) {
    const { env: _env, command: _cmd, cwd: _cwd, type: _t, scriptFile: _sf, ...rest } = config || {};
    return JSON.stringify({
        watcher: { id: watcher?.id || '', name: watcher?.name || '' },
        config: rest,
        state: state ?? null,
        firstRun: !!firstRun,
    });
}

/**
 * The environment a script is given.
 *
 * `env` from the recipe is merged in AFTER the app's own variables, but the
 * app's names are reserved: a recipe cannot redefine `JH_WATCHER_FIRST_RUN` to
 * make every poll look like the first one, which would suppress its own events
 * for ever and look like a quiet watcher.
 */
export function buildScriptEnv({ watcher, secrets = {}, env = {}, firstRun = false }) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (k.startsWith('JH_WATCHER')) continue;      // reserved, see above
        out[k] = String(v ?? '');
    }
    for (const [k, v] of Object.entries(secrets || {})) {
        if (!/^[A-Za-z0-9_]+$/.test(k)) continue;
        out[`${SECRET_ENV_PREFIX}${k.toUpperCase()}`] = String(v ?? '');
    }
    out.JH_WATCHER_ID = String(watcher?.id || '');
    out.JH_WATCHER_NAME = String(watcher?.name || '');
    out.JH_WATCHER_FIRST_RUN = firstRun ? '1' : '0';
    return out;
}

/**
 * Split a script's stdout into events and the state it wants kept.
 *
 * A line that is a JSON object carrying `state` is the state and nothing else;
 * everything else goes through the existing output reader, so a script written
 * for the plain `command` watcher keeps working unchanged.
 *
 * @returns {{events: object[], state: any, hasState: boolean}}
 */
export function parseScriptOutput(watcher, stdout, now = Date.now()) {
    const kept = [];
    let state = null;
    let hasState = false;
    for (const raw of String(stdout || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('{')) {
            let parsed = null;
            try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
            // `state` AND no `event`: a line that carries both is an event that
            // happens to have a state field, and taking it as state would drop
            // the event.
            if (parsed && typeof parsed === 'object' && 'state' in parsed && !parsed.event) {
                state = parsed.state;
                hasState = true;
                continue;
            }
        }
        kept.push(line);
    }
    return { events: eventsFromOutput(watcher, kept.join('\n'), now), state, hasState };
}

/**
 * SHA-256 of a string, hex.
 *
 * Used for "is this still the code the user read before enabling it". Falls
 * back to null where WebCrypto is missing (a bare test runner) — the caller
 * treats a missing hash as "cannot verify", which disables rather than trusts.
 */
export async function sha256(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const bytes = new TextEncoder().encode(String(text ?? ''));
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What a watcher's approval covers.
 *
 * The hash of the recipe (and of its script, when it bundles one) plus the
 * hosts it will talk to. Both are shown before the watcher is switched on, and
 * both are re-checked before every poll: "the code the user read" and "the code
 * that runs" have to be the same file, and a recipe on disk can be swapped
 * after it was read.
 */
export function approvalMatches(approval, { hash, hosts }) {
    if (!approval || !approval.hash) return false;
    if (approval.hash !== hash) return false;
    const before = new Set(approval.hosts || []);
    return (hosts || []).every(h => before.has(h));
}
