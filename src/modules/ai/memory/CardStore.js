// CardStore — what the agent learned from a session, and how it is recalled.
//
// Step 1 of docs/design/agent-memory-learning.plan.md, widened on request to
// cover BOTH polarities of experience:
//
//   lesson   a failure that cost something          "this went wrong here before"
//   insight  something that verifiably WORKED       "this is how it was done / where it lives"
//
// They share one store, one decay model and one recall path on purpose. A memory
// that only holds failures makes a timid agent; one that only holds successes
// makes an overconfident one. The shape is symmetric so neither side is special.
//
// Everything minted here is DERIVED FROM WHAT ACTUALLY HAPPENED — no LLM writes
// these. A lesson's `fix` is the recipe that was observed to resolve the failure;
// an insight is a sequence or a location the agent actually used successfully.
// That is the review's A1 ("record verified actions, not the model's post-hoc
// story") applied to both directions: nothing enters the store on a guess.
//
// Free-form "what I newly understood" from the session summary still goes to
// facts.json for now; Step 3 unifies the two rather than duplicating them here.

import { extOf, fingerprint } from './FailureSignature.js';
// The same unit-overlap scorer the fact store recalls with (latin words + CJK
// bigrams), so "which card is about THIS task" is judged one way across memory.
import { relevanceScore } from './MemoryScoring.js';

/** Injected text is a budget item, not a document. */
export const CARD_MAX_CHARS = 240;
/** Same half-life as FactStore.retentionScore — one decay model for all memory. */
export const HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;
/** A recovery is only a "recipe" if something actually happened in between. */
const MIN_RECOVERY_STEPS = 2;
/** How far after a search a use of its result still counts as "found via". */
const LOCATOR_WINDOW = 3;

const READ_OR_EDIT = /^(read_file|read_office|write_file|multi_replace_file_content|replace_lines|verify_syntax)$/;

// ── Minting ────────────────────────────────────────────────────────────────

/** Tool names, in order, of the successful calls that resolved a failure. */
function recoveryRecipe(events, row) {
    if (row.resolvedAt === null) return [];
    const seq = [];
    for (const e of events) {
        if (!e.ok || e.i <= row.first || e.i > row.resolvedAt) continue;
        if (seq[seq.length - 1] !== e.tool) seq.push(e.tool);
    }
    return seq;
}

/**
 * Is this search term worth remembering as "where X lives"?
 *
 * Observed in real runs: most searches are throwaway REGEXES, e.g.
 * `path\.endsWith\('\.md'\)|\.md'|markdown|isMd`. Storing those produced cards
 * that could never match a future task — the query is a one-off construction,
 * not a name anyone would search for again — while costing an injection slot on
 * every later search. Only NAMES generalise, so only names are kept.
 */
export function isDurableQuery(q) {
    const s = String(q || '').trim();
    if (s.length < 3 || s.length > 60) return false;
    // Regex/glob machinery: escapes, alternation, character classes, anchors,
    // quantifiers, wildcards. Any of these means it was built for one search.
    if (/[\\|[\]()*+?^${}]/.test(s)) return false;
    // A name, a dotted path, or a short phrase. Nothing else.
    return /^[\w.\-\/ ]+$/.test(s);
}

/**
 * Locator insights: a successful repo search whose result the agent then used.
 * "Used" is the verification — a search nobody acted on found nothing useful.
 */
function mintLocators(events, meta) {
    const out = [];
    const seen = new Set();
    for (const s of events) {
        if (!s.ok || !s.q || !isDurableQuery(s.q)) continue;
        const use = events.find(e => e.ok && e.i > s.i && e.i <= s.i + LOCATOR_WINDOW
            && READ_OR_EDIT.test(e.tool) && e.target);
        if (!use) continue;
        const key = `${s.q}|${use.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(baseCard({
            type: 'insight', kind: 'locator',
            signature: `locator|${extOf(use.target) || '-'}`,
            trigger: { tool: s.tool, ext: extOf(use.target), scope: 'workspace' },
            q: s.q, target: use.target,
            what: `"${s.q}" → ${use.target}`,
            confidence: 0.7,
        }, meta));
    }
    return out;
}

function baseCard(fields, { sessionId, date }) {
    const card = {
        id: '',
        hits: 1,
        recurrences_after_hit: 0,
        first_seen: date,
        last_recurrence: date,
        stale: false,
        disabled: false,
        evidence: sessionId ? [`session:${sessionId}`] : [],
        ...fields,
    };
    card.id = `${card.type === 'lesson' ? 'L' : 'I'}-${fingerprint(cardKey(card))}`;
    return card;
}

/**
 * Identity of a card. Two cards with the same key are the same piece of
 * knowledge learned twice — that bumps a hit count instead of adding a row.
 */
export function cardKey(card) {
    if (!card) return '';
    if (card.kind === 'locator') return `insight|locator|${card.q}|${card.target}`;
    // A card with no signature has no derivable identity; fall back to its id so
    // malformed rows stay DISTINCT. Collapsing them would silently delete cards
    // during reconcile — the opposite of what a memory store is for.
    if (!card.signature) return `id|${card.id || ''}`;
    return `${card.type}|${card.kind || '-'}|${card.signature}|${card.trigger?.ext || '-'}`;
}

/**
 * Turn one session's trace into cards. Pure.
 *
 * @param {{rows: Array, events: Array, sessionId?: string, date?: string}} input
 *   rows   — TraceRecorder.summarizeFailures() output
 *   events — the raw trace events
 * @returns {Array} cards (lessons and insights)
 */
export function mintCards({ rows = [], events = [], sessionId = '', date = '' } = {}) {
    const meta = { sessionId, date: date || new Date().toISOString().split('T')[0] };
    const cards = [];

    for (const row of rows) {
        // A refusal is the user's decision, not a defect: learning a "fix" for it
        // would teach the agent to work around its own user.
        if (row.denied || row.kind === 'permission_denied') continue;

        const recipe = recoveryRecipe(events, row);
        const ext = extOf(row.target);

        cards.push(baseCard({
            type: 'lesson',
            signature: row.signature,
            trigger: { tool: row.tool, ext, argShape: row.argShape || '', scope: 'workspace' },
            symptom: row.message || row.kind,
            loc: row.loc || '',
            // Observed, not inferred. Null when the failure was never resolved —
            // an honest "no known fix" beats a plausible invention.
            fix: recipe.length ? recipe.join(' → ') : null,
            verified: recipe.length > 0,
            hypothesis: null,
            root_cause: null,
            costSteps: row.costSteps,
            attempts: row.attempts,
            confidence: row.unresolved ? 0.5 : 0.8,
        }, meta));

        // The positive half of the same event: what actually got it working.
        if (recipe.length >= MIN_RECOVERY_STEPS) {
            cards.push(baseCard({
                type: 'insight', kind: 'recovery',
                signature: `${row.tool}|recovery|${ext || '-'}`,
                trigger: { tool: row.tool, ext, scope: 'workspace' },
                what: recipe.join(' → '),
                costSteps: row.costSteps,
                confidence: 0.8,
            }, meta));
        }
    }

    cards.push(...mintLocators(events, meta));
    return cards;
}

// ── Merging, decay, selection ──────────────────────────────────────────────

/**
 * Fold newly minted cards into the store (mutated in place).
 *
 * A re-learned lesson means the failure HAPPENED AGAIN, which is the signal the
 * card is not working: `recurrences_after_hit` counts the times it recurred
 * after having been injected, and that is what §6.3 of the design measures.
 */
export function mergeCards(store, incoming, date = new Date().toISOString().split('T')[0]) {
    if (!Array.isArray(store) || !Array.isArray(incoming)) return store;
    const byKey = new Map(store.map(c => [cardKey(c), c]));
    for (const card of incoming) {
        const existing = byKey.get(cardKey(card));
        if (!existing) {
            store.push(card);
            byKey.set(cardKey(card), card);
            continue;
        }
        existing.hits = (existing.hits || 1) + 1;
        existing.last_recurrence = date;
        existing.stale = false;
        // Counted only when the card was surfaced IN THIS RUN (`injected` is a
        // per-run flag, stripped on load). "We warned it and it happened anyway"
        // is the measurement; "it happened again in a run where the card never
        // came up" is not the card's failure and must not be charged to it.
        if (existing.injected) existing.recurrences_after_hit = (existing.recurrences_after_hit || 0) + 1;
        // An unverified card learns its fix the first time one is observed.
        if (!existing.fix && card.fix) { existing.fix = card.fix; existing.verified = true; }
        if (card.costSteps > (existing.costSteps || 0)) existing.costSteps = card.costSteps;
        // Cards can arrive hand-edited from the Memory tab, or from an older
        // file version, so no field may be assumed present.
        if (!Array.isArray(existing.evidence)) existing.evidence = [];
        for (const ev of card.evidence || []) {
            if (!existing.evidence.includes(ev)) existing.evidence.push(ev);
        }
        if (existing.evidence.length > 10) existing.evidence = existing.evidence.slice(-10);
    }
    return store;
}

/**
 * Reconcile two versions of the same store (in-memory vs what is on disk now).
 *
 * Needed because a subagent — and any concurrently running task in the same
 * workspace — writes the same file. A plain overwrite at session end would drop
 * whatever the other run learned. Unlike `mergeCards` this does NOT bump hit
 * counts: the same card seen twice here is one card written twice, not a fact
 * learned twice.
 *
 * @returns a NEW array; neither input is mutated.
 */
export function reconcile(mine, theirs) {
    const out = new Map();
    for (const c of [...(theirs || []), ...(mine || [])]) {
        if (!c) continue;
        const key = cardKey(c);
        const prev = out.get(key);
        if (!prev) { out.set(key, { ...c }); continue; }
        const merged = { ...prev };
        merged.hits = Math.max(prev.hits || 1, c.hits || 1);
        merged.costSteps = Math.max(prev.costSteps || 0, c.costSteps || 0);
        merged.shown = Math.max(prev.shown || 0, c.shown || 0);
        merged.recurrences_after_hit = Math.max(prev.recurrences_after_hit || 0, c.recurrences_after_hit || 0);
        if ((c.last_recurrence || '') > (prev.last_recurrence || '')) merged.last_recurrence = c.last_recurrence;
        if ((c.first_seen || '9999') < (prev.first_seen || '9999')) merged.first_seen = c.first_seen;
        if (!merged.fix && c.fix) merged.fix = c.fix;
        // An observed fix is what "verified" means — whichever copy carried it.
        if (merged.fix) merged.verified = true;
        // A card switched off by the user stays off, whichever side says so.
        merged.disabled = !!(prev.disabled || c.disabled);
        merged.evidence = [...new Set([...(prev.evidence || []), ...(c.evidence || [])])].slice(-10);
        out.set(key, merged);
    }
    return [...out.values()];
}

/**
 * Ranking score: how much it cost × how often × confidence, decayed by how long
 * since it last mattered. A lesson for a failure that stopped happening fades
 * out on its own — the review's A2, and the reason a fixed bug does not warn
 * forever.
 */
export function cardScore(card, now = Date.now()) {
    if (!card || card.disabled || card.stale) return 0;
    const last = Date.parse(card.last_recurrence || card.first_seen || '') || now;
    const ageDays = Math.max(0, (now - last) / DAY_MS);
    const weight = Math.max(1, card.costSteps || 1) * (card.hits || 1) * (card.confidence ?? 0.5);
    return weight * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

const eligible = (c, exclude) => cardScore(c) > 0 && !exclude.has(c.id);

/**
 * The card to surface for a tool the agent is about to run. One at most: the
 * point is a nudge at the moment of action, not a briefing.
 */
export function selectForTool(store, { tool, ext } = {}, { now = Date.now(), exclude = new Set() } = {}) {
    if (!Array.isArray(store)) return null;
    const matches = store.filter(c => eligible(c, exclude)
        && c.trigger?.tool === tool
        // No ext on the card ⇒ tool-wide. Ext on both ⇒ must agree, so a lesson
        // about .svelte edits is not replayed at a .rs edit.
        && (!c.trigger.ext || !ext || c.trigger.ext === ext));
    if (matches.length === 0) return null;
    matches.sort((a, b) => cardScore(b, now) - cardScore(a, now));
    return matches[0];
}

/**
 * The opening brief: what this workspace has already taught the agent. Mixed on
 * purpose — a lesson and the insight that resolved it are both useful up front.
 */
export function selectBrief(store, { limit = 3, now = Date.now(), exclude = new Set() } = {}) {
    if (!Array.isArray(store)) return [];
    return store
        .filter(c => eligible(c, exclude))
        .sort((a, b) => cardScore(b, now) - cardScore(a, now))
        .slice(0, limit);
}

/**
 * How many of each kind the opening brief may carry.
 *
 * Separate budgets, NOT one ranked list — that is the whole point. `cardScore`
 * is led by `costSteps`, which measures how much a failure HURT, not how much
 * it matters: "run npm test before committing" costs 0 steps and outranks
 * nothing, while a 7-step anchor mismatch outranks everything. Ranked together,
 * the painful trivia always evicts the project's actual rules.
 *
 * Lessons get a small allowance rather than none: they still have a place up
 * front, but they cannot take the whole brief, and the ones that matter for THIS
 * call arrive through the trigger hook at the moment they apply.
 */
export const BRIEF_BUDGET = { insight: 2, lesson: 1 };

/** The text of a card, for matching it against what the task is about. */
export function cardText(card) {
    const s = cardSummary(card);
    return `${s.headline} ${s.detail}`.trim();
}

/**
 * The opening brief, filled per KIND against its own budget.
 *
 * Within a kind, a `query` (the task prompt) ranks by relevance first — an
 * insight about the area being worked on beats a higher-scoring one from an
 * unrelated corner of the project. Without a query it falls back to score
 * alone, which is the old behaviour.
 */
export function selectBriefBudgeted(store, {
    budgets = BRIEF_BUDGET, query = '', now = Date.now(), exclude = new Set(),
} = {}) {
    if (!Array.isArray(store)) return [];
    const picked = [];
    for (const [kind, budget] of Object.entries(budgets)) {
        if (!budget) continue;
        const pool = store.filter(c => eligible(c, exclude) && c.type === kind && !picked.includes(c));
        pool.sort((a, b) => {
            if (query) {
                const ra = relevanceScore({ summary: cardText(a) }, query);
                const rb = relevanceScore({ summary: cardText(b) }, query);
                if (rb !== ra) return rb - ra;
            }
            return cardScore(b, now) - cardScore(a, now);
        });
        picked.push(...pool.slice(0, budget));
    }
    return picked;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/**
 * The injected line. Phrased as an instruction to DO something (review item
 * A12) — "read the file first" rather than "don't use a stale anchor", because
 * a negation makes the model attend to the thing it should avoid.
 */
export function renderCard(card) {
    if (!card) return '';
    let text;
    if (card.type === 'lesson') {
        const where = card.loc ? ` (${card.loc})` : '';
        text = card.fix
            ? `[Memory — cost ${card.costSteps} steps here before] ${card.trigger?.tool} hit "${card.symptom}"${where}. What worked: ${card.fix}. Do that first.`
            : `[Memory — cost ${card.costSteps} steps here before] ${card.trigger?.tool} hit "${card.symptom}"${where}. No verified fix yet — check the current state before acting.`;
    } else if (card.kind === 'locator') {
        text = `[Memory — where things are] "${card.q}" was found in ${card.target}. Look there first.`;
    } else {
        text = `[Memory — what worked] For ${card.trigger?.tool}${card.trigger?.ext ? ` on ${card.trigger.ext}` : ''}: ${card.what}. Reuse that order.`;
    }
    return text.length > CARD_MAX_CHARS ? text.substring(0, CARD_MAX_CHARS - 1) + '…' : text;
}

/**
 * Recurrence rate: of the runs where this card WAS put in front of the agent,
 * the share where the same failure happened anyway.
 *
 *   0    the card is working — shown, and the failure did not come back
 *   1    the card is useless — shown every time, and it recurred every time
 *   null not shown yet, so there is nothing to judge
 *
 * This is the number Step 1 lives or dies by (plan §4). A high rate does not
 * mean "learn harder"; it means the `fix` is wrong or the signature is too
 * coarse, and the honest response is to correct those rather than to add more
 * memory on top.
 */
export function recurrenceRate(card) {
    const shown = card?.shown || 0;
    if (!shown) return null;
    return Math.min(1, (card.recurrences_after_hit || 0) / shown);
}

/**
 * Fleet-level view of the same question: how many cards are actually earning
 * their place. Returns counts plus the mean rate over cards that have been shown.
 */
export function recurrenceStats(store) {
    const rated = (Array.isArray(store) ? store : [])
        .map(c => ({ card: c, rate: recurrenceRate(c) }))
        .filter(r => r.rate !== null);
    const total = rated.reduce((s, r) => s + r.rate, 0);
    return {
        shownCards: rated.length,
        meanRate: rated.length ? total / rated.length : null,
        working: rated.filter(r => r.rate === 0).length,
        failing: rated.filter(r => r.rate >= 0.5).length,
    };
}

/**
 * The same card, for a HUMAN reading the Memory tab. Separate from `renderCard`
 * on purpose: that one is prompt text aimed at the model (and is charged to the
 * token budget), this one is a table row. One shared formatter would end up
 * serving neither.
 * @returns {{badge:string, headline:string, detail:string}}
 */
export function cardSummary(card) {
    if (!card) return { badge: '', headline: '', detail: '' };
    const where = [card.trigger?.tool, card.trigger?.ext].filter(Boolean).join(' · ');
    if (card.type === 'lesson') {
        return {
            badge: 'lesson',
            headline: `${where} — ${card.symptom || card.signature || ''}`,
            detail: card.fix ? `Verified fix: ${card.fix}` : 'No verified fix yet',
        };
    }
    if (card.kind === 'locator') {
        return { badge: 'where', headline: `"${card.q}"`, detail: `Found in: ${card.target}` };
    }
    return { badge: 'insight', headline: where, detail: `Sequence: ${card.what || ''}` };
}

/**
 * One line naming what a batch of freshly minted cards actually contains, for
 * the status feed. "7 件" on its own tells the user nothing they can act on.
 */
export function summarizeMinted(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (list.length === 0) return '';
    const counts = new Map();
    for (const c of list) {
        const badge = cardSummary(c).badge;
        counts.set(badge, (counts.get(badge) || 0) + 1);
    }
    const kinds = [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    // Name the most expensive one: that is the card most likely to matter, and
    // seeing it is how a wrong lesson gets noticed and switched off.
    const top = [...list].sort((a, b) => (b.costSteps || 0) - (a.costSteps || 0))[0];
    const headline = cardSummary(top).headline;
    return `${kinds}${headline ? ` · ${headline.substring(0, 60)}` : ''}`;
}

/** The opening brief as one message body, or '' when there is nothing to say. */
export function renderBrief(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return '';
    return '[Memory from earlier sessions in this workspace]\n'
        + cards.map(c => `- ${renderCard(c)}`).join('\n')
        + '\nUse these where they apply; ignore any that do not fit this task.';
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * `<workspace>/.agent/memory/cards.jsonl`, one card per line.
 *
 * JSON Lines rather than SQLite by review decision (A3): the project has no
 * sqlite dependency, and this store is a few hundred rows. The migration
 * trigger is written down in the plan, not left to taste.
 */
export class CardStore {
    /**
     * @param {{workspacePath?:string, invoke?:Function, maxCards?:number, maxPerRun?:number}} opts
     *   maxPerRun — hard cap on cards surfaced in one run. Observed in a real
     *   session: a long run collected a memory line at nearly every search, and
     *   advice at that density stops being read. The cap is on the number
     *   SURFACED, not on what is learned.
     */
    constructor({ workspacePath, invoke, maxCards = 300, maxPerRun = 6 } = {}) {
        this.workspacePath = workspacePath || '';
        this._invoke = invoke;
        this.maxCards = maxCards;
        this.maxPerRun = maxPerRun;
        this.cards = [];
        this.enabled = !!(this.workspacePath && typeof invoke === 'function');
        /** Ids surfaced this session — never the same card twice in one run. */
        this.injected = new Set();
    }

    get path() { return `${this.workspacePath}/.agent/memory/cards.jsonl`; }

    /** Parse the file. A missing or corrupt file reads as empty. */
    async _read() {
        try {
            const raw = await this._invoke('read_file', { path: this.path });
            return String(raw || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean);
        } catch (_) {
            return [];
        }
    }

    /**
     * Best-effort load; a missing or corrupt file yields an empty store.
     *
     * `injected` is stripped: it means "surfaced in THIS run", and leaving a
     * previous run's flag in place would charge every later recurrence to a card
     * that was never shown — quietly inflating the one number Step 1 is judged
     * on. The persisted counterpart is `shown`.
     */
    async load() {
        if (!this.enabled) return this.cards;
        this.cards = (await this._read()).map(({ injected, ...card }) => card);
        return this.cards;
    }

    /**
     * Re-read, reconcile, prune to `maxCards` by score, then write. Never throws.
     *
     * The re-read is not paranoia: subagents run their own controller against the
     * same workspace, and the app runs several tasks at once — without it, the
     * last session to finish silently erases what the others learned.
     */
    async save() {
        if (!this.enabled) return false;
        try {
            this.cards = reconcile(this.cards, await this._read());
            if (this.cards.length > this.maxCards) {
                this.cards.sort((a, b) => cardScore(b) - cardScore(a));
                this.cards.length = this.maxCards;
            }
            try { await this._invoke('create_dir', { path: `${this.workspacePath}/.agent/memory` }); } catch (_) { /* exists */ }
            await this._invoke('write_file', {
                path: this.path,
                content: this.cards.map(c => JSON.stringify(c)).join('\n') + '\n',
            });
            return true;
        } catch (e) {
            console.warn('CardStore: could not write cards:', e);
            return false;
        }
    }

    /** Fold a session's trace in. Returns the cards that were minted. */
    learn({ rows, events, sessionId, date }) {
        const minted = mintCards({ rows, events, sessionId, date });
        mergeCards(this.cards, minted, date);
        return minted;
    }

    /**
     * Recall for a call about to run. Marks the card injected so it is not
     * repeated, and so a later recurrence counts against it.
     */
    recallForTool(tool, target) {
        if (!this.enabled || this.cards.length === 0) return null;
        if (this.injected.size >= this.maxPerRun) return null;
        const card = selectForTool(this.cards, { tool, ext: extOf(target) }, { exclude: this.injected });
        if (!card) return null;
        this._markShown(card);
        return card;
    }

    /**
     * `shown` is the denominator of the recurrence rate (how often a card was
     * put in front of the agent); `injected` is the per-run flag that decides
     * whether a recurrence at the end of this run counts against it.
     */
    _markShown(card) {
        this.injected.add(card.id);
        card.injected = true;
        card.shown = (card.shown || 0) + 1;
    }

    /**
     * Recall for the start of a run.
     *
     * `query` is the task prompt: within each kind's budget, what the task is
     * about outranks what merely scored high. Pass nothing and it degrades to
     * pure score, which is what it did before budgets existed.
     */
    recallBrief(query = '', budgets = BRIEF_BUDGET) {
        if (!this.enabled || this.cards.length === 0) return [];
        const picked = selectBriefBudgeted(this.cards, { budgets, query, exclude: this.injected });
        for (const c of picked) this._markShown(c);
        return picked;
    }
}
