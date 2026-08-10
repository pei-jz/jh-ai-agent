// onboarding — mount the first-run wizard, and do what it asks.
//
// Kept out of main.js so the boot sequence stays readable: main.js asks one question
// ("is setup needed?") and calls one function. Everything the wizard actually DOES —
// saving a connection, probing it, registering a workspace — lives here.
//
// Whether it appears at all is decided by views/onboarding/steps.js from the real
// config, not from a "has run" flag. See the note there.

import { invoke } from '@tauri-apps/api/core';
import Onboarding from './svelte/onboarding/Onboarding.svelte';
import { ONBOARDING_STYLES } from './svelte/onboarding/onboarding.styles.js';
import { mountComponent, destroyComponent } from './svelte/mount.svelte.js';
import {
    readSetupState, shouldShowOnboarding, initialStep, rememberSkip, clearSkip,
} from './views/onboarding/steps.js';
import { providerInfo } from './views/config/providers.js';

const HOST_ID = 'jhai-onboarding';

function ensureStyles() {
    if (document.getElementById('ob-styles')) return;
    const el = document.createElement('style');
    el.id = 'ob-styles';
    el.textContent = ONBOARDING_STYLES;
    document.head.appendChild(el);
}

function host() {
    let el = document.getElementById(HOST_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = HOST_ID;
        document.body.appendChild(el);
    }
    return el;
}

/** Read the saved config, tolerating a backend that is not ready yet. */
async function loadConfig() {
    try { return await invoke('get_ai_config') || {}; } catch (_) { return {}; }
}

const isKeyless = (id) => providerInfo(id).keyless;

/**
 * Open the wizard.
 *
 * Exported separately from the launch check so Settings can offer "run setup again" —
 * which also clears the remembered skip, or the next launch would silently suppress it.
 */
export async function openOnboarding() {
    ensureStyles();
    clearSkip(window.localStorage);
    await mountWizard();
}

/**
 * Show the wizard IF first-run setup is still needed. Called once on boot.
 * @returns {Promise<boolean>} whether it was shown
 */
export async function maybeShowOnboarding() {
    const config = await loadConfig();
    const state = readSetupState(config, isKeyless, window.localStorage);
    if (!shouldShowOnboarding(state)) return false;
    ensureStyles();
    await mountWizard(state);
    return true;
}

/** Mount (or re-push) the wizard with freshly read state. */
async function mountWizard(known = null) {
    const config = await loadConfig();
    const state = known || readSetupState(config, isKeyless, window.localStorage);
    // `step` is held here rather than in the component so a re-push after saving a
    // connection can advance it — the component is a view of this state, not its owner.
    if (mountWizard._step === undefined) mountWizard._step = initialStep(state);

    mountComponent(Onboarding, host(), {
        setup: state,
        step: mountWizard._step,
        testStatus: mountWizard._test || null,
        workspaces: Array.isArray(config.approved_projects) ? config.approved_projects : [],
        onStep: (n) => { mountWizard._step = n; mountWizard._test = null; mountWizard(); },
        onSkip: () => { rememberSkip(window.localStorage); close(); },
        onFinish: () => close(),
        onSaveConnection: (inst) => saveConnection(inst),
        onTestConnection: (inst) => testConnection(inst),
        onPickWorkspace: () => pickWorkspace(),
        onRemoveWorkspace: (ws) => removeWorkspace(ws),
    });
}

function close() {
    destroyComponent(document.getElementById(HOST_ID));
    document.getElementById(HOST_ID)?.remove();
    mountWizard._step = undefined;
    mountWizard._test = null;
}

/**
 * Persist the connection, then make it the active one.
 *
 * Setting it active matters: a first connection that is saved but not selected leaves
 * the agent with nothing to call, which is the exact dead end the wizard exists to
 * prevent. `llmService.initFromConfig` is re-run so the choice takes effect without a
 * restart.
 */
async function saveConnection(inst) {
    const config = await loadConfig();
    const instances = Array.isArray(config.llm_instances) ? [...config.llm_instances] : [];
    const created = { ...inst, id: `inst_${Date.now()}` };
    instances.push(created);

    try {
        // Through the API client, exactly like Settings does. The backend merges
        // field-wise, so sending only what changed avoids overwriting the masked
        // secrets it hands back on read.
        await window.apiClient.updateConfig({
            llm_instances: instances,
            active_llm_instance_id: config.active_llm_instance_id || created.id,
        });
    } catch (e) {
        mountWizard._test = { state: 'fail', message: `❌ 保存に失敗しました: ${e?.message || e}` };
        await mountWizard();
        return;
    }

    try {
        const { default: llmService } = await import('../modules/ai/LLMService.js');
        llmService.clearSessionModelLock();
        await llmService.initFromConfig();
    } catch (e) {
        console.warn('Onboarding: could not refresh LLMService:', e);
    }

    mountWizard._test = { state: 'ok', message: '✅ 接続を保存しました。' };
    mountWizard._step = 1;
    await mountWizard();
}

/** Probe the endpoint with what is currently in the form. */
async function testConnection(inst) {
    if (!String(inst.model || '').trim()) {
        mountWizard._test = { state: 'fail', message: '❌ モデル名を入力してください。' };
        await mountWizard();
        return;
    }
    mountWizard._test = { state: 'testing', message: '🔍 接続を確認しています…' };
    await mountWizard();
    try {
        if (!window.apiClient) throw new Error('API client not ready');
        const res = await window.apiClient.testConnection({
            provider: inst.provider,
            model: inst.model,
            api_key: inst.api_key || null,
            base_url: inst.base_url || null,
            api_version: null,
        });
        mountWizard._test = res.success
            ? { state: 'ok', message: '✅ 接続できました。' }
            : { state: 'fail', message: `❌ 失敗: ${res.message}` };
    } catch (e) {
        mountWizard._test = { state: 'fail', message: `❌ エラー: ${e?.message || e}` };
    }
    await mountWizard();
}

/**
 * Add a workspace folder.
 *
 * Also registers it with the Rust path guard, so the agent can actually write there.
 * Saving the path without that produces "operation blocked" on the first real task —
 * a setup step that looks complete and is not.
 */
async function pickWorkspace() {
    let picked = null;
    try { picked = await invoke('select_folder'); } catch (_) { return; }
    if (!picked) return;

    const config = await loadConfig();
    const projects = Array.isArray(config.approved_projects) ? [...config.approved_projects] : [];
    if (!projects.includes(picked)) projects.push(picked);
    try {
        await window.apiClient.updateConfig({ approved_projects: projects });
        await invoke('set_allowed_roots', { roots: projects });
    } catch (e) {
        console.warn('Onboarding: could not save the workspace:', e);
    }
    await mountWizard();
}

async function removeWorkspace(ws) {
    const config = await loadConfig();
    const projects = (Array.isArray(config.approved_projects) ? config.approved_projects : [])
        .filter(p => p !== ws);
    try {
        await window.apiClient.updateConfig({ approved_projects: projects });
    } catch (e) {
        console.warn('Onboarding: could not remove the workspace:', e);
    }
    await mountWizard();
}
