import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { promptTemplateManager } from '../../modules/ai/PromptTemplateManager.js';
import { skillManager } from '../../modules/ai/SkillManager.js';

export class ConfigView {
    constructor() {
        this.config = {
            openai_key: '',
            anthropic_key: '',
            gemini_key: '',
            azure_key: '',
            azure_endpoint: '',
            azure_deployment: '',
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
        this.activeTab = 'llm'; // Tab: 'llm', 'mcp', 'general', 'logs', 'templates', 'skills'
        this.showModal = false;
        this.editingInstance = null; // null if adding new
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

    readFormValues() {
        // Read MCP servers JSON if visible in DOM
        const mcpTextarea = document.getElementById('cfg-mcp-servers');
        if (mcpTextarea) {
            this.config.mcp_text = mcpTextarea.value.trim();
        }

        // Read general settings if visible in DOM
        const proxyEl = document.getElementById('cfg-proxy-url');
        if (proxyEl) this.config.proxy_url = proxyEl.value.trim() || null;

        const loggingToggle = document.getElementById('cfg-logging-enabled-toggle');
        if (loggingToggle) this.config.logging_enabled = loggingToggle.classList.contains('active');

        const logDirEl = document.getElementById('cfg-log-dir');
        if (logDirEl) this.config.log_dir = logDirEl.value.trim() || null;

        const planModeEl = document.getElementById('cfg-plan-mode');
        if (planModeEl) this.config.plan_mode = planModeEl.value;
        const fastModelEl = document.getElementById('cfg-fast-model');
        if (fastModelEl) this.config.fast_model_id = fastModelEl.value || null;
        const deepModelEl = document.getElementById('cfg-deep-model');
        if (deepModelEl) this.config.deep_model_id = deepModelEl.value || null;

        // Helper: read a numeric input where blank or 0 means "disabled / unlimited"
        const readNum = (id, fallback = 0) => {
            const el = document.getElementById(id);
            if (!el) return undefined; // field not in DOM (different tab) — preserve existing value
            const raw = el.value.trim();
            if (raw === '') return 0;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n >= 0 ? n : fallback;
        };

        const maxSteps                 = readNum('cfg-max-steps');
        const tokenBudget              = readNum('cfg-token-budget');
        const wallClock                = readNum('cfg-wall-clock');
        const noProgress               = readNum('cfg-no-progress', 15);
        const identicalThreshold       = readNum('cfg-identical-threshold', 5);
        const cycleRepeats             = readNum('cfg-cycle-repeats', 3);

        if (maxSteps           !== undefined) this.config.max_steps                  = maxSteps;
        if (tokenBudget        !== undefined) this.config.token_budget               = tokenBudget;
        if (wallClock          !== undefined) this.config.wall_clock_minutes         = wallClock;
        if (noProgress         !== undefined) this.config.no_progress_window         = noProgress;
        if (identicalThreshold !== undefined) this.config.identical_call_threshold   = identicalThreshold;
        if (cycleRepeats       !== undefined) this.config.cycle_detection_min_repeats = cycleRepeats;

        const writeAllowedEl = document.getElementById('cfg-write-allowed');
        if (writeAllowedEl) {
            this.config.write_allowed_paths = writeAllowedEl.value
                .split('\n')
                .map(p => p.trim())
                .filter(p => p.length > 0);
        }
    }

    getModalValue(field) {
        if (!this.editingInstance) {
            if (field === 'provider') return 'openai';
            if (field === 'api_version') return '2024-08-01-preview';
            return '';
        }
        const v = this.editingInstance[field];
        // Preserve numeric 0 (a valid temperature) instead of coercing it to ''.
        if (v === 0) return 0;
        return v || '';
    }

    getModalKeyPlaceholder(provider) {
        const p = provider || (this.editingInstance ? this.editingInstance.provider : 'openai');
        switch (p) {
            case 'openai': return 'sk-proj-...';
            case 'anthropic': return 'sk-ant-...';
            case 'gemini': return 'AIzaSy...';
            case 'azure': return 'API Key';
            case 'ollama': return 'Not required';
            case 'generic': return 'API Key (Optional)';
            default: return 'API Key';
        }
    }

    getModalUrlPlaceholder(provider) {
        const p = provider || (this.editingInstance ? this.editingInstance.provider : 'openai');
        switch (p) {
            case 'openai': return 'https://api.openai.com/v1';
            case 'anthropic': return 'https://api.anthropic.com/v1';
            case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta';
            case 'azure': return 'https://your-resource.openai.azure.com/';
            case 'ollama': return 'http://localhost:11434';
            case 'generic': return 'http://localhost:11434/v1';
            default: return 'Use default';
        }
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
                            <h3>🧠 LLM Connections</h3>
                            <p class="subtitle">Manage connection instances and credentials</p>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-secondary" id="btn-save-config">💾 Save Settings</button>
                            <button class="btn btn-primary" id="btn-open-add-modal">➕ Add Connection</button>
                        </div>
                    </div>
                    
                    <div class="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width: 70px; text-align: center;">Default</th>
                                    <th>Provider</th>
                                    <th>Connection Name</th>
                                    <th>Model</th>
                                    <th>Base URL</th>
                                    <th style="text-align: right; width: 180px;">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${instances.length === 0 ? `
                                    <tr>
                                        <td colspan="6" style="text-align: center; padding: 32px; color: var(--text-secondary);">
                                            No LLM connections registered. Click "Add Connection" to register one.
                                        </td>
                                    </tr>
                                ` : (() => {
                                    // If no active connection has been chosen yet, treat the first one as default
                                    const effectiveActiveId = this.config.active_llm_instance_id
                                        || (instances[0] && instances[0].id);
                                    return instances.map(inst => {
                                        let providerName = '';
                                        let providerIcon = '🤖';
                                        switch (inst.provider) {
                                            case 'openai': providerName = 'OpenAI GPT'; providerIcon = '🤖'; break;
                                            case 'anthropic': providerName = 'Anthropic Claude'; providerIcon = '🧠'; break;
                                            case 'gemini': providerName = 'Google Gemini'; providerIcon = '✨'; break;
                                            case 'azure': providerName = 'Azure OpenAI'; providerIcon = '☁️'; break;
                                            case 'ollama': providerName = 'Ollama (Local)'; providerIcon = '🦙'; break;
                                            case 'generic': providerName = 'Generic OpenAI'; providerIcon = '🔌'; break;
                                            default: providerName = inst.provider;
                                        }
                                        const isActive = effectiveActiveId === inst.id;
                                        return `
                                            <tr ${isActive ? 'style="background: rgba(0,200,255,0.04);"' : ''}>
                                                <td style="text-align: center;">
                                                    <input type="radio" name="active-llm-instance"
                                                        class="active-llm-radio"
                                                        data-id="${inst.id}"
                                                        ${isActive ? 'checked' : ''}
                                                        title="Use this connection by default for the agent and Direct Chat"
                                                        style="cursor: pointer; accent-color: var(--accent);">
                                                </td>
                                                <td><span style="margin-right: 8px;">${providerIcon}</span> ${providerName}</td>
                                                <td style="font-weight: 600;">${inst.name}${isActive ? ' <span style="color: var(--accent); font-size: 10px; font-weight: 600; margin-left: 6px;">★ ACTIVE</span>' : ''}</td>
                                                <td><code style="font-family: var(--font-mono); font-size: 11px; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">${inst.model}</code></td>
                                                <td style="color: var(--text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${inst.base_url || 'Default'}</td>
                                                <td>
                                                    <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
                                                        <button class="btn btn-secondary btn-sm btn-edit-instance" data-id="${inst.id}">✏️ Edit</button>
                                                        <button class="btn btn-danger btn-sm btn-delete-instance" data-id="${inst.id}">🗑️ Delete</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('');
                                })()}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        } else if (this.activeTab === 'mcp') {
            tabContentHtml = `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3>🔌 Model Context Protocol (MCP) Servers</h3>
                            <p class="subtitle">Configure local or remote MCP servers in JSON format</p>
                        </div>
                        <button class="btn btn-primary" id="btn-save-config">💾 Save Settings</button>
                    </div>
                    <div class="input-group">
                        <label class="input-label">Configuration JSON</label>
                        <textarea id="cfg-mcp-servers" class="textarea" rows="16" style="font-family: var(--font-mono); font-size: 13px;">${mcpJson}</textarea>
                        <p class="input-hint" style="margin-top: 8px;">Edit the MCP servers config in JSON format. Example: {"sqlite": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite"]}}</p>
                    </div>
                </div>
            `;
        } else if (this.activeTab === 'general') {
            tabContentHtml = `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3>⚙️ General Settings</h3>
                            <p class="subtitle">Configure proxy, logging, and other general preferences</p>
                        </div>
                        <button class="btn btn-primary" id="btn-save-config">💾 Save Settings</button>
                    </div>
                    <div class="provider-card-fields">
                        <div class="input-group">
                            <label class="input-label">HTTP Proxy URL (Optional)</label>
                            <input type="text" id="cfg-proxy-url" class="input" value="${this.config.proxy_url || ''}" placeholder="http://127.0.0.1:7890">
                        </div>
                        <!-- ── Agent Safety Limits ────────────────────────────── -->
                        <div style="margin-top: 8px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary);">
                            <div style="font-size: 12px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;">
                                🛡 Agent Safety Limits
                            </div>
                            <p style="font-size: 11.5px; color: var(--text-tertiary); margin: 0 0 14px 0; line-height: 1.5;">
                                Controls when the agent loop auto-stops or gets nudged.
                                For every field below, <strong>0 (or empty) = disabled / unlimited</strong>.
                                Recommended approach for difficult tasks: leave step cap off, set a token / wall-clock budget you can live with, keep loop detectors generous.
                            </p>

                            <div class="input-group" style="margin-bottom: 12px;">
                                <label class="input-label">Plan-First Mode</label>
                                <select id="cfg-plan-mode" class="input">
                                    <option value="off"${(this.config.plan_mode ?? 'auto') === 'off' ? ' selected' : ''}>Off — never require a plan</option>
                                    <option value="auto"${(this.config.plan_mode ?? 'auto') === 'auto' ? ' selected' : ''}>Auto — plan complex tasks only (recommended)</option>
                                    <option value="always"${(this.config.plan_mode ?? 'auto') === 'always' ? ' selected' : ''}>Always — require an approved plan before any edit</option>
                                </select>
                                <p class="input-hint">
                                    When active, the agent must <strong>investigate → propose a phased plan → get your approval</strong>
                                    before it can run any file-modifying tool. Investigation tools (read / grep / list) are always allowed.
                                    <strong>Auto</strong> only gates tasks it judges complex; simple edits run unblocked.
                                </p>
                            </div>

                            <div class="input-group" style="margin-bottom: 12px;">
                                <label class="input-label">Model Routing — Fast tier</label>
                                <select id="cfg-fast-model" class="input">
                                    <option value="">(未設定 — アクティブモデルを使用)</option>
                                    ${(this.config.llm_instances || []).map(inst => {
                                        const id = `${inst.id}:${inst.model}`;
                                        return `<option value="${id}"${(this.config.fast_model_id || '') === id ? ' selected' : ''}>${inst.name} (${inst.model})</option>`;
                                    }).join('')}
                                </select>
                                <p class="input-hint">即時応答向けの軽量モデル。単発タスク(アプリ連携の intent / freeform)や、複雑判定されないタスクで使われます。</p>
                            </div>

                            <div class="input-group" style="margin-bottom: 12px;">
                                <label class="input-label">Model Routing — Deep tier</label>
                                <select id="cfg-deep-model" class="input">
                                    <option value="">(未設定 — アクティブモデルを使用)</option>
                                    ${(this.config.llm_instances || []).map(inst => {
                                        const id = `${inst.id}:${inst.model}`;
                                        return `<option value="${id}"${(this.config.deep_model_id || '') === id ? ' selected' : ''}>${inst.name} (${inst.model})</option>`;
                                    }).join('')}
                                </select>
                                <p class="input-hint">長考向けの高性能モデル。プラン必須/複雑タスク、および長時間タスクの自動エスカレーション(step 半ば到達時)で使われます。両方未設定ならルーティング無効(常にアクティブモデル)。</p>
                            </div>

                            <div class="input-group" style="margin-bottom: 12px;">
                                <label class="input-label">Max Agent Steps</label>
                                <input type="number" id="cfg-max-steps" class="input" value="${this.config.max_steps ?? 0}" min="0" max="10000" placeholder="0 = unlimited">
                                <p class="input-hint">Hard step ceiling. <strong>Recommended: 0 (unlimited)</strong> — the budgets and loop detectors below are the proper safeguards.</p>
                            </div>

                            <div class="grid-2" style="gap: 12px;">
                                <div class="input-group">
                                    <label class="input-label">Token Budget (cost cap)</label>
                                    <input type="number" id="cfg-token-budget" class="input" value="${this.config.token_budget ?? 0}" min="0" max="100000000" placeholder="0 = unlimited">
                                    <p class="input-hint">Hard stop when cumulative prompt + completion tokens reach this number. Soft reminder at 80%. Example: <code>1000000</code> (1M tokens).</p>
                                </div>

                                <div class="input-group">
                                    <label class="input-label">Wall-clock Timeout (minutes)</label>
                                    <input type="number" id="cfg-wall-clock" class="input" value="${this.config.wall_clock_minutes ?? 0}" min="0" max="1440" placeholder="0 = unlimited">
                                    <p class="input-hint">Hard stop after N minutes of runtime. Soft reminder at 80%. Example: <code>30</code>.</p>
                                </div>
                            </div>

                            <div class="input-group" style="margin-top: 12px;">
                                <label class="input-label">No-Progress Window (steps)</label>
                                <input type="number" id="cfg-no-progress" class="input" value="${this.config.no_progress_window ?? 15}" min="0" max="200" placeholder="15">
                                <p class="input-hint">
                                    If the agent runs this many consecutive steps without modifying any file
                                    (only <code>read_file</code> / <code>grep_search</code> / <code>list_files</code>),
                                    it gets a one-time reminder to either finish or report blockers.
                                    <strong>0 disables this detector.</strong> Recommended: 15.
                                </p>
                            </div>

                            <div class="grid-2" style="gap: 12px; margin-top: 4px;">
                                <div class="input-group">
                                    <label class="input-label">Identical Call Threshold</label>
                                    <input type="number" id="cfg-identical-threshold" class="input" value="${this.config.identical_call_threshold ?? 5}" min="0" max="50" placeholder="5">
                                    <p class="input-hint">
                                        Soft warning when the same tool+args has been called N times in a row.
                                        Hard stop only at 3× this number (warning ignored).
                                        <strong>0 disables.</strong> Increase if you keep hitting it on legitimate retries.
                                    </p>
                                </div>

                                <div class="input-group">
                                    <label class="input-label">Cycle Detection Min Repeats</label>
                                    <input type="number" id="cfg-cycle-repeats" class="input" value="${this.config.cycle_detection_min_repeats ?? 3}" min="0" max="20" placeholder="3">
                                    <p class="input-hint">
                                        Soft warning when an ABAB or ABCABC oscillation repeats this many times.
                                        Higher = more permissive. <strong>0 disables.</strong>
                                    </p>
                                </div>
                            </div>
                        </div>
                        <!-- ── Write-Allowed Directories ──────────────────────── -->
                        <div style="margin-top: 8px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary);">
                            <div style="font-size: 12px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;">
                                📂 Write-Allowed Directories
                            </div>
                            <p style="font-size: 11.5px; color: var(--text-tertiary); margin: 0 0 12px 0; line-height: 1.5;">
                                エージェントが<strong>承認なしで書き込めるディレクトリ</strong>を1行に1つ記入します。
                                ここに含まれるパス（とその配下）への <code>write_file</code> / 編集は承認ダイアログをスキップします。
                                現在のワークスペースと承認済みプロジェクトは常に許可されます。リスト外への書き込みは引き続き承認が必要です。
                            </p>
                            <textarea id="cfg-write-allowed" class="input" rows="4" placeholder="C:\\work\\reports&#10;C:\\data\\output" style="font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical;">${(this.config.write_allowed_paths || []).join('\n')}</textarea>
                        </div>
                        <div class="input-group">
                            <div class="toggle-wrap" id="cfg-logging-enabled-wrap">
                                <div class="toggle ${this.config.logging_enabled ? 'active' : ''}" id="cfg-logging-enabled-toggle"></div>
                                <span class="toggle-label">Enable AI Interaction Logging</span>
                            </div>
                        </div>
                        <div class="input-group">
                            <label class="input-label">Log Directory</label>
                            <div style="display: flex; gap: 8px;">
                                <input type="text" id="cfg-log-dir" class="input" value="${this.config.log_dir || ''}" placeholder="C:\\path\\to\\logs" style="flex: 1;">
                                <button class="btn btn-secondary" id="btn-select-log-dir" style="padding: 0 12px; display: flex; align-items: center; justify-content: center; height: 36px; border: 1px solid var(--border);" type="button">📁 Select</button>
                            </div>
                        </div>
                        <div class="input-group" style="border-top: 1px solid var(--border-light); padding-top: 16px; margin-top: 16px;">
                            <label class="input-label">🗄 ストレージ使用量</label>
                            <div id="cfg-storage-usage" style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;line-height:1.7;">
                                <em style="color:var(--text-tertiary)">「更新」を押すと表示します</em>
                            </div>
                            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                                <button class="btn btn-secondary" id="btn-storage-refresh" type="button" style="font-size:12px;">↻ 更新</button>
                                <button class="btn btn-secondary" id="btn-purge-apilogs" type="button" style="font-size:12px;color:var(--error);border-color:var(--error)">旧APIログ(localStorage)を削除</button>
                                <button class="btn btn-secondary" id="btn-clear-commlog" type="button" style="font-size:12px;color:var(--error);border-color:var(--error)">通信ログファイルをクリア</button>
                            </div>
                            <p class="input-hint">LLMコールの確認は <strong>Monitor</strong>（タスク別）に一本化されました。タスク履歴の削除は <strong>History</strong> から行えます。</p>
                        </div>
                        <div class="input-group" style="border-top: 1px solid var(--border-light); padding-top: 16px; margin-top: 16px;">
                            <label class="input-label">J.H AI Agent Connection Token (API Key)</label>
                            <div style="display: flex; gap: 8px;">
                                <input type="text" id="cfg-connection-token" class="input" value="${window.apiClient ? window.apiClient.token : ''}" readonly style="flex: 1; font-family: var(--font-mono); background: var(--bg-primary); cursor: default;">
                                <button class="btn btn-secondary" id="btn-copy-connection-token" style="padding: 0 12px; display: flex; align-items: center; justify-content: center; height: 36px; border: 1px solid var(--border);" type="button">📋 Copy</button>
                            </div>
                            <p class="input-hint">Use this token and Port <strong>${window.apiClient ? window.apiClient.port : '14300'}</strong> to connect from external tools like JHEditor.</p>

                            <!-- ── Export connection settings so other JH apps auto-discover JH AI ── -->
                            <div style="margin-top: 14px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm); border: 1px solid var(--border);">
                                <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                                    <div>
                                        <strong style="font-size: 13px; color: var(--text-primary);">📤 Export to standard path</strong>
                                        <p class="input-hint" style="margin: 4px 0 0 0;">
                                            Saves this host/port/token to <code>%APPDATA%/JH/ai-connection.json</code> (Windows)
                                            so other JH apps (JHEditor, JHER, JH Task Manager…) can auto-connect without
                                            re-entering credentials.
                                        </p>
                                    </div>
                                    <button class="btn btn-secondary" id="btn-export-connection" type="button" style="white-space: nowrap;">💾 Export</button>
                                </div>
                                <div id="export-connection-status" style="margin-top: 8px; font-size: 11.5px;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (this.activeTab === 'templates') {
            tabContentHtml = this.renderTemplatesTabHtml();
        } else if (this.activeTab === 'skills') {
            tabContentHtml = this.renderSkillsTabHtml();
        } else if (this.activeTab === 'logs') {
            tabContentHtml = this.renderLogsTabHtml();
        } else if (this.activeTab === 'rag') {
            tabContentHtml = this.renderRagTabHtml();
        }

        // Render modal overlay if visible
        const modalHtml = this.showModal ? `
            <div class="modal-overlay" id="llm-modal-overlay">
                <div class="modal" style="width: 500px; max-width: 90%;">
                    <div class="modal-title" style="margin-bottom: 20px;">
                        <h3>${this.editingInstance ? '✏️ Edit LLM Connection' : '➕ Add LLM Connection'}</h3>
                    </div>
                    
                    <div class="provider-card-fields">
                        <div class="input-group">
                            <label class="input-label">Provider Type</label>
                            <select id="modal-provider-type" class="select" ${this.editingInstance ? 'disabled' : ''}>
                                <option value="openai" ${this.getModalValue('provider') === 'openai' ? 'selected' : ''}>OpenAI GPT</option>
                                <option value="anthropic" ${this.getModalValue('provider') === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
                                <option value="gemini" ${this.getModalValue('provider') === 'gemini' ? 'selected' : ''}>Google Gemini</option>
                                <option value="azure" ${this.getModalValue('provider') === 'azure' ? 'selected' : ''}>Azure OpenAI</option>
                                <option value="ollama" ${this.getModalValue('provider') === 'ollama' ? 'selected' : ''}>Ollama (Local)</option>
                                <option value="generic" ${this.getModalValue('provider') === 'generic' ? 'selected' : ''}>Generic OpenAI-Compatible</option>
                            </select>
                        </div>

                        <div class="grid-2">
                            <div class="input-group">
                                <label class="input-label">Connection Name</label>
                                <input type="text" id="modal-inst-name" class="input" value="${this.getModalValue('name')}" placeholder="e.g. My Connection">
                            </div>
                            <div class="input-group">
                                <label class="input-label">Model Name</label>
                                <input type="text" id="modal-inst-model" class="input" value="${this.getModalValue('model')}" placeholder="e.g. gpt-4o, claude-3-5-sonnet">
                            </div>
                        </div>

                        <div class="input-group" id="modal-key-group">
                            <label class="input-label">API Key</label>
                            <div class="input-password-wrap">
                                <input type="password" id="modal-inst-key" class="input" value="${this.getModalValue('api_key')}" placeholder="${this.getModalKeyPlaceholder(this.getModalValue('provider'))}">
                                <button class="input-password-toggle btn-toggle-password" type="button">👁️</button>
                            </div>
                        </div>

                        <div class="input-group" id="modal-url-group">
                            <label class="input-label" id="modal-url-label">Base URL (Optional Override)</label>
                            <input type="text" id="modal-inst-url" class="input" value="${this.getModalValue('base_url')}" placeholder="${this.getModalUrlPlaceholder(this.getModalValue('provider'))}">
                        </div>

                        <div class="input-group" id="modal-version-group" style="display: ${this.getModalValue('provider') === 'azure' ? 'flex' : 'none'};">
                            <label class="input-label">API Version</label>
                            <input type="text" id="modal-inst-version" class="input" value="${this.getModalValue('api_version')}" placeholder="e.g. 2024-08-01-preview">
                        </div>

                        <div class="input-group">
                            <label class="input-label">Context Window (tokens, optional)</label>
                            <input type="number" id="modal-inst-context" class="input" min="0" step="1024" value="${this.getModalValue('context_window') || ''}" placeholder="Auto-detect (leave blank). e.g. 65536 for DeepSeek, 131072 for Qwen">
                            <small style="color: var(--text-secondary); font-size: 11px; margin-top: 4px;">Set this for models we don't recognize so history compaction uses the correct window. Leave blank to auto-detect by model name.</small>
                        </div>

                        <div class="input-group">
                            <label class="input-label">Max Output Tokens (optional)</label>
                            <input type="number" id="modal-inst-maxout" class="input" min="0" step="256" value="${this.getModalValue('max_output_tokens') || ''}" placeholder="Provider default (blank). Anthropic uses 8192 if blank.">
                            <small style="color: var(--text-secondary); font-size: 11px; margin-top: 4px;">Caps the model's reply length. Leave blank for the provider default.</small>
                        </div>

                        <div class="input-group">
                            <label class="input-label">Temperature (optional, 0.0–2.0)</label>
                            <input type="number" id="modal-inst-temp" class="input" min="0" max="2" step="0.1" value="${this.getModalValue('temperature') ?? ''}" placeholder="Provider default (blank). Use ~0.2 for reliable agent tool-use.">
                            <small style="color: var(--text-secondary); font-size: 11px; margin-top: 4px;">Lower = more deterministic (better for tool-calling). Leave blank for the provider default.</small>
                        </div>
                    </div>

                    <div id="modal-test-status" style="margin-top: 12px; font-size: 12px; display: none; padding: 8px 12px; border-radius: var(--radius-sm); font-weight: 500;"></div>

                    <div class="modal-actions" style="margin-top: 20px; display: flex; justify-content: space-between; gap: 8px;">
                        <button class="btn btn-secondary" id="btn-modal-test" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); width: auto;">⚡ Test Connection</button>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-secondary" id="btn-modal-cancel">Cancel</button>
                            <button class="btn btn-primary" id="btn-modal-save">Save Connection</button>
                        </div>
                    </div>
                </div>
            </div>
        ` : '';

        return `
            <style>
                .settings-tab-btn:hover {
                    color: var(--text-primary) !important;
                    background: var(--bg-hover) !important;
                }
                .settings-tab-btn.active:hover {
                    color: var(--accent) !important;
                    background: var(--bg-tertiary) !important;
                }
            </style>

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
                        <button class="settings-tab-btn ${this.activeTab === 'llm' ? 'active' : ''}" data-tab="llm" style="${getTabStyle('llm')}">🧠 LLM Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'mcp' ? 'active' : ''}" data-tab="mcp" style="${getTabStyle('mcp')}">🔌 MCP Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'general' ? 'active' : ''}" data-tab="general" style="${getTabStyle('general')}">⚙️ General Settings</button>
                        <button class="settings-tab-btn ${this.activeTab === 'templates' ? 'active' : ''}" data-tab="templates" style="${getTabStyle('templates')}">📝 Templates</button>
                        <button class="settings-tab-btn ${this.activeTab === 'skills' ? 'active' : ''}" data-tab="skills" style="${getTabStyle('skills')}">⚡ Skills</button>
                        <!-- API Logs moved to the Monitor view (per-task raw payloads). -->
                        <button class="settings-tab-btn ${this.activeTab === 'rag' ? 'active' : ''}" data-tab="rag" style="${getTabStyle('rag')}">🔍 RAG Indexing</button>
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
        if (container) {
            container.innerHTML = this.renderHtml();
            this.init();
        }
    }

    async render() {
        if (!this.loaded) {
            await this.loadConfig();
        }
        return this.renderHtml();
    }

    init() {
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
                this.readFormValues();
                this.activeTab = btn.getAttribute('data-tab');
                if (this.activeTab === 'logs') {
                    await this.loadLogs();
                } else if (this.activeTab === 'skills') {
                    await this.loadSkills();
                }
                this.reRender();
            });
        });

        // RAG tab handlers
        const ragLoadDirsBtn = document.getElementById('btn-rag-load-dirs');
        if (ragLoadDirsBtn) {
            ragLoadDirsBtn.addEventListener('click', async () => {
                const pathEl = document.getElementById('rag-path-input');
                if (!pathEl || !pathEl.value.trim()) return;
                this.ragPath = pathEl.value.trim();
                try {
                    this.ragDirs = await invoke('get_directory_structure', { path: this.ragPath, maxDepth: 5 });
                    this.ragExclusions = [];
                    this.reRender();
                } catch (e) {
                    alert('Failed to load directories: ' + e);
                }
            });
        }

        const ragStartBtn = document.getElementById('btn-rag-start');
        if (ragStartBtn) {
            ragStartBtn.addEventListener('click', async () => {
                const pathEl = document.getElementById('rag-path-input');
                this.ragPath = pathEl ? pathEl.value.trim() : this.ragPath;
                if (!this.ragPath) {
                    alert('Please enter a workspace path first.');
                    return;
                }

                // Collect exclusions from unchecked dirs
                const exclusions = [];
                document.querySelectorAll('.rag-dir-cb').forEach(cb => {
                    if (!cb.checked) exclusions.push(cb.value);
                });
                this.ragExclusions = exclusions;

                // Collect selected extensions
                const extensions = [];
                document.querySelectorAll('.rag-ext-cb').forEach(cb => {
                    if (cb.checked) extensions.push(cb.value);
                });
                this.ragExtensions = extensions;

                // Approve path and start indexing
                try {
                    await invoke('set_rag_approval', { path: this.ragPath, approved: true });
                } catch (e) {
                    console.warn('set_rag_approval failed:', e);
                }

                this.ragProgress = 1;
                this.ragStatus = 'Starting indexing...';
                this.reRender();

                // Listen for progress events
                if (this._ragUnlisten) this._ragUnlisten();
                this._ragUnlisten = await listen('indexing-progress', (event) => {
                    const { percentage, currentPath } = event.payload;
                    this.ragProgress = percentage || 0;
                    this.ragStatus = currentPath || '';
                    const btn = document.getElementById('btn-rag-start');
                    if (btn) btn.textContent = `⏳ ${this.ragProgress}%`;
                    const bar = document.querySelector('#rag-progress-bar');
                    if (bar) bar.style.width = `${this.ragProgress}%`;
                });

                try {
                    const result = await invoke('init_indexer', {
                        path: this.ragPath,
                        exclusions: this.ragExclusions,
                        extensions: this.ragExtensions,
                        modelSize: null,
                    });
                    this.ragProgress = 100;
                    this.ragStatus = result.message || 'Indexing complete!';
                    if (this._ragUnlisten) { this._ragUnlisten(); this._ragUnlisten = null; }
                    this.reRender();
                } catch (e) {
                    this.ragProgress = 0;
                    this.ragStatus = 'Error: ' + (e.message || String(e));
                    if (this._ragUnlisten) { this._ragUnlisten(); this._ragUnlisten = null; }
                    this.reRender();
                }
            });
        }

        // Cascading checkbox for RAG dirs
        document.querySelectorAll('.rag-dir-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const pathVal = e.target.value;
                const sep = pathVal.includes('\\') ? '\\' : '/';
                document.querySelectorAll('.rag-dir-cb').forEach(childCb => {
                    if (childCb.value.startsWith(pathVal + sep)) {
                        childCb.checked = checked;
                        childCb.parentElement.style.opacity = checked ? '1' : '0.5';
                    }
                });
            });
        });

        // ── Templates tab event handlers ──────────────────────────────────────

        const btnTplNew = document.getElementById('btn-tpl-new');
        if (btnTplNew) {
            btnTplNew.addEventListener('click', () => {
                this.editingTemplate = null;
                this.showTemplateForm = true;
                this.reRender();
            });
        }

        const btnTplCancel = document.getElementById('btn-tpl-cancel');
        if (btnTplCancel) {
            btnTplCancel.addEventListener('click', () => {
                this.showTemplateForm = false;
                this.editingTemplate = null;
                this.reRender();
            });
        }

        const btnTplSave = document.getElementById('btn-tpl-save');
        if (btnTplSave) {
            btnTplSave.addEventListener('click', async () => {
                const keyEl = document.getElementById('tpl-key');
                const labelEl = document.getElementById('tpl-label');
                const promptEl = document.getElementById('tpl-prompt');
                const iconEl = document.getElementById('tpl-icon');
                if (!keyEl || !labelEl || !promptEl) return;

                const key = keyEl.value.trim();
                const label = labelEl.value.trim();
                const prompt = promptEl.value;
                const icon = iconEl ? iconEl.value.trim() || '📝' : '📝';

                if (!key || !/^[a-zA-Z0-9_\-]+$/.test(key)) {
                    alert('コマンド名には英数字・ハイフン・アンダースコアのみ使用できます。');
                    return;
                }
                if (!label) { alert('表示名を入力してください。'); return; }
                if (!prompt) { alert('プロンプトテキストを入力してください。'); return; }

                promptTemplateManager.set(key, label, prompt, icon);
                await this._saveTemplates();
                this.showTemplateForm = false;
                this.editingTemplate = null;
                this.reRender();
            });
        }

        document.querySelectorAll('.btn-tpl-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-key');
                const t = promptTemplateManager.get(key);
                if (t) {
                    this.editingTemplate = t;
                    this.showTemplateForm = true;
                    this.reRender();
                }
            });
        });

        document.querySelectorAll('.btn-tpl-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.getAttribute('data-key');
                if (confirm(`テンプレート "/${key}" を削除しますか？`)) {
                    promptTemplateManager.remove(key);
                    await this._saveTemplates();
                    this.reRender();
                }
            });
        });

        // ── Skills tab event handlers ──────────────────────────────────────────

        const btnSkillNew = document.getElementById('btn-skill-new');
        if (btnSkillNew) {
            btnSkillNew.addEventListener('click', () => {
                this.editingSkill = null;
                this.showSkillForm = true;
                this.reRender();
            });
        }

        const btnSkillCancel = document.getElementById('btn-skill-cancel');
        if (btnSkillCancel) {
            btnSkillCancel.addEventListener('click', () => {
                this.showSkillForm = false;
                this.editingSkill = null;
                this.reRender();
            });
        }

        const btnSkillSave = document.getElementById('btn-skill-save');
        if (btnSkillSave) {
            btnSkillSave.addEventListener('click', async () => {
                const nameEl = document.getElementById('skill-name');
                const contentEl = document.getElementById('skill-content');
                if (!contentEl) return;

                const name = this.editingSkill ? this.editingSkill.name : (nameEl ? nameEl.value.trim() : '');
                const content = contentEl.value;

                if (!name) { alert('スキル名を入力してください。'); return; }
                if (!content.trim()) { alert('コンテンツを入力してください。'); return; }

                btnSkillSave.disabled = true;
                btnSkillSave.innerText = '保存中...';
                try {
                    await skillManager.save(name, content);
                    this.skillsList = skillManager.getAll();
                    this.showSkillForm = false;
                    this.editingSkill = null;
                    this.reRender();
                } catch (e) {
                    alert('保存に失敗しました: ' + (e.message || e));
                } finally {
                    btnSkillSave.disabled = false;
                    btnSkillSave.innerText = '💾 保存';
                }
            });
        }

        document.querySelectorAll('.btn-skill-edit').forEach(btn => {
            btn.addEventListener('click', async () => {
                const name = btn.getAttribute('data-name');
                btn.disabled = true;
                try {
                    const content = await skillManager.readContent(name);
                    this.editingSkill = { name, content };
                    this.showSkillForm = true;
                    this.reRender();
                } catch (e) {
                    alert('スキルの読み込みに失敗しました: ' + (e.message || e));
                } finally {
                    btn.disabled = false;
                }
            });
        });

        document.querySelectorAll('.btn-skill-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const name = btn.getAttribute('data-name');
                if (confirm(`スキル "/${name}" を削除しますか？`)) {
                    btn.disabled = true;
                    try {
                        await skillManager.delete(name);
                        this.skillsList = skillManager.getAll();
                        this.reRender();
                    } catch (e) {
                        alert('削除に失敗しました: ' + (e.message || e));
                    }
                }
            });
        });

        // ── End Templates/Skills handlers ─────────────────────────────────────

        // Add Connection Modal - Open
        const btnOpenAddModal = document.getElementById('btn-open-add-modal');
        if (btnOpenAddModal) {
            btnOpenAddModal.addEventListener('click', () => {
                this.readFormValues();
                this.editingInstance = null;
                this.showModal = true;
                this.reRender();
            });
        }

        // Edit Connection Modal - Open
        const editBtns = document.querySelectorAll('.btn-edit-instance');
        editBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.readFormValues();
                const id = btn.getAttribute('data-id');
                const inst = this.config.llm_instances.find(i => i.id === id);
                if (inst) {
                    this.editingInstance = inst;
                    this.showModal = true;
                    this.reRender();
                }
            });
        });

        // "Set as Default" radio buttons (one per LLM instance)
        document.querySelectorAll('.active-llm-radio').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                if (id) {
                    this.readFormValues();
                    this.config.active_llm_instance_id = id;
                    // re-render so the ACTIVE badge moves to this row
                    this.reRender();
                }
            });
        });

        // Delete Connection
        const deleteBtns = document.querySelectorAll('.btn-delete-instance');
        deleteBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                if (confirm('Are you sure you want to remove this connection instance?')) {
                    this.readFormValues();
                    this.config.llm_instances = this.config.llm_instances.filter(i => i.id !== id);
                    // If the active one was just removed, drop the reference so the
                    // next render auto-promotes the first remaining instance.
                    if (this.config.active_llm_instance_id === id) {
                        this.config.active_llm_instance_id = null;
                    }
                    this.reRender();
                }
            });
        });

        // Modal Provider Type Changed - Adjust placeholders and fields dynamically
        const modalProviderSelect = document.getElementById('modal-provider-type');
        if (modalProviderSelect) {
            modalProviderSelect.addEventListener('change', (e) => {
                const provider = e.target.value;
                
                // Show/hide API version field
                const versionGroup = document.getElementById('modal-version-group');
                if (versionGroup) {
                    versionGroup.style.display = provider === 'azure' ? 'flex' : 'none';
                }

                // Update URL label and placeholder
                const urlLabel = document.getElementById('modal-url-label');
                const urlInput = document.getElementById('modal-inst-url');
                if (urlLabel && urlInput) {
                    urlLabel.innerText = provider === 'azure' ? 'Endpoint URL' : 'Base URL (Optional Override)';
                    urlInput.placeholder = this.getModalUrlPlaceholder(provider);
                }

                // Update key placeholder
                const keyInput = document.getElementById('modal-inst-key');
                if (keyInput) {
                    keyInput.placeholder = this.getModalKeyPlaceholder(provider);
                }

                // Autocomplete connection name/model if empty
                const nameInput = document.getElementById('modal-inst-name');
                if (nameInput && (!nameInput.value || nameInput.value.endsWith(' Instance') || nameInput.value.endsWith(' Connection'))) {
                    nameInput.value = `${provider.toUpperCase()} Connection`;
                }
                const modelInput = document.getElementById('modal-inst-model');
                if (modelInput && !modelInput.value) {
                    switch(provider) {
                        case 'openai': modelInput.value = 'gpt-4o'; break;
                        case 'anthropic': modelInput.value = 'claude-3-5-sonnet-20241022'; break;
                        case 'gemini': modelInput.value = 'gemini-1.5-flash'; break;
                        case 'azure': modelInput.value = 'gpt-4o-deployment'; break;
                        case 'ollama': modelInput.value = 'qwen3.5:9b'; break;
                        case 'generic': modelInput.value = 'model-name'; break;
                    }
                }
            });
        }

        // Modal Test Connection
        const btnModalTest = document.getElementById('btn-modal-test');
        if (btnModalTest) {
            btnModalTest.addEventListener('click', async () => {
                const statusEl = document.getElementById('modal-test-status');
                if (!statusEl) return;
                
                const provider = document.getElementById('modal-provider-type').value;
                const model = document.getElementById('modal-inst-model').value.trim();
                const apiKey = document.getElementById('modal-inst-key').value;
                const baseUrl = document.getElementById('modal-inst-url').value.trim();
                const versionEl = document.getElementById('modal-inst-version');
                const apiVersion = versionEl ? versionEl.value.trim() : null;

                if (!model) {
                    alert('Model Name is required to run connection audit.');
                    return;
                }

                btnModalTest.disabled = true;
                btnModalTest.innerText = '⚡ Testing...';
                
                statusEl.style.display = 'block';
                statusEl.style.background = 'var(--bg-tertiary)';
                statusEl.style.color = 'var(--text-secondary)';
                statusEl.innerText = '🔍 Connecting to endpoint...';

                try {
                    if (window.apiClient) {
                        const res = await window.apiClient.testConnection({
                            provider,
                            model,
                            api_key: apiKey || null,
                            base_url: baseUrl || null,
                            api_version: apiVersion || null
                        });

                        if (res.success) {
                            statusEl.style.background = 'rgba(76, 175, 80, 0.1)';
                            statusEl.style.color = 'var(--success)';
                            statusEl.innerText = `✅ Success: Connection verified successfully!`;
                        } else {
                            statusEl.style.background = 'rgba(244, 67, 54, 0.1)';
                            statusEl.style.color = 'var(--error)';
                            statusEl.innerText = `❌ Failure: ${res.message}`;
                        }
                    }
                } catch (e) {
                    statusEl.style.background = 'rgba(244, 67, 54, 0.1)';
                    statusEl.style.color = 'var(--error)';
                    statusEl.innerText = `❌ Error: ${e.message || e}`;
                } finally {
                    btnModalTest.disabled = false;
                    btnModalTest.innerText = '⚡ Test Connection';
                }
            });
        }

        // Modal Cancel
        const btnModalCancel = document.getElementById('btn-modal-cancel');
        if (btnModalCancel) {
            btnModalCancel.addEventListener('click', () => {
                this.showModal = false;
                this.editingInstance = null;
                this.reRender();
            });
        }

        // Modal Save/Submit
        const btnModalSave = document.getElementById('btn-modal-save');
        if (btnModalSave) {
            btnModalSave.addEventListener('click', () => {
                const provider = document.getElementById('modal-provider-type').value;
                const name = document.getElementById('modal-inst-name').value.trim();
                const model = document.getElementById('modal-inst-model').value.trim();
                const apiKey = document.getElementById('modal-inst-key').value;
                const baseUrl = document.getElementById('modal-inst-url').value.trim();
                
                const versionEl = document.getElementById('modal-inst-version');
                const apiVersion = versionEl ? versionEl.value.trim() : null;

                const contextEl = document.getElementById('modal-inst-context');
                const contextRaw = contextEl ? parseInt(contextEl.value, 10) : NaN;
                const contextWindow = Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : null;

                const maxOutEl = document.getElementById('modal-inst-maxout');
                const maxOutRaw = maxOutEl ? parseInt(maxOutEl.value, 10) : NaN;
                const maxOutputTokens = Number.isFinite(maxOutRaw) && maxOutRaw > 0 ? maxOutRaw : null;

                const tempEl = document.getElementById('modal-inst-temp');
                const tempRaw = tempEl && tempEl.value !== '' ? parseFloat(tempEl.value) : NaN;
                const temperature = Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 2 ? tempRaw : null;

                if (!model) {
                    alert('Model Name is required.');
                    return;
                }

                if (this.editingInstance) {
                    // Update existing
                    const inst = this.config.llm_instances.find(i => i.id === this.editingInstance.id);
                    if (inst) {
                        inst.name = name || `${provider} Connection`;
                        inst.model = model;
                        inst.api_key = apiKey || null;
                        inst.base_url = baseUrl || null;
                        inst.api_version = apiVersion || null;
                        inst.context_window = contextWindow;
                        inst.max_output_tokens = maxOutputTokens;
                        inst.temperature = temperature;
                    }
                } else {
                    // Create new
                    const newInst = {
                        id: `inst_${Date.now()}`,
                        name: name || `${provider} Connection`,
                        provider,
                        api_key: apiKey || null,
                        base_url: baseUrl || null,
                        model,
                        api_version: apiVersion || null,
                        context_window: contextWindow,
                        max_output_tokens: maxOutputTokens,
                        temperature: temperature
                    };
                    if (!this.config.llm_instances) {
                        this.config.llm_instances = [];
                    }
                    this.config.llm_instances.push(newInst);
                    // If this is the first instance, mark it as active by default
                    if (this.config.llm_instances.length === 1 && !this.config.active_llm_instance_id) {
                        this.config.active_llm_instance_id = newInst.id;
                    }
                }

                this.showModal = false;
                this.editingInstance = null;
                this.reRender();
            });
        }

        // Select Log Directory Folder Dialog
        const btnSelectLogDir = document.getElementById('btn-select-log-dir');
        if (btnSelectLogDir) {
            btnSelectLogDir.addEventListener('click', async () => {
                try {
                    const selected = await invoke('select_folder');
                    if (selected) {
                        const input = document.getElementById('cfg-log-dir');
                        if (input) {
                            input.value = selected;
                            this.config.log_dir = selected;
                        }
                    }
                } catch (e) {
                    console.error('Failed to select folder:', e);
                }
            });
        }

        // ── Storage usage panel ──────────────────────────────────────────
        const storageRefresh = document.getElementById('btn-storage-refresh');
        if (storageRefresh) {
            storageRefresh.addEventListener('click', () => this._renderStorageUsage());
        }
        const purgeApiLogs = document.getElementById('btn-purge-apilogs');
        if (purgeApiLogs) {
            purgeApiLogs.addEventListener('click', () => {
                if (!confirm('旧APIログ(localStorageのjh_api_logs)を削除しますか？\nMonitorのタスク別ログには影響しません。')) return;
                try { localStorage.removeItem('jh_api_logs'); } catch (_) {}
                this._renderStorageUsage();
            });
        }
        const clearCommLog = document.getElementById('btn-clear-commlog');
        if (clearCommLog) {
            clearCommLog.addEventListener('click', async () => {
                if (!confirm('通信ログファイル(ai_communication.log)を空にしますか？')) return;
                try { await invoke('clear_comm_log'); } catch (e) { console.error(e); }
                this._renderStorageUsage();
            });
        }
        // Auto-load once when the General tab is shown.
        if (document.getElementById('cfg-storage-usage')) this._renderStorageUsage();

        // Export connection settings to the standard path picked up by sibling JH apps
        const btnExportConn = document.getElementById('btn-export-connection');
        if (btnExportConn) {
            btnExportConn.addEventListener('click', async () => {
                const statusEl = document.getElementById('export-connection-status');
                if (!window.apiClient) {
                    if (statusEl) statusEl.innerHTML = `<span style="color:var(--error)">API client not ready.</span>`;
                    return;
                }
                btnExportConn.disabled = true;
                btnExportConn.innerText = '⏳ Exporting...';
                try {
                    const written = await invoke('export_connection_config', {
                        port: window.apiClient.port,
                        token: window.apiClient.token
                    });
                    if (statusEl) {
                        statusEl.innerHTML = `<span style="color:var(--success)">✅ Wrote: <code style="font-family:var(--font-mono)">${escapeHtml(written)}</code></span>`;
                    }
                } catch (e) {
                    if (statusEl) {
                        statusEl.innerHTML = `<span style="color:var(--error)">❌ Export failed: ${escapeHtml(String(e.message || e))}</span>`;
                    }
                } finally {
                    btnExportConn.disabled = false;
                    btnExportConn.innerText = '💾 Export';
                }
            });
        }

        // Copy Connection Token to clipboard
        const btnCopyToken = document.getElementById('btn-copy-connection-token');
        if (btnCopyToken) {
            btnCopyToken.addEventListener('click', () => {
                const tokenInput = document.getElementById('cfg-connection-token');
                if (tokenInput) {
                    navigator.clipboard.writeText(tokenInput.value);
                    btnCopyToken.innerText = 'Copied!';
                    setTimeout(() => {
                        btnCopyToken.innerText = '📋 Copy';
                    }, 2000);
                }
            });
        }

        // Toggle Logging switch listener
        const loggingToggle = document.getElementById('cfg-logging-enabled-toggle');
        const loggingWrap = document.getElementById('cfg-logging-enabled-wrap');
        if (loggingToggle && loggingWrap) {
            loggingWrap.addEventListener('click', () => {
                loggingToggle.classList.toggle('active');
            });
        }

        // Save entire configuration to backend
        const btnSave = document.getElementById('btn-save-config');
        if (btnSave) {
            btnSave.addEventListener('click', async () => {
                btnSave.disabled = true;
                btnSave.innerText = 'Saving...';
                
                try {
                    this.readFormValues();
                    
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
                        proxy_url: this.config.proxy_url,
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
                        agent_temperature:           (this.config.agent_temperature ?? null),
                        plan_mode:                   (this.config.plan_mode || 'auto'),
                        fast_model_id:               (this.config.fast_model_id || null),
                        deep_model_id:               (this.config.deep_model_id || null),
                        prompt_templates:            promptTemplateManager.toConfigValue()
                    };

                    if (window.apiClient) {
                        await window.apiClient.updateConfig(newConfig);
                        showNotification("Settings saved successfully!");

                        // Push the active-instance change into LLMService so the
                        // very next agent run / chat uses it without a restart.
                        try {
                            const { default: llmService } = await import('../../modules/ai/LLMService.js');
                            await llmService.initFromConfig();
                        } catch (e) {
                            console.warn('Could not refresh LLMService after save:', e);
                        }

                        // Reload to update masked strings
                        this.loaded = false;
                        await this.loadConfig();
                        this.reRender();
                    }
                } catch (e) {
                    alert("Error saving config: " + e.message);
                } finally {
                    btnSave.disabled = false;
                    btnSave.innerText = '💾 Save Settings';
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
    }

    renderRagTabHtml() {
        const allExts = ['js', 'jsx', 'ts', 'tsx', 'rs', 'java', 'py', 'md', 'txt', 'html', 'css', 'json', 'xml'];
        const dirsHtml = this.ragDirs.length > 0
            ? this.ragDirs.map(dir => {
                const depth = (dir.match(/\\|\//g) || []).length;
                const indent = depth * 16;
                const basename = dir.split(/[\\/]/).pop();
                const isExcluded = this.ragExclusions.includes(dir);
                return `
                    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding-left:${indent}px;margin-bottom:4px;opacity:${isExcluded ? '0.5' : '1'};">
                        <input type="checkbox" class="rag-dir-cb" value="${dir}" ${isExcluded ? '' : 'checked'}>
                        <span>${basename}</span>
                    </label>
                `;
            }).join('')
            : '<div style="font-size:13px;color:var(--text-secondary);">Enter a workspace path and click "Load Directories".</div>';

        const progressBar = this.ragProgress > 0
            ? `<div style="margin-top:8px;height:6px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;">
                   <div style="height:100%;width:${this.ragProgress}%;background:var(--accent);transition:width 0.3s;"></div>
               </div>`
            : '';

        return `
            <div class="card settings-card" style="height:100%;">
                <div class="card-header" style="margin-bottom:20px;">
                    <h3>🔍 RAG Indexing</h3>
                    <p class="subtitle">Index your workspace for semantic code search (Auto-RAG)</p>
                </div>
                <div class="provider-card-fields">
                    <div class="input-group">
                        <label class="input-label">Workspace Path</label>
                        <div style="display:flex;gap:8px;">
                            <input type="text" id="rag-path-input" class="input" value="${this.ragPath}" placeholder="C:\\path\\to\\workspace" style="flex:1;">
                            <button class="btn btn-secondary" id="btn-rag-load-dirs" style="white-space:nowrap;">Load Directories</button>
                        </div>
                    </div>

                    <div class="input-group">
                        <label class="input-label">Directories to Include</label>
                        <div id="rag-dir-list" style="max-height:200px;overflow-y:auto;background:var(--bg-secondary);padding:10px;border-radius:6px;border:1px solid var(--border);display:flex;flex-direction:column;">
                            ${dirsHtml}
                        </div>
                    </div>

                    <div class="input-group">
                        <label class="input-label">File Extensions</label>
                        <div style="display:flex;flex-wrap:wrap;gap:8px;background:var(--bg-secondary);padding:10px;border-radius:6px;border:1px solid var(--border);">
                            ${allExts.map(ext => `
                                <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;background:var(--bg-color);padding:4px 8px;border-radius:4px;border:1px solid var(--border);">
                                    <input type="checkbox" class="rag-ext-cb" value="${ext}" ${this.ragExtensions.includes(ext) ? 'checked' : ''}>
                                    .${ext}
                                </label>
                            `).join('')}
                        </div>
                    </div>

                    <div style="display:flex;align-items:center;gap:12px;margin-top:8px;">
                        <button class="btn btn-primary" id="btn-rag-start" ${this.ragProgress > 0 && this.ragProgress < 100 ? 'disabled' : ''}>
                            ${this.ragProgress > 0 && this.ragProgress < 100 ? '⏳ Indexing...' : '▶ Start Indexing'}
                        </button>
                        ${this.ragStatus ? `<span style="font-size:13px;color:var(--text-secondary);">${escapeHtml(this.ragStatus)}</span>` : ''}
                    </div>
                    ${progressBar}
                </div>
            </div>
        `;
    }

    renderTemplatesTabHtml() {
        const templates = promptTemplateManager.getAll();
        const ef = this.editingTemplate;

        const formHtml = this.showTemplateForm ? `
            <div style="background: var(--bg-tertiary); border: 1px solid var(--border-focus); border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px;">
                <h4 style="margin: 0 0 14px 0; font-size: 13px; color: var(--accent);">
                    ${ef ? '✏️ テンプレートを編集' : '➕ 新しいテンプレート'}
                </h4>
                <div class="provider-card-fields">
                    <div class="grid-2" style="gap: 12px;">
                        <div class="input-group">
                            <label class="input-label">スラッシュコマンド名 <span style="color:var(--error)">*</span></label>
                            <input type="text" id="tpl-key" class="input" value="${escapeHtml(ef?.key || '')}"
                                placeholder="例: backlog (英数字・ハイフン)"
                                ${ef ? 'readonly style="background:var(--bg-primary);cursor:not-allowed;"' : ''}>
                            <p class="input-hint">チャットで <code>/名前</code> と入力して呼び出します</p>
                        </div>
                        <div class="input-group">
                            <label class="input-label">表示名 <span style="color:var(--error)">*</span></label>
                            <input type="text" id="tpl-label" class="input" value="${escapeHtml(ef?.label || '')}" placeholder="例: BackLog タスク登録">
                        </div>
                    </div>
                    <div class="input-group">
                        <label class="input-label">プロンプトテキスト <span style="color:var(--error)">*</span></label>
                        <textarea id="tpl-prompt" class="textarea" rows="5"
                            placeholder="ここに定型プロンプトを書きます。例:\n次のタスクをBackLogに登録してください...">${escapeHtml(ef?.prompt || '')}</textarea>
                        <p class="input-hint">スラッシュコマンド選択時にチャット入力欄にこのテキストが展開されます</p>
                    </div>
                    <div class="input-group">
                        <label class="input-label">アイコン</label>
                        <input type="text" id="tpl-icon" class="input" value="${escapeHtml(ef?.icon || '📝')}"
                            placeholder="📝" style="width: 80px;">
                    </div>
                </div>
                <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                    <button class="btn btn-secondary" id="btn-tpl-cancel">キャンセル</button>
                    <button class="btn btn-primary" id="btn-tpl-save">💾 保存</button>
                </div>
            </div>
        ` : '';

        const listHtml = templates.length === 0 ? `
            <div style="padding: 32px; text-align: center; color: var(--text-secondary);">
                <span style="font-size: 32px; display: block; margin-bottom: 12px;">📝</span>
                <p>テンプレートが登録されていません。<br>「新規追加」ボタンからテンプレートを作成してください。</p>
            </div>
        ` : `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:40px;text-align:center;">Icon</th>
                            <th>コマンド</th>
                            <th>表示名</th>
                            <th>プロンプト (先頭)</th>
                            <th style="width:140px;text-align:right;">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${templates.map(t => `
                            <tr>
                                <td style="text-align:center;font-size:18px;">${escapeHtml(t.icon)}</td>
                                <td><code style="font-family:var(--font-mono);color:var(--accent);">/${escapeHtml(t.key)}</code></td>
                                <td style="font-weight:600;">${escapeHtml(t.label)}</td>
                                <td style="color:var(--text-secondary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                    ${escapeHtml((t.prompt || '').slice(0, 80))}${t.prompt && t.prompt.length > 80 ? '…' : ''}
                                </td>
                                <td>
                                    <div style="display:flex;gap:6px;justify-content:flex-end;">
                                        <button class="btn btn-secondary btn-sm btn-tpl-edit" data-key="${escapeHtml(t.key)}">✏️ 編集</button>
                                        <button class="btn btn-danger btn-sm btn-tpl-delete" data-key="${escapeHtml(t.key)}">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;

        return `
            <div class="card settings-card" style="height:100%;display:flex;flex-direction:column;">
                <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-shrink:0;">
                    <div>
                        <h3>📝 プロンプトテンプレート</h3>
                        <p class="subtitle">チャットで /コマンド名 と入力して呼び出せる定型プロンプトを管理します</p>
                    </div>
                    <button class="btn btn-primary" id="btn-tpl-new">➕ 新規追加</button>
                </div>
                <div style="flex:1;overflow-y:auto;">
                    ${formHtml}
                    ${listHtml}
                </div>
            </div>
        `;
    }

    renderSkillsTabHtml() {
        const skills = this.skillsList;
        const es = this.editingSkill;

        const formHtml = this.showSkillForm ? `
            <div style="background: var(--bg-tertiary); border: 1px solid var(--border-focus); border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px;">
                <h4 style="margin: 0 0 14px 0; font-size: 13px; color: var(--accent);">
                    ${es ? `✏️ スキルを編集: ${escapeHtml(es.name)}` : '➕ 新しいスキル'}
                </h4>
                <div class="provider-card-fields">
                    ${!es ? `
                    <div class="input-group">
                        <label class="input-label">スキル名 <span style="color:var(--error)">*</span></label>
                        <input type="text" id="skill-name" class="input" value=""
                            placeholder="例: backlog-register (英数字・ハイフン・アンダースコア)">
                        <p class="input-hint">チャットで <code>/スキル名</code> と入力して呼び出します</p>
                    </div>
                    ` : ''}
                    <div class="input-group">
                        <label class="input-label">コンテンツ (Markdown) <span style="color:var(--error)">*</span></label>
                        <textarea id="skill-content" class="textarea" rows="12"
                            style="font-family:var(--font-mono);font-size:12.5px;"
                            placeholder="# スキルタイトル\n\n1行目 (#から始まる) がタイトルになります。\n\n## 使い方\n\nここにスキルの詳細なプロンプトを記述します...">${escapeHtml(es?.content || '')}</textarea>
                        <p class="input-hint">先頭行 <code># タイトル</code> が表示名になります。スラッシュコマンドで選択するとこのテキスト全体がプロンプトに展開されます。</p>
                    </div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                    <button class="btn btn-secondary" id="btn-skill-cancel">キャンセル</button>
                    <button class="btn btn-primary" id="btn-skill-save">💾 保存</button>
                </div>
            </div>
        ` : '';

        const listHtml = skills.length === 0 ? `
            <div style="padding:32px;text-align:center;color:var(--text-secondary);">
                <span style="font-size:32px;display:block;margin-bottom:12px;">⚡</span>
                <p>スキルが登録されていません。<br>「新規作成」ボタンからスキルを作成してください。</p>
            </div>
        ` : `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>コマンド</th>
                            <th>タイトル</th>
                            <th style="width:160px;text-align:right;">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${skills.map(s => `
                            <tr>
                                <td><code style="font-family:var(--font-mono);color:var(--accent);">/${escapeHtml(s.name)}</code></td>
                                <td style="font-weight:600;">${escapeHtml(s.title)}</td>
                                <td>
                                    <div style="display:flex;gap:6px;justify-content:flex-end;">
                                        <button class="btn btn-secondary btn-sm btn-skill-edit" data-name="${escapeHtml(s.name)}">✏️ 編集</button>
                                        <button class="btn btn-danger btn-sm btn-skill-delete" data-name="${escapeHtml(s.name)}">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;

        return `
            <div class="card settings-card" style="height:100%;display:flex;flex-direction:column;">
                <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-shrink:0;">
                    <div>
                        <h3>⚡ Skills</h3>
                        <p class="subtitle">Claude Code の /skill のような呼び出し可能プロシージャ。<code>~/.config/JH AI Agent/skills/</code> に保存されます。</p>
                    </div>
                    <button class="btn btn-primary" id="btn-skill-new">➕ 新規作成</button>
                </div>
                <div style="flex:1;overflow-y:auto;">
                    ${formHtml}
                    ${listHtml}
                </div>
            </div>
        `;
    }

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

        el.innerHTML = '<em style="color:var(--text-tertiary)">読み込み中…</em>';
        let server = {};
        try { server = await invoke('get_storage_usage'); } catch (_) {}

        el.innerHTML = `
            <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">ローカル (localStorage)</div>
            ・チャット履歴 (direct_ai_sessions): ${fmtBytes(chatBytes)}<br>
            ・旧APIログ (jh_api_logs): ${fmtBytes(apiLogBytes)} ${apiLogBytes > 0 ? '<span style="color:var(--text-tertiary)">（撤去済み・削除可）</span>' : ''}<br>
            ・スケジュール (jh_schedules): ${fmtBytes(schedBytes)}<br>
            ・localStorage合計: <strong>${fmtBytes(lsTotal)}</strong>
            <div style="font-weight:600;color:var(--text-primary);margin:8px 0 4px">サーバ (タスク履歴)</div>
            ・task_history.json: ${fmtBytes(server.task_history_bytes)}<br>
            ・task_logs/ (${server.task_logs_count || 0}ファイル): ${fmtBytes(server.task_logs_bytes)}<br>
            ・通信ログ ai_communication.log: ${fmtBytes(server.comm_log_bytes)} ${server.log_dir ? '' : '<span style="color:var(--text-tertiary)">（未設定）</span>'}
        `;
    }

    renderLogsTabHtml() {
        if (!this.config.log_dir) {
            return `
                <div class="card settings-card" style="height: 100%;">
                    <div class="card-header" style="margin-bottom: 20px;">
                        <h3>🔌 API Communication Logs</h3>
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
                        <h3>🔌 API Communication Logs</h3>
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
                        <h3>🔌 API Communication Logs</h3>
                        <p class="subtitle">Chronological record of request payloads and raw AI responses</p>
                    </div>
                    <button class="btn btn-secondary" id="btn-clear-logs" style="color: var(--error); border-color: var(--error); background: transparent;">🗑️ Clear Logs</button>
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
