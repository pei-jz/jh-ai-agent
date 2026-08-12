<!--
  RagTab — workspace indexing for semantic search.

  The feature itself is not implemented (the Start button is disabled and says so —
  the "🚧 Coming soon" the productization report flagged). What IS live is the
  directory / extension picker, and it carried a genuine piece of imperative DOM
  work worth removing: unchecking a directory walked `.rag-dir-cb` and wrote
  `checked` plus `parentElement.style.opacity` on every descendant checkbox.

  That cascade is `descendantsOf` here — pure, tested, and expressed as data.
-->
<script>
    import { icon } from '../../utils/icons.js';
    import { RAG_EXTENSIONS, dirDepth, dirBasename, descendantsOf } from '../../views/config/rag.js';

    let {
        path = '',
        dirs = [],
        /** Directories the user has EXCLUDED (so an unseen one defaults to included). */
        exclusions = [],
        extensions = [],
        progress = 0,
        onPathChange = null,
        onLoadDirs = null,
        onToggleDir = null,
        onToggleExtension = null,
    } = $props();

    const excluded = $derived(new Set(exclusions));
    const chosenExts = $derived(new Set(extensions));

    /**
     * Unchecking a directory excludes everything beneath it too — the previous
     * version achieved this by walking the DOM and setting `.checked` on child
     * inputs, which meant the model and the checkboxes could disagree.
     */
    const toggleDir = (dir, include) => {
        onToggleDir?.([dir, ...descendantsOf(dir, dirs)], include);
    };
</script>

<div class="card settings-card cfg-tab-card">
    <div class="card-header cfg-tab-head-plain">
        <h3>{@html icon('search', 15)} RAG Indexing</h3>
        <p class="subtitle">Index your workspace for semantic code search (Auto-RAG)</p>
    </div>
    <div class="provider-card-fields">
        <div class="input-group">
            <label class="input-label" for="rag-path-input">Workspace Path</label>
            <div class="cfg-row-inline">
                <input id="rag-path-input" class="input cfg-grow" type="text" value={path}
                    placeholder={'C:\\path\\to\\workspace'}
                    oninput={(e) => onPathChange?.(e.currentTarget.value)}>
                <button class="btn btn-secondary cfg-nowrap" id="btn-rag-load-dirs"
                    onclick={() => onLoadDirs?.()}>Load Directories</button>
            </div>
        </div>

        <div class="input-group">
            <span class="input-label">Directories to Include</span>
            <div id="rag-dir-list" class="cfg-rag-dirs">
                {#if !dirs.length}
                    <div class="cfg-rag-hint">Enter a workspace path and click "Load Directories".</div>
                {:else}
                    {#each dirs as dir (dir)}
                        {@const isExcluded = excluded.has(dir)}
                        <label class="cfg-rag-dir" class:is-excluded={isExcluded}
                            style={`padding-left:${dirDepth(dir) * 16}px`}>
                            <input type="checkbox" class="rag-dir-cb" value={dir}
                                checked={!isExcluded}
                                onchange={(e) => toggleDir(dir, e.currentTarget.checked)}>
                            <span>{dirBasename(dir)}</span>
                        </label>
                    {/each}
                {/if}
            </div>
        </div>

        <div class="input-group">
            <span class="input-label">File Extensions</span>
            <div class="cfg-rag-exts">
                {#each RAG_EXTENSIONS as ext (ext)}
                    <label class="cfg-rag-ext">
                        <input type="checkbox" class="rag-ext-cb" value={ext}
                            checked={chosenExts.has(ext)}
                            onchange={(e) => onToggleExtension?.(ext, e.currentTarget.checked)}>
                        .{ext}
                    </label>
                {/each}
            </div>
        </div>

        {#if progress > 0}
            <div class="cfg-rag-bar"><div style={`width:${progress}%`}></div></div>
        {/if}

        <div class="cfg-rag-start">
            <!-- Not implemented. Saying so beats a button that does nothing. -->
            <button class="btn btn-primary" id="btn-rag-start" disabled>🚧 Coming soon</button>
            <span class="cfg-rag-hint">Semantic indexing is not available yet — this feature is
                under development.</span>
        </div>
    </div>
</div>
