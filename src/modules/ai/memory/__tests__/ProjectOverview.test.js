// ProjectOverview — the gist layer.
//
// This is the only memory writer that uses a model, so the tests are mostly
// about keeping it honest: it summarises STRUCTURE (never source), it is capped
// because it rides in every prompt, and it is labelled as generated so it cannot
// be mistaken for the user's own rules.

import { describe, it, expect } from 'vitest';
import {
    structureDigest, buildOverviewPrompt, normalizeOverview, renderOverview,
    isOverviewStale, OVERVIEW_MAX_CHARS, AREA_LIMIT,
    detectConventions, detectConventionsFull, renderConventions, stemWords, isTestPath,
} from '../ProjectOverview.js';

const card = (q, target) => ({ q, target });
const at = (...paths) => paths.map(path => ({ path }));
/** The rules detected, as plain strings, for assertions that read as English. */
const rulesOf = (paths, opts) => detectConventions(at(...paths), { depth: 4, ...opts }).map(c => c.rule);

describe('structureDigest', () => {
    it('groups symbols into the areas they live in, biggest first', () => {
        const areas = structureDigest([
            card('a', 'src/modules/ai/x.js:1'),
            card('b', 'src/modules/ai/y.js:1'),
            card('c', 'src/dashboard/z.js:1'),
        ]);
        expect(areas[0]).toMatchObject({ dir: 'src/modules/ai', files: 2 });
        expect(areas[1]).toMatchObject({ dir: 'src/dashboard', files: 1 });
    });

    it('counts FILES, not symbols — ten exports from one file is one file', () => {
        const areas = structureDigest(
            Array.from({ length: 10 }, (_, i) => card(`n${i}`, 'src/a/one.js:1')));
        expect(areas[0].files).toBe(1);
        expect(areas[0].names).toHaveLength(10);
    });

    it('makes paths relative to the workspace', () => {
        const areas = structureDigest([card('a', 'C:/ws/src/core/x.js:1')], { root: 'C:/ws' });
        expect(areas[0].dir).toBe('src/core');
    });

    it('normalises Windows separators', () => {
        expect(structureDigest([card('a', 'src\\core\\x.js:1')])[0].dir).toBe('src/core');
    });

    it('survives junk', () => {
        expect(structureDigest(null)).toEqual([]);
        expect(structureDigest([{}])).toEqual([]);
    });
});

// Naming rules are the highest-value thing the note can carry, because they are
// what makes a SEARCH land: an agent that knows table access is `*Dao.java`
// greps once. And unlike the rest of this module they need no model — they are
// arithmetic over paths the index already holds.
describe('detectConventions', () => {
    /** A Java/MyBatis shape: the case the whole detector exists for. */
    const enterprise = () => {
        const names = ['Zaiko', 'Chumon', 'Shohin', 'Kokyaku', 'Nyuka', 'Shukka'];
        const out = [];
        for (const n of names) {
            out.push(`src/main/java/dao/${n}Dao.java`);
            out.push(`src/main/resources/mapper/${n}Dao.xml`);
            out.push(`src/main/java/service/${n}Service.java`);
            out.push(`src/test/java/dao/${n}DaoTest.java`);
        }
        return out;
    };

    it('names the suffix rule that makes a search land', () => {
        expect(rulesOf(...[enterprise()])).toContain('src/main/java/dao/*Dao.java');
        expect(rulesOf(...[enterprise()])).toContain('src/main/java/service/*Service.java');
    });

    it('finds the pairing that says where the other half lives', () => {
        // Knowing FooDao.java implies FooDao.xml is worth a line; without it the
        // agent finds the interface and then hunts for the SQL.
        expect(rulesOf(...[enterprise()])).toContain('same name in .java + .xml');
    });

    // The 1,200-table case. Three prefixes at a third each mean "the most common
    // prefix" sees 33% and reports nothing, while the SET covers the directory
    // completely — and it is the set that lets the agent discard two thirds of
    // the search space before it searches.
    it('detects a prefix taxonomy no single prefix would dominate', () => {
        const paths = [];
        for (const p of ['M_', 'T_', 'W_']) {
            for (const n of ['ZAIKO', 'CHUMON', 'SHOHIN', 'KOKYAKU']) paths.push(`db/schema/${p}${n}.sql`);
        }
        const tax = rulesOf(paths).find(r => r.includes('splits by prefix'));
        expect(tax).toBeTruthy();
        expect(tax).toContain('M_*');
        expect(tax).toContain('T_*');
        expect(tax).toContain('W_*');
    });

    it('does not report a taxonomy when one prefix already dominates', () => {
        const paths = Array.from({ length: 9 }, (_, i) => `db/schema/M_T${i}.sql`).concat(['db/schema/T_X.sql']);
        const rules = rulesOf(paths);
        expect(rules).toContain('db/schema/M_*.sql');
        expect(rules.some(r => r.includes('splits by prefix'))).toBe(false);
    });

    // Icon sets have immaculate naming and are worth nothing: nobody greps for a
    // PNG. Left in, they outscore the rules that pay — the first run of this
    // detector on the real repo returned `icons/ios/App*.png` and little else.
    it('ignores asset directories however tidily named', () => {
        const paths = Array.from({ length: 30 }, (_, i) => `res/icons/ic_thing${i}.png`)
            .concat(Array.from({ length: 6 }, (_, i) => `src/dao/Thing${i}Dao.java`));
        const rules = rulesOf(paths);
        expect(rules).toContain('src/dao/*Dao.java');
        expect(rules.every(r => !r.includes('.png'))).toBe(true);
    });

    // Tests answer a different question — not "what share of this folder is
    // tests" but "given a test, what is it called and where does it live".
    // Counted with the source they bury the rule worth having: a views folder
    // half `*View.js` and half `*View.test.js` shows neither at 60%.
    it('asks about tests separately so they do not mask the source rule', () => {
        const paths = [];
        for (const n of ['Config', 'Monitor', 'Overview', 'Chat', 'Task', 'Logs']) {
            paths.push(`src/views/${n}View.js`);
            paths.push(`src/views/__tests__/${n}View.test.js`);
        }
        const rules = rulesOf(paths);
        expect(rules).toContain('src/views/*View.js');
        expect(rules).toContain('tests are named *.test.js');
        expect(rules).toContain('tests live in their own directory beside the code they cover');
    });

    it('reports co-located tests as co-located', () => {
        const paths = [];
        for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
            paths.push(`pkg/${n}.go`);
            paths.push(`pkg/${n}_test.go`);
        }
        expect(rulesOf(paths)).toContain('tests sit in the same directory as the code they cover');
    });

    it('says nothing about a tree with no convention to find', () => {
        // Silence is the correct output here. A rule invented from four unrelated
        // filenames would ride in every prompt and send searches the wrong way.
        expect(rulesOf(['a/one.js', 'a/two.js', 'a/three.js', 'a/four.js', 'a/five.js'])).toEqual([]);
    });

    it('marks a mixed-extension directory rather than implying one', () => {
        const paths = ['ui/AView.js', 'ui/BView.svelte', 'ui/CView.js', 'ui/DView.svelte', 'ui/EView.ts'];
        expect(rulesOf(paths)).toContain('ui/*View.*');
    });

    it('ranks rules by how many files they account for', () => {
        const many = Array.from({ length: 20 }, (_, i) => `src/dao/T${i}Dao.java`);
        const few = Array.from({ length: 5 }, (_, i) => `src/web/T${i}Controller.java`);
        expect(rulesOf([...few, ...many])[0]).toBe('src/dao/*Dao.java');
    });

    it('reads the study-pass locator shape too', () => {
        const rows = Array.from({ length: 6 }, (_, i) => ({ q: 'x', target: `C:/ws/src/dao/T${i}Dao.java:12` }));
        expect(detectConventions(rows, { root: 'C:/ws' }).map(c => c.rule)).toContain('src/dao/*Dao.java');
    });

    it('survives junk', () => {
        expect(detectConventions(null)).toEqual([]);
        expect(detectConventions([{}, { path: '' }])).toEqual([]);
    });
});

describe('detectConventionsFull (measured layer — proposal A/B)', () => {
    it('reports coverage: the share of SOURCE files the rule set accounts for', () => {
        // 12 dao files + 6 service files + 2 free-form files. The rules cover
        // the 18 patterned files but not the 2 odd ones.
        const paths = [
            ...Array.from({ length: 12 }, (_, i) => `src/dao/T${i}Dao.java`),
            ...Array.from({ length: 6 }, (_, i) => `src/service/T${i}Service.java`),
            'src/dao/Util.java',
            'src/dao/Legacy.java',
        ];
        const m = detectConventionsFull(at(...paths));
        expect(m.rules.length).toBeGreaterThan(0);
        expect(m.coverage).toBeGreaterThan(0.8); // 18/20
        expect(m.sourceFiles).toBe(20);
        expect(m.assetFiles).toBe(0);
        expect(m.testFiles).toBe(0);
    });

    it('excludes tests and assets from the source denominator', () => {
        const paths = [
            ...Array.from({ length: 6 }, (_, i) => `src/dao/T${i}Dao.java`),
            ...Array.from({ length: 3 }, (_, i) => `src/dao/T${i}DaoTest.java`),
            ...Array.from({ length: 9 }, (_, i) => `res/ic_launcher${i}.png`),
        ];
        const m = detectConventionsFull(at(...paths));
        expect(m.sourceFiles).toBe(6);
        expect(m.testFiles).toBe(3);
        expect(m.assetFiles).toBe(9);
        expect(m.coverage).toBe(1); // the only source rule covers every source file
    });

    it('attaches a search recipe to every rule', () => {
        const m = detectConventionsFull(at(...[
            ...Array.from({ length: 6 }, (_, i) => `src/main/java/dao/T${i}Dao.java`),
            ...Array.from({ length: 6 }, (_, i) => `src/main/resources/mapper/T${i}Dao.xml`),
        ]));
        const suffix = m.rules.find(r => r.kind === 'suffix');
        expect(suffix?.recipe).toMatch(/ending in Dao/);
        const pair = m.rules.find(r => r.kind === 'pair');
        expect(pair?.recipe).toMatch(/sibling/);
    });

    it('is zero when nothing is detected', () => {
        const m = detectConventionsFull(at('a/one.js', 'a/two.js', 'a/three.js'));
        expect(m.rules).toEqual([]);
        expect(m.coverage).toBe(0);
    });
});

describe('stemWords', () => {
    it('splits CamelCase, separators, and screaming case', () => {
        expect(stemWords('AgentController')).toEqual(['Agent', 'Controller']);
        expect(stemWords('MonitorView.styles')).toEqual(['Monitor', 'View', 'styles']);
        expect(stemWords('M_ZAIKO_MEISAI')).toEqual(['M', 'ZAIKO', 'MEISAI']);
        expect(stemWords('LLMService')).toEqual(['LLM', 'Service']);
    });

    it('returns one word when there is nothing to split', () => {
        expect(stemWords('index')).toEqual(['index']);
        expect(stemWords('')).toEqual([]);
    });
});

describe('isTestPath', () => {
    it('recognises the shapes tests are actually written in', () => {
        expect(isTestPath('src/__tests__/foo.test.js')).toBe(true);
        expect(isTestPath('pkg/thing_test.go')).toBe(true);
        expect(isTestPath('src/a.spec.ts')).toBe(true);
        expect(isTestPath('src/test/java/FooTest.java')).toBe(true);
    });

    it('does not claim ordinary files', () => {
        expect(isTestPath('src/latest.js')).toBe(false);
        expect(isTestPath('src/protest/index.js')).toBe(false);
        expect(isTestPath('src/TestHarness.js')).toBe(false);
    });
});

describe('renderConventions', () => {
    it('shows the count behind every rule', () => {
        // The count is what separates this from the model's own guessing, and it
        // is what lets a weak rule be dismissed rather than believed.
        const line = renderConventions([{ rule: 'src/dao/*Dao.java', hits: 87, total: 100, share: 0.87 }]);
        expect(line).toBe('- src/dao/*Dao.java  (87/100 files, 87%)');
    });

    it('includes the search recipe when the rule carries one', () => {
        const line = renderConventions([{
            kind: 'suffix', rule: 'src/dao/*Dao.java', hits: 87, total: 100, share: 0.87,
            recipe: 'files ending in Dao under src/dao/',
        }]);
        expect(line).toContain('files ending in Dao');
    });

    it('survives junk', () => {
        expect(renderConventions(null)).toBe('');
    });
});

describe('buildOverviewPrompt', () => {
    const areas = Array.from({ length: 20 }, (_, i) => ({ dir: `src/a${i}`, files: 20 - i, names: ['x', 'y'] }));

    it('describes the structure, and never asks for source', () => {
        const p = buildOverviewPrompt(areas.slice(0, 2), { projectName: 'jh-ai-agent' });
        expect(p).toContain('jh-ai-agent');
        expect(p).toContain('src/a0/');
        expect(p).not.toMatch(/read the (files|source)/i);
    });

    it('caps how many areas it names, and says how many it left out', () => {
        const p = buildOverviewPrompt(areas);
        expect(p).toContain(`…and ${20 - AREA_LIMIT} smaller areas`);
    });

    it('forbids inventing what the structure does not show', () => {
        // The failure mode for a generated overview is confident fiction about
        // business purpose, which then rides in every prompt.
        const p = buildOverviewPrompt(areas.slice(0, 1));
        expect(p).toContain('Do NOT invent');
        expect(p).toContain('appears to');
    });

    it('keeps the note short enough to be standing context', () => {
        expect(buildOverviewPrompt(areas.slice(0, 1))).toMatch(/UNDER \d+ characters/);
    });

    it('hands the measured rules over with their counts', () => {
        const p = buildOverviewPrompt(areas.slice(0, 1), {
            conventions: [{ rule: 'src/dao/*Dao.java', hits: 87, total: 100, share: 0.87 }],
        });
        expect(p).toContain('src/dao/*Dao.java');
        expect(p).toContain('87/100');
    });

    it('tells the model the counted rules are NOT its own inference', () => {
        // Everything else in this prompt is hedged with "appears to", correctly.
        // Hedging a counted rule the same way would turn the note's most reliable
        // line into its most tentative-sounding one.
        const p = buildOverviewPrompt(areas.slice(0, 1), {
            conventions: [{ rule: 'src/dao/*Dao.java', hits: 87, total: 100, share: 0.87 }],
        });
        expect(p).toContain('COUNTED, not inferred');
        expect(p).toMatch(/not weaken them with "appears to"/);
    });

    it('omits the section entirely when nothing was detected', () => {
        expect(buildOverviewPrompt(areas.slice(0, 1))).not.toContain('MEASURED');
    });

    // The note is injected on every step; the index is queried. Restating the
    // tree in the note pays for it hundreds of times to duplicate something the
    // index answers more precisely.
    it('forbids reproducing what the index already answers', () => {
        const p = buildOverviewPrompt(areas.slice(0, 1));
        expect(p).toContain('Do NOT reproduce the directory listing');
        expect(p).toMatch(/injected into EVERY step/);
    });
});

describe('normalizeOverview', () => {
    it('strips a code fence the model wrapped it in', () => {
        expect(normalizeOverview('```markdown\n- a bullet\n```')).toBe('- a bullet');
    });

    it('drops a lead-in line that is not part of the note', () => {
        expect(normalizeOverview('Here is the orientation note:\n- a bullet')).toBe('- a bullet');
    });

    it('keeps a first line that IS a bullet', () => {
        expect(normalizeOverview('- first\n- second')).toBe('- first\n- second');
    });

    it('enforces the standing-context cap', () => {
        const out = normalizeOverview('- ' + 'x'.repeat(5000));
        expect(out.length).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS);
        expect(out.endsWith('…')).toBe(true);
    });

    it('returns empty for nothing', () => {
        expect(normalizeOverview('')).toBe('');
        expect(normalizeOverview(null)).toBe('');
    });
});

describe('renderOverview', () => {
    it('labels the block as generated and possibly stale', () => {
        // It sits next to the user's own instructions.md, which is normative.
        // Reading as equally authoritative is the thing to prevent.
        const b = renderOverview('- a bullet', { generatedAt: '2026-08-13T00:00:00Z' });
        expect(b).toContain('<project_overview');
        expect(b).toContain('2026-08-13');
        expect(b).toMatch(/Auto-generated/);
        expect(b).toMatch(/prefer what you read in the files/);
    });

    it('emits nothing when there is no note — no empty block in the prompt', () => {
        expect(renderOverview('')).toBe('');
        expect(renderOverview('   ')).toBe('');
    });

    it('renders the measured rules VERBATIM when the stored layer is present', () => {
        // The rules are arithmetic over paths; a model rephrasing them cannot
        // make them more true. The prose is the model's part, the rules are not
        // re-expressed — they are copied (proposal A).
        const conventions = {
            rules: [
                { kind: 'suffix', rule: 'src/dao/*Dao.java', hits: 87, total: 100, share: 0.87, recipe: 'files ending in Dao under src/dao/' },
            ],
            coverage: 0.87, sourceFiles: 100, assetFiles: 0, testFiles: 0,
        };
        const b = renderOverview('- the project is a Tauri app', { generatedAt: '2026-08-13T00:00:00Z', conventions });
        expect(b).toContain('src/dao/*Dao.java');
        expect(b).toContain('(87/100 files, 87%)');
        expect(b).toMatch(/Measured naming rules/);
        expect(b).toContain('the project is a Tauri app');
    });

    it('does not duplicate the measured block when the prose already carries it', () => {
        // The prose is the summariser's phrasing of the same rules; the stored
        // layer is the verbatim original. Both belong, but the stored one must
        // not appear twice.
        const conventions = { rules: [{ kind: 'suffix', rule: 'src/dao/*Dao.java', hits: 6, total: 6, share: 1 }], coverage: 1 };
        const b = renderOverview('- table access is *Dao.java', { conventions });
        expect(b.match(/src\/dao\/\*Dao\.java/g)).toHaveLength(1);
    });
});

describe('isOverviewStale', () => {
    const now = Date.parse('2026-08-13T00:00:00Z');

    it('is stale when there is none', () => {
        expect(isOverviewStale(null, { now })).toBe(true);
        expect(isOverviewStale({ generatedAt: '' }, { now })).toBe(true);
    });

    it('is fresh within the window and stale past it', () => {
        expect(isOverviewStale({ generatedAt: '2026-08-01T00:00:00Z' }, { now })).toBe(false);
        expect(isOverviewStale({ generatedAt: '2026-06-01T00:00:00Z' }, { now })).toBe(true);
    });

    it('is stale when the workspace HEAD changed since the prose was written', () => {
        // A commit moved the tree the prose described, even though the calendar
        // says the note is young. The measured half does NOT age this way — it is
        // refreshed by every study pass — but the prose must follow the tree.
        expect(isOverviewStale(
            { generatedAt: '2026-08-12T00:00:00Z', head: 'abc1234' },
            { now, head: 'def5678' })).toBe(true);
    });

    it('stays fresh when HEAD is unchanged or unknown', () => {
        expect(isOverviewStale(
            { generatedAt: '2026-08-12T00:00:00Z', head: 'abc1234' },
            { now, head: 'abc1234' })).toBe(false);
        // No recorded head and no current head: fall back to age alone.
        expect(isOverviewStale(
            { generatedAt: '2026-08-12T00:00:00Z' },
            { now })).toBe(false);
    });
});

describe('structureDigest accepts either input shape', () => {
    it('folds the study pass output ({path, names})', () => {
        const areas = structureDigest([
            { path: 'src/modules/ai/x.js', names: ['alpha', 'beta'] },
            { path: 'src/modules/ai/y.js', names: ['gamma'] },
        ]);
        expect(areas[0]).toMatchObject({ dir: 'src/modules/ai', files: 2 });
        expect(areas[0].names).toEqual(['alpha', 'beta', 'gamma']);
    });
});

// ── Generalisation (priority 1-5): the detector beyond Java/MyBatis ────────
// The original five shapes were verified as Java/MyBatis-specific. These tests
// pin the generalisations: word-boundary affixes, suffix taxonomies, naming
// case, generated output, and conventional directory roles — the shapes a
// React/TS, Python, Go or Rust tree actually shows.
describe('detectConventions generalisation', () => {
    it('detects a word-boundary prefix taxonomy (User/Admin/Guest, not M_/T_/W_)', () => {
        const paths = [];
        for (const p of ['User', 'Admin', 'Guest']) {
            for (const n of ['Profile', 'Settings', 'Orders', 'Payments']) paths.push(`models/${p}${n}.ts`);
        }
        const tax = rulesOf(paths).find(r => r.includes('splits by prefix'));
        expect(tax).toBeTruthy();
        expect(tax).toContain('User*');
        expect(tax).toContain('Admin*');
        expect(tax).toContain('Guest*');
    });

    it('detects a word-boundary suffix taxonomy (Create/Update/Delete handlers)', () => {
        // Each entity pairs with a different verb, so only the SUFFIX side
        // forms a set. (A grid of entities × verbs would also make the prefix
        // side a taxonomy, and the prefix side wins.)
        const paths = ['handlers/UserCreate.ts', 'handlers/OrderCreate.ts',
            'handlers/ProductUpdate.ts', 'handlers/InvoiceUpdate.ts',
            'handlers/CustomerDelete.ts', 'handlers/ShipmentDelete.ts'];
        const tax = rulesOf(paths).find(r => r.includes('splits by suffix'));
        expect(tax).toBeTruthy();
        expect(tax).toContain('*Create');
        expect(tax).toContain('*Delete');
    });

    it('does not double-report a prefix taxonomy as a suffix taxonomy', () => {
        // M_ZAIKO: the suffix ZAIKO is the ENTITY name, not a second
        // classification. Only the prefix split may fire.
        const paths = [];
        for (const p of ['M_', 'T_', 'W_']) {
            for (const n of ['ZAIKO', 'CHUMON']) paths.push(`db/schema/${p}${n}.sql`);
        }
        const rules = rulesOf(paths);
        expect(rules.some(r => r.includes('splits by prefix'))).toBe(true);
        expect(rules.some(r => r.includes('splits by suffix'))).toBe(false);
    });

    it('reports naming CASE when that is all a directory has to say', () => {
        // Single-word files: no affix to count, but PascalCase is a rule an
        // agent needs before naming the next component.
        const paths = Array.from({ length: 6 }, (_, i) => `src/components/Widget${i}.tsx`);
        const style = rulesOf(paths).find(r => r.includes('are PascalCase'));
        expect(style).toBeTruthy();
    });

    it('detects a shared middle word when neither end is regular', () => {
        const paths = ['flows/CreateUserFoo.ts', 'flows/UpdateUserBar.ts', 'flows/DeleteUserBaz.ts',
            'flows/ListUserQux.ts', 'flows/GetUserQuux.ts', 'flows/SetUserCorge.ts'];
        const mid = rulesOf(paths).find(r => r.includes('contain User'));
        expect(mid).toBeTruthy();
        expect(mid).toMatch(/same position/);
    });

    it('excludes generated output from source coverage and flags it do-not-edit', () => {
        const paths = [
            ...Array.from({ length: 6 }, (_, i) => `src/dao/T${i}Dao.java`),
            ...Array.from({ length: 20 }, (_, i) => `dist/bundle.${i}.js`),
        ];
        const m = detectConventionsFull(at(...paths));
        expect(m.rules.some(r => r.rule.includes('generated output'))).toBe(true);
        expect(m.generatedFiles).toBe(20);
        expect(m.sourceFiles).toBe(6);
        expect(m.coverage).toBe(1); // generated files never dilute the source ratio
    });

    it('names conventional directory roles that the dir name does not say', () => {
        const paths = ['src/api/users.ts', 'src/api/orders.ts', 'src/api/products.ts',
            'src/api/categories.ts', 'src/api/invoices.ts', 'src/api/payments.ts'];
        const role = rulesOf(paths).find(r => r.includes('holds the API surface'));
        expect(role).toBeTruthy();
    });

    it('ranks a searchable suffix above a case style even when case counts more', () => {
        const paths = [
            ...Array.from({ length: 20 }, (_, i) => `src/dao/T${i}Dao.java`),
            ...Array.from({ length: 6 }, (_, i) => `src/service/T${i}Service.java`),
        ];
        const rules = rulesOf(paths);
        expect(rules[0]).toContain('Dao');
        expect(rules.indexOf(rules.find(r => r.includes('PascalCase')))).toBeGreaterThan(
            rules.indexOf(rules.find(r => r.includes('Dao'))));
    });

    it('detects a kebab-case naming rule in a docs/scripts tree', () => {
        const paths = Array.from({ length: 6 }, (_, i) => `scripts/build-lambda-${i}.sh`);
        const style = rulesOf(paths).find(r => r.includes('kebab-case'));
        expect(style).toBeTruthy();
    });
});
