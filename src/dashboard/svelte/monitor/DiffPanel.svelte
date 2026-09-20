<!--
  DiffPanel — a lightweight inline diff viewer for one changed file.

  Shells out to the existing `git_diff` Tauri command and colourises the
  unified-diff output (see views/monitor/diffView.js for the parsing). Nothing
  here re-implements diffing: git is the engine. Loaded lazily on first open, so
  a file list with fifty rows costs nothing until the user asks to see one.

  State machine, local to this panel:
    idle  → loading → ready (diff) | empty (no diff) | error (message)
  Re-clicking the Diff button closes it, so the toggle is a single control.

  A second control — Revert — restores the file to the index, undoing exactly
  the unstaged change the diff shows. It is destructive, so it asks first.
-->
<script>
    import { invoke } from '@tauri-apps/api/core';
    import { icon } from '../../utils/icons.js';
    import { parseUnifiedDiff, relPathFor } from '../../views/monitor/diffView.js';

    let {
        /** Absolute path of the changed file. */
        path = '',
        /** The workspace root — used as git's cwd and to relativise the path. */
        workspace = '',
    } = $props();

    const rel = $derived(relPathFor(path, workspace));

    let open = $state(false);
    let loading = $state(false);
    let reverting = $state(false);
    let error = $state('');
    let lines = $state([]);
    let meta = $state({ diff: '', empty: false });

    // git_diff / git_revert run with `cwd` inside an allowed root (PathGuard).
    // A workspace opened from task history may not be registered yet — the agent
    // registers it live, not at boot — so grant it before invoking. Idempotent;
    // ignored by older backends.
    async function ensureRoot() {
        try { await invoke('set_allowed_roots', { roots: [workspace] }); } catch (_) { /* older backend */ }
    }

    /** Run git_diff for this file and fold its output into state. */
    async function fetchDiff() {
        const out = await invoke('git_diff', {
            cwd: workspace,
            staged: false,
            path: rel || null,
        });
        const text = String(out || '').trim();
        if (!text || text === '(no diff)') {
            meta = { ...meta, empty: true };
            lines = [];
        } else {
            meta = { ...meta, empty: false };
            lines = parseUnifiedDiff(text);
        }
    }

    async function load() {
        if (!open) {
            open = true;
            if (!lines.length && !error) {
                if (!workspace) {
                    error = 'No workspace — cannot read the diff for this file.';
                    return;
                }
                loading = true;
                try {
                    await ensureRoot();
                    await fetchDiff();
                } catch (e) {
                    error = e?.message || String(e);
                    lines = [];
                } finally {
                    loading = false;
                }
            }
        } else {
            open = false;
        }
    }

    async function revert() {
        if (reverting) return;
        if (!workspace) {
            open = true;
            error = 'No workspace — cannot revert this file.';
            return;
        }
        const ok = confirm(
            `変更を元に戻しますか？\n\nファイル: ${rel}\n\n` +
            'この操作は元に戻せません。作業ツリー上の変更が破棄され、' +
            'インデックス（git add 済み）の内容に戻ります。',
        );
        if (!ok) return;
        reverting = true;
        error = '';
        try {
            await ensureRoot();
            await invoke('git_revert', { cwd: workspace, path: rel || null });
            // Re-read the diff so the panel shows the now-empty state.
            open = true;
            loading = true;
            try {
                await fetchDiff();
            } finally {
                loading = false;
            }
        } catch (e) {
            open = true;
            error = e?.message || String(e);
        } finally {
            reverting = false;
        }
    }
</script>

<div class="tl-diff">
    <span class="tl-diff-actions">
        <button type="button" class="tl-diff-toggle" class:is-open={open}
            aria-expanded={open}
            onclick={load}>
            {@html icon('code', 12)} Diff
        </button>
        <button type="button" class="tl-diff-toggle is-revert"
            onclick={revert} disabled={reverting}
            title="このファイルの変更を元に戻す">
            {@html icon('history', 12)} {reverting ? 'Reverting…' : 'Revert'}
        </button>
    </span>

    {#if open}
        <div class="tl-diff-panel">
            {#if loading}
                <div class="tl-diff-note">{@html icon('clock', 12)} Reading diff…</div>
            {:else if error}
                <div class="tl-diff-note is-error">{@html icon('alert', 12)} {error}</div>
            {:else if meta.empty}
                <div class="tl-diff-note">{@html icon('check', 12)} No diff (working tree matches index).</div>
            {:else}
                <pre class="tl-diff-pre">{#each lines as ln, i (i)}<div class="tl-diff-line is-{ln.type}">{ln.text || ' '}</div>{/each}</pre>
            {/if}
        </div>
    {/if}
</div>
