<!--
  ImageZoom — a screenshot at full size.

  Replaces MonitorView._openImageZoom, which built the overlay with
  createElement, wrote the <img> through innerHTML with the src interpolated
  unescaped, and registered a document-level keydown that it then had to
  remember to remove inside its own close handler.
-->
<script>
    let { src = '', alt = 'Full size image', onClose = null } = $props();
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose?.(); }} />

<div
    class="iz-overlay"
    role="button"
    tabindex="-1"
    aria-label="Close full-size image"
    onclick={() => onClose?.()}
    onkeydown={(e) => { if (e.key === 'Enter') onClose?.(); }}
>
    <img {src} {alt}>
</div>

<style>
    .iz-overlay {
        position: fixed; inset: 0; z-index: 5000; padding: 24px;
        background: rgba(0, 0, 0, 0.85);
        display: flex; align-items: center; justify-content: center;
        cursor: zoom-out;
    }
    .iz-overlay img {
        max-width: 96vw; max-height: 92vh;
        border-radius: 8px;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
    }
</style>
