// monitorLogFormat — pure formatters for the Monitor 'All Logs' view, split
// out of MonitorView.js. Each takes a log entry / data object and returns an
// HTML string; none depend on view state (no `this`). Kept behaviourally
// identical to the former methods.

import { normalizeLeakedEscapes } from '../utils/resultView.js';

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function extractThoughtSummary(rawText) {
        const txt = (rawText || '').trim();
        if (txt.startsWith('{') || txt.startsWith('[')) {
            try {
                const obj = JSON.parse(txt);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    // Try preferred field names first
                    for (const field of ['thinking', 'thought', 'observation', 'plan', 'reflection', 'summary', 'analysis', 'reasoning', 'action']) {
                        if (typeof obj[field] === 'string' && obj[field].trim()) {
                            const v = obj[field].trim();
                            return v.substring(0, 120) + (v.length > 120 ? '…' : '');
                        }
                    }
                    // Fall back to first string value
                    for (const v of Object.values(obj)) {
                        if (typeof v === 'string' && v.trim()) {
                            return v.substring(0, 120) + (v.length > 120 ? '…' : '');
                        }
                    }
                }
            } catch {}
        }
        return txt.substring(0, 120) + (txt.length > 120 ? '…' : '');
    }

export function fmtThought(log) {
        let rawText = '';
        let parsedObj = null;
        try {
            if (typeof log.data.text === 'object' && log.data.text !== null) {
                parsedObj = log.data.text;
                rawText = JSON.stringify(log.data.text, null, 2);
            } else {
                rawText = String(log.data.text || '');
                // Try to parse if it looks like JSON
                const trimmed = rawText.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { parsedObj = JSON.parse(trimmed); } catch (_) { /* not JSON */ }
                }
            }
        } catch {
            rawText = String(log.data.text || '');
        }

        // Repair escape-leaked text (literal \n from a weak model's JSON string).
        rawText = normalizeLeakedEscapes(rawText);
        const uid = Math.random().toString(36).slice(2, 7);
        const summary = extractThoughtSummary(rawText);
        const detailHtml = formatThoughtDetail(parsedObj, rawText);

        // A plain-text thought's "detail" is just the same sentence again — the
        // expand arrow then opened a box repeating the summary verbatim. Only
        // offer the expander when the detail actually ADDS something (a structured
        // JSON thought, or text longer than the extracted summary).
        const detailText = String(detailHtml).replace(/<[^>]*>/g, '').trim();
        const hasMore = detailText.length > summary.trim().length + 8;

        return `
            <div class="mlog mlog-thought log-thought">
                <span class="mlog-icon">🧠</span>
                <div class="mlog-body">
                    <div class="mlog-thought-summary" data-uid="${uid}">
                        <span>${escapeHtml(summary)}</span>
                        ${hasMore ? `<button class="mlog-expand-btn" data-uid="${uid}" data-target="thought-detail-${uid}">▶</button>` : ''}
                    </div>
                    ${hasMore ? `<div class="mlog-thought-detail" id="thought-detail-${uid}">${detailHtml}</div>` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Render the expanded thought detail as labeled, readable sections.
     * If the thought is a JSON object, each known field becomes a labeled
     * block with an icon (Observation / Thinking / Plan / etc.). Unknown
     * fields are kept too, just with a generic label. Strings without JSON
     * structure fall through to a preformatted text block.
     */

export function formatThoughtDetail(parsedObj, rawText) {
        // Non-JSON or array? Just show as preformatted text.
        if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
            return `<pre class="thought-raw">${escapeHtml(rawText)}</pre>`;
        }

        // Known field → human-friendly label + icon
        const LABELS = {
            goal:        { icon: '🎯', label: 'Goal' },
            observation: { icon: '👁',  label: 'Observation' },
            thinking:    { icon: '🧠', label: 'Thinking' },
            thought:     { icon: '🧠', label: 'Thought' },
            reasoning:   { icon: '🧠', label: 'Reasoning' },
            analysis:    { icon: '🔍', label: 'Analysis' },
            plan:        { icon: '📋', label: 'Plan' },
            next_steps:  { icon: '➡',  label: 'Next Steps' },
            reflection:  { icon: '💭', label: 'Reflection' },
            summary:     { icon: '📝', label: 'Summary' },
            action:      { icon: '⚡', label: 'Action' },
            tool_calls:  { icon: '⚙', label: 'Tool Calls' },
        };

        // Preferred display order — fields not in this list come last in original order
        const PREFERRED_ORDER = [
            'goal', 'observation', 'thinking', 'thought', 'reasoning',
            'analysis', 'plan', 'next_steps', 'reflection',
            'summary', 'action', 'tool_calls'
        ];

        const keys = Object.keys(parsedObj);
        const ordered = [
            ...PREFERRED_ORDER.filter(k => keys.includes(k)),
            ...keys.filter(k => !PREFERRED_ORDER.includes(k))
        ];

        const renderValue = (v) => {
            if (v == null) return '<span class="thought-empty">(empty)</span>';
            if (typeof v === 'string') {
                return escapeHtml(v);
            }
            if (Array.isArray(v)) {
                // Render as bullet list; nested objects get JSON-stringified
                const items = v.map(item => {
                    if (typeof item === 'string') return `<li>${escapeHtml(item)}</li>`;
                    return `<li><pre class="thought-nested">${escapeHtml(JSON.stringify(item, null, 2))}</pre></li>`;
                }).join('');
                return `<ul class="thought-list">${items}</ul>`;
            }
            // Nested object → pretty JSON
            return `<pre class="thought-nested">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
        };

        const sections = ordered
            .filter(key => {
                const v = parsedObj[key];
                if (v == null) return false;
                if (typeof v === 'string' && v.trim() === '') return false;
                if (Array.isArray(v) && v.length === 0) return false;
                return true;
            })
            .map(key => {
                const meta = LABELS[key] || {
                    icon: '·',
                    // Convert snake_case → Title Case for unknown keys
                    label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                };
                return `
                    <div class="thought-field">
                        <div class="thought-field-label"><span class="thought-field-icon">${meta.icon}</span>${escapeHtml(meta.label)}</div>
                        <div class="thought-field-content">${renderValue(parsedObj[key])}</div>
                    </div>
                `;
            })
            .join('');

        // If nothing useful was extracted, fall back to raw
        if (!sections) {
            return `<pre class="thought-raw">${escapeHtml(rawText)}</pre>`;
        }
        return `<div class="thought-detail-formatted">${sections}</div>`;
    }

export function fmtTool(log) {
        const name = log.data.name || 'unknown';
        const args = log.data.args || {};
        const result = log.data.result;

        const uid = Math.random().toString(36).slice(2, 7);
        const resultStr = result ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : '';
        const resultSnippet = resultStr ? resultStr.substring(0, 60) + (resultStr.length > 60 ? '…' : '') : '';

        let toolIcon = '🛠';
        let toolTitle = name;
        let toolClass = 'log-tool';
        let customContentHtml = '';

        if (name === 'read_file' || name === 'view_file') {
            toolIcon = '📖';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Read File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-read log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'write_file' || name === 'write_to_file') {
            toolIcon = '✍';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Wrote File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-write log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'multi_replace_file_content') {
            toolIcon = '📝';
            const filepath = args.path || args.file_path || '';
            const filename = filepath.split(/[/\\]/).pop() || filepath;
            toolTitle = `Edited File: <code>${escapeHtml(filename)}</code> <span style="font-size:10px;opacity:0.6;font-family:monospace;">(${escapeHtml(filepath)})</span>`;
            toolClass = 'mlog-write log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'grep_search') {
            toolIcon = '🔍';
            const term = args.term || args.query || '';
            toolTitle = `Searched for: <code>"${escapeHtml(term)}"</code>`;
            toolClass = 'mlog-read log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'run_command') {
            toolIcon = '💻';
            const cmd = args.command || '';
            toolTitle = `Ran Command: <code>${escapeHtml(cmd)}</code>`;
            toolClass = 'mlog-cmd log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:var(--text-primary);background:var(--bg-input);border-color:var(--border);">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'list_files' || name === 'list_dir') {
            toolIcon = '📁';
            const path = args.path || args.directory || '';
            toolTitle = `Listed Directory: <code>${escapeHtml(path)}</code>`;
            toolClass = 'log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'create_artifact' || name === 'update_artifact') {
            toolIcon = '📄';
            const artName = args.name || '';
            toolTitle = `Saved Artifact: <code>${escapeHtml(artName)}</code>`;
            toolClass = 'log-tool';
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        } else if (name === 'finish_task') {
            toolIcon = '🏁';
            const summary = args.summary || '';
            toolTitle = `Finished Task: <strong style="color:var(--success);">${escapeHtml(summary)}</strong>`;
            toolClass = 'mlog-success log-tool';
        } else {
            const argPairs = Object.entries(args).slice(0, 3).map(([k, v]) => {
                const val = typeof v === 'string' ? `"${v.substring(0, 30)}"` : JSON.stringify(v).substring(0, 30);
                return `${k}=${val}`;
            }).join(', ') + (Object.keys(args).length > 3 ? ', …' : '');
            toolTitle = `<span class="mlog-tool-name">${escapeHtml(name)}</span> <span class="mlog-tool-args">(${escapeHtml(argPairs)})</span>`;
            if (resultStr) {
                customContentHtml = `<pre style="margin:0;font-family:var(--font-mono);font-size:10.5px;white-space:pre;overflow-x:auto;color:inherit;">${escapeHtml(resultStr)}</pre>`;
            }
        }

        let isErrResult = false;
        if (resultStr) {
            const lower = resultStr.toLowerCase();
            if (lower.startsWith('error') || lower.includes('"error"')) {
                isErrResult = true;
            }
        }
        if (isErrResult) {
            toolClass = 'mlog-error log-tool';
        }

        const innerContent = customContentHtml || (resultStr ? `<div style="font-family:monospace;white-space:pre-wrap;word-break:break-word;">${escapeHtml(resultStr)}</div>` : '');

        return `
            <div class="mlog ${toolClass}">
                <span class="mlog-icon">${toolIcon}</span>
                <div class="mlog-body">
                    <div class="mlog-tool-row" data-uid="${uid}" style="display:flex;align-items:center;width:100%;">
                        <span class="mlog-tool-name" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;">${toolTitle}</span>
                        ${resultStr ? `
                            <span class="mlog-tool-result-preview" style="max-width:250px;margin-left:8px;font-size:10px;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${escapeHtml(resultSnippet)}</span>
                            <button class="mlog-expand-btn" data-uid="${uid}" data-target="tool-result-${uid}" style="margin-left:6px;flex-shrink:0;">▶</button>
                        ` : ''}
                    </div>
                    ${resultStr ? `
                        <div class="mlog-tool-result" id="tool-result-${uid}" style="margin-top:6px;">
                            ${innerContent}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

export function fmtFile(log) {
        return `
            <div class="mlog mlog-file log-file">
                <span class="mlog-icon">📝</span>
                <span class="mlog-body"><code>${escapeHtml(log.data.path || '')}</code></span>
            </div>
        `;
    }

export function fmtStatus(log) {
        const txt = String(log.data.message || log.data.status || '');

        // Suppress meaningless noise
        if (!txt || txt === 'Waiting for user input...' || txt.trim().startsWith('{')) return '';

        // "<the step's thought> (step N)" — AgentController emits this status right
        // before the `thought` event carrying the SAME text. The step header already
        // shows it and the 🧠 thought line renders it in full, so this line was a
        // pure triplicate.
        if (/\(step\s*\d+\)\s*$/.test(txt)) return '';

        // Suppress redundant status logs (formatted as tool calls instead)
        if (txt.startsWith('Reading file:') ||
            txt.startsWith('Writing file:') ||
            txt.startsWith('Editing file:') ||
            txt.startsWith('Running command:') ||
            txt.startsWith('Searching for') ||
            txt.startsWith('Searching:') ||          // grep_search's own status
            txt.startsWith('Searching the web:') ||
            txt.startsWith('Exploring directory:') ||
            txt.startsWith('Deep scanning directory:') ||
            txt.startsWith('Creating artifact:') ||
            txt.startsWith('Updating artifact:') ||
            txt.startsWith('Presenting result') ||
            txt.startsWith('Asking the user:') ||
            txt.startsWith('Proposed plan:') ||
            txt.startsWith('Calling MCP tool:')) {
            return '';
        }

        // JSON parse retry / error recovery → show as inline warning within step
        if (txt.includes('JSON parse failed') || txt.includes('⚠️')) {
            return `<div class="mlog log-status" style="color:var(--warning,#f59e0b)"><span class="mlog-icon">⚠️</span><span class="mlog-body">${escapeHtml(txt)}</span></div>`;
        }
        // Generic error/abort messages
        if (txt.includes('failed') || txt.includes('Error') || txt.includes('error')) {
            return `<div class="mlog mlog-error log-status"><span class="mlog-icon">⚡</span><span class="mlog-body" style="color:var(--error)">${escapeHtml(txt)}</span></div>`;
        }
        return `<div class="mlog mlog-status log-status"><span class="mlog-icon" style="opacity:0.5">·</span><span class="mlog-body" style="color:var(--text-tertiary)">${escapeHtml(txt)}</span></div>`;
    }

    /** A "log" entry is CHAT-like (→ step-header button) unless it's a typed card. */

export function isChatLog(data) {
        const m = data && data.method;
        return !!data && m !== 'TOOL' && m !== 'METRICS' && m !== 'REVIEW';
    }

    /** 📊 Efficiency Report card — the end-of-run step-reduction metrics. */

export function fmtEfficiency(d) {
        const r = (d && d.response) || {};
        const k = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
        const warn = (r.re_reads || 0) > 3;
        const chips = [
            `📍 ${r.steps ?? '?'} steps`,
            `🧮 ↑${k(r.prompt_tokens)} ↓${k(r.completion_tokens)} tok`,
            `📄 ${r.distinct_files_read ?? 0} files read`,
            `♻ ${r.re_reads ?? 0} re-reads`,
        ];
        if (r.re_read_chars_approx) chips.push(`🗑 ~${k(r.re_read_chars_approx)} wasted chars`);
        if (r.compactions) chips.push(`🗜 ${r.compactions}× compact · -${k(r.compaction_chars_saved)} chars`);
        const chipsHtml = chips.map(c =>
            `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:var(--bg-tertiary);font-size:11px">${escapeHtml(c)}</span>`
        ).join(' ');
        const top = (r.top_re_read_files || []);
        const topHtml = top.length
            ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;opacity:.8">再読込ファイル / re-read files (${top.length})</summary>`
              + `<table style="margin-top:4px;font-size:11px;border-collapse:collapse">`
              + top.map(f => `<tr><td style="padding:1px 8px 1px 0;opacity:.85">${escapeHtml(f.path)}</td><td style="opacity:.7">${f.reads}×</td></tr>`).join('')
              + `</table></details>`
            : '';
        const hintHtml = r.hint
            ? `<div style="margin-top:6px;font-size:11px;color:${warn ? 'var(--error)' : 'var(--text-tertiary)'}">${escapeHtml(r.hint)}</div>`
            : '';
        return `<div class="mlog mlog-status" style="border-left:3px solid ${warn ? 'var(--error)' : 'var(--accent)'}">
            <span class="mlog-icon">📊</span>
            <div class="mlog-body">
                <strong>Efficiency Report</strong>
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${chipsHtml}</div>
                ${topHtml}${hintHtml}
            </div>
        </div>`;
    }

    /** 🔎 Independent-review verdict line (from the sub-agent review gate). */

export function fmtReview(d) {
        const r = (d && d.response) || {};
        const v = r.verdict || '?';
        const icon = v === 'pass' ? '✅' : v === 'fail' ? '❌' : '❔';
        const reason = r.reason ? ` <span style="opacity:.6">(${escapeHtml(r.reason)})</span>` : '';
        return `<div class="mlog mlog-status"><span class="mlog-icon">🔎</span><span class="mlog-body"><strong>Review:</strong> ${icon} ${escapeHtml(String(v))}${reason}</span></div>`;
    }

export function fmtTelemetry(d) {
        if (!d) return '';
        const isErr = d.status >= 400 || d.error;
        const method = d.method === 'TOOL' ? `TOOL:${d.name || ''}` : (d.method || 'POST');
        const dur = d.duration ? `${d.duration}ms` : '';
        const uid = Math.random().toString(36).slice(2, 7);

        let usageTxt = '';
        if (d.usage) {
            if (d.method === 'TOOL') {
                const fmt = b => typeof b === 'number' ? (b < 1024 ? b + 'B' : (b/1024).toFixed(1) + 'K') : '0B';
                usageTxt = `↑${fmt(d.usage.request_size)} ↓${fmt(d.usage.response_size)}`;
            } else {
                usageTxt = `↑${d.usage.prompt_tokens||0}t ↓${d.usage.completion_tokens||0}t`;
            }
        }

        const fmtPayload = (data) => {
            if (!data) return '';
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
            if (typeof data !== 'object') return String(data);
            let out = '';
            for (const [k, v] of Object.entries(data)) {
                // Skip empty string values (e.g. "thought":"" from native tool calling)
                if (typeof v === 'string' && v.trim() === '') continue;
                out += `=== ${k} ===\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\n`;
            }
            return out.trim();
        };

        const req = escapeHtml(fmtPayload(d.request));
        const res = escapeHtml(fmtPayload(d.response || d.error || ''));
        const hdrs = d.headers ? escapeHtml(JSON.stringify(d.headers, null, 2)) : '';

        return `
            <div class="mlog-telemetry telemetry-log" id="tele-${uid}">
                <div class="mlog-tele-header">
                    <span class="mlog-tele-method">${escapeHtml(method)}</span>
                    <span class="${isErr ? 'mlog-tele-status-err' : 'mlog-tele-status-ok'}">${d.status || (isErr ? 'ERR' : 'OK')}</span>
                    <span class="mlog-tele-dur">${dur}</span>
                    ${usageTxt ? `<span class="mlog-tele-usage">${escapeHtml(usageTxt)}</span>` : ''}
                    <span style="margin-left:auto;font-size:9px;color:var(--text-tertiary)">▶</span>
                </div>
                <div class="mlog-tele-body" id="tele-body-${uid}">
                    <div class="mlog-tele-tabs">
                        <button class="mlog-tele-tab active" data-tab="req" data-uid="${uid}">Request</button>
                        <button class="mlog-tele-tab" data-tab="res" data-uid="${uid}">Response</button>
                        ${hdrs ? `<button class="mlog-tele-tab" data-tab="hdrs" data-uid="${uid}">Headers</button>` : ''}
                    </div>
                    <div class="mlog-tele-content" id="tele-content-${uid}">
                        <pre class="tele-pane tele-req-${uid}">${req}</pre>
                        <pre class="tele-pane tele-res-${uid}" style="display:none">${res}</pre>
                        ${hdrs ? `<pre class="tele-pane tele-hdrs-${uid}" style="display:none">${hdrs}</pre>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    // idPrefix lets the SAME approval render in two places (All Logs step body +
    // the Task view) with unique element ids but a shared data-confirm-card key
    // so _markConfirmResolved can resolve both copies at once.
