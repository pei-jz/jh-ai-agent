<!--
  AskConversation — the conversation surface for an `ask` run.

  Was svelte/chat/ChatMessages.svelte, restored unchanged. The engine behind it
  is now the agent (one loop, logged, billed, remembered) but the SURFACE is the
  one Chat had, because that is what a conversation should look like — see
  docs/design/information-architecture.md §4 and views/monitor/askConversation.js
  for the mapping.

  Region 6. This replaces the manual append path, which was the hot loop: on every
  message push during generation, `_appendLastMessage` built a detached <div>, set its
  innerHTML from a string renderer, pulled out `firstElementChild`, appended it and
  called `scrollIntoView`. The empty-state placeholder had to be removed by hand
  first, and a transient system notice was a second, near-duplicate copy of the same
  code (`_appendSystemMessage`).

  A keyed `{#each}` covers all of it: existing bubbles are untouched when one is
  appended, so a streaming reply does not re-parse the markdown of the whole
  conversation.

  Transient notices are passed in alongside the real messages rather than injected
  into the DOM, so they cannot survive a re-render they were never part of.
-->
<script>
    import AskMessage from './AskMessage.svelte';

    let {
        messages = [],
        /** Non-persisted warnings/status lines, shown after the conversation. */
        notices = [],
        renderMarkdown = (t) => String(t ?? ''),
        renderUserMarkdown = (t) => String(t ?? ''),
        onOpenFile = null,
    } = $props();

    const list = $derived(Array.isArray(messages) ? messages : []);

    /**
     * A stable key per message.
     *
     * Index alone is wrong for a conversation that only ever grows at the end — but
     * messages carry no id, and inventing one here would not survive the reload path
     * that rebuilds them from storage. Index is correct FOR THIS SHAPE (append-only,
     * plus in-place mutation of the last bubble while streaming) and is what the
     * append-based predecessor effectively used.
     */
</script>

{#if !list.length && !notices.length}
    <!-- A run always has at least its request, so this only shows in the gap
         before the first item arrives. -->
    <div class="chat-empty-state">
        <div class="chat-empty-icon">💬</div>
        <h3>…</h3>
    </div>
{:else}
    {#each list as msg, i (i)}
        <AskMessage {msg} {renderMarkdown} {renderUserMarkdown} {onOpenFile} />
    {/each}
    {#each notices as text, i (i)}
        <div class="chat-message-row msg-ai">
            <div class="message-bubble chat-notice">
                <div class="message-content chat-notice-content">{text}</div>
            </div>
        </div>
    {/each}
{/if}
