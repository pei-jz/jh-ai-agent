// configModel — PURE settings logic: the tab list, the localStorage-backed
// allowlists, and the wire payload the whole config is saved as.
//
// Extracted from ConfigView.js during the Svelte migration. `buildConfigPayload`
// is the valuable one: it encodes several rules that were learned the hard way
// (see the comments on each) and lived inside a 90-line method on a view class,
// so the only way to check "does choosing (not set) actually clear the model?"
// was to drive the whole Settings page.

import { approvedPatternRefusal } from './configForm.js';

/** The vertical tab strip, in order. */
export const CONFIG_TABS = [
    { id: 'llm', icon: 'llm', label: 'LLM Settings' },
    { id: 'mcp', icon: 'mcp', label: 'MCP Settings' },
    { id: 'general', icon: 'gear', label: 'General Settings' },
    { id: 'templates', icon: 'template', label: 'Templates' },
    { id: 'skills', icon: 'bolt', label: 'Skills' },
    // API Logs moved to the Monitor view (per-task raw payloads).
    { id: 'rag', icon: 'search', label: 'RAG Indexing' },
    // Memory and Usage are both DESTINATIONS now, not tabs
    // (docs/design/information-architecture.md §7 step 4 and its §11 correction).
    // Reviewing what the agent believes is not a setting, and neither is looking
    // at what the month cost — Settings is where you change how the app behaves
    // and then leave.
];

export const APPROVED_COMMANDS_KEY = 'jhai_approved_commands';
export const AUTO_APPROVE_WS_KEY = 'jhai_autoapprove_workspaces';
const SECTIONS_KEY = 'jhai_settings_sections';

export function readList(key) {
    try {
        const a = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(a) ? a.map(String) : [];
    } catch (_) { return []; }
}

export function writeList(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) { /* private mode */ }
}

/**
 * Add to a localStorage-backed allowlist.
 *
 * The approved-COMMANDS list is a safety boundary: a bare "*" and anything
 * classified dangerous are refused here, so the rule holds no matter which
 * surface added the pattern.
 *
 * @returns {{ok: true, list: string[]} | {ok: false, reason: string}}
 */
export function addToList(key, value, classify) {
    if (key === APPROVED_COMMANDS_KEY) {
        const refusal = approvedPatternRefusal(value, classify);
        if (refusal) return { ok: false, reason: refusal };
    }
    const list = readList(key);
    if (!list.includes(value)) list.push(value);
    writeList(key, list);
    return { ok: true, list };
}

export function removeFromList(key, value) {
    const list = readList(key).filter(v => v !== value);
    writeList(key, list);
    return list;
}

/** Which General sections are open. Persisted so a long tab stays where it was. */
export function readOpenSections() {
    try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}'); }
    catch (_) { return {}; }
}

export function writeOpenSection(key, open) {
    const s = readOpenSections();
    s[key] = !!open;
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(s)); } catch (_) { /* private mode */ }
    return s;
}

/**
 * Serialize an Agent Safety Limit field for the wire.
 *
 * A numeric 0 is sent EXPLICITLY (not null) when the user chose
 * "disabled/unlimited", so the backend stores the intent. `null` goes only when
 * the value is genuinely missing, which is what makes the backend's
 * preservation logic fall back to the previously-saved value.
 */
export function limitValue(v) {
    if (v === null || v === undefined) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Which connection should be the default after this save.
 *
 * Promotes the first instance when none is set, and re-promotes when the stored
 * id no longer matches anything — otherwise deleting the active connection
 * leaves the agent pointing at nothing.
 */
export function resolveActiveInstanceId(instances, current) {
    const list = Array.isArray(instances) ? instances : [];
    let activeId = current;
    if (!activeId && list.length > 0) activeId = list[0].id;
    if (activeId && !list.some(i => i.id === activeId)) activeId = list[0]?.id || null;
    return activeId ?? null;
}

/**
 * Build the object sent to `updateConfig`.
 *
 * @param {object} config the live config
 * @param {string|object} promptTemplates already in its config shape
 * @throws {Error} when the MCP text is not valid JSON — the caller owns the message
 */
export function buildConfigPayload(config, promptTemplates) {
    let mcpConfig = {};
    if (config.mcp_text) {
        try {
            mcpConfig = JSON.parse(config.mcp_text);
        } catch (e) {
            throw new Error('Invalid MCP configuration JSON format: ' + e.message);
        }
    }

    return {
        openai_key: config.openai_key || null,
        anthropic_key: config.anthropic_key || null,
        gemini_key: config.gemini_key || null,
        azure_key: config.azure_key || null,
        azure_endpoint: config.azure_endpoint || null,
        azure_deployment: config.azure_deployment || null,
        tavily_api_key: config.tavily_api_key || null,
        proxy_url: config.proxy_url,
        output_language: config.output_language || 'Japanese',
        logging_enabled: config.logging_enabled,
        log_dir: config.log_dir,
        max_steps: limitValue(config.max_steps),
        approved_projects: config.approved_projects || [],
        write_allowed_paths: config.write_allowed_paths || [],
        fetch_allowed_hosts: config.fetch_allowed_hosts || [],
        mcp_servers: mcpConfig,
        llm_instances: config.llm_instances,
        active_llm_instance_id: resolveActiveInstanceId(config.llm_instances, config.active_llm_instance_id),
        // Agent Safety Limits — 0 means "disabled" (sent explicitly, not as null)
        token_budget: limitValue(config.token_budget),
        wall_clock_minutes: limitValue(config.wall_clock_minutes),
        no_progress_window: limitValue(config.no_progress_window),
        identical_call_threshold: limitValue(config.identical_call_threshold),
        cycle_detection_min_repeats: limitValue(config.cycle_detection_min_repeats),
        escalate_at_step: limitValue(config.escalate_at_step),
        agent_temperature: config.agent_temperature ?? null,
        history_compress_ratio: config.history_compress_ratio ?? null,
        plan_mode: config.plan_mode || 'auto',
        subagent_review: config.subagent_review || 'off',
        memory_recall: config.memory_recall || 'on',
        phase_routing: config.phase_routing || 'off',
        episode_injection: config.episode_injection || 'off',
        // `??`, NOT `||`. "(not set)" sends an EMPTY STRING as the explicit clear
        // sentinel — `||` collapsed it to null, which the backend's field-wise
        // merge reads as "the caller didn't mention this" and restores the
        // previous model. That was the reported bug: choosing "(not set)"
        // appeared to save and came back with the old model.
        // See normalizeModelId + clear_blank_routing (ai_config.rs).
        fast_model_id: config.fast_model_id ?? null,
        deep_model_id: config.deep_model_id ?? null,
        prompt_templates: promptTemplates,
    };
}

/**
 * Fold a normalized patch into a config object, returning a NEW one.
 *
 * The components already applied each field's rule (views/config/configForm.js),
 * so this stays dumb on purpose — the one exception being `undefined`, which the
 * secret normalizer uses to mean "leave the stored value alone".
 */
export function applyConfigPatch(config, patch) {
    const next = { ...config };
    for (const [k, v] of Object.entries(patch || {})) {
        if (v === undefined) continue;
        next[k] = v;
    }
    return next;
}

/** Insert or update a connection, returning a NEW list plus the active id. */
export function upsertInstance(instances, next, activeId) {
    const list = Array.isArray(instances) ? [...instances] : [];
    const at = next.id ? list.findIndex(i => i.id === next.id) : -1;

    if (at >= 0) {
        // The EXISTING name wins over the provider default. The original wrote
        // `next.name || \`${next.provider} Connection\`` unconditionally, so an
        // update that carried no name renamed the connection — and when it also
        // carried no provider, renamed it to "undefined Connection".
        const name = next.name || list[at].name || `${next.provider} Connection`;
        list[at] = { ...list[at], ...next, name };
        return { instances: list, activeId };
    }
    const created = { ...next, id: `inst_${Date.now()}`, name: next.name || `${next.provider} Connection` };
    list.push(created);
    // The first connection becomes the default: an agent with a connection it
    // will not use is a confusing empty state.
    const nextActive = (list.length === 1 && !activeId) ? created.id : activeId;
    return { instances: list, activeId: nextActive };
}

/** Remove a connection, clearing the active id when it was the one removed. */
export function removeInstance(instances, id, activeId) {
    const list = (Array.isArray(instances) ? instances : []).filter(i => i.id !== id);
    // Drop the reference when the active one goes, so the next resolve
    // auto-promotes the first remaining instance rather than marking none.
    return { instances: list, activeId: activeId === id ? null : activeId };
}
