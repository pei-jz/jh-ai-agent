// wizardPlan — "what starts it, then what it does", in that order.
//
// The setup flow this backs exists because the two halves of an automation were
// never introduced to each other. Creating a watcher gave you something that
// polls and emits; creating a job gave you something that waits for an event.
// Neither did anything alone, nothing said so, and the join between them was an
// event name typed twice in two tabs.
//
// The wizard makes one pass produce both. This file is the PURE half: what the
// picker offers, and what a finished wizard turns into. No storage, no clock,
// no Tauri — so the interesting question ("does a time-only job come out with
// no watcher?") is answerable in a test rather than by clicking.
//
// ── The time-only case ───────────────────────────────────────────────────
//
// A fixed-cycle job — "write the daily report every morning at nine" — has
// nothing to watch. The tempting shape is a separate flow for it, and that is
// exactly the mistake this redesign already undid twice: three tabs split by
// mechanism, then two pickers split by transport. Both were re-merged because
// the person setting it up is answering ONE question, and it is not "which
// subsystem".
//
// So the clock is one more thing in the same list. Step 1 asks what starts it;
// choosing "every morning at 9" and choosing "when mail arrives" differ only in
// which form step 2 renders, and step 3 — the actual work — is identical either
// way. The time path simply produces no watcher.
//
// See docs/design/autonomy-triggers.md.

import { defaultValues, missingRequired } from '../triggers/recipes/recipeFormat.js';
import { JOB_DEFAULTS } from './JobModel.js';

/** The synthetic option for "on a timer, but not one of the presets". */
export const CUSTOM_TIME = '__time';

/** Steps, in order. The same three whichever driver was chosen. */
export const STEPS = ['start', 'setup', 'work'];

/**
 * What the first step offers, in two groups.
 *
 * Groups, not tabs. The distinction is real and worth showing — one of these
 * runs on a clock, the other goes and looks at something — but it is a property
 * of the options, not a fork in the flow.
 */
export function startOptions(recipes = []) {
    const watch = recipes.filter(r => !r.schedule);
    return [
        {
            group: 'time',
            // Exactly ONE entry. Listing the clock presets here read as "pick
            // weekly or monthly", which is a step-2 question — and answering it
            // twice, once by picking a preset and once in the schedule form, is
            // the kind of double-entry this whole redesign is removing. The
            // presets are still there; they are offered on step 3 as ready-made
            // WORK, which is what they actually are.
            items: [{
                id: CUSTOM_TIME,
                driver: 'time',
                name: 'スケジュールを決める',
                description: '決まった時刻・間隔・毎月など。監視は使いません。',
                recipe: null,
            }],
        },
        {
            group: 'watch',
            // The four that ARE an engine come first; a preset is a USE of one,
            // and mixing the two granularities in one flat list is what made
            // the old picker read as arbitrary.
            items: watch.map(r => ({
                id: r.id, driver: 'watch', name: r.name, description: r.description,
                recipe: r, basic: !!r.basic,
            })).sort((a, b) => (b.basic ? 1 : 0) - (a.basic ? 1 : 0)),
        },
    ];
}

/**
 * Ready-made work for the clock path, offered on step 3.
 *
 * These are the recipes with a `schedule`: they carry a prompt AND a suggested
 * cycle. Picking one fills both, which is the only reason a preset is worth
 * having — a preset that configures the trigger and then leaves the prompt
 * empty has handed back the hard part.
 */
export function timeTemplates(recipes = []) {
    return (recipes || []).filter(r => r.schedule && r.job?.prompt);
}

/**
 * Apply a template to the wizard state.
 *
 * Returns a NEW state rather than mutating: what the schedule and the prompt
 * become is then one visible assignment, and the caller can say in the UI that
 * the cycle was changed too — silently moving a field the user has already set
 * two steps back is worse than a preset that does nothing.
 */
export function applyTemplate(state, recipe) {
    if (!recipe) return state;
    return {
        ...state,
        templateId: recipe.id,
        schedule: { ...SCHEDULE_DEFAULTS, ...(recipe.schedule || {}) },
        job: {
            ...state.job,
            name: recipe.job?.name || state.job?.name || '',
            purpose: recipe.job?.purpose || state.job?.purpose || '',
            prompt: recipe.job?.prompt || state.job?.prompt || '',
            maxPerHour: recipe.job?.maxPerHour || state.job?.maxPerHour,
        },
    };
}

/** Find an option by id across both groups. */
export function findOption(recipes, id) {
    for (const g of startOptions(recipes)) {
        const hit = g.items.find(i => i.id === id);
        if (hit) return hit;
    }
    return null;
}

/** A schedule with nothing chosen yet. */
export const SCHEDULE_DEFAULTS = {
    scheduleType: 'fixed',
    time: '09:00',
    days: [1, 2, 3, 4, 5],
    intervalMinutes: 60,
    dayOfMonth: '1',        // a STRING: DOM_OPTIONS are, and a select
                            // compares by identity, so a number renders unset
    onceAt: '',
};

/**
 * The wizard's starting state for a chosen option.
 *
 * A preset arrives with BOTH halves filled in — its schedule or its watcher
 * fields, and the prompt it exists to run. That is the point of adding a `job`
 * section to the recipe format: a preset that configures a watcher and then
 * leaves you at an empty prompt box has handed back the hard part.
 */
export function initialState(option) {
    const r = option?.recipe || null;
    return {
        optionId: option?.id || '',
        driver: option?.driver || 'time',
        values: r && !r.schedule ? defaultValues(r) : {},
        secrets: {},
        schedule: { ...SCHEDULE_DEFAULTS, ...(r?.schedule || {}) },
        everySeconds: r?.defaults?.everySeconds || 300,
        eventName: r?.defaults?.eventName || '',
        watcherName: r && !r.schedule ? r.name : '',
        job: {
            name: r?.job?.name || '',
            purpose: r?.job?.purpose || '',
            prompt: r?.job?.prompt || r?.defaults?.promptHint || '',
            workspacePath: '',
            agentModeId: null,
            maxPerHour: r?.job?.maxPerHour || JOB_DEFAULTS.maxPerHour,
            cooldownMs: r?.job?.cooldownMs || JOB_DEFAULTS.cooldownMs,
            budgetTokens: 0,
        },
    };
}

/**
 * What is stopping this step from being finished.
 *
 * Per step, and messages rather than a boolean — the same reasoning as
 * `validateRecipe`: three blanks should cost one round of fixing, not three.
 * Checked here rather than in the component so "you cannot reach the end
 * without a prompt" is a test rather than a click-through.
 */
export function stepProblems(step, state, option, storedSecrets = new Set()) {
    const out = [];
    const s = state || {};
    if (step === 'start') {
        if (!s.optionId) out.push('何をきっかけにするかを選んでください。');
        return out;
    }
    if (step === 'setup') {
        if (s.driver === 'time') {
            const sc = s.schedule || {};
            if (sc.scheduleType === 'once') {
                if (!sc.onceAt) out.push('日時を入れてください。');
                return out;
            }
            if (sc.scheduleType === 'interval') {
                if (!(Number(sc.intervalMinutes) > 0)) out.push('間隔（分）を入れてください。');
            } else if (!sc.time) {
                out.push('時刻を入れてください。');
            }
            if (sc.scheduleType !== 'monthly' && !(sc.days || []).length) {
                out.push('曜日を1つ以上選んでください。');
            }
            return out;
        }
        if (!String(s.watcherName || '').trim()) out.push('監視の名前を入れてください。');
        if (!String(s.eventName || '').trim()) out.push('イベント名を入れてください。');
        for (const f of missingRequired(option?.recipe, s.values, storedSecrets)) {
            if (s.secrets?.[f.key]) continue;        // typed now, stored on save
            out.push(`${f.label} を入れてください。`);
        }
        return out;
    }
    if (step === 'work') {
        if (!String(s.job?.name || '').trim()) out.push('作業の名前を入れてください。');
        if (!String(s.job?.prompt || '').trim()) out.push('やることを書いてください。');
        // Required for the same reason JobDetail requires it: the name says
        // what it is called, only this says why the person who finds it in six
        // months should keep it.
        if (!String(s.job?.purpose || '').trim()) out.push('目的を1行書いてください。');
    }
    return out;
}

/**
 * The records to create, from a finished wizard.
 *
 * Returns a PLAN rather than writing anything: the caller stores secrets,
 * records the recipe approval and saves, in that order, and a plan it can look
 * at first is what lets the last screen show exactly what is about to exist.
 *
 * `watcher` is null for the time path. Not an empty watcher, not one with
 * `type: 'none'` — the absence is the honest answer, and the job's trigger says
 * everything there is to say about what starts it.
 *
 * Both come out DISABLED. Same rule as everywhere else here: nothing is live
 * the moment it is created, because someone who mis-set a 5-minute poll should
 * find that out by reading the summary rather than by watching it run.
 */
export function buildPlan(state, option, now = Date.now()) {
    const s = state || {};
    const recipe = option?.recipe || null;
    const jobId = `job_${now}`;

    const job = {
        ...JOB_DEFAULTS,
        id: jobId,
        enabled: false,
        name: s.job?.name || '',
        purpose: s.job?.purpose || '',
        prompt: s.job?.prompt || '',
        workspacePath: s.job?.workspacePath || '',
        agentModeId: s.job?.agentModeId || null,
        maxPerHour: Number(s.job?.maxPerHour) || JOB_DEFAULTS.maxPerHour,
        cooldownMs: Number(s.job?.cooldownMs) || 0,
        budgetTokens: Number(s.job?.budgetTokens) || 0,
        // Which option produced this, so the list can say where a job came from
        // and a preset can be improved without guessing who is using it.
        createdFrom: s.templateId || s.optionId || '',
        triggers: [],
    };

    if (s.driver === 'time') {
        const sc = s.schedule || SCHEDULE_DEFAULTS;
        job.triggers = [{
            kind: 'time',
            scheduleType: sc.scheduleType,
            time: sc.time,
            days: sc.days,
            dayOfMonth: sc.dayOfMonth,
            intervalMinutes: Number(sc.intervalMinutes) || 60,
            onceAt: sc.onceAt,
        }];
        return { watcher: null, approve: null, job };
    }

    const watcherId = `wch_${now}`;
    // Secrets never travel in `values`: they go to the OS credential store by
    // field id, and the watcher record holds only which fields exist.
    const secretKeys = new Set((recipe?.fields || []).filter(f => f.type === 'secret').map(f => f.key));
    const values = {};
    for (const [k, v] of Object.entries(s.values || {})) if (!secretKeys.has(k)) values[k] = v;

    // The link the old two-tab flow left as a matching string. The job holds
    // the watcher's ID, so renaming the event breaks nothing.
    job.triggers = [{ kind: 'watch', sourceId: watcherId }];

    return {
        watcher: {
            id: watcherId,
            name: s.watcherName,
            enabled: false,
            recipeId: recipe?.id || '',
            values,
            type: recipe?.engine || '',
            everySeconds: Number(s.everySeconds) || recipe?.defaults?.everySeconds || 300,
            eventName: s.eventName,
        },
        // The recipe and the hosts, as read on the screen the user just
        // approved. Recorded by the caller AFTER the values are stored, so the
        // approval covers a configuration that exists.
        approve: { watcherId, recipe, values },
        job,
    };
}
