// toolGroups — decide whether an optional tool GROUP (browser / git) is
// advertised to the LLM. Advertising tools that can't run (Playwright not
// installed) bloats the prompt and invites wasted calls, so we gate them:
//   • a user preference (localStorage `jhai_tool_groups`) can disable a group;
//   • the `browser_*` group auto-hides once a run has proven Playwright is
//     unavailable (the browser handler sets `jhai_playwright_unavailable`).
// Pure functions here; ToolExecutor reads localStorage and passes the flags.

/** Tools that only make sense while an app is publishing documents. */
const RESOURCE_TOOLS = new Set(['list_resources', 'read_resource']);

/** @returns {'browser'|'git'|'resources'|null} the optional group a tool belongs to. */
export function toolGroupOf(name) {
    if (typeof name !== 'string') return null;
    if (name.startsWith('browser_')) return 'browser';
    if (name.startsWith('git_')) return 'git';
    if (RESOURCE_TOOLS.has(name)) return 'resources';
    return null;
}

/**
 * @param {string} name tool name
 * @param {{prefs?:object, playwrightUnavailable?:boolean, hasResources?:boolean}} opts
 *   prefs: { browser?:boolean, git?:boolean, resources?:boolean } — false disables that group.
 *   playwrightUnavailable: true hides the browser group.
 *   hasResources: false/absent hides the resource tools (nothing to read).
 * @returns {boolean} whether to advertise this tool
 */
export function isToolAdvertised(name, opts = {}) {
    const group = toolGroupOf(name);
    if (!group) return true;                       // core tools always advertised
    const prefs = opts.prefs || {};
    if (prefs[group] === false) return false;      // explicit user opt-out
    if (group === 'browser' && opts.playwrightUnavailable) return false;
    // Unlike browser/git, this group is advertised only on POSITIVE evidence:
    // with no app connected the tools can do nothing but waste a turn.
    if (group === 'resources' && !opts.hasResources) return false;
    return true;
}

/**
 * Read the gating inputs from localStorage (guarded for non-browser test envs).
 * @param {{hasResources?:boolean}} live values that come from runtime state
 *   rather than preferences (the registry knows what apps published).
 */
export function readToolGroupState(live = {}) {
    const out = { prefs: {}, playwrightUnavailable: false, hasResources: !!live.hasResources };
    try {
        if (typeof localStorage === 'undefined') return out;
        const raw = localStorage.getItem('jhai_tool_groups');
        if (raw) out.prefs = JSON.parse(raw) || {};
        out.playwrightUnavailable = localStorage.getItem('jhai_playwright_unavailable') === '1';
    } catch (_) { /* defaults */ }
    return out;
}
