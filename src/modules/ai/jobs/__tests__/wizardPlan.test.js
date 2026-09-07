// The wizard's job is to produce two records that know about each other, and
// to do it in one pass. These tests pin the two things that were wrong before
// it existed:
//
//   • a watcher and a job created separately, joined by a hand-typed name;
//   • no route at all for work that just runs on a timer, because the whole
//     flow was built around "configure a watcher first".
import { describe, it, expect } from 'vitest';
import {
    CUSTOM_TIME, STEPS, startOptions, findOption, initialState, stepProblems, buildPlan,
    timeTemplates, applyTemplate,
} from '../wizardPlan.js';
import { normalizeRecipe, validateRecipe } from '../../triggers/recipes/recipeFormat.js';
import { BUILTIN_RECIPES } from '../../triggers/recipes/builtinRecipes.js';

const RECIPES = BUILTIN_RECIPES.map(r => normalizeRecipe({ ...r, builtin: true }, r.id));
const byId = (id) => RECIPES.find(r => r.id === id);

describe('every shipped recipe is loadable', () => {
    // A built-in that fails validation is silently dropped by the registry, so
    // the new `schedule` and `job` sections have to survive the same path a
    // user's file goes through.
    it('validates, including the clock-driven ones', () => {
        const bad = RECIPES.map(r => [r.id, validateRecipe(r)]).filter(([, p]) => p.length);
        expect(bad).toEqual([]);
    });

    it('a schedule recipe carries no engine and does carry work', () => {
        const r = byId('daily-report');
        expect(r.engine).toBe('');
        expect(r.schedule.time).toBe('09:00');
        expect(r.job.prompt).toContain('日報');
    });

    it('refuses a recipe that claims both a schedule and an engine', () => {
        const r = normalizeRecipe(
            { id: 'x', name: 'x', engine: 'http', schedule: {}, job: { prompt: 'p' } }, 'x');
        expect(validateRecipe(r)).toContain('schedule と engine は同時に指定できません。');
    });

    it('refuses a schedule recipe with nothing to do', () => {
        const r = normalizeRecipe({ id: 'x', name: 'x', schedule: {} }, 'x');
        expect(validateRecipe(r)).toContain('schedule のレシピには job.prompt が必要です。');
    });
});

describe('step 1 is one list, not two flows', () => {
    it('offers the clock and the watchers as groups of the same question', () => {
        const [time, watch] = startOptions(RECIPES);
        expect(time.group).toBe('time');
        expect(watch.group).toBe('watch');
        expect(time.items[0].id).toBe(CUSTOM_TIME);
    });

    it('asks the clock question ONCE, not once per cycle', () => {
        // Listing 毎朝 / 毎週 / 毎月 presets here read as "pick your cycle",
        // which is exactly what step 2 asks — and answering it in two places
        // is the double-entry this whole redesign exists to remove.
        const [time] = startOptions(RECIPES);
        expect(time.items).toHaveLength(1);
        expect(time.items.map(i => i.id)).not.toContain('daily-report');
    });

    it('puts the four engines above the presets that use them', () => {
        const watch = startOptions(RECIPES)[1];
        const firstPreset = watch.items.findIndex(i => !i.basic);
        const lastBasic = watch.items.map(i => i.basic).lastIndexOf(true);
        expect(lastBasic).toBeLessThan(firstPreset);
    });

    it('never lists a clock recipe as something to watch', () => {
        const watch = startOptions(RECIPES)[1];
        expect(watch.items.some(i => i.recipe.schedule)).toBe(false);
    });
});

describe('a preset arrives with both halves filled in', () => {
    it('brings its own prompt, so step 3 is a review and not a blank box', () => {
        const s = initialState(findOption(RECIPES, 'github-actions'));
        expect(s.driver).toBe('watch');
        expect(s.job.prompt).toContain('CI');
        expect(s.eventName).toBe('ci.failed');
        expect(s.watcherName).toBe('GitHub Actions が落ちた');
    });

    it('a clock preset is offered as ready-made WORK, on step 3', () => {
        // Where it belongs: it is a prompt with a suggested cycle, not a
        // different kind of trigger.
        expect(timeTemplates(RECIPES).map(r => r.id))
            .toEqual(['daily-report', 'weekly-review']);
    });

    it('applying one fills the work AND moves the cycle, visibly', () => {
        const base = initialState(findOption(RECIPES, CUSTOM_TIME));
        const s = applyTemplate(base, byId('weekly-review'));
        expect(s.job.prompt).toContain('今週');
        expect(s.job.purpose).not.toBe('');
        // The schedule moves too — which is why the UI says so rather than
        // changing a field the user set two steps back in silence.
        expect(s.schedule.time).toBe('17:00');
        expect(s.schedule.days).toEqual([5]);
        expect(s.templateId).toBe('weekly-review');
    });

    it('never offers a template that has no work in it', () => {
        expect(timeTemplates(RECIPES).every(r => r.job?.prompt)).toBe(true);
    });

    it('the free-form timer brings nothing but sane defaults', () => {
        const s = initialState(findOption(RECIPES, CUSTOM_TIME));
        expect(s.driver).toBe('time');
        expect(s.job.prompt).toBe('');
        expect(s.schedule.scheduleType).toBe('fixed');
    });
});

describe('a fixed-cycle job produces no watcher', () => {
    // THE question this design had to answer. A time-driven job is not a
    // watcher with the watching turned off; there is nothing to poll, and
    // saying so by returning null is what keeps the sources list honest.
    it('returns null for the watcher and a time trigger for the job', () => {
        const option = findOption(RECIPES, CUSTOM_TIME);
        const s = initialState(option);
        s.job = { ...s.job, name: '朝の準備', purpose: '毎朝の下ごしらえ', prompt: 'やる' };
        const plan = buildPlan(s, option, 1000);

        expect(plan.watcher).toBeNull();
        expect(plan.approve).toBeNull();
        expect(plan.job.triggers).toEqual([{
            kind: 'time', scheduleType: 'fixed', time: '09:00',
            // A STRING, matching DOM_OPTIONS: a select compares by identity,
            // so a number here rendered the monthly form with nothing chosen.
            days: [1, 2, 3, 4, 5], dayOfMonth: '1', intervalMinutes: 60, onceAt: '',
        }]);
    });

    it('a job built from a template records which one, for later', () => {
        const option = findOption(RECIPES, CUSTOM_TIME);
        const s = applyTemplate(initialState(option), byId('daily-report'));
        const plan = buildPlan(s, option, 1000);
        expect(plan.watcher).toBeNull();
        expect(plan.job.prompt).toContain('日報');
        expect(plan.job.triggers[0].kind).toBe('time');
        // Not `__time`: knowing a preset produced this is what lets the preset
        // be improved without guessing who is using it.
        expect(plan.job.createdFrom).toBe('daily-report');
    });
});

describe('a watch job comes out linked to its watcher', () => {
    it('by ID, so renaming the event breaks nothing', () => {
        const option = findOption(RECIPES, 'health-check');
        const s = initialState(option);
        s.values.url = 'https://example.com/healthz';
        s.watcherName = '本番の死活';
        const plan = buildPlan(s, option, 2000);

        expect(plan.watcher.id).toBe('wch_2000');
        expect(plan.job.triggers).toEqual([{ kind: 'watch', sourceId: 'wch_2000' }]);
        expect(plan.watcher.recipeId).toBe('health-check');
        expect(plan.watcher.type).toBe('http');
        expect(plan.watcher.values.url).toBe('https://example.com/healthz');
    });

    it('keeps the credential out of the record entirely', () => {
        const option = findOption(RECIPES, 'github-actions');
        const s = initialState(option);
        s.values.repo = 'owner/repo';
        s.values.token = 'should-never-be-here';   // even if something set it
        s.secrets.token = 'ghp_xxx';
        const plan = buildPlan(s, option, 3000);

        expect(plan.watcher.values).toEqual({ repo: 'owner/repo' });
        expect(JSON.stringify(plan)).not.toContain('ghp_xxx');
        expect(JSON.stringify(plan)).not.toContain('should-never-be-here');
    });

    it('hands the caller what to approve, for the config that will exist', () => {
        const option = findOption(RECIPES, 'health-check');
        const s = initialState(option);
        s.values.url = 'https://example.com/healthz';
        const plan = buildPlan(s, option, 4000);
        expect(plan.approve.watcherId).toBe(plan.watcher.id);
        expect(plan.approve.values).toEqual(plan.watcher.values);
    });
});

describe('nothing is live the moment it is created', () => {
    it('both records come out switched off', () => {
        const option = findOption(RECIPES, 'git-remote');
        const s = initialState(option);
        s.values.repo = 'C:/repo';
        const plan = buildPlan(s, option, 5000);
        expect(plan.watcher.enabled).toBe(false);
        expect(plan.job.enabled).toBe(false);
    });
});

describe('a step says what is missing before it lets you past', () => {
    it('will not start without a choice', () => {
        expect(stepProblems('start', { optionId: '' })).toHaveLength(1);
        expect(stepProblems('start', { optionId: CUSTOM_TIME })).toEqual([]);
    });

    it('asks a watch recipe for its required fields', () => {
        const option = findOption(RECIPES, 'health-check');
        const s = initialState(option);
        expect(stepProblems('setup', s, option).join()).toContain('ヘルス URL');
        s.values.url = 'https://x/y';
        expect(stepProblems('setup', s, option)).toEqual([]);
    });

    it('accepts a secret typed just now, before it has been stored', () => {
        const option = findOption(RECIPES, 'mail');
        const s = initialState(option);
        s.values = { ...s.values, host: 'imap.example.com', user: 'me' };
        const before = stepProblems('setup', s, option).length;
        s.secrets.password = 'typed';
        expect(stepProblems('setup', s, option).length).toBeLessThan(before);
    });

    it('does not demand a weekday list from a one-off or a monthly', () => {
        const s = { driver: 'time', schedule: { scheduleType: 'once', onceAt: '2026-09-10T09:00' } };
        expect(stepProblems('setup', s)).toEqual([]);
        const m = { driver: 'time', schedule: { scheduleType: 'monthly', time: '09:00', dayOfMonth: 1, days: [] } };
        expect(stepProblems('setup', m)).toEqual([]);
    });

    it('requires a purpose, because JobDetail will refuse to save without one', () => {
        const s = { job: { name: 'n', prompt: 'p', purpose: '' } };
        expect(stepProblems('work', s)).toEqual(['目的を1行書いてください。']);
    });

    it('reports every blank at once rather than one per round', () => {
        expect(stepProblems('work', { job: {} })).toHaveLength(3);
    });
});

describe('the flow itself', () => {
    it('is the same three steps whichever driver was chosen', () => {
        expect(STEPS).toEqual(['start', 'setup', 'work']);
    });
});
