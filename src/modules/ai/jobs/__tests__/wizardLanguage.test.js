// Everything the setup flow SAYS follows the app's language.
//
// The chrome was translated and several things around it were not, so an
// English UI showed English buttons around Japanese sentences: the card for
// "just run it on a timer", the weekday circles, the reasons a step could not
// be finished, and the line under a job's name saying what starts it. Each of
// those had its wording written straight into a .js file, where the i18n
// mechanism could not reach it.
//
// Two kinds of test here, and the second is the one that matters: the first
// checks the strings that were fixed, the second FAILS ON THE NEXT ONE — a
// Japanese sentence added to any of these modules is found by the scan whether
// or not anyone remembers this file exists.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { __setLocaleForTest } from '../../../../i18n/index.js';
import { startOptions, stepProblems, initialState, SCHEDULE_DEFAULTS } from '../wizardPlan.js';
import { triggerSummary } from '../JobModel.js';

afterEach(() => __setLocaleForTest('ja'));

/** Kana or kanji anywhere in the string. */
const JAPANESE = /[ぁ-んァ-ヶ一-龯]/;

describe('the wizard speaks the app language', () => {
    it('names the clock option in both', () => {
        __setLocaleForTest('ja');
        const ja = startOptions([])[0].items[0];
        expect(ja.name).toBe('スケジュールを決める');

        __setLocaleForTest('en');
        const en = startOptions([])[0].items[0];
        expect(en.name).toBe('Pick a schedule');
        expect(JAPANESE.test(en.description)).toBe(false);
    });

    it('gives the reasons a step is unfinished in both', () => {
        const empty = { ...initialState(null), schedule: { ...SCHEDULE_DEFAULTS, time: '' } };

        __setLocaleForTest('ja');
        expect(stepProblems('work', empty, null).join(' ')).toContain('目的');

        __setLocaleForTest('en');
        const problems = stepProblems('work', empty, null);
        expect(problems.length).toBe(3);
        for (const p of problems) expect(JAPANESE.test(p), p).toBe(false);
    });

    it('names the missing field in the message, in either language', () => {
        const recipe = { fields: [{ key: 'url', label: 'Health URL', type: 'text', required: true }] };
        __setLocaleForTest('en');
        const [msg] = stepProblems('setup',
            { driver: 'watch', watcherName: 'w', eventName: 'e', values: {}, secrets: {} },
            { recipe });
        expect(msg).toContain('Health URL');
        expect(JAPANESE.test(msg)).toBe(false);
    });
});

describe('what starts a job reads in the app language', () => {
    it('describes a schedule in both', () => {
        const every30 = { kind: 'time', scheduleType: 'interval', intervalMinutes: 30 };
        __setLocaleForTest('ja');
        expect(triggerSummary(every30)).toBe('30分ごと');
        __setLocaleForTest('en');
        expect(triggerSummary(every30)).toBe('every 30 min');
    });

    it('says "not set" in the app language rather than a fixed string', () => {
        __setLocaleForTest('en');
        const summary = triggerSummary({ kind: 'time', scheduleType: 'fixed' });
        expect(JAPANESE.test(summary)).toBe(false);
    });
});

describe('nothing in the setup flow is written in one language only', () => {
    // The scan that makes this stay true. It reads the SOURCE, so a sentence
    // added tomorrow is caught without anyone adding a case above.
    const FILES = [
        'src/modules/ai/jobs/wizardPlan.js',
        'src/modules/ai/jobs/JobModel.js',
        'src/dashboard/svelte/jobs/JobCatalog.svelte',
        'src/dashboard/svelte/jobs/SetupWizard.svelte',
        'src/dashboard/svelte/schedule/ScheduleFields.svelte',
    ];

    /** Strip comments — prose ABOUT the code is written in English or Japanese
     *  as suits the explanation, and is never rendered. */
    function code(src) {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments, JSDoc
            .replace(/<!--[\s\S]*?-->/g, '')          // svelte markup comments
            .split('\n')
            .filter(line => !line.trim().startsWith('//'))
            .map(line => line.replace(/\s\/\/.*$/, ''))
            .join('\n');
    }

    it.each(FILES)('%s has no Japanese outside the catalog', (rel) => {
        const src = code(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8'));
        const offenders = src.split('\n')
            .map((line, i) => [i + 1, line])
            .filter(([, line]) => JAPANESE.test(line))
            // A key name may mention it; a VALUE is the problem.
            .map(([n, line]) => `${n}: ${line.trim()}`);
        expect(offenders).toEqual([]);
    });
});
