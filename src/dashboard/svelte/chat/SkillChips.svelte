<!--
  SkillChips — the skills attached to the next message.

  Region 6. innerHTML plus a per-chip remove listener rebound on every change; the
  remove handler read the skill name back out of `data-name` on the closest ancestor.
-->
<script>
    let { skills = [], onRemove = null } = $props();
    const list = $derived(Array.isArray(skills) ? skills : []);
</script>

{#each list as s (s.name)}
    <span class="skill-chip" data-name={s.name} title={`Skill: ${s.name}`}>
        <span class="skill-chip-icon">⚡</span>
        <span class="skill-chip-label">{s.title || s.name}</span>
        <button class="skill-chip-remove" type="button" title="Remove skill"
            onclick={() => onRemove?.(s.name)}>✕</button>
    </span>
{/each}
