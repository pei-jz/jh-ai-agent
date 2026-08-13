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
    import { modelRates, estimateSavings } from '../../../modules/ai/agent/ModelPhaseRouter.js';
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

    // Phase routing needs BOTH tiers — with one, every phase resolves to the
    // same model and the switch is a lie. The estimate needs $/1M rates on both
    // connections as well, and says so rather than inventing a number.
    const bothTiersSet = $derived(!!config.fast_model_id && !!config.deep_model_id);
    const savings = $derived(bothTiersSet
        ? estimateSavings(
            { fast: config.fast_model_id, deep: config.deep_model_id },
            modelRates(config.llm_instances))
        : null);
    const money = (n) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

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
            <label class="input-label" for="cfg-output-language">{t('settings.outputLang')}</label>
            <select id="cfg-output-language" class="input"
                value={config.output_language || 'Japanese'}
                onchange={(e) => patch('output_language', e.currentTarget.value || 'Japanese')}>
                {#each OUTPUT_LANGUAGES as [val, label] (val)}
                    <option value={val}>{label}</option>
                {/each}
            </select>
            <p class="input-hint">{@html t('settings.outputLang.hint')}</p>
        </div>
        <div class="input-group">
            <label class="input-label" for="cfg-proxy-url">{t('settings.proxy')}</label>
            <input id="cfg-proxy-url" class="input" type="text"
                value={config.proxy_url || ''} placeholder="http://127.0.0.1:7890"
                oninput={(e) => patch('proxy_url', normalizeText(e.currentTarget.value))}>
        </div>
        <div class="input-group">
            <!-- A masked value must not be saved back over the real key. -->
            <label class="input-label" for="cfg-tavily-key">{t('settings.tavily')}</label>
            <input id="cfg-tavily-key" class="input" type="password"
                value={config.tavily_api_key || ''} placeholder="tvly-..."
                oninput={(e) => patch('tavily_api_key', normalizeSecret(e.currentTarget.value))}>
            <p class="input-hint">{t('settings.tavily.hint')}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" class="cfg-link">tavily.com</a>.</p>
        </div>
    {/snippet}
    {@render section('basic', true, 'gear', t('settings.sec.basic'), basicBody)}

    {#snippet behaviorBody()}
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-plan-mode">{t('settings.planMode')}</label>
            <select id="cfg-plan-mode" class="input" value={config.plan_mode ?? 'auto'}
                onchange={(e) => patch('plan_mode', e.currentTarget.value)}>
                <option value="off">{t('settings.planMode.off')}</option>
                <option value="auto">{t('settings.planMode.auto')}</option>
                <option value="always">{t('settings.planMode.always')}</option>
            </select>
            <p class="input-hint">{@html t('settings.planMode.hint')}</p>
        </div>

        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-subagent-review">{t('settings.subagentReview')}</label>
            <select id="cfg-subagent-review" class="input" value={config.subagent_review ?? 'off'}
                onchange={(e) => patch('subagent_review', e.currentTarget.value)}>
                <option value="off">{t('settings.subagentReview.off')}</option>
                <option value="on">{t('settings.subagentReview.on')}</option>
            </select>
            <p class="input-hint">{@html t('settings.subagentReview.hint')}</p>
        </div>

        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-memory-recall">{t('settings.memoryRecall')}</label>
            <select id="cfg-memory-recall" class="input" value={config.memory_recall ?? 'auto'}
                onchange={(e) => patch('memory_recall', e.currentTarget.value)}>
                <!-- Auto leads because it is the default: it is the only arm that
                     can answer whether recall is helping at all. -->
                <option value="auto">{t('settings.memoryRecall.auto')}</option>
                <option value="on">{t('settings.memoryRecall.on')}</option>
                <option value="off">{t('settings.memoryRecall.off')}</option>
            </select>
            <p class="input-hint">{@html t('settings.memoryRecall.hint')}</p>
        </div>

        <!-- Both routing selects send "" rather than null to clear — see
             normalizeModelId for why that distinction matters. -->
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-fast-model">{t('settings.routing.fast')}</label>
            <select id="cfg-fast-model" class="input" value={config.fast_model_id || ''}
                onchange={(e) => patch('fast_model_id', normalizeModelId(e.currentTarget.value))}>
                <option value="">{t('settings.routing.unset')}</option>
                {#each routing as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
            <p class="input-hint">{@html t('settings.routing.fast.hint')}</p>
        </div>

        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-deep-model">{t('settings.routing.deep')}</label>
            <select id="cfg-deep-model" class="input" value={config.deep_model_id || ''}
                onchange={(e) => patch('deep_model_id', normalizeModelId(e.currentTarget.value))}>
                <option value="">{t('settings.routing.unset')}</option>
                {#each routing as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
            <p class="input-hint">{@html t('settings.routing.deep.hint')}</p>
        </div>

        <!-- Phase routing. Placed directly under the two tiers because it is the
             setting that makes them worth configuring: without it a run picks one
             tier and stays there. See modules/ai/agent/ModelPhaseRouter.js. -->
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-phase-routing">{t('settings.phaseRouting')}</label>
            <select id="cfg-phase-routing" class="input" value={config.phase_routing ?? 'off'}
                disabled={!bothTiersSet}
                onchange={(e) => patch('phase_routing', e.currentTarget.value)}>
                <option value="off">{t('settings.phaseRouting.off')}</option>
                <option value="on">{t('settings.phaseRouting.on')}</option>
            </select>
            <p class="input-hint">{@html t('settings.phaseRouting.hint')}</p>

            {#if !bothTiersSet}
                <p class="input-hint cfg-phase-warn">{@html t('settings.phaseRouting.needTiers')}</p>
            {:else}
                <div class="cfg-phase-box">
                    <p class="cfg-phase-map">{@html t('settings.phaseRouting.tiers', {
                        deep: routing.find(m => m.id === config.deep_model_id)?.label || config.deep_model_id,
                        fast: routing.find(m => m.id === config.fast_model_id)?.label || config.fast_model_id,
                    })}</p>
                    {#if savings}
                        <p class="cfg-phase-save">{@html t('settings.phaseRouting.estimate', {
                            pct: savings.savedPct,
                            baseline: money(savings.baseline),
                            routed: money(savings.routed),
                        })}</p>
                    {:else}
                        <p class="input-hint cfg-hint-tight">{t('settings.phaseRouting.noRates')}</p>
                    {/if}
                </div>
            {/if}
        </div>
    {/snippet}
    {@render section('behavior', false, 'llm', t('settings.sec.behavior'), behaviorBody)}

    {#snippet safetyBody()}
        <p class="cfg-sec-hint">{@html t('settings.safety.hint')}</p>

        <!-- Six fields that behave identically, driven from SAFETY_FIELDS instead of
             six copies of the same markup. The English label/hint in the table is
             passed as t()'s fallback, so a key missing from both catalogs still
             renders real text rather than a dotted id. -->
        {#each SAFETY_FIELDS as f (f.key)}
            <div class="input-group cfg-group-gap" class:cfg-half={f.half}>
                <label class="input-label" for={`cfg-${f.key}`}
                    >{t(`settings.safety.${f.key}.label`, null, f.label)}</label>
                <input id={`cfg-${f.key}`} class="input" type="number"
                    min={f.min} max={f.max} placeholder={f.placeholder}
                    value={config[f.key] ?? f.fallback}
                    oninput={(e) => patch(f.key, normalizeInt(e.currentTarget.value, f.fallback))}>
                <p class="input-hint">{@html t(`settings.safety.${f.key}.hint`, null, f.hint)}</p>
            </div>
        {/each}

        <!-- A FLOAT in (0,1]; integer parsing would destroy it, which is why it
             never went through the shared numeric reader. -->
        <div class="input-group cfg-group-gap">
            <label class="input-label" for="cfg-compress-ratio">{t('settings.safety.compressRatio')}</label>
            <input id="cfg-compress-ratio" class="input" type="number"
                min="0.1" max="1" step="0.05" placeholder="0.5"
                value={config.history_compress_ratio ?? 0.5}
                oninput={(e) => patch('history_compress_ratio', normalizeRatio(e.currentTarget.value))}>
            <p class="input-hint">{@html t('settings.safety.compressRatio.hint')}</p>
        </div>
    {/snippet}
    {@render section('safety', false, 'shield', t('settings.sec.safety'), safetyBody)}

    {#snippet pathsBody()}
        <p class="cfg-sec-hint">{@html t('settings.paths.hint')}</p>
        <textarea id="cfg-write-allowed" class="input cfg-path-area" rows="4"
            placeholder={'C:\\work\\reports\nC:\\data\\output'}
            value={(config.write_allowed_paths || []).join('\n')}
            oninput={(e) => patch('write_allowed_paths', normalizePathList(e.currentTarget.value))}
        ></textarea>
    {/snippet}
    {@render section('paths', false, 'folder', t('settings.sec.paths'), pathsBody)}

    {#snippet commandsBody()}
        <p class="cfg-sec-hint">{@html t('settings.commands.hint')}</p>
        <div class="input-group">
            <span class="input-label">{t('settings.commands.approved')}</span>
            <div id="cfg-approved-cmds" class="cfg-cmd-list">
                {#if !approvedCommands.length}
                    <div class="cfg-cmd-empty">{t('settings.commands.none')}</div>
                {:else}
                    {#each approvedCommands as cmd (cmd)}
                        <div class="cfg-cmd-row">
                            <code>{cmd}</code>
                            <button class="cfg-cmd-del" type="button" title={t('settings.commands.remove')}
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
                    onclick={addCommand}>{@html icon('plus', 12)} {t('settings.commands.add')}</button>
            </div>
        </div>
        <div class="input-group cfg-group-top">
            <span class="input-label">{t('settings.autows')}</span>
            <p class="input-hint cfg-hint-tight">{t('settings.autows.hint')}</p>
            <div id="cfg-autows" class="cfg-cmd-list">
                {#if !autoApproveWorkspaces.length}
                    <div class="cfg-cmd-empty">{t('settings.commands.none')}</div>
                {:else}
                    {#each autoApproveWorkspaces as ws (ws)}
                        <div class="cfg-cmd-row">
                            <code>{ws}</code>
                            <button class="cfg-cmd-del" type="button" title={t('settings.commands.remove')}
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
                    onclick={addWorkspace}>{@html icon('plus', 12)} {t('settings.commands.add')}</button>
            </div>
        </div>
    {/snippet}
    {@render section('commands', false, 'shield', t('settings.sec.commands'), commandsBody)}

    {#snippet loggingBody()}
        <div class="input-group">
            <div class="toggle-wrap" id="cfg-logging-enabled-wrap" role="button" tabindex="0"
                onclick={() => patch('logging_enabled', !config.logging_enabled)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); patch('logging_enabled', !config.logging_enabled); } }}>
                <div class="toggle" class:active={config.logging_enabled} id="cfg-logging-enabled-toggle"></div>
                <span class="toggle-label">{t('settings.logging.enable')}</span>
            </div>
        </div>
        <div class="input-group">
            <label class="input-label" for="cfg-log-dir">{t('settings.logging.dir')}</label>
            <div class="cfg-row-inline">
                <input id="cfg-log-dir" class="input cfg-grow" type="text"
                    value={config.log_dir || ''} placeholder={'C:\\path\\to\\logs'}
                    oninput={(e) => patch('log_dir', normalizeText(e.currentTarget.value))}>
                <button class="btn btn-secondary cfg-btn-pick" id="btn-select-log-dir" type="button"
                    onclick={() => onSelectLogDir?.()}>{@html icon('folder', 13)} {t('settings.logging.select')}</button>
            </div>
        </div>
        <div class="input-group cfg-group-top-sm">
            <span class="input-label">{@html icon('memory', 13)} {t('settings.storage')}</span>
            <div id="cfg-storage-usage" class="cfg-storage">
                {#if storageUsage}{@html storageUsage}
                {:else}<em class="cfg-muted">{t('settings.storage.press')}</em>{/if}
            </div>
            <div class="cfg-btn-row">
                <button class="btn btn-secondary cfg-btn-sm" id="btn-storage-refresh" type="button"
                    onclick={() => onRefreshStorage?.()}>↻ {t('settings.storage.refresh')}</button>
                <button class="btn btn-secondary cfg-btn-sm cfg-btn-danger" id="btn-purge-apilogs" type="button"
                    onclick={() => onPurgeApiLogs?.()}>{t('settings.storage.purgeApi')}</button>
                <button class="btn btn-secondary cfg-btn-sm cfg-btn-danger" id="btn-clear-commlog" type="button"
                    onclick={() => onClearCommLog?.()}>{t('settings.storage.clearComm')}</button>
            </div>
            <p class="input-hint">{@html t('settings.storage.hint')}</p>
        </div>
    {/snippet}
    {@render section('logging', false, 'template', t('settings.sec.logging'), loggingBody)}

    {#snippet connectionBody()}
        <div class="input-group">
            <label class="input-label" for="cfg-connection-token">{t('settings.token')}</label>
            <div class="cfg-row-inline">
                <input id="cfg-connection-token" class="input cfg-grow cfg-token" type="text"
                    value={connection.token || ''} readonly>
                <button class="btn btn-secondary cfg-btn-pick" id="btn-copy-connection-token" type="button"
                    onclick={() => onCopyToken?.()}>{@html icon('clipboard', 13)} {t('common.copy')}</button>
            </div>
            <p class="input-hint">{@html t('settings.token.hint', { port: connection.port || '14300' })}</p>

            <!-- Export so other JH apps auto-discover this agent. -->
            <div class="cfg-export-box">
                <div class="cfg-export-head">
                    <div>
                        <strong class="cfg-export-title">{@html icon('save', 13)} {t('settings.export.title')}</strong>
                        <p class="input-hint cfg-hint-tight">{@html t('settings.export.hint')}</p>
                    </div>
                    <button class="btn btn-secondary cfg-nowrap" id="btn-export-connection" type="button"
                        onclick={() => onExportConnection?.()}>{@html icon('save', 13)} {t('settings.export')}</button>
                </div>
                <div id="export-connection-status" class="cfg-export-status">{exportStatus}</div>
            </div>

            <!-- The first-run wizard, on demand. It only appears by itself when there
                 is no usable connection, so someone who skipped it — or who wants to
                 walk a colleague through setup — otherwise has no way back to it. -->
            <div class="cfg-export-box">
                <div class="cfg-export-head">
                    <div>
                        <strong class="cfg-export-title">{@html icon('sparkle', 13)} {t('onboarding.rerun')}</strong>
                        <p class="input-hint cfg-hint-tight">{t('onboarding.rerun.hint')}</p>
                    </div>
                    <button class="btn btn-secondary cfg-nowrap" id="btn-run-setup" type="button"
                        onclick={() => onRunSetup?.()}>{@html icon('gear', 13)} {t('onboarding.open')}</button>
                </div>
            </div>
        </div>
    {/snippet}
    {@render section('connection', false, 'plug', t('settings.sec.connection'), connectionBody)}

    <!-- The version is always worth showing: every support conversation starts with
         "which build?". The update CHECK only appears on a build that can actually
         verify a signature — offering a button that cannot work, or explaining why it
         cannot, is noise the user can do nothing about. -->
    {#snippet updateBody()}
        <div class="input-group">
            <p class="input-hint">{t('update.currentVersion', { version: appVersion || t('common.unknown') })}</p>

            {#if updatesConfigured}
                <!-- The check only reports; installing is a separate click on the banner. -->
                <p class="input-hint cfg-hint-tight">{t('update.signed.hint')}</p>
                <button class="btn btn-secondary cfg-nowrap" type="button"
                    onclick={() => onCheckUpdate?.()}>{@html icon('shield', 13)} {t('update.check')}</button>
            {/if}
        </div>
    {/snippet}
    {@render section('updates', false, 'gear',
        updatesConfigured ? t('update.section') : t('about.section'), updateBody)}

    <!-- Shown ONLY on a build that can verify licence keys. Without an issuing key
         there is no edition system from the user's point of view, and naming one
         ("Community") would advertise a paywall that does not exist — enforcement is
         off entirely (editions.js ENFORCEMENT_ENABLED). -->
    {#snippet licenseBody()}
        <div class="input-group">
            <p class="cfg-lic-title" class:is-warn={licenseView.tone === 'warn'}
                class:is-error={licenseView.tone === 'error'}>{licenseView.title}</p>
            <p class="input-hint cfg-hint-tight">{licenseView.detail}</p>
            {#if license.licensee}
                <!-- Shown only here: a licensee is often a company or a person's name. -->
                <p class="input-hint cfg-hint-tight">{t('license.licensee')}: <strong>{license.licensee}</strong></p>
            {/if}

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
        </div>
    {/snippet}
    {#if licensingConfigured}
        {@render section('license', false, 'shield', t('license.section'), licenseBody)}
    {/if}
</div>
