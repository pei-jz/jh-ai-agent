// The visual contract, as assertions.
//
// docs/design/visual-language.md is prose, and prose does not stay true. These
// are the rules that make adding a theme cheap — every one of them was violated
// before, and each violation cost the same thing: a decision that had to be
// re-made per theme instead of once.
//
// The point is NOT tidiness. A translucent card's contrast depends on what is
// behind it, and what is behind it differs in each of five themes; a theme block
// that names `#result-panel` means porting a theme requires knowing this app's
// element ids. Both turn "add a theme" into "edit the app".

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');            // src/
const css = readFileSync(join(here, '../dashboard.css'), 'utf8');

/** Every file that can carry a style rule. */
function styleSources(dir = root, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === '__tests__' || name === 'node_modules') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { styleSources(p, out); continue; }
        if (/\.(css|svelte)$/.test(name) || /[Ss]tyles\.js$/.test(name) || name === 'main.js') {
            out.push([relative(root, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]);
        }
    }
    return out;
}
const SOURCES = styleSources();

/** Strip comments so a rule QUOTED in prose is not read as a rule. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');


/**
 * The declarations of the rule whose selector is exactly `sel`, from `src`.
 *
 * Scanned rather than matched with a constructed regex: these selectors carry
 * dots and hashes, and the escaping is easy to get wrong in a way that silently
 * finds NOTHING — which reads as a passing test right up until it does not.
 */
function ruleBody(sel, src = code(css)) {
    let from = 0;
    for (;;) {
        const at = src.indexOf(sel, from);
        if (at < 0) return null;
        from = at + sel.length;
        // Whole selector, not a prefix of a longer one, and it must open a block.
        if (/[\w-]/.test(src[at - 1] || '') || /^[\w-]/.test(src.slice(from))) continue;
        const rest = src.slice(from);
        const brace = rest.search(/\S/);
        if (rest[brace] !== '{') continue;
        const open = from + brace;
        return src.slice(open + 1, src.indexOf('}', open));
    }
}

const THEMES = ['light', 'paper', 'paper-subtle', 'bamboo-ancient', 'kakejiku'];
const themeBlock = (t) => {
    const start = css.indexOf(`:root[data-theme="${t}"] {`);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
};

describe('§1 — nothing translucent, nothing blurred', () => {
    it('has no backdrop-filter anywhere', () => {
        const offenders = SOURCES.filter(([, s]) => /backdrop-filter\s*:/.test(code(s))).map(([f]) => f);
        expect(offenders).toEqual([]);
    });

    it('gives every theme an OPAQUE card surface', () => {
        for (const t of ['', ...THEMES]) {
            const block = t ? themeBlock(t) : css.slice(css.indexOf(':root {'), css.indexOf('}'));
            const m = block.match(/--surface-raised:\s*([^;]+);/);
            expect(m, `--surface-raised missing in ${t || ':root'}`).toBeTruthy();
            expect(m[1], `--surface-raised is translucent in ${t || ':root'}`).not.toMatch(/rgba|hsla/);
        }
    });

    it('has retired the solid/translucent card pair', () => {
        expect(code(css)).not.toContain('--bg-card-solid');
    });
});

describe('§3 — one accent, and shadows only for what floats', () => {
    it('defines no glow tokens', () => {
        for (const name of ['--accent-glow', '--accent-glow-lg', '--shadow-glow']) {
            expect(code(css), `${name} is still defined`).not.toContain(`${name}:`);
        }
    });

    it('nothing references a glow token', () => {
        const offenders = SOURCES
            .filter(([, s]) => /var\(--(accent-glow|shadow-glow)/.test(code(s)))
            .map(([f]) => f);
        expect(offenders).toEqual([]);
    });

    it('offers exactly two shadows, and both are theme tokens', () => {
        for (const name of ['--shadow-sm', '--shadow-md', '--shadow-lg']) {
            expect(code(css), `${name} survives`).not.toContain(`${name}:`);
        }
        for (const t of THEMES) {
            expect(themeBlock(t), `${t} must own its shadows`).toContain('--shadow-pop:');
        }
    });
});

describe('§3 — four radius steps', () => {
    it('retires the four that were defined but not used', () => {
        for (const name of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl']) {
            expect(code(css)).not.toContain(`${name}:`);
        }
    });

    it('leaves no literal px corner anywhere', () => {
        const offenders = [];
        for (const [f, s] of SOURCES) {
            const hits = code(s).match(/border(?:-\w+)*-radius:\s*\d+px/g);
            if (hits) offenders.push(`${f}: ${hits.slice(0, 3).join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });

    it('defines the four steps', () => {
        for (const name of ['--r-1', '--r-2', '--r-3', '--r-pill']) {
            expect(css).toContain(`${name}:`);
        }
    });
});

describe('§5 — a theme supplies values, never selectors', () => {
    // This is the rule that decides what porting a JHEditor theme costs.
    it('no theme block reaches into the app with an element selector', () => {
        const offenders = [...code(css).matchAll(/:root\[data-theme="[^"]+"\]\s+[.#][\w-]+/g)]
            .map(m => m[0]);
        expect(offenders).toEqual([]);
    });

    it("declares body background-image exactly once", () => {
        // The bug this exists for: `body` carried TWO background-image
        // declarations — the contract's var(--texture-app) and, later in the
        // file, var(--grain, none). The later one won, so every theme's pattern
        // resolved to `none`. What matters is not how many ELEMENTS wear the
        // texture (the chrome wears it too, deliberately) but that no element
        // declares the property twice.
        const c = code(css);
        const decls = [...(ruleBody('body') || '').matchAll(/background-image:\s*([^;]+);/g)]
            .map(m => m[1].trim());
        expect(decls, 'body must set background-image exactly once').toHaveLength(1);
        expect(decls[0]).toBe('var(--texture-app)');
        // The token that used to shadow it is not a background source any more.
        expect(c).not.toMatch(/background-image:[^;]*--grain/);
    });

    // A theme whose pattern stops at the edge of the content looks like a
    // wallpaper hung inside a plain frame — on 掛け軸 the mount IS the theme.
    //
    // The assertion is that the texture is declared INSIDE each element's own
    // rule, because that is what the bug was: a separate
    // `#titlebar, .sidebar { background-image: … }` earlier in the file, reset to
    // none by the `background:` SHORTHAND in the real rule further down. A
    // shorthand always beats an earlier longhand, and nothing errors.
    // The title bar reads `--texture-chrome`; the ground and the rail read
    // `--texture-app`. They are separate because a pattern strong enough to say
    // what a theme IS can be too strong to read through — 竹簡's slats belong on
    // the binding, not under the task list.
    it.each([['body', '--texture-app'], ['#titlebar', '--texture-chrome'], ['.sidebar', '--texture-app']])(
        '%s wears %s', (sel, token) => {
        const body = ruleBody(sel);
        expect(body, `${sel} rule not found`).toBeTruthy();
        expect(body, `${sel} does not set the texture`).toContain(`background-image: var(${token})`);
        // …and after its own shorthand, or the shorthand would clear it.
        const bg = body.indexOf('background:');
        const img = body.indexOf('background-image:');
        if (bg >= 0) expect(img, `${sel} declares the image BEFORE its shorthand`).toBeGreaterThan(bg);
    });

    it('lets the chrome default to the ground, so one pattern needs one token', () => {
        const base = ruleBody(':root') || '';
        expect(base).toMatch(/--texture-chrome:\s*var\(--texture-app\)/);
    });

    it('竹簡 keeps its slats on the chrome only — they are unreadable under a list', () => {
        const bamboo = themeBlock('bamboo-ancient');
        expect(bamboo).toContain('--texture-chrome: var(--grain), var(--slip);');
        expect(bamboo).toMatch(/--texture-app:\s*none;/);
        expect(bamboo).toMatch(/--texture-read:\s*none;/);
    });

    it('tiles the texture instead of stretching one speck across the window', () => {
        // The textures are gradients, which fill their element by default.
        const bodyRule = ruleBody('body') || '';
        expect(bodyRule).toMatch(/background-size:\s*\d+px/);
        expect(bodyRule).toMatch(/background-repeat:\s*repeat/);
    });

    // A texture applied to a selector nothing matches is the same as no texture.
    it('applies --texture-read to selectors that exist', () => {
        const rule = code(css).match(/([^{}]+)\{\s*background-image:\s*var\(--texture-read\)/);
        expect(rule).toBeTruthy();
        const selectors = rule[1].split(',').map(x => x.trim()).filter(Boolean);
        const markup = SOURCES.filter(([f]) => /\.svelte$/.test(f)).map(([, s2]) => s2).join('\n');
        const live = selectors.filter(sel => markup.includes(sel.replace(/^[.#]/, '')));
        expect(live.length, `none of ${selectors.join(', ')} appears in any component`)
            .toBeGreaterThan(0);
    });

    it('defaults both textures to none, so a plain theme writes nothing', () => {
        const base = css.slice(css.indexOf(':root {'), css.indexOf('\n}'));
        expect(base).toMatch(/--texture-app:\s*none/);
        expect(base).toMatch(/--texture-read:\s*none/);
    });

    it('gives the themes that HAVE a texture the token rather than a rule', () => {
        // 古紙 (an aged sheet), 竹簡 (slats) and 掛け軸 (silk weave). 白紙 is the
        // plain one and deliberately has neither — that is what separates it
        // from 古紙 now that both are light.
        expect(themeBlock('paper')).toContain('--texture-app:');
        expect(themeBlock('paper')).toContain('--texture-read:');
        expect(themeBlock('bamboo-ancient')).toContain('--texture-app:');
        expect(themeBlock('kakejiku')).toContain('--texture-app:');
        expect(themeBlock('paper-subtle')).not.toContain('--texture-');
    });

    it('replaces the hand-written font hook with a theme token', () => {
        expect(code(css)).not.toContain('--font-hand');
        expect(css).toContain('--font-accent:');
        // The default has to be the UI face, or a theme with no opinion breaks.
        const base = css.slice(css.indexOf(':root {'), css.indexOf('\n}'));
        expect(base).toMatch(/--font-accent:\s*var\(--font-sans\)/);
    });
});

// ── The safety net for renames ───────────────────────────────────────────────
// A CSS custom property that is referenced but never defined does not error —
// it silently resolves to nothing, and the element renders unstyled. That makes
// a token rename the one refactor the rest of the suite cannot catch, which is
// why visual-language.md §7 puts the rename LAST and why this exists.
describe('every token that is used is defined', () => {
    const DEFINED = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));

    // Declared by a component's own <style>, or by the browser.
    const LOCAL = /^--(mpane|insp|left|r-|paper-rule|grain|slip|texture)/;

    it('resolves every var() reference to a defined token', () => {
        const missing = new Map();
        for (const [f, src] of SOURCES) {
            for (const m of code(src).matchAll(/var\(\s*(--[\w-]+)/g)) {
                const name = m[1];
                if (DEFINED.has(name) || LOCAL.test(name)) continue;
                // A component may define its own; only flag what nothing declares.
                if (new RegExp(`${name}\s*:`).test(src)) continue;
                if (!missing.has(name)) missing.set(name, f);
            }
        }
        expect([...missing.entries()].map(([n, f]) => `${n} (first used in ${f})`)).toEqual([]);
    });
});

// ── Regions, not cards ───────────────────────────────────────────────────────
// The distinction the app kept losing: a CONTAINER is a region of the page and
// divides with a rule; a CONTROL is something you press or type into and keeps
// its border and radius (that is what says it is operable); a FLOATING layer
// keeps its shadow because it really is above the page.
//
// Drawing containers as cards is what made five groupings on one screen read as
// five objects stacked on a surface — worst under the textured themes, where the
// card hides the paper it is lying on.
describe('containers divide, they do not float', () => {
    /** Selectors that name a REGION of a screen, not a control or a modal. */
    const CONTAINERS = [
        '.card', '.stat-card',
        '.cfg-sec',
        '.mpanel-left', '.mpanel-right', '.mtl-insp',
        '.sch-list-panel', '.sch-detail-panel',
    ];

    /**
     * The declarations of one rule, comments stripped.
     *
     * Scanned rather than matched with a constructed regex: the selectors carry
     * dots and the escaping is easy to get wrong in a way that silently finds
     * nothing, which is worse than failing.
     */
    const bodyOf = (sel) => {
        for (const [, src] of SOURCES) {
            const c = code(src);
            let from = 0;
            for (;;) {
                const at = c.indexOf(sel, from);
                if (at < 0) break;
                from = at + sel.length;
                // Must be the whole selector (not a prefix of a longer class)
                // and must open a block right after it.
                const after = c.slice(from);
                if (/^[\w-]/.test(after)) continue;
                const brace = after.search(/\S/);
                if (after[brace] !== '{') continue;
                const open = from + brace;
                return c.slice(open + 1, c.indexOf('}', open));
            }
        }
        return null;
    };

    /** One declaration's value, or '' when the rule does not set it. */
    const decl = (body, prop) => {
        const re = new RegExp(`(?:^|[;{])\s*${prop}\s*:\s*([^;]+)`, 'g');
        let last = '';
        for (const m of body.matchAll(re)) last = m[1].trim();
        return last;
    };

    it.each(CONTAINERS)('%s is not boxed', (sel) => {
        const body = bodyOf(sel);
        expect(body, `${sel} not found`).toBeTruthy();
        // A container may carry ONE edge rule; what it must not have is a box.
        // Read the declarations rather than pattern-matching the text: a
        // lookahead like /border:\s*(?!none)/ passes on "border: none" by
        // backtracking \s* to nothing, which is how this first went green
        // against rules that were still boxed.
        expect(decl(body, 'border'), `${sel} still has a border box`)
            .toMatch(/^(none|0)?$/);
        expect(decl(body, 'border-radius'), `${sel} still has a radius`)
            .toMatch(/^(0|0px)?$/);
    });

    // The other half of the rule: controls keep theirs. A page where nothing has
    // an edge is flat in the wrong sense — you cannot see what is operable.
    it.each(['.mcomp-send', '.mcomp-int', '.mem-tab', '.sch-day-btn'])(
        '%s keeps its edge, because it is a control', (sel) => {
            const body = bodyOf(sel);
            expect(body, `${sel} not found`).toBeTruthy();
            expect(body).toMatch(/border-radius:/);
        });
});
