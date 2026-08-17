// LLMTurn — pure native/JSON tool-call formatting helpers for the agent loop
// (P3 monolith split from AgentController.js). These are the pure parts of
// _generateWithHistory: formatting provider tool calls and deciding whether a
// text reply looks like a failed tool invocation. The async loop that calls
// llmService.chatWithTools / chat stays in AgentController.

/**
 * Format provider-streamed tool calls defensively. Provider stream assembly can
 * yield imperfect entries:
 *   • entry without `function` (or name at top level)  → tolerate/drop
 *   • arguments as EMPTY string (deltas lost / no-arg call) → {}
 *   • genuinely malformed JSON → throws SyntaxError (caller retries/falls back)
 *
 * @param {Array} toolCalls raw provider entries ({function:{name,arguments}} or flattened)
 * @param {(s:string)=>object} [parseJSON] parser for the arguments string. The
 *   agent passes its REPAIRING parser (_safeParseJSON), which recovers the
 *   common LLM JSON damage (trailing commas, unescaped Windows paths) before
 *   giving up; the default is strict JSON.parse.
 * @returns {Array<{name:string, args:object}>}
 * @throws {SyntaxError} when a non-empty arguments string is not valid JSON
 */
export function formatNativeToolCalls(toolCalls, parseJSON = JSON.parse) {
    return toolCalls
        .filter(tc => tc && (tc.function?.name || tc.name))
        .map(tc => {
            const fn = tc.function || tc;   // some providers flatten name/arguments
            let args = fn.arguments ?? fn.args ?? {};
            if (typeof args === 'string') {
                const s = args.trim();
                if (s === '') {
                    args = {};
                } else {
                    try {
                        args = parseJSON(s);
                    } catch (parseErr) {
                        throw new SyntaxError(`JSON parsing failed for tool '${fn.name}': ${parseErr.message}`);
                    }
                }
            }
            return { name: fn.name, args };
        });
}

/**
 * Does a plain-text model reply look like it tried to invoke a tool via text
 * instead of the function-call API? Used to decide whether to fall back to
 * JSON mode rather than accepting the text as a final answer.
 *
 * @param {string} txt trimmed text content of the reply
 * @param {string[]} [toolNames] known tool names (for the PLAN:/CALL: pattern)
 * @returns {boolean}
 */
export function looksLikeToolTextCall(txt, toolNames = []) {
    if (!txt) return false;
    const angle = '<function=' + '|<tool_' + 'call>'; // '<function=' | '<tool_call>'
    const named = (Array.isArray(toolNames) ? toolNames : []).some(
        td => new RegExp('\\b' + td + '\\b').test(txt) && /PLAN:/i.test(txt)
    );
    return /\bCALL:\s*\w/i.test(txt) ||
        txt.includes('<function=') ||
        txt.includes('<tool_' + 'call>') ||
        named;
}

/**
 * Strip an XML-style <thought> wrapper the model may output, keeping only the
 * inner OBSERVE/PLAN/CALL text.
 * @returns {string}
 */
export function stripThoughtWrapper(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return '';
    const start = raw.indexOf('<thought>');
    const end = raw.lastIndexOf('</thought>');
    if (start === -1 || end === -1) return raw;
    return raw.slice(start + '<thought>'.length, end).trim();
}
