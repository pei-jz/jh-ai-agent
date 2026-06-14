// ResponseParser — PURE parsing of raw LLM output into { thought, tool_calls }.
//
// Extracted from AgentController (Phase 1 refactor) so the bug-prone, JSON-repair-
// heavy parsing logic is isolated, dependency-free (no Tauri / DOM / network), and
// fully unit-testable. AgentController delegates its `_extractToolCall` /
// `_safeParseJSON` / `_cleanFinalResponse` methods to these functions.

import { jsonrepair } from 'jsonrepair';

/**
 * Parse a JSON string with progressive repair fallbacks:
 *   1. plain JSON.parse
 *   2. strip ```markdown fences```
 *   3. fix unescaped Windows backslashes (`C:\Users` → `C:\\Users`)
 *   4. jsonrepair (missing quotes/colons/commas)
 *   5. extract outermost { … } and repair that
 * Returns the parsed value, or throws if nothing works. Non-strings pass through.
 */
export function safeParseJSON(str) {
    if (typeof str !== 'string') return str;
    let trimmed = str.trim();

    try {
        return JSON.parse(trimmed);
    } catch (e) {
        let repaired = trimmed;

        // Handle markdown code blocks
        if (repaired.startsWith('```')) {
            const lines = repaired.split('\n');
            if (lines[0].startsWith('```')) lines.shift();
            if (lines[lines.length - 1].startsWith('```')) lines.pop();
            repaired = lines.join('\n').trim();
        }

        try {
            return JSON.parse(repaired);
        } catch (e2) {}

        // Pre-repair: fix unescaped Windows backslashes — `\U`, `\f` etc. are
        // invalid JSON escapes. Double any backslash not part of a valid escape.
        try {
            const winEscapeFixed = repaired.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
            if (winEscapeFixed !== repaired) {
                return JSON.parse(winEscapeFixed);
            }
        } catch (e2b) {}

        try {
            const highlyRepaired = jsonrepair(repaired);
            return JSON.parse(highlyRepaired);
        } catch (e3) {
            // Last resort: outermost { … }.
            const start = repaired.indexOf('{');
            const end = repaired.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                const extracted = repaired.substring(start, end + 1);
                try {
                    return JSON.parse(jsonrepair(extracted));
                } catch (e4) {
                    try {
                        return JSON.parse(jsonrepair(extracted.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')));
                    } catch (_) {
                        throw e3;
                    }
                }
            }
            throw e3;
        }
    }
}

/**
 * Strip a SINGLE outermost ``` … ``` code fence wrapping the whole payload,
 * leaving any INNER fences intact. Anchored to the start/end of the (trimmed)
 * input and greedy, so it spans to the LAST closing fence — used so a JSON
 * tool-call envelope whose string values contain their own ```lang blocks
 * (e.g. present_result's `markdown` holding a ```java sample) is not truncated
 * at the first inner fence. Returns the unwrapped body, or the trimmed input
 * when there is no clean outermost wrapper.
 */
export function stripOuterCodeFence(text) {
    if (!text || typeof text !== 'string') return text || '';
    const t = text.trim();
    const m = t.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*)\r?\n```$/);
    return m ? m[1].trim() : t;
}

/**
 * Extract a tool-call envelope from arbitrary LLM text. Tries, in order:
 *   1. <thought>/<tool_calls><tool_call .../> XML tags
 *   1.5 a single outer ```json fence wrapping a JSON envelope (inner-fence safe)
 *   2. ```json``` code blocks
 *   3. a raw whole-string JSON object
 *   4. outermost { … }
 *   5. brace-matched scan for individual {name, args} calls
 * Returns { thought, tool_calls[] } or null when nothing parseable is found.
 */
export function extractToolCall(text) {
    if (!text) return null;
    const results = { thought: null, tool_calls: [] };

    // 1. XML-like tags
    const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/);
    if (thoughtMatch) {
        results.thought = thoughtMatch[1].trim();
    }

    const toolCallsMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
    if (toolCallsMatch) {
        const innerContent = toolCallsMatch[1];
        const toolCallRegex = /<tool_call\s+name="([^"]+)"\s+args=({[\s\S]*?}|"[^"]*")\s*\/>/g;
        let tcMatch;
        while ((tcMatch = toolCallRegex.exec(innerContent)) !== null) {
            try {
                let argsStr = tcMatch[2].trim();
                if (argsStr.startsWith('"') && argsStr.endsWith('"')) {
                    argsStr = argsStr.substring(1, argsStr.length - 1);
                }
                const args = safeParseJSON(argsStr);
                results.tool_calls.push({ name: tcMatch[1], args });
            } catch (e) {
                console.warn('Failed to parse args in <tool_call> tag:', tcMatch[2], e);
            }
        }
    }

    // 1b. Anthropic-style <function_calls><invoke name="X"><parameter ...>…</invoke>.
    //     Some models (e.g. DeepSeek) emit tool calls in this XML form as plain
    //     text instead of using the native function-call API or the JSON envelope.
    //     Parse it so those calls actually execute instead of being treated as a
    //     text-only "no tool call" reply (which stalled the agent loop).
    if (results.tool_calls.length === 0) {
        const invokeCalls = extractInvokeToolCalls(text);
        if (invokeCalls.length > 0) {
            results.tool_calls.push(...invokeCalls);
            if (!results.thought) {
                const idx = text.search(/<function_calls>|<invoke\b/);
                const pre = idx > 0 ? text.slice(0, idx).trim() : '';
                if (pre) results.thought = pre;
            }
        }
    }

    if (results.tool_calls.length > 0) return results;

    // 1.5 Outer ``` fence wrapping a single JSON envelope whose string values may
    // THEMSELVES contain ``` fences (e.g. present_result's markdown holding a
    // ```java block). Step 2's non-greedy block regex stops at the first INNER
    // fence and truncates the JSON (the truncated string is then "repaired" into
    // a short value — the bug where only the first lines of a code answer reached
    // the app). When the whole payload is one fenced block, strip just the
    // OUTERMOST fence and brace-match the JSON object so inner fences are kept.
    {
        const unfenced = stripOuterCodeFence(text);
        if (unfenced && unfenced !== text.trim()) {
            const s = unfenced.indexOf('{');
            const e = unfenced.lastIndexOf('}');
            if (s !== -1 && e > s) {
                try {
                    const data = safeParseJSON(unfenced.substring(s, e + 1));
                    if (data && (data.thought || data.tool_calls)) {
                        if (data.thought && !results.thought) results.thought = data.thought;
                        if (data.tool_calls) {
                            if (Array.isArray(data.tool_calls)) results.tool_calls.push(...data.tool_calls);
                            else if (typeof data.tool_calls === 'object' && data.tool_calls.name) results.tool_calls.push(data.tool_calls);
                        }
                    }
                } catch (_) { /* fall through to the block-regex / brace strategies */ }
            }
        }
        if (results.tool_calls.length > 0) return results;
    }

    // 2. JSON code blocks
    const blockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = blockRegex.exec(text)) !== null) {
        const rawContent = match[1].trim();
        try {
            const data = safeParseJSON(rawContent);
            if (data.thought) {
                if (!results.thought) results.thought = data.thought;
                else if (typeof results.thought === 'object' && typeof data.thought === 'object') Object.assign(results.thought, data.thought);
            }
            if (data.tool_calls) {
                if (Array.isArray(data.tool_calls)) {
                    results.tool_calls.push(...data.tool_calls);
                } else if (typeof data.tool_calls === 'object' && data.tool_calls.name) {
                    results.tool_calls.push(data.tool_calls);
                }
            }
        } catch (e) {
            const fallbackCalls = extractAllPossibleToolCalls(rawContent);
            if (fallbackCalls.length > 0) results.tool_calls.push(...fallbackCalls);
        }
    }

    // 3 & 4. Raw / outermost JSON
    if (results.tool_calls.length === 0) {
        const rawStr = text.trim();
        let parsedWhole = false;
        if (rawStr.startsWith('{') && rawStr.endsWith('}')) {
            try {
                const data = safeParseJSON(rawStr);
                if (data && (data.thought || data.tool_calls)) {
                    parsedWhole = true;
                    if (data.thought) results.thought = data.thought;
                    if (data.tool_calls) {
                        if (Array.isArray(data.tool_calls)) results.tool_calls.push(...data.tool_calls);
                        else if (typeof data.tool_calls === 'object' && data.tool_calls.name) results.tool_calls.push(data.tool_calls);
                    }
                }
            } catch (e) {}
        }

        if (!parsedWhole) {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                try {
                    const data = safeParseJSON(text.substring(start, end + 1));
                    if (data && (data.thought || data.tool_calls)) {
                        if (data.thought) results.thought = data.thought;
                        if (data.tool_calls) {
                            if (Array.isArray(data.tool_calls)) results.tool_calls.push(...data.tool_calls);
                            else if (typeof data.tool_calls === 'object' && data.tool_calls.name) results.tool_calls.push(data.tool_calls);
                        }
                    }
                } catch (e) {}
            }

            if (results.tool_calls.length === 0) {
                const fallbackCalls = extractAllPossibleToolCalls(text);
                if (fallbackCalls.length > 0) results.tool_calls.push(...fallbackCalls);
            }
        }
    }

    if (!results.thought) {
        results.thought = extractThoughtFromMalformedText(text);
    }

    if (results.tool_calls.length > 0 || results.thought) return results;
    return null;
}

/**
 * Parse Anthropic/XML-style tool calls:
 *   <function_calls>
 *     <invoke name="list_files">
 *       <parameter name="path" string="true">C:/foo</parameter>
 *     </invoke>
 *   </function_calls>
 * Returns [{ name, args }]. Parameter values are kept as strings when the tag
 * has string="true", otherwise JSON-parsed (so numbers/bools/arrays/objects come
 * through typed), falling back to the raw string when not valid JSON.
 */
export function extractInvokeToolCalls(text) {
    const calls = [];
    if (typeof text !== 'string' || (!text.includes('<invoke') && !text.includes('<function_calls'))) {
        return calls;
    }
    const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
    let m;
    while ((m = invokeRe.exec(text)) !== null) {
        const name = m[1];
        const inner = m[2];
        const args = {};
        const paramRe = /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/g;
        let p;
        while ((p = paramRe.exec(inner)) !== null) {
            const pname = p[1];
            const attrs = p[2] || '';
            // Strip the single newline the XML pretty-printing usually adds.
            const raw = p[3].replace(/^\n/, '').replace(/\n\s*$/, '');
            if (/\bstring\s*=\s*"true"/.test(attrs)) {
                args[pname] = raw;
            } else {
                try { args[pname] = JSON.parse(raw); }
                catch { args[pname] = raw; }
            }
        }
        calls.push({ name, args });
    }
    return calls;
}

/**
 * Brace-matched scan for individual {"name":…,"args":…} tool-call objects in
 * malformed text. String-aware (ignores braces inside quotes). Dedupes.
 */
export function extractAllPossibleToolCalls(text) {
    const toolCalls = [];
    let startPositions = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (char === '{') {
            startPositions.push(i);
        } else if (char === '}') {
            const startIdx = startPositions.pop();
            if (startIdx !== undefined) {
                const candidate = text.substring(startIdx, i + 1);
                if (candidate.includes('"name"') && candidate.includes('"args"')) {
                    const tryPush = (parsed) => {
                        if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.args && !parsed.tool_calls) {
                            const dup = toolCalls.some(tc => tc.name === parsed.name && JSON.stringify(tc.args) === JSON.stringify(parsed.args));
                            if (!dup) toolCalls.push(parsed);
                        }
                    };
                    try {
                        tryPush(safeParseJSON(candidate));
                    } catch (e) {
                        try { tryPush(JSON.parse(jsonrepair(candidate))); } catch (err) {}
                    }
                }
            }
        }
    }
    return toolCalls;
}

/** Best-effort extraction of a `thought` value from malformed/partial JSON text. */
export function extractThoughtFromMalformedText(text) {
    const stringRegex = /"thought"\s*:\s*"([^"]+)"/i;
    const match = text.match(stringRegex);
    if (match) return match[1];

    const objectStartIdx = text.search(/"thought"\s*:\s*\{/i);
    if (objectStartIdx !== -1) {
        const startBraceIdx = text.indexOf('{', objectStartIdx);
        if (startBraceIdx !== -1) {
            let braceCount = 0;
            let inString = false;
            let escape = false;
            for (let i = startBraceIdx; i < text.length; i++) {
                const char = text[i];
                if (escape) { escape = false; continue; }
                if (char === '\\') { escape = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (inString) continue;

                if (char === '{') braceCount++;
                else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        const objStr = text.substring(startBraceIdx, i + 1);
                        try {
                            return safeParseJSON(objStr);
                        } catch (e) {
                            try { return JSON.parse(jsonrepair(objStr)); } catch (err) {}
                        }
                        break;
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Strip a leading ReAct meta-preamble ("OBSERVE: … | PLAN: … | CALL: tool",
 * also pipe-less and multi-line forms) from a deliverable. Models are told to
 * narrate OBSERVE/PLAN before each call; when a model (e.g. MiMo) skips
 * present_result and that narration ends up as the finish_task thought, this
 * preamble would otherwise become the app-visible result. Any REAL content the
 * model placed AFTER the preamble (a code block, prose) is preserved — only the
 * meta-line is removed. A preamble-only string collapses to '' so the caller's
 * "no deliverable" path (report synthesis) takes over instead of showing meta.
 */
export function stripReActPreamble(text) {
    if (!text || typeof text !== 'string') return text || '';
    let t = text.replace(/^\s+/, '');
    // Form with an explicit "CALL: <tool>" terminator — strip through it.
    let m = t.match(/^OBSERVE:[\s\S]*?CALL:\s*[A-Za-z_][A-Za-z0-9_]*\b[ \t]*\.?/i);
    if (m) return t.slice(m[0].length).trim();
    // Native-protocol form (no CALL token): "OBSERVE: … PLAN: …" up to the end
    // of the PLAN line. Only strip when both markers are present so we never
    // eat a legitimate answer that merely happens to start with "OBSERVE".
    if (/^OBSERVE:/i.test(t) && /\bPLAN:/i.test(t)) {
        m = t.match(/^OBSERVE:[\s\S]*?PLAN:[^\n]*(\n|$)/i);
        if (m) return t.slice(m[0].length).trim();
    }
    return text.trim();
}

/**
 * Produce a clean, user-facing final response from raw LLM text — stripping
 * <thought>/<tool_calls> tags and JSON envelopes, surfacing prose when present,
 * else a formatted reasoning block, else a friendly fallback.
 */
export function cleanFinalResponse(text) {
    if (!text) return '';
    try {
        let thoughtPart = '';
        let remainingText = text;

        const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/);
        if (thoughtMatch) {
            thoughtPart = `> ${thoughtMatch[1].trim().replace(/\n/g, '\n> ')}`;
            remainingText = remainingText.replace(thoughtMatch[0], '').trim();
        }

        const toolCallsMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
        if (toolCallsMatch) {
            remainingText = remainingText.replace(toolCallsMatch[0], '').trim();
        }

        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            remainingText = remainingText.replace(jsonMatch[0], '').trim();
            try {
                const parsed = safeParseJSON(jsonMatch[1].trim());
                const thought = parsed.thought || parsed;
                if (typeof thought === 'object') {
                    const subThought = Object.entries(thought)
                        .map(([k, v]) => `> **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                        .join('\n');
                    thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + subThought;
                } else {
                    thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + `> ${thought}`;
                }
            } catch (e) {}
        } else {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                const possibleJson = text.substring(start, end + 1);
                try {
                    const parsed = safeParseJSON(possibleJson);
                    if (parsed.thought || parsed.tool_calls) {
                        remainingText = remainingText.replace(possibleJson, '').trim();
                        const thought = parsed.thought || parsed;
                        if (typeof thought === 'object') {
                            const subThought = Object.entries(thought)
                                .map(([k, v]) => `> **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                                .join('\n');
                            thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + subThought;
                        } else {
                            thoughtPart = (thoughtPart ? thoughtPart + '\n' : '') + `> ${thought}`;
                        }
                    }
                } catch (e) {}
            }
        }

        const cleanedThought = thoughtPart.replace(/[>\s\.]/g, '').trim();
        const isThoughtPlaceholder = cleanedThought.length === 0 || cleanedThought.toLowerCase() === 'reasoning' || cleanedThought.toLowerCase() === 'analyzing';

        const cleanedRemainingText = remainingText.trim();
        const isRemainingPlaceholder = cleanedRemainingText.replace(/[\s\.]/g, '').trim().length === 0;

        if (cleanedRemainingText.length > 5 && !isRemainingPlaceholder) {
            return remainingText;
        }
        if (thoughtPart && !isThoughtPlaceholder) {
            return `### 🧠 Reasoning Process\n${thoughtPart}`;
        }
        return 'すべてのタスクが正常に完了しました。';
    } catch (e) {}
    return String(text);
}
