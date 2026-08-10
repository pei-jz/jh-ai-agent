// providers — what the Settings UI knows about each LLM provider.
//
// One table instead of the four parallel `switch (provider)` statements this
// replaces (display name + icon in the connection row, key placeholder, URL
// placeholder, default base URL). Those had already drifted apart: 'generic' was
// missing from two of them, so a generic OpenAI-compatible connection showed the
// raw string "generic" and offered no placeholder help at all.
//
// Adding a provider is now one row here.

/**
 * @typedef {object} ProviderInfo
 * @property {string} id
 * @property {string} label     shown in the connection table
 * @property {string} icon      name in the shared inline-SVG set
 * @property {string} keyHint   API-key field placeholder
 * @property {string} urlHint   base-URL field placeholder
 * @property {string} model     model name suggested when the field is empty
 * @property {boolean} keyless  true when no API key is needed (local runtimes)
 * @property {string} [urlLabel] overrides the base-URL field's label
 */
const PROVIDERS = [
    { id: 'openai',    label: 'OpenAI GPT',        icon: 'bot',     keyHint: 'sk-proj-...',  urlHint: 'https://api.openai.com/v1',                          model: 'gpt-4o' },
    { id: 'anthropic', label: 'Anthropic Claude',  icon: 'brain',   keyHint: 'sk-ant-...',   urlHint: 'https://api.anthropic.com/v1',                       model: 'claude-3-5-sonnet-20241022' },
    { id: 'gemini',    label: 'Google Gemini',     icon: 'sparkle', keyHint: 'AIzaSy...',    urlHint: 'https://generativelanguage.googleapis.com/v1beta',   model: 'gemini-1.5-flash' },
    // Azure's URL is the resource endpoint, not an API base — hence its own label.
    { id: 'azure',     label: 'Azure OpenAI',      icon: 'cloud',   keyHint: 'API Key',      urlHint: 'https://your-resource.openai.azure.com/',            model: 'gpt-4o-deployment', urlLabel: 'Endpoint URL' },
    { id: 'ollama',    label: 'Ollama (Local)',    icon: 'server',  keyHint: 'Not required', urlHint: 'http://localhost:11434',                             model: 'qwen3.5:9b', keyless: true },
    // An OpenAI-compatible endpoint that is not OpenAI: DeepSeek, vLLM, LM Studio,
    // a corporate gateway. The base URL is the whole point, so it has no default.
    { id: 'generic',   label: 'Generic OpenAI',    icon: 'plug',    keyHint: 'API key (if required)', urlHint: 'https://your-endpoint/v1',                  model: 'model-name', urlLabel: 'Base URL (required)' },
];

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

/** Every provider, in the order the picker should offer them. */
export function allProviders() {
    return PROVIDERS.map(p => ({ ...p, keyless: !!p.keyless }));
}

/**
 * What the UI should show for a provider id.
 *
 * An UNKNOWN id (a config written by a newer version, or hand-edited) falls back
 * to showing the id itself rather than an empty cell — the previous `switch`
 * defaulted the label but left the icon as the generic bot, which made a typo look
 * like a real provider.
 */
export function providerInfo(id) {
    const hit = BY_ID.get(id);
    if (hit) {
        return {
            ...hit,
            keyless: !!hit.keyless,
            urlLabel: hit.urlLabel || 'Base URL (Optional Override)',
            known: true,
        };
    }
    return {
        id: String(id || ''),
        label: String(id || '(unknown)'),
        icon: 'alert',
        keyHint: 'API Key',
        urlHint: '',
        model: '',
        urlLabel: 'Base URL (Optional Override)',
        keyless: false,
        known: false,
    };
}

/**
 * Fill in what the user has not typed yet when the provider changes.
 *
 * Only touches fields that are EMPTY or still hold a previous auto-suggestion —
 * typing must never be overwritten. The name check mirrors the old behaviour: a
 * value ending in " Connection" / " Instance" was itself auto-generated.
 *
 * @returns {{name?: string, model?: string}} the changes to apply
 */
export function suggestForProvider(id, current = {}) {
    const p = BY_ID.get(id);
    if (!p) return {};
    const out = {};
    const name = String(current.name || '');
    if (!name || name.endsWith(' Connection') || name.endsWith(' Instance')) {
        out.name = `${p.id.toUpperCase()} Connection`;
    }
    if (!String(current.model || '').trim()) out.model = p.model;
    return out;
}

/** The base URL to prefill when a provider is chosen. '' means "make them type it". */
export function defaultBaseUrl(id) {
    const p = BY_ID.get(id);
    if (!p) return '';
    // Generic exists precisely because the endpoint is unknown, so never guess one.
    return p.id === 'generic' ? '' : p.urlHint;
}

/**
 * Which connection the agent will actually use.
 *
 * With nothing chosen yet the FIRST connection is the effective default. The table
 * has to agree with that or the ★ ACTIVE marker sits on no row while the agent
 * happily uses one.
 */
export function effectiveActiveId(instances, activeId) {
    const list = Array.isArray(instances) ? instances : [];
    if (activeId && list.some(i => i.id === activeId)) return activeId;
    return list.length ? list[0].id : null;
}

/**
 * Is this connection instance usable?
 *
 * Returns the reasons it is not, so the form can say which field is at fault
 * instead of refusing to save with no explanation.
 *
 * @returns {string[]} empty when valid
 */
export function validateInstance(inst = {}) {
    const errors = [];
    if (!String(inst.name || '').trim()) errors.push('Connection name is required.');
    if (!String(inst.model || '').trim()) errors.push('Model is required.');
    const p = BY_ID.get(inst.provider);
    if (!p) {
        errors.push('Pick a provider.');
    } else {
        if (!p.keyless && !String(inst.api_key || '').trim()) {
            errors.push(`An API key is required for ${p.label}.`);
        }
        // Generic has no default endpoint to fall back on, so a missing URL is fatal
        // rather than merely unset.
        if (p.id === 'generic' && !String(inst.base_url || '').trim()) {
            errors.push('Base URL is required for a generic OpenAI-compatible endpoint.');
        }
    }
    return errors;
}
