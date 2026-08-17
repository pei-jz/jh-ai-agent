// configForm — the normalization rules for the General settings form.
//
// These were embedded in `readFormValues()`, a ~90-line function that read every
// field back out of the DOM by id. Each rule below is load-bearing and at least one
// of them was a bug fix that a rewrite could easily undo, so they live here with
// tests rather than inside a form handler.
//
// The form is bound state now: the component reports a PATCH per change and the
// view applies it, so there is nothing to read back.

/**
 * The agent-safety numeric fields.
 *
 * Data-driven because all six behave identically — 0/blank means "disabled /
 * unlimited" — and the form previously repeated the same input markup six times
 * with only the label and the default varying.
 */
export const SAFETY_FIELDS = [
    {
        key: 'max_steps', label: 'Max Agent Steps', fallback: 0, min: 0, max: 10000,
        placeholder: '0 = unlimited',
        hint: 'Hard step ceiling. <strong>Recommended: 0 (unlimited)</strong> — the budgets and loop detectors below are the proper safeguards.',
    },
    {
        key: 'token_budget', label: 'Token Budget (cost cap)', fallback: 0, min: 0, max: 100000000,
        placeholder: '0 = unlimited',
        hint: 'Hard stop when cumulative prompt + completion tokens reach this number. Soft reminder at 80%. Example: <code>1000000</code> (1M tokens).',
        half: true,
    },
    {
        key: 'wall_clock_minutes', label: 'Wall-clock Timeout (minutes)', fallback: 0, min: 0, max: 1440,
        placeholder: '0 = unlimited',
        hint: 'Hard stop after N minutes of runtime. Soft reminder at 80%. Example: <code>30</code>.',
        half: true,
    },
    {
        key: 'no_progress_window', label: 'No-Progress Window (steps)', fallback: 15, min: 0, max: 200,
        placeholder: '15',
        hint: 'If the agent runs this many consecutive steps without modifying any file (only <code>read_file</code> / <code>grep_search</code> / <code>list_files</code>), it gets a one-time reminder to either finish or report blockers. <strong>0 disables this detector.</strong> Recommended: 15.',
    },
    {
        key: 'identical_call_threshold', label: 'Identical Call Threshold', fallback: 5, min: 0, max: 50,
        placeholder: '5',
        hint: 'Soft warning when the same tool+args has been called N times in a row. Hard stop only at 3× this number (warning ignored). <strong>0 disables.</strong> Increase if you keep hitting it on legitimate retries.',
        half: true,
    },
    {
        key: 'escalate_at_step', label: 'Promote to Deep model at step', fallback: 0, min: 0, max: 1000,
        placeholder: '0 = never',
        // Says what the setting does. Repository history belongs in the commit
        // log, not in the help text of a field someone is trying to fill in.
        hint: 'Switch a Fast-tier run to the Deep model once it reaches this step. <strong>0 disables (default).</strong> A mid-run model change <strong>discards the prompt cache for the whole remainder</strong>, so enable it only if cheap-tier runs are visibly stalling.',
        half: true,
    },
    {
        key: 'cycle_detection_min_repeats', label: 'Cycle Detection Min Repeats', fallback: 3, min: 0, max: 20,
        placeholder: '3',
        hint: 'Soft warning when an ABAB or ABCABC oscillation repeats this many times. Higher = more permissive. <strong>0 disables.</strong>',
        half: true,
    },
];

export const OUTPUT_LANGUAGES = [
    ['Japanese', '日本語 (Japanese)'],
    ['English', 'English'],
    ['Korean', '한국어 (Korean)'],
    ['Chinese', '中文 (Chinese)'],
    ['Spanish', 'Español (Spanish)'],
    ['French', 'Français (French)'],
    ['German', 'Deutsch (German)'],
];

/** The masked stand-in the backend returns instead of a stored secret. */
export const MASKED = '********';

/**
 * A safety-limit integer.
 *
 * Blank means 0 (= disabled/unlimited), NOT the field's default: clearing the box
 * has to be a way to turn the limit off. Anything unparseable falls back to the
 * field's default rather than silently becoming 0, which would disable a detector
 * because of a typo.
 */
export function normalizeInt(raw, fallback = 0) {
    const s = String(raw ?? '').trim();
    if (s === '') return 0;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The history compress ratio: a float in (0, 1], or null for "use the default".
 *
 * Integer parsing would destroy this field, which is why it never went through the
 * shared numeric reader.
 */
export function normalizeRatio(raw) {
    const s = String(raw ?? '').trim();
    if (s === '') return null;
    const f = parseFloat(s);
    return (Number.isFinite(f) && f > 0 && f <= 1) ? f : null;
}

/** A text field where empty means "not set". */
export function normalizeText(raw) {
    const s = String(raw ?? '').trim();
    return s === '' ? null : s;
}

/**
 * A secret.
 *
 * The backend hands back a MASKED placeholder rather than the stored value, so
 * saving that placeholder back would overwrite the real key with asterisks.
 * `undefined` means "leave whatever is stored alone".
 */
export function normalizeSecret(raw) {
    const s = String(raw ?? '').trim();
    if (s === MASKED) return undefined;
    return s === '' ? null : s;
}

/**
 * A model-routing selection.
 *
 * An EMPTY STRING, never null. The backend merges a saved config field-wise and
 * reads `null` as "the caller didn't mention this", restoring the previous value —
 * so sending null made "(not set)" impossible to choose. "" is the explicit clear;
 * the backend normalizes it back to null itself.
 */
export function normalizeModelId(raw) {
    return String(raw ?? '');
}

/** One directory per line, blanks dropped. */
export function normalizePathList(raw) {
    return String(raw ?? '')
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

/**
 * Hosts `fetch_url` may reach despite resolving to a private address.
 *
 * This list is a security opt-out, so it takes HOSTNAMES only — anything that
 * looks like a URL is reduced to its host. Pasting `http://localhost:3000/api`
 * and having it silently never match (because the stored string is not a host)
 * is the failure mode where a user believes they granted an exception and did
 * not; better to accept the paste and extract the host.
 *
 * A bare `*` is refused: it would re-open every private address at once, which
 * is the whole thing the guard exists to prevent.
 */
export function normalizeHostList(raw) {
    const out = [];
    for (const line of String(raw ?? '').split('\n')) {
        let s = line.trim().toLowerCase();
        if (!s || s === '*') continue;
        s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // strip scheme
        s = s.split('/')[0];                            // strip path
        s = s.replace(/^\[|\]$/g, '');                  // bare IPv6 literal
        // Strip a :port, but not the colons inside an IPv6 address.
        if (!s.includes(':') || /^[^:]+:\d+$/.test(s)) s = s.split(':')[0];
        s = s.replace(/\.+$/, '');                      // trailing root dot
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * May this command pattern be auto-approved?
 *
 * A HARD SAFETY BOUNDARY, not a convenience check, so it is a pure function with
 * its own tests rather than a few lines inside a click handler:
 *   • a bare `*` would approve every command ever run;
 *   • a dangerous command (delete / format / kill / force-push …) always requires
 *     approval and can never be whitelisted, however the user spells it.
 *
 * @param {string} pattern the pattern as typed; a trailing `*` matches any args
 * @param {(cmd: string) => string} classify commandPolicy.classifyCommand
 * @returns {string|null} the refusal to show, or null when the pattern is allowed
 */
export function approvedPatternRefusal(pattern, classify) {
    const pat = String(pattern || '').trim();
    if (!pat) return 'Enter a command pattern.';
    if (pat === '*' || pat === '* *') {
        return 'A bare "*" would approve every command — not allowed.';
    }
    // Classify the command WITHOUT its wildcard, or the trailing `*` would be read
    // as an argument and could hide the verb being matched.
    const bare = pat.replace(/\s*\*\s*$/, '');
    if (typeof classify === 'function' && classify(bare) === 'dangerous') {
        return 'This pattern matches a DANGEROUS command (delete / format / kill / force-push …). '
            + 'Dangerous commands always require approval and cannot be whitelisted.';
    }
    return null;
}

/** `id:model` — the composite the routing selects speak. */
export function modelChoices(instances) {
    return (Array.isArray(instances) ? instances : []).map(inst => ({
        id: `${inst.id}:${inst.model}`,
        label: `${inst.name} (${inst.model})`,
    }));
}
