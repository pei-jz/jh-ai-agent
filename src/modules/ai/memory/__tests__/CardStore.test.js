// CardStore — what a session teaches, and what gets recalled later.
//
// The rules under test are the ones that decide whether this store stays useful
// or turns into noise: what is worth minting, what counts as "verified", how a
// card fades, and which single card surfaces at a given call.

import { describe, it, expect, vi } from 'vitest';
import {
    mintCards, mergeCards, cardScore, cardKey, selectForTool, selectBrief,
    renderCard, renderBrief, reconcile, recurrenceRate, consolidateCards, recurrenceStats, CardStore, HALF_LIFE_DAYS,
    isDurableQuery, cardSummary, summarizeMinted, selectBriefBudgeted, BRIEF_BUDGET,
} from '../CardStore.js';
import { toEvent, summarizeFailures } from '../TraceRecorder.js';

const ev = (i, tool, target, { err, q } = {}) => toEvent({
    iteration: i, tool,
    args: { path: target, ...(q ? { pattern: q } : {}) },
    result: err || 'Success', isError: !!err, ms: 1,
});
/** A search call carries its query in `pattern` (grep_search) — no `path`. */
const search = (i, q) => toEvent({ iteration: i, tool: 'grep_search', args: { pattern: q }, result: 'hit', isError: false });

const learn = (events) => mintCards({ rows: summarizeFailures(events), events, sessionId: 's1', date: '2026-08-11' });

describe('minting lessons', () => {
    const events = [
        ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }),
        ev(3, 'read_file', 'a.svelte'),
        ev(4, 'write_file', 'a.svelte'),
    ];

    it('mints a lesson whose fix is the sequence that actually worked', () => {
        const lesson = learn(events).find(c => c.type === 'lesson');
        expect(lesson.signature).toBe('write_file|edit_mismatch|.svelte');
        expect(lesson.fix).toBe('read_file → write_file');
        expect(lesson.verified).toBe(true);
        expect(lesson.costSteps).toBe(2);
    });

    it('leaves fix null — not guessed — when the failure was never resolved', () => {
        const lesson = learn([ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }), ev(5, 'read_file', 'b.js')])
            .find(c => c.type === 'lesson');
        expect(lesson.fix).toBeNull();
        expect(lesson.verified).toBe(false);
        expect(lesson.confidence).toBeLessThan(0.8); // unresolved ⇒ less trusted
    });

    it('records root_cause as unknown rather than inventing one', () => {
        // Review item A1: only verified actions are stored; the "why" is filled
        // in later, when a recurrence gives something to reason from.
        const lesson = learn(events).find(c => c.type === 'lesson');
        expect(lesson.root_cause).toBeNull();
        expect(lesson.hypothesis).toBeNull();
    });

    // 8 of the 15 stored fixes were this: "DO: multi_replace_file_content" on a
    // card triggered BY multi_replace_file_content failing. It advises the agent
    // to do what it was already doing, and — because the triggering call sits
    // inside the follow-through scoring window — it also scored as compliance
    // for free. The insight half already refused this case; the lesson half did
    // not, which is how a vacuous instruction became the commonest instruction.
    it('does not record a "fix" that is just the failing tool again', () => {
        const lesson = learn([
            ev(2, 'multi_replace_file_content', 'a.js', { err: 'Error: old_text not found' }),
            ev(3, 'multi_replace_file_content', 'a.js'),
        ]).find(c => c.type === 'lesson');
        expect(lesson.fix).toBeNull();
        expect(lesson.verified).toBe(false);
    });

    it('still records a fix that involved doing something different', () => {
        const lesson = learn([
            ev(2, 'write_file', 'a.js', { err: 'Error: anchor does not match' }),
            ev(3, 'read_file', 'a.js'),
            ev(4, 'write_file', 'a.js'),
        ]).find(c => c.type === 'lesson');
        expect(lesson.fix).toBe('read_file → write_file');
    });

    it('never mints a card for a user refusal', () => {
        const denied = toEvent({ iteration: 1, tool: 'delete_file', args: { path: 'a.js' }, result: 'Error: User Denied', isError: true, denied: true });
        expect(learn([denied])).toHaveLength(0);
    });
});

describe('minting insights — the "what worked" half', () => {
    it('mints a recovery recipe alongside the lesson', () => {
        const cards = learn([
            ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }),
            ev(3, 'read_file', 'a.svelte'),
            ev(4, 'write_file', 'a.svelte'),
        ]);
        const insight = cards.find(c => c.type === 'insight');
        expect(insight.kind).toBe('recovery');
        expect(insight.what).toBe('read_file → write_file');
        expect(renderCard(insight)).toContain('what worked');
    });

    it('does not mint a recipe when the retry alone fixed it (nothing to learn)', () => {
        const cards = learn([
            ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }),
            ev(3, 'write_file', 'a.svelte'),
        ]);
        expect(cards.some(c => c.type === 'insight')).toBe(false);
    });

    it('mints a locator when a search result is actually used', () => {
        const cards = learn([search(1, 'licenseState'), ev(2, 'read_file', 'src/license.js')]);
        const loc = cards.find(c => c.kind === 'locator');
        expect(loc.q).toBe('licenseState');
        expect(loc.target).toBe('src/license.js');
        expect(renderCard(loc)).toContain('src/license.js');
    });

    it('ignores a throwaway REGEX search, keeping only names', () => {
        // Observed in a real run: `path\.endsWith\('\.md'\)|\.md'|markdown|isMd`
        // was stored as "where things are". A query built for one search can never
        // match a future task, so the card only costs an injection slot.
        const cards = learn([search(1, "path\\.endsWith\\('\\.md'\\)|\\.md'|markdown|isMd"), ev(2, 'read_file', 'src/a.js')]);
        expect(cards).toHaveLength(0);
    });

    it.each([
        ['licenseState', true],
        ['createNewFileOfType', true],
        ['src/modules/core/Editor.js', true],
        ['agent safety limits', true],
        ['a|b', false],
        ['foo.*bar', false],
        ['^start', false],
        ['x\\.y', false],
        ['ab', false],
        ['z'.repeat(80), false],
    ])('judges %j durable=%s', (q, expected) => {
        expect(isDurableQuery(q)).toBe(expected);
    });

    it('ignores a search nobody acted on', () => {
        // An unused search found nothing worth remembering — that is the
        // verification, and it costs no LLM call to apply.
        expect(learn([search(1, 'nothing'), ev(9, 'read_file', 'far.js')])).toHaveLength(0);
    });

    it('learns from a clean, successful session (no failure required)', () => {
        const cards = learn([search(1, 'ConfigView'), ev(2, 'read_file', 'src/dashboard/views/ConfigView.js')]);
        expect(cards).toHaveLength(1);
        expect(cards[0].type).toBe('insight');
    });
});

describe('merging', () => {
    it('bumps hits instead of duplicating the same knowledge', () => {
        const store = learn([
            ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }),
            ev(3, 'read_file', 'a.svelte'),
            ev(4, 'write_file', 'a.svelte'),
        ]);
        const before = store.length;
        mergeCards(store, learn([
            ev(1, 'write_file', 'b.svelte', { err: 'Error: anchor does not match' }),
            ev(2, 'read_file', 'b.svelte'),
            ev(3, 'write_file', 'b.svelte'),
        ]), '2026-08-12');
        expect(store).toHaveLength(before);
        expect(store.find(c => c.type === 'lesson').hits).toBe(2);
        expect(store.find(c => c.type === 'lesson').last_recurrence).toBe('2026-08-12');
    });

    it('counts a recurrence AFTER the card was injected — the "is it working?" number', () => {
        const store = learn([ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' })]);
        store[0].injected = true; // surfaced during the next run…
        mergeCards(store, learn([ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' })]), '2026-08-12');
        expect(store[0].recurrences_after_hit).toBe(1); // …and it happened anyway
    });

    it('fills in a fix the first time one is observed', () => {
        const store = learn([ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' })]);
        expect(store[0].fix).toBeNull();
        mergeCards(store, learn([
            ev(2, 'write_file', 'a.svelte', { err: 'Error: anchor does not match' }),
            ev(3, 'read_file', 'a.svelte'),
            ev(4, 'write_file', 'a.svelte'),
        ]), '2026-08-12');
        expect(store[0].fix).toBe('read_file → write_file');
        expect(store[0].verified).toBe(true);
    });

    it('keys locators by query AND target, so different discoveries coexist', () => {
        const a = learn([search(1, 'foo'), ev(2, 'read_file', 'x.js')]);
        const b = learn([search(1, 'bar'), ev(2, 'read_file', 'y.js')]);
        expect(cardKey(a[0])).not.toBe(cardKey(b[0]));
    });
});

describe('reconcile — two sessions writing the same file', () => {
    const card = (over) => ({ type: 'lesson', signature: 's', trigger: { ext: '.js' }, hits: 1, costSteps: 2, first_seen: '2026-08-05', last_recurrence: '2026-08-05', evidence: ['session:a'], ...over });

    it('keeps what the other session learned instead of overwriting it', () => {
        const mine = [card()];
        const theirs = [card({ signature: 'other' })];
        expect(reconcile(mine, theirs)).toHaveLength(2);
    });

    it('takes the strongest version of the same card, without double-counting hits', () => {
        const out = reconcile(
            [card({ hits: 3, costSteps: 2, last_recurrence: '2026-08-11' })],
            [card({ hits: 2, costSteps: 9, last_recurrence: '2026-08-09', evidence: ['session:b'] })],
        );
        expect(out).toHaveLength(1);
        expect(out[0].hits).toBe(3);          // max, NOT 5 — one card written twice
        expect(out[0].costSteps).toBe(9);
        expect(out[0].last_recurrence).toBe('2026-08-11');
        expect(out[0].evidence).toEqual(['session:b', 'session:a']);
    });

    it('adopts a fix the other session verified', () => {
        const out = reconcile([card({ fix: null })], [card({ fix: 'read_file → write_file' })]);
        expect(out[0].fix).toBe('read_file → write_file');
        expect(out[0].verified).toBe(true);
    });

    it('keeps a card the user switched off, whichever copy says so', () => {
        expect(reconcile([card()], [card({ disabled: true })])[0].disabled).toBe(true);
        expect(reconcile([card({ disabled: true })], [card()])[0].disabled).toBe(true);
    });

    it('keeps identity-less cards apart instead of collapsing them', () => {
        // Defensive: a hand-edited or truncated row without a signature must not
        // swallow its neighbours during reconcile.
        const out = reconcile([{ id: 'x' }, { id: 'y' }], [{ id: 'z' }]);
        expect(out.map(c => c.id).sort()).toEqual(['x', 'y', 'z']);
    });

    it('mutates neither input', () => {
        const mine = [card()];
        reconcile(mine, [card({ hits: 9 })]);
        expect(mine[0].hits).toBe(1);
    });
});

describe('decay', () => {
    const card = (over) => ({ type: 'lesson', costSteps: 4, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11', ...over });
    const NOW = Date.parse('2026-08-11');

    it('halves a card that has not recurred in one half-life', () => {
        const fresh = cardScore(card(), NOW);
        const old = cardScore(card(), NOW + HALF_LIFE_DAYS * 86_400_000);
        expect(old / fresh).toBeCloseTo(0.5, 5);
    });

    it('ranks an expensive, repeated failure above a cheap one', () => {
        expect(cardScore(card({ costSteps: 9, hits: 3 }), NOW)).toBeGreaterThan(cardScore(card(), NOW));
    });

    it('scores a disabled or stale card at zero', () => {
        expect(cardScore(card({ disabled: true }), NOW)).toBe(0);
        expect(cardScore(card({ stale: true }), NOW)).toBe(0);
    });
});

describe('recall', () => {
    const store = [
        { id: 'a', type: 'lesson', signature: 's', trigger: { tool: 'write_file', ext: '.svelte' }, costSteps: 7, hits: 1, confidence: 0.8, symptom: 'anchor', last_recurrence: '2026-08-11' },
        { id: 'b', type: 'lesson', signature: 't', trigger: { tool: 'write_file', ext: '.rs' }, costSteps: 2, hits: 1, confidence: 0.8, symptom: 'build', last_recurrence: '2026-08-11' },
        { id: 'c', type: 'insight', kind: 'recovery', trigger: { tool: 'read_file', ext: '' }, what: 'x → y', costSteps: 1, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' },
    ];

    it('matches on tool AND file type, so a .svelte lesson stays off a .rs edit', () => {
        expect(selectForTool(store, { tool: 'write_file', ext: '.svelte' }).id).toBe('a');
        expect(selectForTool(store, { tool: 'write_file', ext: '.rs' }).id).toBe('b');
        expect(selectForTool(store, { tool: 'glob', ext: '.rs' })).toBeNull();
    });

    it('lets a card with no file type apply tool-wide', () => {
        expect(selectForTool(store, { tool: 'read_file', ext: '.md' }).id).toBe('c');
    });

    it('skips cards already surfaced in this run', () => {
        expect(selectForTool(store, { tool: 'write_file', ext: '.svelte' }, { exclude: new Set(['a']) })).toBeNull();
    });

    it('briefs with the highest-scoring cards, both kinds mixed', () => {
        const brief = selectBrief(store, { limit: 2 });
        expect(brief.map(c => c.id)).toEqual(['a', 'b']);
        expect(renderBrief(brief)).toContain('[Verified from earlier runs');
    });

    it('says nothing when there is nothing to say', () => {
        expect(renderBrief([])).toBe('');
        expect(selectForTool([], { tool: 'x' })).toBeNull();
    });
});

// The opening brief fills each KIND against its own budget instead of ranking
// everything together. `cardScore` is led by costSteps — how much a failure
// HURT, not how much it matters — so one ranked list let painful trivia evict
// everything else (plan §4.5).
describe('brief budgets', () => {
    const card = (over) => ({
        id: over.id, type: 'insight', hits: 1, confidence: 0.8,
        last_recurrence: '2026-08-12', trigger: {}, ...over,
    });

    it('a costly lesson cannot take the whole brief', () => {
        const store = [
            card({ id: 'L1', type: 'lesson', costSteps: 40, symptom: 'anchor' }),
            card({ id: 'L2', type: 'lesson', costSteps: 30, symptom: 'anchor' }),
            card({ id: 'L3', type: 'lesson', costSteps: 20, symptom: 'anchor' }),
            card({ id: 'I1', kind: 'recovery', what: 'read_file → write_file', costSteps: 1 }),
        ];
        const picked = selectBriefBudgeted(store);
        // Under one ranked list this was L1, L2, L3 — the insight never appeared.
        expect(picked.filter(c => c.type === 'lesson')).toHaveLength(1);
        expect(picked.some(c => c.id === 'I1')).toBe(true);
    });

    it('ranks WITHIN a budget by what the task is about', () => {
        const store = [
            card({ id: 'far', kind: 'locator', q: 'billing', target: 'src/billing.js', costSteps: 9 }),
            card({ id: 'near', kind: 'locator', q: 'licenseState', target: 'src/license.js', costSteps: 1 }),
        ];
        // 'far' scores higher (costSteps 9 vs 1); the query is what flips it.
        expect(selectBriefBudgeted(store, { budgets: { insight: 1 } })[0].id).toBe('far');
        expect(selectBriefBudgeted(store, { budgets: { insight: 1 }, query: 'licenseState を直す' })[0].id).toBe('near');
    });

    it('falls back to score when there is no query', () => {
        const store = [
            card({ id: 'a', kind: 'recovery', what: 'x', costSteps: 2 }),
            card({ id: 'b', kind: 'recovery', what: 'y', costSteps: 9 }),
        ];
        expect(selectBriefBudgeted(store, { budgets: { insight: 1 } })[0].id).toBe('b');
    });

    it('skips disabled cards and ones already shown', () => {
        const store = [
            card({ id: 'off', kind: 'recovery', what: 'x', costSteps: 9, disabled: true }),
            card({ id: 'seen', kind: 'recovery', what: 'y', costSteps: 8 }),
            card({ id: 'ok', kind: 'recovery', what: 'z', costSteps: 1 }),
        ];
        const picked = selectBriefBudgeted(store, { budgets: { insight: 2 }, exclude: new Set(['seen']) });
        expect(picked.map(c => c.id)).toEqual(['ok']);
    });

    it('leaves a kind out entirely when its budget is zero', () => {
        const store = [card({ id: 'L1', type: 'lesson', costSteps: 40, symptom: 'x' })];
        expect(selectBriefBudgeted(store, { budgets: { insight: 2, lesson: 0 } })).toEqual([]);
    });

    it('the default budget keeps lessons a minority', () => {
        expect(BRIEF_BUDGET.lesson).toBeLessThan(BRIEF_BUDGET.insight);
    });
});

describe('rendering', () => {
    // The action goes on its OWN line behind a `DO:` marker rather than inside a
    // sentence. Measured over 89 runs, the prose form ("What worked: X. Do that
    // first.") produced a follow-through of 53.8% against a 50.0% control base
    // rate — i.e. the agent did what it would have done anyway. Prose buries the
    // one part of a card that is actionable.
    it('puts the action on its own line, as an instruction', () => {
        const text = renderCard({
            type: 'lesson', trigger: { tool: 'write_file' }, symptom: 'anchor does not match',
            fix: 'read_file → write_file', costSteps: 7, confidence: 0.8, last_recurrence: '2026-08-11',
        });
        expect(text).toContain('\n  DO: read_file → write_file');
        expect(text).not.toMatch(/\bdon't\b|\bdo not\b|\bnever\b/i);
    });

    it('still carries what it cost, which is why the card is worth reading', () => {
        const text = renderCard({
            type: 'lesson', trigger: { tool: 'write_file' }, symptom: 'anchor does not match',
            fix: 'read_file → write_file', costSteps: 7,
        });
        expect(text).toContain('cost 7 steps');
    });

    it('is honest when there is no verified fix', () => {
        const text = renderCard({ type: 'lesson', trigger: { tool: 'write_file' }, symptom: 'x', fix: null, costSteps: 3 });
        expect(text).toContain('no verified fix');
        expect(text).toContain('\n  DO: check the current state');
    });

    // The old brief closed with "ignore any that do not fit this task", which
    // gave the model a free pass on every card. The escape hatch has to stay —
    // advice that does not fit must not be forced — but using it now costs a
    // sentence, so it gets used when it is true rather than by default.
    it('makes skipping a card cost something to say', () => {
        const brief = renderBrief([{ type: 'lesson', trigger: { tool: 'write_file' }, symptom: 'x', fix: 'a → b', costSteps: 2 }]);
        expect(brief).not.toMatch(/ignore any/i);
        expect(brief).toMatch(/say which and why/i);
    });

    it('stays inside the injection budget', () => {
        const text = renderCard({ type: 'lesson', trigger: { tool: 'write_file' }, symptom: 'y'.repeat(500), fix: 'z'.repeat(500), costSteps: 1 });
        expect(text.length).toBeLessThanOrEqual(240);
    });

    // Measured on the real store BEFORE this fix: 14 of 37 lesson cards (38%)
    // had no DO line at all. A long error message filled all 240 characters and
    // the only actionable part of the card never reached the model. Truncating
    // the finished string puts the cap exactly where the instruction lives.
    it('keeps the DO line when the error message is long', () => {
        const text = renderCard({
            type: 'lesson', trigger: { tool: 'grep_search' },
            symptom: 'Error: invalid glob — ' + 'x'.repeat(400),
            fix: 'grep_search', costSteps: 3,
        });
        expect(text).toContain('\n  DO: grep_search');
        expect(text.length).toBeLessThanOrEqual(240);
        expect(text).toContain('…');   // the CONTEXT is what got shortened
    });

    it('keeps the DO line for every card kind', () => {
        const long = 'q'.repeat(400);
        const cards = [
            { type: 'lesson', trigger: { tool: 't' }, symptom: long, fix: 'a → b', costSteps: 1 },
            { type: 'lesson', trigger: { tool: 't' }, symptom: long, fix: null, costSteps: 1 },
            { type: 'insight', kind: 'locator', q: long, target: 'src/a.js' },
            { type: 'insight', kind: 'recovery', trigger: { tool: 't', ext: '.js' }, what: 'a → b' },
        ];
        for (const c of cards) {
            expect(renderCard(c)).toContain('DO:');
            expect(renderCard(c).length).toBeLessThanOrEqual(240);
        }
    });

    it('caps a pathological DO line rather than emitting only an ellipsis', () => {
        const text = renderCard({ type: 'lesson', trigger: { tool: 't' }, symptom: 'x', fix: 'z'.repeat(500), costSteps: 1 });
        expect(text.length).toBeLessThanOrEqual(240);
        expect(text).toContain('DO:');
    });
});

describe('CardStore persistence', () => {
    const make = (raw) => {
        const invoke = vi.fn(async (cmd) => (cmd === 'read_file' ? raw : null));
        return { invoke, store: new CardStore({ workspacePath: 'C:/ws', invoke }) };
    };

    it('loads one card per line and tolerates a corrupt one', async () => {
        const { store } = make('{"id":"a","type":"lesson"}\nnot json\n{"id":"b","type":"insight"}');
        await store.load();
        expect(store.cards.map(c => c.id)).toEqual(['a', 'b']);
    });

    it('starts empty when the file does not exist', async () => {
        const invoke = vi.fn(async () => { throw new Error('ENOENT'); });
        const store = new CardStore({ workspacePath: 'C:/ws', invoke });
        await expect(store.load()).resolves.toEqual([]);
    });

    it('writes to .agent/memory/cards.jsonl', async () => {
        const { invoke, store } = make('');
        store.cards = [{ id: 'a', type: 'lesson' }];
        await store.save();
        const write = invoke.mock.calls.find(c => c[0] === 'write_file');
        expect(write[1].path).toBe('C:/ws/.agent/memory/cards.jsonl');
        expect(JSON.parse(write[1].content.trim()).id).toBe('a');
    });

    it('does not erase what another session wrote while this one ran', async () => {
        // A subagent (or a concurrent task in the same workspace) appended a card
        // after this store loaded. Saving must not roll that back.
        const { invoke, store } = make('{"id":"theirs","type":"lesson","signature":"other","trigger":{}}');
        store.cards = [{ id: 'mine', type: 'lesson', signature: 'mine', trigger: {} }];
        await store.save();
        const written = invoke.mock.calls.find(c => c[0] === 'write_file')[1].content.trim().split('\n').map(JSON.parse);
        expect(written.map(c => c.id).sort()).toEqual(['mine', 'theirs']);
    });

    it('prunes to the cap by score, keeping the expensive lessons', async () => {
        const { invoke, store } = make('');
        store.maxCards = 2;
        store.cards = [
            { id: 'cheap', costSteps: 1, hits: 1, confidence: 0.5, last_recurrence: '2026-08-11' },
            { id: 'costly', costSteps: 9, hits: 3, confidence: 0.9, last_recurrence: '2026-08-11' },
            { id: 'mid', costSteps: 4, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' },
        ];
        await store.save();
        expect(store.cards.map(c => c.id)).toEqual(['costly', 'mid']);
        expect(invoke.mock.calls.some(c => c[0] === 'write_file')).toBe(true);
    });

    it('never throws when the write fails', async () => {
        const invoke = vi.fn(async (cmd) => { if (cmd === 'write_file') throw new Error('disk full'); return null; });
        const store = new CardStore({ workspacePath: 'C:/ws', invoke });
        await expect(store.save()).resolves.toBe(false);
    });

    // The brief fires at step 1; the tool it warns about may not run until step
    // 18, by which point the brief is buried under seventeen steps of history.
    // Striking the card off at step 1 meant nothing re-asserted it at the one
    // moment it was certain to be relevant.
    it('re-asserts a briefed card when its trigger actually fires', () => {
        const { store } = make('');
        store.cards = [{ id: 'a', type: 'lesson', trigger: { tool: 'write_file', ext: '.js' }, costSteps: 5, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' }];
        expect(store.recallBrief('anything')).toHaveLength(1);
        expect(store.recallForTool('write_file', 'x.js')?.id).toBe('a');
        // Twice is the limit — a third sighting would be nagging, not recall.
        expect(store.recallForTool('write_file', 'y.js')).toBeNull();
    });

    it('counts a re-asserted card ONCE in the statistics', () => {
        // `shown` is the recurrence rate's denominator. Counting one card twice
        // in a run would halve the apparent recurrence rate of the cards the run
        // leaned on hardest — the ones whose rate matters most.
        const { store } = make('');
        store.cards = [{ id: 'a', type: 'lesson', trigger: { tool: 'write_file', ext: '.js' }, costSteps: 5, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' }];
        store.recallBrief('anything');
        store.recallForTool('write_file', 'x.js');
        expect(store.cards[0].shown).toBe(1);
    });

    // Observed on the real store: a three-slot brief spent two slots saying
    // "X is in MemoryTab.svelte" and "Y is in MemoryTab.svelte". As a place to
    // look those are one sentence, and the second cost a slot another file
    // could have used — MonitorView.js alone had 12 live locator cards.
    it('gives one file only one slot in the brief', () => {
        const loc = (id, q, target) => ({
            id, type: 'insight', kind: 'locator', q, target, what: `"${q}" → ${target}`,
            hits: 5, confidence: 0.8, last_recurrence: '2026-08-11',
        });
        const store = [
            loc('a', 'cfg-mem-summary', 'src/MemoryTab.svelte'),
            loc('b', '_syncListTabs', 'src/MemoryTab.svelte'),
            loc('c', 'runStudy', 'src/ConfigRoot.svelte'),
        ];
        const picked = selectBriefBudgeted(store, { budgets: { insight: 2 } });
        expect(picked.map(c => c.target)).toEqual(['src/MemoryTab.svelte', 'src/ConfigRoot.svelte']);
    });

    it('still allows two lessons about one file — they are different failures', () => {
        const lesson = (id, sig) => ({
            id, type: 'lesson', signature: sig, target: 'src/a.js',
            trigger: { tool: 'write_file' }, costSteps: 5, hits: 1, confidence: 0.8,
            last_recurrence: '2026-08-11',
        });
        const picked = selectBriefBudgeted([lesson('a', 's1'), lesson('b', 's2')], { budgets: { lesson: 2 } });
        expect(picked).toHaveLength(2);
    });

    it('marks a recalled card injected so it is not repeated in one run', () => {
        const { store } = make('');
        store.cards = [{ id: 'a', type: 'lesson', trigger: { tool: 'write_file', ext: '.js' }, costSteps: 5, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' }];
        expect(store.recallForTool('write_file', 'x.js').id).toBe('a');
        expect(store.cards[0].injected).toBe(true);
        expect(store.recallForTool('write_file', 'x.js')).toBeNull();
    });

    it('stops surfacing cards once the per-run cap is reached', () => {
        // A long run was collecting a memory line at nearly every search; advice
        // at that density stops being read. Learning is unaffected — only how
        // much of it is put in front of the agent in one run.
        const invoke = vi.fn(async () => null);
        const store = new CardStore({ workspacePath: 'C:/ws', invoke, maxPerRun: 2 });
        store.cards = ['a', 'b', 'c'].map(id => ({
            id, type: 'lesson', signature: id, trigger: { tool: 'grep_search', ext: '' },
            costSteps: 3, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11',
        }));
        expect(store.recallForTool('grep_search', 'x.js')).toBeTruthy();
        expect(store.recallForTool('grep_search', 'y.js')).toBeTruthy();
        expect(store.recallForTool('grep_search', 'z.js')).toBeNull();
    });

    // Control-arm selection. The card is picked so its recipe can be scored
    // against a run that never saw it — that score is the base rate the recall
    // arm has to beat — but nothing was put in front of the agent, so neither
    // `shown` (the recurrence-rate denominator) nor `injected` (which decides
    // whether a later recurrence is the card's fault) may move.
    it('picks a card in shadow mode without counting it as shown', () => {
        const { store } = make('');
        store.cards = [{ id: 'a', type: 'lesson', trigger: { tool: 'write_file', ext: '.js' }, costSteps: 5, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' }];
        expect(store.recallForTool('write_file', 'x.js', { shadow: true }).id).toBe('a');
        expect(store.cards[0].shown || 0).toBe(0);
        expect(store.cards[0].injected).toBeUndefined();
        // Still deduplicated within the run — picking it twice would score the
        // same recipe twice off one selection.
        expect(store.recallForTool('write_file', 'x.js', { shadow: true })).toBeNull();
    });

    it('keeps the opening brief out of the statistics in shadow mode', () => {
        const { store } = make('');
        store.cards = [{ id: 'i1', type: 'insight', kind: 'locator', what: 'grep_search → read_file', hits: 2, confidence: 0.8, last_recurrence: '2026-08-11' }];
        expect(store.recallBrief('anything', undefined, { shadow: true })).toHaveLength(1);
        expect(store.cards[0].shown || 0).toBe(0);
        expect(store.cards[0].injected).toBeUndefined();
    });

    // The gap that let three of these bugs through: every rule was tested as a
    // pure function, and nothing tested the ROUND TRIP those functions live in.
    // load() mutates, save() reconciles against the file — and reconcile was
    // quietly dropping what load() had just decided.
    describe('persistence round trip', () => {
        /** A store whose file contains `rows`, and which writes back to it. */
        const withDisk = (rows) => {
            let file = rows.map(r => JSON.stringify(r)).join('\n');
            const invoke = vi.fn(async (cmd, args) => {
                if (cmd === 'read_file') return file;
                if (cmd === 'write_file') { file = args.content; return null; }
                return null;
            });
            const store = new CardStore({ workspacePath: 'C:/ws', invoke });
            return { store, read: () => file.split('\n').filter(Boolean).map(l => JSON.parse(l)) };
        };

        it('persists a retirement decided during load', async () => {
            // consolidateCards retires advice that was shown three times and
            // failed every time. reconcile took the FILE's row first and never
            // copied `stale` off the in-memory one, so the decision evaporated
            // on the way back to disk — every run re-deciding and re-forgetting.
            const { store, read } = withDisk([
                { id: 'a', type: 'lesson', signature: 's', shown: 3, recurrences_after_hit: 3, stale: false },
            ]);
            await store.load();
            expect(store.cards[0].stale).toBe(true);
            await store.save();
            expect(read()[0].stale).toBe(true);
            expect(read()[0].retiredReason).toContain('recurred every time');
        });

        it('persists the merge of two spellings of one file', async () => {
            const loc = (target, hits) => ({
                id: 'x', type: 'insight', kind: 'locator', q: 'foo', target,
                what: `"foo" → ${target}`, hits, first_seen: '2026-08-01', last_recurrence: '2026-08-01',
            });
            const { store, read } = withDisk([loc('src/a.js', 2), loc('C:/ws/src/a.js', 3)]);
            await store.load();
            await store.save();
            expect(read()).toHaveLength(1);
            expect(read()[0].target).toBe('src/a.js');
            expect(read()[0].hits).toBe(5);
        });

        it('keeps a card the user switched off, even past the cap', async () => {
            // cardScore is 0 for a disabled card, so score-ordered culling put it
            // at the very bottom and deleted it first. The next occurrence then
            // re-minted the same card with disabled: false — silently undoing
            // "stop showing me this", which is the one defence against a bad
            // memory that the user actually controls.
            const rows = Array.from({ length: 12 }, (_, i) => ({
                id: `c${i}`, type: 'lesson', signature: `s${i}`, costSteps: 5, hits: 3,
                confidence: 0.8, last_recurrence: '2026-08-20',
            }));
            rows.push({ id: 'off', type: 'lesson', signature: 'off', costSteps: 9, hits: 9, confidence: 0.9, last_recurrence: '2026-08-20', disabled: true });
            const { store, read } = withDisk(rows);
            store.maxCards = 5;
            await store.load();
            await store.save();
            expect(read().some(c => c.id === 'off')).toBe(true);
            expect(read().filter(c => !c.disabled)).toHaveLength(5);
        });
    });

    it('is inert without a workspace', () => {
        const store = new CardStore({ invoke: vi.fn() });
        expect(store.enabled).toBe(false);
        expect(store.recallForTool('write_file', 'a.js')).toBeNull();
        expect(store.recallBrief()).toEqual([]);
    });
});

// Step 5b. Minting keeps the store correct per event; nothing kept it correct
// over time. The third rule is the one that matters: the store already records
// what it needs to judge its own advice, and until now nothing read it.
describe('consolidateCards', () => {
    const loc = (q, target, date) => ({
        id: `I-${q}-${target}`, type: 'insight', kind: 'locator', q, target,
        first_seen: date, last_recurrence: date,
    });

    it('retires a locator whose file MOVED, keeping the newest', () => {
        // Same term, same file name, different directory — that is a move.
        const cards = [
            loc('licenseState', 'src/old/license.js', '2026-01-01'),
            loc('licenseState', 'src/license.js', '2026-08-01'),
        ];
        const r = consolidateCards(cards);
        expect(r.stale).toBe(1);
        expect(cards[0].stale).toBe(true);
        expect(cards[1].stale).toBeFalsy();
    });

    // The first version of this rule retired 18 correct cards on the real store.
    // A symbol living in several files is the NORMAL case for a code search, and
    // every one of those answers is true.
    it('keeps every sighting when one term legitimately spans files', () => {
        const cards = [
            loc('finish_task', 'src/modules/ai/ToolExecutor.js', '2026-01-01'),
            loc('finish_task', 'src/modules/ai/AgentController.js', '2026-08-01'),
        ];
        expect(consolidateCards(cards).stale).toBe(0);
        expect(cards.every(c => !c.stale)).toBe(true);
    });

    it('leaves a locator alone when every sighting agrees', () => {
        const cards = [loc('x', 'a.js', '2026-01-01'), loc('x', 'a.js', '2026-08-01')];
        expect(consolidateCards(cards).stale).toBe(0);
    });

    // Two routes to a fix is not a contradiction, so neither is removed. But a
    // human should get to settle it, which requires being told it exists.
    it('flags two verified fixes for one failure without deleting either', () => {
        const mk = (id, fix) => ({ id, type: 'lesson', signature: 'write_file|edit_mismatch|.js', fix, verified: true });
        const cards = [mk('a', 'read_file → write_file'), mk('b', 'replace_lines')];
        expect(consolidateCards(cards).contested).toBe(2);
        expect(cards.every(c => c.contested)).toBe(true);
    });

    it('clears the flag once the disagreement is gone', () => {
        const cards = [{ id: 'a', type: 'lesson', signature: 's', fix: 'x', verified: true, contested: true }];
        consolidateCards(cards);
        expect(cards[0].contested).toBe(false);
    });

    it('retires advice that was shown repeatedly and never worked', () => {
        // The store measures its own advice. Keeping a warning that has been
        // tested three times and failed three times is the opposite of learning
        // — and it costs an injection slot a working card could use.
        const cards = [{ id: 'a', type: 'lesson', signature: 's', shown: 3, recurrences_after_hit: 3 }];
        const r = consolidateCards(cards);
        expect(r.retired).toBe(1);
        expect(cards[0].stale).toBe(true);
        expect(cards[0].retiredReason).toContain('recurred every time');
    });

    it('does not retire on too little evidence, or on advice that works', () => {
        const young = [{ id: 'a', type: 'lesson', signature: 's', shown: 2, recurrences_after_hit: 2 }];
        const working = [{ id: 'b', type: 'lesson', signature: 's', shown: 9, recurrences_after_hit: 1 }];
        expect(consolidateCards(young).retired).toBe(0);
        expect(consolidateCards(working).retired).toBe(0);
    });

    it('clears a stored fix that is only the failing tool again', () => {
        // Minting refuses these now; these are the rows written before that rule.
        // The card stays — the failure is worth knowing — but the empty
        // instruction stops competing for a brief slot.
        const cards = [{ type: 'lesson', signature: 's', trigger: { tool: 'grep_search' }, fix: 'grep_search', verified: true }];
        consolidateCards(cards);
        expect(cards[0].fix).toBeNull();
        expect(cards[0].verified).toBe(false);
        expect(cards).toHaveLength(1);
    });

    it('leaves a real recipe alone', () => {
        const cards = [{ type: 'lesson', signature: 's', trigger: { tool: 'write_file' }, fix: 'read_file → write_file', verified: true }];
        consolidateCards(cards);
        expect(cards[0].fix).toBe('read_file → write_file');
    });

    it('is idempotent — a second pass changes nothing', () => {
        const cards = [
            loc('q', 'a.js', '2026-01-01'), loc('q', 'b.js', '2026-08-01'),
            { id: 'x', type: 'lesson', signature: 's', shown: 5, recurrences_after_hit: 5 },
        ];
        consolidateCards(cards);
        expect(consolidateCards(cards)).toEqual({ stale: 0, contested: 0, retired: 0, merged: 0 });
    });

    it('survives junk', () => {
        expect(consolidateCards(null)).toEqual({ stale: 0, contested: 0, retired: 0, merged: 0 });
        expect(consolidateCards([{}, { kind: 'locator' }])).toEqual({ stale: 0, contested: 0, retired: 0, merged: 0 });
    });

    // Measured on the real store: 85 of 131 locator cards held an absolute path,
    // and 18 files existed under two or three spellings — each one eating a slot
    // in a three-slot brief, and each looking to the model like a different file.
    describe('one spelling per file', () => {
        const at = (target, over = {}) => ({
            id: 't', type: 'insight', kind: 'locator', q: 'foo', target,
            what: `"foo" → ${target}`, hits: 1, first_seen: '2026-08-01', last_recurrence: '2026-08-01', ...over,
        });

        it('rewrites absolute targets to workspace-relative', () => {
            const cards = [at('C:\\ws\\src\\a.js')];
            consolidateCards(cards, { root: 'C:/ws' });
            expect(cards[0].target).toBe('src/a.js');
            expect(cards[0].what).toBe('"foo" → src/a.js');
        });

        it('folds the spellings of one file into a single card, summing hits', () => {
            const cards = [
                at('src/a.js', { hits: 2, shown: 1 }),
                at('C:/ws/src/a.js', { hits: 3, shown: 2 }),
                at('C:\\ws\\src\\a.js', { hits: 1 }),
            ];
            const r = consolidateCards(cards, { root: 'C:/ws' });
            expect(r.merged).toBe(2);
            expect(cards).toHaveLength(1);
            expect(cards[0].hits).toBe(6);
            expect(cards[0].shown).toBe(3);
        });

        it('keeps a card switched off, however many rows merge into it', () => {
            const cards = [at('src/a.js'), at('C:/ws/src/a.js', { disabled: true })];
            consolidateCards(cards, { root: 'C:/ws' });
            expect(cards[0].disabled).toBe(true);
        });

        it('leaves paths alone with no workspace to make them relative to', () => {
            const cards = [at('C:/ws/src/a.js')];
            consolidateCards(cards);
            expect(cards[0].target).toBe('C:/ws/src/a.js');
        });

        // The disagreement rule and the dedupe rule share a key. Merging first
        // would pick one fix, drop the other, and erase the conflict.
        it('does NOT fold two cards that disagree about the fix', () => {
            const mk = (fix) => ({ type: 'lesson', signature: 's', fix, verified: true });
            const cards = [mk('read_file → write_file'), mk('replace_lines')];
            const r = consolidateCards(cards);
            expect(r.merged).toBe(0);
            expect(cards).toHaveLength(2);
            expect(r.contested).toBe(2);
        });

        it('adopts a fix from a duplicate that has one when the survivor does not', () => {
            const cards = [
                { type: 'lesson', signature: 's', fix: null },
                { type: 'lesson', signature: 's', fix: 'read_file → write_file' },
            ];
            consolidateCards(cards);
            expect(cards).toHaveLength(1);
            expect(cards[0].fix).toBe('read_file → write_file');
            expect(cards[0].verified).toBe(true);
        });
    });
});

// ── The Step 1 metric ────────────────────────────────────────────────────
// "Did the recurrence rate fall?" is the question the whole step is judged on,
// so what counts as a recurrence has to be exact.
describe('recurrence rate', () => {
    it('is null until the card has actually been shown', () => {
        expect(recurrenceRate({ hits: 5, recurrences_after_hit: 0 })).toBeNull();
    });

    it('is 0 when shown and the failure did not come back', () => {
        expect(recurrenceRate({ shown: 3, recurrences_after_hit: 0 })).toBe(0);
    });

    it('is 1 when it recurred every time it was shown', () => {
        expect(recurrenceRate({ shown: 2, recurrences_after_hit: 2 })).toBe(1);
    });

    it('counts a recurrence only when the card was shown IN THAT RUN', () => {
        // Otherwise a failure recurring in a session where the card never came up
        // is charged to the card, and the metric quietly reads worse than reality.
        const store = [{
            id: 'L-1', type: 'lesson', signature: 'write_file|edit_mismatch|.svelte',
            trigger: { tool: 'write_file', ext: '.svelte' }, hits: 1, costSteps: 5,
            confidence: 0.8, last_recurrence: '2026-08-11',
        }];
        const relearn = () => mergeCards(store, [{ ...store[0], hits: 1 }], '2026-08-12');

        relearn();                       // run A: never shown
        expect(store[0].recurrences_after_hit || 0).toBe(0);

        store[0].injected = true;        // run B: shown, and it happened anyway
        relearn();
        expect(store[0].recurrences_after_hit).toBe(1);
    });

    it('forgets the injected flag across sessions', async () => {
        // `injected` means "shown in THIS run". Persisting it would make every
        // later recurrence look like a card that failed despite a warning.
        const invoke = vi.fn(async (cmd) => (cmd === 'read_file'
            ? '{"id":"a","type":"lesson","signature":"s","trigger":{},"injected":true,"shown":2}'
            : null));
        const store = new CardStore({ workspacePath: 'C:/ws', invoke });
        await store.load();
        expect(store.cards[0].injected).toBeUndefined();
        expect(store.cards[0].shown).toBe(2);   // the persisted counterpart survives
    });

    it('counts each time a card is put in front of the agent', () => {
        const invoke = vi.fn(async () => null);
        const store = new CardStore({ workspacePath: 'C:/ws', invoke });
        store.cards = [{ id: 'a', type: 'lesson', signature: 's', trigger: { tool: 'write_file', ext: '.js' }, costSteps: 5, hits: 1, confidence: 0.8, last_recurrence: '2026-08-11' }];
        store.recallForTool('write_file', 'x.js');
        expect(store.cards[0].shown).toBe(1);
    });

    it('summarises which cards are earning their place', () => {
        const stats = recurrenceStats([
            { shown: 3, recurrences_after_hit: 0 },   // working
            { shown: 2, recurrences_after_hit: 2 },   // failing
            { hits: 1 },                              // never shown — not counted
        ]);
        expect(stats.shownCards).toBe(2);
        expect(stats.working).toBe(1);
        expect(stats.failing).toBe(1);
        expect(stats.meanRate).toBeCloseTo(0.5);
    });
});
