<!--
  Onboarding — first-run setup.

  The productization report's P0: a new user had to start a model runtime, pick a model
  and set a workspace unaided, and for the audience this aims at that is where they
  stopped. Three steps, and only the first is required.

  Two things it deliberately does NOT do:
    • It does not block. Skip is always available and is remembered — someone who
      wants to configure things by hand should not be asked twice.
    • It does not reimplement the connection form. Step 1 reuses ConnectionModal's
      pieces (the provider table, the validator, Test Connection) so the wizard and
      Settings cannot drift into disagreeing about what a valid connection is.

  Whether it opens at all is `shouldShowOnboarding` in views/onboarding/steps.js — a
  question about the real config, not a "has run" flag.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { t } from '../../../i18n/index.js';
    import { STEPS, canAdvance } from '../../views/onboarding/steps.js';
    import {
        allProviders, providerInfo, defaultBaseUrl, validateInstance, suggestForProvider,
    } from '../../views/config/providers.js';

    let {
        /**
         * From readSetupState — what is already configured.
         *
         * NOT named `state`: that shadows the `$state` rune, and `$state(...)` then
         * compiles as a store auto-subscription to the prop. The name is reserved in
         * practice even though nothing says so.
         */
        setup = { hasConnection: false, hasWorkspace: false, skipped: false },
        /** Where to open. From initialStep(state). */
        step = 0,
        /** {state, message} while testing / after a test. */
        testStatus = null,
        /** Approved project folders, so step 2 can show what is set. */
        workspaces = [],
        onSaveConnection = null,
        onTestConnection = null,
        onPickWorkspace = null,
        onRemoveWorkspace = null,
        onSkip = null,
        onFinish = null,
        onStep = null,
    } = $props();

    const providers = allProviders();
    const last = STEPS.length - 1;

    let form = $state({
        provider: 'openai', name: '', model: '', api_key: '', base_url: '',
    });
    let errors = $state([]);
    const info = $derived(providerInfo(form.provider));

    const onProviderChange = (next) => {
        const wasDefault = !form.base_url
            || providers.some(p => p.urlHint === form.base_url && p.id !== 'generic');
        form.provider = next;
        if (wasDefault) form.base_url = defaultBaseUrl(next);
        Object.assign(form, suggestForProvider(next, form));
    };

    const collect = () => ({
        provider: form.provider,
        name: form.name.trim() || `${form.provider.toUpperCase()} Connection`,
        model: form.model.trim(),
        api_key: form.api_key.trim(),
        base_url: form.base_url.trim(),
    });

    const save = () => {
        const next = collect();
        errors = validateInstance(next);
        if (errors.length) return;
        onSaveConnection?.(next);
    };

    const go = (n) => onStep?.(Math.max(0, Math.min(last, n)));
</script>

<div class="ob-overlay" role="dialog" aria-modal="true" aria-label={t('onboarding.aria')}>
    <div class="ob-panel">
        <div class="ob-head">
            <div class="ob-title">
                <h2>{t('onboarding.title')}</h2>
                <p>{STEPS[step].blurb}</p>
            </div>
            <!-- Always available. A setup wizard that traps you is worse than none. -->
            <button class="ob-skip" type="button" onclick={() => onSkip?.()}>{t('onboarding.skip')}</button>
        </div>

        <ol class="ob-rail">
            {#each STEPS as s, i (s.id)}
                <li class="ob-rail-item" class:is-current={i === step} class:is-done={i < step}>
                    <span class="ob-rail-num">{i < step ? '✓' : i + 1}</span>
                    <span class="ob-rail-label">{s.title}</span>
                </li>
            {/each}
        </ol>

        <div class="ob-body">
            {#if step === 0}
                {#if setup.hasConnection}
                    <div class="ob-ok">
                        {@html icon('shield', 15)} 接続は設定済みです。次へ進めます。
                    </div>
                {/if}
                <div class="input-group">
                    <label class="input-label" for="ob-provider">{t('onboarding.provider')}</label>
                    <select id="ob-provider" class="select" value={form.provider}
                        onchange={(e) => onProviderChange(e.currentTarget.value)}>
                        {#each providers as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
                    </select>
                    {#if info.keyless}
                        <p class="input-hint">{t('onboarding.keyless.hint')}</p>
                    {/if}
                </div>
                <div class="grid-2">
                    <div class="input-group">
                        <label class="input-label" for="ob-model">{t('onboarding.model')}</label>
                        <input id="ob-model" class="input" type="text" bind:value={form.model}
                            placeholder={info.model}>
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="ob-key">{t('onboarding.apiKey')}</label>
                        <input id="ob-key" class="input" type="password" bind:value={form.api_key}
                            placeholder={info.keyHint} disabled={info.keyless}>
                    </div>
                </div>
                <div class="input-group">
                    <label class="input-label" for="ob-url">{info.urlLabel}</label>
                    <input id="ob-url" class="input" type="text" bind:value={form.base_url}
                        placeholder={info.urlHint}>
                </div>

                {#if errors.length}
                    <div class="cfg-modal-errors" role="alert">
                        {#each errors as e (e)}<div>{e}</div>{/each}
                    </div>
                {/if}
                {#if testStatus?.message}
                    <div class="cfg-test-status is-{testStatus.state || 'idle'}">{testStatus.message}</div>
                {/if}

                <div class="ob-actions">
                    <button class="btn btn-secondary" type="button"
                        disabled={testStatus?.state === 'testing'}
                        onclick={() => onTestConnection?.(collect())}>⚡ {t('onboarding.test')}</button>
                    <button class="btn btn-primary" type="button" onclick={save}>
                        {@html icon('save', 13)} 保存して次へ</button>
                </div>

            {:else if step === 1}
                {#if workspaces.length}
                    <div class="ob-ws-list">
                        {#each workspaces as ws (ws)}
                            <div class="ob-ws-row">
                                {@html icon('folder', 13)}
                                <code>{ws}</code>
                                <button class="ob-ws-del" type="button" title={t('common.delete')}
                                    onclick={() => onRemoveWorkspace?.(ws)}>✕</button>
                            </div>
                        {/each}
                    </div>
                {:else}
                    <p class="ob-muted">{t('onboarding.noWorkspace')}</p>
                {/if}
                <div class="ob-actions">
                    <button class="btn btn-secondary" type="button"
                        onclick={() => onPickWorkspace?.()}>{@html icon('folder', 13)} フォルダを選ぶ</button>
                </div>

            {:else}
                <ul class="ob-ready">
                    <li>{@html icon('report', 14)} <strong>資料を読ませる</strong> — Excel / Word / PowerPoint をそのまま読み、要点や集計を出します。</li>
                    <li>{@html icon('table', 14)} <strong>成果物を作らせる</strong> — Excel（新規・既存の部分更新）や Word 文書を出力します。</li>
                    <li>{@html icon('search', 14)} <strong>調べさせる</strong> — Web とローカルの資料を横断して調査レポートにまとめます。</li>
                    <li>{@html icon('clock', 14)} <strong>定期実行</strong> — 毎朝の集計などを Schedule に登録できます。</li>
                </ul>
                <p class="ob-muted">
                    設定は Settings からいつでも変更できます。コード作業をさせるときは、タスク作成時のモードを
                    <strong>Develop</strong> に切り替えてください。
                </p>
                <div class="ob-actions">
                    <button class="btn btn-primary" type="button" onclick={() => onFinish?.()}>
                        はじめる</button>
                </div>
            {/if}
        </div>

        <div class="ob-foot">
            <button class="btn btn-secondary btn-sm" type="button"
                disabled={step === 0} onclick={() => go(step - 1)}>{t('common.back')}</button>
            <span class="ob-count">{step + 1} / {STEPS.length}</span>
            {#if step < last}
                <!-- Step 1 gates: without a connection nothing downstream works, so
                     advancing would only postpone the same dead end. -->
                <button class="btn btn-secondary btn-sm" type="button"
                    disabled={!canAdvance(step, setup)}
                    title={canAdvance(step, setup) ? '' : '先に接続を保存してください'}
                    onclick={() => go(step + 1)}>{t('common.next')}</button>
            {:else}
                <span></span>
            {/if}
        </div>
    </div>
</div>
