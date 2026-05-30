/**
 * AgentModes — Central definition of agent execution modes.
 *
 * Each mode provides a `behavior` object that is merged into the task's
 * behaviorOverrides (AgentController) or sent as the `behavior` field in
 * the POST /api/tasks body.
 *
 * Fields (all optional):
 *   system_prompt      — fully replaces ContextBuilder's output when set
 *   extra_instructions — appended after the system prompt
 *   enabled_tools      — array of allowed tool names (null = all tools)
 *   max_iterations     — step limit override (0 = unlimited)
 */

export const AGENT_MODES = {
    developer: {
        id: 'developer',
        label: '💻 Developer',
        description: 'コード編集・ファイル操作に特化。検証ルールあり',
        behavior: {
            // No overrides — ContextBuilder's default "elite software engineer" is used
        }
    },

    researcher: {
        id: 'researcher',
        label: '🔍 Researcher',
        description: 'Web調査・レポート作成。fetch_urlを活用',
        behavior: {
            system_prompt: `You are an expert research analyst. Your job is to gather information, synthesize findings, and produce clear written reports.

Workflow:
1. Use fetch_url to retrieve relevant web pages or APIs.
2. Extract and summarize the key information.
3. Use write_file to save the final report to the requested location.
4. Call finish_task with a brief summary.

Rules:
- Do NOT try to edit or compile code — that is not your role.
- If a URL returns HTML, parse only the text content you need; do not dump raw HTML into your report.
- Write reports in Japanese unless the user explicitly requests another language.
- Always call finish_task when the report is saved.`,
            enabled_tools: ['fetch_url', 'read_file', 'write_file', 'list_files', 'run_command', 'task_progress', 'finish_task'],
            max_iterations: 30
        }
    },

    analyst: {
        id: 'analyst',
        label: '📊 Analyst',
        description: 'データ分析・集計・スプレッドシート処理',
        behavior: {
            system_prompt: `You are a skilled data analyst. Your job is to read data files, perform calculations or aggregations, and produce structured output (tables, summaries, CSV, JSON).

Workflow:
1. Read the source data files with read_file or list_files.
2. Use run_command to invoke Python / Node scripts for heavy computation when needed.
3. Write the results to the requested output path with write_file.
4. Call finish_task with a summary of findings.

Rules:
- Prefer structured output (JSON, CSV, Markdown tables) over prose.
- Verify numeric results for obvious outliers before saving.
- Write responses and reports in Japanese unless asked otherwise.`,
            enabled_tools: ['read_file', 'write_file', 'list_files', 'glob', 'grep_search', 'run_command', 'task_progress', 'finish_task'],
            max_iterations: 40
        }
    },

    assistant: {
        id: 'assistant',
        label: '💬 Assistant',
        description: '一般的な質問・文書作成・軽量タスク',
        behavior: {
            system_prompt: `You are a helpful, concise AI assistant. Answer questions, write documents, and help with general tasks.

Rules:
- Give direct, practical answers. Avoid unnecessary filler.
- If file output is requested, use write_file to save it.
- Respond in Japanese unless the user writes in another language.
- Call finish_task when the requested work is complete.`,
            enabled_tools: ['write_file', 'read_file', 'list_files', 'fetch_url', 'task_progress', 'finish_task'],
            max_iterations: 20
        }
    },

    automation: {
        id: 'automation',
        label: '⚙️ Automation',
        description: 'コマンド実行・システム操作・バッチ処理',
        behavior: {
            system_prompt: `You are a system automation engineer. Your job is to execute shell commands, manage files, and run batch operations reliably.

Workflow:
1. Plan the sequence of operations using task_progress.
2. Execute each step with run_command or file tools.
3. Verify each step succeeded before proceeding to the next.
4. Call finish_task with a summary of what was executed.

Rules:
- Always set safe_to_auto_run=true only for clearly read-only commands.
- For destructive operations (delete, overwrite, move), verify the path first.
- Respond in Japanese unless asked otherwise.`,
            enabled_tools: ['run_command', 'read_file', 'write_file', 'list_files', 'glob', 'grep_search', 'move_file', 'delete_file', 'task_progress', 'finish_task'],
            max_iterations: 50
        }
    }
};

export const DEFAULT_MODE_ID = 'developer';

/** Returns the behavior object for a given mode ID. Falls back to developer. */
export function getBehaviorForMode(modeId) {
    const mode = AGENT_MODES[modeId] || AGENT_MODES[DEFAULT_MODE_ID];
    return mode.behavior;
}

/** Merges a mode's behavior with any additional overrides. */
export function buildBehavior(modeId, extraOverrides = {}) {
    const base = getBehaviorForMode(modeId);
    const merged = { ...base, ...extraOverrides };
    // Merge system_prompt: if extraOverrides has system_prompt, it wins
    return merged;
}
