<!--
  AllowlistModal — what the agent may run without asking again.

  Replaces MonitorView._showApprovedCommandsModal, which rebuilt the ENTIRE
  overlay with innerHTML after every single removal — the only way it had to
  refresh one row — while relying on one delegated click handler to tell a close
  button from a delete button.

  The lists live in localStorage because they are per-machine trust decisions,
  not project configuration.
-->
<script>
    import { t } from '../../../i18n/index.js';
    const PATTERN_KEY = 'jhai_approved_commands';
    const WORKSPACE_KEY = 'jhai_autoapprove_workspaces';

    let { onClose = null } = $props();

    const read = (k) => {
        try {
            const a = JSON.parse(localStorage.getItem(k) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (_) { return []; }
    };

    let patterns = $state(read(PATTERN_KEY));
    let workspaces = $state(read(WORKSPACE_KEY));

    function remove(key, value) {
        const next = read(key).filter(x => x !== value);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch (_) { /* storage full */ }
        if (key === PATTERN_KEY) patterns = next; else workspaces = next;
    }
</script>

<div
    class="acm-overlay"
    role="button"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }}
>
    <div class="acm-box" role="dialog" aria-label={t('allow.title')}>
        <div class="acm-head">
            <strong>🛡 Command approval allowlist</strong>
            <button class="acm-close" type="button" aria-label={t('common.close')} onclick={() => onClose?.()}>✖</button>
        </div>
        <div class="acm-body">
            <div>
                <div class="acm-section">{t('allow.patterns')}<code>*</code> = prefix match)</div>
                <div class="acm-list">
                    {#each patterns as p (p)}
                        <div class="acm-row">
                            <code>{p}</code>
                            <button class="acm-del" type="button" title={t('common.remove')}
                                onclick={() => remove(PATTERN_KEY, p)}>✕</button>
                        </div>
                    {:else}
                        <div class="acm-empty">(none)</div>
                    {/each}
                </div>
            </div>
            <div>
                <div class="acm-section">{t('allow.autoWs')}</div>
                <div class="acm-list">
                    {#each workspaces as w (w)}
                        <div class="acm-row">
                            <code>{w}</code>
                            <button class="acm-del" type="button" title={t('common.remove')}
                                onclick={() => remove(WORKSPACE_KEY, w)}>✕</button>
                        </div>
                    {:else}
                        <div class="acm-empty">(none)</div>
                    {/each}
                </div>
            </div>
            <div class="acm-note">
                Dangerous commands (rm / Remove-Item / git reset --hard / push --force …) are
                always confirmed, whatever is on these lists.
            </div>
        </div>
    </div>
</div>

<style>
    .acm-overlay {
        position: fixed; inset: 0; z-index: 4200; padding: 24px;
        background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
    }
    .acm-box {
        background: var(--surface-panel);
        border: 1px solid var(--line);
        border-radius: var(--r-3);
        width: 560px; max-width: 94vw; max-height: 86vh;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }
    .acm-head {
        padding: 14px 18px;
        border-bottom: 1px solid var(--line);
        background: var(--surface-sunken);
        display: flex; justify-content: space-between; align-items: center;
    }
    .acm-head strong { font-size: 14px; }
    .acm-close { background: none; border: none; color: var(--ink); cursor: pointer; font-size: 18px; }
    .acm-body {
        padding: 16px 18px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 16px;
    }
    .acm-section { font-size: 12px; font-weight: 700; color: var(--ink-soft); margin-bottom: 6px; }
    .acm-list { display: flex; flex-direction: column; gap: 4px; }
    .acm-note { font-size: 11px; color: var(--ink-faint); }
</style>
