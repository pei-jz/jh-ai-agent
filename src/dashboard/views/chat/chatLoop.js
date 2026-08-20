// chatLoop — one chat turn: stream a reply, run any tools it asked for, repeat.
//
// Extracted from ChatView.sendMessage, a 410-line method that interleaved the
// loop with the DOM it drew into: it created the reply bubble with
// `document.createElement`, wrote raw HTML into it on every chunk, removed it
// again when the chunk turned out to be a tool call, and kept a "thinking"
// indicator alive on a 100ms `setInterval` writing into an element by id.
//
// Two bugs came directly from that shape, and both are recorded in its comments:
//   • the streamed bubble was looked up with a GLOBAL getElementById on a
//     repeated id, so a tool loop's second iteration wrote into the previous
//     iteration's bubble;
//   • the final answer was appended twice on the success path, because the
//     error handler's "render what I just pushed" ran unconditionally.
//
// Here the loop only produces EVENTS. What they look like is the component's
// problem, and nothing needs an element id.

/** Turns beyond which we stop, so a model that keeps calling tools cannot spin. */
export const MAX_TOOL_LOOPS = 10;
/** How much history goes to the API — cache efficiency and context limits. */
export const MAX_HISTORY_MESSAGES = 10;

/**
 * Does this streamed text look like the start of a tool-call envelope?
 *
 * Used to show "thinking" instead of the raw JSON forming in the chat. It is a
 * PREFIX test on purpose: the decision has to be made from the first few
 * characters, before the object is complete.
 */
export function looksLikeToolCall(text) {
    const trimmed = String(text || '').trimStart();
    return trimmed.startsWith('```json')
        || trimmed.startsWith('{"thought"')
        || trimmed.startsWith('{ "thought"');
}

/** The conversation as the API wants it, most recent window only. */
export function toApiMessages(messages, limit = MAX_HISTORY_MESSAGES) {
    return (messages || [])
        .map(m => {
            if (m.isToolCall) return { role: 'assistant', content: m.content };
            if (m.isToolResult) return { role: 'user', content: m.content };
            return { role: m.role, content: m.content };
        })
        .slice(-limit);
}

/**
 * The tool-calling protocol block appended to the user's system prompt.
 *
 * Chat is deliberately told there is no `finish_task`: offering it made the
 * model spend its turn "finishing" and the user got a tool trace instead of an
 * answer. In Chat the reply IS the deliverable.
 */
export function buildSystemPrompt(base, toolDefs, outputLanguage) {
    const tools = (toolDefs || []).map(t => `<tool name="${t.function.name}">
<description>${t.function.description}</description>
<parameters>${JSON.stringify(t.function.parameters)}</parameters>
</tool>`).join('\n');

    return `${base}

<available_tools>
${tools}
</available_tools>

<instructions>
If you need to perform actions, query/modify files, run commands, or use any other tools, you MUST reply with a JSON object wrapped inside a markdown code block (\`\`\`json).
The JSON object must contain a "thought" string and a "tool_calls" array.

Example:
\`\`\`json
{
  "thought": "Describe what you observed, what you plan to do, and why you are calling the tool.",
  "tool_calls": [
    {
      "name": "list_files",
      "args": { "path": "." }
    }
  ]
}
\`\`\`

If no tool execution is needed, or if you have finished all tasks, you can reply normally in plain text.
Always write your thoughts and tool calls in the JSON structure if you use tools.
Once you have what you need, ANSWER in plain text. This is a conversation, not a
task: there is no \`finish_task\` to call, and a tool call is never a substitute
for the answer itself.
Your final responses and messages to the user MUST be in ${outputLanguage}.
</instructions>
`;
}

/** Was this error the user pressing stop, rather than a failure? */
export function isAbort(e) {
    return e?.name === 'AbortError'
        || String(e?.message || '').includes('aborted')
        || String(e?.message || '').includes('cancelled');
}

/**
 * The message shown when a run is stopped.
 *
 * A stop during a tool loop is a different event from a stop mid-sentence, and
 * saying which one happened is the difference between "it broke" and "it did
 * what I asked".
 */
export function abortMessage(messages) {
    const last = (messages || [])[messages.length - 1];
    return (last?.role === 'user' && String(last.content || '').startsWith('Tool Execution Results:'))
        ? '*(Tool execution loop stopped by user)*'
        : '*(Generation stopped by user)*';
}

/**
 * Run one turn to completion.
 *
 * Every side effect is injected, so the whole loop is testable without a DOM,
 * an LLM or a tool executor.
 *
 * @param {object} deps
 * @param {Array}  deps.messages          the live history; pushed to via `push`
 * @param {Function} deps.push            (msg) => void — append and persist
 * @param {object} deps.llm               { chat(apiMessages, system, onChunk, signal, images) }
 * @param {object} deps.tools            { getToolsForNativeAPI, executeTool, endSession }
 * @param {Function} deps.extractToolCall (text) => {thought, tool_calls} | null
 * @param {string} deps.systemPrompt
 * @param {string} deps.outputLanguage
 * @param {string[]} [deps.images]        sent on the FIRST iteration only
 * @param {AbortSignal} [deps.signal]
 * @param {Function} [deps.onThinking]    (on: boolean) => void
 * @param {Function} [deps.onStatus]      (text: string) => void — tool progress
 * @param {Function} [deps.onStreamStart] () => void
 * @param {Function} [deps.onStreamDelta] (full: string) => void
 * @param {Function} [deps.onStreamEnd]   (kept: boolean) => void — false ⇒ discard the bubble
 * @param {Function} [deps.confirm]       (req) => Promise<boolean>
 */
export async function runChatTurn({
    messages, push, llm, tools, extractToolCall,
    systemPrompt = '', outputLanguage = 'Japanese', images = [], signal = null,
    onThinking = () => {}, onStatus = () => {}, onStreamStart = () => {},
    onStreamDelta = () => {}, onStreamEnd = () => {}, confirm = async () => true,
}) {
    let loopCount = 0;
    let keepRunning = true;

    try {
        while (keepRunning && loopCount < MAX_TOOL_LOOPS) {
            if (signal?.aborted) break;

            onThinking(true);
            const prompt = buildSystemPrompt(systemPrompt, tools.getToolsForNativeAPI(), outputLanguage);

            let streamed = '';
            let started = false;
            const res = await llm.chat(
                toApiMessages(messages),
                prompt,
                (chunk) => {
                    if (!started) { started = true; onThinking(false); onStreamStart(); }
                    streamed += chunk;
                    onStreamDelta(streamed);
                },
                signal,
                loopCount === 0 ? images : [],
            );
            onThinking(false);

            const toolCall = extractToolCall(res.content);

            if (toolCall?.tool_calls?.length > 0) {
                loopCount++;
                // The streamed bubble only ever held the placeholder or raw JSON;
                // the tool-call entry replaces it, so the chat stays clean.
                onStreamEnd(false);

                push({ role: 'assistant', content: res.content, isToolCall: true, toolCalls: toolCall.tool_calls });

                const results = [];
                for (const call of toolCall.tool_calls) {
                    const result = await tools.executeTool(call, onStatus, confirm);
                    results.push({ tool_call_name: call.name, result });
                }
                push({
                    role: 'user',
                    content: `Tool Execution Results:\n${JSON.stringify(results, null, 2)}`,
                    isToolResult: true,
                    results,
                });

                if (toolCall.tool_calls.some(c => c.name === 'finish_task')) keepRunning = false;
            } else if (toolCall && (!toolCall.tool_calls || toolCall.tool_calls.length === 0)) {
                // JSON with no calls: the model planned out loud and stopped. Ask
                // for the answer rather than presenting a thought as the reply.
                loopCount++;
                onStreamEnd(false);
                push({ role: 'assistant', content: res.content, isToolCall: true, toolCalls: [] });
                push({
                    role: 'user',
                    content: 'You outputted a thought/planning JSON but no tool calls and no final answer. Please provide your final response to the user in plain text now.',
                });
            } else {
                // Plain prose — the answer. It is ALREADY on screen as the streamed
                // bubble, so it is kept rather than re-appended: appending here is
                // what used to duplicate every reply.
                onStreamEnd(true);
                push({ role: 'assistant', content: res.content, streamed: true });
                keepRunning = false;
            }
        }
    } catch (e) {
        onThinking(false);
        onStreamEnd(false);
        if (isAbort(e)) {
            push({ role: 'assistant', content: abortMessage(messages) });
        } else {
            console.error('Chat loop error:', e);
            push({ role: 'assistant', content: `Failed to generate reply: ${e.message || e}`, isError: true });
        }
    } finally {
        tools.endSession();
    }
}
