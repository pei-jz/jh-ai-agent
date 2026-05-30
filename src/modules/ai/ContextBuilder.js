import { invoke } from '@tauri-apps/api/core';
import { projectContext } from './ProjectContext.js';
import { conversationMemory } from './ConversationMemory.js';
import { workflowManager } from './WorkflowManager.js';
import { tokenEstimator } from './TokenEstimator.js';
import llmService from './LLMService.js';
import { toolExecutor } from './ToolExecutor.js';

class ContextBuilder {
    constructor() {
        // Cache for the static prompt prefix (persona + tool defs + protocol + rules).
        // Rebuilt only when workspace, model, language, or native-tool flag changes.
        // Call invalidateStaticCache() at session start to force a fresh build.
        this._staticCache = null;
        // { key: string, prefix: string }
    }

    /**
     * The JSON-envelope tool-calling protocol block (used when native function
     * calling is NOT available). Extracted as a static method so the runtime
     * native→JSON fallback (AgentController._generateWithHistory) can append it
     * when a model that claimed native support fails to actually emit tool calls —
     * otherwise the model would be asked for the JSON envelope by a parser while
     * the system prompt only described the function-call API (a silent mismatch).
     */
    static getJsonModeProtocol() {
        return `
<protocol>
When invoking tools, reply with EXACTLY ONE JSON object wrapped in a \`\`\`json fenced code block.
NO commentary before or after the fence. NO multiple JSON blocks. NO trailing prose.

The "thought" field MUST follow this 3-part structure (one sentence each):
  "OBSERVE: <what you see> | PLAN: <what you'll do and why> | CALL: <tool name>"

\`\`\`json
{
  "thought": "OBSERVE: The export is missing from utils.js. | PLAN: Add it with multi_replace to keep the edit minimal. | CALL: multi_replace_file_content",
  "tool_calls": [
    { "name": "tool_name", "args": { "arg_name": "value" } }
  ]
}
\`\`\`

JSON FORMATTING RULES (critical — most failures come from these):
  • All string values MUST escape: backslash \\\\, double-quote \\", newline \\n, tab \\t.
  • Do NOT include unescaped newlines inside a JSON string. Use \\n.
  • If a string contains a code snippet with quotes, escape every " as \\".
  • Backticks are fine unescaped (JSON has no special meaning for them).
  • Keep "thought" SHORT — long strings increase escape-mistake odds.
</protocol>
`;
    }

    /** Force a full rebuild on the next getSystemPrompt call. */
    invalidateStaticCache() {
        this._staticCache = null;
    }

    /**
     * Smart extraction of the active file context.
     */
    _smartExtractActiveFile(fileContent, cursorLine, maxLines) {
        const lines = fileContent.split('\n');
        const totalLines = lines.length;

        if (totalLines <= maxLines) {
            return fileContent;
        }

        const importantLines = new Set();

        const contextHalf = Math.floor(maxLines * 0.6 / 2);
        const startLine = Math.max(0, cursorLine - contextHalf);
        const endLine = Math.min(totalLines - 1, cursorLine + contextHalf);
        for (let i = startLine; i <= endLine; i++) {
            importantLines.add(i);
        }

        const structuralRegex = /^(import|export|class|function|const \w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|let \w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/;

        let structCount = 0;
        const maxStructLines = maxLines * 0.4;

        for (let i = 0; i < totalLines; i++) {
            if (structCount >= maxStructLines) break;
            if (importantLines.has(i)) continue;

            const line = lines[i].trim();
            if (structuralRegex.test(line)) {
                importantLines.add(i);
                structCount++;
                if (i + 1 < totalLines && lines[i+1].trim() === '{') {
                    importantLines.add(i + 1);
                    structCount++;
                }
            }
        }

        const sortedLines = Array.from(importantLines).sort((a, b) => a - b);
        let result = [];
        let lastLineAdded = -1;

        for (const lineIdx of sortedLines) {
            if (lastLineAdded !== -1 && lineIdx > lastLineAdded + 1) {
                result.push(`... (L${lastLineAdded + 2} to L${lineIdx} omitted) ...`);
            }
            result.push(lines[lineIdx]);
            lastLineAdded = lineIdx;
        }

        return result.join('\n');
    }

    gatherActiveContext(clientContext = null) {
        if (!clientContext) return '';
        const parts = [];

        const isAgentPrivateFile = (path) => {
            if (!path) return false;
            const normalized = path.replace(/\\/g, '/');
            return normalized.includes('/.agent/');
        };

        // 1. Active file content
        if (clientContext.currentFile && !isAgentPrivateFile(clientContext.currentFile)) {
            parts.push(`<active_file path="${clientContext.currentFile}" content_status="omitted_for_agent_mode_use_read_file_tool" />`);
        }

        // 2. Other open files
        if (Array.isArray(clientContext.openFiles) && clientContext.openFiles.length > 0) {
            const otherFiles = clientContext.openFiles.filter(p => p !== clientContext.currentFile && !isAgentPrivateFile(p));
            if (otherFiles.length > 0) {
                parts.push(`<other_open_files>\n${otherFiles.map(p => `  <file path="${p}"/>`).join('\n')}\n</other_open_files>`);
            }
        }

        // 3. Terminal output
        if (clientContext.terminalOutput && clientContext.terminalOutput.trim()) {
            parts.push(`<terminal_output>\n<![CDATA[\n${clientContext.terminalOutput.trim()}\n]]>\n</terminal_output>`);
        }

        // 4. Linter/Diagnostics
        if (Array.isArray(clientContext.diagnostics) && clientContext.diagnostics.length > 0) {
            parts.push(`<linter_diagnostics>`);
            clientContext.diagnostics.forEach(d => {
                parts.push(`  <error line="${d.line || 'unknown'}" type="${d.type || 'error'}">${d.message}</error>`);
            });
            parts.push(`</linter_diagnostics>`);
        }

        return parts.length === 0 ? '' : `<active_context>\n${parts.join('\n')}\n</active_context>\n`;
    }

    async getSystemPrompt(workspacePath, clientContext = null, editContext = null, kisContext = '', currentQuery = '') {
        const root = workspacePath || '.';

        const currentModel = llmService.getCurrentModel() || '';
        // Use the effective limit (honors per-connection context_window override
        // and the real provider) so DeepSeek/Qwen/etc. aren't mis-sized to 32K.
        const modelLimit = llmService.getEffectiveModelLimit();
        const systemBudget = Math.floor(modelLimit * 0.4);

        // Project Info (in-memory, cheap)
        let projectInfo = projectContext.getPromptContext();
        const projectTokens = tokenEstimator.estimateTokens(projectInfo);
        if (projectTokens > Math.floor(systemBudget * 0.25)) {
            projectInfo = tokenEstimator.trimToFit(projectInfo, Math.floor(systemBudget * 0.25));
        }

        // Active Context (from param, in-memory)
        let activeContext = '';
        try {
            activeContext = this.gatherActiveContext(clientContext);
            const activeTokens = tokenEstimator.estimateTokens(activeContext);
            if (activeTokens > Math.floor(systemBudget * 0.2)) {
                activeContext = tokenEstimator.trimToFit(activeContext, Math.floor(systemBudget * 0.2));
            }
        } catch (e) {
            console.warn('Failed to gather active context:', e);
        }

        // Memory + Workflow (in-memory)
        // Pass currentQuery so relevant past sessions are ranked first.
        let memoryContext = '';
        try {
            memoryContext = conversationMemory.getPromptContext(currentQuery);
        } catch (e) { }

        const workflowContext = workflowManager.getPromptContext();

        // Artifacts (DISK IO — must run every iteration since files change)
        let artifactContext = '';
        let taskPlanContent = '';
        const isAgentSession = toolExecutor.isSessionActive ? toolExecutor.isSessionActive() : false;
        if (isAgentSession) {
            try {
                const artifactDir = toolExecutor.getSessionArtifactDir(workspacePath);
                const files = await invoke('read_dir', { path: artifactDir });
                if (files && files.length > 0) {
                    const otherArtifacts = [];
                    for (const file of files) {
                        if (!file.name.endsWith('.md')) continue;
                        let data;
                        try {
                            data = await invoke('read_file', { path: `${artifactDir}/${file.name}` });
                        } catch (_) { continue; }

                        if (file.name === 'task_plan.md' || file.name.toLowerCase() === 'task_plan.md') {
                            taskPlanContent = data;
                        } else {
                            otherArtifacts.push({ name: file.name, content: data });
                        }
                    }
                    if (otherArtifacts.length > 0) {
                        artifactContext = '<artifacts>\n';
                        for (const a of otherArtifacts) {
                            artifactContext += `<artifact name="${a.name}">\n<![CDATA[\n${a.content}\n]]>\n</artifact>\n`;
                        }
                        artifactContext += '</artifacts>\n';

                        const artifactTokens = tokenEstimator.estimateTokens(artifactContext);
                        if (artifactTokens > Math.floor(systemBudget * 0.15)) {
                            artifactContext = tokenEstimator.trimToFit(artifactContext, Math.floor(systemBudget * 0.15));
                        }
                    }
                }
            } catch (e) { }
        }

        // ── Static Prefix (cached per session) ────────────────────────────
        // Reading config is needed for outputLanguage (part of cache key).
        // Persona file read is skipped on cache hits — the main disk IO saving.
        const config = await invoke('get_ai_config');
        const outputLanguage = config.output_language || 'Japanese';
        // Use the single source-of-truth in LLMService rather than duplicating the
        // provider allowlist here.  This guarantees ContextBuilder and AgentController
        // always agree on which calling mode is in effect.
        const isNative = llmService.supportsNativeTools();
        const cacheKey = `${root}|${currentModel}|${outputLanguage}|${isNative}`;

        let staticPrefix;
        if (this._staticCache?.key === cacheKey) {
            staticPrefix = this._staticCache.prefix;
        } else {
            let agentPersona = `You are an elite autonomous software engineer integrated into J.H AI Agent.
You explore codebases, edit files, search, and run commands using the provided tools.
Act decisively: prefer doing the work over lengthy introspection. Verify after every change. When something fails, deduce the root cause and self-correct.
IMPORTANT: Final responses to the USER must be in ${outputLanguage}. Internal reasoning may be in any language.`;

            try {
                const personaPath = `${root}/.agent/agents/default.md`;
                const fileData = await invoke('read_file', { path: personaPath });
                if (fileData) {
                    agentPersona = fileData;
                }
            } catch (e) {}

            const toolDefs = toolExecutor.toolDefinitions.map(t => `<tool name="${t.name}">\n<description>${t.description}</description>\n</tool>`).join('\n');

            // ── Protocol section ─────────────────────────────────────────
            let instructionsPrompt = '';
            if (isNative) {
                instructionsPrompt = `
<protocol>
Use the provided native tool-calling mechanism (function calls) to invoke tools.
Before EVERY function call, output a short reasoning preamble as plain text:

OBSERVE: [One sentence: what the previous result showed, or the current state]
PLAN: [One sentence: what you will do next and why]

Then immediately invoke the function via the tool-calling API.
Do NOT write "CALL: <tool_name>" — that is NOT a function call.
The actual invocation must go through the function-call mechanism, not as text.

Example:
OBSERVE: The export statement is missing from utils.js after the helper definition.
PLAN: Insert it using multi_replace_file_content (content-based) so the rest of the file is untouched.
[function call: multi_replace_file_content(...)]
</protocol>
`;
            } else {
                instructionsPrompt = ContextBuilder.getJsonModeProtocol();
            }

            staticPrefix = `
<system_role>
${agentPersona}
</system_role>

<available_tools>
${toolDefs}
</available_tools>

${instructionsPrompt}

<task_completion>
The ONLY way to end a task is to call \`finish_task\` explicitly.
Text-only replies (no tool call) will cause the system to ask you to continue —
they are never treated as completion.

Call \`finish_task\` when ALL of these are true:
  ✓ The user's stated goal is fully achieved.
  ✓ Every file you edited has been verified (read back / syntax-checked / tested).
  ✓ No syntax errors or broken structure remain in any file you touched.
  ✓ If a follow-up message arrived from the user, the new request is also addressed.
</task_completion>

<critical_rules>

1. **Verify After Every Edit (MANDATORY)**:
   - After \`write_file\` / \`multi_replace_file_content\`, the tool result includes the file's
     new content. Inspect it. If chars are missing, structure is broken, or it doesn't match
     what you intended — fix immediately with another edit. NEVER assume the edit succeeded.
   - For .js / .ts / .jsx / .tsx / .json files, ALSO call \`verify_syntax\` right after the edit
     and fix any reported errors BEFORE doing anything else.

2. **Tool Choice for Edits**:
   - Create new / fully rewrite: \`write_file\`.
   - Modify existing: \`multi_replace_file_content\` (CONTENT-BASED — see rules below).
   - NEVER use \`run_command\` with shell redirects (\`echo > file\`, \`Set-Content\`, \`sed\`) —
     they cause encoding corruption and silent breakage.
   - If multi_replace on a long file fails twice in a row, switch to \`write_file\` with full new content.
   - **File Encoding**: \`write_file\` automatically preserves the existing file's charset (UTF-8, Shift-JIS,
     EUC-JP, UTF-16, etc.). To force a specific encoding, pass \`"encoding": "shift-jis"\` (or
     \`"utf-8"\`, \`"euc-jp"\`, \`"utf-16le"\`). \`read_file\` always returns UTF-8 regardless of the
     original charset — you never need to worry about encoding when reading.

   **How \`multi_replace_file_content\` works (content-based, NOT line-based):**
   - Each replacement is \`{ old_text, new_text }\`. The tool searches for \`old_text\` as a
     LITERAL string in the file. There are NO line numbers — never pass start_line/end_line.
   - **KEEP old_text SHORT.** Prefer ONE line that contains a unique identifier (a function
     name, variable, prop, etc.) over a large multi-line block. You can reproduce one line
     exactly; reproducing 5+ lines character-for-character is error-prone and the #1 cause of
     "not found" failures. Only add extra context lines when a single line isn't unique.
     Example — to delete an \`onNodeDrag={handleNodeDrag}\` JSX prop, use old_text
     \`"                onNodeDrag={handleNodeDrag}\\n"\` (that one line), NOT the whole \`<ReactFlow>\` block.
   - **Line endings are TOLERANT** — CRLF (Windows) and LF are treated as equivalent.
     Always write \`\\n\` in your \`old_text\` and \`new_text\`; the tool normalizes both sides
     to LF for matching and restores the file's original line ending on write-back.
     **Do NOT include \`\\r\` in your strings** — it is unnecessary and harder to type correctly.
   - **Whitespace is STRICT** — tabs vs spaces, trailing whitespace, and indentation
     amount must match the file exactly. (Everything except line endings.)
   - **CRITICAL when copying from read_file output:** \`read_file\` returns each line as
     \`<lineno>\\t<content>\`. The line number + tab is DISPLAY-ONLY — it is NOT part of the
     file content. Strip it before putting the text into \`old_text\`. If you accidentally
     include \`42\\t\` at the start of your \`old_text\`, the match will fail with "not found".
   - **When you get a "not found" error:** the tool now returns a "Closest matching region"
     with the file's actual content for that area, plus a whitespace-visualized diff
     (\`·\` = space, \`→\` = tab). USE THAT BLOCK as your next \`old_text\` — do NOT guess again.
   - **After 3 consecutive failures on the same file**, the tool auto-clears its cache,
     re-reads the file, and surfaces the fresh content in the error. Use that content
     directly; do not call \`read_file\` again right after — you already have it.
   - Required uniqueness: \`old_text\` must appear EXACTLY ONCE in the file.
       • 0 matches → error "not found"  (file changed since you read it, or whitespace differs)
       • 2+ matches → error "matches N times"  (include 3-5 more lines of surrounding context
         to disambiguate, or set \`"replace_all": true\` if you intend to update every occurrence)
   - Replacements apply IN ORDER. After replacement #1 runs, the file content changes,
     so replacement #2's \`old_text\` must match the file AS-IT-IS-AFTER-#1.
   - To delete a region: pass \`"new_text": ""\`.
   - To rename a symbol across the file: one replacement with \`"replace_all": true\`.
   - If you get a "not found" error, the most likely cause is stale content in your memory —
     call \`read_file\` to refresh, then retry with the exact text you just saw.

3. **File Paths (Windows-safe)**:
   - **Always use forward slashes** (\`/\`) in paths, even on Windows. Never write
     backslashes (\`\\\\\` or \`\\\`) — they cause JSON-escape mistakes that mangle the
     path. Correct: \`C:/projects/app/src/file.tsx\`. Wrong: \`C:\\\\projects\\\\app\\\\src\\\\file.tsx\`.
   - **Relative paths** (without a drive letter or leading slash) are resolved against
     the workspace root. Prefer relative paths when the file is inside the workspace.
   - **When read_file returns "not found"** the error includes "Did you mean?" suggestions
     from the parent directory — pick from those instead of guessing again. Common cause:
     extension typo (\`.ts\` vs \`.tsx\`, \`.js\` vs \`.jsx\`).

4. **Anti-Loop / Anti-Re-Read**:
   - DO NOT read the same file more than twice in one session unless it has been edited.
   - The contents of \`task_plan.md\` (if it exists) is automatically embedded in the
     <task_plan> section below — DO NOT re-read it via \`read_file\`.
   - If your last 3 actions feel like repeats of earlier ones, STOP and try a different angle.
   - If you've made >5 edits to the same file in this session, STOP and reassess whether
     a single \`write_file\` rewrite would be cleaner.

5. **Use task_progress for Multi-Step Tasks (MANDATORY)**:
   - For ANY task requiring 3 or more distinct actions (edits, commands, searches across files),
     your FIRST tool call MUST be \`task_progress(action="set", items=[...])\` to register subtasks.
   - As you complete each subtask, update with \`action="update"\`. Do NOT rely on conversation
     history to remember what's done (it gets compacted).
   - When uncertain "have I finished step N?", call \`task_progress\` (action="get"),
     NOT \`read_file\` on task_plan.md.
   - **Skip only for single-action tasks** (e.g. "read file X and report", "run one command").

6. **If You Broke Something, Fix It Now**:
   - You introduced a syntax error → fix it immediately, do not move to other work.
   - Do not call \`finish_task\` while ANY file you edited has syntax errors.

7. **Stuck? Ask, Don't Spin**:
   - If 3 different approaches all failed for the same subproblem, STOP.
   - Summarize what you tried, what failed, and ASK the user for guidance.
   - It's better to wait for clarification than to keep grinding.

8. **Language**:
   - User-facing replies and status messages: ${outputLanguage}.
   - Plans / artifacts / code / commit messages: English.

9. **Continue After User Follow-up**:
   - If the user sends a new message after a task was declared complete, do NOT
     immediately call \`finish_task\` again. The new message is proof the task isn't done —
     re-examine, fix, verify, then call \`finish_task\` only when the new goal is met.

</critical_rules>
`;

            this._staticCache = { key: cacheKey, prefix: staticPrefix };
        }

        // ══════════════════════════════════════════════════════════════
        // Assemble full system prompt:
        //   Static prefix (cached) → Semi-static → Dynamic suffix
        // Order maximizes LLM prefix caching (Gemini, Anthropic, OpenAI)
        // ══════════════════════════════════════════════════════════════
        let systemPrompt = staticPrefix;

        // ── Semi-Static (changes per session, not per request) ──
        systemPrompt += `
<environment>
<project_root>${root}</project_root>
<model_limit_tokens>${modelLimit.toLocaleString()}</model_limit_tokens>
</environment>

<project_summary>
${projectInfo}
</project_summary>
`;

        // task_plan.md gets its own highlighted section so the agent doesn't
        // re-read it after compaction. Placed semi-statically (session-level,
        // not per-request) so prefix caching still benefits but the agent
        // always sees the current plan inline.
        if (taskPlanContent) {
            // Budget at most 20% of system prompt for the plan (it can grow as the
            // agent updates checklists; trim if it gets out of hand).
            let planBody = taskPlanContent;
            const planBudget = Math.floor(systemBudget * 0.2);
            const planTokens = tokenEstimator.estimateTokens(planBody);
            if (planTokens > planBudget) {
                planBody = tokenEstimator.trimToFit(planBody, planBudget);
            }
            systemPrompt += `
<task_plan source="artifact:task_plan.md">
<!-- IMPORTANT: This is the FULL current task_plan.md. Do NOT call read_file on it —
     it is already provided here in every prompt. Use the task_progress tool to mark
     items complete; do NOT mutate this artifact directly to track checkbox state. -->
<![CDATA[
${planBody}
]]>
</task_plan>
`;
        }

        if (kisContext) {
            systemPrompt += `\n<knowledge_items>\n${kisContext}\n</knowledge_items>\n`;
        }

        // ── Dynamic Suffix (changes every request, ordered least→most volatile) ──
        if (workflowContext) {
            systemPrompt += `\n${workflowContext}\n`;
        }

        if (memoryContext) {
            systemPrompt += `\n${memoryContext}\n`;
        }

        if (artifactContext) {
            systemPrompt += `\n${artifactContext}\n`;
        }

        if (editContext) {
            systemPrompt += `\n<user_selected_context>\n<![CDATA[\n${editContext}\n]]>\n</user_selected_context>\n`;
        }

        if (activeContext) {
            systemPrompt += `\n${activeContext}\n`;
        }

        return systemPrompt;
    }
}

export const contextBuilder = new ContextBuilder();
export { ContextBuilder };
