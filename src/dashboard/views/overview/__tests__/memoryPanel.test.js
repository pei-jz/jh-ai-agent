// memoryPanel — the Dashboard memory tab's selection rules.
//
// The load-bearing decision here is which number leads: an OUTCOME
// (recurrenceRate — did the failure come back after the card was shown) rather
// than the card's own `confidence`. These tests pin the distinctions that make
// that number honest: a card nobody has seen is not a success, a disabled card
// is not knowledge, and the worst offender sorts to the top.

import { describe, it, expect } from 'vitest';
import {
    memoryLayers, memoryHealth, recentlyLearned, searchMemory,
    toggleCardDisabled, cardTime, FAILING_RATE,
} from '../memoryPanel.js';

/** `shown`/`recurrences_after_hit` are what recurrenceRate() divides. */
const card = (over = {}) => ({
    id: 'L-' + Math.random().toString(36).slice(2, 8),
    type: 'lesson',
    signature: 'write_file|edit_mismatch',
    trigger: { tool: 'write_file', ext: '.js' },
    symptom: 'old_text did not match',
    fix: 're-read the range first',
    hits: 1,
    costSteps: 4,
    confidence: 0.8,
    disabled: false,
    first_seen: '2026-08-01',
    last_recurrence: '2026-08-10',
    ...over,
});

const fact = (over = {}) => ({ fact: 'tests run with npx vitest run', type: 'semantic', hits: 3, date: '2026-08-01', ...over });

describe('memoryLayers', () => {
    it('counts facts and cards separately — they are different stores', () => {
        const l = memoryLayers({
            facts: [fact(), fact({ type: 'episodic' }), fact({ type: undefined })],
            cards: [card(), card({ type: 'insight' })],
            episodes: [{}, {}, {}],
        });
        // A fact with no type predates the layer split and reads as semantic.
        expect(l.durable).toBe(2);
        expect(l.episodic).toBe(1);
        expect(l.lessons).toBe(1);
        expect(l.insights).toBe(1);
        expect(l.episodes).toBe(3);
    });

    // A switched-off card is not knowledge the agent has — but hiding that it
    // exists would make the toggle feel like a delete.
    it('excludes disabled cards from the type counts but still reports them', () => {
        const l = memoryLayers({ cards: [card(), card({ disabled: true })] });
        expect(l.lessons).toBe(1);
        expect(l.disabled).toBe(1);
        expect(l.totalCards).toBe(2);
    });

    it('survives missing stores', () => {
        expect(memoryLayers().totalCards).toBe(0);
        expect(memoryLayers({ cards: 'nope' }).lessons).toBe(0);
    });
});

describe('memoryHealth', () => {
    const shown = (n, recurred) => card({ shown: n, recurrences_after_hit: recurred });

    it('counts a card whose failure stopped as held', () => {
        const h = memoryHealth([shown(5, 0)]);
        expect(h.held).toBe(1);
        expect(h.failing).toBe(0);
    });

    it('counts a card whose failure keeps coming back as failing', () => {
        const h = memoryHealth([shown(6, 4)]);
        expect(h.failing).toBe(1);
        expect(h.held).toBe(0);
    });

    it('puts the in-between cases in partial rather than rounding them either way', () => {
        const h = memoryHealth([shown(10, 2)]);
        expect(h.partial).toBe(1);
        expect(h.held + h.failing).toBe(0);
    });

    // A card minted yesterday and never surfaced is not evidence. Counting it
    // as held would inflate the one bar this panel exists to make honest.
    it('does not count a never-shown card as a success', () => {
        const h = memoryHealth([card()]);
        expect(h.shown).toBe(0);
        expect(h.held).toBe(0);
        expect(h.unproven).toBe(1);
        expect(h.total).toBe(1);
    });

    it('ignores disabled cards entirely', () => {
        const h = memoryHealth([shown(5, 5), card({ disabled: true, shown: 9, recurrences_after_hit: 9 })]);
        expect(h.total).toBe(1);
        expect(h.failing).toBe(1);
    });

    it('names the worst offenders first, with a readable summary', () => {
        const bad = shown(10, 9);
        const worse = shown(10, 10);
        const h = memoryHealth([bad, worse, shown(10, 0)]);
        expect(h.failingCards[0].rate).toBe(1);
        expect(h.failingCards[0].card.id).toBe(worse.id);
        expect(h.failingCards[0].headline).toBeTruthy();
    });

    it('caps the inline failing list', () => {
        const many = Array.from({ length: 9 }, () => shown(4, 4));
        expect(memoryHealth(many).failingCards.length).toBeLessThanOrEqual(3);
        expect(memoryHealth(many).failing).toBe(9);
    });

    it('treats exactly the threshold as failing', () => {
        expect(memoryHealth([shown(10, 10 * FAILING_RATE)]).failing).toBe(1);
    });
});

describe('recentlyLearned', () => {
    it('returns only cards newer than the mark, newest first', () => {
        const old = card({ first_seen: '2026-08-01', last_recurrence: '2026-08-01' });
        const mid = card({ first_seen: '2026-08-05', last_recurrence: '2026-08-05' });
        const fresh = card({ first_seen: '2026-08-09', last_recurrence: '2026-08-09' });
        const since = Date.parse('2026-08-03');
        const got = recentlyLearned([old, mid, fresh], since);
        expect(got.map(g => g.card.id)).toEqual([fresh.id, mid.id]);
    });

    it('uses the later of minted / seen-again', () => {
        expect(cardTime(card({ first_seen: '2026-08-01', last_recurrence: '2026-08-09' })))
            .toBe(Date.parse('2026-08-09'));
    });

    it('returns everything when nothing has been looked at yet', () => {
        expect(recentlyLearned([card(), card()], 0)).toHaveLength(2);
    });

    it('respects the limit', () => {
        const five = Array.from({ length: 5 }, (_, i) => card({ last_recurrence: `2026-08-0${i + 1}` }));
        expect(recentlyLearned(five, 0, 2)).toHaveLength(2);
    });
});

describe('searchMemory', () => {
    const store = {
        cards: [card({ symptom: 'edit_mismatch on svelte files', trigger: { tool: 'write_file', ext: '.svelte' } })],
        facts: [fact({ fact: 'release with npm run build' })],
    };

    it('finds a card by what it is about', () => {
        const hits = searchMemory(store, 'svelte');
        expect(hits).toHaveLength(1);
        expect(hits[0].kind).toBe('card');
    });

    it('finds a fact by its text', () => {
        const hits = searchMemory(store, 'npm run build');
        expect(hits[0].kind).toBe('fact');
    });

    it('matches the tool name a card triggers on', () => {
        expect(searchMemory(store, 'write_file')).toHaveLength(1);
    });

    it('is case-insensitive', () => {
        expect(searchMemory(store, 'SVELTE')).toHaveLength(1);
    });

    it('returns nothing for an empty query rather than everything', () => {
        expect(searchMemory(store, '   ')).toEqual([]);
    });

    it('survives a missing store', () => {
        expect(searchMemory(undefined, 'x')).toEqual([]);
    });
});

describe('toggleCardDisabled', () => {
    it('flips one card and leaves the rest alone', () => {
        const a = card({ id: 'L-a' });
        const b = card({ id: 'L-b' });
        const out = toggleCardDisabled([a, b], 'L-a', true);
        expect(out[0].disabled).toBe(true);
        expect(out[1].disabled).toBe(false);
    });

    // The store is written back whole; mutating in place would let a failed
    // write leave the UI showing a state the file does not have.
    it('does not mutate the input', () => {
        const a = card({ id: 'L-a' });
        toggleCardDisabled([a], 'L-a', true);
        expect(a.disabled).toBe(false);
    });

    it('is a no-op for an unknown id', () => {
        const a = card({ id: 'L-a' });
        expect(toggleCardDisabled([a], 'nope', true)[0].disabled).toBe(false);
    });
});
