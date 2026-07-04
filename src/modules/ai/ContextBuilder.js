import { invoke } from '@tauri-apps/api/core';
import { projectContext } from './ProjectContext.js';
import { conversationMemory } from './ConversationMemory.js';
import { tokenEstimator } from './TokenEstimator.js';
import llmService from './LLMService.js';

class ContextBuilder {
    // Sentinel separating the STABLE (cacheable) system prefix from the VOLATILE
    // (per-turn-changing) suffix. The Rust layer (ai.rs) splits the system prompt
    // on this marker: the prefix becomes an Anthropic `cache_control` text block
    // (billed at ~10% on cache hits), the suffix is sent uncached. Non-Anthropic
    // providers strip the marker. Keep in sync with SYS_CACHE_BREAK in ai.rs.
    static SYSTEM_CACHE_BREAK = '<<<JHAI_SYSTEM_CACHE_BREAK>>>';

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

Put a brief line of reasoning in the "thought" field, then the tool call(s):

\`\`\`json
{
  "thought": "Add the missing export with multi_replace to keep the edit minimal.",
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

    async getSystemPrompt(workspacePath, toolExecutor, clientContext = null, editContext = null, kisContext = '', currentQuery = '') {
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
        // Heavy (file-editing agent) vs lightweight (scoped / app-intent) prompt.
        // If the active built-in allowlist contains NO editing/exec tools, the task
        // can't edit files at all, so the multi_replace/verify/path/anti-loop rules
        // are pure waste — emit a slim persona + slim rules instead. Normal agent
        // tasks (unrestricted allowlist) keep the full heavy prompt unchanged.
        const EDITING_TOOLS = new Set([
            'write_file', 'multi_replace_file_content', 'replace_lines',
            'delete_file', 'move_file', 'create_dir', 'run_command',
        ]);
        const activeBuiltinNames = toolExecutor.getActiveToolDefinitions().map(t => t.name);
        const editingMode = activeBuiltinNames.some(n => EDITING_TOOLS.has(n));
        const cacheKey = `${root}|${currentModel}|${outputLanguage}|${isNative}|${editingMode ? 'edit' : 'lite'}`;

        let staticPrefix;
        if (this._staticCache?.key === cacheKey) {
            staticPrefix = this._staticCache.prefix;
        } else {
            let agentPersona = editingMode
                ? `You are an elite autonomous software engineer integrated into J.H AI Agent.
You explore codebases, edit files, search, and run commands using the provided tools.
Act decisively: prefer doing the work over lengthy introspection. Verify after every change. When something fails, deduce the root cause and self-correct.
IMPORTANT: Final responses to the USER must be in ${outputLanguage}. Internal reasoning may be in any language.`
                : `You are a helpful AI assistant embedded in J.H AI Agent, acting as a tool-using assistant for an integrated application.
Use the provided tools to obtain what you need, then deliver a clear, well-structured result.
IMPORTANT: Final responses to the USER must be in ${outputLanguage}. Internal reasoning may be in any language.`;

            // The .agent/agents/default.md override IS the heavy software-engineer
            // persona — only honor it in editing mode (it would re-bloat lite tasks).
            if (editingMode) {
                try {
                    const personaPath = `${root}/.agent/agents/default.md`;
                    const fileData = await invoke('read_file', { path: personaPath });
                    if (fileData) {
                        agentPersona = fileData;
                    }
                } catch (e) {}
            }

            // In NATIVE mode the tool schemas are sent in the API `tools` field
            // (authoritative) — listing them again here would duplicate them AND be
            // billed as extra input tokens. So native mode gets only a short pointer;
            // JSON mode needs the full textual listing (no native tools array).
            // Build from getToolsForNativeAPI() so the listing respects the
            // per-task allowlist + MCP server filter AND includes enabled MCP
            // tools (e.g. an app's get_buffer). Listing every built-in here —
            // including ones the allowlist blocks — makes the agent try blocked
            // tools and stall on "not enabled for this task".
            const toolDefs = toolExecutor.getToolsForNativeAPI()
                .map(t => `<tool name="${t.function.name}">\n<description>${t.function.description}</description>\n</tool>`)
                .join('\n');
            const toolsSection = isNative
                ? `Tool schemas are provided to you via the native function-calling API (the request's \`tools\` field) — invoke them directly. Built-in + any enabled MCP tools are all available there.`
                : toolDefs;

            // ── Protocol section ─────────────────────────────────────────
            let instructionsPrompt = '';
            if (isNative) {
                instructionsPrompt = `
<protocol>
Invoke tools through the native function-calling mechanism. Reason as much as you
need before acting, but keep any out-loud reasoning brief. Do NOT write the call as
text (e.g. "CALL: read_file") — always use the actual function-call API.
</protocol>
`;
            } else {
                instructionsPrompt = ContextBuilder.getJsonModeProtocol();
            }

            if (!editingMode) {
                // ── Lightweight prompt for scoped / app-intent tasks ──────────
                staticPrefix = `
<system_role>
${agentPersona}
</system_role>

<available_tools>
${toolsSection}
</available_tools>

${instructionsPrompt}

<task_completion>
A task ends in exactly one of two ways — a text-only reply is never treated as completion:
- \`finish_task\` — when the user's request is fully addressed (deliver the result via \`present_result\` first when a result kind is expected).
- \`ask_user\` — when you genuinely CANNOT proceed without input only the user can give (ambiguous requirement, a missing decision, or attached content the current model can't read). This pauses the run and waits for their reply. Do NOT use it to report progress; prefer a reasonable assumption when you can.

For a LARGE or AMBIGUOUS request, you MAY briefly state your intended approach and call \`ask_user\` to confirm the direction before doing extensive work — optional, and best used when a wrong assumption would be costly to undo. Otherwise proceed with a reasonable approach.
</task_completion>

<critical_rules>
1. **Deliver the result**: when you have the answer, call \`present_result\` with the requested kind (e.g. markdown / answer / table), then \`finish_task\`.
2. **Use tools, don't guess**: call the provided tools (e.g. \`get_buffer\`) to obtain real content rather than assuming it.
3. **Avoid loops**: if repeated tool calls don't make progress, stop and deliver a best-effort result, or call \`ask_user\` with a clarifying question (do NOT keep re-investigating the same thing).
4. **Language**: user-facing output in ${outputLanguage}.
</critical_rules>
`;
            } else {
            staticPrefix = `
<system_role>
${agentPersona}
</system_role>

<available_tools>
${toolsSection}
</available_tools>

${instructionsPrompt}

<task_completion>
A task ends ONLY by calling \`finish_task\` (goal achieved) or \`ask_user\` (blocked on
input only the user can give). Text-only replies (no tool call) will cause the system to
ask you to continue — they are never treated as completion. If you find yourself wanting
to "wait for the user" or "confirm with the user", call \`ask_user\` — never just emit text.

For a LARGE or AMBIGUOUS request, you MAY briefly propose your intended approach and call
\`ask_user\` to confirm the direction before doing extensive work — optional, best used when a
wrong assumption would be costly to undo. Otherwise proceed with a sensible approach.

Call \`finish_task\` when ALL of these are true:
  ✓ The user's stated goal is fully achieved.
  ✓ Every file you edited has been verified (read back / syntax-checked / tested).
  ✓ No syntax errors or broken structure remain in any file you touched.
  ✓ If a follow-up message arrived from the user, the new request is also addressed.
</task_completion>

<critical_rules>

1. **Verify After Every Edit (MANDATORY)**:
   - After \`write_file\` / \`multi_replace_file_content\`, the tool result includes the file's
     new content. Inspect it. If chars are missing or structure is broken, fix immediately —
     NEVER assume the edit succeeded.
   - For plain .js / .mjs / .cjs / .json files, call \`verify_syntax\` after the edit.
     For .jsx / .tsx / .ts, \`verify_syntax\` is NOT reliable (node can't parse JSX/TS) —
     verify those with the project's own build instead, e.g. run_command("npx vite build").
   - If you introduced a syntax error, fix it NOW before any other work.

2. **Tool Choice for Edits**:
   - Create a new file → \`write_file\`. Small targeted change → \`multi_replace_file_content\`
     (content-based, the default). Large/awkward contiguous block, or after multi_replace
     keeps failing → \`replace_lines\` (line-based; read_file first). Detailed mechanics for each
     live in the tool's own \`description\` — follow them there; keep \`old_text\` SHORT and exact.
   - If multi_replace on a long file fails twice in a row, switch to \`replace_lines\` — do NOT
     fall back to a full \`write_file\` rewrite (full rewrites of big files drop content).
   - NEVER use \`run_command\` with shell redirects (\`echo > file\`, \`Set-Content\`, \`sed\`) — they
     corrupt encoding. \`write_file\` preserves the file's charset automatically (override with
     \`"encoding"\`); \`read_file\` always returns UTF-8.

3. **File Paths (Windows-safe)**:
   - **Always use forward slashes** (\`/\`), even on Windows — backslashes cause JSON-escape
     mistakes. Correct: \`C:/projects/app/src/file.tsx\`. Relative paths resolve against the
     workspace root (prefer them inside the workspace).
   - On a read_file "not found", use the error's "Did you mean?" suggestions (often an
     extension typo: \`.ts\` vs \`.tsx\`) rather than guessing again.

4. **Don't spin**: avoid re-reading an unchanged file or repeating an action that
   didn't make progress — change approach instead. \`task_plan.md\` is auto-embedded
   in the <task_plan> section below, so read it there, not via \`read_file\`.

5. **Track multi-step work (recommended)**: for a task with several distinct steps,
   \`task_progress\` helps you keep state across history compaction — register the
   subtasks and update them as you go. Optional, but useful on longer tasks.

6. **Stuck? Ask, Don't Spin**:
   - If 3 different approaches all failed for the same subproblem, STOP and call \`ask_user\`
     with what you tried, what failed, and the guidance you need. This pauses the run cleanly
     (not a completion). Better to ask than to re-run the same investigation hoping for a
     different result.

7. **Language**:
   - User-facing replies and status messages: ${outputLanguage}.
   - Plans / artifacts / code / commit messages: English.

8. **Continue After User Follow-up**:
   - If the user sends a new message after a task was declared complete, do NOT immediately
     call \`finish_task\` again — the new message means it isn't done. Re-examine, fix, verify,
     then finish only when the new goal is met.

</critical_rules>
`;
            }

            this._staticCache = { key: cacheKey, prefix: staticPrefix };
        }

        // ══════════════════════════════════════════════════════════════
        // Assemble the system prompt in TWO regions split by SYSTEM_CACHE_BREAK:
        //
        //   STABLE region (before the sentinel) → cached on Anthropic
        //     Byte-identical across every step of a run: persona/tools/rules,
        //     environment, project summary, KIs, long-term memory (ranked by the
        //     run-constant query), user-selected + active-file context.
        //
        //   VOLATILE region (after the sentinel) → sent uncached
        //     Changes during the run: task_plan (mutated by task_progress),
        //     workflow phase, artifacts (written by the agent). Keeping these
        //     OUT of the cached prefix is what lets the big static block — and
        //     the conversation history — stay cache-hits step after step.
        //
        // ai.rs splits on the sentinel; non-Anthropic providers strip it.
        // ══════════════════════════════════════════════════════════════
        let stablePart = staticPrefix;

        // ── Semi-Static (changes per session, not per request) ──
        stablePart += `
<environment>
<project_root>${root}</project_root>
<model_limit_tokens>${modelLimit.toLocaleString()}</model_limit_tokens>
</environment>

<project_summary>
${projectInfo}
</project_summary>
`;

        if (kisContext) {
            stablePart += `\n<knowledge_items>\n${kisContext}\n</knowledge_items>\n`;
        }

        // Long-term memory is ranked against currentQuery, which is constant for
        // the whole run — so it's stable and cacheable.
        if (memoryContext) {
            stablePart += `\n${memoryContext}\n`;
        }

        if (editContext) {
            stablePart += `\n<user_selected_context>\n<![CDATA[\n${editContext}\n]]>\n</user_selected_context>\n`;
        }

        if (activeContext) {
            stablePart += `\n${activeContext}\n`;
        }

        // ── Volatile region (per-turn changing — kept uncached) ──
        let volatilePart = '';

        // task_plan.md gets its own highlighted section so the agent doesn't
        // re-read it after compaction. It mutates as the agent updates the
        // checklist, so it lives in the volatile (uncached) region.
        if (taskPlanContent) {
            // Budget at most 20% of system prompt for the plan (it can grow as the
            // agent updates checklists; trim if it gets out of hand).
            let planBody = taskPlanContent;
            const planBudget = Math.floor(systemBudget * 0.2);
            const planTokens = tokenEstimator.estimateTokens(planBody);
            if (planTokens > planBudget) {
                planBody = tokenEstimator.trimToFit(planBody, planBudget);
            }
            volatilePart += `
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

        if (artifactContext) {
            volatilePart += `\n${artifactContext}\n`;
        }

        // Only emit the sentinel when there's a volatile region to separate;
        // otherwise the whole prompt is the cacheable prefix.
        return volatilePart.trim()
            ? `${stablePart}${ContextBuilder.SYSTEM_CACHE_BREAK}\n${volatilePart}`
            : stablePart;
    }
}

export const contextBuilder = new ContextBuilder();
export { ContextBuilder };
