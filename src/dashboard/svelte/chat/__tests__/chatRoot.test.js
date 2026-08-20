// @vitest-environment jsdom
//
// The Chat shell, after migration. The turn is covered in
// views/chat/__tests__/chatLoop.test.js and attachments in
// views/chat/__tests__/chatAttachments.test.js; what is left here is the wiring
// the 1,700-line class used to hold together by element id.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const invoke = vi.fn(async () => null);
const onDragDropEvent = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
// LLMService registers a native-stream listener at IMPORT time; without this the
// real `listen` reaches for window.__TAURI_INTERNALS__ and rejects unhandled,
// even though every test injects its own llm.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => ({ onDragDropEvent: (...a) => onDragDropEvent(...a) }),
}));
vi.mock('../../../../modules/ai/McpManager.js', () => ({
    mcpManager: {
        clients: new Map(),
        serversConfig: { mcpServers: {} },
        loadConfig: vi.fn(async () => {}),
        startClient: vi.fn(async () => {}),
        getError: () => null,
    },
}));
vi.mock('../../../../modules/ai/PromptTemplateManager.js', () => ({
    promptTemplateManager: {
        loadFromConfig: vi.fn(),
        search: vi.fn(() => [{ key: 'review', label: 'Code review', prompt: 'Review this:' }]),
    },
}));
vi.mock('../../../../modules/ai/SkillManager.js', () => ({
    skillManager: {
        refresh: vi.fn(async () => {}),
        search: vi.fn(() => [{ name: 'excel', title: 'Excel helper' }]),
        readContent: vi.fn(async () => 'SKILL BODY'),
    },
}));

const ChatRoot = (await import('../ChatRoot.svelte')).default;

afterEach(() => cleanup());
beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? { mcp_servers: {} } : null));
});

const MODELS = [{ id: 'openai:gpt-4o', name: 'GPT-4o' }, { id: 'x:fast', name: 'Fast' }];

/** An llm stub that answers with `reply` after streaming it in one chunk. */
function llmOf(reply = 'Hello back.') {
    return {
        getCurrentModel: () => 'openai:gpt-4o',
        setCurrentModel: vi.fn(),
        async chat(_msgs, _sys, onChunk) { onChunk(reply); return { content: reply }; },
    };
}

const toolsOf = () => ({
    startSession: vi.fn(async () => {}),
    setToolAllowlist: vi.fn(),
    setMcpRelevanceQuery: vi.fn(),
    setMcpPruneOptions: vi.fn(),
    getToolsForNativeAPI: () => [],
    executeTool: vi.fn(async () => 'ok'),
    endSession: vi.fn(),
});

function mountRoot(props = {}) {
    const api = { getModels: vi.fn(async () => ({ models: MODELS })) };
    const confirmAction = vi.fn(() => true);
    const notify = vi.fn();
    const llm = props.llm || llmOf();
    const tools = props.tools || toolsOf();
    const utils = render(ChatRoot, { props: { api, confirmAction, notify, llm, tools, ...props } });
    return { ...utils, api, confirmAction, notify, llm, tools };
}

const typeInto = (el, value) => fireEvent.input(el, { target: { value } });
const box = (c) => c.querySelector('.chat-textarea');
const sendBtn = (c) => c.querySelector('.btn-chat-send');
const buttonSaying = (c, re) => [...c.querySelectorAll('button')].find(b => re.test(b.textContent));

/** Wait for the popup rows, which only exist once both searches have run. */
async function slashRows(container) {
    return waitFor(() => {
        const rows = [...container.querySelectorAll('.slash-popup-item')];
        expect(rows.length).toBeGreaterThan(0);
        return rows;
    });
}

describe('mounting', () => {
    it('lists the models the API returned and selects the current one', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.container.querySelectorAll('option').length).toBe(2));
        expect(h.container.querySelector('select').value).toBe('openai:gpt-4o');
    });

    // An unconfigured backend used to leave the picker empty, so sending did
    // nothing and gave no reason why.
    it('falls back to a static list when no models are configured', async () => {
        const h = mountRoot({ api: { getModels: vi.fn(async () => ({ models: [] })) } });
        await waitFor(() => expect(h.container.textContent).toMatch(/Fallback/));
    });

    it('starts with the empty state and a disabled send button', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.container.textContent).toMatch(/Start a conversation/));
        expect(sendBtn(h.container).disabled).toBe(true);
    });

    it('creates an active session so the first message has somewhere to go', async () => {
        mountRoot();
        await waitFor(() => expect(localStorage.getItem('direct_ai_sessions')).toBeTruthy());
        const store = JSON.parse(localStorage.getItem('direct_ai_sessions'));
        expect(store.activeSessionId).toBeTruthy();
        expect(store.sessions[store.activeSessionId].messages).toEqual([]);
    });
});

describe('sending', () => {
    it('shows the user message, then the reply', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'hi there');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.container.textContent).toMatch(/hi there/));
        await waitFor(() => expect(h.container.textContent).toMatch(/Hello back/));
    });

    it('clears the input once sent', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'hi');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(box(h.container).value).toBe(''));
    });

    it('persists the conversation and titles the session from the first message', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'what is a monad');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => {
            const store = JSON.parse(localStorage.getItem('direct_ai_sessions'));
            const s = store.sessions[store.activeSessionId];
            expect(s.title).toMatch(/what is a monad/);
            expect(s.messages.length).toBeGreaterThan(1);
        });
    });

    it('scopes the tools to web search with no agent-control tools', async () => {
        const tools = toolsOf();
        const h = mountRoot({ tools });
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'search something');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(tools.setToolAllowlist).toHaveBeenCalled());
        expect(tools.setToolAllowlist).toHaveBeenCalledWith(
            ['web_search', 'fetch_url'], { agentControl: false },
        );
        expect(tools.setMcpRelevanceQuery).toHaveBeenCalledWith('search something');
    });

    it('sends on Enter but not on Shift+Enter', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'one');
        await fireEvent.keyDown(box(h.container), { key: 'Enter', shiftKey: true });
        expect(h.container.textContent).not.toMatch(/Hello back/);
        await fireEvent.keyDown(box(h.container), { key: 'Enter' });
        await waitFor(() => expect(h.container.textContent).toMatch(/Hello back/));
    });

    // Enter with an IME composition open is the user picking a candidate, not
    // asking to send.
    it('does not send while an IME composition is open', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'にほんご');
        await fireEvent.keyDown(box(h.container), { key: 'Enter', isComposing: true });
        expect(h.container.textContent).not.toMatch(/Hello back/);
    });

    it('offers stop while generating, and aborts when pressed', async () => {
        const llm = {
            getCurrentModel: () => 'openai:gpt-4o',
            setCurrentModel: vi.fn(),
            chat: (_m, _s, _c, signal) => new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            }),
        };
        const h = mountRoot({ llm });
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'slow');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(sendBtn(h.container).classList.contains('btn-stop')).toBe(true));
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.container.textContent).toMatch(/stopped by user/));
    });
});

describe('the slash popup', () => {
    it('opens only when the whole input is a command', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'tell me about /review');
        expect(h.container.querySelector('.slash-popup')).toBeNull();
        await typeInto(box(h.container), '/rev');
        await waitFor(() => expect(h.container.querySelector('.slash-popup')).toBeTruthy());
    });

    it('inserts a template into the input', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/rev');
        const rows = await slashRows(h.container);
        await fireEvent.mouseDown(rows.find(r => /Code review/.test(r.textContent)));
        await waitFor(() => expect(box(h.container).value).toBe('Review this:'));
    });

    // A skill becomes a chip rather than being pasted in: the body is injected at
    // send time so the input box stays readable.
    it('attaches a skill as a chip, keeping what the user typed after it', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/excel summarise Q3');
        const rows = await slashRows(h.container);
        await fireEvent.mouseDown(rows.find(r => /Excel helper/.test(r.textContent)));
        await waitFor(() => expect(h.container.querySelector('.skill-chip')).toBeTruthy());
        expect(box(h.container).value).toBe('summarise Q3');
    });

    // Visibility is tracked separately from the row count: a query that matches
    // nothing still has to say so, which is the "/ shows nothing" symptom.
    it('still opens, saying nothing matched, when the query hits neither source', async () => {
        const { promptTemplateManager } = await import('../../../../modules/ai/PromptTemplateManager.js');
        const { skillManager } = await import('../../../../modules/ai/SkillManager.js');
        promptTemplateManager.search.mockReturnValueOnce([]);
        skillManager.search.mockReturnValueOnce([]);
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/zzzz');
        await waitFor(() => expect(h.container.querySelector('.slash-popup')).toBeTruthy());
        expect(h.container.textContent).toMatch(/No matching template or skill/);
    });

    // The predecessor swallowed Enter whenever the popup was open, so a command
    // that matched nothing left the user unable to send at all.
    it('lets Enter send when the open popup has nothing to choose', async () => {
        const { promptTemplateManager } = await import('../../../../modules/ai/PromptTemplateManager.js');
        const { skillManager } = await import('../../../../modules/ai/SkillManager.js');
        promptTemplateManager.search.mockReturnValueOnce([]);
        skillManager.search.mockReturnValueOnce([]);
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/nomatch');
        await waitFor(() => expect(h.container.querySelector('.slash-popup')).toBeTruthy());
        await fireEvent.keyDown(box(h.container), { key: 'Enter' });
        await waitFor(() => expect(h.container.textContent).toMatch(/Hello back/));
    });

    it('closes on Escape without sending', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/rev');
        await waitFor(() => expect(h.container.querySelector('.slash-popup')).toBeTruthy());
        await fireEvent.keyDown(box(h.container), { key: 'Escape' });
        await waitFor(() => expect(h.container.querySelector('.slash-popup')).toBeNull());
        expect(h.container.textContent).not.toMatch(/Hello back/);
    });

    it('sends the skill body to the model but not to the bubble', async () => {
        const seen = [];
        const llm = llmOf();
        llm.chat = async (msgs, _s, onChunk) => { seen.push(msgs); onChunk('ok'); return { content: 'ok' }; };
        const h = mountRoot({ llm });
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), '/excel do it');
        const rows = await slashRows(h.container);
        await fireEvent.mouseDown(rows.find(r => /Excel helper/.test(r.textContent)));
        await waitFor(() => expect(h.container.querySelector('.skill-chip')).toBeTruthy());
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(JSON.stringify(seen[0])).toContain('SKILL BODY');
        expect(h.container.querySelector('.chat-body').textContent).not.toContain('SKILL BODY');
    });
});

describe('sessions', () => {
    it('New Chat opens an empty conversation and keeps the old one', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'first');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.container.textContent).toMatch(/Hello back/));

        await fireEvent.click(buttonSaying(h.container, /New Chat/));
        await waitFor(() => expect(h.container.textContent).toMatch(/Start a conversation/));
        const store = JSON.parse(localStorage.getItem('direct_ai_sessions'));
        expect(Object.keys(store.sessions).length).toBe(2);
    });

    it('Clear Chat empties the current conversation after confirming', async () => {
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'something');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.container.textContent).toMatch(/Hello back/));

        await fireEvent.click(buttonSaying(h.container, /Clear Chat/));
        await waitFor(() => expect(h.container.textContent).toMatch(/Start a conversation/));
        expect(h.confirmAction).toHaveBeenCalled();
        const store = JSON.parse(localStorage.getItem('direct_ai_sessions'));
        expect(store.sessions[store.activeSessionId].messages).toEqual([]);
    });

    it('leaves the conversation alone when the confirm is declined', async () => {
        const h = mountRoot({ confirmAction: vi.fn(() => false) });
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'keep me');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.container.textContent).toMatch(/keep me/));
        await fireEvent.click(buttonSaying(h.container, /Clear Chat/));
        expect(h.container.textContent).toMatch(/keep me/);
    });

    it('opens the history modal and switches to a past chat', async () => {
        localStorage.setItem('direct_ai_sessions', JSON.stringify({
            activeSessionId: 'b',
            sessions: {
                a: { id: 'a', title: 'Older chat', timestamp: 1, messages: [{ role: 'user', content: 'from A' }] },
                b: { id: 'b', title: 'Newer chat', timestamp: 2, messages: [] },
            },
        }));
        const h = mountRoot();
        await waitFor(() => expect(buttonSaying(h.container, /History/)).toBeTruthy());
        await fireEvent.click(buttonSaying(h.container, /History/));
        const row = await waitFor(() => {
            const el = [...document.querySelectorAll('.ch-row, .ch-item, .ch-session')]
                .find(e => /Older chat/.test(e.textContent));
            expect(el).toBeTruthy();
            return el;
        });
        await fireEvent.click(row);
        await waitFor(() => expect(h.container.textContent).toMatch(/from A/));
    });
});

describe('settings panel', () => {
    it('is collapsed until asked for', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.container.querySelector('.chat-system-prompt-toggle')).toBeTruthy());
        expect(h.container.querySelector('.chat-system-prompt-panel')).toBeNull();
        await fireEvent.click(h.container.querySelector('.chat-system-prompt-toggle'));
        await waitFor(() => expect(h.container.querySelector('.chat-system-prompt-panel')).toBeTruthy());
        expect(h.container.textContent).toMatch(/System Prompt/);
    });

    it('says so when no MCP servers are configured', async () => {
        const h = mountRoot();
        await waitFor(() => expect(h.container.querySelector('.chat-system-prompt-toggle')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.chat-system-prompt-toggle'));
        await waitFor(() => expect(h.container.textContent).toMatch(/No MCP servers configured/));
    });

    // Toggling one checkbox used to call reRender(), which rebuilt the whole view —
    // and with it the textarea the user was typing in.
    it('keeps the draft when an MCP server is toggled', async () => {
        invoke.mockImplementation(async (cmd) =>
            (cmd === 'get_ai_config' ? { mcp_servers: { fs: { command: 'x' } } } : null));
        const h = mountRoot();
        await waitFor(() => expect(box(h.container)).toBeTruthy());
        await typeInto(box(h.container), 'half-written thought');
        await fireEvent.click(h.container.querySelector('.chat-system-prompt-toggle'));
        const cb = await waitFor(() => {
            const el = h.container.querySelector('.chat-mcp-checkbox');
            expect(el).toBeTruthy();
            return el;
        });
        await fireEvent.click(cb);
        await waitFor(() => expect(box(h.container).value).toBe('half-written thought'));
    });
});

describe('teardown', () => {
    it('releases the drag-drop listener', async () => {
        const unlisten = vi.fn();
        onDragDropEvent.mockImplementation(async () => unlisten);
        const h = mountRoot();
        await waitFor(() => expect(onDragDropEvent).toHaveBeenCalled());
        h.unmount();
        await waitFor(() => expect(unlisten).toHaveBeenCalled());
    });
});
