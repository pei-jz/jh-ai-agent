// The two STRUCTURED events the Dashboard's Run tab is drawn from.
//
// Both replaced something that could have been scraped out of a status string
// instead — "🧭 計画 / plan へ — モデル切替: X → Y" and "🧠 <card text>". Parsing
// those back would have broken the first time anyone reworded a message, and
// the card id (which the memory panel needs to line the entry up with its
// toggle) was never in the string at all.
//
// So these run the REAL loop and assert the events come out with the fields the
// Dashboard indexes on. A rename on either side fails here rather than showing
// an empty phase rail in production.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeHarness, toolStep, finishStep } from './agentHarness.js';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

const FAST = 'i1:flash';
const DEEP = 'i2:kimi';
const REPORT = '結論: '.padEnd(500, '詳細');
const COMPLEX = 'Refactor the authentication module across all services, '
    + 'update every caller, add tests, and migrate the config schema.';

const routed = (over = {}) => ({
    fast_model_id: FAST, deep_model_id: DEEP, phase_routing: 'on', plan_mode: 'off', ...over,
});

const events = (h, name) => h.events.filter(e => e.event === name);

describe('the phase event', () => {
    it('announces the OPENING phase, not only the switches', async () => {
        // Without this the rail would not know which phase a run is in until
        // the first transition — i.e. it would be blank for the whole plan.
        const h = makeHarness({
            caller: 'NewTask', config: routed(),
            script: [toolStep('task_progress', { action: 'set', items: ['a'] }), finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        const first = events(h, 'phase')[0];
        expect(first.phase).toBe('plan');
        expect(first.model).toBe(DEEP);
        expect(first.from).toBeNull();
    });

    it('carries the phase, the model and where it came from on each switch', async () => {
        const h = makeHarness({
            caller: 'NewTask', config: routed(),
            script: [toolStep('task_progress', { action: 'set', items: ['a'] }), finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        const phases = events(h, 'phase');
        const exec = phases.find(p => p.phase === 'execute');
        expect(exec.model).toBe(FAST);
        expect(exec.from).toBe(DEEP);
        const review = phases.find(p => p.phase === 'review');
        expect(review.model).toBe(DEEP);
    });

    it('carries the per-phase token split the rail prices with', async () => {
        const h = makeHarness({
            caller: 'NewTask', config: routed(),
            script: [toolStep('task_progress', { action: 'set', items: ['a'] }), finishStep(REPORT)],
        });
        await h.run(COMPLEX);
        const exec = events(h, 'phase').find(p => p.phase === 'execute');
        expect(exec.tokens.plan).toBeGreaterThan(0);
    });

    it('says nothing at all when phase routing is off', async () => {
        const h = makeHarness({ caller: 'NewTask', script: [finishStep(REPORT)] });
        await h.run(COMPLEX);
        expect(events(h, 'phase')).toHaveLength(0);
    });
});

describe('the memory_recall event', () => {
    /** A cards.jsonl the fake workspace will serve. */
    const CARDS = [
        {
            id: 'I-1', type: 'insight', signature: 'multi_replace|.js',
            trigger: { tool: 'read_file', ext: '.js' },
            what: 'read then grep then replace',
            hits: 5, costSteps: 4, confidence: 0.9, disabled: false,
            first_seen: '2026-08-01', last_recurrence: '2026-08-11',
        },
    ];

    const withCards = (over = {}) => makeHarness({
        caller: 'NewTask',
        config: { memory_recall: 'on', plan_mode: 'off' },
        invokeResults: {
            read_file: (args) => (String(args?.path || '').endsWith('cards.jsonl')
                ? CARDS.map(c => JSON.stringify(c)).join('\n')
                : ''),
        },
        script: [toolStep('read_file', { path: 'a.js' }), finishStep(REPORT)],
        ...over,
    });

    it('names the card, with the id the memory panel toggles on', async () => {
        const h = withCards();
        await h.run('fix the parser');
        const recalls = events(h, 'memory_recall');
        expect(recalls.length).toBeGreaterThan(0);
        const all = recalls.flatMap(r => r.cards);
        expect(all.some(c => c.id === 'I-1')).toBe(true);
        // A headline a person can read — not the prompt text sent to the model.
        expect(all[0].headline).toBeTruthy();
    });

    it('distinguishes the opening brief from a mid-run nudge', async () => {
        const h = withCards();
        await h.run('fix the parser');
        const sources = new Set(events(h, 'memory_recall').map(r => r.source));
        expect([...sources].every(s => s === 'brief' || s === 'tool')).toBe(true);
        expect(sources.size).toBeGreaterThan(0);
    });

    it('records the step it fired at, so a card can be paired with what happened next', async () => {
        const h = withCards();
        await h.run('fix the parser');
        expect(events(h, 'memory_recall')[0].at).toBeGreaterThanOrEqual(1);
    });

    it('stays silent when recall is switched off', async () => {
        const h = withCards({ config: { memory_recall: 'off', plan_mode: 'off' } });
        await h.run('fix the parser');
        expect(events(h, 'memory_recall')).toHaveLength(0);
    });

    it('stays silent when the workspace has learned nothing', async () => {
        const h = makeHarness({
            caller: 'NewTask', config: { memory_recall: 'on', plan_mode: 'off' },
            script: [toolStep('read_file', { path: 'a.js' }), finishStep(REPORT)],
        });
        await h.run('fix the parser');
        expect(events(h, 'memory_recall')).toHaveLength(0);
    });
});
