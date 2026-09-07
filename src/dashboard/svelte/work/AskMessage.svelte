<!--
  AskMessage — one turn in an `ask` conversation.

  Was svelte/chat/ChatMessage.svelte, restored unchanged: the tool call is ONE
  line with the arguments behind a closed disclosure, a successful result folds
  to a muted line, and an ERROR stays open — because a failed lookup silently
  folded away is how a wrong answer gets trusted.

  Region 6. Replaces `renderMessageHtml` (~120 lines of string building, every style
  written as an inline attribute repeated per attachment) and the manual append path:
  `_appendLastMessage` created a detached <div>, set its innerHTML, took
  `firstElementChild` and appended it. That is the hot path — it ran after every
  message push during generation.

  Markdown rendering stays injected (`renderMarkdown` / `renderUserMarkdown`) so this
  component never decides how content is parsed; chat/chatMarkdown.js owns that and
  keeps its own tests.
-->
<script>
    import { t } from '../../../i18n/index.js';
    import { renderFileList } from '../../utils/resultView.js';
    import { statChips } from '../../views/monitor/timelineItems.js';
    import { icon } from '../../utils/icons.js';

    let {
        msg,
        /** Assistant content → HTML (formatMessageContent). */
        renderMarkdown = (t) => String(t ?? ''),
        /** User content → HTML (formatMarkdown — no tool-call unwrapping). */
        renderUserMarkdown = (t) => String(t ?? ''),
        onOpenFile = null,
    } = $props();

    const isUser = $derived(msg.role === 'user');
    const kb = (n) => `${(Number(n || 0) / 1024).toFixed(1)} KB`;
    const isErrorResult = (r) => typeof r.result === 'string' && r.result.startsWith('Error');
    const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

    const results = $derived(msg.results || []);
    const hasResultError = $derived(results.some(isErrorResult));
    const toolCalls = $derived(msg.toolCalls || []);
    const toolNames = $derived(toolCalls.map(tc => tc.name).join(', ') || 'tools');
</script>

{#if msg.isToolCall}
    <!-- A tool call reads as one line: simple chat should read like a conversation,
         not a transcript. The raw args stay behind a closed disclosure for debugging. -->
    <div class="chat-message-row msg-ai chat-row-full">
        <div class="chat-tool-activity">
            <div class="chat-tool-head">
                <span class="chat-tool-spinner">🔍</span>
                <span>{t('ask.researching')} <span class="chat-tool-names">{toolNames}</span></span>
            </div>
            <details class="chat-tool-details">
                <summary>{t('common.details')}</summary>
                {#each toolCalls as tc, i (i)}
                    <div class="chat-tool-arg">
                        <div class="chat-tool-arg-name">{tc.name}</div>
                        <pre><code>{JSON.stringify(tc.args, null, 2)}</code></pre>
                    </div>
                {/each}
            </details>
        </div>
    </div>

{:else if msg.isToolResult}
    <!-- A success collapses to one muted line; an ERROR stays visible, because a
         failed lookup silently folded away is how a wrong answer gets trusted. -->
    <div class="chat-message-row msg-ai chat-row-full">
        <div class="chat-tool-activity chat-tool-result" class:is-error={hasResultError}>
            <details>
                <summary>
                    {#if hasResultError}⚠️ Tool returned an error
                    {:else}✓ Research data retrieved ({results.length}){/if}
                </summary>
                {#each results as r, i (i)}
                    <div class="chat-tool-res">
                        <div class="chat-tool-res-name" class:is-error={isErrorResult(r)}>
                            <strong>{r.tool_call_name}</strong>
                        </div>
                        <pre class:is-error={isErrorResult(r)}><code>{asText(r.result)}</code></pre>
                    </div>
                {/each}
            </details>
        </div>
    </div>

{:else}
    <div class="chat-message-row" class:msg-user={isUser} class:msg-ai={!isUser}>
        <div class="message-bubble" class:is-error={msg.isError}>
            <div class="message-content" class:is-error={msg.isError}>
                {#if isUser}
                    {@html renderUserMarkdown(msg.displayContent || msg.content)}
                {:else}
                    {@html renderMarkdown(msg.content)}
                {/if}
            </div>

            {#if msg.images?.length}
                <div class="chat-bubble-images">
                    <!-- Zooming is the delegated [.chat-zoomable-img] handler on the
                         container (ChatView.init). One path, not two. -->
                    {#each msg.images as src, i (i)}
                        <img class="chat-zoomable-img" {src} alt={t('common.attachment')}>
                    {/each}
                </div>
            {/if}

            {#if msg.files?.length}
                <div class="chat-bubble-files">
                    {#each msg.files as f, i (i)}
                        <div class="chat-file-chip">
                            <span>📄</span>
                            <span class="chat-file-name">{f.name}</span>
                            <span class="chat-file-size">({kb(f.size)})</span>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if msg.skills?.length}
                <div class="chat-bubble-skills">
                    {#each msg.skills as s, i (i)}
                        <span class="skill-chip skill-chip-static" title={`Skill: ${s.name}`}>
                            <span class="skill-chip-icon">⚡</span>
                            <span class="skill-chip-label">{s.title || s.name}</span>
                        </span>
                    {/each}
                </div>
            {/if}

            <!-- A completed agent turn's numbers and the files it touched. Shares
                 statChips with the Monitor timeline rather than a second formatter. -->
            {#if !isUser && msg.resultStats}
                <div class="mrc-stats">
                    {#each statChips(msg.resultStats) as c (c.icon + c.text)}
                        <span>{@html icon(c.icon)} {c.text}</span>
                    {/each}
                </div>
            {/if}
            {#if !isUser && msg.resultFiles?.length}
                <!-- Still the shared string helper: the vanilla delegated
                     [data-open-path] handler on the container picks up its clicks,
                     and that handler moves with the ChatView shell. -->
                {@html renderFileList(msg.resultFiles)}
            {/if}
        </div>
    </div>
{/if}
