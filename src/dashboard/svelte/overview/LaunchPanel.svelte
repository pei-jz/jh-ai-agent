<!--
  LaunchPanel — the prompt box, the workspace field and the recipe chips.

  The launcher hands off to Monitor's new-task modal rather than creating the
  task itself. That modal owns workspace validation, the agent-mode picker, MCP
  selection, "/" template expansion and attachments — a second creation path here
  would be the weaker of the two and would drift.
-->
<script>
    import { untrack } from 'svelte';
    import { icon } from '../../utils/icons.js';
    import { clip } from '../../views/overview/overviewModel.js';

    let {
        recipes = [],
        projects = [],
        workspace = '',
        /** Placeholder changes when something is already running. */
        busy = false,
        onLaunch = null,
        onBrowse = null,
        onRecipe = null,
    } = $props();

    let prompt = $state('');
    // Seeded once; the $effect below takes over if the parent resolves a
    // different default later. `untrack` says the capture is deliberate.
    let ws = $state(untrack(() => workspace));
    let ta = $state(null);

    // Keep the field in step when the parent resolves a different default, but
    // never clobber what the user is typing.
    let seeded = $state(false);
    $effect(() => {
        if (!seeded && workspace) { ws = workspace; seeded = true; }
    });

    function autoGrow() {
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(150, Math.max(40, ta.scrollHeight)) + 'px';
    }

    function submit(e) {
        e?.preventDefault();
        const p = prompt.trim();
        if (!p) { ta?.focus(); return; }
        onLaunch?.({ prompt: p, ws: ws.trim() });
    }

    function onKeydown(e) {
        // Enter sends; Shift+Enter is a newline. `isComposing` keeps an IME
        // candidate selection from submitting the form.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
        }
    }

    async function applyRecipe(r) {
        const text = await onRecipe?.(r);
        if (typeof text === 'string') {
            prompt = text;
            ta?.focus();
            queueMicrotask(autoGrow);
        }
    }

    async function browse() {
        const picked = await onBrowse?.();
        if (picked) ws = picked;
    }
</script>

<form class="dl" onsubmit={submit} autocomplete="off">
    <textarea
        bind:this={ta}
        bind:value={prompt}
        class="dl-input"
        rows="1"
        placeholder={busy ? 'Queue another task…' : 'What should the agent do?'}
        oninput={autoGrow}
        onkeydown={onKeydown}
    ></textarea>
    <div class="dl-row">
        <input class="dl-ws" type="text" list="dash-ws-list" bind:value={ws}
            placeholder="(no workspace)" aria-label="Workspace">
        <datalist id="dash-ws-list">
            {#each projects as p}<option value={p}></option>{/each}
        </datalist>
        <button type="button" class="btn btn-secondary dl-browse" onclick={browse}
            title="Browse for a workspace folder" aria-label="Browse for a workspace folder">
            {@html icon('folder', 12)}
        </button>
        <button type="submit" class="btn btn-primary dl-go">{@html icon('bolt', 12)} Start</button>
    </div>
</form>

<div class="dr">
    <span class="a-lab dr-lab">Recipes</span>
    <div class="dr-chips">
        {#each recipes as r}
            <button type="button" class="dr-chip" title={clip(r.prompt, 120)} onclick={() => applyRecipe(r)}>
                {clip(r.label, 22)}{#if r.uses}<span class="n">×{r.uses}</span>{/if}
            </button>
        {/each}
        <a class="dr-chip is-add" href="#config?tab=templates">
            {@html icon('plus', 10)}
            {recipes.length ? ' Add' : ' Add a template to get one-click starts'}
        </a>
    </div>
</div>
