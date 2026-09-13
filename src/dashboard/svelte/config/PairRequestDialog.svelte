<!--
  PairRequestDialog — "JHEditor wants to connect."

  The prompt IS the security boundary. Everything about it is shaped by the two
  ways an approval prompt fails.

  1. It names a claim instead of a program. Any process on this machine can POST
     `{"app": "JHEditor"}`, and a dialog that only shows that string is a dialog
     that can be made to say anything. So the app's own name is drawn as a
     claim, and the EXECUTABLE PATH the OS reported for the connecting socket is
     drawn beside it as the fact. When the path could not be read, that is said
     out loud rather than hidden — "unidentified" is information.

  2. It is approved by reflex. A background process can fire a request at the
     exact moment the user launches their editor; the dialog appears, it looks
     like the thing they just started, and they click Approve. The six-digit
     code is the answer: the requesting app shows the same number in its own
     window, so the user has something to COMPARE rather than something to
     assume. Comparison, not transcription — pairing happens again after every
     agent restart, and a code people must retype is friction they route around.

  Denying is the primary action here. Nothing breaks when a real app is denied
  (it asks again), and something does break when a fake one is approved.
-->
<script>
    import { icon } from '../../utils/icons.js';

    let {
        /** { id, app, code, pid, exe } */
        request,
        /** (id, approved) => void */
        onAnswer = null,
        /** Seconds left before the request expires on its own. */
        expiresIn = 120,
    } = $props();

    let remaining = $state(expiresIn);

    // The clock is not decoration: a request that has expired cannot be
    // approved, and a dialog that does not say so lets the user click a button
    // that does nothing.
    $effect(() => {
        const t = setInterval(() => {
            remaining = Math.max(0, remaining - 1);
            if (remaining === 0) onAnswer?.(request.id, false);
        }, 1000);
        return () => clearInterval(t);
    });

    // Split so the executable's own name can be read at a glance while the full
    // path stays visible — "jheditor.exe" in a folder nobody expected is the
    // thing worth noticing, and a long path buries it.
    const exeName = $derived(
        request.exe ? String(request.exe).split(/[\\/]/).pop() : null
    );
</script>

<div class="pair-overlay" role="dialog" aria-modal="true" aria-labelledby="pair-title">
    <div class="pair-box">
        <div class="pair-head">
            <span class="pair-ico">{@html icon('link', 16)}</span>
            <strong id="pair-title">接続の要求</strong>
        </div>

        <p class="pair-claim">
            <strong>{request.app}</strong> と名乗るプログラムが J.H AI Agent への接続を求めています。
        </p>

        <div class="pair-facts">
            <div class="pair-row">
                <span class="pair-key">実行ファイル</span>
                {#if request.exe}
                    <span class="pair-val">
                        <span class="pair-exe-name">{exeName}</span>
                        <span class="pair-exe-path">{request.exe}</span>
                    </span>
                {:else}
                    <span class="pair-val pair-unknown">
                        特定できませんでした — 名前は自己申告です
                    </span>
                {/if}
            </div>
            {#if request.pid}
                <div class="pair-row">
                    <span class="pair-key">PID</span>
                    <span class="pair-val">{request.pid}</span>
                </div>
            {/if}
        </div>

        <div class="pair-code-box">
            <p class="pair-code-hint">要求元のウィンドウに出ている番号と一致しますか？</p>
            <div class="pair-code">{request.code}</div>
        </div>

        <p class="pair-note">
            承認するとこのアプリはタスクの実行を含む API 全体を使えます。
            トークンは保存されず、J.H AI Agent を閉じると無効になります。
        </p>

        <div class="pair-actions">
            <span class="pair-clock">残り {remaining} 秒</span>
            <!-- Deny is the default action: nothing is lost by refusing a real
                 app, and the dialog is dismissed the same way by Escape. -->
            <button class="btn btn-primary" type="button"
                onclick={() => onAnswer?.(request.id, false)}>拒否</button>
            <button class="btn" type="button"
                onclick={() => onAnswer?.(request.id, true)}>番号が一致 — 承認</button>
        </div>
    </div>
</div>

<style>
    .pair-overlay {
        position: fixed; inset: 0; z-index: 5000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.55);
    }
    .pair-box {
        width: min(460px, 92vw);
        display: flex; flex-direction: column; gap: 12px;
        padding: 18px 20px; border-radius: var(--r-3, 10px);
        background: var(--surface-panel); border: 1px solid var(--line);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
    }
    .pair-head { display: flex; align-items: center; gap: 8px; font-size: var(--fs-md); }
    .pair-ico { color: var(--accent); display: inline-flex; }
    .pair-claim { margin: 0; font-size: var(--fs-sm); }

    .pair-facts {
        display: flex; flex-direction: column; gap: 6px;
        padding: 10px; border-radius: var(--r-2);
        background: var(--surface-sunken); border: 1px solid var(--line);
        font-size: var(--fs-sm);
    }
    .pair-row { display: flex; gap: 10px; align-items: baseline; }
    .pair-key { flex: 0 0 84px; color: var(--ink-soft); }
    .pair-val { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .pair-exe-name { font-weight: 600; }
    /* The full path wraps rather than truncating: the part that matters may be
       the directory, and an ellipsis would hide exactly that. */
    .pair-exe-path { color: var(--ink-soft); font-size: 11px; word-break: break-all; }
    .pair-unknown { color: var(--warning); }

    .pair-code-box {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        padding: 10px; border-radius: var(--r-2);
        background: var(--accent-surface); border: 1px solid var(--accent-dim);
    }
    .pair-code-hint { margin: 0; font-size: var(--fs-sm); color: var(--ink-soft); }
    .pair-code {
        font-size: 26px; font-weight: 700; letter-spacing: 6px;
        font-variant-numeric: tabular-nums;
    }

    .pair-note { margin: 0; font-size: 11.5px; color: var(--ink-soft); line-height: 1.55; }

    .pair-actions { display: flex; align-items: center; gap: 8px; }
    .pair-clock { margin-right: auto; font-size: 11.5px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
</style>
