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
    import SegmentedChoice from './SegmentedChoice.svelte';
    import {
        SAFETY_FIELDS, BEHAVIOR_FIELDS, settingKey, OUTPUT_LANGUAGES, MASKED,
        normalizeInt, normalizeRatio, normalizeText, normalizeSecret,
        normalizeModelId, normalizePathList, normalizeHostList, modelChoices,
    } from '../../views/config/configForm.js';
    import { describeLicense } from '../../../modules/license/licenseState.js';
    import { modelRates, estimateSavings } from '../../../modules/ai/agent/ModelPhaseRouter.js';
    import { t, UI_LOCALES } from '../../../i18n/index.js';
    import { INSTALL_COMMAND as BROWSER_INSTALL_COMMAND } from '../../../modules/ai/browser/playwrightState.js';

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
        /**
         * Where API keys are actually kept: {kind: 'keychain'|'file', name, available}.
         *
         * Shown because the fallback is real. On a machine with no usable
         * credential store the keys stay in ai_config.json, and a user who
         * believes otherwise would be wrong about the one thing this feature
         * exists to change.
         */
        secretStorage = null,
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
        /**
         * Optional browser stack, as a STATE rather than a setting:
         * {state:'unknown'|'ok'|'unavailable', reason, checkedAt}. The parent owns
         * it because the probe is an async call into the worker process.
         */
        browserState = { state: 'unknown', reason: '', checkedAt: null },
        browserProbing = false,
        /** Result of the last re-check, in the user's words. Cleared on the next one. */
        browserNotice = '',
        onProbeBrowser = null,
        onForgetBrowser = null,
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
        /**
         * Simplified-first toggle. Defaults to false (advanced sections hidden);
         * the unit tests pass true so they can keep asserting the routing / safety
         * / experimental controls without clicking the toggle first. Reassignable
         * like any Svelte 5 prop, so the toggle just flips it.
         */
        showAdvanced = false,
    } = $props();

    const licenseView = $derived(describeLicense(license));

    // 'question' for unknown, because the honest answer there is that we do not
    // know — a tick would claim evidence this state is defined by not having.
    const browserStateIcon = $derived(
        browserState.state === 'ok' ? 'check' : browserState.state === 'unavailable' ? 'alert' : 'question');
    const browserCheckedLabel = $derived(
        browserState.checkedAt ? new Date(browserState.checkedAt).toLocaleString() : '');
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

    // Simplified-first: Safety Limits, model routing and the experimental knobs
    // are hidden until the user opts into them. A non-engineer should only ever
    // see language, network, plan mode and memory — everything else is an
    // advanced concern that a wrong value can quietly cost real money or break a
    // run. Session-scoped on purpose (not persisted): someone who wants the deep
    // controls re-opens them in one click, and a shared machine does not inherit
    // them. `showAdvanced` is the Svelte 5 prop above, reassigned by the toggle.

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

    /**
     * Which "?" is open — one at a time, by key.
     *
     * One open panel rather than a set: these are long paragraphs, and several
     * open at once rebuilds the wall of text the panels exist to remove.
     */
    let openHelp = $state('');
    const toggleHelp = (key) => { openHelp = openHelp === key ? '' : key; };

    /** The option in force, falling back to the same default the control uses. */
    const behaviorValue = (f) => config[f.key] ?? f.def;
    /** Short captions for the segments; the explanation is the line below. */
    const behaviorOptions = (f) =>
        f.options.map(o => ({ value: o, label: t(settingKey(f.key, o)) }));
</script>

<!-- Esc closes the open panel, the way it closes every other transient thing. -->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && openHelp) openHelp = ''; }} />

<!--
  The long explanation, on request.

  It used to be on screen always — six lines under a one-line control — which is
  most of why this tab ran to several screens, and it is read once and then
  never again. What stays visible is the one-line description of the CHOSEN
  option; this is the "why", including the measurements and the reason a default
  is what it is.

  Two snippets rather than one because the button and the panel do not belong in
  the same place: the button sits on the label row, the panel opens under the
  whole field.
-->
{#snippet helpBtn(key)}
    <button type="button" class="cfg-help-btn"
        aria-expanded={openHelp === key} aria-controls={`help-${key}`}
        title={t('settings.help')} onclick={() => toggleHelp(key)}>?</button>
{/snippet}

{#snippet helpPanel(key, body)}
    {#if openHelp === key}
        <!-- Inside the field's own cell, not spanning the row: with two
             columns, a panel below both would not say which "?" opened it. -->
        <div class="cfg-help-panel" id={`help-${key}`} role="region">{@html body}</div>
    {/if}
{/snippet}

{#snippet section(key, def, titleIcon, title, body)}
    <details class="cfg-sec" data-sec={key} open={isOpen(key, def)}
        ontoggle={(e) => onToggleSection?.(key, e.currentTarget.open)}>
        <summary>{@html icon(titleIcon, 13)} {title}<span class="cfg-sec-chev">▾</span></summary>
        <div class="cfg-sec-body">{@render body()}</div>
    </details>
{/snippet}

<div class="provider-card-fields">

    <div class="cfg-advanced-toggle">
        <div class="toggle-wrap" role="button" tabindex="0"
            onclick={() => (showAdvanced = !showAdvanced)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAdvanced = !showAdvanced; } }}>
            <div class="toggle" class:active={showAdvanced}></div>
            <span class="toggle-label">{t('settings.advanced.show')}</span>
        </div>
        <p class="input-hint">{t('settings.advanced.hint')}</p>
    </div>

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
            <!-- Where the key above is kept — INSIDE this field's group, under
                 the box it is about. It used to be a banner between the proxy
                 field and this one, which reads as a note about the field it
                 sits under, and it sat under the wrong one. -->
            {#if secretStorage}
                <div class="cfg-secret-note" class:is-fallback={!secretStorage.available}>
                    {#if secretStorage.available}
                        {t('settings.secret.stored', { store: secretStorage.name })}
                    {:else}
                        {t('settings.secret.fallback', { store: secretStorage.name })}
                    {/if}
                </div>
            {/if}
            <p class="input-hint">{t('settings.tavily.hint')}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" class="cfg-link">tavily.com</a>.</p>
        </div>
    {/snippet}
    {@render section('basic', true, 'gear', t('settings.sec.basic'), basicBody)}

    {#snippet behaviorBody()}
        <!-- One loop, not seven near-identical blocks. Each row is:
             label + "?", the options as buttons, and one line saying what the
             CHOSEN option does. The long paragraph is behind the "?".

             Buttons rather than a dropdown because two or three fixed options
             fit on screen: the choice, and the fact that there IS a choice, are
             visible without opening anything. Lists that grow (models,
             languages) stay <select>. -->
        {#each BEHAVIOR_FIELDS as f (f.key)}
            {#if !f.advanced || showAdvanced}
                <div class="input-group cfg-setting">
                    <div class="cfg-setting-head">
                        <span class="input-label" id={`lbl-${f.key}`}>{t(settingKey(f.key))}</span>
                        {@render helpBtn(f.key)}
                    </div>
                    <SegmentedChoice
                        name={`cfg-${f.key}`}
                        labelledBy={`lbl-${f.key}`}
                        value={behaviorValue(f)}
                        options={behaviorOptions(f)}
                        onChange={(v) => patch(f.key, v)} />
                    <p class="input-hint cfg-choice-desc">
                        {@html t(settingKey(f.key, behaviorValue(f), 'desc'))}
                    </p>
                    {@render helpPanel(f.key, t(settingKey(f.key, null, 'hint')))}
                </div>
            {/if}
        {/each}


        {#if showAdvanced}
        <!-- Both routing selects send "" rather than null to clear — see
             normalizeModelId for why that distinction matters.
             These stay dropdowns: the list is whatever connections exist. -->
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
        <div class="input-group cfg-setting cfg-wide">
            <div class="cfg-setting-head">
                <span class="input-label" id="lbl-phase-routing">{t('settings.phaseRouting')}</span>
                {@render helpBtn('phase_routing')}
            </div>
            <SegmentedChoice
                name="cfg-phase-routing"
                labelledBy="lbl-phase-routing"
                disabled={!bothTiersSet}
                value={config.phase_routing ?? 'off'}
                options={[
                    { value: 'off', label: t('settings.phaseRouting.off') },
                    { value: 'on', label: t('settings.phaseRouting.on') },
                ]}
                onChange={(v) => patch('phase_routing', v)} />
            <p class="input-hint cfg-choice-desc">
                {@html t(`settings.phaseRouting.${config.phase_routing ?? 'off'}.desc`)}
            </p>
            {@render helpPanel('phase_routing', t('settings.phaseRouting.hint'))}

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
        {/if}
    {/snippet}
    {@render section('behavior', false, 'llm', t('settings.sec.behavior'), behaviorBody)}

    {#snippet safetyBody()}
        <p class="cfg-sec-hint">{@html t('settings.safety.hint')}</p>

        <!-- Six fields that behave identically, driven from SAFETY_FIELDS instead of
             six copies of the same markup. The English label/hint in the table is
             passed as t()'s fallback, so a key missing from both catalogs still
             renders real text rather than a dotted id. -->
        <!-- Label, then the box, on one line. A three-digit limit had a
             full-width input under a full-width label, which reads as a field
             for prose and made this section the tallest on the tab. The unit is
             beside the box because "0" alone does not say whether it counts
             minutes, steps or tokens. -->
        {#each SAFETY_FIELDS as f (f.key)}
            <div class="input-group cfg-num">
                <div class="cfg-num-row">
                    <label class="input-label cfg-num-label" for={`cfg-${f.key}`}
                        >{t(`settings.safety.${f.key}.label`, null, f.label)}</label>
                    <input id={`cfg-${f.key}`} class="input cfg-num-input" type="number"
                        min={f.min} max={f.max} placeholder={f.placeholder}
                        value={config[f.key] ?? f.fallback}
                        oninput={(e) => patch(f.key, normalizeInt(e.currentTarget.value, f.fallback))}>
                    <span class="cfg-num-unit">{t(`settings.unit.${f.unit}`, null, '')}</span>
                    {@render helpBtn(f.key)}
                </div>
                {@render helpPanel(f.key, t(`settings.safety.${f.key}.hint`, null, f.hint))}
            </div>
        {/each}

        <!-- A FLOAT in (0,1]; integer parsing would destroy it, which is why it
             never went through the shared numeric reader. -->
        <div class="input-group cfg-num">
            <div class="cfg-num-row">
                <label class="input-label cfg-num-label" for="cfg-compress-ratio">{t('settings.safety.compressRatio')}</label>
                <input id="cfg-compress-ratio" class="input cfg-num-input" type="number"
                    min="0.1" max="1" step="0.05" placeholder="0.5"
                    value={config.history_compress_ratio ?? 0.5}
                    oninput={(e) => patch('history_compress_ratio', normalizeRatio(e.currentTarget.value))}>
                <span class="cfg-num-unit"></span>
                {@render helpBtn('history_compress_ratio')}
            </div>
            {@render helpPanel('history_compress_ratio', t('settings.safety.compressRatio.hint'))}
        </div>
    {/snippet}
    {#if showAdvanced}
        {@render section('safety', false, 'shield', t('settings.sec.safety'), safetyBody)}
    {/if}

    {#snippet pathsBody()}
        <p class="cfg-sec-hint">{@html t('settings.paths.hint')}</p>
        <textarea id="cfg-write-allowed" class="input cfg-path-area cfg-wide" rows="4"
            placeholder={'C:\\work\\reports\nC:\\data\\output'}
            value={(config.write_allowed_paths || []).join('\n')}
            oninput={(e) => patch('write_allowed_paths', normalizePathList(e.currentTarget.value))}
        ></textarea>

        <div class="input-group cfg-wide">
            <label class="input-label" for="cfg-fetch-hosts">{t('settings.fetchHosts')}</label>
            <textarea id="cfg-fetch-hosts" class="input cfg-path-area" rows="3"
                placeholder={'localhost\nintranet.example.com'}
                value={(config.fetch_allowed_hosts || []).join('\n')}
                oninput={(e) => patch('fetch_allowed_hosts', normalizeHostList(e.currentTarget.value))}
            ></textarea>
            <p class="input-hint">{@html t('settings.fetchHosts.hint')}</p>
        </div>
    {/snippet}
    {@render section('paths', false, 'folder', t('settings.sec.paths'), pathsBody)}

    {#snippet commandsBody()}
        <p class="cfg-sec-hint">{@html t('settings.commands.hint')}</p>
        <div class="input-group cfg-wide">
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
                    placeholder={t('settings.cmdPattern.placeholder')} bind:value={newCommand}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCommand(); } }}>
                <button class="btn btn-secondary" id="btn-approved-cmd-add" type="button"
                    onclick={addCommand}>{@html icon('plus', 12)} {t('settings.commands.add')}</button>
            </div>
        </div>
        <div class="input-group cfg-group-top cfg-wide">
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
        <div class="input-group cfg-group-top-sm cfg-wide">
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
        <div class="input-group cfg-wide">
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
        <div class="input-group cfg-wide">
            <p class="input-hint">{t('update.currentVersion', { version: appVersion || t('common.unknown') })}</p>

            {#if updatesConfigured}
                <!-- The check only reports; installing is a separate click on the banner. -->
                <p class="input-hint cfg-hint-tight">{t('update.signed.hint')}</p>
                <button class="btn btn-secondary cfg-nowrap" type="button"
                    onclick={() => onCheckUpdate?.()}>{@html icon('shield', 13)} {t('update.check')}</button>
            {/if}
        </div>
    {/snippet}
    <!-- NOT a setting — a capability, which is why it took a while to find a home.
         The browser tools need Playwright installed in the project, and the app had
         nowhere to say so: a failed run hid the tools and told the user nothing, and
         installing Playwright afterwards could not bring them back, because the flag
         that hid them was only ever cleared by a SUCCESSFUL browser call — which a
         hidden tool can no longer make. So this section is the state, the install
         line, and the two ways back out of that. -->
    {#snippet browserBody()}
        <div class="input-group cfg-wide">
            <p class="cfg-cap-state" class:is-ok={browserState.state === 'ok'}
                class:is-bad={browserState.state === 'unavailable'}>
                {@html icon(browserStateIcon, 13)} {t('browser.state.' + browserState.state)}
            </p>
            <p class="input-hint cfg-hint-tight">{@html t('browser.intro')}</p>
            <p class="input-hint cfg-hint-tight">{@html t('browser.hint.' + browserState.state)}</p>

            {#if browserState.reason}
                <p class="input-hint cfg-hint-tight">{t('browser.reason', { reason: browserState.reason })}</p>
            {/if}

            <p class="input-hint cfg-hint-tight">{t('browser.install')}</p>
            <code class="cfg-cap-cmd">{BROWSER_INSTALL_COMMAND}</code>

            {#if browserCheckedLabel}
                <p class="input-hint cfg-hint-tight">{t('browser.checked', { when: browserCheckedLabel })}</p>
            {/if}
            {#if browserNotice}
                <p class="cfg-cap-note">{browserNotice}</p>
            {/if}

            <div class="cfg-row-inline">
                <button class="btn btn-secondary cfg-nowrap" type="button" disabled={browserProbing}
                    onclick={() => onProbeBrowser?.()}
                    >{@html icon('search', 13)} {browserProbing ? t('browser.rechecking') : t('browser.recheck')}</button>
                <button class="btn btn-secondary cfg-nowrap" type="button"
                    onclick={() => onForgetBrowser?.()}>{t('browser.forget')}</button>
            </div>
            <p class="input-hint cfg-hint-tight">{t('browser.forget.hint')}</p>
        </div>
    {/snippet}
    {@render section('browser', false, 'monitor', t('settings.sec.browser'), browserBody)}

    {@render section('updates', false, 'gear',
        updatesConfigured ? t('update.section') : t('about.section'), updateBody)}

    <!-- Shown ONLY on a build that can verify licence keys. Without an issuing key
         there is no edition system from the user's point of view, and naming one
         ("Community") would advertise a paywall that does not exist — enforcement is
         off entirely (editions.js ENFORCEMENT_ENABLED). -->
    {#snippet licenseBody()}
        <div class="input-group cfg-wide">
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

<style>
    .cfg-secret-note {
        /* Sits between the key box and its hint now, not as a banner of its
           own between two unrelated fields. */
        margin: 2px 0 0;
        padding: 8px 12px;
        border: 1px solid var(--line-soft);
        border-left: 3px solid var(--accent);
        border-radius: var(--r-2);
        background: var(--surface-sunken);
        font-size: 11.5px; line-height: 1.55;
        color: var(--ink-soft);
    }
    .cfg-secret-note.is-fallback { border-left-color: var(--error, #c0392b); }
    .cfg-secret-note code { font-family: var(--font-mono); font-size: 11px; }

    /* A capability read-out, not a field: it states what IS, so it leads the
       section rather than sitting under a label. */
    .cfg-cap-state {
        display: flex; align-items: center; gap: 6px;
        margin: 0 0 2px; font-size: 13px; font-weight: 600;
        color: var(--ink-soft);
    }
    .cfg-cap-state.is-ok { color: var(--success, #2d7d46); }
    .cfg-cap-state.is-bad { color: var(--error, #c0392b); }
    .cfg-cap-cmd {
        display: block; margin: 2px 0 0; padding: 7px 10px;
        border: 1px solid var(--line-soft); border-radius: var(--r-2);
        background: var(--surface-sunken);
        font-family: var(--font-mono); font-size: 11px;
        color: var(--ink); user-select: all; overflow-x: auto; white-space: nowrap;
    }
    /* The outcome of the last re-check. Transient, so it reads as a reply to
       the click rather than as another permanent line of status. */
    .cfg-cap-note {
        margin: 6px 0 0; padding: 8px 12px;
        border: 1px solid var(--line-soft); border-left: 3px solid var(--accent);
        border-radius: var(--r-2); background: var(--surface-sunken);
        font-size: 11.5px; line-height: 1.55; color: var(--ink-soft);
    }
</style>
