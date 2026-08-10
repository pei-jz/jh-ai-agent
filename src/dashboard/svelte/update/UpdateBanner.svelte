<!--
  UpdateBanner — the one place the app talks about updates.

  A corner banner rather than a modal: an update is news, not an interruption, and the
  user has to be able to keep working while deciding.

  The wording comes from `describe()` so the conditions and the words cannot drift —
  in particular, a FAILED check must never read as "you are up to date". Nothing here
  installs anything: that needs the button.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { describe } from '../../views/update/updateState.js';
    import { t } from '../../../i18n/index.js';

    let {
        /** From the updater module's state machine. */
        state = { phase: 'idle' },
        onInstall = null,
        onDismiss = null,
        onDisable = null,
    } = $props();

    const view = $derived(describe(state));
    const phase = $derived(state?.phase || 'idle');
    const canInstall = $derived(phase === 'available');
    // Mid-download there is nothing safe to cancel, so the banner stays put.
    const canDismiss = $derived(phase !== 'downloading' && phase !== 'ready');
</script>

{#if phase !== 'idle' && view.title}
    <div class="upd-banner" class:is-failed={phase === 'failed'} role="status" aria-live="polite">
        <span class="upd-ic" class:is-busy={view.busy}>
            {#if phase === 'failed'}{@html icon('alert', 15)}
            {:else if phase === 'available' || phase === 'ready'}{@html icon('save', 15)}
            {:else}{@html icon('shield', 15)}{/if}
        </span>

        <div class="upd-body">
            <div class="upd-title">{view.title}</div>
            {#if view.detail}<div class="upd-detail">{view.detail}</div>{/if}
            {#if phase === 'downloading'}
                <div class="upd-bar"><div style={`width:${state.progress}%`}></div></div>
            {/if}
        </div>

        <div class="upd-actions">
            {#if canInstall}
                <!-- Downloading verifies the signature before anything is installed;
                     an unsigned or mis-signed bundle fails here and is discarded. -->
                <button class="btn btn-primary btn-sm" type="button"
                    onclick={() => onInstall?.()}>{t('update.install')}</button>
            {/if}
            {#if phase === 'available'}
                <button class="upd-link" type="button"
                    onclick={() => onDisable?.()}>{t('update.disable')}</button>
            {/if}
            {#if canDismiss}
                <button class="upd-close" type="button" title={t('common.close')}
                    onclick={() => onDismiss?.()}>✕</button>
            {/if}
        </div>
    </div>
{/if}
