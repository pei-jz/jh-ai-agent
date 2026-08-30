<!--
  Inspector — the Task view's metadata column.

  Keep the timeline a pure reading surface and put everything you look UP — ids,
  timings, token flow, the files a run touched, the actions you might take — in a
  column of its own.

  FIRST component of the Svelte migration (docs/design/svelte-migration.md). It
  was chosen because it is a pure function of its props with no internal state,
  so behaviour parity with the string builder it replaces is provable. The
  calculations (cost, cache accounting, tree shaping) stay in
  views/monitor/inspector.js as pure, separately-tested exports — only the
  RENDERING moved here.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { icon } from '../../utils/icons.js';
    import {
        cacheInsideInput, freshInput, costOf, costOfModels, fmtCost, fmtTokens, buildFileTree,
    } from '../../views/monitor/inspector.js';
    import FileTree from './FileTree.svelte';
    import Sparkline from './Sparkline.svelte';

    let {
        task = null,
        stats = {},
        usage = {},
        files = [],
        perStep = [],
        rates = null,
        /** model → rates. Lets a run that changed models be priced per model. */
        costTable = null,
        chapters = [],
        activeChapter = '',
        /** 'workspace' | 'instructions' | 'copy' */
        onAction = null,
        onChapter = null,
        onOpenFile = null,
    } = $props();

    const NO_WS = '(no workspace — MCP / research task)';
    // A refactor can touch hundreds of files; this column is a reference, not a
    // file manager.
    const FILE_CAP = 200;

    const ws = $derived(task?.workspace_path || '');
    const cached = $derived(usage.cache_read_input_tokens || 0);
    const inclusive = $derived(cacheInsideInput(usage));
    // Price each model's own slice when the run used more than one; only fall
    // back to a single rate set for a task recorded before per-model attribution
    // existed. Otherwise a finished run's cost moved every time the active model
    // changed, because its whole volume was re-priced at the new model's rates.
    const cost = $derived(costOfModels(task?.model_usage, costTable, rates) || costOf(usage, rates));
    const mixedModels = $derived(Object.keys(task?.model_usage || {}).length > 1);

    // Per-model token + cost rows for the inspector's Token usage section. Each
    // model that actually consumed tokens gets a row, priced at its own rates
    // (falling back to the task's rate set, then to "no price").
    const modelRows = $derived((() => {
        const mu = task?.model_usage || {};
        const entries = Object.entries(mu).filter(([, u]) => u && typeof u === 'object');
        if (!entries.length) return [];
        return entries.map(([model, u]) => {
            const tokens = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0)
                + (Number(u.cache_read_input_tokens) || 0);
            const c = costOf(u, (costTable && costTable[model]) || rates);
            return {
                model,
                tokens,
                in: fmtTokens(u.prompt_tokens || 0),
                out: fmtTokens(u.completion_tokens || 0),
                cache: fmtTokens(u.cache_read_input_tokens || 0),
                cost: c ? fmtCost(c.total) : null,
            };
        }).filter(r => r.tokens > 0);
    })());

    const elapsed = $derived(stats.durationMs ? `${Math.round(stats.durationMs / 1000)}s` : '');
    const shortId = $derived(task?.id ? `#${String(task.id).slice(0, 8)}` : '');

    const fileList = $derived(Array.isArray(files) ? files : []);
    const shownFiles = $derived(fileList.slice(0, FILE_CAP));
    const hiddenFiles = $derived(fileList.length - shownFiles.length);
    const tree = $derived(buildFileTree(shownFiles, ws));

    // A row renders only when it has a value — an inspector full of em-dashes is
    // noise. `0` counts as a value; empty string and null do not.
    const has = (v) => v || v === 0;
    const freshIn = $derived(fmtTokens(freshInput(usage.prompt_tokens, cached, inclusive)));

    // One chapter is not a table of contents.
    const chapterList = $derived(Array.isArray(chapters) && chapters.length >= 2 ? chapters : []);
</script>

{#if task}
    <!-- Status / Started / Steps are gone: the task list on the left already
         carries them (status dot, start time, progress), so a reference column
         repeating them costs height without adding information. What stays is
         what the list cannot show: the stable id, the caller and the elapsed. -->
    <div class="insp-sec">
        <div class="insp-h">{t('common.task')}</div>
        {#each [
            ['ID', shortId],
            ['Caller', task.caller],
            ['Elapsed', elapsed],
        ] as [label, value]}
            {#if has(value)}
                <div class="insp-row">
                    <span class="insp-k">{label}</span>
                    <span class="insp-v">{value}</span>
                </div>
            {/if}
        {/each}
    </div>

    <!-- The workspace used to be a full fixed row above the story, costing
         vertical space on every render for a value that cannot change during a
         run. It is reference material, so it belongs here — beside the actions
         that act on it. -->
    <div class="insp-sec">
        <div class="insp-h">{t('common.workspace')}</div>
        <div class="insp-ws" title={ws || NO_WS}>
            {@html icon('folder')}
            <span class="insp-ws-path">{ws || NO_WS}</span>
        </div>
    </div>

    <div class="insp-sec">
        <div class="insp-h">Token usage{perStep.length ? ' (per step)' : ''}</div>
        <Sparkline {perStep} {usage} {inclusive} />
        <!-- "In" is the part that MISSED the cache — the same split the bars
             use, and the only one whose cost figure means anything. -->
        <div class="insp-row">
            <span class="insp-k">{cached ? 'In (fresh)' : 'In'}</span>
            {#if cost}<span class="insp-cost">{fmtCost(cost.in)}</span>{/if}
            <span class="insp-v">{freshIn}</span>
        </div>
        <!-- Only worth a row when caching actually did something. -->
        {#if cached}
            <div class="insp-row">
                <span class="insp-k">{t('task.cached')}</span>
                {#if cost}<span class="insp-cost">{fmtCost(cost.cache)}</span>{/if}
                <span class="insp-v">{fmtTokens(cached)}</span>
            </div>
        {/if}
        <div class="insp-row">
            <span class="insp-k">Out</span>
            {#if cost}<span class="insp-cost">{fmtCost(cost.out)}</span>{/if}
            <span class="insp-v">{fmtTokens(usage.completion_tokens || 0)}</span>
        </div>
        <div class="insp-row">
            <span class="insp-k">{t('common.total')}</span>
            {#if cost}<span class="insp-cost">{fmtCost(cost.total)}</span>{/if}
            <span class="insp-v">{fmtTokens(usage.total_tokens || 0)}</span>
        </div>
        <!-- When the run touched more than one model, the totals above are a SUM
             of differently-priced slices. The per-model rows below are the actual
             usage, so "which model cost me what" has an answer instead of a blend. -->
        {#if modelRows.length > 1}
            <div class="insp-models">
                {#each modelRows as r (r.model)}
                    <div class="insp-row">
                        <span class="insp-k" title={r.model}>{r.model}</span>
                        {#if r.cost}<span class="insp-cost">{r.cost}</span>{/if}
                        <span class="insp-v">{r.in} ↑ · {r.cache} ⚡ · {r.out} ↓</span>
                    </div>
                {/each}
            </div>
        {/if}
        {#if mixedModels}
            <!-- Say so: a mixed-model total is a SUM of differently-priced slices,
                 not one volume at one rate, and that is worth knowing before
                 comparing it against another run. -->
            <div class="insp-note">
                {Object.keys(task.model_usage).length} モデル分を個別単価で合算
            </div>
        {/if}
    </div>

    {#if fileList.length}
        <div class="insp-sec">
            <div class="insp-h">{t('task.changedFiles')}<span class="insp-n">{fileList.length}</span></div>
            <div class="insp-tree">
                <FileTree node={tree} {onOpenFile} />
                {#if hiddenFiles > 0}
                    <div class="insp-tree-more">+{hiddenFiles} more</div>
                {/if}
            </div>
        </div>
    {/if}

    <div class="insp-sec">
        <div class="insp-h">{t('common.actions')}</div>
        <!-- Both workspace actions act on a PATH. On an MCP / research task there
             is none, and they were dead controls. -->
        {#if ws}
            <button type="button" class="insp-act" data-insp-act="workspace"
                onclick={() => onAction?.('workspace')}>
                {@html icon('folder')} Open workspace
            </button>
            <button type="button" class="insp-act" data-insp-act="instructions"
                onclick={() => onAction?.('instructions')}>
                {@html icon('template')} Project instructions
            </button>
        {/if}
        <button type="button" class="insp-act" data-insp-act="copy"
            onclick={() => onAction?.('copy')}>
            {@html icon('report')} Copy the result
        </button>
    </div>

    <!-- LAST on purpose: the chapter rail is the longest section on a long run, and
         sitting above Actions it pushed them off-screen. It is also the one section
         you scroll TO deliberately rather than glance at. -->
    {#if chapterList.length}
        <div class="insp-sec">
            <div class="insp-h">{t('task.chapters')}</div>
            {#each chapterList as c (c.id)}
                <button
                    type="button"
                    class="insp-chap insp-chap-{c.kind}"
                    class:is-active={c.id === activeChapter}
                    data-chap={c.id}
                    onclick={() => onChapter?.(c.id)}
                >
                    <span class="insp-chap-dot"></span>{c.label}
                </button>
            {/each}
        </div>
    {/if}
{/if}
