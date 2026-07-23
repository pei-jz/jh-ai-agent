// toolGroups — decide whether an optional tool GROUP (browser / git) is
// advertised to the LLM. Advertising tools that can't run (Playwright not
// installed) bloats the prompt and invites wasted calls, so we gate them:
//   • a user preference (localStorage `jhai_tool_groups`) can disable a group;
//   • the `browser_*` group auto-hides once a run has proven Playwright is
//     unavailable (the browser handler sets `jhai_playwright_unavailable`).
// Pure functions here; ToolExecutor reads localStorage and passes the flags.

/** @returns {'browser'|'git'|null} the optional group a tool belongs to. */
export function toolGroupOf(name) {
    if (typeof name !== 'string') return null;
    if (name.startsWith('browser_')) return 'browser';
    if (name.startsWith('git_')) return 'git';
    return null;
}

/**
 * @param {string} name tool name
 * @param {{prefs?:object, playwrightUnavailable?:boolean}} opts
 *   prefs: { browser?:boolean, git?:boolean } — false disables that group.
 *   playwrightUnavailable: true hides the browser group.
 * @returns {boolean} whether to advertise this tool
 */
export function isToolAdvertised(name, opts = {}) {
    const group = toolGroupOf(name);
    if (!group) return true;                       // core tools always advertised
    const prefs = opts.prefs || {};
    if (prefs[group] === false) return false;      // explicit user opt-out
    if (group === 'browser' && opts.playwrightUnavailable) return false;
    return true;
}

/** Read the gating inputs from localStorage (guarded for non-browser test envs). */
export function readToolGroupState() {
    const out = { prefs: {}, playwrightUnavailable: false };
    try {
        if (typeof localStorage === 'undefined') return out;
        const raw = localStorage.getItem('jhai_tool_groups');
        if (raw) out.prefs = JSON.parse(raw) || {};
        out.playwrightUnavailable = localStorage.getItem('jhai_playwright_unavailable') === '1';
    } catch (_) { /* defaults */ }
    return out;
}
