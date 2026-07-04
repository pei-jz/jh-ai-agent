// toolSchemas — the agent's built-in tool definitions (pure static data).
//
// Extracted verbatim from ToolExecutor (Part A refactor) so the large schema
// block lives apart from the executor's runtime logic. These objects contain no
// `this`/runtime references; ToolExecutor consumes them read-only (filter / find
// / map) and never mutates the array. MCP tools are appended separately at call
// time, not here.
//
// Shape per entry:
//   { name, isSafe?, description, parameters: <JSON-Schema> }
// `isSafe` marks tools that never need user confirmation (read-only / planning).

export const TOOL_DEFINITIONS = [
    {
        name: 'list_files',
        isSafe: true,
        description: 'List files and subdirectories directly under the specified directory path.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path to list (. for project root)' }
            },
            required: ['path'],
            additionalProperties: false
        }
    },
    {
        name: 'read_file',
        isSafe: true,
        description: 'Read the content of a file as a UTF-8 text string. By default returns up to 2000 lines from the start. Use offset (1-indexed start line) and limit (max lines) for partial reads of large files. The result is prefixed with line numbers in `<lineno>\\t<content>` format for easy reference — these line numbers are display-only and must NEVER be included in multi_replace_file_content\'s old_text (use only the content after the tab).',
        parameters: {
            type: 'object',
            properties: {
                path:   { type: 'string',  description: 'Path of the file to read' },
                offset: { type: ['integer', 'null'], description: 'Optional (null to omit). 1-indexed starting line number (default 1). Use to skip past content you already have.' },
                limit:  { type: ['integer', 'null'], description: 'Optional (null to omit). Maximum number of lines to return (default 2000). Increase for files where you need the whole content.' }
            },
            required: ['path', 'offset', 'limit'],
            additionalProperties: false
        }
    },
    {
        name: 'grep_search',
        isSafe: true,
        description: 'Recursively search for a regex pattern across files (respects .gitignore). Returns matching lines with file path and line number. Use this INSTEAD of read_file when you want to find where something is defined/used — it is dramatically cheaper than reading every file.',
        parameters: {
            type: 'object',
            properties: {
                pattern:          { type: 'string',  description: 'Rust regex pattern (e.g. "function\\s+foo", "TODO|FIXME"). Special characters must be escaped.' },
                path:             { type: ['string', 'null'],  description: 'Optional (null to omit). Root directory to search. Defaults to workspace root.' },
                include_glob:     { type: ['string', 'null'],  description: 'Optional (null to omit). Limit search to files matching this glob (e.g. "*.{js,ts}", "src/**/*.rs"). Comma-separate multiple patterns.' },
                case_insensitive: { type: ['boolean', 'null'], description: 'Optional (null to omit). Default false.' },
                max_results:      { type: ['integer', 'null'], description: 'Optional (null to omit). Max matches to return (default 200, hard cap 2000).' },
                context_lines:    { type: ['integer', 'null'], description: 'Optional (null to omit). Lines of context above/below each match (default 0, max 5).' }
            },
            required: ['pattern', 'path', 'include_glob', 'case_insensitive', 'max_results', 'context_lines'],
            additionalProperties: false
        }
    },
    {
        name: 'glob',
        isSafe: true,
        description: 'Find files whose path matches a glob pattern (respects .gitignore). Use ** for any directories, * for any chars within one segment. Examples: "**/*.test.js", "src/**/*.{ts,tsx}", "**/README*".',
        parameters: {
            type: 'object',
            properties: {
                pattern:     { type: 'string',  description: 'Glob pattern.' },
                path:        { type: ['string', 'null'],  description: 'Optional (null to omit). Root directory to search. Defaults to workspace root.' },
                max_results: { type: ['integer', 'null'], description: 'Optional (null to omit). Max files to return (default 500, hard cap 5000).' }
            },
            required: ['pattern', 'path', 'max_results'],
            additionalProperties: false
        }
    },
    {
        name: 'delete_file',
        isSafe: false,
        description: 'Delete a single file. Refuses to delete directories. Asks the user to confirm unless inside the workspace root.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to delete' }
            },
            required: ['path'],
            additionalProperties: false
        }
    },
    {
        name: 'move_file',
        isSafe: false,
        description: 'Rename or move a file/directory. Creates any missing parent directories. Will not overwrite an existing destination unless overwrite=true.',
        parameters: {
            type: 'object',
            properties: {
                from:      { type: 'string',  description: 'Source path' },
                to:        { type: 'string',  description: 'Destination path' },
                overwrite: { type: ['boolean', 'null'], description: 'Optional (null to omit). If true, replace an existing destination. Default false.' }
            },
            required: ['from', 'to', 'overwrite'],
            additionalProperties: false
        }
    },
    {
        name: 'write_file',
        isSafe: false,
        description: 'WHEN TO USE: choose this ONLY for (a) creating a brand-new file, or (b) fully replacing a file whose complete intended content you have. To edit PART of an existing file, use multi_replace_file_content (precise spans) or replace_lines (a large contiguous block) — NOT this. Create a new file or completely overwrite an existing file. The existing file\'s charset encoding is automatically preserved. SAFETY: (1) if the file already exists but was not read in this session, the call is BLOCKED unless overwrite_unread=true. (2) overwriting a LARGE existing file (full rewrite) is BLOCKED — full rewrites of big files routinely drop content (truncation); use multi_replace_file_content for targeted edits, or pass allow_full_overwrite=true only when you truly have the complete new file content. For partial edits, ALWAYS prefer multi_replace_file_content.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to write' },
                content: { type: 'string', description: 'Entire content to write to the file' },
                encoding: { type: ['string', 'null'], description: 'Optional (null to omit) charset override: "utf-8" (default), "shift-jis", "euc-jp", "utf-16le", "utf-16be". If null, the existing file\'s encoding is preserved.' },
                overwrite_unread: { type: ['boolean', 'null'], description: 'Optional (null to omit). Set true to overwrite a pre-existing file that has NOT been read with read_file in this session. Default false — protects you from clobbering a file you don\'t know the contents of.' },
                allow_full_overwrite: { type: ['boolean', 'null'], description: 'Optional (null to omit). Set true ONLY to fully replace a LARGE existing file when you genuinely have its complete intended content. Leave null/false for partial edits — those must use multi_replace_file_content instead (full rewrites of big files risk dropping content).' }
            },
            required: ['path', 'content', 'encoding', 'overwrite_unread', 'allow_full_overwrite'],
            additionalProperties: false
        }
    },
    {
        name: 'run_command',
        isSafe: false,
        description: 'Execute a shell command for builds, tests, or system checks. Runs in the workspace root by default; pass cwd to run in a subdirectory (e.g. a monorepo package). Defaults to a 60-second timeout; set timeout_ms for longer operations.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command string to run in the shell (e.g., "npm run test", "cargo check")' },
                cwd: { type: ['string', 'null'], description: 'Optional (null to omit) working directory for the command. Relative paths resolve against the workspace root (e.g. "packages/api"); absolute paths must stay inside an allowed root. Defaults to the workspace root.' },
                safe_to_auto_run: { type: ['boolean', 'null'], description: 'Optional (null to omit). Set true if command is safe and has no side-effects. Skips user confirmation.' },
                timeout_ms: { type: ['number', 'null'], description: 'Optional (null to omit). Timeout in milliseconds (default: 60000). Increase for long-running builds (e.g., 120000 for 2 minutes).' }
            },
            required: ['command', 'cwd', 'safe_to_auto_run', 'timeout_ms'],
            additionalProperties: false
        }
    },
    {
        name: 'multi_replace_file_content',
        description: 'WHEN TO USE: this is the DEFAULT tool for editing an existing file — use it to change one or more specific text spans you can quote exactly. Prefer it over write_file for any partial edit. Switch to replace_lines when the region is a large/awkward contiguous block that is error-prone to retype, or when this tool keeps failing to match. Apply one or more content-based search-and-replace edits to an existing file. Each replacement provides the exact original text (old_text) and its replacement (new_text); old_text MUST match EXACTLY once in the file. BEST PRACTICE: keep old_text SHORT — ideally ONE line containing a unique identifier (plus a few words of context only if needed for uniqueness). Short exact anchors succeed far more often than large multi-line blocks, which are easy to mis-transcribe. To disambiguate when a line repeats, add the minimum extra context to make it unique. Set replace_all=true to update every occurrence (useful for renames). Line numbers are NEVER used — only literal string matching. IMPORTANT: when copying text from read_file output, strip the leading `<lineno>\\t` prefix from each line — that prefix is display-only and is NOT part of the file. MECHANICS: line endings are tolerant (write `\\n`; CRLF/LF both match), but whitespace/indentation must match exactly. Replacements apply IN ORDER — replacement #2 must match the file AS-IT-IS-AFTER #1. To delete a region, pass new_text="". On a "not found" error the tool returns the file\'s actual "Closest matching region" (with a `·`=space/`→`=tab diff) — copy that as your next old_text instead of guessing; after 3 failures on one file it auto-refreshes and surfaces the live content.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to edit' },
                replacements: {
                    type: 'array',
                    description: 'Ordered list of search-and-replace operations. Each is applied sequentially to the running content, so later old_texts must match what the file looks like AFTER earlier replacements.',
                    items: {
                        type: 'object',
                        properties: {
                            old_text: { type: 'string', description: 'Exact literal text to find. Must match exactly once (unless replace_all=true). Include surrounding context if the snippet alone is ambiguous.' },
                            new_text: { type: 'string', description: 'Replacement text. Use the empty string to delete the matched region.' },
                            replace_all: { type: ['boolean', 'null'], description: 'Optional (null to omit). If true, every occurrence of old_text is replaced (uniqueness is not required). Default: false.' }
                        },
                        required: ['old_text', 'new_text', 'replace_all'],
                        additionalProperties: false
                    }
                }
            },
            required: ['path', 'replacements'],
            additionalProperties: false
        }
    },
    {
        name: 'replace_lines',
        isSafe: false,
        description: 'WHEN TO USE: replace a large or awkward CONTIGUOUS block addressed by LINE NUMBER — ideal when retyping the block exactly for multi_replace_file_content is error-prone, or when multi_replace_file_content keeps failing to match. For small precise edits prefer multi_replace_file_content; for a new/whole file use write_file. Replace a contiguous LINE RANGE [start_line..end_line] (1-indexed, inclusive) with new_text. Unlike multi_replace_file_content (which matches by content), this addresses by LINE NUMBER — ideal for replacing a large or awkward block you can SEE in read_file output without re-typing it exactly (avoids transcription typos on big multi-line blocks). SAFETY (required): you MUST pass expected_first_line and expected_last_line — the exact CURRENT text of the range\'s first and last lines, WITHOUT the read_file "<lineno>\\t" prefix. The edit is REJECTED (nothing written) if they don\'t match the file, so stale line numbers can never clobber the wrong lines. ALWAYS call read_file right before to get fresh line numbers. To DELETE the range, pass new_text="".',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to edit' },
                start_line: { type: 'number', description: 'First line of the range to replace (1-indexed, inclusive).' },
                end_line: { type: 'number', description: 'Last line of the range to replace (1-indexed, inclusive). Must be >= start_line.' },
                new_text: { type: 'string', description: 'Replacement text for the whole range. Use "" to delete the lines. Do NOT include any "<lineno>\\t" prefixes — write raw file content only.' },
                expected_first_line: { type: 'string', description: 'The exact current content of start_line (strip the read_file "<lineno>\\t" prefix). Verified against the file before replacing; trailing whitespace is ignored.' },
                expected_last_line: { type: 'string', description: 'The exact current content of end_line (strip the read_file "<lineno>\\t" prefix). Verified against the file before replacing; trailing whitespace is ignored.' }
            },
            required: ['path', 'start_line', 'end_line', 'new_text', 'expected_first_line', 'expected_last_line'],
            additionalProperties: false
        }
    },
    {
        name: 'create_artifact',
        description: 'Create a new markdown artifact (e.g. implementation plan, checklist) and show it in a dedicated tab.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: "Name of the artifact file (e.g. 'task_plan')" },
                content: { type: 'string', description: 'Content of the artifact in markdown format' }
            },
            required: ['name', 'content'],
            additionalProperties: false
        }
    },
    {
        name: 'update_artifact',
        description: 'Update an existing markdown artifact (overwrites entire content).',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the artifact file to update' },
                content: { type: 'string', description: 'Updated entire content of the artifact' }
            },
            required: ['name', 'content'],
            additionalProperties: false
        }
    },
    {
        name: 'finish_task',
        isSafe: true,
        description: "End the task when the user's goal is fully achieved (and, for code changes, verified). IMPORTANT: if the user asked for a TEXT deliverable — a report, analysis, answer, proposal, or plan — that deliverable must already be delivered, either via `present_result` or as the full content of `summary` below. Do NOT call finish_task merely to ANNOUNCE completion (e.g. \"I completed the analysis\") without the actual content — an empty finish leaves the user with nothing.",
        parameters: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'The outcome. For a TEXT deliverable that you did not send via present_result and that involved no file changes, put the COMPLETE report/answer/proposal here (not a one-line "done" claim). For code tasks, a concise summary of what changed and how it was verified.' }
            },
            required: ['summary'],
            additionalProperties: false
        }
    },
    {
        name: 'ask_user',
        isSafe: true,
        description: "Pause the task and ask the user a clarifying question, then STOP and wait for their reply. Use this ONLY when you genuinely cannot proceed without input the user must supply — e.g. an ambiguous requirement, a missing decision, or attached content you cannot read (an image the current model can't see). This ENDS the current run cleanly: the question is shown to the user and the agent stops. Do NOT use it to report progress or to confirm work that is already done (use finish_task for completion). Prefer making a reasonable assumption and proceeding when you can; reserve ask_user for true blockers. When the answer is a choice, PROVIDE `options` so the user gets clickable buttons instead of having to type — e.g. options ['はい','いいえ'] for a yes/no, or a list of concrete choices. Set `multi_select` true when several options may be picked together.",
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The clarifying question to ask the user, in the user\'s language. Be specific about what you need and why you cannot proceed without it.' },
                context: { type: ['string', 'null'], description: 'Optional brief summary of what you have already done / found, so the user has context when answering. null to omit.' },
                options: { type: ['array', 'null'], items: { type: 'string' }, description: 'Optional list of concrete answer choices (in the user\'s language). When provided, the user gets clickable buttons/checkboxes instead of a free-text box. Use for yes/no (["はい","いいえ"]) or any multiple-choice. null for a free-text answer.' },
                multi_select: { type: ['boolean', 'null'], description: 'When true (and `options` given), the user may select MULTIPLE options (checkboxes + submit). false/null = single choice.' }
            },
            required: ['question', 'context', 'options', 'multi_select'],
            additionalProperties: false
        }
    },
    {
        name: 'verify_syntax',
        isSafe: true,
        description: 'Validate a file using a real parser. JSON files are parsed in-process; JS/JSX/MJS/CJS files are validated by spawning `node --check` (real V8 parser); TS/TSX files are skipped with guidance (use `run_command npx tsc --noEmit` for type checking). Call after every edit to .json/.js/.jsx/.mjs/.cjs files to catch syntax breakage immediately.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path of the file to syntax-check' }
            },
            required: ['path'],
            additionalProperties: false
        }
    },
    {
        name: 'web_search',
        isSafe: true,
        description: 'Search the web by QUERY and get back ranked results (title, URL, snippet). Use this FIRST whenever you need current/online information — do NOT guess or recall a URL from memory (that is the #1 cause of 404 errors). Then call fetch_url on the most relevant result URL to read its content. No API key required.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query, e.g. "JPY USD exchange rate today" or "Tauri v2 global shortcut docs".' },
                max_results: { type: ['integer', 'null'], description: 'Optional (null to omit). Max results to return, 1–10. Default 5.' }
            },
            required: ['query', 'max_results'],
            additionalProperties: false
        }
    },
    {
        name: 'fetch_url',
        isSafe: true,
        description: 'Fetch the content of a specific KNOWN URL via HTTP GET and return the response body as text. Use this to read a page/API/RSS whose URL you got from web_search or the user. Do NOT invent or recall URLs from memory — if you are not sure of the exact URL, call web_search first. For JSON APIs the raw JSON is returned; for HTML the full HTML is returned. Maximum response size is 500 KB.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The full URL to fetch (must start with http:// or https://)' },
                headers: {
                    type: ['array', 'null'],
                    description: 'Optional (null to omit) HTTP headers as a list of name/value pairs, e.g. [{"name":"Accept","value":"application/json"}].',
                    items: {
                        type: 'object',
                        properties: {
                            name:  { type: 'string', description: 'Header name (e.g. "Accept")' },
                            value: { type: 'string', description: 'Header value (e.g. "application/json")' }
                        },
                        required: ['name', 'value'],
                        additionalProperties: false
                    }
                }
            },
            required: ['url', 'headers'],
            additionalProperties: false
        }
    },
    {
        name: 'task_progress',
        isSafe: true,
        description: 'Track subtask state. PERSISTS across the whole workspace (stored in .agent/tasks.json) — items survive context compaction AND carry over between sessions, so a multi-run project keeps one running checklist. At the START of a task call action="get" first to see any tasks left over from earlier sessions; use action="update" to mark items completed/in_progress/blocked; use action="set" to (re)initialize the list — note "set" REPLACES the entire list, so only use it for a genuinely new piece of work, not to append.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['set', 'update', 'get'],
                    description: '"set" replaces the entire item list (use at task start). "update" patches one or more items by id. "get" returns the current state without changes.'
                },
                items: {
                    type: ['array', 'null'],
                    description: 'For "set": full list of subtasks. For "update": one or more items with id + new status. Pass null for action="get".',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Stable identifier (e.g. "1", "2a")' },
                            title: { type: ['string', 'null'], description: 'Short subtask description (null when only updating status)' },
                            status: {
                                type: ['string', 'null'],
                                enum: ['pending', 'in_progress', 'completed', 'blocked', null],
                                description: 'Current state of the subtask (null to leave unchanged on update)'
                            },
                            note: { type: ['string', 'null'], description: 'Optional brief note (e.g. blocker reason); null to omit' }
                        },
                        required: ['id', 'title', 'status', 'note'],
                        additionalProperties: false
                    }
                }
            },
            required: ['action', 'items'],
            additionalProperties: false
        }
    },
    {
        name: 'present_result',
        isSafe: true,
        description: "Deliver the FINAL, structured result to the calling app (AI-Hub Result Contract). Use this as the last step when a task was launched by an external app (JHEditor/JHER/…) so the app can render it consistently and offer 'apply' actions. Choose `kind`: 'markdown' (prose/tables → fill `markdown`), 'answer' (short text → `markdown`), 'file-list' (relevant files → `files`), 'code-edit' (proposed edits → `edits`). Provide `actions` the user can apply (open a file, insert markdown, apply an edit). For a plain chat reply with no app integration, just finish normally instead.",
        parameters: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    enum: ['markdown', 'table', 'answer', 'file-list', 'code-edit'],
                    description: 'Result shape the app should render.'
                },
                summary: { type: ['string', 'null'], description: 'One-line summary of the result (null to omit).' },
                markdown: { type: ['string', 'null'], description: 'Markdown body for kind=markdown/table/answer. null otherwise.' },
                files: {
                    type: ['array', 'null'],
                    description: 'For kind=file-list: relevant files. null otherwise.',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path.' },
                            line: { type: ['integer', 'null'], description: 'Optional 1-based line (null to omit).' },
                            reason: { type: ['string', 'null'], description: 'Why this file is relevant (null to omit).' }
                        },
                        required: ['path', 'line', 'reason'],
                        additionalProperties: false
                    }
                },
                edits: {
                    type: ['array', 'null'],
                    description: 'For kind=code-edit: proposed edits. null otherwise.',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Target file path.' },
                            new_text: { type: 'string', description: 'Replacement text for the range (or full insert).' },
                            start_line: { type: ['integer', 'null'], description: '1-based start line (null = whole file / app decides).' },
                            end_line: { type: ['integer', 'null'], description: '1-based end line (null to omit).' }
                        },
                        required: ['path', 'new_text', 'start_line', 'end_line'],
                        additionalProperties: false
                    }
                },
                actions: {
                    type: ['array', 'null'],
                    description: 'Apply-actions the app can offer the user (null/[] for none).',
                    items: {
                        type: 'object',
                        properties: {
                            label: { type: 'string', description: 'Button label shown to the user.' },
                            type: {
                                type: 'string',
                                enum: ['openFile', 'insertMarkdown', 'applyEdit'],
                                description: 'What the app does when the user applies this action.'
                            },
                            path: { type: ['string', 'null'], description: 'For openFile/applyEdit (null to omit).' },
                            line: { type: ['integer', 'null'], description: 'For openFile (null to omit).' },
                            text: { type: ['string', 'null'], description: 'For insertMarkdown/applyEdit new text (null to omit).' }
                        },
                        required: ['label', 'type', 'path', 'line', 'text'],
                        additionalProperties: false
                    }
                }
            },
            required: ['kind', 'summary', 'markdown', 'files', 'edits', 'actions'],
            additionalProperties: false
        }
    }
];
