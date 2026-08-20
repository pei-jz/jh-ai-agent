// apiCallView — turning one logged LLM/tool call into the tabs the inspector shows.
//
// Extracted from MonitorView._showChatModal, a 195-line method that built the
// whole dialog as one `entries.map(...).join('')` innerHTML string and then
// re-queried its own output twice to attach a listener per sub-tab and per copy
// button. The decisions in there — which tabs exist for this entry, which one
// opens first, how a message array reads — are what this module owns.
//
// It also drops `fmtPayload`, a 35-line formatter that was left behind when the
// single payload dump became the tab set. Nothing had called it since.

/**
 * Raw LLM envelopes arrive with "\n" and "\t" as literal two-character escapes.
 * Left alone they make a <pre> panel one unreadable line.
 */
export function unescapeNewlines(s) {
    return typeof s === 'string'
        ? s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        : s;
}

/** Longest single message shown before it is cut — a full history is megabytes. */
export const MAX_MESSAGE_CHARS = 4000;

/** A conversation array as readable text. */
export function formatMessages(arr, label) {
    let out = `=== ${label} (${arr.length} messages) ===\n`;
    arr.forEach((msg, i) => {
        const role = msg.role || 'unknown';
        const raw = typeof msg.content === 'string'
            ? msg.content.substring(0, MAX_MESSAGE_CHARS)
                + (msg.content.length > MAX_MESSAGE_CHARS ? '\n…(truncated)' : '')
            : JSON.stringify(msg.content, null, 2);
        out += `──── [${i}] ${role} ────\n${unescapeNewlines(raw)}\n\n`;
    });
    return out;
}

/** A value that may already be an object, or a JSON string, or neither. */
function asObject(v) {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
    return {};
}

/**
 * Header names whose value is a credential.
 *
 * ai.rs already destroys these before they leave the process — that is where the
 * secret actually lives, and redacting at the source is what makes it impossible
 * to forget. This is the second layer: the modal is what a user screenshots or
 * screen-shares, so anything reaching this file that still LOOKS like a
 * credential is masked again rather than trusted.
 */
const SECRET_HEADERS = new Set([
    'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie', 'proxy-authorization',
]);

/** A value that has clearly not been redacted yet. */
function looksSecret(value) {
    const v = String(value ?? '');
    // Already-redacted values arrive as "Bearer ****  (set)" / "****  (set)".
    return v.includes('****') ? false : v.trim().length > 0;
}

/**
 * Headers as they can safely be shown: names intact, credential values masked.
 *
 * The name and the auth SCHEME are the useful parts — "did a key get attached,
 * and as what" — and they survive.
 */
export function redactHeaders(headers) {
    const src = headers && typeof headers === 'object' ? headers : {};
    const out = {};
    for (const [name, value] of Object.entries(src)) {
        if (SECRET_HEADERS.has(String(name).toLowerCase()) && looksSecret(value)) {
            const scheme = String(value).split(/\s+/)[0] || '';
            out[name] = /^(bearer|basic)$/i.test(scheme) ? `${scheme} ****  (set)` : '****  (set)';
        } else {
            out[name] = value;
        }
    }
    return out;
}

/** Keys that get their own tab, so they are not repeated in Params. */
const OWN_TAB = ['system_prompt', 'history', 'messages', 'tools', 'url', 'headers', 'sent_request'];

/**
 * The tabs for one call, and which of them opens.
 *
 * Only tabs with content are offered — an empty "Tools" tab is a dead end. The
 * as-SENT body opens by default when it exists: it is the request as actually
 * thrown at the provider (cache_control markers, the stable/volatile system
 * split, messages in send order), which is what you came here to read. History
 * is the fallback.
 *
 * @returns {{tabs: Array<{key,label,content}>, defaultIndex: number}}
 */
export function apiCallTabs(entry = {}) {
    const r = asObject(entry.request);
    const tabs = [];

    const sent = r.sent_request != null
        ? (typeof r.sent_request === 'string' ? r.sent_request : JSON.stringify(r.sent_request, null, 2))
        : '';
    if (sent) tabs.push({ key: 'sent', label: '📡 Sent (raw)', content: sent });

    // Scalar request parameters — model, tool_calling, temperature, max_tokens.
    // An empty string is dropped: native tool calling emits `thought: ""`.
    const params = {};
    for (const k of Object.keys(r)) {
        if (OWN_TAB.includes(k)) continue;
        if (typeof r[k] === 'string' && r[k].trim() === '') continue;
        params[k] = r[k];
    }
    if (Object.keys(params).length) {
        tabs.push({ key: 'params', label: '⚙ Params', content: JSON.stringify(params, null, 2) });
    }

    if (typeof r.system_prompt === 'string' && r.system_prompt) {
        tabs.push({ key: 'system', label: '🧾 System (pre-assembly)', content: r.system_prompt });
    }

    const history = Array.isArray(r.history) ? r.history : (Array.isArray(r.messages) ? r.messages : null);
    if (history) {
        tabs.push({ key: 'history', label: `💬 History (${history.length})`, content: formatMessages(history, 'history') });
    }

    if (Array.isArray(r.tools)) {
        tabs.push({ key: 'tools', label: `🛠 Tools (${r.tools.length})`, content: JSON.stringify(r.tools, null, 2) });
    }

    // Always present: a call with neither a response nor an error still has to
    // show something, or the entry looks like it never happened.
    const response = unescapeNewlines(typeof entry.response === 'string'
        ? entry.response
        : (entry.response ? JSON.stringify(entry.response, null, 2) : (entry.error || '')));
    tabs.push({ key: 'response', label: '📤 Response', content: response || '(empty)' });

    // The request headers as sent. Empty for a call that never left, so the tab
    // stays absent rather than showing "{}".
    const headers = redactHeaders(entry.headers);
    if (Object.keys(headers).length) {
        tabs.push({ key: 'headers', label: '🔖 Headers', content: JSON.stringify(headers, null, 2) });
    }

    const sentAt = tabs.findIndex(t => t.key === 'sent');
    const historyAt = tabs.findIndex(t => t.key === 'history');
    return { tabs, defaultIndex: Math.max(0, sentAt >= 0 ? sentAt : historyAt) };
}

/** The one-line summary above a call's tabs. */
export function callHeadline(entry = {}) {
    const u = entry.usage;
    const cacheRead = u?.cache_read_input_tokens || 0;
    const cacheWrite = u?.cache_creation_input_tokens || 0;
    return {
        method: entry.method === 'TOOL' ? `TOOL:${entry.name}` : (entry.method || 'CHAT'),
        status: entry.status || ((entry.status || 200) >= 400 || entry.error ? 'ERR' : 200),
        isError: (entry.status || 200) >= 400 || !!entry.error,
        stepLabel: entry.stepLabel || '',
        duration: entry.duration || 0,
        usage: u
            ? `↑${u.prompt_tokens || 0}`
                + (cacheRead > 0 ? ` (cached ${cacheRead})` : '')
                + (cacheWrite > 0 ? ` (+cache ${cacheWrite})` : '')
                + ` / ↓${u.completion_tokens || 0} / total: ${u.total_tokens || 0} tokens`
            : '',
    };
}

/** The dialog's title: how many calls, and what they cost together. */
export function callsTitle(entries = []) {
    const sum = (f) => entries.reduce((s, c) => s + (f(c) || 0), 0);
    const prompt = sum(c => c.usage?.prompt_tokens);
    const completion = sum(c => c.usage?.completion_tokens);
    const ms = sum(c => c.duration);
    return `🔌 API Calls (${entries.length}) · ↑${prompt}t ↓${completion}t · ${ms}ms total`;
}

/**
 * Which entries need their full payload fetched before the dialog can show them.
 *
 * Listing and replay strip `history` / `system_prompt` / `sent_request` / `tools`
 * from every entry — without that the payload is O(steps²) and a long task's log
 * is unusable. The full record is fetched only for the calls actually opened.
 */
export function slimEntries(entries = []) {
    return entries.filter(e => e?.request?._slim && Number.isFinite(e?._idx));
}
