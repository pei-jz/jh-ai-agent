// @vitest-environment jsdom
//
// ChatMessage / ChatMessages — region 6 of the Svelte migration.
//
// What these replaced was the hot path: on every message push during generation,
// `_appendLastMessage` built a detached <div>, set its innerHTML from a string
// renderer, took `firstElementChild`, appended it and scrolled. The empty-state
// placeholder had to be removed by hand first, and `_appendSystemMessage` was a
// near-duplicate that injected transient notices straight into the DOM — where any
// re-render silently dropped them.
//
// The properties pinned here are the ones that shape mattered for: that appending
// leaves existing bubbles alone, that a failed tool result stays visible, and that a
// notice's lifetime is explicit.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ChatMessage from '../ChatMessage.svelte';
import ChatMessages from '../ChatMessages.svelte';

afterEach(() => cleanup());

/** Markdown stand-ins: distinguishable, so we can see which path ran. */
const md = (t) => `<p class="assistant">${String(t ?? '')}</p>`;
const umd = (t) => `<p class="user">${String(t ?? '')}</p>`;

const one = (msg) => render(ChatMessage, {
    props: { msg, renderMarkdown: md, renderUserMarkdown: umd },
}).container;
const many = (props) => render(ChatMessages, {
    props: { renderMarkdown: md, renderUserMarkdown: umd, ...props },
}).container;

describe('ChatMessage — user and assistant bubbles', () => {
    it('renders a user turn through the USER markdown path', () => {
        // The two paths differ: the assistant's unwraps tool-call envelopes.
        const el = one({ role: 'user', content: 'hello' });
        expect(el.querySelector('.msg-user')).not.toBe(null);
        expect(el.querySelector('p.user').textContent).toBe('hello');
    });

    it('prefers displayContent for a user turn', () => {
        // The raw content can carry an expanded skill/template body; the display copy
        // is what was actually typed.
        const el = one({ role: 'user', content: 'EXPANDED', displayContent: '/deploy' });
        expect(el.textContent).toContain('/deploy');
        expect(el.textContent).not.toContain('EXPANDED');
    });

    it('renders an assistant turn through the ASSISTANT markdown path', () => {
        const el = one({ role: 'assistant', content: 'sure' });
        expect(el.querySelector('.msg-ai')).not.toBe(null);
        expect(el.querySelector('p.assistant').textContent).toBe('sure');
    });

    it('marks an error turn', () => {
        const el = one({ role: 'assistant', content: 'boom', isError: true });
        expect(el.querySelector('.message-bubble').classList.contains('is-error')).toBe(true);
        expect(el.querySelector('.message-content').classList.contains('is-error')).toBe(true);
    });
});

describe('ChatMessage — attachments', () => {
    it('shows image thumbnails, zoomable via the container handler', () => {
        const el = one({ role: 'user', content: '', images: ['data:image/png;base64,A', 'data:image/png;base64,B'] });
        expect(el.querySelectorAll('.chat-zoomable-img')).toHaveLength(2);
    });

    it('shows attached files with a readable size', () => {
        const el = one({ role: 'user', content: '', files: [{ name: 'log.txt', size: 2048 }] });
        expect(el.textContent).toContain('log.txt');
        expect(el.textContent).toContain('2.0 KB');
    });

    it('shows the skills a turn carried', () => {
        const el = one({ role: 'user', content: '', skills: [{ name: 'deploy', title: 'Ship it' }] });
        expect(el.querySelector('.skill-chip').textContent).toContain('Ship it');
    });

    it('falls back to the skill NAME when it has no title', () => {
        const el = one({ role: 'user', content: '', skills: [{ name: 'deploy' }] });
        expect(el.querySelector('.skill-chip').textContent).toContain('deploy');
    });

    it('shows the agent turn stats, sharing the Monitor chip formatter', () => {
        const el = one({ role: 'assistant', content: 'done', resultStats: { steps: 4, tokens: 2000 } });
        expect(el.textContent).toContain('4 steps');
        expect(el.textContent).toContain('2.0k tok');
    });

    it('does NOT show stats on a user turn', () => {
        const el = one({ role: 'user', content: 'x', resultStats: { steps: 4 } });
        expect(el.textContent).not.toContain('4 steps');
    });

    it('escapes a hostile file name', () => {
        const el = one({ role: 'user', content: '', files: [{ name: '<img src=x>', size: 1 }] });
        expect(el.querySelector('img')).toBe(null);
    });
});

describe('ChatMessage — tool activity', () => {
    const call = {
        isToolCall: true,
        toolCalls: [{ name: 'web_search', args: { query: 'svelte 5 runes' } }],
    };

    it('reads as one line naming the tools, with the args folded away', () => {
        const el = one(call);
        expect(el.textContent).toContain('Using tools to research');
        expect(el.textContent).toContain('web_search');
        // Closed by default: simple chat should read like a conversation.
        expect(el.querySelector('.chat-tool-details').open).toBe(false);
    });

    it('keeps the raw args available for debugging', () => {
        expect(one(call).querySelector('.chat-tool-arg pre').textContent).toContain('svelte 5 runes');
    });

    it('says "tools" when a call carries no names', () => {
        expect(one({ isToolCall: true, toolCalls: [] }).textContent).toContain('tools');
    });

    it('collapses a SUCCESSFUL result to a count', () => {
        const el = one({
            isToolResult: true,
            results: [{ tool_call_name: 'web_search', result: 'ok' }],
        });
        expect(el.textContent).toContain('Research data retrieved (1)');
        expect(el.querySelector('.chat-tool-result').classList.contains('is-error')).toBe(false);
    });

    it('keeps a FAILED result visibly marked', () => {
        // A folded-away failed lookup is how a wrong answer gets trusted.
        const el = one({
            isToolResult: true,
            results: [{ tool_call_name: 'web_search', result: 'Error: network down' }],
        });
        expect(el.textContent).toContain('Tool returned an error');
        expect(el.querySelector('.chat-tool-result').classList.contains('is-error')).toBe(true);
        expect(el.querySelector('.chat-tool-res-name').classList.contains('is-error')).toBe(true);
    });

    it('serialises a non-string result rather than printing [object Object]', () => {
        const el = one({ isToolResult: true, results: [{ tool_call_name: 't', result: { a: 1 } }] });
        expect(el.querySelector('pre').textContent).toContain('"a": 1');
    });
});

describe('ChatMessages — the conversation', () => {
    const msg = (content) => ({ role: 'assistant', content });

    it('invites a first message when there is nothing at all', () => {
        expect(many({ messages: [] }).textContent).toContain('Start a conversation');
    });

    it('renders every turn, in order', () => {
        const el = many({ messages: [{ role: 'user', content: 'q' }, msg('a')] });
        const rows = [...el.querySelectorAll('.chat-message-row')];
        expect(rows).toHaveLength(2);
        expect(rows[0].classList.contains('msg-user')).toBe(true);
        expect(rows[1].classList.contains('msg-ai')).toBe(true);
    });

    it('REUSES existing bubbles when one is appended', async () => {
        // The requirement behind the hand-rolled append: a streaming reply must not
        // re-parse the markdown of the whole conversation on every chunk.
        const first = msg('one');
        const { container, rerender } = render(ChatMessages, {
            props: { messages: [first], renderMarkdown: md, renderUserMarkdown: umd },
        });
        const before = container.querySelector('.chat-message-row');
        await rerender({ messages: [first, msg('two')], renderMarkdown: md, renderUserMarkdown: umd });
        expect(container.querySelector('.chat-message-row')).toBe(before);
        expect(container.querySelectorAll('.chat-message-row')).toHaveLength(2);
    });

    it('updates the LAST bubble in place while it streams', async () => {
        const { container, rerender } = render(ChatMessages, {
            props: { messages: [msg('par')], renderMarkdown: md, renderUserMarkdown: umd },
        });
        await rerender({ messages: [msg('partial reply')], renderMarkdown: md, renderUserMarkdown: umd });
        expect(container.textContent).toContain('partial reply');
        expect(container.querySelectorAll('.chat-message-row')).toHaveLength(1);
    });

    it('drops the empty state as soon as there is a turn', async () => {
        const { container, rerender } = render(ChatMessages, { props: { messages: [] } });
        expect(container.querySelector('.chat-empty-state')).not.toBe(null);
        await rerender({ messages: [msg('hi')], renderMarkdown: md, renderUserMarkdown: umd });
        expect(container.querySelector('.chat-empty-state')).toBe(null);
    });

    it('shows a transient notice AFTER the conversation', () => {
        const el = many({ messages: [msg('a')], notices: ['⚠️ Failed to load skill'] });
        expect(el.querySelector('.chat-notice').textContent).toContain('Failed to load skill');
        const rows = [...el.querySelectorAll('.chat-message-row')];
        expect(rows[rows.length - 1].querySelector('.chat-notice')).not.toBe(null);
    });

    it('a notice alone counts as content — no empty state behind it', () => {
        const el = many({ messages: [], notices: ['heads up'] });
        expect(el.querySelector('.chat-empty-state')).toBe(null);
        expect(el.textContent).toContain('heads up');
    });

    it('CLEARS notices when they are withdrawn', async () => {
        // They used to be injected into the DOM, so their lifetime was whatever the
        // next re-render happened to do.
        const { container, rerender } = render(ChatMessages, {
            props: { messages: [msg('a')], notices: ['old'], renderMarkdown: md, renderUserMarkdown: umd },
        });
        expect(container.textContent).toContain('old');
        await rerender({ messages: [msg('a')], notices: [], renderMarkdown: md, renderUserMarkdown: umd });
        expect(container.textContent).not.toContain('old');
    });

    it('tolerates a missing message list', () => {
        expect(many({ messages: null }).textContent).toContain('Start a conversation');
    });
});
