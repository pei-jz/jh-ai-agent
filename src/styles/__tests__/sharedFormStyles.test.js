// A class used by more than one component has to be defined GLOBALLY.
//
// Svelte scopes a component's <style>: `.sch-input` written inside
// ScheduleDetail.svelte compiles to `.sch-input.svelte-xxxx` and matches
// nothing anywhere else. TriggerPanel's markup used those same class names to
// "match the form next to it" and got browser defaults instead — labels inline
// with fields, inputs at their intrinsic width — sitting one tab away from a
// form that looked designed.
//
// jsdom does not evaluate scoping, so no rendering test can catch this. What
// can is the structural rule itself: if two components use a class, its rules
// belong in dashboard.css.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../..');
const css = readFileSync(join(here, '../dashboard.css'), 'utf8');

function svelteFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) svelteFiles(p, out);
        else if (name.endsWith('.svelte')) out.push([p, readFileSync(p, 'utf8')]);
    }
    return out;
}

/** The class names a component's markup actually uses. */
function classesUsedIn(text) {
    const markup = text.replace(/<style[\s\S]*?<\/style>/g, '')
                       .replace(/<script[\s\S]*?<\/script>/g, '');
    const out = new Set();
    for (const m of markup.matchAll(/class(?::[\w-]+)?=["{]([^"}]*)["}]?/g)) {
        for (const c of m[1].split(/[\s,]+/)) {
            if (/^[a-z][\w-]*$/i.test(c)) out.add(c);
        }
    }
    return out;
}

/**
 * The class names a component DEFINES in its own scoped <style>.
 *
 * Only a class that OPENS a selector counts. `.trg-where .sch-input { flex: 1 }`
 * is a layout tweak applied to a shared class inside this component, which is
 * legitimate and works — Svelte stamps the scope class on the component's own
 * elements, so a descendant selector still matches. What is not legitimate is
 * OWNING `.sch-input` in a component's scoped style, because then no other
 * component can use it.
 */
function classesDefinedIn(text) {
    const style = (text.match(/<style[\s\S]*?<\/style>/) || [''])[0]
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const out = new Set();
    for (const m of style.matchAll(/(^|[{}]|,)\s*\.([a-z][\w-]*)/gi)) out.add(m[2]);
    return out;
}

const components = svelteFiles(join(src, 'dashboard/svelte'));

describe('the schedule and trigger forms share one definition', () => {
    // These are the vocabulary the two forms are built from. They must live in
    // the global sheet, because both use them and only one could define them.
    const SHARED = [
        'sch-detail-panel', 'sch-detail-header', 'sch-detail-body',
        'sch-field', 'sch-label', 'sch-note',
        'sch-input', 'sch-textarea', 'sch-select',
    ];

    it.each(SHARED)('.%s is defined in dashboard.css', (cls) => {
        expect(css).toMatch(new RegExp(`\\.${cls}\\b`));
    });

    it('neither component redefines them in its own scoped style', () => {
        const offenders = [];
        for (const [path, text] of components) {
            if (!/schedule[\\/](ScheduleDetail|TriggerPanel)\.svelte$/.test(path)) continue;
            const defined = classesDefinedIn(text);
            for (const cls of SHARED) {
                if (defined.has(cls)) offenders.push(`${path.split(/[\\/]/).pop()} → .${cls}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    // The actual failure, stated directly: TriggerPanel leaning on a class that
    // only ScheduleDetail defines is the bug, whatever the class is called.
    it('TriggerPanel uses no class that only ScheduleDetail defines', () => {
        const trigger = components.find(([p]) => p.endsWith('TriggerPanel.svelte'));
        const detail = components.find(([p]) => p.endsWith('ScheduleDetail.svelte'));
        expect(trigger, 'TriggerPanel.svelte').toBeTruthy();
        expect(detail, 'ScheduleDetail.svelte').toBeTruthy();

        const own = classesDefinedIn(trigger[1]);
        const neighbours = classesDefinedIn(detail[1]);
        const borrowed = [...classesUsedIn(trigger[1])]
            .filter(c => neighbours.has(c) && !own.has(c) && !new RegExp(`\\.${c}\\b`).test(css));
        expect(borrowed).toEqual([]);
    });
});

// Three times this session a class name was used and defined nowhere:
// `data-tooltip` (an empty hover box), `.sch-*` in the wrong scope (an
// unstyled form), and these (a view with no height and no spacing under its
// heading). The class is silent about it every time — nothing errors, the
// element just gets browser defaults.
describe('the view shell classes are real', () => {
    const SHELL = ['view-container', 'view-header', 'schedule-root'];

    it.each(SHELL)('.%s is defined, not just used', (cls) => {
        expect(css).toMatch(new RegExp(`\\.${cls}\\s*[,{]`));
    });

    it('every class the root views mount into exists somewhere', () => {
        const roots = components.filter(([p]) => /Root\.svelte$/.test(p));
        const missing = [];
        for (const [path, textOf] of roots) {
            const own = classesDefinedIn(textOf);
            for (const cls of SHELL) {
                const used = new RegExp(`class="[^"]*\\b${cls}\\b`).test(textOf);
                if (used && !own.has(cls) && !new RegExp(`\\.${cls}\\s*[,{]`).test(css)) {
                    missing.push(`${path.split(/[\/]/).pop()} → .${cls}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});

// The general rule, rather than one pair of components at a time.
//
// This has now happened three times: TriggerPanel written against
// ScheduleDetail's `.sch-*`, WatcherPanel written against TriggerPanel's
// `.trg-*`, and the view shell classes defined nowhere at all. Every time it
// looks identical from the outside — the markup is right, the class names are
// right, and the browser applies its defaults because a Svelte <style> is
// scoped to the component that wrote it.
describe("a class two components use must be defined where both can see it", () => {
    // This has now happened three times, identically: TriggerPanel written
    // against ScheduleDetail's `.sch-*`, WatcherPanel against TriggerPanel's
    // `.trg-*`, and the view shell classes defined nowhere at all. From the
    // outside every case looks the same — the markup is right, the class names
    // are right, and the browser applies its defaults, because a Svelte
    // <style> is scoped to the component that wrote it.
    //
    // The rule is about SHARING, not about where any single class lives: one
    // component styling its own markup is its own business. The moment a second
    // component is written against the same name, the definition has to be
    // somewhere both of them reach.
    it('is in dashboard.css, not inside one of them', () => {
        const usedBy = new Map();        // class -> Set(component file)
        for (const [path, textOf] of components) {
            for (const cls of classesUsedIn(textOf)) {
                if (!usedBy.has(cls)) usedBy.set(cls, new Set());
                usedBy.get(cls).add(path);
            }
        }

        const offenders = [];
        for (const [cls, users] of usedBy) {
            if (users.size < 2) continue;                                   // not shared
            if (new RegExp(`\\.${cls}\\s*[,{]`).test(css)) continue;  // global: fine
            // Fine too if every user styles it itself — no one is relying on
            // someone else's scoped rules.
            const stylers = [...users].filter(
                (path) => classesDefinedIn(components.find(([p]) => p === path)[1]).has(cls));
            if (stylers.length === 0) continue;      // nobody styles it at all
            if (stylers.length === users.size) continue;
            offenders.push(
                `.${cls} is styled only in ${stylers.map(short).join(', ')} `
                + `but also used by ${[...users].filter(u => !stylers.includes(u)).map(short).join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });
});

/** Just the filename, for a readable failure. */
function short(path) {
    return path.split(/[\\/]/).pop();
}
