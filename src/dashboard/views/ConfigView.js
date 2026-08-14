import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';
import { icon } from '../utils/icons.js';
import { classifyCommand } from '../../modules/ai/tools/commandPolicy.js';
// The stored-length cap for one fact. This tab is a WRITE path into facts.json,
// so it has to respect the same limit the agent's own writes do.
import { capFactText } from '../../modules/ai/memory/FactStore.js';
// The `.agent/` reader/writer, shared with the Dashboard's memory panel. It used
// to live here as four path strings and three parsers; a second copy in another
// view is how cards.jsonl would have ended up written as a JSON array by one of
// them and appended to by the agent as JSON Lines.
import {
    memoryPaths, readWorkspaceMemory, allowMemoryDir,
    writeCards, writeFacts, writeEpisodes, readOverview, writeOverview,
} from '../../modules/ai/memory/workspaceMemory.js';
import { CONFIG_SECTION_STYLES, CONFIG_MODAL_STYLES } from './ConfigView.styles.js';
// MIGRATED regions (region 5 of docs/design/svelte-migration.md). The provider
// table they share is views/config/providers.js.
import ConnectionTable from '../svelte/config/ConnectionTable.svelte';
import ConnectionModal from '../svelte/config/ConnectionModal.svelte';
import SettingsGeneral from '../svelte/config/SettingsGeneral.svelte';
import {
    licenseState, hasStoredKey, activateLicense, clearLicense,
    licensingConfigured, refreshLicense,
} from '../license.js';
import { getLocale, setLocale, t } from '../../i18n/index.js';
import SettingsMcp from '../svelte/config/SettingsMcp.svelte';
import TemplatesTab from '../svelte/config/TemplatesTab.svelte';
import SkillsTab from '../svelte/config/SkillsTab.svelte';
import RagTab from '../svelte/config/RagTab.svelte';
import MemoryTab from '../svelte/config/MemoryTab.svelte';
import { approvedPatternRefusal } from './config/configForm.js';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';

/** Every host id a migrated region mounts into — teardown walks this list. */
const MOUNT_HOSTS = [
    'cfg-conn-table', 'cfg-conn-modal', 'cfg-general-panel', 'cfg-mcp-panel',
    'cfg-templates-panel', 'cfg-skills-panel', 'cfg-rag-panel', 'cfg-memory-panel',
];

export class ConfigView {
    constructor() {
        this.config = {
            openai_key: '',
            anthropic_key: '',
            gemini_key: '',
            azure_key: '',
            azure_endpoint: '',
            azure_deployment: '',
            tavily_api_key: '',
            proxy_url: '',
            logging_enabled: false,
            log_dir: '',
            max_steps: 0,
            approved_projects: [],
            write_allowed_paths: [],
            mcp_servers: {},
            llm_instances: [],
            active_llm_instance_id: null,
            // ── Agent Safety Limits (0 / null = unlimited / disabled) ──
            token_budget: 0,
            wall_clock_minutes: 0,
            no_progress_window: 15,
            identical_call_threshold: 5,
            cycle_detection_min_repeats: 3
        };
        this.loaded = false;
        this.activeTab = 'llm'; // Tab: 'llm', 'mcp', 'general', 'logs', 'templates', 'skills', 'rag', 'memory'

        // ── 🧠 Memory tab state ──────────────────────────────────────────
        // null = not loaded yet (shows the "select a workspace" hint).
        this.memoryWorkspace = '';
        this.memoryFacts = null;
        this.memoryEpisodes = null;
        this.memoryCards = null;
        this.memoryOverview = null;
        /** compareArms() over .agent/trace/metrics.jsonl — null until a run exists. */
        this.abStats = null;
        this.showModal = false;
        this.editingInstance = null; // null if adding new
        // Test-connection result for the modal: {state, message} or null.
        this._connTestStatus = null;
        this.logsList = [];
        this.logsError = '';

        // Templates tab state
        this.editingTemplate = null; // null = new, else { key, label, prompt, icon }
        this.showTemplateForm = false;

        // Skills tab state
        this.skillsList = [];         // [{ name, title, path }]
        this.editingSkill = null;     // null = none, else { name, content }
        this.showSkillForm = false;
        this.ragPath = '';
        this.ragDirs = [];
        this.ragExclusions = [];
        this.ragExtensions = ['js', 'jsx', 'ts', 'tsx', 'rs', 'java', 'py', 'md', 'txt', 'html', 'css', 'json', 'xml'];
        this.ragStatus = '';
        this.ragProgress = 0;
        this._ragUnlisten = null;
    }

    async loadConfig() {
        try {
            if (window.apiClient) {
                const cfg = await window.apiClient.getConfig();
                this.config = { ...this.config, ...cfg };
                if (this.config.mcp_servers) {
                    this.config.mcp_text = JSON.stringify(this.config.mcp_servers, null, 2);
                } else {
                    this.config.mcp_text = '{}';
                }
                if (!this.config.llm_instances) {
                    this.config.llm_instances = [];
                }
                promptTemplateManager.loadFromConfig(this.config);
                this.loaded = true;
            }
        } catch (e) {
            console.error("Failed to load config:", e);
        }
    }

    async loadSkills() {
        await skillManager.refresh();
        this.skillsList = skillManager.getAll();
    }

    /**
     * Push the General and MCP tab bodies.
     *
     * These replace `readFormValues()`, which read every field back out of the DOM
     * by id (90 lines). The components report a normalized PATCH per change and
     * `_applyConfigPatch` folds it straight into this.config, so the form and the
     * config can never disagree — and a renamed field fails loudly instead of
     * silently stopping saving.
     */
    _syncGeneralTabs() {
        const mcpHost = document.getElementById('cfg-mcp-panel');
        if (mcpHost) {
            mountComponent(SettingsMcp, mcpHost, {
                text: this.config.mcp_text || '{}',
                onChange: (text) => { this.config.mcp_text = text.trim(); },
            });
        }

        const genHost = document.getElementById('cfg-general-panel');
        if (!genHost) return;
        this._general = mountComponent(SettingsGeneral, genHost, {
            config: this.config,
            connection: {
                token: window.apiClient ? window.apiClient.token : '',
                port: window.apiClient ? window.apiClient.port : '14300',
            },
            openSections: this._readOpenSections(),
            approvedCommands: this._lsList('jhai_approved_commands'),
            autoApproveWorkspaces: this._lsList('jhai_autoapprove_workspaces'),
            storageUsage: this._storageUsageHtml || '',
            exportStatus: this._exportStatus || '',
            onChange: (patch) => this._applyConfigPatch(patch),
            onToggleSection: (key, open) => this._writeOpenSection(key, open),
            onSelectLogDir: () => this._pickLogDir(),
            onCopyToken: () => this._copyConnectionToken(),
            onExportConnection: () => this._exportConnection(),
            onRefreshStorage: () => this._renderStorageUsage(),
            onPurgeApiLogs: () => this._purgeApiLogs(),
            onClearCommLog: () => this._clearCommLog(),
            onAddApprovedCommand: (v) => this._lsAdd('jhai_approved_commands', v),
            onRemoveApprovedCommand: (v) => this._lsRemove('jhai_approved_commands', v),
            onRunSetup: async () => {
                const { openOnboarding } = await import('../onboarding.js');
                await openOnboarding();
            },
            onAddAutoWorkspace: (v) => this._lsAdd('jhai_autoapprove_workspaces', v),
            onRemoveAutoWorkspace: (v) => this._lsRemove('jhai_autoapprove_workspaces', v),
            appVersion: this._appVersion || '',
            updatesConfigured: !!this._updatesConfigured,
            uiLocale: getLocale(),
            onChangeLocale: (code) => {
                // Re-render the whole dashboard, not just this tab: the switcher lives
                // in Settings but the strings it changes are everywhere.
                if (setLocale(code) === code) window.dashboard?.render?.();
            },
            license: licenseState(),
            licensingConfigured: !!this._licensingConfigured,
            hasLicenseKey: hasStoredKey(),
            onActivateLicense: async (key) => {
                await activateLicense(key);
                this._syncGeneralTabs();
            },
            onClearLicense: async () => {
                await clearLicense();
                this._syncGeneralTabs();
            },
            onCheckUpdate: async () => {
                const { checkForUpdate } = await import('../updater.js');
                // Not silent: the user asked, so "you are up to date" and any failure
                // both need to be said out loud.
                await checkForUpdate({ silent: false });
            },
        });
        this._loadBuildInfo();
    }

    /**
     * Fill in the version and whether updates are signed, once.
     *
     * Both come from the Tauri side and neither changes while the app runs, so this
     * resolves in the background and re-pushes rather than blocking the tab's render.
     */
    _loadBuildInfo() {
        if (this._buildInfoLoaded) return;
        this._buildInfoLoaded = true;
        (async () => {
            try {
                const [{ getVersion }, { isUpdaterConfigured }] = await Promise.all([
                    import('@tauri-apps/api/app'),
                    import('../updater.js'),
                ]);
                this._appVersion = await getVersion();
                this._updatesConfigured = await isUpdaterConfigured();
                this._licensingConfigured = await licensingConfigured();
                await refreshLicense();
            } catch (_) {
                // Browser/dev mode: no Tauri. The tab then says updates are not
                // configured, which is true of a non-packaged build.
            }
            this._syncGeneralTabs();
        })();
    }

    /**
     * Push the four list-style tabs. Only the active one has a host, so the rest are
     * no-ops — cheaper than checking activeTab here, and it keeps the call sites simple.
     */
    _syncListTabs() {
        const tplHost = document.getElementById('cfg-templates-panel');
        if (tplHost) {
            mountComponent(TemplatesTab, tplHost, {
                templates: promptTemplateManager.getAll(),
                editing: this.editingTemplate,
                showForm: this.showTemplateForm,
                onNew: () => { this.editingTemplate = null; this.showTemplateForm = true; this.reRender(); },
                onCancel: () => { this.editingTemplate = null; this.showTemplateForm = false; this.reRender(); },
                onEdit: (key) => {
                    const t = promptTemplateManager.get(key);
                    if (!t) return;
                    this.editingTemplate = t;
                    this.showTemplateForm = true;
                    this.reRender();
                },
                onDelete: async (key) => {
                    if (!confirm('Delete the template "/' + key + '"?')) return;
                    promptTemplateManager.remove(key);
                    await this._saveTemplates();
                    this.reRender();
                },
                onSave: async (tpl) => {
                    // Already validated in the component (templateRefusal).
                    promptTemplateManager.set(tpl.key, tpl.label, tpl.prompt, tpl.icon);
                    await this._saveTemplates();
                    this.editingTemplate = null;
                    this.showTemplateForm = false;
                    this.reRender();
                },
            });
        }

        const skillHost = document.getElementById('cfg-skills-panel');
        if (skillHost) {
            mountComponent(SkillsTab, skillHost, {
                skills: this.skillsList || [],
                editing: this.editingSkill,
                showForm: this.showSkillForm,
                onNew: () => { this.editingSkill = null; this.showSkillForm = true; this.reRender(); },
                onCancel: () => { this.editingSkill = null; this.showSkillForm = false; this.reRender(); },
                onEdit: async (name) => {
                    try {
                        const content = await skillManager.readContent(name);
                        this.editingSkill = { name, content };
                        this.showSkillForm = true;
                        this.reRender();
                    } catch (e) {
                        alert('Failed to load skill: ' + (e.message || e));
                    }
                },
                onDelete: async (name) => {
                    if (!confirm('Delete the skill "/' + name + '"?')) return;
                    try {
                        await skillManager.delete(name);
                        this.skillsList = skillManager.getAll();
                        this.reRender();
                    } catch (e) {
                        alert('Failed to delete: ' + (e.message || e));
                    }
                },
                onSave: async (skill) => {
                    try {
                        await skillManager.save(skill.name, skill.content);
                        this.skillsList = skillManager.getAll();
                        this.editingSkill = null;
                        this.showSkillForm = false;
                        this.reRender();
                    } catch (e) {
                        alert('Failed to save: ' + (e.message || e));
                    }
                },
            });
        }

        const ragHost = document.getElementById('cfg-rag-panel');
        if (ragHost) {
            mountComponent(RagTab, ragHost, {
                path: this.ragPath,
                dirs: this.ragDirs,
                exclusions: this.ragExclusions,
                extensions: this.ragExtensions,
                progress: this.ragProgress,
                onPathChange: (v) => { this.ragPath = v.trim(); },
                onLoadDirs: () => this._loadRagDirs(),
                // The component hands back the directory AND its descendants, so the
                // cascade is one model update instead of a DOM walk.
                onToggleDir: (paths, include) => {
                    const set = new Set(this.ragExclusions);
                    for (const p of paths) { if (include) set.delete(p); else set.add(p); }
                    this.ragExclusions = [...set];
                    this._syncListTabs();
                },
                onToggleExtension: (ext, on) => {
                    const set = new Set(this.ragExtensions);
                    if (on) set.add(ext); else set.delete(ext);
                    this.ragExtensions = [...set];
                    this._syncListTabs();
                },
            });
        }

        const memHost = document.getElementById('cfg-memory-panel');
        if (memHost) {
            const projects = Array.isArray(this.config.approved_projects) ? this.config.approved_projects : [];
            mountComponent(MemoryTab, memHost, {
                workspace: this.memoryWorkspace || projects[0] || '',
                projects,
                facts: this.memoryFacts,
                episodes: this.memoryEpisodes,
                cards: this.memoryCards,
                onWorkspaceChange: (v) => { this.memoryWorkspace = v.trim(); },
                onBrowse: async () => {
                    try {
                        const sel = await invoke('select_folder');
                        if (sel) { this.memoryWorkspace = sel; this._syncListTabs(); }
                    } catch (_) { /* dialog cancelled */ }
                },
                onLoad: async () => {
                    if (!this.memoryWorkspace) { alert('Please enter a workspace path.'); return; }
                    await this.loadMemoryData();
                    await this._loadIndexStats();
                    await this._loadAbStats();
                    this._syncListTabs();
                },
                indexStats: this.indexStats || null,
                abStats: this.abStats || null,
                overview: this.memoryOverview || null,
                onSaveOverview: (text) => this._saveOverview(text),
                studying: !!this._studying,
                studyStatus: this._studyStatus || '',
                onStudy: () => this._runStudy(),
                onEditFact: (i, text) => this._mutateFacts(list => { list[i].fact = capFactText(text); }),
                onDeleteFact: (i) => {
                    if (!confirm('Delete this fact?')) return;
                    this._mutateFacts(list => { list.splice(i, 1); });
                },
                onClearFacts: () => {
                    if (!confirm('Delete ALL durable facts?')) return;
                    this._mutateFacts(list => { list.length = 0; });
                },
                onDeleteEpisode: (i) => {
                    if (!confirm('Delete this episode?')) return;
                    this._mutateEpisodes(list => { list.splice(i, 1); });
                },
                // Switching a card off keeps it (it can come back) but takes it out
                // of recall — CardStore scores a disabled card at zero.
                onToggleCard: (i, disabled) => this._mutateCards(list => { list[i].disabled = disabled; }),
                onDeleteCard: (i) => {
                    if (!confirm('Delete this learned card?')) return;
                    this._mutateCards(list => { list.splice(i, 1); });
                },
                onClearCards: () => {
                    if (!confirm('Delete ALL learned cards?')) return;
                    this._mutateCards(list => { list.length = 0; });
                },
                onClearEpisodes: () => {
                    if (!confirm('Delete ALL session history?')) return;
                    this._mutateEpisodes(list => { list.length = 0; });
                },
            });
        }
    }

    /** Load the directory tree the RAG picker offers. */
    async _loadRagDirs() {
        if (!this.ragPath) return;
        try {
            this.ragDirs = await invoke('get_directory_structure', { path: this.ragPath, maxDepth: 5 });
            this.ragExclusions = [];
            this._syncListTabs();
        } catch (e) {
            alert('Failed to load directories: ' + e);
        }
    }

    /**
     * Mutate facts.json and write it back.
     *
     * On a write failure the on-disk state is RELOADED rather than left disagreeing
     * with the screen — this tab exists so a wrong memory can be corrected, so it has
     * to be trustworthy about what is actually stored.
     */
    async _mutateFacts(fn) {
        if (!Array.isArray(this.memoryFacts)) return;
        fn(this.memoryFacts);
        this._syncListTabs();
        try {
            await this.saveMemoryFacts();
        } catch (e) {
            alert('Failed to save facts.json: ' + e);
            await this.loadMemoryData();
            this._syncListTabs();
        }
    }

    /** Same contract as _mutateFacts, for the experience cards. */
    async _mutateCards(fn) {
        if (!Array.isArray(this.memoryCards)) return;
        fn(this.memoryCards);
        this._syncListTabs();
        try {
            await this.saveMemoryCards();
        } catch (e) {
            alert('Failed to save cards.jsonl: ' + e);
            await this.loadMemoryData();
            this._syncListTabs();
        }
    }

    async _mutateEpisodes(fn) {
        if (!Array.isArray(this.memoryEpisodes)) return;
        fn(this.memoryEpisodes);
        this._syncListTabs();
        try {
            await this.saveMemoryEpisodes();
        } catch (e) {
            alert('Failed to save memory.json: ' + e);
            await this.loadMemoryData();
            this._syncListTabs();
        }
    }

    /**
     * Fold a normalized patch into the live config.
     *
     * The components already applied the field's rule (see views/config/configForm.js),
     * so this stays dumb on purpose — the one exception being `undefined`, which the
     * secret normalizer uses to mean "leave the stored value alone".
     */
    _applyConfigPatch(patch) {
        for (const [k, v] of Object.entries(patch || {})) {
            if (v === undefined) continue;
            this.config[k] = v;
        }
        // Re-push so derived UI (the routing selects' option list, the logging
        // toggle) reflects the change.
        this._syncGeneralTabs();
    }

    /** Which General sections are open. Persisted so a long tab stays where it was. */
    _readOpenSections() {
        try { return JSON.parse(localStorage.getItem('jhai_settings_sections') || '{}'); }
        catch (_) { return {}; }
    }

    _writeOpenSection(key, open) {
        const s = this._readOpenSections();
        s[key] = !!open;
        try { localStorage.setItem('jhai_settings_sections', JSON.stringify(s)); } catch (_) {}
    }

    /**
     * Add to a localStorage-backed allowlist.
     *
     * The approved-COMMANDS list is a safety boundary: a bare "*" and anything
     * classified dangerous are refused here, so the rule holds no matter which
     * surface added the pattern.
     */
    _lsAdd(key, value) {
        if (key === 'jhai_approved_commands') {
            const refusal = approvedPatternRefusal(value, classifyCommand);
            if (refusal) { alert(refusal); return; }
        }
        const list = this._lsList(key);
        if (!list.includes(value)) list.push(value);
        this._lsSave(key, list);
        this._syncGeneralTabs();
    }

    _lsRemove(key, value) {
        this._lsSave(key, this._lsList(key).filter(v => v !== value));
        this._syncGeneralTabs();
    }

    async _pickLogDir() {
        try {
            const selected = await invoke('select_folder');
            if (selected) this._applyConfigPatch({ log_dir: selected });
        } catch (e) {
            console.error('Failed to select folder:', e);
        }
    }

    _copyConnectionToken() {
        const token = window.apiClient ? window.apiClient.token : '';
        if (token) navigator.clipboard.writeText(token);
    }

    _purgeApiLogs() {
        if (!confirm('Delete the old API logs (localStorage jh_api_logs)? This does not affect Monitor per-task logs.')) return;
        try { localStorage.removeItem('jh_api_logs'); } catch (_) {}
        this._renderStorageUsage();
    }

    async _clearCommLog() {
        if (!confirm('Clear the communication log file?')) return;
        try { await invoke('clear_comm_log'); } catch (e) { console.error(e); }
        this._renderStorageUsage();
    }

    /** Write host/port/token where sibling JH apps look for them. */
    async _exportConnection() {
        if (!window.apiClient) {
            this._exportStatus = '<span class="cfg-err">API client not ready.</span>';
            this._syncGeneralTabs();
            return;
        }
        this._exportStatus = '<span class="cfg-muted">Exporting…</span>';
        this._syncGeneralTabs();
        try {
            const written = await invoke('export_connection_config', {
                port: Number(window.apiClient.port) || 14300,
                token: window.apiClient.token || '',
            });
            this._exportStatus = `<span class="cfg-ok">Wrote: <code>${escapeHtml(String(written))}</code></span>`;
        } catch (e) {
            this._exportStatus = `<span class="cfg-err">Export failed: ${escapeHtml(String(e.message || e))}</span>`;
        }
        this._syncGeneralTabs();
    }

    /**
     * Read the current form into this.config, build the wire payload, and
     * persist it via the API — the single source of truth for "save the whole
     * config". Both the "Save Settings" button and the connection modal's
     * "Save Connection" button call this so editing a connection is durable
     * immediately, without a separate Save Settings click.
     *
     * Throws on invalid MCP JSON or API failure; callers own the UI feedback.
     */
    async persistConfig() {

        let mcpConfig = {};
        if (this.config.mcp_text) {
            try {
                mcpConfig = JSON.parse(this.config.mcp_text);
            } catch (e) {
                throw new Error("Invalid MCP configuration JSON format: " + e.message);
            }
        }

        // If no active id is set but instances exist, default to the first one
        let activeId = this.config.active_llm_instance_id;
        if (!activeId && this.config.llm_instances && this.config.llm_instances.length > 0) {
            activeId = this.config.llm_instances[0].id;
        }
        // If the active id no longer matches a real instance, clear it
        if (activeId && !this.config.llm_instances.some(i => i.id === activeId)) {
            activeId = this.config.llm_instances[0]?.id || null;
        }

        // Helper: serialize an Agent Safety Limit field for the wire.
        // We send a numeric 0 explicitly (not null) when the user has
        // chosen "disabled/unlimited" so the backend stores intent clearly.
        // We send `null` only when the value is genuinely missing so the
        // backend's preservation logic falls back to the previously-saved value.
        const limit = (v) => {
            if (v === null || v === undefined) return null;
            const n = parseInt(v, 10);
            return Number.isFinite(n) && n >= 0 ? n : null;
        };

        const newConfig = {
            openai_key: this.config.openai_key || null,
            anthropic_key: this.config.anthropic_key || null,
            gemini_key: this.config.gemini_key || null,
            azure_key: this.config.azure_key || null,
            azure_endpoint: this.config.azure_endpoint || null,
            azure_deployment: this.config.azure_deployment || null,
            tavily_api_key: this.config.tavily_api_key || null,
            proxy_url: this.config.proxy_url,
            output_language:             (this.config.output_language || 'Japanese'),
            logging_enabled: this.config.logging_enabled,
            log_dir: this.config.log_dir,
            max_steps:                   limit(this.config.max_steps),
            approved_projects: this.config.approved_projects || [],
            write_allowed_paths: this.config.write_allowed_paths || [],
            mcp_servers: mcpConfig,
            llm_instances: this.config.llm_instances,
            active_llm_instance_id: activeId,
            // Agent Safety Limits — 0 means "disabled" (sent explicitly, not as null)
            token_budget:                limit(this.config.token_budget),
            wall_clock_minutes:          limit(this.config.wall_clock_minutes),
            no_progress_window:          limit(this.config.no_progress_window),
            identical_call_threshold:    limit(this.config.identical_call_threshold),
            cycle_detection_min_repeats: limit(this.config.cycle_detection_min_repeats),
            escalate_at_step:            limit(this.config.escalate_at_step),
            agent_temperature:           (this.config.agent_temperature ?? null),
            history_compress_ratio:      (this.config.history_compress_ratio ?? null),
            plan_mode:                   (this.config.plan_mode || 'auto'),
            subagent_review:             (this.config.subagent_review || 'off'),
            memory_recall:               (this.config.memory_recall || 'auto'),
            phase_routing:               (this.config.phase_routing || 'off'),
            // `??`, NOT `||`. "(not set)" sends an EMPTY STRING as the explicit
            // clear sentinel — `||` collapsed it to null, which the backend's
            // field-wise merge reads as "the caller didn't mention this" and
            // restores the previous model. That is the reported bug: choosing
            // "(not set)" appeared to save and came back with the old model.
            // See normalizeModelId + clear_blank_routing (ai_config.rs).
            fast_model_id:               (this.config.fast_model_id ?? null),
            deep_model_id:               (this.config.deep_model_id ?? null),
            prompt_templates:            promptTemplateManager.toConfigValue()
        };

        if (window.apiClient) {
            await window.apiClient.updateConfig(newConfig);

            // Push the active-instance change into LLMService so the
            // very next agent run / chat uses it without a restart.
            try {
                const { default: llmService } = await import('../../modules/ai/LLMService.js');
                // A saved default is authoritative — drop any earlier session
                // (dropdown) model lock so this choice actually takes effect.
                llmService.clearSessionModelLock();
                await llmService.initFromConfig();
            } catch (e) {
                console.warn('Could not refresh LLMService after save:', e);
            }
        }
    }

    // NOTE: getModalValue / getModalKeyPlaceholder / getModalUrlPlaceholder are
    // gone. The first fed `value="…"` attributes in a template literal (the form is
    // bound state now); the other two were two of the FOUR parallel provider
    // switches that had already drifted apart — views/config/providers.js is the
    // single table.

    /**
     * Push the LLM tab's two migrated regions: the connection table and, when open,
     * the add/edit modal.
     *
     * Both are re-pushed together because the modal's Save mutates the list the
     * table renders.
     */
    _syncLlmTab() {
        const tableHost = document.getElementById('cfg-conn-table');
        if (tableHost) {
            mountComponent(ConnectionTable, tableHost, {
                instances: this.config.llm_instances || [],
                activeId: this.config.active_llm_instance_id,
                onSetActive: (id) => this._setActiveInstance(id),
                onEdit: (id) => this._openInstanceModal(id),
                onDelete: (id) => this._deleteInstance(id),
            });
        }

        const modalHost = document.getElementById('cfg-conn-modal');
        if (!modalHost) return;
        if (!this.showModal) {
            destroyComponent(modalHost);
            return;
        }
        mountComponent(ConnectionModal, modalHost, {
            instance: this.editingInstance,
            testStatus: this._connTestStatus,
            onSave: (inst) => this._saveInstance(inst),
            onCancel: () => this._closeInstanceModal(),
            onTest: (inst) => this._testInstance(inst),
        });
    }

    /** Open the modal to add (no id) or edit an existing connection. */
    _openInstanceModal(id = null) {
        // Capture whatever is typed in the OTHER fields of this tab first: the modal
        // triggers a re-render, and unread inputs would be lost.
        this.editingInstance = id
            ? (this.config.llm_instances || []).find(i => i.id === id) || null
            : null;
        this._connTestStatus = null;
        this.showModal = true;
        this._syncLlmTab();
    }

    _closeInstanceModal() {
        this.showModal = false;
        this.editingInstance = null;
        this._connTestStatus = null;
        this._syncLlmTab();
    }

    /** Which connection the agent and Direct Chat use by default. */
    _setActiveInstance(id) {
        if (!id) return;
        this.config.active_llm_instance_id = id;
        this._syncLlmTab();
    }

    _deleteInstance(id) {
        if (!confirm('Are you sure you want to remove this connection instance?')) return;
        this.config.llm_instances = (this.config.llm_instances || []).filter(i => i.id !== id);
        // Drop the reference when the active one goes, so the next render
        // auto-promotes the first remaining instance rather than marking none.
        if (this.config.active_llm_instance_id === id) {
            this.config.active_llm_instance_id = null;
        }
        this._syncLlmTab();
    }

    /**
     * Create or update a connection, then persist immediately — the connection is
     * durable without a separate "Save Settings" click. On failure the in-memory
     * change stays so the user can retry.
     *
     * Validation already happened in the component (validateInstance).
     */
    async _saveInstance(next) {
        if (!Array.isArray(this.config.llm_instances)) this.config.llm_instances = [];
        const list = this.config.llm_instances;
        const existing = next.id ? list.find(i => i.id === next.id) : null;

        if (existing) {
            Object.assign(existing, next, { name: next.name || `${next.provider} Connection` });
        } else {
            const created = {
                ...next,
                id: `inst_${Date.now()}`,
                name: next.name || `${next.provider} Connection`,
            };
            list.push(created);
            // The first connection becomes the default: an agent with a connection
            // it will not use is a confusing empty state.
            if (list.length === 1 && !this.config.active_llm_instance_id) {
                this.config.active_llm_instance_id = created.id;
            }
        }

        this.showModal = false;
        this.editingInstance = null;
        this._connTestStatus = null;
        try {
            await this.persistConfig();
            showNotification('Connection saved.');
            // Reload so the masked key strings the backend returns replace the
            // plaintext we just sent.
            this.loaded = false;
            await this.loadConfig();
        } catch (e) {
            alert('Error saving connection: ' + (e.message || e));
        }
        this.reRender();
    }

    /** Probe the endpoint with the values currently in the form. */
    async _testInstance(inst) {
        if (!String(inst.model || '').trim()) {
            this._connTestStatus = { state: 'fail', message: 'Model Name is required to run a connection audit.' };
            this._syncLlmTab();
            return;
        }
        this._connTestStatus = { state: 'testing', message: '🔍 Connecting to endpoint...' };
        this._syncLlmTab();
        try {
            if (!window.apiClient) throw new Error('No API client available.');
            const res = await window.apiClient.testConnection({
                provider: inst.provider,
                model: inst.model,
                api_key: inst.api_key || null,
                base_url: inst.base_url || null,
                api_version: inst.api_version || null,
            });
            this._connTestStatus = res.success
                ? { state: 'ok', message: '✅ Success: Connection verified successfully!' }
                : { state: 'fail', message: `❌ Failure: ${res.message}` };
        } catch (e) {
            this._connTestStatus = { state: 'fail', message: `❌ Error: ${e.message || e}` };
        }
        this._syncLlmTab();
    }

    renderHtml() {
        const instances = this.config.llm_instances || [];
        const mcpJson = this.config.mcp_text || '{}';

        // Helper for vertical tabs active state
        const getTabStyle = (tabId) => {
            const isActive = this.activeTab === tabId;
            return `
                padding: 12px 16px;
                background: ${isActive ? 'var(--bg-tertiary)' : 'transparent'};
                border: none;
                border-left: 3px solid ${isActive ? 'var(--accent)' : 'transparent'};
                border-radius: ${isActive ? '0 var(--radius-md) var(--radius-md) 0' : 'var(--radius-md)'};
                color: ${isActive ? 'var(--accent)' : 'var(--text-secondary)'};
                font-family: inherit;
                font-size: 13px;
                font-weight: ${isActive ? '600' : '500'};
                text-align: left;
                cursor: pointer;
                transition: all var(--transition-fast);
                display: flex;
                align-items: center;
                gap: 10px;
                width: 100%;
                outline: none;
            `;
        };

        // Render specific tab content
        let tabContentHtml = '';
        if (this.activeTab === 'llm') {
            tabContentHtml = `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3>${icon('llm', 15)} LLM Connections</h3>
                            <p class="subtitle">Manage connection instances and credentials</p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-secondary" id="btn-save-config">${icon('save', 13)} Save Settings</button>
                            <button class="btn btn-primary" id="btn-open-add-modal">${icon('plus', 13)} Add Connection</button>
                        </div>
                    </div>
                    
                    <!-- MIGRATED: ConnectionTable.svelte, mounted by _syncLlmTab().
                         The row used to be built by a provider switch inlined here,
                         and that switch had drifted out of sync with the three other
                         copies of the same table (see views/config/providers.js). -->
                    <div id="cfg-conn-table"></div>
                </div>
            `;
        } else if (this.activeTab === 'mcp') {
            tabContentHtml = `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3>${icon('mcp', 15)} Model Context Protocol (MCP) Servers</h3>
                            <p class="subtitle">Configure local or remote MCP servers in JSON format</p>
                        </div>
                        <button class="btn btn-primary" id="btn-save-config">${icon('save', 13)} Save Settings</button>
                    </div>
                    <!-- MIGRATED: SettingsMcp.svelte (_syncGeneralTabs). -->
                    <div id="cfg-mcp-panel"></div>
                </div>
            `;
        } else if (this.activeTab === 'general') {
            tabContentHtml = `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3>${icon('gear', 15)} General Settings</h3>
                            <p class="subtitle">Configure proxy, logging, and other general preferences</p>
                        </div>
                        <button class="btn btn-primary" id="btn-save-config">${icon('save', 13)} Save Settings</button>
                    </div>
                    <!-- MIGRATED: SettingsGeneral.svelte (_syncGeneralTabs). ~260 lines
                         of form markup whose every field was read back out of the DOM
                         by readFormValues(); each control reports a normalized patch
                         now, so what was typed and what gets saved are one value. -->
                    <div id="cfg-general-panel"></div>
                </div>
            `;
        } else if (this.activeTab === 'templates') {
            tabContentHtml = '<div id="cfg-templates-panel"></div>';
        } else if (this.activeTab === 'skills') {
            tabContentHtml = '<div id="cfg-skills-panel"></div>';
        } else if (this.activeTab === 'logs') {
            tabContentHtml = this.renderLogsTabHtml();
        } else if (this.activeTab === 'rag') {
            tabContentHtml = '<div id="cfg-rag-panel"></div>';
        } else if (this.activeTab === 'memory') {
            tabContentHtml = '<div id="cfg-memory-panel"></div>';
        }

        // MIGRATED: ConnectionModal.svelte, mounted by _syncLlmTab(). It was a
        // ~90-line template literal with 14 fields, each read back later by
        // getElementById(...).value, plus imperative style.display toggling for the
        // Azure-only field and JS relabelling of the URL input.
        const modalHtml = '<div id="cfg-conn-modal"></div>';

        return `
            <!-- Both style blocks are emitted for EVERY tab. CONFIG_SECTION_STYLES
                 used to live inside the General tab's branch, so .cfg-* (which the
                 Memory / RAG / Templates / Skills tabs are built out of) only
                 existed while General was the active tab — open Settings on Memory
                 and the tab rendered with no CSS at all. -->
            <style>${CONFIG_SECTION_STYLES}</style>
            <style>${CONFIG_MODAL_STYLES}</style>

            <div class="view-container">
                <div class="view-header">
                    <div>
                        <h1>Settings</h1>
                        <p class="subtitle">Configure AI connection instances, API keys, and MCP servers</p>
                    </div>
                </div>

                <!-- 2-Column Sidebar Layout for Settings -->
                <div style="display: flex; gap: 24px; min-height: 500px; width: 100%; align-items: flex-start; margin-top: 8px;">
                    
                    <!-- Left Column: Vertical Tabs Sidebar -->
                    <div class="tabs-vertical" style="width: 220px; display: flex; flex-direction: column; gap: 4px; border-right: 1px solid var(--border); padding-right: 16px; flex-shrink: 0;">
                        <button class="settings-tab-btn ${this.activeTab === 'llm' ? 'active' : ''}" data-tab="llm" style="${getTabStyle('llm')}">${icon('llm')} LLM Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'mcp' ? 'active' : ''}" data-tab="mcp" style="${getTabStyle('mcp')}">${icon('mcp')} MCP Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'general' ? 'active' : ''}" data-tab="general" style="${getTabStyle('general')}">${icon('gear')} General Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'templates' ? 'active' : ''}" data-tab="templates" style="${getTabStyle('templates')}">${icon('template')} Templates</button>
                        <button class="settings-tab-btn ${this.activeTab === 'skills' ? 'active' : ''}" data-tab="skills" style="${getTabStyle('skills')}">${icon('bolt')} Skills</button>
                        <!-- API Logs moved to the Monitor view (per-task raw payloads). -->
                        <button class="settings-tab-btn ${this.activeTab === 'rag' ? 'active' : ''}" data-tab="rag" style="${getTabStyle('rag')}">${icon('search')} RAG Indexing</button>
                        <button class="settings-tab-btn ${this.activeTab === 'memory' ? 'active' : ''}" data-tab="memory" style="${getTabStyle('memory')}">${icon('memory')} Memory</button>
                    </div>

                    <!-- Right Column: Active Tab Content Area -->
                    <div class="settings-content-wrapper" style="flex: 1; min-width: 0;">
                        ${tabContentHtml}
                    </div>
                </div>

                ${modalHtml}
            </div>
        `;
    }

    reRender() {
        const container = document.querySelector('.main-content');
        if (!container) return;
        // Unmount the migrated regions BEFORE the innerHTML swap discards their
        // hosts. Without this the old instances stay alive holding listeners on
        // detached nodes, and the seam's bookkeeping still believes they are mounted.
        for (const id of MOUNT_HOSTS) destroyComponent(document.getElementById(id));
        container.innerHTML = this.renderHtml();
        this.init();
    }

    // ── Approved commands / auto-approve workspaces (localStorage-backed) ──
    // Same stores the Monitor's approval dialog writes ("Always allow" /
    // per-workspace auto-approve): jhai_approved_commands (patterns) and
    // jhai_autoapprove_workspaces (paths). Editable here so the user doesn't
    // need a pending approval card to manage them.

    _lsList(key) {
        try {
            const a = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(a) ? a.map(String) : [];
        } catch (_) { return []; }
    }

    _lsSave(key, arr) {
        try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
    }

    // NOTE: _renderApprovedCmdLists / _initApprovedCommandsSection are gone. They
    // wrote two lists as innerHTML and then re-attached delegated remove handlers,
    // plus a keydown and a click listener per add field. SettingsGeneral.svelte
    // renders both lists from props; the SAFETY guard that used to live inside the
    // add handler is now approvedPatternRefusal (pure, tested) and is enforced in
    // _lsAdd below, so it applies wherever a pattern is added from.

    async render() {
        if (!this.loaded) {
            await this.loadConfig();
        }
        return this.renderHtml();
    }

    init() {
        // NOTE: the General tab's collapsible-section persistence and the
        // approved-commands editors are SettingsGeneral.svelte's, wired through
        // onToggleSection / onAddApprovedCommand / onRemoveApprovedCommand.

        // Toggle password show/hide
        const passwordToggles = document.querySelectorAll('.btn-toggle-password');
        passwordToggles.forEach(btn => {
            btn.addEventListener('click', () => {
                const input = btn.previousElementSibling;
                if (input.type === 'password') {
                    input.type = 'text';
                    btn.innerText = '🔒';
                } else {
                    input.type = 'password';
                    btn.innerText = '👁️';
                }
            });
        });

        // Tab Switching Click Listeners
        const tabButtons = document.querySelectorAll('.settings-tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                        this.activeTab = btn.getAttribute('data-tab');
                if (this.activeTab === 'logs') {
                    await this.loadLogs();
                } else if (this.activeTab === 'skills') {
                    await this.loadSkills();
                }
                this.reRender();
            });
        });

        // MIGRATED (region 5): the Memory, RAG, Templates and Skills tabs are Svelte
        // components. What stood here was ~330 lines of per-button listeners plus a
        // DOM-walking cascade (unchecking a RAG directory wrote `.checked` and
        // `parentElement.style.opacity` on every descendant input, so the model and
        // the checkboxes could disagree). All four are prop callbacks now.
        this._syncListTabs();

        // ── End Templates/Skills handlers ─────────────────────────────────────

        // Add Connection Modal - Open
        // MIGRATED (region 5): the connection table and its modal are Svelte
        // components. What stood here was ~270 lines: four querySelectorAll loops
        // re-binding row buttons after every reRender, a provider-change handler
        // that rewrote placeholders / labels / visibility by hand, and two handlers
        // that read 14 fields back out of the DOM with getElementById.
        this._syncLlmTab();
        // "Add Connection" is still in this tab's vanilla card header (it moves with
        // the tab shell), so it keeps a listener — but the work is the same method
        // the table's Edit calls.
        document.getElementById('btn-open-add-modal')
            ?.addEventListener('click', () => this._openInstanceModal(null));

        // Select Log Directory Folder Dialog
        // MIGRATED (region 5): the General and MCP tab bodies are Svelte
        // components. Their controls report patches through props, so the ~95 lines
        // of per-button listeners that stood here — log-dir picker, storage
        // refresh/purge, connection export, token copy, the logging toggle that
        // toggled a CSS class and was read back later by classList.contains — are
        // now methods called by name.
        this._syncGeneralTabs();

        // Save entire configuration to backend
        const btnSave = document.getElementById('btn-save-config');
        if (btnSave) {
            btnSave.addEventListener('click', async () => {
                btnSave.disabled = true;
                btnSave.innerText = 'Saving...';

                try {
                    await this.persistConfig();
                    showNotification("Settings saved successfully!");

                    // Reload to update masked strings
                    this.loaded = false;
                    await this.loadConfig();
                    this.reRender();
                } catch (e) {
                    alert("Error saving config: " + e.message);
                } finally {
                    btnSave.disabled = false;
                    btnSave.innerHTML = `${icon('save', 13)} Save Settings`;
                }
            });
        }

        // Log Entry Accordion Toggles
        const logHeaders = document.querySelectorAll('.log-entry-header');
        logHeaders.forEach(hdr => {
            hdr.addEventListener('click', () => {
                const idx = hdr.getAttribute('data-idx');
                const body = document.getElementById(`log-body-${idx}`);
                const chevron = document.getElementById(`log-chevron-${idx}`);
                
                if (body && chevron) {
                    const isVisible = body.style.display === 'block';
                    body.style.display = isVisible ? 'none' : 'block';
                    chevron.style.transform = isVisible ? 'rotate(180deg)' : 'rotate(0deg)';
                }
            });
        });

        // Clear Logs Action
        const btnClearLogs = document.getElementById('btn-clear-logs');
        if (btnClearLogs) {
            btnClearLogs.addEventListener('click', async () => {
                if (confirm('Are you sure you want to clear all API communication logs? This will empty the log file.')) {
                    try {
                        const logPath = `${this.config.log_dir}/ai_communication.log`.replace(/\\/g, '/');
                        await invoke('write_file', { path: logPath, content: '' });
                        await this.loadLogs();
                        this.reRender();
                    } catch (e) {
                        alert('Failed to clear log file: ' + (e.message || e));
                    }
                }
            });
        }
    }

    /** Save current prompt templates to the backend config. */
    async _saveTemplates() {
        if (!window.apiClient) return;
        try {
            const current = await window.apiClient.getConfig();
            await window.apiClient.updateConfig({
                ...current,
                prompt_templates: promptTemplateManager.toConfigValue(),
            });
        } catch (e) {
            console.error('Failed to save templates:', e);
            throw e;
        }
    }

    async loadLogs() {
        this.logsList = [];
        this.logsError = '';
        if (!this.config.log_dir) {
            return;
        }
        
        try {
            const logPath = `${this.config.log_dir}/ai_communication.log`.replace(/\\/g, '/');
            const exists = await invoke('file_exists', { path: logPath });
            if (exists) {
                const raw = await invoke('read_file', { path: logPath });
                if (raw && raw.trim()) {
                    const lines = raw.trim().split('\n');
                    const parsed = [];
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            parsed.push(JSON.parse(line));
                        } catch (e) {
                            console.error('Failed to parse log line:', e);
                        }
                    }
                    this.logsList = parsed.reverse();
                }
            }
        } catch (e) {
            console.error('Failed to load logs:', e);
            this.logsError = e.message || e;
        }
    }

    destroy() {
        if (this._ragUnlisten) {
            this._ragUnlisten();
            this._ragUnlisten = null;
        }
        // Unmount migrated regions. reRender() replaces this view's whole innerHTML,
        // so a live instance left pointing at a detached host would leak its
        // listeners — and two instances on one host is what the seam exists to stop.
        for (const id of MOUNT_HOSTS) destroyComponent(document.getElementById(id));
    }

    // ─── 🧠 Memory tab — view / edit / delete the agent's long-term memory ───
    // facts.json (durable facts injected into the system prompt) and memory.json
    // (episodic session summaries) live under <workspace>/.agent/. This tab makes
    // them visible so wrong or stale memories can be corrected by the user.

    // Thin wrappers over memory/workspaceMemory.js. Kept as methods because the
    // tests drive them through the view, but the paths, parsing and path-guard
    // grant all live in the shared module now.
    _memoryPaths(ws) { return memoryPaths(ws); }

    /**
     * Learn the workspace's structure up front (docs/design/agent-memory-learning.plan.md
     * Step 3.8), and retire what the tree no longer has (Step 5a) in the same pass.
     *
     * Experience only records where the agent happened to walk, so a project it
     * has never run in has a memory of nothing. This fills that in from facts —
     * a symbol IS declared at this file and line — which is why the cards it
     * writes need no confidence discount against learned ones.
     */
    async _runStudy() {
        if (this._studying) return;
        if (!this.memoryWorkspace) { alert('Please enter a workspace path.'); return; }

        this._studying = true;
        this._studyStatus = '';
        this._syncListTabs();
        try {
            const { runStudyPass, dropStudyCards } = await import('../../modules/ai/memory/StudyPass.js');
            // The index is written inside `.agent/memory`, so the guard has to
            // know about the directory before the pass starts, not after.
            await this._allowMemoryDir();

            const res = await runStudyPass({
                workspacePath: this.memoryWorkspace, invoke,
                onProgress: ({ read, total }) => {
                    this._studyStatus = `${read} / ${total}`;
                    this._syncListTabs();
                },
            });
            if (res.error) {
                this._studyStatus = t('memory.study.failed', { error: res.error });
                return;
            }

            // Symbols live in the INDEX now, not in cards.jsonl — they are a
            // lookup, and a lookup belongs behind a query rather than in a list
            // the user is expected to read.
            this._studyStatus = t('memory.study.indexed', {
                files: res.files, symbols: res.symbols, edges: res.edges,
            }) + (res.pruned ? t('memory.study.dropped', { count: res.pruned }) : '')
                + (res.truncated || res.omitted
                    ? ' ' + t('memory.study.capped', { total: res.total || res.files + (res.omitted || 0), omitted: res.omitted || 0 })
                    : '');
            this._syncListTabs();

            // One-time migration: the first version of this pass wrote a card per
            // symbol. They live in the index now, so the rows left in cards.jsonl
            // are residue in a panel whose whole purpose is being reviewable.
            const { kept, dropped } = dropStudyCards(this.memoryCards || []);
            if (dropped) {
                this.memoryCards = kept;
                await this.saveMemoryCards();
                this._studyStatus += ' · ' + t('memory.study.migrated', { count: dropped });
            }
            await this._loadIndexStats();
            this._syncListTabs();

            // Phase 2 — the ORIENTATION note. The index says where every symbol
            // is; it does not say what the project IS, and without that a symbol
            // query is a guess. This is the one memory writer that uses a model,
            // because "what is this area for" cannot be parsed out of an AST. It
            // reads the STRUCTURE the pass just produced, never the source.
            await this._writeOverview(res.areas);
        } catch (e) {
            this._studyStatus = t('memory.study.failed', { error: String(e?.message || e) });
        } finally {
            this._studying = false;
            this._syncListTabs();
        }
    }

    /**
     * Read the index's size and per-area coverage for the Memory tab.
     *
     * Coverage is the part worth showing: it says which areas the agent knows
     * NOTHING about, and therefore where its answers are guesses.
     */
    async _loadIndexStats() {
        try {
            const { CodeIndexClient, coverage } = await import('../../modules/ai/memory/CodeIndex.js');
            const idx = new CodeIndexClient({ workspacePath: this.memoryWorkspace, invoke });
            const stats = await idx.stats();
            const paths = (await idx.knownHashes()).map(([p]) => p);
            this.indexStats = { ...stats, coverage: coverage(paths, { root: this.memoryWorkspace }) };
        } catch (_) {
            this.indexStats = null;
        }
    }

    /**
     * Read `.agent/trace/metrics.jsonl` and compare the two arms.
     *
     * Without this the comparison exists only as a function nobody calls: the
     * rows accumulate on disk and the question they were collected to answer
     * ("is recall helping?") can only be answered by someone writing a script.
     * A memory layer whose evaluation is that inconvenient does not get
     * evaluated — which is the failure mode the arms were introduced against.
     */
    async _loadAbStats() {
        try {
            const { compareArms, parseMetrics, runsNeeded } =
                await import('../../modules/ai/memory/SessionMetrics.js');
            const text = await invoke('read_file', { path: `${this.memoryWorkspace}/.agent/trace/metrics.jsonl` });
            const rows = parseMetrics(text);
            this.abStats = rows.length
                ? { ...compareArms(rows), rows: rows.length, needed: runsNeeded(rows) }
                : null;
        } catch (_) {
            this.abStats = null; // no runs recorded yet
        }
    }

    /**
     * Summarise the structure the study pass just mapped, and store it as the
     * standing orientation note (`.agent/memory/overview.md`).
     *
     * The note is TWO layers (proposal A/B):
     *   - measured: the naming rules, counted off the file listing (no model).
     *     Stored verbatim in the note's front matter every pass, so it can never
     *     drift from the tree the index actually saw — refreshing it costs
     *     nothing and needs no LLM.
     *   - interpreted: the prose about what the project IS. Written by a model
     *     ONLY when the stored prose is stale (30 days, or the workspace's HEAD
     *     commit changed since it was written). The prose is the expensive,
     *     fallible half; the measurements are the reliable, cheap half, and the
     *     two must not be coupled to the same refresh clock.
     *
     * Best-effort: a failure here leaves the index — which is the expensive part
     * — intact. The note is markdown on disk precisely so the user can correct
     * it, since it is the only generated memory that is not verified.
     */
    async _writeOverview(cards) {
        try {
            const { structureDigest, detectConventionsFull, buildOverviewPrompt, normalizeOverview, isOverviewStale } =
                await import('../../modules/ai/memory/ProjectOverview.js');
            const { writeOverview, readOverview } = await import('../../modules/ai/memory/workspaceMemory.js');
            const llmService = (await import('../../modules/ai/LLMService.js')).default;

            const areas = structureDigest(cards, { root: this.memoryWorkspace });
            if (!areas.length) return;
            // Counted from the same paths, before the model sees anything. The
            // model's job here is to phrase them, not to find them. This is the
            // MEASURED layer: stored verbatim, refreshed every pass.
            const measured = detectConventionsFull(cards, { root: this.memoryWorkspace });
            const conventions = measured.rules;

            // Only re-run the model when the stored prose is stale. The measured
            // layer above is always fresh; the prose is the expensive half and
            // must not be rewritten on every study pass.
            const head = await this._headCommit();
            const prev = await readOverview(this.memoryWorkspace, invoke);
            const stale = isOverviewStale(prev, { now: Date.now(), head });
            if (!stale && prev.text) {
                // Fresh prose: just refresh the measurements (cheap) and keep the
                // user's/previous prose untouched.
                await writeOverview(this.memoryWorkspace, prev.text, invoke, prev.generatedAt, measured, head);
                this.memoryOverview = { ...prev, conventions: measured, head };
                this._studyStatus = t('memory.study.overviewRefreshed');
                this._syncListTabs();
                return;
            }

            // While the LLM call runs, the status must say "creating…"; once it
            // lands it must say "created". The two must not stack, so the finished
            // message REPLACES the "creating…" text instead of appending to it.
            this._studyStatus = t('memory.study.overview');
            this._syncListTabs();

            const name = String(this.memoryWorkspace).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            const prompt = buildOverviewPrompt(areas, { projectName: name, conventions });
            let raw = '';
            await llmService.generate(prompt, 'You write concise, factual orientation notes. Output bullets only.',
                (chunk) => { raw += chunk; });

            const text = normalizeOverview(raw);
            if (!text) return;
            const generatedAt = new Date().toISOString();
            await writeOverview(this.memoryWorkspace, text, invoke, generatedAt, measured, head);
            // Show it. Writing the file without refreshing what the panel holds
            // left the note invisible until someone pressed Load again — which
            // for a panel whose whole job is "read this and correct it" is the
            // same as not having written it.
            this.memoryOverview = { text, generatedAt, conventions: measured };
            // Replaces the "creating…" row — a finished action must not keep
            // reading as an in-flight one.
            this._studyStatus = t('memory.study.overviewDone');
        } catch (e) {
            console.warn('ConfigView: overview generation failed:', e);
            this._studyStatus = t('memory.study.overviewFailed');
        }
    }

    /**
     * Persist the user's manual edit of the orientation note.
     *
     * `onSaveOverview` was wired to this method but the method did not exist —
     * the Memory tab's Save button threw (undefined method) and the edit was
     * silently dropped. The write is the same one the study pass uses; the only
     * difference is that the user's edit is authoritative, so the timestamp is
     * refreshed here and the panel shows the saved text immediately.
     */
    async _saveOverview(text) {
        if (!this.memoryWorkspace) return;
        try {
            const generatedAt = new Date().toISOString();
            const head = await this._headCommit();
            const prev = await readOverview(this.memoryWorkspace, invoke);
            // The user's edit is authoritative: the timestamp is refreshed and the
            // stored measurements are kept as-is (a manual edit touches the prose,
            // not the arithmetic).
            await writeOverview(this.memoryWorkspace, String(text || ''), invoke, generatedAt, prev.conventions || null, head);
            this.memoryOverview = { text: String(text || '').trim(), generatedAt, conventions: prev.conventions || null, head };
            this._syncListTabs();
        } catch (e) {
            console.warn('ConfigView: overview save failed:', e);
            alert('Failed to save the overview note: ' + (e?.message || e));
        }
    }

    /**
     * HEAD of the workspace, recorded on every studied card so a later pass can
     * tell how old the reading is. Absent (not a repo, no git) is fine — the
     * path check is what actually retires a card.
     */
    async _headCommit() {
        try {
            const out = await invoke('git_log', { cwd: this.memoryWorkspace, limit: 1 });
            const m = String(out || '').match(/\b[0-9a-f]{7,40}\b/);
            return m ? m[0] : '';
        } catch (_) {
            return '';
        }
    }

    async _allowMemoryDir() {
        await allowMemoryDir(this.memoryWorkspace, invoke);
    }

    async loadMemoryData() {
        if (!this.memoryWorkspace) return;
        const { facts, episodes, cards } = await readWorkspaceMemory(this.memoryWorkspace, invoke);
        this.memoryFacts = facts;
        this.memoryEpisodes = episodes;
        this.memoryCards = cards;
        // The orientation note is a separate file (.agent/memory/overview.md) that
        // readWorkspaceMemory deliberately does not read. Skipping it left
        // memoryOverview undefined after Load, so the Memory tab's "overview?.text"
        // gate hid the note — it had been written, just never read back. readOverview
        // never throws (missing file ⇒ empty), so this stays best-effort.
        this.memoryOverview = await readOverview(this.memoryWorkspace, invoke);
        if (this.memoryOverview?.generatedAt) {
            this.memoryOverview.head = await this._headCommit();
        }
    }

    async saveMemoryFacts() {
        await writeFacts(this.memoryWorkspace, this.memoryFacts, invoke);
    }

    async saveMemoryEpisodes() {
        await writeEpisodes(this.memoryWorkspace, this.memoryEpisodes, invoke);
    }

    async saveMemoryCards() {
        await writeCards(this.memoryWorkspace, this.memoryCards, invoke);
    }

    // NOTE: renderMemoryTabHtml / renderRagTabHtml / renderTemplatesTabHtml /
    // renderSkillsTabHtml are gone (~330 lines). They are MemoryTab / RagTab /
    // TemplatesTab / SkillsTab .svelte, mounted by _syncListTabs(). Their validation
    // moved to views/config/lists.js and the RAG directory cascade to
    // views/config/rag.js — both pure and tested.

    async _renderStorageUsage() {
        const el = document.getElementById('cfg-storage-usage');
        if (!el) return;
        const fmtBytes = (b) => {
            b = b || 0;
            if (b < 1024) return `${b} B`;
            if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
            return `${(b / 1048576).toFixed(2)} MB`;
        };
        const lsSize = (key) => {
            try { const v = localStorage.getItem(key); return v ? v.length * 2 : 0; } catch { return 0; }
        };
        let lsTotal = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                lsTotal += (k.length + (localStorage.getItem(k) || '').length) * 2;
            }
        } catch (_) {}
        const chatBytes = lsSize('direct_ai_sessions');
        const apiLogBytes = lsSize('jh_api_logs');
        const schedBytes = lsSize('jh_schedules');

        el.innerHTML = '<em style="color:var(--text-tertiary)">Loading…</em>';
        let server = {};
        try { server = await invoke('get_storage_usage'); } catch (_) {}

        el.innerHTML = `
            <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">Local (localStorage)</div>
            · Chat history (direct_ai_sessions): ${fmtBytes(chatBytes)}<br>
            · Old API logs (jh_api_logs): ${fmtBytes(apiLogBytes)} ${apiLogBytes > 0 ? '<span style="color:var(--text-tertiary)">(retired · safe to delete)</span>' : ''}<br>
            · Schedules (jh_schedules): ${fmtBytes(schedBytes)}<br>
            · localStorage total: <strong>${fmtBytes(lsTotal)}</strong>
            <div style="font-weight:600;color:var(--text-primary);margin:8px 0 4px">Server (task history)</div>
            · task_history.json: ${fmtBytes(server.task_history_bytes)}<br>
            · task_logs/ (${server.task_logs_count || 0} files): ${fmtBytes(server.task_logs_bytes)}<br>
            · Communication log ai_communication.log: ${fmtBytes(server.comm_log_bytes)} ${server.log_dir ? '' : '<span style="color:var(--text-tertiary)">(not set)</span>'}
        `;
    }

    renderLogsTabHtml() {
        if (!this.config.log_dir) {
            return `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="margin-bottom: 20px;">
                        <h3>${icon('plug', 15)} API Communication Logs</h3>
                        <p class="subtitle">View and debug detailed API payloads sent to AI providers</p>
                    </div>
                    <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                        <span style="font-size: 48px; display: block; margin-bottom: 16px;">⚠️</span>
                        <h4>Log Directory Not Configured</h4>
                        <p style="margin-top: 8px; max-width: 400px; margin-left: auto; margin-right: auto;">
                            Please configure a log directory in the <strong>⚙️ General Settings</strong> tab first and enable interaction logging.
                        </p>
                    </div>
                </div>
            `;
        }

        if (this.logsError) {
            return `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="margin-bottom: 20px;">
                        <h3>${icon('plug', 15)} API Communication Logs</h3>
                        <p class="subtitle">View and debug detailed API payloads sent to AI providers</p>
                    </div>
                    <div style="padding: 40px; text-align: center; color: var(--error);">
                        <span style="font-size: 48px; display: block; margin-bottom: 16px;">❌</span>
                        <h4>Failed to read log file</h4>
                        <p style="margin-top: 8px;">${escapeHtml(this.logsError)}</p>
                    </div>
                </div>
            `;
        }

        const logRowsHtml = this.logsList && this.logsList.length > 0
            ? this.logsList.map((log, idx) => {
                const dateStr = log.timestamp ? new Date(log.timestamp).toLocaleString() : 'Unknown Time';
                const provider = log.provider || 'unknown';
                const model = log.model || 'unknown';
                
                let reqPretty = '';
                try {
                    reqPretty = JSON.stringify(log.request, null, 2);
                } catch(e) { reqPretty = String(log.request); }

                const resPretty = typeof log.response === 'string' ? log.response : JSON.stringify(log.response, null, 2);
                
                return `
                    <div class="log-entry-row" style="border: 1px solid var(--border-light); border-radius: var(--radius-sm); margin-bottom: 10px; overflow: hidden; background: var(--bg-secondary);">
                        <div class="log-entry-header" data-idx="${idx}" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; cursor: pointer; background: var(--bg-tertiary); user-select: none;">
                            <div style="display: flex; align-items: center; gap: 16px;">
                                <span style="font-size: 11px; color: var(--text-tertiary); font-family: var(--font-mono);">${dateStr}</span>
                                <span style="font-weight: 600; text-transform: uppercase; font-size: 12px; color: var(--accent);">${escapeHtml(provider)}</span>
                                <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);">${escapeHtml(model)}</span>
                            </div>
                            <span class="log-chevron" id="log-chevron-${idx}" style="font-size: 12px; transition: transform var(--transition-fast);">▼</span>
                        </div>
                        <div class="log-entry-body" id="log-body-${idx}" style="display: none; border-top: 1px solid var(--border-light); padding: 16px; background: var(--bg-input);">
                            <div class="grid-2" style="gap: 16px;">
                                <div>
                                    <h4 style="font-size: 12px; color: var(--accent); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Request Payload</h4>
                                    <pre style="background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; padding: 12px; max-height: 300px; overflow-y: auto; margin: 0;"><code class="language-json" style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-primary); white-space: pre-wrap; word-break: break-all;">${escapeHtml(reqPretty)}</code></pre>
                                </div>
                                <div>
                                    <h4 style="font-size: 12px; color: var(--accent); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Response Content</h4>
                                    <pre style="background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; padding: 12px; max-height: 300px; overflow-y: auto; margin: 0;"><code style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-primary); white-space: pre-wrap; word-break: break-all;">${escapeHtml(resPretty)}</code></pre>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')
            : `
                <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                    <span style="font-size: 32px; display: block; margin-bottom: 12px;">📋</span>
                    <p>No communication logs captured yet. Send a message to get started.</p>
                </div>
            `;

        return `
            <div class="card settings-card" style="height: 100%; display: flex; flex-direction: column;">
                <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-shrink: 0;">
                    <div>
                        <h3>${icon('plug', 15)} API Communication Logs</h3>
                        <p class="subtitle">Chronological record of request payloads and raw AI responses</p>
                    </div>
                    <button class="btn btn-secondary" id="btn-clear-logs" style="color: var(--error); border-color: var(--error); background: transparent;">${icon('trash', 12)} Clear Logs</button>
                </div>
                
                <div class="logs-list-container" style="flex: 1; overflow-y: auto; padding-right: 4px;">
                    ${logRowsHtml}
                </div>
            </div>
        `;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}

function showNotification(message) {
    const el = document.createElement('div');
    el.className = 'toast toast-success';
    el.innerHTML = `<span>✓</span> <span>${message}</span>`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 50);
    setTimeout(() => {
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 300);
    }, 3000);
}
