// ProjectOverview — the GIST layer: a few hundred tokens saying what this
// project is, kept in the prompt at all times.
//
// The layer this file adds, and why the other two are not enough:
//
//   overview  (here)   coarse, lossy, COMPLETE coverage   — always injected
//   index     (study)  symbol-precise, no coverage gaps   — queried, never injected
//   cards     (memory) verified experience                — recalled on a trigger
//
// A person does not hold 1,333 symbols in their head. They hold "Tauri app,
// dashboard is vanilla JS plus Svelte islands, the agent loop is in
// AgentController, memory lives under modules/ai/memory" — and go looking when
// they need a detail. The vague version is what makes the precise version
// usable: without knowing WHERE the memory layer lives, a symbol query is a
// guess.
//
// The first study pass shipped only the middle row, which is how it produced 716
// rows of `setSel → NewFileModal.js:307` and no sense of the project at all.
//
// ── Why this one uses an LLM when nothing else does ────────────────────────
// Every other memory writer here records only what was observed, because
// inference is where memory goes wrong. But "what is this module FOR" cannot be
// derived from an AST — that is the one thing only a reader can say. So this is
// the deliberate exception, and it is bounded three ways: it summarises the
// STRUCTURE (never raw source), it is small, and it is written to a file the
// user can read and correct.

import { targetPath } from './StudyPass.js';

/** Overview is standing context: it is in every prompt, so it has a hard cap. */
export const OVERVIEW_MAX_CHARS = 1600;
/** Directories described individually before the rest are summarised as "other". */
export const AREA_LIMIT = 14;
/** Exported names quoted per area — enough to recognise it, not to inventory it. */
export const NAMES_PER_AREA = 6;

const rel = (path, root) => {
    const p = String(path || '').replace(/\\/g, '/');
    const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return (r && p.toLowerCase().startsWith(r.toLowerCase() + '/')) ? p.slice(r.length + 1) : p;
};

/**
 * Fold a study pass into the DIGEST the summariser reads.
 *
 * Deliberately not the source: a model asked to describe a project from 400
 * files either reads 400 files (unaffordable) or reads eight and generalises
 * from those (wrong). The structure — which areas exist, how big they are, what
 * each one exports — is small, complete, and is what a human skims first.
 *
 * @param {Array<{q:string, target:string}>} cards study locator cards
 * @param {{root?:string, depth?:number}} opts
 */
export function structureDigest(rows, { root = '', depth = 3 } = {}) {
    const areas = new Map();
    for (const r of (rows || [])) {
        // Accepts either shape: `{path, names[]}` from the study pass, or the
        // `{q, target}` locator shape, so the digest does not care which side of
        // the index the caller happens to be holding.
        const raw = r?.path ?? targetPath(r?.target);
        const path = rel(raw, root);
        if (!path) continue;
        const parts = path.split('/');
        const dir = parts.slice(0, Math.min(depth, Math.max(1, parts.length - 1))).join('/');
        const a = areas.get(dir) || { dir, files: new Set(), names: [] };
        a.files.add(path);
        for (const n of (Array.isArray(r.names) ? r.names : (r.q ? [r.q] : []))) a.names.push(n);
        areas.set(dir, a);
    }

    return [...areas.values()]
        .map(a => ({ dir: a.dir, files: a.files.size, names: a.names }))
        // Biggest first: the areas that dominate a tree are the ones a newcomer
        // needs named, and the tail is noise in a few hundred tokens.
        .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

// ── Naming conventions, COUNTED rather than guessed ───────────────────────
//
// The highest-value thing an orientation note can carry is not what the project
// is — it is what makes a SEARCH land. An agent that knows table access classes
// are all `*Dao.java` greps once; one that does not greps three times and then
// guesses. On a 1,200-table schema that difference is most of the exploration
// cost.
//
// And unlike everything else in this file, conventions do not need a model to
// find. "87 of 100 files under dao/ end in Dao" is arithmetic over paths the
// index already holds. So it is done here, mechanically, and handed to the
// summariser as measurement — which is also why the prompt below tells it NOT to
// hedge these the way it hedges its own inferences.

const SEP = /[_\-.]/;
/** Stems too generic to key a cross-extension pair on. */
const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'init', 'app', 'test', 'types', 'utils', 'const']);

/**
 * Extensions to skip entirely. Icon sets have immaculate naming conventions
 * (`ic_launcher.png`, `AppIcon-60x60.png`) and are worth nothing here: nobody
 * greps for a PNG, and left in they crowd out the rules that do pay. A denylist
 * rather than an allowlist so an unusual SOURCE extension — .cbl, .jsp, .sql,
 * .pro — is mined rather than silently ignored.
 */
const ASSET_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.icns', '.webp', '.bmp',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.zip', '.gz', '.pdf',
    '.mp3', '.mp4', '.wav', '.lock', '.map', '.min.js', '.snap',
]);

const TEST_RE = /(^|[._-])(test|spec)s?[._-]|(^|\/)__tests__\//i;
/** Does this path look like a test? Matched on the full relative path. */
export function isTestPath(path) {
    const p = String(path || '');
    return TEST_RE.test(p) || /Tests?\.(java|cs|kt|rb|py)$/.test(p);
}

/** `AgentController` → ['Agent','Controller']; `M_ZAIKO` → ['M','ZAIKO']. */
export function stemWords(stem) {
    return String(stem || '')
        .split(/[_\-.]+/)
        .flatMap(p => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
        .filter(Boolean);
}

/** The trailing word WITH its separator, so `agent_controller` reads `*_controller`. */
function trailing(stem, word) {
    const i = stem.length - word.length;
    if (i <= 0 || stem.slice(i) !== word) return null;
    return (SEP.test(stem[i - 1]) ? stem[i - 1] : '') + word;
}

function leading(stem, word) {
    if (!stem.startsWith(word) || stem.length === word.length) return null;
    const next = stem[word.length];
    return word + (SEP.test(next) ? next : '');
}

/**
 * The naming CASE of a stem, when it has one. Single-word stems return null
 * unless they are Capitalised — there is no rule in `user.go, order.go` to
 * name, but `Header.tsx, Footer.tsx` really are PascalCase and an agent
 * naming the next file should keep that.
 */
function styleOf(stem) {
    const s = String(stem || '');
    if (s.length < 2) return null;
    if (/^[A-Z][A-Za-z0-9]*$/.test(s)) return 'PascalCase';
    if (/^[a-z][a-zA-Z0-9]*$/.test(s) && /[A-Z]/.test(s)) return 'camelCase';
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)) return 'snake_case';
    if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(s)) return 'SCREAMING_SNAKE';
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(s)) return 'kebab-case';
    return null;
}

/**
 * Directory names that mark GENERATED output, not source. `dist/`, `target/`,
 * `coverage/` are tool output: rules mined from them would describe how a
 * bundler names chunks, and editing them gets overwritten. They are counted
 * apart from source, get a single "do not edit" marker rule, and never count
 * against coverage.
 */
const GENERATED_DIRS = {
    dist: true, build: true, out: true, target: true, 'node_modules': true,
    '.next': true, '.nuxt': true, '.turbo': true, coverage: true, gen: true,
    generated: true,
};

/**
 * Conventional directory roles whose NAME does not say what they hold. `dao/`
 * is self-describing; `api/`, `core/`, `lib/` are not, and knowing that
 * `cli/` holds the command-line entrypoints is a real search short-cut.
 * Deliberately small: a wrong role is worse than none.
 */
const ROLE_BY_DIR = {
    api: 'the API surface (routes/handlers)',
    cli: 'command-line entrypoints',
    core: 'the shared core (logic other areas build on)',
    lib: 'shared libraries',
    pkg: 'shared packages',
    plugins: 'plugin implementations',
    providers: 'provider implementations',
    hooks: 'React hooks',
    constants: 'shared constants',
    migrations: 'database migrations',
    scripts: 'build/automation scripts',
};

/** Winner of a count map, with its share of the total. */
function dominant(counts, total, { minFiles, minShare }) {
    let best = null;
    for (const [key, n] of counts) if (!best || n > best.n) best = { key, n };
    if (!best || best.n < minFiles || best.n / total < minShare) return null;
    return { key: best.key, hits: best.n, total, share: best.n / total };
}

/**
 * Measure the naming rules the tree actually follows.
 *
 * @param {Array} rows  same shapes structureDigest takes: {path} or {target}
 * @returns {Array<{kind:string, rule:string, hits:number, total:number, share:number}>}
 *   sorted by how many files each rule accounts for.
 */
export function detectConventions(rows, {
    root = '', depth = 4, minFiles = 4, minShare = 0.6, limit = 10,
} = {}) {
    const out = detectConventionsFull(rows, { root, depth, minFiles, minShare, limit });
    return out.rules;
}

/**
 * The measured layer (proposal A/B): the same arithmetic as detectConventions,
 * plus the two things that turn it from a display into a usable tool:
 *
 *  - `coverage` — what fraction of the SOURCE files (post asset/test filtering)
 *    the emitted rule set accounts for. This is what lets the agent calibrate
 *    how much to trust the note: 100% says "searches land by these rules", 30%
 *    says "most of the tree is free-form — grep before you trust a rule".
 *  - `recipe` — a search recipe per rule, so a measured rule is not just a
 *    fact to admire but a direct instruction for where to look first.
 *
 * Beyond the original five shapes, the detector generalises to what a tree of
 * ANY stack actually shows:
 *  - word-boundary affixes — camelCase *Dao as well as *_dao, and a prefix
 *    taxonomy of WORDS (User, Admin, Guest …) as well as M_/T_/W_;
 *  - naming CASE (PascalCase / camelCase / snake_case / kebab-case), the rule
 *    an agent needs before naming a new file;
 *  - a shared middle word (CreateUserFoo/UpdateUserBar) when neither end is
 *    regular;
 *  - generated-output dirs (dist/, target/, coverage/) — flagged "do not
 *    edit", excluded from coverage as non-source;
 *  - conventional directory roles (api/, core/, cli/, …) that name what they
 *    hold without saying it in the name.
 *
 * Both are arithmetic, never a model's guess, and both survive the LLM layer
 * (see buildOverviewPrompt / renderOverview): the rules are handed to the
 * summariser as COUNTED facts, and the same JSON is stored next to the note so
 * a later pass can refresh it without paying for a model.
 *
 * @param {Array} rows  same shapes structureDigest takes: {path} or {target}
 * @returns {{rules: Array<{kind,rule,hits,total,share,coverage,recipe}>, coverage: number,
 *            total: number, sourceFiles: number, assetFiles: number, testFiles: number,
 *            generatedFiles: number}}
 */
export function detectConventionsFull(rows, {
    root = '', depth = 4, minFiles = 4, minShare = 0.6, limit = 10,
} = {}) {
    const rules = [];
    const byDir = new Map();
    const byStem = new Map();
    const tests = [];
    const genCount = new Map();
    let sourceFiles = 0, assetFiles = 0, testFiles = 0, generatedFiles = 0;

    for (const r of (rows || [])) {
        const path = rel(r?.path ?? targetPath(r?.target), root);
        if (!path) continue;
        const parts = path.split('/');
        const base = parts[parts.length - 1];
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        if (ASSET_EXTS.has(ext.toLowerCase())) { assetFiles++; continue; }
        // Tests are counted separately, not just reported separately. Left in the
        // per-directory tallies they bury the rule worth having: a views folder
        // that is half `*View.js` and half `*View.test.js` shows neither at 60%,
        // and the answer "these are the views, and their tests sit beside them"
        // is two rules, not one muddled one.
        if (isTestPath(path)) { testFiles++; tests.push({ path, stem, ext }); continue; }
        const dir = parts.slice(0, Math.min(depth, Math.max(1, parts.length - 1))).join('/');
        // Generated output (dist/, target/, coverage/, …) is not source: rules
        // mined from a build dir would describe how a tool names its output,
        // and those files must not dilute source coverage. They get one marker
        // rule instead — "do not edit, regenerate".
        if (GENERATED_DIRS[dir.split('/').pop()]) {
            generatedFiles++;
            genCount.set(dir, (genCount.get(dir) || 0) + 1);
            continue;
        }
        sourceFiles++;
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push({ stem, ext, path });

        if (stem.length >= 4 && !GENERIC_STEMS.has(stem.toLowerCase())) {
            if (!byStem.has(stem)) byStem.set(stem, new Set());
            byStem.get(stem).add(ext);
        }
    }

    const taxonomyOf = (counts, total, { minFiles, minShare }) => {
        // A taxonomy is a small SET of affixes that covers the directory even
        // though no single one dominates — `M_`/`T_`/`W_` at a third each. The
        // residue words under a prefix taxonomy are the ENTITY names, so a
        // suffix taxonomy is suppressed when the prefix side already split the
        // dir: in `M_ZAIKO` the suffix ZAIKO is the table name, not a second
        // classification.
        const tax = [...counts.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6);
        const covered = tax.reduce((s, [, n]) => s + n, 0);
        if (tax.length < 2 || covered / total < minShare) return null;
        return tax;
    };
    const makeTaxonomyRule = (side, dir, total, tax) => {
        const covered = tax.reduce((s, [, n]) => s + n, 0);
        if (side === 'suffix') {
            return {
                kind: 'suffixTaxonomy',
                key: tax.map(([k]) => k),
                rule: `${dir}/ splits by suffix: ${tax.map(([k, n]) => `*${k} (${n})`).join(', ')}`,
                hits: covered, total, share: covered / total,
            };
        }
        return {
            kind: 'taxonomy',
            key: tax.map(([k]) => k),
            rule: `${dir}/ splits by prefix: ${tax.map(([k, n]) => `${k}* (${n})`).join(', ')}`,
            hits: covered, total, share: covered / total,
        };
    };

    for (const [dir, files] of byDir) {
        if (files.length < minFiles) continue;
        const sufC = new Map();
        const preC = new Map();
        const midC = new Map();
        const styleC = new Map();
        const extC = new Map();
        for (const f of files) {
            extC.set(f.ext, (extC.get(f.ext) || 0) + 1);
            const w = stemWords(f.stem);
            // Suffix = last word, prefix = first word. A word that recurs at the
            // SAME middle position in every name is a weaker but real anchor —
            // `CreateUserFoo/UpdateUserBar/…`: no shared first or last word, but
            // every name has `User` right after the verb.
            if (w.length >= 2) {
                const s = trailing(f.stem, w[w.length - 1]);
                if (s) sufC.set(s, (sufC.get(s) || 0) + 1);
                const p = leading(f.stem, w[0]);
                if (p) preC.set(p, (preC.get(p) || 0) + 1);
            }
            for (let i = 1; i < w.length - 1; i++) {
                const key = `${i}:${w[i]}`;
                midC.set(key, (midC.get(key) || 0) + 1);
            }
            const st = styleOf(f.stem);
            if (st) styleC.set(st, (styleC.get(st) || 0) + 1);
        }
        // The extension is part of the rule only when the directory has one.
        // Mixed directories get `.*` rather than a bare stem, so `*.styles`
        // does not read as a filename it is not.
        const domExt = dominant(extC, files.length, { minFiles: 1, minShare: 0.8 });
        const ext = domExt ? domExt.key : '.*';

        const suf = dominant(sufC, files.length, { minFiles, minShare });
        const pre = dominant(preC, files.length, { minFiles, minShare });
        // A prefix that is just the suffix seen from the other end (every file in
        // the directory is one word) would restate the same rule.
        const sameKey = !!suf && !!pre && suf.key === pre.key;
        // Prefix taxonomy decided first: when it fires, the suffix side is the
        // residue of ENTITY names and is not a second classification.
        const preTax = !pre ? taxonomyOf(preC, files.length, { minFiles, minShare }) : null;

        if (suf) {
            rules.push({ kind: 'suffix', rule: `${dir}/*${suf.key}${ext}`, ...suf });
        } else if (!pre && !preTax) {
            // No single ending wins — but a small SET of endings might cover
            // everything (`*Create/*Update/*Delete` at a third each).
            const tax = taxonomyOf(sufC, files.length, { minFiles, minShare });
            if (tax) rules.push(makeTaxonomyRule('suffix', dir, files.length, tax));
        }
        if (pre && !sameKey) {
            rules.push({ kind: 'prefix', rule: `${dir}/${pre.key}*${ext}`, ...pre });
        } else if (!pre && preTax) {
            // No single prefix dominates — but a TAXONOMY might. `M_` master,
            // `T_` transaction, `W_` work is three prefixes at a third each, so
            // "the most common one" sees 33% and reports nothing, while the set
            // covers the directory completely. On a 1,200-table schema this is
            // the single most useful line in the note: it lets the agent discard
            // two thirds of the search space before it searches.
            rules.push(makeTaxonomyRule('prefix', dir, files.length, preTax));
        }
        if (!suf && !pre) {
            const mid = dominant(midC, files.length, { minFiles, minShare });
            if (mid) {
                const word = mid.key.split(':')[1];
                rules.push({
                    kind: 'containsWord', key: mid.key,
                    rule: `${dir}/ names all contain ${word} (same position in every name)`,
                    hits: mid.hits, total: files.length, share: mid.share,
                });
            }
        }
        // Naming CASE is a rule too: "files here are PascalCase" is exactly what
        // an agent needs before naming a new file, and it is often the only
        // signal a directory of unrelated single-word files (user.go, order.go)
        // gives off.
        const style = dominant(styleC, files.length, { minFiles, minShare });
        if (style) {
            rules.push({
                kind: 'caseStyle', key: style.key,
                rule: ext === '.*'
                    ? `${dir}/* are ${style.key}`
                    : `${dir}/*${ext} are ${style.key}`,
                hits: style.hits, total: files.length, share: style.share,
            });
        }
        // The directory's own name can BE the contract: components/ holds
        // components. Not counted toward coverage — it says what the dir is
        // for, not which names to expect.
        const role = ROLE_BY_DIR[dir.split('/').pop()];
        if (role) {
            rules.push({
                kind: 'role',
                rule: `${dir}/ holds ${role}`,
                hits: files.length, total: files.length, share: 1,
            });
        }
    }

    // Generated output gets its own marker: the one thing an agent must know
    // about dist/ is not to edit it — a wrong edit there is silently
    // overwritten on the next build. Worth a line even when the dir is small.
    for (const [dir, n] of genCount) {
        rules.push({
            kind: 'generated',
            rule: `${dir}/ is generated output — do not edit, regenerate instead`,
            hits: n, total: n, share: 1,
        });
    }

    // Same name, two extensions — the MyBatis/JSP shape, where finding one half
    // tells you exactly where the other half is.
    const pairC = new Map();
    let paired = 0;
    for (const exts of byStem.values()) {
        if (exts.size < 2) continue;
        paired++;
        const combo = [...exts].sort().join(' + ');
        pairC.set(combo, (pairC.get(combo) || 0) + 1);
    }
    for (const [combo, n] of pairC) {
        // Out of names that span extensions AT ALL — not out of every name in
        // the project, which would report a real 1:1 pairing as a 20% tendency.
        if (n >= minFiles) rules.push({ kind: 'pair', rule: `same name in ${combo}`, hits: n, total: paired, share: n / paired });
    }

    // Tests, asked as their own question: not "what share of this folder is
    // tests" but "given a test, what is it called and where does it live". Both
    // halves matter — knowing the suffix without the placement still leaves the
    // agent searching the wrong directory.
    if (tests.length >= minFiles) {
        const nameC = new Map();
        let inDedicatedDir = 0;
        for (const t of tests) {
            if (/(^|\/)(__tests__|tests?|spec)\//i.test(t.path)) inDedicatedDir++;
            const w = stemWords(t.stem);
            const s = w.length >= 2 ? trailing(t.stem, w[w.length - 1]) : null;
            if (s) nameC.set(s + t.ext, (nameC.get(s + t.ext) || 0) + 1);
        }
        const name = dominant(nameC, tests.length, { minFiles, minShare });
        if (name) rules.push({ kind: 'tests', rule: `tests are named *${name.key}`, hits: name.hits, total: tests.length, share: name.share });
        if (inDedicatedDir / tests.length >= minShare) {
            rules.push({ kind: 'tests', rule: 'tests live in their own directory beside the code they cover', hits: inDedicatedDir, total: tests.length, share: inDedicatedDir / tests.length });
        } else if (inDedicatedDir / tests.length <= 1 - minShare) {
            rules.push({ kind: 'tests', rule: 'tests sit in the same directory as the code they cover', hits: tests.length - inDedicatedDir, total: tests.length, share: (tests.length - inDedicatedDir) / tests.length });
        }
    }

    // Coverage: which source files the emitted rule set accounts for. A file is
    // covered if any rule that names its directory matches it — the suffix rule
    // `src/dao/*Dao.java` covers every file in that directory whose stem ends in
    // Dao, the taxonomy rule covers every file whose leading prefix is one of the
    // listed ones. Tests are excluded from the denominator just as they are from
    // the rules: they answer a different question.
    //
    // Computed on the rules BEFORE `key` is stripped: the coverage matcher needs
    // the exact suffix/prefix it counted with, which the public rule object does
    // not carry.
    const coveredFiles = new Set();
    for (const r of rules) {
        const dir = ruleDirOf(r);
        const files = byDir.get(dir) || [];
        for (const f of files) {
            const w = stemWords(f.stem);
            if (r.kind === 'suffix') {
                const s = w.length >= 2 ? trailing(f.stem, w[w.length - 1]) : null;
                if (s === r.key) coveredFiles.add(f.path);
            } else if (r.kind === 'prefix') {
                const p = w.length >= 2 ? leading(f.stem, w[0]) : null;
                if (p === r.key) coveredFiles.add(f.path);
            } else if (r.kind === 'suffixTaxonomy') {
                const s = w.length >= 2 ? trailing(f.stem, w[w.length - 1]) : null;
                if (s && r.key.includes(s)) coveredFiles.add(f.path);
            } else if (r.kind === 'taxonomy') {
                const prefix = r.rule.match(/(\w+\*)/g) || [];
                for (const pf of prefix) {
                    const k = pf.slice(0, -1);
                    if (leading(f.stem, w[0]) === k) coveredFiles.add(f.path);
                }
            } else if (r.kind === 'containsWord') {
                const [i, word] = String(r.key).split(':');
                if (w[Number(i)] === word) coveredFiles.add(f.path);
            } else if (r.kind === 'caseStyle') {
                if (styleOf(f.stem) === r.key) coveredFiles.add(f.path);
            }
        }
    }
    const coverage = sourceFiles > 0 ? coveredFiles.size / sourceFiles : 0;

    // The public rule object: counts and a search recipe, no internal key.
    // Ranked by SEARCH VALUE first — a suffix that lands a grep outranks a case
    // style that only guides naming, even when the case rule counts more files.
    // Within a tier, more files wins.
    const SEARCH_VALUE = {
        suffix: 5, prefix: 4, taxonomy: 4, suffixTaxonomy: 4,
        pair: 3, containsWord: 3, tests: 3,
        caseStyle: 2, role: 1, generated: 1,
    };
    const ordered = rules
        .map(({ key, ...r }) => ({ ...r, recipe: recipeOf(r) }))
        .sort((a, b) => (SEARCH_VALUE[b.kind] || 0) - (SEARCH_VALUE[a.kind] || 0) || b.hits - a.hits)
        .slice(0, limit);

    return {
        rules: ordered,
        coverage,
        sourceFiles,
        assetFiles,
        testFiles,
        generatedFiles,
    };
}

// ── recipe: what a rule means for a search ────────────────────────────────
/**
 * The directory a rule lives in, read back out of the rule string.
 *
 * Suffix/prefix rules embed the dir before the glob-bearing segment
 * (`src/dao/*Dao.java` → `src/dao`); taxonomy rules carry it before the
 * " splits by prefix:" marker (`db/schema/ splits by prefix: …` → `db/schema`).
 */
function ruleDirOf(r) {
    if (r.kind === 'taxonomy') return r.rule.split(' splits by prefix:')[0].replace(/\/$/, '');
    if (r.kind === 'suffixTaxonomy') return r.rule.split(' splits by suffix:')[0].replace(/\/$/, '');
    if (r.kind === 'containsWord') return r.rule.split(' names all contain')[0].replace(/\/$/, '');
    if (r.kind === 'caseStyle') return r.rule.split('/*')[0];
    if (r.kind === 'role') return r.rule.split('/ holds')[0];
    if (r.kind === 'generated') return r.rule.split(' is generated')[0];
    const segs = r.rule.split('/');
    const star = segs.findIndex(s => s.includes('*'));
    return star > 0 ? segs.slice(0, star).join('/') : '';
}

function recipeOf(r) {
    switch (r.kind) {
        case 'suffix': {
            const m = r.rule.match(/\*([^/.*]+)\.([a-z0-9.]+)$/i);
            return m ? `files ending in ${m[1]} under ${r.rule.split('/*')[0]}/` : '';
        }
        case 'prefix': {
            const m = r.rule.match(/([A-Za-z0-9_\-.]+)\*[^/]*$/);
            return m ? `files starting with ${m[1]} under ${r.rule.split('/').slice(0, -1).join('/')}/` : '';
        }
        case 'taxonomy': {
            const m = r.rule.match(/(\w+\*)/g);
            return m ? `files split by first prefix: ${m.slice(0, 3).join(', ')} — grep the right bucket before searching the whole schema` : '';
        }
        case 'pair': {
            const exts = r.rule.slice('same name in '.length).split(' + ');
            return exts.length >= 2 ? `a ${exts[0]} file usually has a sibling ${exts[1]} file with the same name — find one, and you know where the other is` : '';
        }
        case 'tests':
            return r.rule.startsWith('tests are named')
                ? `tests are ${r.rule.slice('tests are named *'.length - 1)} — search the tests directory, not the source`
                : r.rule;
        case 'suffixTaxonomy': {
            const m = r.rule.match(/\*([A-Za-z0-9_\-.]+)/g) || [];
            return m.length
                ? `files ending in ${m.map(s => s.slice(1).replace(/^[_\-.]/, '')).join(' or ')} under ${ruleDirOf(r)}/ — grep one bucket before the whole dir`
                : '';
        }
        case 'containsWord': {
            const m = r.rule.match(/contain (\w+)/);
            return m ? `every name carries ${m[1]} at the same position — grep that word to find the family` : '';
        }
        case 'caseStyle': {
            const m = r.rule.match(/are ([A-Za-z_]+)$/);
            return m ? `name new files here in ${m[1]}` : '';
        }
        case 'role':
        case 'generated':
            return r.rule;
        default:
            return '';
    }
}

/** The measured rules, as the lines the summariser is shown. */
export function renderConventions(list) {
    return (list || [])
        .map(c => `- ${c.rule}  (${c.hits}/${c.total} files, ${Math.round(c.share * 100)}%)${c.recipe ? `  — ${c.recipe}` : ''}`)
        .join('\n');
}

/** Render the digest as the prompt the summariser is given. */
export function buildOverviewPrompt(areas, { projectName = '', extra = '', conventions = [] } = {}) {
    const shown = areas.slice(0, AREA_LIMIT);
    const rest = areas.slice(AREA_LIMIT);
    const lines = shown.map(a =>
        `- ${a.dir}/  (${a.files} files)  exports: ${a.names.slice(0, NAMES_PER_AREA).join(', ') || '—'}`);
    if (rest.length) {
        lines.push(`- …and ${rest.length} smaller areas (${rest.reduce((s, a) => s + a.files, 0)} files)`);
    }

    const conv = renderConventions(conventions);

    return `You are writing the orientation note an agent reads before searching this codebase.

This note is injected into EVERY step of EVERY run, so each line is paid for
hundreds of times. The test for a line is not "is it true and interesting" but
"would not knowing it make the agent guess WRONG and pay for it". A line that
merely describes the tree fails that test — the agent can query the tree.

Project: ${projectName || '(unnamed)'}
${extra ? `\nExtra context supplied by the user:\n${extra}\n` : ''}${conv ? `
Naming rules MEASURED from the file listing (counts are exact):
${conv}
` : ''}
Structure (directories by size, with the names they export):
${lines.join('\n')}

Write UNDER 900 characters, as plain markdown bullets, in this order of priority:
1. The naming rules above, restated so they are usable when searching
   (e.g. "table access is *Dao.java, one class per table"). These are the most
   valuable lines in the note: they are what turns a blind grep into a direct hit.
2. What this project appears to BE — but only the part that CONSTRAINS how it is
   changed (e.g. "Tauri app: the frontend cannot touch the filesystem, all IO
   goes through Rust commands"). Its business purpose alone changes nothing and
   is not worth a line.
3. The 3-6 areas that matter, one line each — only where the directory name does
   not already say it.

Rules:
- The measured naming rules are COUNTED, not inferred. State them as fact, and do
  not weaken them with "appears to". Drop any whose count is too low to trust.
- Everything else: describe only what the structure supports, and where it is
  ambiguous say "appears to".
- Do NOT reproduce the directory listing, and do NOT inventory files or exports.
  That is what the agent's index is for, and it answers more precisely than you can.
- Do NOT invent features, business purpose, or history you cannot see here.
- No preamble, no closing summary, no headings — bullets only.`;
}

/**
 * Clean the model's answer into something safe to put in every prompt.
 * Strips markdown fences and any preamble line, and enforces the cap.
 */
export function normalizeOverview(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
    // Models like to open with "Here is the orientation note:" — drop a lead-in
    // line that is not itself a bullet.
    const lines = s.split('\n');
    while (lines.length && !/^\s*[-*\d]/.test(lines[0]) && lines[0].trim().endsWith(':')) lines.shift();
    s = lines.join('\n').trim();
    return s.length > OVERVIEW_MAX_CHARS ? s.slice(0, OVERVIEW_MAX_CHARS - 1) + '…' : s;
}

/**
 * The standing block for the system prompt.
 *
 * Labelled as generated and fallible on purpose. It sits near the user's own
 * `.agent/instructions.md`, which is NORMATIVE; conflating the two would give a
 * machine's guess the same standing as the user's rules.
 *
 * When the stored measured layer (detectConventionsFull's return, kept in the
 * note's front matter) is present, it is rendered VERBATIM here — the rules and
 * their counts are arithmetic over paths the index already holds, and nothing a
 * model rephrases can make that more true. The prose is the model's part; the
 * measurements are not re-expressed, they are copied (proposal A).
 */
export function renderOverview(text, { generatedAt = '', conventions = null } = {}) {
    const body = String(text || '').trim();
    if (!body) return '';
    const conv = renderConventions(conventions?.rules || []);
    const measured = conv ? `
<!-- Measured naming rules (counted from the file listing — exact, refreshed on study) -->
${conv}
` : '';
    return `<project_overview generated="${generatedAt}">
<!-- Auto-generated orientation from the project's structure. Broad but shallow,
     and possibly out of date: prefer what you read in the files over this. -->
${body}${measured}
</project_overview>`;
}

/**
 * Is the stored overview old enough to be worth regenerating?
 *
 * Two clocks, because the two halves of the note age differently (proposal C):
 *  - the MEASURED half (naming rules) is refreshed by every study pass — pure
 *    arithmetic, no model — so it is stale only by age, and never by commit.
 *  - the INTERPRETED half (prose) is written by a model, so its staleness is
 *    judged against the workspace's HEAD: a changed commit means the tree the
 *    prose described is no longer the tree being read, even if the calendar
 *    says the note is young.
 *
 * @param {object|null} meta  {generatedAt, head?} from readOverview.
 * @param {{now?:number, maxAgeDays?:number, head?:string}} opts
 */
export function isOverviewStale(meta, { now = Date.now(), maxAgeDays = 30, head = '' } = {}) {
    const at = Date.parse(meta?.generatedAt || '') || 0;
    if (!at) return true;
    // HEAD changed since the prose was written ⇒ the reading is older than the
    // tree, regardless of the calendar.
    if (head && meta?.head && head !== meta.head) return true;
    return (now - at) / 86_400_000 > maxAgeDays;
}
