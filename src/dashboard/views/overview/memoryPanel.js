// memoryPanel — what the Dashboard's Memory tab shows, as pure functions.
//
// The design question this file answers is "which number goes at the top". Kimi
// K3's proposal put a stated CONFIDENCE score there ("確信度 0.92"). Confidence
// exists on every card and it is a real field, but it is an INPUT to ranking —
// the agent's own estimate of itself. It cannot tell you a lesson is useless,
// because a useless lesson is just as confident as a good one.
//
// `recurrenceRate()` can. It is `recurrences_after_hit / shown`: of the times a
// card was shown to the agent, how often did the failure come back anyway. Zero
// means the fix held. That is an outcome, measured after the fact, and it is the
// only number here that can tell you to switch a card OFF — which is the whole
// reason a human looks at this panel.
//
// So the panel leads with "is it working", and confidence appears nowhere.

import { recurrenceRate, cardScore, HALF_LIFE_DAYS, cardSummary } from '../../../modules/ai/memory/CardStore.js';
import { factType } from '../../../modules/ai/memory/FactStore.js';

export { HALF_LIFE_DAYS };

/**
 * A card counts as "still recurring" at or above this rate. Half is a
 * deliberate choice rather than a hair-trigger: a lesson that fails once in
 * three is still earning its place, and flagging it would train you to ignore
 * the flag — the same failure mode as the old dashboard's permanent red panel.
 */
export const FAILING_RATE = 0.5;
/** Below this, the fix is holding. Between the two is "partial". */
export const HELD_RATE = 0.001;

/** How many freshly-learned cards the panel lists before deferring to Settings. */
export const RECENT_LIMIT = 4;
/** How many failing cards to name inline. */
export const FAILING_LIMIT = 3;

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Counts per memory layer, for the summary strip.
 *
 * Facts and cards are different stores with different lifecycles, so they are
 * counted separately rather than summed into one "memories" figure that would
 * mean nothing. Disabled cards are excluded from the type counts but reported —
 * a switched-off card is not knowledge the agent has, and hiding that it exists
 * would make the toggle feel like a delete.
 */
export function memoryLayers({ facts, episodes, cards } = {}) {
    const f = arr(facts);
    const c = arr(cards);
    const live = c.filter(x => !x.disabled);
    return {
        durable: f.filter(x => factType(x) === 'semantic').length,
        episodic: f.filter(x => factType(x) !== 'semantic').length,
        lessons: live.filter(x => x.type === 'lesson').length,
        insights: live.filter(x => x.type !== 'lesson').length,
        episodes: arr(episodes).length,
        disabled: c.filter(x => x.disabled).length,
        totalCards: c.length,
        totalFacts: f.length,
    };
}

/**
 * Did the memory work?
 *
 * Only cards that have actually been SHOWN can be judged — a card minted
 * yesterday and never surfaced is not evidence either way, so it sits in
 * `unproven` instead of quietly counting as a success and inflating the bar.
 *
 * @returns {{held:number, partial:number, failing:number, shown:number,
 *            unproven:number, total:number, failingCards:object[]}}
 */
export function memoryHealth(cards) {
    const live = arr(cards).filter(c => !c.disabled);
    const rated = [];
    let unproven = 0;
    for (const c of live) {
        const rate = recurrenceRate(c);
        if (rate === null) { unproven++; continue; }
        rated.push({ card: c, rate });
    }
    const held = rated.filter(r => r.rate <= HELD_RATE).length;
    const failing = rated.filter(r => r.rate >= FAILING_RATE);
    return {
        held,
        failing: failing.length,
        partial: rated.length - held - failing.length,
        shown: rated.length,
        unproven,
        total: live.length,
        // Worst first: the card most worth switching off leads the list.
        failingCards: failing
            .sort((a, b) => b.rate - a.rate)
            .slice(0, FAILING_LIMIT)
            .map(r => ({ card: r.card, rate: r.rate, ...cardSummary(r.card) })),
    };
}

/** ISO date/timestamp → epoch ms, or 0. Cards carry dates in both shapes. */
function at(v) {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? t : 0;
}

/** When a card last changed — minted, or seen again. */
export function cardTime(card) {
    return Math.max(at(card?.last_recurrence), at(card?.first_seen));
}

/**
 * Cards learned since `sinceMs`, newest first.
 *
 * "New" is relative to the last time the panel was OPENED, not to a fixed
 * window: the point of the badge is "there is something here you have not
 * judged yet", and a 24-hour window would either nag about cards you already
 * dismissed or hide ones from a week you were away.
 */
export function recentlyLearned(cards, sinceMs = 0, limit = RECENT_LIMIT) {
    return arr(cards)
        .map(c => ({ card: c, t: cardTime(c) }))
        .filter(x => x.t > sinceMs)
        .sort((a, b) => b.t - a.t)
        .slice(0, limit)
        .map(x => ({ card: x.card, at: x.t, ...cardSummary(x.card) }));
}

/**
 * Free-text search across cards and facts.
 *
 * Substring, case-insensitive, over the fields a person would actually type at:
 * the rendered summary, the signature, and the trigger. Not the ranking score —
 * search is for "where did I see that", and burying an exact text match under a
 * high-scoring near-miss is how a search box loses trust.
 */
export function searchMemory({ cards, facts } = {}, query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];

    for (const c of arr(cards)) {
        const s = cardSummary(c);
        const hay = [s.headline, s.detail, c.signature, c.trigger?.tool, c.trigger?.ext]
            .filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(q)) {
            out.push({ kind: 'card', card: c, ...s, score: cardScore(c) });
        }
    }
    for (const f of arr(facts)) {
        const text = String(f?.fact || '');
        if (text.toLowerCase().includes(q)) {
            out.push({
                kind: 'fact', fact: f, badge: factType(f),
                headline: text, detail: `${f.hits || 1}× · ${f.date || ''}`,
                score: 0,
            });
        }
    }
    // Cards before facts within equal relevance: a card carries a fix, a fact
    // carries a statement, and the fix is the more useful hit.
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Flip one card's `disabled` flag, by id. Returns a NEW array. */
export function toggleCardDisabled(cards, id, disabled) {
    return arr(cards).map(c => (c.id === id ? { ...c, disabled: !!disabled } : c));
}
