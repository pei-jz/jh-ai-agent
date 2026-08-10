<!--
  SettingsGeneral — the General Settings tab.

  The largest single form in the app, and the home of the pattern this migration
  exists to remove: ~260 lines of markup whose every field was read back out of the
  DOM by `readFormValues()` (90 lines of `getElementById(...).value`). A field that
  was renamed in one place and not the other silently stopped saving.

  Here each control reports a normalized PATCH through `onChange`, so "what the user
  typed" and "what will be saved" are the same value. The normalization rules live in
  views/config/configForm.js with their own tests — several of them are load-bearing
  (see normalizeModelId and normalizeSecret in particular).

  The collapsible sections keep their persisted open/closed state: this tab is long
  and someone who opened "Agent Safety Limits" should still find it open next time.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import {
        SAFETY_FIELDS, OUTPUT_LANGUAGES, MASKED,
        normalizeInt, normalizeRatio, normalizeText, normalizeSecret,
        normalizeModelId, normalizePathList, modelChoices,
    } from '../../views/config/configForm.js';
    import { describeLicense } from '../../../modules/license/licenseState.js';
    import { t, UI_LOCALES } from '../../../i18n/index.js';

    let {
        config = {},
        /** Connection info for the token section. */
        connection = { token: '', port: '14300' },
        /** Which sections are open, keyed by section id. Persisted by the parent. */
        openSections = {},
        /** Approved-command / auto-approve-workspace lists (localStorage-backed). */
        approvedCommands = [],
        autoApproveWorkspaces = [],
        storageUsage = '',
        exportStatus = '',
        /** (patch) => void — a partial config update, already normalized. */
        onChange = null,
        onToggleSection = null,
        onSelectLogDir = null,
        onCopyToken = null,
        onExportConnection = null,
        onRefreshStorage = null,
        onPurgeApiLogs = null,
        onClearCommLog = null,
        onAddApprovedCommand = null,
        onRemoveApprovedCommand = null,
        onAddAutoWorkspace = null,
        onRemoveAutoWorkspace = null,
        onRunSetup = null,
        /** This build's version, and whether it can verify signed updates. */
        appVersion = '',
        updatesConfigured = false,
        onCheckUpdate = null,
        /** Evaluation from modules/license/licenseState.js. */
        license = { edition: 'community', status: 'none', licensee: '' },
        licensingConfigured = false,
        hasLicenseKey = false,
        onActivateLicense = null,
        onClearLicense = null,
        /** UI language. Owned by the parent so the whole view re-renders on change. */
        uiLocale = 'ja',
        onChangeLocale = null,
    } = $props();

    const licenseView = $derived(describeLicense(license));
    let licenseKeyInput = $state('');

    const patch = (key, value) => {
        // `undefined` = "leave the stored value alone" (a masked secret).
        if (value === undefined) return;
        onChange?.({ [key]: value });
    };

    const routing = $derived(modelChoices(config.llm_instances));
    const isOpen = (key, def = false) => (key in openSections ? !!openSections[key] : def);

    let newCommand = $state('');
    let newWorkspace = $state('');

    const addCommand = () => {
        const v = newCommand.trim();
        if (!v) return;
        onAddApprovedCommand?.(v);
        newCommand = '';
    };
    const addWorkspace = () => {
        const v = newWorkspace.trim();
        if (!v) return;
        onAddAutoWorkspace?.(v);
        newWorkspace = '';
    };
</script>

{#snippet section(key, def, titleIcon, title, body)}
    <details class="cfg-sec" data-sec={key} open={isOpen(key, def)}
        ontoggle={(e) => onToggleSection?.(key, e.currentTarget.open)}>
        <summary>{@html icon(titleIcon, 13)} {title}<span class="cfg-sec-chev">▾</span></summary>
        <div class="cfg-sec-body">{@render body()}</div>
    </details>
{/snippet}

<div class="provider-card-fields">

    {#snippet basicBody()}
        <div class="input-group">
            <!-- The app's own language. Kept next to, but distinct from, the agent's
                 output language below — see i18n/index.js for why they are separate. -->
            <label class="input-label" for="cfg-ui-locale">{t('common.language')}</label>
            <select id="cfg-ui-locale" class="input" value={uiLocale}
                onchange={(e) => onChangeLocale?.(e.currentTarget.value)}>
                {#each UI_LOCALES as [code, label] (code)}
                    <option value={code}>{label}</option>
                {/each}
            </select>
            <p class="input-hint">{t('common.language.hint')}</p>
        </div>
        <div class="input-group">
            <label class="input-label" for="cfg-output-language">Agent Output Language</label>
            <select id="cfg-output-language" class="input"
                value={config.output_language || 'Japanese'}
                onchange={(e) => patch('output_language', e.currentTarget.value || 'Japanese')}>
                {#each OUTPUT_LANGUAGES as [val, label] (val)}
                    <option value={val}>{label}</option>
                {/each}
            </select>
            <p class="input-hint">The language the agent uses for <strong>final responses to you</strong>.
                Injected automatically into the system prompt; internal reasoning may use any language.
                This is separate from the UI language.</p>
        </div>
        <div class="input-group">
            <label class="input-label" for="cfg-proxy-url">HTTP Proxy URL (Optional)</label>
            <input id="cfg-proxy-url" class="input" type="text"
                value={config.proxy_url || ''} placeholder="http://127.0.0.1:7890"
                oninput={(e) => patch('proxy_url', normalizeText(e.currentTarget.value))}>
        </div>
        <div class="input-group">
            <!-- A masked value must not be saved back over the real key. -->
            <label class="input-label" for="cfg-tavily-key">Tavily API Key (Search)</label>
            <input id="cfg-tavily-key" class="input" type="password"
                value={config.tavily_api_key || ''} placeholder="tvly-..."
                oninput={(e) => patch('tavily_api_key', normalizeSecret(e.currentTarget.value))}>
            <p class="input-hint">Required for web_search capability. Get a free API key at
                <a href="https://tavily.com" target="_blank" rel="noreferrer" class="cfg-link">tavily.com</a>.</p>
        </div>
    {/snippet}
    {@render section('basic', true, 'gear', 'Basic — Language & Network', basicBody)}

    {#snippet behaviorBody()}
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-plan-mode">Plan-First Mode</label>
            <select id="cfg-plan-mode" class="input" value={config.plan_mode ?? 'auto'}
                onchange={(e) => patch('plan_mode', e.currentTarget.value)}>
                <option value="off">Off — never require a plan</option>
                <option value="auto">Auto — plan complex tasks only (recommended)</option>
                <option value="always">Always — require an approved plan before any edit</option>
            </select>
            <p class="input-hint">When active, the agent must
                <strong>investigate → propose a phased plan → get your approval</strong> before it can run
                any file-modifying tool. Investigation tools (read / grep / list) are always allowed.
                <strong>Auto</strong> only gates tasks it judges complex; simple edits run unblocked.</p>
        </div>

        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-subagent-review">Sub-agent Review (Experimental)</label>
            <select id="cfg-subagent-review" class="input" value={config.subagent_review ?? 'off'}
                onchange={(e) => patch('subagent_review', e.currentTarget.value)}>
                <option value="off">Off — no independent review (default)</option>
                <option value="on">On — review file changes before finish</option>
            </select>
            <p class="input-hint">When on, finish_task first spawns an
                <strong>independent read-only reviewer sub-agent</strong> (isolated context, fast-tier
                model) that checks this run's file changes against the request. Blocking findings
                ([BUG] / criteria violations) are sent back to the agent ONCE for fixes; style remarks
                never block. Adds roughly 10–20% tokens to tasks that modify files.</p>
        </div>

        <!-- Both routing selects send "" rather than null to clear — see
             normalizeModelId for why that distinction matters. -->
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-fast-model">Model Routing — Fast tier</label>
            <select id="cfg-fast-model" class="input" value={config.fast_model_id || ''}
                onchange={(e) => patch('fast_model_id', normalizeModelId(e.currentTarget.value))}>
                <option value="">(not set — use the active model)</option>
                {#each routing as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
            <p class="input-hint">A lightweight model for fast responses. Used for single-shot tasks
                (app intents / freeform) and tasks not judged complex.</p>
        </div>

        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-deep-model">Model Routing — Deep tier</label>
            <select id="cfg-deep-model" class="input" value={config.deep_model_id || ''}
                onchange={(e) => patch('deep_model_id', normalizeModelId(e.currentTarget.value))}>
                <option value="">(not set — use the active model)</option>
                {#each routing as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
            <p class="input-hint">A high-capability model for deep reasoning. Used for
                plan-required/complex tasks and auto-escalation on long runs (around mid-step).
                If both are unset, routing is disabled (always the active model).</p>
        </div>
    {/snippet}
    {@render section('behavior', false, 'llm', 'Agent Behavior — Plan & Models', behaviorBody)}

    {#snippet safetyBody()}
        <p class="cfg-sec-hint">Controls when the agent loop auto-stops or gets nudged.
            For every field below, <strong>0 (or empty) = disabled / unlimited</strong>.
            Recommended approach for difficult tasks: leave step cap off, set a token / wall-clock
            budget you can live with, keep loop detectors generous.</p>

        <!-- Six fields that behave identically, driven from SAFETY_FIELDS instead of
             six copies of the same markup. -->
        {#each SAFETY_FIELDS as f (f.key)}
            <div class="input-group cfg-group-gap" class:cfg-half={f.half}>
                <label class="input-label" for={`cfg-${f.key}`}>{f.label}</label>
                <input id={`cfg-${f.key}`} class="input" type="number"
                    min={f.min} max={f.max} placeholder={f.placeholder}
                    value={config[f.key] ?? f.fallback}
                    oninput={(e) => patch(f.key, normalizeInt(e.currentTarget.value, f.fallback))}>
                <p class="input-hint">{@html f.hint}</p>
            </div>
        {/each}

        <!-- A FLOAT in (0,1]; integer parsing would destroy it, which is why it
             never went through the shared numeric reader. -->
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-compress-ratio">History Compress Ratio (cache optimization)</label>
            <input id="cfg-compress-ratio" class="input" type="number"
                min="0.1" max="1" step="0.05" placeholder="0.5"
                value={config.history_compress_ratio ?? 0.5}
                oninput={(e) => patch('history_compress_ratio', normalizeRatio(e.currentTarget.value))}>
            <p class="input-hint">Old tool results are compressed ONLY once the conversation history
                exceeds <strong>this fraction</strong> of the model's context window. Below it, history
                is kept verbatim so the LLM's prompt cache can reuse it, which
                <strong>greatly reduces token usage</strong> on multi-step tasks. Lower = compress
                sooner (smaller prompts, less cache reuse); higher = stay stable longer (more cache
                hits, closer to the window limit). <strong>Recommended: 0.5</strong>. Blank = default (0.5).</p>
        </div>
    {/snippet}
    {@render section('safety', false, 'shield', 'Agent Safety Limits', safetyBody)}

    {#snippet pathsBody()}
        <p class="cfg-sec-hint">One directory per line where the agent may
            <strong>write without approval</strong>. <code>write_file</code> / edits to paths under
            these (and their subfolders) skip the approval dialog. The current workspace and approved
            projects are always allowed. Writes outside this list still require approval.</p>
        <textarea id="cfg-write-allowed" class="input cfg-path-area" rows="4"
            placeholder={'C:\\work\\reports\nC:\\data\\output'}
            value={(config.write_allowed_paths || []).join('\n')}
            oninput={(e) => patch('write_allowed_paths', normalizePathList(e.currentTarget.value))}
        ></textarea>
    {/snippet}
    {@render section('paths', false, 'folder', 'Write-Allowed Directories', pathsBody)}

    {#snippet commandsBody()}
        <p class="cfg-sec-hint">Command patterns the agent may run
            <strong>without an approval prompt</strong> (added via the approval dialog's
            "Always allow"; editable here — stored on this machine). A trailing <code>*</code>
            matches any arguments, e.g. <code>git status *</code>. <strong>Dangerous commands</strong>
            (delete / format / kill / force-push …) always require approval regardless of this list.</p>
        <div class="input-group">
            <label class="input-label">Approved command patterns</label>
            <div id="cfg-approved-cmds" class="cfg-cmd-list">
                {#if !approvedCommands.length}
                    <div class="cfg-cmd-empty">(none)</div>
                {:else}
                    {#each approvedCommands as cmd (cmd)}
                        <div class="cfg-cmd-row">
                            <code>{cmd}</code>
                            <button class="cfg-cmd-del" type="button" title="Remove"
                                onclick={() => onRemoveApprovedCommand?.(cmd)}>✕</button>
                        </div>
                    {/each}
                {/if}
            </div>
            <div class="cfg-cmd-add">
                <input id="cfg-approved-cmd-new" class="input cfg-mono-input" type="text"
                    placeholder="e.g. npm run build *" bind:value={newCommand}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCommand(); } }}>
                <button class="btn btn-secondary" id="btn-approved-cmd-add" type="button"
                    onclick={addCommand}>{@html icon('plus', 12)} Add</button>
            </div>
        </div>
        <div class="input-group cfg-group-top">
            <label class="input-label">Auto-approve workspaces</label>
            <p class="input-hint cfg-hint-tight">Normal-risk commands run without prompts when the
                task's workspace is one of these. Dangerous commands still prompt.</p>
            <div id="cfg-autows" class="cfg-cmd-list">
                {#if !autoApproveWorkspaces.length}
                    <div class="cfg-cmd-empty">(none)</div>
                {:else}
                    {#each autoApproveWorkspaces as ws (ws)}
                        <div class="cfg-cmd-row">
                            <code>{ws}</code>
                            <button class="cfg-cmd-del" type="button" title="Remove"
                                onclick={() => onRemoveAutoWorkspace?.(ws)}>✕</button>
                        </div>
                    {/each}
                {/if}
            </div>
            <div class="cfg-cmd-add">
                <input id="cfg-autows-new" class="input cfg-mono-input" type="text"
                    placeholder={'C:\\projects\\MyProject'} bind:value={newWorkspace}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addWorkspace(); } }}>
                <button class="btn btn-secondary" id="btn-autows-add" type="button"
                    onclick={addWorkspace}>{@html icon('plus', 12)} Add</button>
            </div>
        </div>
    {/snippet}
    {@render section('commands', false, 'shield', 'Approved Commands — Auto-Approve', commandsBody)}

    {#snippet loggingBody()}
        <div class="input-group">
            <div class="toggle-wrap" id="cfg-logging-enabled-wrap" role="button" tabindex="0"
                onclick={() => patch('logging_enabled', !config.logging_enabled)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); patch('logging_enabled', !config.logging_enabled); } }}>
                <div class="toggle" class:active={config.logging_enabled} id="cfg-logging-enabled-toggle"></div>
                <span class="toggle-label">Enable AI Interaction Logging</span>
            </div>
        </div>
        <div class="input-group">
            <label class="input-label" for="cfg-log-dir">Log Directory</label>
            <div class="cfg-row-inline">
                <input id="cfg-log-dir" class="input cfg-grow" type="text"
                    value={config.log_dir || ''} placeholder={'C:\\path\\to\\logs'}
                    oninput={(e) => patch('log_dir', normalizeText(e.currentTarget.value))}>
                <button class="btn btn-secondary cfg-btn-pick" id="btn-select-log-dir" type="button"
                    onclick={() => onSelectLogDir?.()}>{@html icon('folder', 13)} Select</button>
            </div>
        </div>
        <div class="input-group cfg-group-top-sm">
            <label class="input-label">🗄 Storage Usage</label>
            <div id="cfg-storage-usage" class="cfg-storage">
                {#if storageUsage}{@html storageUsage}
                {:else}<em class="cfg-muted">Press "Refresh" to show</em>{/if}
            </div>
            <div class="cfg-btn-row">
                <button class="btn btn-secondary cfg-btn-sm" id="btn-storage-refresh" type="button"
                    onclick={() => onRefreshStorage?.()}>↻ Refresh</button>
                <button class="btn btn-secondary cfg-btn-sm cfg-btn-danger" id="btn-purge-apilogs" type="button"
                    onclick={() => onPurgeApiLogs?.()}>Delete old API logs (localStorage)</button>
                <button class="btn btn-secondary cfg-btn-sm cfg-btn-danger" id="btn-clear-commlog" type="button"
                    onclick={() => onClearCommLog?.()}>Clear communication log file</button>
            </div>
            <p class="input-hint">LLM-call inspection and task history (search, filter, delete) are
                consolidated in <strong>Monitor</strong>.</p>
        </div>
    {/snippet}
    {@render section('logging', false, 'template', 'Logging & Storage', loggingBody)}

    {#snippet connectionBody()}
        <div class="input-group">
            <label class="input-label" for="cfg-connection-token">J.H AI Agent Connection Token (API Key)</label>
            <div class="cfg-row-inline">
                <input id="cfg-connection-token" class="input cfg-grow cfg-token" type="text"
                    value={connection.token || ''} readonly>
                <button class="btn btn-secondary cfg-btn-pick" id="btn-copy-connection-token" type="button"
                    onclick={() => onCopyToken?.()}>{@html icon('clipboard', 13)} Copy</button>
            </div>
            <p class="input-hint">Use this token and Port <strong>{connection.port || '14300'}</strong>
                to connect from external tools like JHEditor.</p>

            <!-- Export so other JH apps auto-discover this agent. -->
            <div class="cfg-export-box">
                <div class="cfg-export-head">
                    <div>
                        <strong class="cfg-export-title">📤 Export to standard path</strong>
                        <p class="input-hint cfg-hint-tight">Saves this host/port/token to
                            <code>%APPDATA%/JH/ai-connection.json</code> (Windows) so other JH apps
                            (JHEditor, JHER, JH Task Manager…) can auto-connect without re-entering
                            credentials.</p>
                    </div>
                    <button class="btn btn-secondary cfg-nowrap" id="btn-export-connection" type="button"
                        onclick={() => onExportConnection?.()}>{@html icon('save', 13)} Export</button>
                </div>
                <div id="export-connection-status" class="cfg-export-status">{exportStatus}</div>
            </div>

            <!-- The first-run wizard, on demand. It only appears by itself when there
                 is no usable connection, so someone who skipped it — or who wants to
                 walk a colleague through setup — otherwise has no way back to it. -->
            <div class="cfg-export-box">
                <div class="cfg-export-head">
                    <div>
                        <strong class="cfg-export-title">🧭 {t('onboarding.rerun')}</strong>
                        <p class="input-hint cfg-hint-tight">{t('onboarding.rerun.hint')}</p>
                    </div>
                    <button class="btn btn-secondary cfg-nowrap" id="btn-run-setup" type="button"
                        onclick={() => onRunSetup?.()}>{@html icon('gear', 13)} {t('onboarding.open')}</button>
                </div>
            </div>
        </div>
    {/snippet}
    {@render section('connection', false, 'plug', 'Connection — Token & Export', connectionBody)}

    {#snippet updateBody()}
        <div class="input-group">
            <p class="input-hint">{t('update.currentVersion', { version: appVersion || t('common.unknown') })}</p>

            {#if updatesConfigured}
                <!-- The check only reports; installing is a separate click on the banner. -->
                <p class="input-hint cfg-hint-tight">{t('update.signed.hint')}</p>
                <button class="btn btn-secondary cfg-nowrap" type="button"
                    onclick={() => onCheckUpdate?.()}>{@html icon('shield', 13)} {t('update.check')}</button>
            {:else}
                <!-- Honest rather than broken: an unsigned build has no trustworthy
                     update channel, so we do not offer a button that cannot work. -->
                <p class="input-hint cfg-hint-tight">{t('update.unconfigured.detail')}
                    <code>docs/RELEASING.md</code></p>
            {/if}
        </div>
    {/snippet}
    {@render section('updates', false, 'shield', t('update.section'), updateBody)}

    {#snippet licenseBody()}
        <div class="input-group">
            <p class="cfg-lic-title" class:is-warn={licenseView.tone === 'warn'}
                class:is-error={licenseView.tone === 'error'}>{licenseView.title}</p>
            <p class="input-hint cfg-hint-tight">{licenseView.detail}</p>
            {#if license.licensee}
                <!-- Shown only here: a licensee is often a company or a person's name. -->
                <p class="input-hint cfg-hint-tight">{t('license.licensee')}: <strong>{license.licensee}</strong></p>
            {/if}

            {#if licensingConfigured}
                <label class="input-label" for="cfg-license-key">{t('license.key')}</label>
                <div class="cfg-row-inline">
                    <input id="cfg-license-key" class="input cfg-grow" type="text"
                        placeholder="JHAI1.…" spellcheck="false"
                        bind:value={licenseKeyInput}>
                    <button class="btn btn-secondary cfg-btn-pick" type="button"
                        disabled={!licenseKeyInput.trim()}
                        onclick={() => onActivateLicense?.(licenseKeyInput.trim())}
                        >{@html icon('shield', 13)} {t('common.apply')}</button>
                </div>
                <p class="input-hint cfg-hint-tight">{t('license.offline.hint')}</p>
                {#if hasLicenseKey}
                    <button class="cfg-lic-clear" type="button"
                        onclick={() => onClearLicense?.()}>{t('license.clear')}</button>
                {/if}
            {:else}
                <!-- No issuing key in this build, so there is no key we could accept.
                     Offering an input that rejects everything would look like a bug. -->
                <p class="input-hint cfg-hint-tight">{t('license.unconfigured.hint')}
                    <code>docs/design/licensing.md</code></p>
            {/if}
        </div>
    {/snippet}
    {@render section('license', false, 'shield', t('license.section'), licenseBody)}
</div>
