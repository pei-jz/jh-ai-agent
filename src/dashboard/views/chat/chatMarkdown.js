// chatMarkdown — pure string→HTML helpers extracted from ChatView (Part A
// refactor). These render chat message content: HTML escaping, <think> block
// formatting, a lightweight markdown→HTML pass (code blocks, tables, headers,
// lists, emphasis), and table rendering. No DOM access — pure functions, so
// they're unit-tested directly (see chatMarkdown.test.js).

export function ensureChatMarkdownStyles() {
    // Global, idempotent Copy-button handler. Markdown from this module is
    // rendered in ChatView, the Monitor result view AND the spotlight overlay;
    // previously only ChatView bound a handler, so the Copy button silently
    // did nothing everywhere else. Document-level delegation covers them all.
    if (!document._jhCopyCodeBound) {
        document._jhCopyCodeBound = true;
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-copy-code');
            if (!btn) return;
            const codeEl = btn.closest('.code-block-wrapper')?.querySelector('pre');
            const text = codeEl ? codeEl.innerText : '';
            const done = () => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            };
            const fallback = () => {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;opacity:0;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    done();
                } catch (_) { /* clipboard unavailable */ }
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(fallback);
            } else {
                fallback();
            }
        });
    }

    if (document.getElementById('chat-markdown-styles')) return;
    const style = document.createElement('style');
    style.id = 'chat-markdown-styles';
    style.textContent = `
        /* Markdown Typography */
        .chat-md p { margin-bottom: 8px; }
        .chat-md p:last-child { margin-bottom: 0; }
        .chat-md h1, .chat-md h2, .chat-md h3, .chat-md h4, .chat-md h5, .chat-md h6 {
            margin: 12px 0 6px 0; color: var(--accent);
        }
        .chat-md h1:first-child, .chat-md h2:first-child, .chat-md h3:first-child { margin-top: 0; }
        .chat-md ul, .chat-md ol { margin: 8px 0; padding-left: 20px; }
        .chat-md li { margin-bottom: 4px; }
        .chat-md blockquote {
            border-left: 3px solid var(--accent);
            background: var(--bg-tertiary);
            padding: 6px 12px; margin: 8px 0;
            color: var(--text-secondary);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }
        
        /* Tables */
        .chat-md table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
        .chat-md th, .chat-md td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; }
        .chat-md th { background: var(--bg-tertiary); font-weight: 600; color: var(--accent); }
        .chat-md tr:nth-child(even) { background: var(--bg-tertiary); }

        /* Code Blocks */
        .chat-md .inline-code {
            font-family: var(--font-mono); font-size: 12px;
            background: var(--bg-tertiary); padding: 2px 5px;
            border-radius: 4px; color: var(--accent);
        }
        .chat-md .code-block-wrapper {
            margin: 10px 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--border);
        }
        .chat-md .code-block-header {
            background: var(--bg-input); padding: 6px 12px;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid var(--border);
        }
        .chat-md .code-block-lang {
            font-size: 11px; font-family: var(--font-mono);
            color: var(--text-secondary); text-transform: uppercase;
        }
        .chat-md .btn-copy-code {
            background: transparent; border: none; color: var(--accent);
            font-size: 11px; cursor: pointer; font-weight: 500;
        }
        .chat-md .btn-copy-code:hover { color: var(--accent-hover); }
        .chat-md .code-block-wrapper pre {
            margin: 0; padding: 12px; background: var(--bg-primary); overflow-x: auto;
        }
        .chat-md .code-block-wrapper code {
            /* Theme variable, NOT a hardcoded light gray — #e6edf3 was invisible
               on the light theme's near-white code background. */
            font-family: var(--font-mono); font-size: 12.5px; color: var(--text-primary); line-height: 1.5;
        }

        /* Thought Process */
        .chat-md .thought-process-block {
            margin: 8px 0; border-radius: 6px; border: 1px solid var(--border);
            background: var(--bg-secondary); overflow: hidden;
        }
        .chat-md .thought-process-block > summary {
            cursor: pointer; padding: 8px 12px; font-size: 12px; font-weight: 500;
            color: var(--text-secondary); background: var(--bg-tertiary);
            user-select: none;
        }
        .chat-md .thought-process-content {
            padding: 12px; font-size: 12.5px; color: var(--text-secondary);
            border-top: 1px solid var(--border);
        }
        .chat-md .thought-process-streaming {
            animation: pulse-border 2s infinite;
        }
        @keyframes pulse-border {
            0% { border-color: var(--border); }
            50% { border-color: var(--accent); }
            100% { border-color: var(--border); }
        }
    `;
    document.head.appendChild(style);
}

export function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}

export function formatMessageContent(text) {
    if (!text) return '';

    let thinkHtml = '';
    let contentText = text;

    if (text.includes('<think>')) {
        const parts = text.split('<think>');
        const preThink = parts[0];
        const postThink = parts[1];

        if (postThink.includes('</think>')) {
            const postThinkParts = postThink.split('</think>');
            const thinkText = postThinkParts[0];
            const restText = postThinkParts[1] || '';

            thinkHtml = `
                <details class="thought-process-block" open>
                    <summary>Thought Process (Completed)</summary>
                    <div class="thought-process-content">${formatMarkdown(thinkText)}</div>
                </details>
            `;
            contentText = preThink + restText;
        } else {
            thinkHtml = `
                <details class="thought-process-block" open>
                    <summary>Thought Process (Thinking...)</summary>
                    <div class="thought-process-content thought-process-streaming">${formatMarkdown(postThink)}</div>
                </details>
            `;
            contentText = preThink;
        }
    }

    return thinkHtml + formatMarkdown(contentText);
}

export function formatMarkdown(text) {
    if (!text) return '';

    let html = escapeHtml(text);

    // ── Protect code from every later pass ──────────────────────────────
    // Fenced blocks and inline code are swapped for private-use-area
    // placeholders and restored at the VERY END. Previously the rendered
    // code-block HTML stayed in the string while the table/header/bold/list
    // passes ran over it, so markdown-looking text INSIDE a code block (e.g.
    // a \`\`\`markdown template with "- item" lines) was transformed into real
    // <li>/<table>/<strong> elements — the "unindented bullets inside a code
    // block" bug.
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        codeBlocks.push(`<div class="code-block-wrapper">
            <div class="code-block-header">
                <span class="code-block-lang">${lang || 'code'}</span>
                <button class="btn-copy-code" type="button">Copy</button>
            </div>
            <pre><code class="language-${lang}">${code.trim()}</code></pre>
        </div>`);
        return `\uE000${codeBlocks.length - 1}\uE001`;
    });

    // Inline code — protected the same way (a backticked \`*text*\` must not
    // become italic, etc.).
    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (match, code) => {
        inlineCodes.push(`<code class="inline-code">${code}</code>`);
        return `\uE002${inlineCodes.length - 1}\uE003`;
    });

    // Tables parser
    const lines = html.split('\n');
    let inTable = false;
    let tableHeaders = [];
    let tableRows = [];
    let newLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            const cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
            if (!inTable) {
                const nextLine = lines[i+1] ? lines[i+1].trim() : '';
                if (nextLine.startsWith('|') && nextLine.includes('-')) {
                    inTable = true;
                    tableHeaders = cells;
                    i++; // skip separator
                    continue;
                }
            }
            if (inTable) {
                tableRows.push(cells);
                continue;
            }
        }

        if (inTable && !(line.startsWith('|') && line.endsWith('|'))) {
            newLines.push(renderTableHtml(tableHeaders, tableRows));
            inTable = false;
            tableHeaders = [];
            tableRows = [];
        }

        newLines.push(lines[i]);
    }

    if (inTable) {
        newLines.push(renderTableHtml(tableHeaders, tableRows));
    }

    html = newLines.join('\n');

    // Headers
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Bold & Italic
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

    // Lists
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li class="ol-item">$1</li>');

    html = html.replace(/(<li>.*<\/li>)/gs, (match) => {
        if (match.includes('ol-item')) {
            return `<ol>${match.replace(/ class="ol-item"/g, '')}</ol>`;
        } else {
            return `<ul>${match}</ul>`;
        }
    });

    // Line breaks (code blocks are placeholders here, so their inner newlines
    // are naturally exempt; tables/lists still need the split-exemption).
    const blocks = html.split(/(<div class="code-block-wrapper">[\s\S]*?<\/div>|<pre>[\s\S]*?<\/pre>|<table>[\s\S]*?<\/table>|<ul>[\s\S]*?<\/ul>|<ol>[\s\S]*?<\/ol>)/g);
    for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        if (!b.startsWith('<div class="code-block-wrapper"') && !b.startsWith('<pre') && !b.startsWith('<table') && !b.startsWith('<ul') && !b.startsWith('<ol')) {
            blocks[k] = b.replace(/\n/g, '<br>');
        }
    }
    html = blocks.join('');

    // ── Restore protected code (inline first — blocks may not contain them,
    // but the order is safe either way) ─────────────────────────────────
    html = html.replace(/\uE002(\d+)\uE003/g, (m, i) => inlineCodes[Number(i)] ?? m);
    html = html.replace(/\uE000(\d+)\uE001/g, (m, i) => codeBlocks[Number(i)] ?? m);

    return html;
}

export function renderTableHtml(headers, rows) {
    const headerHtml = headers.map(h => `<th>${h}</th>`).join('');
    const rowsHtml = rows.map(r => `<tr>${r.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap">
        <table>
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    </div>`;
}
