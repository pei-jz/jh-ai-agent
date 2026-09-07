// recipeFormat — a watcher recipe, and the rules it is not allowed to break.
//
// A recipe is a NAMED, SHAREABLE CONFIGURATION of an engine that already
// exists. Not a new kind of watcher, not a plugin runtime: `resolveConfig()`
// returns the same plain object `WatcherManager.poll()` has always consumed,
// so nothing in WatcherEngine changes to add one.
//
// The reason the file exists is that the type list was the wrong axis. "GitHub
// Actions failed", "the RSS feed moved", "Jira has a new unassigned ticket" are
// all `http` plus a path plus a key — so a fifth TYPE was never the answer, and
// a fifth, sixth, seventh preset in code would have gone on for ever.
//
// PURE. Loading, secrets and the clock live elsewhere; everything here is a
// function of its arguments, which is what lets the safety rules below be
// tested without a filesystem or a network.
//
// See docs/design/watcher-recipes.md.

/** Engines a recipe may drive. Each is an EXISTING watcher type. */
export const ENGINES = ['http', 'folder', 'mail', 'command', 'script'];

/**
 * The config keys each engine accepts — an allow-list, not a filter.
 *
 * A recipe's `config` is merged into a watcher, so without this a recipe could
 * set `baseline` (defeating first-run suppression), `enabled`, or `id`. Those
 * are the app's business, never the recipe's.
 */
export const CONFIG_KEYS = {
    http: ['url', 'watchPath', 'equals', 'aggregate', 'filterField', 'filterExclude',
           'watchRegex', 'headerName', 'headerValue'],
    folder: ['path', 'recursive'],
    mail: ['host', 'port', 'user', 'password', 'folder', 'mailFrom', 'mailSubject', 'unseenOnly'],
    command: ['command', 'cwd', 'env'],
    script: ['command', 'cwd', 'env', 'scriptFile'],
};

/**
 * Where a `type: "secret"` field may be referenced. THE rule of this file.
 *
 * A declarative recipe cannot execute anything, so its only possible attack is
 * to put a credential somewhere that leaves the machine — a query string, a
 * command line that lands in a process list. Confining secrets to a request
 * header, an IMAP password (which never even reaches JavaScript) and the
 * environment of a child process closes that, and closes it at load time so a
 * bad recipe is refused rather than run once and regretted.
 */
export const SECRET_SLOTS = {
    http: ['headerValue'],
    mail: ['password'],
    command: ['env'],
    script: ['env'],
    folder: [],
};

/** Field types a recipe form may declare. */
export const FIELD_TYPES = ['text', 'number', 'secret', 'path', 'boolean', 'select'];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Deliberately the same spelling triggers use for payload fields. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every field name referenced by a template string. */
export function templateKeys(str) {
    const out = [];
    if (typeof str !== 'string') return out;
    for (const m of str.matchAll(PLACEHOLDER)) out.push(m[1]);
    return out;
}

/**
 * Substitute placeholders from `values`.
 *
 * A key with no value is left ALONE rather than blanked. A URL that silently
 * loses a path segment is polled successfully against the wrong resource; one
 * that still carries the placeholder fails loudly and says which field is empty.
 */
export function renderTemplate(str, values = {}) {
    if (typeof str !== 'string') return str;
    return str.replace(PLACEHOLDER, (whole, key) => {
        const v = values[key];
        return v === undefined || v === null || v === '' ? whole : String(v);
    });
}

/** A config value that is nothing but one placeholder. */
const SOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Render a config value, keeping the TYPE when the whole value is one field.
 *
 * `"recursive": "{{recursive}}"` has to come out as `true`, not `"true"` — the
 * string "false" is truthy, so a checkbox the user cleared would have gone on
 * scanning subfolders, and `port` would have been a string where the backend
 * wants a number.
 */
function renderOne(str, values) {
    const sole = SOLE_PLACEHOLDER.exec(str);
    if (sole) {
        const v = values[sole[1]];
        return v === undefined || v === null || v === '' ? str : v;
    }
    return renderTemplate(str, values);
}

/**
 * Which secret field a slot refers to, if any.
 *
 * The mailbox password is the case this exists for: its value must never reach
 * JavaScript (the backend reads it from the credential store by id), so the
 * runtime needs the field NAME rather than the substituted value.
 */
export function secretFieldIn(recipe, slot) {
    const secrets = new Set((recipe?.fields || []).filter(f => f.type === 'secret').map(f => f.key));
    const v = recipe?.config?.[slot];
    if (typeof v !== 'string') return null;
    return templateKeys(v).find(k => secrets.has(k)) || null;
}

/** Walk every string in a config, so the checks below cannot miss a nested one. */
function eachTemplate(config, fn, prefix = '') {
    for (const [k, v] of Object.entries(config || {})) {
        const at = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') fn(v, at, k);
        else if (v && typeof v === 'object' && !Array.isArray(v)) eachTemplate(v, fn, at);
    }
}

/**
 * Fill in what a recipe left out, and drop what it is not allowed to set.
 *
 * Never throws — a malformed recipe is reported by `validateRecipe`, so the UI
 * can show every problem at once instead of the first one.
 */
export function normalizeRecipe(raw, name = '') {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const engine = ENGINES.includes(r.engine) ? r.engine : String(r.engine || '');
    const allowed = CONFIG_KEYS[engine] || [];
    const config = {};
    for (const key of allowed) {
        if (r.config && r.config[key] !== undefined) config[key] = r.config[key];
    }
    return {
        // The FILE decides the id. A recipe that could rename itself in its
        // header would shadow another one on the next load, and the watchers
        // pointing at the old id would quietly start polling the new thing.
        id: String(name || r.id || '').trim(),
        name: String(r.name || name || '').trim(),
        description: String(r.description || '').trim(),
        engine,
        builtin: !!r.builtin,
        // True for the four that ARE an engine rather than a use of one.
        // Only affects which group the picker puts it in.
        basic: !!r.basic,
        // A CLOCK-driven recipe. `engine` is empty for these: there is nothing
        // to poll, so none of the watcher machinery (hosts, scripts, approval
        // hashes) applies — which is correct, because a schedule runs no code
        // of its own. It is here rather than in a separate concept because
        // choosing "every morning" and choosing "when mail arrives" are the
        // same decision to the person making it.
        schedule: r.schedule && typeof r.schedule === 'object' ? {
            scheduleType: ['fixed', 'interval', 'monthly', 'once'].includes(r.schedule.scheduleType)
                ? r.schedule.scheduleType : 'fixed',
            time: String(r.schedule.time || '09:00'),
            days: Array.isArray(r.schedule.days) ? r.schedule.days.map(Number).filter(n => n >= 0 && n <= 6) : [1, 2, 3, 4, 5],
            intervalMinutes: Number(r.schedule.intervalMinutes) || 60,
            dayOfMonth: String(r.schedule.dayOfMonth ?? 1),
        } : null,
        // The work this preset is FOR.
        //
        // A watcher alone does nothing: it produces events that no job consumes.
        // Every preset that shipped without this made the person write the
        // other half themselves, in another tab, joined by an event name typed
        // twice — which is the gap the wizard closes.
        job: r.job && typeof r.job === 'object' ? {
            name: String(r.job.name || ''),
            purpose: String(r.job.purpose || ''),
            prompt: String(r.job.prompt || ''),
            maxPerHour: Number(r.job.maxPerHour) || 0,
            cooldownMs: Number(r.job.cooldownMs) || 0,
        } : null,
        fields: (Array.isArray(r.fields) ? r.fields : []).map(f => ({
            key: String(f?.key || ''),
            label: String(f?.label || f?.key || ''),
            type: FIELD_TYPES.includes(f?.type) ? f.type : 'text',
            required: !!f?.required,
            placeholder: f?.placeholder != null ? String(f.placeholder) : '',
            hint: f?.hint != null ? String(f.hint) : '',
            // Does this field need the full width of the form?
            //
            // The form is two columns; a host, a port or a folder name is happy
            // in one of them, and forcing every field to span turned an eight
            // field recipe into eight full-width rows and a screen of scrolling
            // with nothing on the right. A path always spans, because the
            // browse button rides beside it.
            wide: f?.wide !== undefined ? !!f.wide : f?.type === 'path',
            default: f?.default,
            options: Array.isArray(f?.options) ? f.options : undefined,
        })),
        config,
        payload: (Array.isArray(r.payload) ? r.payload : [])
            .filter(p => Array.isArray(p) && p.length)
            .map(([n, d]) => [String(n), String(d ?? '')]),
        defaults: {
            everySeconds: Number(r.defaults?.everySeconds) || 300,
            eventName: String(r.defaults?.eventName || '').trim(),
            promptHint: String(r.defaults?.promptHint || '').trim(),
        },
        // Set by the loader, not by the recipe: where it came from and what it
        // bundles. A recipe claiming its own path could point the runner at a
        // script it does not contain.
        dir: '',
        path: '',
        scriptPath: '',
    };
}

/**
 * Everything wrong with a recipe, in one pass.
 *
 * Returns messages, not a boolean: a recipe with three mistakes should cost one
 * round of editing, not three.
 */
export function validateRecipe(recipe) {
    const problems = [];
    const r = recipe || {};
    if (!NAME_RE.test(r.id || '')) problems.push(`名前 "${r.id}" が使えません（英数字と . _ - のみ）。`);
    if (!r.name) problems.push('name がありません。');
    // A clock-driven recipe has no engine, and must not be asked for one.
    if (r.schedule) {
        if (r.engine) problems.push('schedule と engine は同時に指定できません。');
        if (!r.job?.prompt) problems.push('schedule のレシピには job.prompt が必要です。');
        return problems;
    }
    if (!ENGINES.includes(r.engine)) {
        problems.push(`engine "${r.engine}" は使えません（${ENGINES.join(' / ')}）。`);
        return problems;         // the checks below are all engine-relative
    }

    const keys = new Set();
    for (const f of r.fields || []) {
        if (!/^[A-Za-z0-9_]+$/.test(f.key)) problems.push(`項目名 "${f.key}" が使えません。`);
        if (keys.has(f.key)) problems.push(`項目 "${f.key}" が重複しています。`);
        keys.add(f.key);
    }
    const secrets = new Set((r.fields || []).filter(f => f.type === 'secret').map(f => f.key));
    const slots = SECRET_SLOTS[r.engine] || [];

    eachTemplate(r.config, (str, at, leaf) => {
        for (const key of templateKeys(str)) {
            if (!keys.has(key)) {
                problems.push(`config.${at} が未定義の項目 {{${key}}} を使っています。`);
                continue;
            }
            // The one rule worth refusing a recipe over. See SECRET_SLOTS.
            const inSlot = slots.some(s => at === s || at.startsWith(`${s}.`)) || slots.includes(leaf);
            if (secrets.has(key) && !inSlot) {
                problems.push(
                    `秘密の項目 {{${key}}} は config.${at} には書けません`
                    + `（${r.engine} では ${slots.join(' / ') || 'どこにも'} のみ）。`);
            }
        }
    });

    if (r.engine === 'http' && !r.config.url) problems.push('config.url がありません。');
    if (r.engine === 'folder' && !r.config.path) problems.push('config.path がありません。');
    if (r.engine === 'mail' && !r.config.host) problems.push('config.host がありません。');
    if ((r.engine === 'command' || r.engine === 'script') && !r.config.command) {
        problems.push('config.command がありません。');
    }
    if (!r.defaults?.eventName) problems.push('defaults.eventName がありません。');
    return problems;
}

/** The form's starting values. */
export function defaultValues(recipe) {
    const out = {};
    for (const f of recipe?.fields || []) {
        if (f.default !== undefined) out[f.key] = f.default;
        else if (f.type === 'boolean') out[f.key] = false;
        else out[f.key] = '';
    }
    return out;
}

/**
 * Required fields with nothing in them.
 *
 * A secret is required-satisfied by "one is stored", not by a value in the
 * form — the form never holds it.
 */
export function missingRequired(recipe, values = {}, storedSecrets = new Set()) {
    const out = [];
    for (const f of recipe?.fields || []) {
        if (!f.required) continue;
        if (f.type === 'secret') {
            if (!storedSecrets.has(f.key) && !values[f.key]) out.push(f);
            continue;
        }
        const v = values[f.key];
        if (v === undefined || v === null || v === '' || v === false) out.push(f);
    }
    return out;
}

/**
 * The watcher config, with the NON-SECRET fields filled in.
 *
 * Secrets are deliberately left as placeholders: this result is what the UI
 * shows and what gets handed around, and a credential should not be in it. They
 * are substituted at the last moment by `applySecrets`, into the slots
 * `validateRecipe` has already restricted them to.
 */
export function resolveConfig(recipe, values = {}) {
    const plain = {};
    const secretKeys = new Set((recipe?.fields || []).filter(f => f.type === 'secret').map(f => f.key));
    for (const [k, v] of Object.entries(values || {})) {
        if (!secretKeys.has(k)) plain[k] = v;
    }
    const walk = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (typeof v === 'string') out[k] = renderOne(v, plain);
            else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = walk(v);
            else out[k] = v;
        }
        return out;
    };
    return { type: recipe?.engine, ...walk(recipe?.config) };
}

/**
 * The last step: put the credentials in, and ONLY where they are allowed.
 *
 * Re-checked here rather than trusted from load time, because the recipe file
 * on disk can be swapped after it was validated. Cheap, and it means a
 * substituted secret can only ever appear in a slot this function knows about.
 *
 * @param {object} config    from resolveConfig
 * @param {object} recipe
 * @param {object} secrets   fieldKey -> value, fetched at poll time
 */
export function applySecrets(config, recipe, secrets = {}) {
    const out = { ...config };
    const slots = SECRET_SLOTS[recipe?.engine] || [];
    for (const slot of slots) {
        if (slot === 'env') {
            if (!out.env || typeof out.env !== 'object') continue;
            const env = {};
            for (const [k, v] of Object.entries(out.env)) env[k] = renderTemplate(v, secrets);
            out.env = env;
            continue;
        }
        if (typeof out[slot] === 'string') out[slot] = renderTemplate(out[slot], secrets);
    }
    return out;
}

/**
 * The hosts this recipe will talk to, once filled in.
 *
 * Shown before a watcher is switched on. A recipe is a file someone can send
 * you; "this one sends your token to api.github.com" is the fact that decides
 * whether to enable it, and it is not visible anywhere else.
 */
export function recipeHosts(recipe, values = {}) {
    const hosts = new Set();
    const config = recipe?.engine ? resolveConfig(recipe, values) : {};
    const url = config.url;
    if (typeof url === 'string' && url) {
        try { hosts.add(new URL(url).host); }
        catch (_) { hosts.add(url.replace(/^\w+:\/\//, '').split('/')[0]); }
    }
    if (config.host) hosts.add(String(config.host));
    return [...hosts].filter(Boolean);
}

/** Fields this recipe's events carry, for the payload list in the UI. */
export function payloadFields(recipe) {
    return recipe?.payload?.length ? recipe.payload : [];
}
