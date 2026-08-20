<!--
  ConfigRoot — the Settings page.

  Svelte migration step 3 (docs/design/svelte-migration.md). The eight tab BODIES
  were already components; what remained was a 1,615-line shell that assembled
  their props, owned every piece of state and, after almost every handler, called
  `reRender()` — which rebuilt the entire page's innerHTML and re-mounted all
  eight. Editing one template re-created the whole Settings view.

  ── Two things fixed on the way through ─────────────────────────────────────
  1. `_renderStorageUsage()` wrote its HTML straight into `#cfg-storage-usage`,
     which is INSIDE SettingsGeneral's own subtree, while the `storageUsage` prop
     it was supposed to feed was never assigned and so was always ''. That is the
     one rule mount.svelte.js states outright — the vanilla side must never touch
     a mounted subtree again — and it held only because the component happened to
     leave that div empty. It is a normal prop now.
  2. The `logs` tab is gone. API logs moved to Monitor (per-task raw payloads) and
     the tab BUTTON was removed then, but `renderLogsTabHtml()` (~90 lines),
     `loadLogs()` and their branch in the tab switch stayed. Nothing could reach
     them.
-->
<script>
    import { untrack } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { listen } from '@tauri-apps/api/event';
    import { icon } from '../../utils/icons.js';
    import { getLocale, setLocale, t } from '../../../i18n/index.js';
    import { showNotification } from '../../utils/notifications.js';
    import { promptTemplateManager } from '../../../modules/ai/PromptTemplateManager.js';
    import { skillManager } from '../../../modules/ai/SkillManager.js';
    import { classifyCommand } from '../../../modules/ai/tools/commandPolicy.js';
    import { capFactText } from '../../../modules/ai/memory/FactStore.js';
    import {
        readWorkspaceMemory, writeFacts, writeEpisodes, writeCards,
        readOverview, writeOverview, memoryPaths, allowMemoryDir,
    } from '../../../modules/ai/memory/workspaceMemory.js';
    import {
        licenseState, hasStoredKey, activateLicense, clearLicense,
        refreshLicense, licensingConfigured,
    } from '../../license.js';
    import {
        CONFIG_TABS, APPROVED_COMMANDS_KEY, AUTO_APPROVE_WS_KEY,
        readList, addToList, removeFromList, readOpenSections, writeOpenSection,
        buildConfigPayload, applyConfigPatch, upsertInstance, removeInstance,
    } from '../../views/config/configModel.js';
    import { storageUsageHtml } from '../../views/config/storageUsage.js';

    import ConnectionTable from './ConnectionTable.svelte';
    import ConnectionModal from './ConnectionModal.svelte';
    import SettingsGeneral from './SettingsGeneral.svelte';
    import SettingsMcp from './SettingsMcp.svelte';
    import TemplatesTab from './TemplatesTab.svelte';
    import SkillsTab from './SkillsTab.svelte';
    import RagTab from './RagTab.svelte';
    import MemoryTab from './MemoryTab.svelte';

    let {
        /** Injectable seams — default to the real client / Tauri bridge. */
        api = null,
        confirmAction = (msg) => window.confirm(msg),
        notify = (msg) => window.alert(msg),
        toast = showNotification,
        pickFolder = () => invoke('select_folder'),
        onLocaleChange = () => window.dashboard?.render?.(),
        initialTab = 'llm',
    } = $props();

    const client = () => api ?? window.apiClient;

    const DEFAULT_CONFIG = {
        openai_key: '', anthropic_key: '', gemini_key: '', azure_key: '',
        azure_endpoint: '', azure_deployment: '', tavily_api_key: '', proxy_url: '',
        logging_enabled: false, log_dir: '', max_steps: 0,
        approved_projects: [], write_allowed_paths: [], fetch_allowed_hosts: [],
        mcp_servers: {}, llm_instances: [], active_llm_instance_id: null,
        token_budget: 0, wall_clock_minutes: 0, no_progress_window: 15,
        identical_call_threshold: 5, cycle_detection_min_repeats: 3,
    };

    let config = $state({ ...DEFAULT_CONFIG, mcp_text: '{}' });
    // Seeded ONCE, deliberately — see ConnectionModal.svelte for the full note.
    // `untrack` says so to the compiler; reading the prop directly does the same
    // thing but warns that only the initial value is captured, and those warnings
    // drown out the ones that mean something.
    let activeTab = $state(untrack(() => initialTab));

    // LLM tab
    let showModal = $state(false);
    let editingInstance = $state(null);
    let connTestStatus = $state(null);

    // General tab
    let openSections = $state(readOpenSections());
    let approvedCommands = $state(readList(APPROVED_COMMANDS_KEY));
    let autoApproveWorkspaces = $state(readList(AUTO_APPROVE_WS_KEY));
    let storageUsage = $state('');
    let exportStatus = $state('');
    let appVersion = $state('');
    let updatesConfigured = $state(false);
    let licensingOn = $state(false);
    let license = $state(licenseState());
    let uiLocale = $state(getLocale());

    // Templates / Skills
    let editingTemplate = $state(null);
    let showTemplateForm = $state(false);
    let templates = $state([]);
    let skillsList = $state([]);
    /** Where API keys are kept — the fallback to plaintext has to be visible. */
    let secretStorage = $state(null);
    let editingSkill = $state(null);
    let showSkillForm = $state(false);

    // RAG
    let ragPath = $state('');
    let ragDirs = $state([]);
    let ragExclusions = $state([]);
    let ragExtensions = $state(['js', 'jsx', 'ts', 'tsx', 'rs', 'java', 'py', 'md', 'txt', 'html', 'css', 'json', 'xml']);
    let ragProgress = $state(0);

    // Memory — null means "not loaded yet", which the tab shows as a hint.
    let memoryWorkspace = $state('');
    let memoryFacts = $state(null);
    let memoryEpisodes = $state(null);
    let memoryCards = $state(null);
    let memoryOverview = $state(null);
    let indexStats = $state(null);
    let abStats = $state(null);
    let studying = $state(false);
    let studyStatus = $state('');

    const projects = $derived(Array.isArray(config.approved_projects) ? config.approved_projects : []);
    const connection = $derived({
        token: client()?.token || '',
        port: client()?.port || '14300',
    });

    // ── Config ────────────────────────────────────────────────────────────

    async function loadConfig() {
        const c = client();
        if (!c) return;
        try {
            const cfg = await c.getConfig();
            const next = { ...DEFAULT_CONFIG, ...config, ...cfg };
            next.mcp_text = next.mcp_servers ? JSON.stringify(next.mcp_servers, null, 2) : '{}';
            if (!next.llm_instances) next.llm_instances = [];
            config = next;
            promptTemplateManager.loadFromConfig(config);
            templates = promptTemplateManager.getAll();
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    }

    /**
     * The single source of truth for "save the whole config".
     *
     * Both the Save Settings button and the connection modal's Save call it, so
     * editing a connection is durable immediately without a separate click.
     * Throws on invalid MCP JSON or API failure; callers own the feedback.
     */
    async function persistConfig() {
        const payload = buildConfigPayload(config, promptTemplateManager.toConfigValue());
        const c = client();
        if (!c) return;
        await c.updateConfig(payload);
        try {
            const { default: llmService } = await import('../../../modules/ai/LLMService.js');
            // A saved default is authoritative — drop any earlier session
            // (dropdown) model lock so this choice actually takes effect.
            llmService.clearSessionModelLock();
            await llmService.initFromConfig();
        } catch (e) {
            console.warn('Could not refresh LLMService after save:', e);
        }
    }

    async function save() {
        try {
            await persistConfig();
            toast('Settings saved.');
            await loadConfig();
        } catch (e) {
            notify('Error saving settings: ' + (e.message || e));
        }
    }

    const patchConfig = (patch) => { config = applyConfigPatch(config, patch); };

    // ── Connections ───────────────────────────────────────────────────────

    function openInstanceModal(id = null) {
        editingInstance = id ? (config.llm_instances || []).find(i => i.id === id) || null : null;
        connTestStatus = null;
        showModal = true;
    }

    function closeInstanceModal() {
        showModal = false;
        editingInstance = null;
        connTestStatus = null;
    }

    function deleteInstance(id) {
        if (!confirmAction('Are you sure you want to remove this connection instance?')) return;
        const r = removeInstance(config.llm_instances, id, config.active_llm_instance_id);
        config = { ...config, llm_instances: r.instances, active_llm_instance_id: r.activeId };
    }

    async function saveInstance(next) {
        const r = upsertInstance(config.llm_instances, next, config.active_llm_instance_id);
        config = { ...config, llm_instances: r.instances, active_llm_instance_id: r.activeId };
        closeInstanceModal();
        try {
            await persistConfig();
            toast('Connection saved.');
            // Reload so the masked key strings the backend returns replace the
            // plaintext we just sent.
            await loadConfig();
        } catch (e) {
            notify('Error saving connection: ' + (e.message || e));
        }
    }

    async function testInstance(inst) {
        if (!String(inst.model || '').trim()) {
            connTestStatus = { state: 'fail', message: 'Model Name is required to run a connection audit.' };
            return;
        }
        connTestStatus = { state: 'testing', message: '🔍 Connecting to endpoint...' };
        try {
            const c = client();
            if (!c) throw new Error('No API client available.');
            const res = await c.testConnection({
                provider: inst.provider, model: inst.model,
                api_key: inst.api_key || null, base_url: inst.base_url || null,
                api_version: inst.api_version || null,
            });
            connTestStatus = res.success
                ? { state: 'ok', message: '✅ Success: Connection verified successfully!' }
                : { state: 'fail', message: `❌ Failure: ${res.message}` };
        } catch (e) {
            connTestStatus = { state: 'fail', message: `❌ Error: ${e.message || e}` };
        }
    }

    // ── General tab actions ───────────────────────────────────────────────

    function addTo(key, value) {
        const r = addToList(key, value, classifyCommand);
        if (!r.ok) { notify(r.reason); return; }
        if (key === APPROVED_COMMANDS_KEY) approvedCommands = r.list;
        else autoApproveWorkspaces = r.list;
    }

    function removeFrom(key, value) {
        const list = removeFromList(key, value);
        if (key === APPROVED_COMMANDS_KEY) approvedCommands = list;
        else autoApproveWorkspaces = list;
    }

    async function refreshStorage() {
        storageUsage = '<em class="cfg-muted">Loading…</em>';
        let server = {};
        try { server = await invoke('get_storage_usage'); } catch (_) { /* dev/browser */ }
        storageUsage = storageUsageHtml(server);
    }

    async function exportConnection() {
        const c = client();
        if (!c) { exportStatus = '<span class="cfg-err">API client not ready.</span>'; return; }
        exportStatus = '<span class="cfg-muted">Exporting…</span>';
        try {
            const written = await invoke('export_connection_config', {
                port: Number(c.port) || 14300, token: c.token || '',
            });
            exportStatus = `<span class="cfg-ok">Wrote: <code>${String(written)}</code></span>`;
        } catch (e) {
            exportStatus = `<span class="cfg-err">Export failed: ${String(e.message || e)}</span>`;
        }
    }

    // ── Memory tab ────────────────────────────────────────────────────────

    async function loadMemoryData() {
        if (!memoryWorkspace) return;
        const { facts, episodes, cards } = await readWorkspaceMemory(memoryWorkspace, invoke);
        memoryFacts = facts;
        memoryEpisodes = episodes;
        memoryCards = cards;
        // A separate file that readWorkspaceMemory deliberately does not read.
        // Skipping it left the note written but never read back, so the tab's
        // `overview?.text` gate hid it. readOverview never throws.
        memoryOverview = await readOverview(memoryWorkspace, invoke);
        if (memoryOverview?.generatedAt) memoryOverview.head = await headCommit();
    }

    async function headCommit() {
        try {
            const out = await invoke('run_command', { command: 'git rev-parse HEAD', cwd: memoryWorkspace });
            return String(out || '').trim().slice(0, 12);
        } catch (_) { return ''; }
    }

    /** Mutate one store optimistically, reloading from disk if the write fails. */
    async function mutateStore(kind, fn) {
        const target = { facts: memoryFacts, cards: memoryCards, episodes: memoryEpisodes }[kind];
        if (!Array.isArray(target)) return;
        const copy = [...target];
        fn(copy);
        if (kind === 'facts') memoryFacts = copy;
        else if (kind === 'cards') memoryCards = copy;
        else memoryEpisodes = copy;
        const writer = { facts: writeFacts, cards: writeCards, episodes: writeEpisodes }[kind];
        const file = { facts: 'facts.json', cards: 'cards.jsonl', episodes: 'memory.json' }[kind];
        try {
            await writer(memoryWorkspace, copy, invoke);
        } catch (e) {
            notify(`Failed to save ${file}: ` + e);
            await loadMemoryData();
        }
    }

    async function loadIndexStats() {
        try {
            const { CodeIndexClient, coverage } = await import('../../../modules/ai/memory/CodeIndex.js');
            const idx = new CodeIndexClient({ workspacePath: memoryWorkspace, invoke });
            const stats = await idx.stats();
            const paths = (await idx.knownHashes()).map(([p]) => p);
            indexStats = { ...stats, coverage: coverage(paths, { root: memoryWorkspace }) };
        } catch (_) { indexStats = null; }
    }

    async function loadAbStats() {
        try {
            const { compareArms, parseMetrics, runsNeeded } =
                await import('../../../modules/ai/memory/SessionMetrics.js');
            const text = await invoke('read_file', { path: `${memoryWorkspace}/.agent/trace/metrics.jsonl` });
            const rows = parseMetrics(text);
            abStats = rows.length ? { ...compareArms(rows), rows: rows.length, needed: runsNeeded(rows) } : null;
        } catch (_) { abStats = null; }   // no runs recorded yet
    }

    async function runStudy() {
        if (studying) return;
        if (!memoryWorkspace) { notify('Please enter a workspace path.'); return; }
        studying = true;
        studyStatus = '';
        try {
            const { runStudyPass, dropStudyCards } = await import('../../../modules/ai/memory/StudyPass.js');
            // The index is written inside `.agent/memory`, so the guard has to know
            // about the directory before the pass starts, not after.
            await allowMemoryDir(memoryWorkspace, invoke);

            const res = await runStudyPass({
                workspacePath: memoryWorkspace, invoke,
                onProgress: ({ read, total }) => { studyStatus = `${read} / ${total}`; },
            });
            if (res.error) { studyStatus = t('memory.study.failed', { error: res.error }); return; }

            studyStatus = t('memory.study.indexed', { files: res.files, symbols: res.symbols, edges: res.edges })
                + (res.skipped ? t('memory.study.skipped', { count: res.skipped }) : '')
                + (res.pruned ? t('memory.study.dropped', { count: res.pruned }) : '')
                + (res.truncated || res.omitted
                    ? ' ' + t('memory.study.capped', { total: res.total || res.files + (res.omitted || 0), omitted: res.omitted || 0 })
                    : '');

            // One-time migration: the first version of this pass wrote a card per
            // symbol. They live in the index now, so the rows left in cards.jsonl
            // are residue in a panel whose whole purpose is being reviewable.
            const { kept, dropped } = dropStudyCards(memoryCards || []);
            if (dropped) {
                memoryCards = kept;
                await writeCards(memoryWorkspace, kept, invoke);
                studyStatus += ' · ' + t('memory.study.migrated', { count: dropped });
            }
            await loadIndexStats();
            await writeProjectOverview(res.areas);
        } catch (e) {
            studyStatus = t('memory.study.failed', { error: String(e?.message || e) });
        } finally {
            studying = false;
        }
    }

    /** Best-effort: a failure here leaves the index — the expensive part — intact. */
    async function writeProjectOverview(areas) {
        try {
            const { structureDigest, detectConventionsFull, buildOverviewPrompt, normalizeOverview, isOverviewStale } =
                await import('../../../modules/ai/memory/ProjectOverview.js');
            const llmService = (await import('../../../modules/ai/LLMService.js')).default;

            const digest = structureDigest(areas, { root: memoryWorkspace });
            if (!digest.length) return;
            const measured = detectConventionsFull(areas, { root: memoryWorkspace });
            const head = await headCommit();
            const prev = await readOverview(memoryWorkspace, invoke);

            let text = prev?.text || '';
            if (isOverviewStale(prev, { head })) {
                const prompt = buildOverviewPrompt(digest, measured.rules);
                const res = await llmService.generate([{ role: 'user', content: prompt }]);
                text = normalizeOverview(res?.content || '');
            }
            await writeOverview(memoryWorkspace, text, invoke, {
                generatedAt: new Date().toISOString(), head, conventions: measured.rules,
            });
            memoryOverview = await readOverview(memoryWorkspace, invoke);
            if (memoryOverview) memoryOverview.head = head;
        } catch (e) {
            console.warn('Overview generation failed:', e);
        }
    }

    async function saveOverview(text) {
        try {
            await writeOverview(memoryWorkspace, text, invoke, {
                generatedAt: memoryOverview?.generatedAt, head: memoryOverview?.head,
                conventions: memoryOverview?.conventions,
            });
            memoryOverview = await readOverview(memoryWorkspace, invoke);
        } catch (e) {
            notify('Failed to save overview.md: ' + (e.message || e));
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    $effect(() => {
        let cancelled = false;
        (async () => {
            await loadConfig();
            if (cancelled) return;
            try {
                secretStorage = await invoke('get_secret_storage_info');
            } catch (_) { /* older backend — say nothing rather than guess */ }
            await skillManager.refresh();
            if (!cancelled) skillsList = skillManager.getAll();
        })();
        return () => { cancelled = true; };
    });

    // Version and update-signing status come from the Tauri side and neither
    // changes while the app runs, so they resolve in the background.
    $effect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [{ getVersion }, { isUpdaterConfigured }] = await Promise.all([
                    import('@tauri-apps/api/app'),
                    import('../../updater.js'),
                ]);
                if (cancelled) return;
                appVersion = await getVersion();
                updatesConfigured = await isUpdaterConfigured();
                licensingOn = await licensingConfigured();
                await refreshLicense();
                if (!cancelled) license = licenseState();
            } catch (_) {
                // Browser/dev mode: no Tauri. The tab then says updates are not
                // configured, which is true of a non-packaged build.
            }
        })();
        return () => { cancelled = true; };
    });

    $effect(() => {
        let un = null;
        listen('rag-progress', (e) => { ragProgress = e.payload?.percent ?? 0; })
            .then(f => { un = f; })
            .catch(() => { /* no Tauri in dev */ });
        return () => { try { un?.(); } catch (_) {} };
    });
</script>

<div class="view-container">
    <div class="view-header">
        <div>
            <h1>Settings</h1>
            <p class="subtitle">Configure AI connection instances, API keys, and MCP servers</p>
        </div>
    </div>

    <div class="cfg-layout">
        <div class="tabs-vertical cfg-tabs">
            {#each CONFIG_TABS as tab}
                <button type="button" class="settings-tab-btn" class:active={activeTab === tab.id}
                    onclick={() => (activeTab = tab.id)}>
                    {@html icon(tab.icon)} {tab.label}
                </button>
            {/each}
        </div>

        <div class="settings-content-wrapper">
            {#if activeTab === 'llm'}
                <div class="card settings-card cfg-full">
                    <div class="card-header cfg-card-head">
                        <div>
                            <h3>{@html icon('llm', 15)} LLM Connections</h3>
                            <p class="subtitle">Manage connection instances and credentials</p>
                        </div>
                        <div class="cfg-head-actions">
                            <button class="btn btn-secondary" onclick={save}>{@html icon('save', 13)} Save Settings</button>
                            <button class="btn btn-primary" onclick={() => openInstanceModal()}>{@html icon('plus', 13)} Add Connection</button>
                        </div>
                    </div>
                    <ConnectionTable
                        instances={config.llm_instances || []}
                        activeId={config.active_llm_instance_id}
                        onSetActive={(id) => { if (id) config = { ...config, active_llm_instance_id: id }; }}
                        onEdit={openInstanceModal}
                        onDelete={deleteInstance}
                    />
                </div>
            {:else if activeTab === 'mcp'}
                <div class="card settings-card cfg-full">
                    <div class="card-header cfg-card-head">
                        <div>
                            <h3>{@html icon('mcp', 15)} Model Context Protocol (MCP) Servers</h3>
                            <p class="subtitle">Configure local or remote MCP servers in JSON format</p>
                        </div>
                        <button class="btn btn-primary" onclick={save}>{@html icon('save', 13)} Save Settings</button>
                    </div>
                    <SettingsMcp text={config.mcp_text || '{}'}
                        onChange={(text) => (config = { ...config, mcp_text: text.trim() })} />
                </div>
            {:else if activeTab === 'general'}
                <div class="card settings-card cfg-full">
                    <div class="card-header cfg-card-head">
                        <div>
                            <h3>{@html icon('gear', 15)} General Settings</h3>
                            <p class="subtitle">Configure proxy, logging, and other general preferences</p>
                        </div>
                        <button class="btn btn-primary" onclick={save}>{@html icon('save', 13)} Save Settings</button>
                    </div>
                    <SettingsGeneral
                        {config} {connection} {openSections} {approvedCommands}
                        {autoApproveWorkspaces} {storageUsage} {exportStatus} {secretStorage}
                        {appVersion} {updatesConfigured} {uiLocale} {license}
                        licensingConfigured={licensingOn}
                        hasLicenseKey={hasStoredKey()}
                        onChange={patchConfig}
                        onToggleSection={(k, open) => { openSections = writeOpenSection(k, open); }}
                        onSelectLogDir={async () => {
                            try { const sel = await pickFolder(); if (sel) patchConfig({ log_dir: sel }); }
                            catch (e) { console.error('Failed to select folder:', e); }
                        }}
                        onCopyToken={() => { if (connection.token) navigator.clipboard.writeText(connection.token); }}
                        onExportConnection={exportConnection}
                        onRefreshStorage={refreshStorage}
                        onPurgeApiLogs={() => {
                            if (!confirmAction('Delete the old API logs (localStorage jh_api_logs)? This does not affect Monitor per-task logs.')) return;
                            try { localStorage.removeItem('jh_api_logs'); } catch (_) {}
                            refreshStorage();
                        }}
                        onClearCommLog={async () => {
                            if (!confirmAction('Clear the communication log file?')) return;
                            try { await invoke('clear_comm_log'); } catch (e) { console.error(e); }
                            refreshStorage();
                        }}
                        onAddApprovedCommand={(v) => addTo(APPROVED_COMMANDS_KEY, v)}
                        onRemoveApprovedCommand={(v) => removeFrom(APPROVED_COMMANDS_KEY, v)}
                        onAddAutoWorkspace={(v) => addTo(AUTO_APPROVE_WS_KEY, v)}
                        onRemoveAutoWorkspace={(v) => removeFrom(AUTO_APPROVE_WS_KEY, v)}
                        onRunSetup={async () => {
                            const { openOnboarding } = await import('../../onboarding.js');
                            await openOnboarding();
                        }}
                        onChangeLocale={(code) => {
                            // The switcher lives in Settings but the strings it changes
                            // are everywhere, so the whole dashboard re-renders.
                            if (setLocale(code) === code) { uiLocale = code; onLocaleChange(); }
                        }}
                        onActivateLicense={async (key) => { await activateLicense(key); license = licenseState(); }}
                        onClearLicense={async () => { await clearLicense(); license = licenseState(); }}
                        onCheckUpdate={async () => {
                            const { checkForUpdate } = await import('../../updater.js');
                            // Not silent: the user asked, so "you are up to date" and
                            // any failure both need to be said out loud.
                            await checkForUpdate({ silent: false });
                        }}
                    />
                </div>
            {:else if activeTab === 'templates'}
                <TemplatesTab
                    {templates} editing={editingTemplate} showForm={showTemplateForm}
                    onNew={() => { editingTemplate = null; showTemplateForm = true; }}
                    onCancel={() => { editingTemplate = null; showTemplateForm = false; }}
                    onEdit={(key) => {
                        const tpl = promptTemplateManager.get(key);
                        if (!tpl) return;
                        editingTemplate = tpl;
                        showTemplateForm = true;
                    }}
                    onDelete={async (key) => {
                        if (!confirmAction('Delete the template "/' + key + '"?')) return;
                        promptTemplateManager.remove(key);
                        templates = promptTemplateManager.getAll();
                        await persistConfig();
                    }}
                    onSave={async (tpl) => {
                        promptTemplateManager.set(tpl.key, tpl.label, tpl.prompt, tpl.icon);
                        templates = promptTemplateManager.getAll();
                        await persistConfig();
                        editingTemplate = null;
                        showTemplateForm = false;
                    }}
                />
            {:else if activeTab === 'skills'}
                <SkillsTab
                    skills={skillsList} editing={editingSkill} showForm={showSkillForm}
                    onNew={() => { editingSkill = null; showSkillForm = true; }}
                    onCancel={() => { editingSkill = null; showSkillForm = false; }}
                    onEdit={async (name) => {
                        try {
                            editingSkill = { name, content: await skillManager.readContent(name) };
                            showSkillForm = true;
                        } catch (e) { notify('Failed to load skill: ' + (e.message || e)); }
                    }}
                    onDelete={async (name) => {
                        if (!confirmAction('Delete the skill "/' + name + '"?')) return;
                        try { await skillManager.delete(name); skillsList = skillManager.getAll(); }
                        catch (e) { notify('Failed to delete: ' + (e.message || e)); }
                    }}
                    onSave={async (skill) => {
                        try {
                            await skillManager.save(skill.name, skill.content);
                            skillsList = skillManager.getAll();
                            editingSkill = null;
                            showSkillForm = false;
                        } catch (e) { notify('Failed to save: ' + (e.message || e)); }
                    }}
                    onBundle={async (name) => {
                        try {
                            const dir = await skillManager.promoteToDirectory(name);
                            skillsList = skillManager.getAll();
                            // The point of the folder is putting things IN it, so say
                            // where it is rather than only that it worked.
                            toast('Skill "/' + name + '" is now a folder: ' + dir);
                        } catch (e) { notify('Failed to convert: ' + (e.message || e)); }
                    }}
                />
            {:else if activeTab === 'rag'}
                <RagTab
                    path={ragPath} dirs={ragDirs} exclusions={ragExclusions}
                    extensions={ragExtensions} progress={ragProgress}
                    onPathChange={(v) => (ragPath = v.trim())}
                    onLoadDirs={async () => {
                        if (!ragPath) return;
                        try {
                            ragDirs = await invoke('get_directory_structure', { path: ragPath, maxDepth: 5 });
                            ragExclusions = [];
                        } catch (e) { notify('Failed to read the directory: ' + (e.message || e)); }
                    }}
                    onToggleDir={(paths, include) => {
                        // The component hands back the directory AND its descendants,
                        // so the cascade is one model update, not a DOM walk.
                        const set = new Set(ragExclusions);
                        for (const p of paths) { if (include) set.delete(p); else set.add(p); }
                        ragExclusions = [...set];
                    }}
                    onToggleExtension={(ext, on) => {
                        const set = new Set(ragExtensions);
                        if (on) set.add(ext); else set.delete(ext);
                        ragExtensions = [...set];
                    }}
                />
            {:else if activeTab === 'memory'}
                <MemoryTab
                    workspace={memoryWorkspace || projects[0] || ''}
                    {projects}
                    facts={memoryFacts} episodes={memoryEpisodes} cards={memoryCards}
                    {indexStats} {abStats} overview={memoryOverview}
                    {studying} {studyStatus}
                    onWorkspaceChange={(v) => (memoryWorkspace = v.trim())}
                    onBrowse={async () => {
                        try { const sel = await pickFolder(); if (sel) memoryWorkspace = sel; }
                        catch (_) { /* dialog cancelled */ }
                    }}
                    onLoad={async () => {
                        if (!memoryWorkspace) { notify('Please enter a workspace path.'); return; }
                        await loadMemoryData();
                        await loadIndexStats();
                        await loadAbStats();
                    }}
                    onSaveOverview={saveOverview}
                    onStudy={runStudy}
                    onEditFact={(i, text) => mutateStore('facts', (l) => { l[i] = { ...l[i], fact: capFactText(text) }; })}
                    onDeleteFact={(i) => { if (confirmAction('Delete this fact?')) mutateStore('facts', (l) => l.splice(i, 1)); }}
                    onClearFacts={() => { if (confirmAction('Delete ALL durable facts?')) mutateStore('facts', (l) => (l.length = 0)); }}
                    onDeleteEpisode={(i) => { if (confirmAction('Delete this episode?')) mutateStore('episodes', (l) => l.splice(i, 1)); }}
                    onClearEpisodes={() => { if (confirmAction('Delete ALL session history?')) mutateStore('episodes', (l) => (l.length = 0)); }}
                    onToggleCard={(i, disabled) => mutateStore('cards', (l) => { l[i] = { ...l[i], disabled }; })}
                    onDeleteCard={(i) => { if (confirmAction('Delete this learned card?')) mutateStore('cards', (l) => l.splice(i, 1)); }}
                    onClearCards={() => { if (confirmAction('Delete ALL learned cards?')) mutateStore('cards', (l) => (l.length = 0)); }}
                />
            {/if}
        </div>
    </div>

    {#if showModal}
        <ConnectionModal
            instance={editingInstance}
            testStatus={connTestStatus}
            onSave={saveInstance}
            onCancel={closeInstanceModal}
            onTest={testInstance}
        />
    {/if}
</div>

<style>
    /* Moved off the inline style="" attributes the string builder carried. */
    .cfg-layout {
        display: flex; gap: 24px; min-height: 500px; width: 100%;
        align-items: flex-start; margin-top: 8px;
    }
    .cfg-tabs {
        width: 220px; display: flex; flex-direction: column; gap: 4px;
        border-right: 1px solid var(--border); padding-right: 16px; flex-shrink: 0;
    }
    .settings-content-wrapper { flex: 1; min-width: 0; }
    .cfg-full { height: 100%; }
    .cfg-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .cfg-head-actions { display: flex; gap: 8px; }

    /* The active state was a 20-line inline style object per button. */
    .settings-tab-btn {
        padding: 12px 16px;
        background: transparent;
        border: none;
        border-left: 3px solid transparent;
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
        transition: all var(--transition-fast);
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        outline: none;
    }
    .settings-tab-btn:hover { color: var(--text-primary); }
    .settings-tab-btn.active {
        background: var(--bg-tertiary);
        border-left-color: var(--accent);
        border-radius: 0 var(--radius-md) var(--radius-md) 0;
        color: var(--accent);
        font-weight: 600;
    }
</style>
