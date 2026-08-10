<!--
  AttachmentPreviews — what is attached to the next message.

  Region 6. Same shape as SkillChips: innerHTML plus a per-item remove listener
  rebound after every change, reading the id back out of `data-id` on the closest
  ancestor.
-->
<script>
    let { attachments = [], onRemove = null } = $props();
    const list = $derived(Array.isArray(attachments) ? attachments : []);
</script>

{#each list as att (att.id)}
    <div class="chat-preview-item" class:preview-image={att.type === 'image'}
        class:preview-file={att.type !== 'image'} data-id={att.id}>
        {#if att.type === 'image'}
            <img src={att.dataUrl} alt={att.name}>
        {:else}
            <span>📄</span>
        {/if}
        <span class="file-name" title={att.name}>{att.name}</span>
        <button class="btn-remove-preview" type="button" title="Remove attachment"
            onclick={() => onRemove?.(att.id)}>✕</button>
    </div>
{/each}
