// markdown.js — PURE markdown→HTML + result/file rendering (no DOM, no Tauri).
// Extracted from resultView.js (Phase 5) so the bug-prone renderer is unit-
// testable. resultView.js re-exports these and adds the DOM/IPC glue
// (attachFileOpenHandlers / ensureResultViewStyles).

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Inline markdown (code/bold/italic/link). Operates on already-escaped text.
function renderInline(escaped) {
    return escaped
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * Minimal, dependency-free Markdown → HTML renderer.
 * Supports: headings, fenced code, un/ordered lists, GFM tables, blockquotes,
 * horizontal rules, paragraphs, and inline formatting. Small by design.
 */
export function renderMarkdown(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let inList = null; // 'ul' | 'ol' | null

    const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };

    while (i < lines.length) {
        const line = lines[i];

        const fence = line.match(/^```(\w*)\s*$/);
        if (fence) {
            closeList();
            const codeLines = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++; }
            i++; // skip closing fence
            html += `<pre class="rv-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
            continue;
        }

        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            closeList();
            const parseRow = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            const headers = parseRow(line);
            i += 2;
            let table = '<table class="rv-table"><thead><tr>' +
                headers.map(h => `<th>${renderInline(escapeHtml(h))}</th>`).join('') + '</tr></thead><tbody>';
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                const cells = parseRow(lines[i]);
                table += '<tr>' + cells.map(c => `<td>${renderInline(escapeHtml(c))}</td>`).join('') + '</tr>';
                i++;
            }
            table += '</tbody></table>';
            html += table;
            continue;
        }

        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            closeList();
            const level = h[1].length;
            html += `<h${level} class="rv-h">${renderInline(escapeHtml(h[2]))}</h${level}>`;
            i++; continue;
        }

        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
            closeList();
            html += '<hr class="rv-hr">';
            i++; continue;
        }

        if (/^\s*>\s?/.test(line)) {
            closeList();
            html += `<blockquote class="rv-quote">${renderInline(escapeHtml(line.replace(/^\s*>\s?/, '')))}</blockquote>`;
            i++; continue;
        }

        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
            if (inList !== 'ul') { closeList(); html += '<ul class="rv-list">'; inList = 'ul'; }
            html += `<li>${renderInline(escapeHtml(ul[1]))}</li>`;
            i++; continue;
        }

        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ol) {
            if (inList !== 'ol') { closeList(); html += '<ol class="rv-list">'; inList = 'ol'; }
            html += `<li>${renderInline(escapeHtml(ol[1]))}</li>`;
            i++; continue;
        }

        if (/^\s*$/.test(line)) { closeList(); i++; continue; }

        closeList();
        const para = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i]) &&
               !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>|\s*\|)/.test(lines[i])) {
            para.push(lines[i]); i++;
        }
        html += `<p class="rv-p">${renderInline(escapeHtml(para.join(' ')))}</p>`;
    }
    closeList();
    return html;
}

const ACTION_LABEL = {
    created: '🆕 Created',
    modified: '✏️ Modified',
    deleted: '🗑 Deleted',
};

function fileRow(f) {
    const p = String(f.path || '');
    const name = p.split(/[\\/]/).pop() || p;
    const action = ACTION_LABEL[f.action] || f.action || '';
    return '<tr>' +
        `<td><a href="#" class="rv-file-link" data-open-path="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(name)}</a></td>` +
        `<td class="rv-action">${escapeHtml(action)}</td>` +
        `<td>${escapeHtml(f.description || '')}</td>` +
        '</tr>';
}

/** A compact stats chip row from a structured stats object. */
function renderStatsChips(stats) {
    if (!stats || typeof stats !== 'object') return '';
    const chips = [];
    if (stats.steps) chips.push(`<span class="rv-chip">🔁 Steps ${stats.steps}</span>`);
    const tools = stats.tools && typeof stats.tools === 'object' ? Object.entries(stats.tools) : [];
    const toolTotal = tools.reduce((n, [, c]) => n + (c || 0), 0);
    if (toolTotal > 0) {
        const detail = tools.map(([n, c]) => `${n}×${c}`).join(', ');
        chips.push(`<span class="rv-chip" title="${escapeHtml(detail)}">🛠 Tools ${toolTotal}</span>`);
    }
    if (stats.tokens) {
        const t = stats.tokens >= 1000 ? (stats.tokens / 1000).toFixed(1) + 'k' : stats.tokens;
        chips.push(`<span class="rv-chip">🔢 ${t} tok</span>`);
    }
    if (stats.durationMs) chips.push(`<span class="rv-chip">⏱ ${Math.round(stats.durationMs / 1000)}s</span>`);
    if (stats.files) chips.push(`<span class="rv-chip">📄 ${stats.files} files</span>`);
    return chips.length ? `<div class="rv-chips">${chips.join('')}</div>` : '';
}

/**
 * Full result panel. Prefers the STRUCTURED shape
 * ({answer, stats, request, plan, files}) → answer-first sections with a compact
 * stats chip row and a collapsible 詳細 (request/plan). Falls back to the flat
 * {summary, files} markdown blob for older payloads / API back-compat.
 */
export function renderResultSummary(resultSummary) {
    if (!resultSummary) return '<div class="rv-empty">No result summary yet.</div>';
    const { answer, stats, request, plan, summary, files } = resultSummary;

    let html = '';
    const hasStructured = (answer && answer.trim()) || stats || (request && request.trim()) || (plan && plan.trim());

    if (hasStructured) {
        // 1. Answer (headline — the LLM's actual deliverable).
        if (answer && answer.trim()) {
            html += `<div class="rv-section-label">💬 Answer</div>`;
            html += `<div class="rv-summary rv-answer">${renderMarkdown(answer)}</div>`;
        }
        // 2. Compact stats chips.
        html += renderStatsChips(stats);
        // 3. Collapsible details: request + plan.
        const details = [];
        if (request && request.trim()) {
            details.push(`<div class="rv-detail-h">📥 Request</div><div class="rv-summary">${renderMarkdown(request)}</div>`);
        }
        if (plan && plan.trim()) {
            details.push(`<div class="rv-detail-h">🗺 Plan</div><div class="rv-summary">${renderMarkdown(plan)}</div>`);
        }
        if (details.length) {
            html += `<details class="rv-details"><summary>Details (request & plan)</summary>${details.join('')}</details>`;
        }
    } else if (summary && summary.trim()) {
        // Back-compat: flat markdown blob.
        html += `<div class="rv-summary">${renderMarkdown(summary)}</div>`;
    }

    // File table (shared by both shapes).
    if (Array.isArray(files) && files.length > 0) {
        html += `<div class="rv-files-title">Created / modified files (${files.length})</div>`;
        html += '<table class="rv-table rv-files"><thead><tr><th>File</th><th>Action</th><th>Description</th></tr></thead><tbody>';
        for (const f of files) html += fileRow(f);
        html += '</tbody></table>';
    } else {
        html += '<div class="rv-files-title">Created / modified files</div><div class="rv-empty">None</div>';
    }
    return html;
}

/** Just the file table (no summary). Returns '' when there are no files. */
export function renderFileList(files, opts = {}) {
    if (!Array.isArray(files) || files.length === 0) return '';
    const title = opts.title || `📁 Created / modified files (${files.length})`;
    let html = `<div class="rv-filelist"><div class="rv-files-title">${escapeHtml(title)}</div>`;
    html += '<table class="rv-table rv-files"><thead><tr><th>File</th><th>Action</th><th>Description</th></tr></thead><tbody>';
    for (const f of files) html += fileRow(f);
    html += '</tbody></table></div>';
    return html;
}

/** Normalize [{path,original,current}] → [{path,action,description}] (action from existence). */
export function filesFromModified(modifiedFiles) {
    return (modifiedFiles || []).map(f => ({
        path: f.path,
        action: (f.original === null || f.original === undefined || f.original === '') ? 'created' : 'modified',
        description: '',
    }));
}
