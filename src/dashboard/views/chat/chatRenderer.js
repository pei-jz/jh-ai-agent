// chatRenderer — pulling a tool call out of an LLM response.
//
// This file used to be the chat's HTML-string builders. After the Svelte migration
// (region 6) the rendering is svelte/chat/ChatMessage.svelte, and what is left is the
// one thing here that was never rendering at all: PROTOCOL parsing. A model that
// cannot use native function-calling emits the call as text, in one of several
// dialects, and this recovers it.
//
// Consumers: ChatView (the chat loop) and main.js (the global app-intent path).


/** Extract a tool-call JSON object from an LLM response (fenced or bare). */
export function extractToolCall(response) {
    if (!response) return null;

    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1]);
        } catch (e) {
            try {
                const cleanStr = jsonMatch[1].trim();
                return JSON.parse(cleanStr);
            } catch (e2) {}
        }
    }

    if (response.trim().startsWith('{') && response.trim().endsWith('}')) {
        try {
            return JSON.parse(response);
        } catch (e) {}
    }

    return null;
}

/** Parse an agent "thought" into structured { observe, plan, call, raw }. */
// NOTE: parseThought / renderAgentSteps / renderMessageHtml / renderResultStatsChips
// are gone.
//
//   • renderMessageHtml → svelte/chat/ChatMessage.svelte (region 6).
//   • renderResultStatsChips → statChips in monitor/timelineItems.js, which the chat
//     bubble and the Monitor timeline now share instead of keeping two formatters.
//   • parseThought was only reachable through renderAgentSteps.
//   • renderAgentSteps had NO caller even before the migration — it rendered an
//     agent-step list for a chat mode that moved to Monitor → New Task.
//
// extractToolCall stays: it is protocol parsing, not rendering, and main.js uses it.
