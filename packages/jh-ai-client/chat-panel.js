/**
 * <jh-ai-chat-panel> — drop-in Web Component for any JH client app.
 *
 * Usage:
 *   <jh-ai-chat-panel id="ai" mode="single_shot"></jh-ai-chat-panel>
 *
 *   <script type="module">
 *     import '@jh/ai-client/chat-panel.js';
 *     const panel = document.getElementById('ai');
 *     panel.client = myJhAiClient;                  // pre-configured JhAiClient
 *     panel.behaviors = {                           // app-specific behavior presets
 *       sqlGen:    { mode: 'single_shot', system_prompt: '...', response_format: 'code' },
 *       refactor:  { mode: 'iterative_agent', enabled_tools: null },
 *     };
 *     panel.context = () => ({ schema: getCurrentSchema() }); // dynamic context
 *   </script>
 *
 * The component has a built-in mode/behavior selector, message bubbles, and
 * approval prompts. Apps that want a deeply custom UI can ignore this and use
 * the JhAiClient class directly.
 */

const STYLES = `
:host {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0;
    background: #1a1d24;
}
.jh-toolbar {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #2a2e38;
    background: #1f232c;
    align-items: center;
}
.jh-toolbar label { font-size: 11px; color: #888; }
.jh-toolbar select {
    background: #14171c;
    border: 1px solid #2a2e38;
    color: #e0e0e0;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
}
.jh-toolbar .spacer { flex: 1; }
.jh-status {
    font-size: 11px;
    color: #888;
    padding: 2px 8px;
    border-radius: 4px;
    background: #14171c;
}
.jh-messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.jh-msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
}
.jh-msg.user {
    align-self: flex-end;
    background: #2a4a7a;
    color: #fff;
}
.jh-msg.ai {
    align-self: flex-start;
    background: #232831;
    border: 1px solid #2a2e38;
}
.jh-msg.system {
    align-self: center;
    background: transparent;
    color: #888;
    font-size: 11px;
    font-style: italic;
}
.jh-step {
    align-self: flex-start;
    font-size: 11px;
    color: #aaa;
    padding: 4px 10px;
    background: #14171c;
    border-left: 3px solid #4a8ab8;
    border-radius: 0 4px 4px 0;
    max-width: 85%;
}
.jh-input-row {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid #2a2e38;
    background: #1f232c;
}
.jh-input-row textarea {
    flex: 1;
    background: #14171c;
    border: 1px solid #2a2e38;
    color: #e0e0e0;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
    resize: none;
    min-height: 36px;
    max-height: 120px;
    outline: none;
}
.jh-input-row textarea:focus { border-color: #4a8ab8; }
.jh-input-row button {
    background: #4a8ab8;
    border: none;
    color: #fff;
    padding: 0 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
}
.jh-input-row button:hover { background: #5a9ac8; }
.jh-input-row button:disabled { background: #444; cursor: not-allowed; }
.jh-input-row button.abort { background: #b85a4a; }
.jh-confirm {
    align-self: stretch;
    margin: 4px 0;
    padding: 12px;
    background: #2a2419;
    border: 1px solid #b8884a;
    border-radius: 6px;
}
.jh-confirm h4 { margin: 0 0 6px 0; font-size: 13px; color: #f0c070; }
.jh-confirm pre {
    background: #14171c;
    padding: 6px 8px;
    border-radius: 4px;
    margin: 6px 0;
    font-size: 11px;
    overflow-x: auto;
    color: #ccc;
}
.jh-confirm-buttons { display: flex; gap: 8px; margin-top: 8px; }
.jh-confirm-buttons button {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}
.jh-confirm-buttons .approve { background: #4a8a4a; color: #fff; }
.jh-confirm-buttons .reject  { background: #8a4a4a; color: #fff; }
`;

class JhAiChatPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._client = null;
        this._behaviors = { default: {} };
        this._context = null;
        this._activeBehavior = 'default';
        this._currentTask = null;
        this._pendingApprovals = new Map();
    }

    /** Pre-configured JhAiClient instance (caller must call .ready() first if needed). */
    set client(c) { this._client = c; }
    get client() { return this._client; }

    /**
     * Behavior presets registered by the host app. Object map of
     *   { presetName: behaviorObject }
     * The first key is selected by default.
     */
    set behaviors(b) {
        this._behaviors = b && Object.keys(b).length ? b : { default: {} };
        this._activeBehavior = Object.keys(this._behaviors)[0];
        this._refreshToolbar();
    }
    get behaviors() { return this._behaviors; }

    /**
     * Either a context object or a function returning a context object.
     * Re-evaluated on every send (so the host can dynamically inject the
     * current schema, file, etc.).
     */
    set context(c) { this._context = c; }
    get context() {
        return typeof this._context === 'function' ? this._context() : this._context;
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>${STYLES}</style>
            <div class="jh-toolbar">
                <label>Behavior</label>
                <select id="behaviorSelect"></select>
                <span class="spacer"></span>
                <span class="jh-status" id="status">idle</span>
            </div>
            <div class="jh-messages" id="messages"></div>
            <div class="jh-input-row">
                <textarea id="input" placeholder="Type your request… (Enter to send, Shift+Enter for newline)"></textarea>
                <button id="sendBtn">Send</button>
            </div>
        `;

        const sendBtn = this.shadowRoot.getElementById('sendBtn');
        const input = this.shadowRoot.getElementById('input');
        const select = this.shadowRoot.getElementById('behaviorSelect');

        sendBtn.addEventListener('click', () => this._send());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._send();
            }
        });
        select.addEventListener('change', (e) => {
            this._activeBehavior = e.target.value;
        });

        this._refreshToolbar();
    }

    _refreshToolbar() {
        if (!this.shadowRoot) return;
        const select = this.shadowRoot.getElementById('behaviorSelect');
        if (!select) return;
        select.innerHTML = '';
        for (const name of Object.keys(this._behaviors)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === this._activeBehavior) opt.selected = true;
            select.appendChild(opt);
        }
    }

    _setStatus(text) {
        const s = this.shadowRoot.getElementById('status');
        if (s) s.textContent = text;
    }

    _appendMessage(role, content) {
        const msgs = this.shadowRoot.getElementById('messages');
        const el = document.createElement('div');
        el.className = `jh-msg ${role}`;
        el.textContent = content;
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
        return el;
    }

    _appendStep(text) {
        const msgs = this.shadowRoot.getElementById('messages');
        const el = document.createElement('div');
        el.className = 'jh-step';
        el.textContent = text;
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
    }

    async _send() {
        if (!this._client) {
            this._appendMessage('system', 'Error: client not configured.');
            return;
        }
        if (this._currentTask) {
            // Abort instead of double-sending
            try { this._currentTask.abort?.(); } catch (_) {}
            this._currentTask = null;
            this._setStatus('aborted');
            this.shadowRoot.getElementById('sendBtn').textContent = 'Send';
            this.shadowRoot.getElementById('sendBtn').classList.remove('abort');
            return;
        }

        const input = this.shadowRoot.getElementById('input');
        const prompt = input.value.trim();
        if (!prompt) return;
        input.value = '';

        this._appendMessage('user', prompt);
        const aiBubble = this._appendMessage('ai', '…');

        const behavior = this._behaviors[this._activeBehavior] || {};
        const ctx = this.context;

        const sendBtn = this.shadowRoot.getElementById('sendBtn');
        sendBtn.textContent = 'Abort';
        sendBtn.classList.add('abort');
        this._setStatus('running');

        try {
            if ((behavior.mode || 'single_shot') === 'single_shot') {
                const result = await this._client.invoke({ prompt, behavior, context: ctx });
                aiBubble.textContent = result.content || '(no response)';
            } else {
                const task = this._client.invokeAgent({
                    prompt, behavior, context: ctx,
                    onStep: (pkt) => {
                        if (pkt.event === 'thought' && pkt.data?.text) {
                            this._appendStep('💭 ' + String(pkt.data.text).slice(0, 200));
                        } else if (pkt.event === 'tool_call' && pkt.data?.name) {
                            this._appendStep('⚙ ' + pkt.data.name);
                        } else if (pkt.event === 'status' && pkt.data?.message) {
                            this._setStatus(pkt.data.message.slice(0, 60));
                        }
                    },
                    onConfirm: (req) => this._renderConfirm(req),
                });
                this._currentTask = task;
                const result = await task.completed;
                aiBubble.textContent = result.content || '(complete)';
            }
            this._setStatus('done');
        } catch (err) {
            aiBubble.textContent = '❌ ' + (err.message || String(err));
            this._setStatus('error');
        } finally {
            this._currentTask = null;
            sendBtn.textContent = 'Send';
            sendBtn.classList.remove('abort');
        }
    }

    _renderConfirm(req) {
        return new Promise((resolve) => {
            const msgs = this.shadowRoot.getElementById('messages');
            const box = document.createElement('div');
            box.className = 'jh-confirm';
            box.innerHTML = `
                <h4>${req.type === 'command_confirm' ? '🛡 Command Approval'
                    : req.type === 'plan_review' ? '📋 Plan Approval'
                    : '📝 File Modification Approval'}</h4>
                <div>${req.message ? escapeHtml(req.message) : ''}</div>
                ${req.command ? `<pre>${escapeHtml(req.command)}</pre>` : ''}
                ${req.path ? `<div style="font-size:11px;color:#aaa;margin-top:4px;">${escapeHtml(req.path)}</div>` : ''}
                <div class="jh-confirm-buttons">
                    <button class="approve">Approve</button>
                    <button class="reject">Reject</button>
                </div>
            `;
            box.querySelector('.approve').addEventListener('click', () => {
                box.querySelector('.jh-confirm-buttons').innerHTML = '<span style="color:#4a8a4a">✅ Approved</span>';
                resolve(true);
            });
            box.querySelector('.reject').addEventListener('click', () => {
                box.querySelector('.jh-confirm-buttons').innerHTML = '<span style="color:#8a4a4a">❌ Rejected</span>';
                resolve(false);
            });
            msgs.appendChild(box);
            msgs.scrollTop = msgs.scrollHeight;
        });
    }
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

customElements.define('jh-ai-chat-panel', JhAiChatPanel);

export { JhAiChatPanel };
