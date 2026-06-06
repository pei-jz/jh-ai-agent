// chatMarkdown — pure string→HTML helpers extracted from ChatView (Part A
// refactor). These render chat message content: HTML escaping, <think> block
// formatting, a lightweight markdown→HTML pass (code blocks, tables, headers,
// lists, emphasis), and table rendering. No DOM access — pure functions, so
// they're unit-tested directly (see chatMarkdown.test.js).

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

    // Code blocks with syntax highlighting layout
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<div class="code-block-wrapper">
            <div class="code-block-header">
                <span class="code-block-lang">${lang || 'code'}</span>
                <button class="btn-copy-code" type="button">Copy</button>
            </div>
            <pre><code class="language-${lang}">${code.trim()}</code></pre>
        </div>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

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

    // Line breaks
    const blocks = html.split(/(<div class="code-block-wrapper">[\s\S]*?<\/div>|<pre>[\s\S]*?<\/pre>|<table>[\s\S]*?<\/table>|<ul>[\s\S]*?<\/ul>|<ol>[\s\S]*?<\/ol>)/g);
    for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        if (!b.startsWith('<div class="code-block-wrapper"') && !b.startsWith('<pre') && !b.startsWith('<table') && !b.startsWith('<ul') && !b.startsWith('<ol')) {
            blocks[k] = b.replace(/\n/g, '<br>');
        }
    }
    html = blocks.join('');

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
