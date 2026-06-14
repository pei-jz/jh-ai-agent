// mock-jheditor-server.js — minimal JHEditor MOCK for end-to-end PoC testing.
//
// Lets you verify the JHAI "AI Hub" (Part A/B) without running the real JHEditor:
// it dials JHAI's outbound MCP WebSocket (`/mcp/ws?app=jheditor&token=…`), acts
// as the MCP SERVER, and registers the same tools the real JHEditor adapter does
// (get_buffer / get_selection / list_open_files). Once connected, those tools
// EXIST for JHAI's LLM, so an intent like `summarize_logs` can actually call
// get_buffer and return a real result.
//
// Usage (Node 18+; Node 22 has global WebSocket/fetch — `ws` is used as fallback):
//   node examples/mock-jheditor-server.js
//   node examples/mock-jheditor-server.js --buffer ./examples/sample.log
//   node examples/mock-jheditor-server.js --url http://127.0.0.1:14300 --token <tok>
//
// Connection is resolved in this order:
//   1. --url / --token CLI flags
//   2. JHAI_URL / JHAI_TOKEN env vars
//   3. the standard JH connection file written by JHAI's "Export Connection":
//        Windows  %APPDATA%\JH\ai-connection.json
//        macOS    $HOME/Library/Application Support/JH/ai-connection.json
//        Linux    $XDG_CONFIG_HOME|$HOME/.config/JH/ai-connection.json
//
// After it connects, trigger a task from JHAI (or any client) scoped to this app,
// e.g. behavior.mcp_servers=["jheditor"] + intent summarize_logs. The tool calls
// and their arguments are printed here so you can watch the round-trip.

import { createJhaiAdapter } from '../sdk/jhai-adapter.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) { out[key] = next; i++; }
            else out[key] = true;
        }
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));

// ── Connection resolution ──────────────────────────────────────────────────────
function standardConfigPaths() {
    const home = os.homedir();
    const list = [];
    if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'JH', 'ai-connection.json'));
    list.push(path.join(home, 'Library', 'Application Support', 'JH', 'ai-connection.json'));
    if (process.env.XDG_CONFIG_HOME) list.push(path.join(process.env.XDG_CONFIG_HOME, 'JH', 'ai-connection.json'));
    list.push(path.join(home, '.config', 'JH', 'ai-connection.json'));
    return list;
}

function resolveConnection() {
    // 1. CLI flags
    if (args.url && args.token) {
        return { jhaiBaseUrl: String(args.url), authToken: String(args.token), source: 'cli' };
    }
    // 2. Env
    if (process.env.JHAI_URL && process.env.JHAI_TOKEN) {
        return { jhaiBaseUrl: process.env.JHAI_URL, authToken: process.env.JHAI_TOKEN, source: 'env' };
    }
    // 3. Standard config file
    for (const p of standardConfigPaths()) {
        try {
            if (!fs.existsSync(p)) continue;
            const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (cfg && cfg.token && cfg.port) {
                const host = cfg.host || '127.0.0.1';
                return { jhaiBaseUrl: `http://${host}:${cfg.port}`, authToken: cfg.token, source: p };
            }
        } catch (_) { /* try next */ }
    }
    return null;
}

// ── Sample buffer (used when --buffer is not given) ─────────────────────────────
const SAMPLE_LOG = [
    '2026-06-05 09:58:31 INFO  app started (v1.4.2)',
    '2026-06-05 10:00:05 WARN  cache miss for key=user:42',
    '2026-06-05 10:01:12 ERROR failed to connect db (timeout after 5000ms)',
    '2026-06-05 10:01:13 INFO  retrying db connection (attempt 1/3)',
    '2026-06-05 10:01:18 INFO  db connection established',
    '2026-06-05 10:14:02 WARN  slow query 1320ms: SELECT * FROM orders',
    '2026-06-05 11:03:44 ERROR unhandled rejection in worker #3',
    '2026-06-05 11:03:45 INFO  worker #3 restarted',
    '2026-06-05 12:30:10 INFO  scheduled backup completed (842 MB)',
    '2026-06-05 13:45:59 WARN  disk usage 86% on /var',
    '',
].join('\n');

function loadBuffer() {
    if (args.buffer && typeof args.buffer === 'string') {
        try {
            return fs.readFileSync(path.resolve(args.buffer), 'utf8');
        } catch (e) {
            console.warn(`[mock] could not read --buffer ${args.buffer}: ${e.message}; using sample`);
        }
    }
    return SAMPLE_LOG;
}

// ── WebSocket impl (global on Node 22; fall back to `ws`) ────────────────────────
async function resolveWebSocketImpl() {
    if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
    try {
        const mod = await import('ws');
        return mod.default || mod.WebSocket;
    } catch (_) {
        throw new Error('No WebSocket available. Use Node 22+ or `npm i ws`.');
    }
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
    const conn = resolveConnection();
    if (!conn) {
        console.error(
            '[mock] No connection settings found.\n' +
            '  Pass --url http://127.0.0.1:<port> --token <tok>,\n' +
            '  set JHAI_URL / JHAI_TOKEN, or run JHAI → Settings → General → "Export Connection".'
        );
        process.exit(1);
    }
    console.log(`[mock] JHAI = ${conn.jhaiBaseUrl}  (source: ${conn.source})`);

    const WebSocketImpl = await resolveWebSocketImpl();
    const ai = createJhaiAdapter({
        app: 'jheditor',
        jhaiBaseUrl: conn.jhaiBaseUrl,
        authToken: conn.authToken,
        WebSocketImpl,
    });
    ai.onLog = (m) => console.log(m);

    let buffer = loadBuffer();
    const docId = args.buffer ? path.resolve(args.buffer) : 'mock://sample.log';

    // Tools — mirror src/modules/ai/JhAiMcp.js in the real JHEditor.
    ai.registerTool({
        name: 'get_buffer',
        description: '現在 JHEditor で編集中のドキュメント全文(プレーンテキスト)を返す。',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async (_args, ctx) => {
            console.log(`[mock] → get_buffer  (ctx.documentId=${ctx && ctx.documentId})`);
            return { content: [{ type: 'text', text: buffer }] };
        },
    });
    ai.registerTool({
        name: 'get_selection',
        description: '現在エディタで選択されているテキストを返す(選択がなければ空文字)。',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            console.log('[mock] → get_selection');
            return { content: [{ type: 'text', text: '' }] };
        },
    });
    ai.registerTool({
        name: 'list_open_files',
        description: '現在開いているタブ(ファイル)の一覧を JSON で返す。',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            console.log('[mock] → list_open_files');
            const list = [{ path: docId, isDirty: false, active: true }];
            return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
        },
    });

    ai.setContextProvider(() => ({ app: 'jheditor', documentId: docId }));

    await ai.start();
    console.log('[mock] connected as "jheditor" — tools: get_buffer, get_selection, list_open_files');
    console.log('[mock] waiting for tool calls from JHAI… (Ctrl+C to quit)');

    // Optional: self-drive the PoC end-to-end if --run-intent is passed. Requires
    // the LLM-side task pipeline (a configured provider) on JHAI to be ready.
    if (args['run-intent']) {
        const intentId = typeof args['run-intent'] === 'string' ? args['run-intent'] : 'summarize_logs';
        // Register the intent locally so runIntent can resolve it to an inline object.
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
        ai.onResult('markdown', (payload) => {
            console.log('\n[mock] ===== RESULT (markdown) =====\n' + (payload.md || payload.markdown || '') + '\n=====');
        });
        console.log(`[mock] running intent "${intentId}"…`);
        try {
            const env = await ai.runIntent(intentId, { prompt: 'このドキュメントのログを集計して' });
            console.log('[mock] intent finished. envelope kind=', env && env.kind);
        } catch (e) {
            console.error('[mock] intent failed:', e.message);
        }
    }

    const shutdown = () => { console.log('\n[mock] shutting down'); ai.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('[mock] fatal:', e); process.exit(1); });
