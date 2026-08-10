<!--
  FileList — the files one exchange touched, grouped by directory.

  Small lists start open; a big one starts collapsed to its summary line, because
  a run that touched 179 files used to flood the card it belongs to.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { buildFileTree } from '../../views/monitor/inspector.js';

    let { files = [], workspace = '', onOpenFile = null } = $props();

    const OPEN_BELOW = 8;
    const list = $derived(Array.isArray(files) ? files : []);
    let open = $state(true);
    // The initial state depends on the size, and $derived would fight the user's
    // click. Set it once per file-set instead.
    $effect(() => { open = list.length <= OPEN_BELOW; });

    /** Flat directory groups — one level is enough inside a card. */
    const groups = $derived.by(() => {
        const tree = buildFileTree(list, workspace);
        const out = [];
        const walk = (node, prefix) => {
            const name = prefix ? `${prefix}/${node.name}` : node.name;
            if (node.files.length) out.push({ dir: name || './', files: node.files });
            for (const child of node.dirs.values()) walk(child, name);
        };
        if (tree.files.length) out.push({ dir: './', files: tree.files });
        for (const child of tree.dirs.values()) walk(child, '');
        return out.sort((a, b) => a.dir.localeCompare(b.dir));
    });
</script>

{#if list.length}
    <div class="mrc-files-details">
        <button type="button" class="mrc-files-summary" onclick={() => (open = !open)}>
            {@html icon('file')} Changed files {list.length}
            <span class="mrc-fd-hint">{open ? '(click to collapse)' : '(click to expand)'}</span>
        </button>
        {#if open}
            <div class="mrc-files-scroll">
                {#each groups as g (g.dir)}
                    <div class="mrc-fg">
                        <div class="mrc-fg-dir" title={g.dir}>
                            {@html icon('folder')} {g.dir} <span class="mrc-fg-n">{g.files.length}</span>
                        </div>
                        <div class="mrc-files">
                            {#each g.files as f (f.path)}
                                <button
                                    type="button"
                                    class="mrc-file"
                                    data-open-path={f.path}
                                    title={f.path}
                                    onclick={() => onOpenFile?.(f.path)}
                                >{@html icon('file')} {f.name}{#if f.action}<span class="mrc-file-act">{f.action}</span>{/if}</button>
                            {/each}
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{/if}
