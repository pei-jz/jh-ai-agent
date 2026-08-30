<!--
  ConnectionModal — add or edit one LLM connection.

  Part of region 5 (ConfigView). What this replaces is the clearest case in the
  whole migration: a ~90-line template literal with 14 fields, each read back later
  by `getElementById('modal-inst-…').value`, plus imperative `style.display`
  toggling to show the Azure-only field and to relabel the URL input when the
  provider changed. The form is bound state here, so "what did the user type" and
  "what does the form show" cannot disagree.

  Validation is `validateInstance` (pure, tested). It reports every problem at
  once — the old flow refused to save with no explanation of which field was wrong.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { untrack } from 'svelte';
    import { icon } from '../../utils/icons.js';
    import {
        allProviders, providerInfo, defaultBaseUrl, validateInstance, suggestForProvider,
    } from '../../views/config/providers.js';
    import { inferVisionSupport, instanceSupportsVision } from '../../../modules/ai/modelCapabilities.js';

    let {
        /** null = adding; otherwise the instance being edited. */
        instance = null,
        /** {state:'idle'|'testing'|'ok'|'fail', message:string} */
        testStatus = null,
        onSave = null,
        onCancel = null,
        onTest = null,
    } = $props();

    const isEdit = $derived(!!instance?.id);
    const providers = allProviders();

    /**
     * The form's own copy. Seeded ONCE from the prop: a $derived would throw away what
     * the user is typing every time the parent re-pushed props, which happens on every
     * test-connection status update.
     *
     * `untrack` is what makes that intent explicit. Reading a prop directly inside
     * $state(...) does the same thing but has the compiler warn that only the initial
     * value is captured — which was 12 warnings on this file alone, drowning out real
     * ones. Here capturing the initial value IS the requirement.
     */
    let form = $state(untrack(() => ({
        provider: instance?.provider || 'openai',
        name: instance?.name || '',
        model: instance?.model || '',
        api_key: instance?.api_key || '',
        base_url: instance?.base_url || '',
        api_version: instance?.api_version || '',
        context_window: instance?.context_window ?? '',
        max_output_tokens: instance?.max_output_tokens ?? '',
        temperature: instance?.temperature ?? '',
        cost_per_1m_input: instance?.cost_per_1m_input ?? '',
        cost_per_1m_cache_read: instance?.cost_per_1m_cache_read ?? '',
        cost_per_1m_output: instance?.cost_per_1m_output ?? '',
        // Seeded from the guess for a NEW connection; an existing one keeps what
        // it was saved with, so re-opening the dialog never silently flips it.
        supports_vision: instanceSupportsVision(instance || {}),
    })));

    const info = $derived(providerInfo(form.provider));
    /** What the name-based rule would say for the form as it stands right now. */
    const inferredVision = $derived(inferVisionSupport(form.provider, form.model));
    let showKey = $state(false);
    let errors = $state([]);

    /**
     * Changing the provider re-suggests the URL, name and model — but only where
     * the user has not typed anything of their own. The URL counts as untouched
     * when it is empty or still holds another provider's default.
     */
    const onProviderChange = (next) => {
        const urlWasDefault = !form.base_url
            || providers.some(p => p.urlHint === form.base_url && p.id !== 'generic');
        form.provider = next;
        if (urlWasDefault) form.base_url = defaultBaseUrl(next);
        Object.assign(form, suggestForProvider(next, form));
    };

    /** Blank number field ⇒ null (= "provider default"), not 0. */
    const num = (v) => {
        const s = String(v ?? '').trim();
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };

    const collect = () => ({
        ...(instance || {}),
        provider: form.provider,
        name: form.name.trim(),
        model: form.model.trim(),
        api_key: form.api_key.trim(),
        base_url: form.base_url.trim(),
        api_version: form.api_version.trim(),
        context_window: num(form.context_window),
        max_output_tokens: num(form.max_output_tokens),
        temperature: num(form.temperature),
        cost_per_1m_input: num(form.cost_per_1m_input),
        cost_per_1m_cache_read: num(form.cost_per_1m_cache_read),
        cost_per_1m_output: num(form.cost_per_1m_output),
        // Always written explicitly: once a connection has been through this
        // dialog, the guess no longer decides whether it gets images.
        supports_vision: !!form.supports_vision,
    });

    const submit = () => {
        const next = collect();
        errors = validateInstance(next);
        if (errors.length) return;
        onSave?.(next);
    };
</script>

<div class="modal-overlay" id="llm-modal-overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    role="presentation">
    <div class="modal cfg-modal" role="dialog" aria-modal="true">
        <div class="modal-title">
            <h3>
                {#if isEdit}{@html icon('edit', 14)} Edit LLM Connection
                {:else}{@html icon('plus', 14)} Add LLM Connection{/if}
            </h3>
        </div>

        <div class="provider-card-fields">
            <div class="input-group">
                <label class="input-label" for="modal-provider-type">{t('conn.providerType')}</label>
                <!-- Locked while editing: the provider decides the whole shape of
                     the credentials, so changing it is a new connection. -->
                <select id="modal-provider-type" class="select" disabled={isEdit}
                    value={form.provider}
                    onchange={(e) => onProviderChange(e.currentTarget.value)}>
                    {#each providers as p (p.id)}
                        <option value={p.id}>{p.label}</option>
                    {/each}
                </select>
            </div>

            <div class="grid-2">
                <div class="input-group">
                    <label class="input-label" for="modal-inst-name">{t('conn.name')}</label>
                    <input id="modal-inst-name" class="input" type="text"
                        bind:value={form.name} placeholder="e.g. My Connection">
                </div>
                <div class="input-group">
                    <label class="input-label" for="modal-inst-model">{t('conn.model')}</label>
                    <input id="modal-inst-model" class="input" type="text"
                        bind:value={form.model} placeholder="e.g. gpt-4o, claude-3-5-sonnet">
                </div>
            </div>

            <!-- A local runtime needs no key, so the field says so instead of
                 looking like a required blank. -->
            <div class="input-group" id="modal-key-group">
                <label class="input-label" for="modal-inst-key">{t('conn.apiKey')}</label>
                <div class="input-password-wrap">
                    <input id="modal-inst-key" class="input"
                        type={showKey ? 'text' : 'password'}
                        bind:value={form.api_key}
                        placeholder={info.keyHint}>
                    <button class="input-password-toggle btn-toggle-password" type="button"
                        title={showKey ? 'Hide' : 'Show'}
                        onclick={() => (showKey = !showKey)}>👁️</button>
                </div>
            </div>

            <!-- Azure's is a resource endpoint, not an API base, so the label comes
                 from the provider table rather than being relabelled from JS. -->
            <div class="input-group" id="modal-url-group">
                <label class="input-label" for="modal-inst-url">{info.urlLabel}</label>
                <input id="modal-inst-url" class="input" type="text"
                    bind:value={form.base_url} placeholder={info.urlHint}>
            </div>

            <!-- Azure-only. This used to be shown/hidden by writing style.display
                 from a change handler. -->
            {#if form.provider === 'azure'}
                <div class="input-group" id="modal-version-group">
                    <label class="input-label" for="modal-inst-version">{t('conn.apiVersion')}</label>
                    <input id="modal-inst-version" class="input" type="text"
                        bind:value={form.api_version} placeholder="e.g. 2024-08-01-preview">
                </div>
            {/if}

            <div class="input-group">
                <label class="input-label" for="modal-inst-context">{t('conn.contextWindow')}</label>
                <input id="modal-inst-context" class="input" type="number" min="0" step="1024"
                    bind:value={form.context_window}
                    placeholder="Auto-detect (leave blank). e.g. 65536 for DeepSeek, 131072 for Qwen">
                <small class="cfg-hint">Set this for models we don't recognize so history
                    compaction uses the correct window. Leave blank to auto-detect by model name.</small>
            </div>

            <div class="input-group">
                <label class="input-label" for="modal-inst-maxout">{t('conn.maxOutput')}</label>
                <input id="modal-inst-maxout" class="input" type="number" min="0" step="256"
                    bind:value={form.max_output_tokens}
                    placeholder={t('conn.maxOutput.placeholder')}>
                <small class="cfg-hint">Caps the model's reply length. Leave blank for the provider default.</small>
            </div>

            <!-- Vision is a per-connection FACT, not something a model name can be
                 trusted to reveal: a local llava / qwen2-vl takes images and has no
                 "gpt" in its name, and not every anthropic/gemini model takes them
                 at all. The box starts from the guess and the user overrides it. -->
            <div class="input-group">
                <label class="cfg-check" for="modal-inst-vision">
                    <input id="modal-inst-vision" type="checkbox" bind:checked={form.supports_vision}>
                    <span>{t('conn.vision')}</span>
                </label>
                <small class="cfg-hint">
                    {#if inferredVision === form.supports_vision}
                        Inferred from the provider and model name. Correct it here if it is wrong —
                        images are only sent to a connection that accepts them.
                    {:else}
                        Set by you (the name-based guess would say
                        <b>{inferredVision ? 'yes' : 'no'}</b>).
                    {/if}
                </small>
            </div>

            <div class="input-group">
                <label class="input-label" for="modal-inst-temp">Temperature (optional, 0.0–2.0)</label>
                <input id="modal-inst-temp" class="input" type="number" min="0" max="2" step="0.1"
                    bind:value={form.temperature}
                    placeholder="Provider default (blank). Use ~0.2 for reliable agent tool-use.">
                <small class="cfg-hint">Lower = more deterministic (better for tool-calling).
                    Leave blank for the provider default.</small>
            </div>

            <div class="input-group">
                <span class="input-label">Pricing — USD per 1M tokens (optional)</span>
                <div class="cfg-price-row">
                    <input id="modal-inst-cost-in" class="input" type="number" min="0" step="0.01"
                        bind:value={form.cost_per_1m_input} placeholder={t('conn.rate.in')}>
                    <input id="modal-inst-cost-cache" class="input" type="number" min="0" step="0.01"
                        bind:value={form.cost_per_1m_cache_read} placeholder={t('conn.rate.cache')}>
                    <input id="modal-inst-cost-out" class="input" type="number" min="0" step="0.01"
                        bind:value={form.cost_per_1m_output} placeholder={t('conn.rate.out')}>
                </div>
                <small class="cfg-hint">Used for the dashboard cost estimate when THIS model is
                    active. e.g. GPT-4o ≈ 2.5 / — / 10; Claude Sonnet ≈ 3 / 0.3 / 15.
                    Cache blank ⇒ ~10% of input.</small>
            </div>
        </div>

        <!-- Every problem at once. Refusing to save while saying nothing about which
             field was wrong was the old behaviour. -->
        {#if errors.length}
            <div class="cfg-modal-errors" role="alert">
                {#each errors as e (e)}<div>{e}</div>{/each}
            </div>
        {/if}

        {#if testStatus?.message}
            <div id="modal-test-status" class="cfg-test-status is-{testStatus.state || 'idle'}">
                {testStatus.message}
            </div>
        {/if}

        <div class="modal-actions cfg-modal-actions">
            <button class="btn btn-secondary cfg-btn-test" id="btn-modal-test"
                disabled={testStatus?.state === 'testing'}
                onclick={() => onTest?.(collect())}>⚡ Test Connection</button>
            <div class="cfg-modal-confirm">
                <button class="btn btn-secondary" id="btn-modal-cancel"
                    onclick={() => onCancel?.()}>{t('common.cancel')}</button>
                <button class="btn btn-primary" id="btn-modal-save"
                    onclick={submit}>{t('conn.save')}</button>
            </div>
        </div>
    </div>
</div>
