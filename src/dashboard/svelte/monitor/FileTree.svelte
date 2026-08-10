<!--
  FileTree — the changed-file list, as a directory tree.

  Recursion IS the markup here, and Svelte escapes the paths — as a string builder this
  had to concatenate its own indentation and re-escape every path by hand.
  `buildFileTree` (pure, unit-tested) still does the shaping.

  Directories COLLAPSE. A refactor that touches four areas produces a tree taller than
  the column, and the whole point of this panel is to answer "which part of the project
  did this run change?" at a glance — which you cannot do while scrolling. Open by
  default, because the common case is a handful of files and hiding those would just add
  a click.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import Self from './FileTree.svelte';

    let {
        /** A node from buildFileTree: {name, dirs: Map, files: []} */
        node,
        depth = 0,
        /** Called with the real absolute path — the row shows only the basename. */
        onOpenFile = null,
    } = $props();

    // Sorted views of the node's children. Directories lead: they are the structure,
    // and a reader scans for the area before the file.
    const dirs = $derived([...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)));
    const files = $derived([...node.files].sort((a, b) => a.name.localeCompare(b.name)));

    /**
     * Which directories are folded, by name.
     *
     * A Set of the CLOSED ones rather than the open ones, so a directory that appears
     * later (the run touches a new area mid-stream) arrives open like the rest instead
     * of needing an entry to become visible.
     */
    let closed = $state(new Set());
    const toggle = (name) => {
        const next = new Set(closed);
        if (next.has(name)) next.delete(name); else next.add(name);
        closed = next;
    };

    /** Indent by depth. Inline because the depth is data, not a fixed set of classes. */
    const pad = (d) => `padding-left:${4 + d * 12}px`;
    const isWrite = (action) => action === 'created' || action === 'modified';

    /** How many files a directory holds, all the way down — its one-line summary. */
    const countFiles = (n) => n.files.length
        + [...n.dirs.values()].reduce((sum, d) => sum + countFiles(d), 0);
</script>

{#each dirs as dir (dir.name)}
    {@const isClosed = closed.has(dir.name)}
    <button
        type="button"
        class="insp-tree-dir"
        class:is-closed={isClosed}
        style={pad(depth)}
        title={dir.name}
        aria-expanded={!isClosed}
        onclick={() => toggle(dir.name)}
    >
        <span class="insp-tree-chev">{isClosed ? '▶' : '▼'}</span>
        {@html icon('folder')}
        <span class="insp-tree-n">{dir.name}</span>
        <!-- The count is what makes a folded directory still say something. -->
        <span class="insp-tree-count">{countFiles(dir)}</span>
    </button>
    {#if !isClosed}
        <Self node={dir} depth={depth + 1} {onOpenFile} />
    {/if}
{/each}

{#each files as file (file.path)}
    <!-- A real <button>: this row is activated, so it must be reachable by keyboard.
         The old markup was a <div> with a delegated click handler, which no amount of
         CSS makes focusable. -->
    <button
        type="button"
        class="insp-file insp-tree-file"
        style={pad(depth)}
        data-open-path={file.path}
        title={file.path}
        onclick={() => onOpenFile?.(file.path)}
    >
        {@html icon(isWrite(file.action) ? 'edit' : 'file')}
        <span class="insp-file-n">{file.name}</span>
        {#if file.action}<span class="insp-file-a">{file.action}</span>{/if}
    </button>
{/each}
