// jheditor-adapter.example.js — MINIMAL JHEditor ↔ JHAI integration (Part B PoC).
//
// This is a REFERENCE TEMPLATE to copy into the JHEditor app. It shows the
// smallest useful integration: connect to JHAI, expose ONE tool (`get_buffer`),
// declare ONE intent (`summarize_logs`), and render the `markdown` result with
// an "insert into document" action.
//
// Replace the `editor` shim below with JHEditor's real editor API. Everything
// else is the standard SDK usage from docs/design/ai-hub-client-adapter-sdk.md.
//
// Usage in JHEditor:
//   import { initJhEditorAi } from './jheditor-adapter.example.js';
//   const ai = await initJhEditorAi({ jhaiBaseUrl, authToken, editor, ui });
//   summarizeLogsButton.onclick = () => ai.runIntent('summarize_logs',
//       { prompt: '現在のドキュメントのログを集計して' });

import { createJhaiAdapter } from '../sdk/jhai-adapter.js';

/**
 * @param {object} deps
 * @param {string} deps.jhaiBaseUrl  e.g. "http://127.0.0.1:8123" (JHAI server)
 * @param {string} deps.authToken    JHAI connection token
 * @param {object} deps.editor       JHEditor API: { activeDocumentId(), getText(docId), insertAtCursor(text) }
 * @param {object} deps.ui           JHEditor UI: { showMarkdownPanel(md, actions) }
 */
export async function initJhEditorAi({ jhaiBaseUrl, authToken, editor, ui }) {
    const ai = createJhaiAdapter({ app: 'jheditor', jhaiBaseUrl, authToken });
    ai.onLog = (m) => console.debug(m);

    // ── 1) Tool: return the buffer currently being edited ────────────────────
    ai.registerTool({
        name: 'get_buffer',
        description: '現在 JHEditor で編集中のドキュメント全文(プレーンテキスト)を返す。',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        // ctx.documentId comes from behavior.mcp_context (_meta.jhai) — the live doc.
        handler: async (_args, ctx) => {
            const docId = ctx.documentId || editor.activeDocumentId();
            const text = editor.getText(docId);
            return { content: [{ type: 'text', text: text ?? '' }] };
        },
    });

    // ── 2) Intent: log aggregation → markdown result ─────────────────────────
    ai.registerIntent({
        id: 'summarize_logs',
        title: 'ログ集計',
        systemPrompt:
            'あなたは編集中ドキュメントのログを集計するアシスタントです。' +
            'まず get_buffer で本文を取得し、件数・時間帯・カテゴリ等を集計して、' +
            '読みやすい Markdown の表で結果をまとめてください。',
        tools: ['get_buffer'],
        resultKind: 'markdown',
    });

    // ── 3) Live context: which document the request targets ──────────────────
    ai.setContextProvider(() => ({
        app: 'jheditor',
        documentId: editor.activeDocumentId(),
    }));

    // ── 4) Render the markdown result + offer "insert into document" ─────────
    ai.onResult('markdown', (payload, actions) => {
        ui.showMarkdownPanel(payload.md, actions);
    });
    ai.registerActionHandler('insertMarkdown', (apply) => {
        editor.insertAtCursor(apply.text);
    });

    // ── 5) Connect (outbound WS = registration; no inbound server) ───────────
    await ai.start();
    return ai;
}

// ─────────────────────────────────────────────────────────────────────────────
// Example editor/ui shims (DELETE — replace with JHEditor's real APIs).
// Shown only so the file reads as a complete, runnable reference.
// ─────────────────────────────────────────────────────────────────────────────
export const exampleEditorShim = {
    _docs: { 'doc-1': '2026-06-05 10:00 INFO start\n2026-06-05 10:01 ERROR boom\n' },
    _active: 'doc-1',
    activeDocumentId() { return this._active; },
    getText(docId) { return this._docs[docId] || ''; },
    insertAtCursor(text) { this._docs[this._active] += '\n' + text; },
};
export const exampleUiShim = {
    showMarkdownPanel(md, actions) {
        console.log('--- AI result (markdown) ---\n' + md);
        console.log('actions:', actions.map(a => a.label).join(', '));
    },
};
