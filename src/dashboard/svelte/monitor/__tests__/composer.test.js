// @vitest-environment jsdom
//
// Composer — the prompt box at the top of the executions list.
//
// docs/design/information-architecture.md §7 step 1. What is pinned here is the
// behaviour that makes it a REPLACEMENT for the Dashboard launcher rather than a
// third way to start a task: it validates the same way, it posts through the
// shared creator, and it carries mode/workspace forward.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

vi.mock('../../../../modules/ai/McpManager.js', () => ({
    mcpManager: { clients: new Set(), startClient: vi.fn(async () => {}) },
}));
vi.mock('../../../../modules/ai/PromptTemplateManager.js', () => ({
    promptTemplateManager: { loadFromConfig: vi.fn(), search: () => [] },
}));
vi.mock('../../../../modules/ai/SkillManager.js', () => ({
    skillManager: { refresh: vi.fn(async () => {}), search: () => [] },
}));

import Composer from '../Composer.svelte';

const CONFIG = { approved_projects: ['C:/proj', 'C:/other'], mcp_servers: {} };

function mount(props = {}) {
    const onCreated = vi.fn();
    const onDetails = vi.fn();
    const notify = vi.fn();
    const request = vi.fn(async () => ({ task_id: 't-42' }));
    const r = render(Composer, {
        props: {
            api: { request },
            onCreated, onDetails, notify,
            ...props,
        },
    });
    return { ...r, onCreated, onDetails, notify, request };
}

const ta = (c) => c.querySelector('.mcomp-ta');
/** The workspace is a NAME on a status line now, not a field. */
const wsText = (c) => c.querySelector('.mcomp-ctx-ws')?.textContent || '';
const ctxTitle = (c) => c.querySelector('.mcomp-ctx')?.getAttribute('title') || '';
const send = (c) => c.querySelector('.mcomp-send');

/**
 * The controls only exist once the box is in use — see Composer.svelte.
 *
 * `focusIn`, not `focus`: the composer listens on the CONTAINER so that moving
 * focus from the input to one of its own buttons does not close it, and `focus`
 * does not bubble. Firing the wrong one here would test nothing.
 */
async function open(container) {
    await waitFor(() => expect(ta(container)).toBeTruthy());
    await fireEvent.focusIn(ta(container));
    await waitFor(() => expect(send(container)).toBeTruthy());
}
const body = (request) => JSON.parse(request.mock.calls[0][1].body);

beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? CONFIG : ''));
});
afterEach(() => cleanup());

describe('Composer — starting a task', () => {
    it('seeds the workspace from the first approved project', async () => {
        const { container } = mount();
        await open(container);
        await waitFor(() => expect(ctxTitle(container)).toContain('C:/proj'));
    });

    it('prefers the workspace the view carried from the last create', async () => {
        const { container } = mount({ workspace: 'C:/carried' });
        await open(container);
        await waitFor(() => expect(ctxTitle(container)).toContain('C:/carried'));
    });

    // The change that freed the row: thirty characters of path became a name.
    it('shows the workspace by NAME, keeping the full path as the title', async () => {
        const WIN = String.raw`C:\cusor_workspace\jh-ai-agent`;
        const { container } = mount({ workspace: WIN });
        await open(container);
        await waitFor(() => expect(wsText(container)).toBe('jh-ai-agent'));
        expect(ctxTitle(container)).toContain(WIN);
    });

    it('handles a POSIX path and a trailing separator too', async () => {
        const { container } = mount({ workspace: '/home/me/proj/' });
        await open(container);
        await waitFor(() => expect(wsText(container)).toBe('proj'));
    });

    // An empty three-line box with six controls made the column look full before
    // anything was in it.
    it('shows nothing but the input until the box is used', () => {
        const { container } = mount();
        expect(ta(container)).toBeTruthy();
        expect(send(container)).toBeNull();
        expect(container.querySelector('.mcomp-int')).toBeNull();
        expect(container.querySelector('.mcomp-ctx')).toBeNull();
    });

    it('reveals the controls on focus', async () => {
        const { container } = mount();
        await open(container);
        expect(container.querySelector('.mcomp-int')).toBeTruthy();
        expect(container.querySelector('.mcomp-ctx')).toBeTruthy();
    });

    it('keeps them open while there is text, even after blur', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'still writing' } });
        await fireEvent.blur(ta(container));
        await waitFor(() => expect(send(container)).toBeTruthy());
    });

    it('posts the typed prompt and reports the new task id', async () => {
        const { container, request, onCreated } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'fix the socket' } });
        await fireEvent.click(send(container));

        await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        expect(body(request).prompt).toBe('fix the socket');
        expect(body(request).workspace_path).toBe('C:/proj');
        expect(body(request).caller).toBe('Composer');
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith('t-42', expect.objectContaining({ workspace: 'C:/proj' })));
    });

    it('clears the box after a successful create, so the next task starts empty', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'one' } });
        await fireEvent.click(send(container));
        await waitFor(() => expect(ta(container).value).toBe(''));
    });

    it('keeps the prompt when the create fails — losing what was typed is the worst outcome', async () => {
        const request = vi.fn(async () => { throw new Error('offline'); });
        const notify = vi.fn();
        const { container } = render(Composer, {
            props: { api: { request }, notify, workspace: 'C:/proj' },
        });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'keep me' } });
        await fireEvent.click(send(container));

        await waitFor(() => expect(notify).toHaveBeenCalled());
        expect(ta(container).value).toBe('keep me');
        // and it is sendable again
        expect(send(container).disabled).toBe(false);
    });

    it('refuses an empty prompt without posting', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.click(send(container));
        expect(request).not.toHaveBeenCalled();
    });

    // A `build` run edits files, so it needs somewhere to work: the server
    // accepts a task with no workspace and the run fails on its first tool.
    it('refuses a missing workspace for a 頼む run', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? { approved_projects: [] } : ''));
        const { container, request, onDetails } = mount();
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'この件を直して' } });
        await fireEvent.click(send(container));

        expect(request).not.toHaveBeenCalled();
        expect(onDetails).toHaveBeenCalled();
    });

    // But a QUESTION does not. "Where do I get the Java LSP" has no files to
    // touch, and an ask run could not touch any anyway — demanding a folder
    // first asks for something that will never be used.
    it('sends a 聞く run with no workspace at all', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? { approved_projects: [] } : ''));
        const { container, request } = mount();
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'java LSP はどこでダウンロードできますか' } });
        await fireEvent.click(send(container));

        await waitFor(() => expect(request).toHaveBeenCalled());
        expect(body(request).behavior.interaction).toBe('ask');
        expect(body(request).workspace_path).toBe('');
    });
});

describe('Composer — the keyboard', () => {
    it('Enter sends', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'go' } });
        await fireEvent.keyDown(ta(container), { key: 'Enter' });
        await waitFor(() => expect(request).toHaveBeenCalled());
    });

    it('Shift+Enter does not send', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'go' } });
        await fireEvent.keyDown(ta(container), { key: 'Enter', shiftKey: true });
        expect(request).not.toHaveBeenCalled();
    });

    // The one this app must never get wrong: confirming an IME candidate with
    // Enter would otherwise submit a half-typed Japanese prompt.
    it('Enter while an IME candidate is open does not send', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'にほんご' } });
        await fireEvent.keyDown(ta(container), { key: 'Enter', isComposing: true });
        expect(request).not.toHaveBeenCalled();
    });
});

describe('Composer — handing off to the full modal', () => {
    it('passes what is already typed to Details rather than discarding it', async () => {
        const { container, onDetails } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'needs an attachment' } });
        await fireEvent.click(container.querySelector('.mcomp-ctx'));
        expect(onDetails).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'needs an attachment', ws: 'C:/proj' }));
    });

    it('shows the mode it will use, so Details is not the only way to know', async () => {
        const { container } = mount({ modeId: 'research' });
        await open(container);
        expect(container.querySelector('.mcomp-ctx-mode').textContent.toLowerCase()).toContain('research');
    });

    // A missing workspace cannot be fixed here any more, so saying "required"
    // and leaving the user with nowhere to set it would be a dead end.
    it('sends the user to the modal when a 頼む run has no workspace', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? { approved_projects: [] } : ''));
        const { container, onDetails, request } = mount();
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'この件を直して' } });
        await fireEvent.click(send(container));
        expect(request).not.toHaveBeenCalled();
        expect(onDetails).toHaveBeenCalled();
    });
});

describe('Composer — the Dashboard handoff', () => {
    it('opens filled in when a launch was queued', async () => {
        const { container } = mount({ presetPrompt: 'from the dashboard', workspace: 'C:/proj' });
        await waitFor(() => expect(ta(container).value).toBe('from the dashboard'));
    });

    it('never overwrites what the user is already typing', async () => {
        const { container, rerender } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.input(ta(container), { target: { value: 'mine' } });
        // The view holds the draft, so it hands the same value back — that is
        // what the real MonitorView does with `_composerText`.
        await rerender({ presetPrompt: 'theirs', workspace: 'C:/proj', text: 'mine' });
        expect(ta(container).value).toBe('mine');
    });

    // The contract, modelled the way MonitorView implements it: the view stores
    // what `onText` reports and hands the same value back. An unrelated
    // re-render (a socket packet, a status change) then cannot wipe the draft.
    it('survives an unrelated re-render when the view holds the draft', async () => {
        let held = '';
        const { container, rerender } = mount({
            place: 'hero', workspace: 'C:/proj', onText: (v) => { held = v; },
        });
        await fireEvent.input(ta(container), { target: { value: 'still here' } });
        expect(held).toBe('still here');

        await rerender({ place: 'hero', workspace: 'C:/proj', text: held, busy: true });
        expect(ta(container).value).toBe('still here');
    });
});

// ── The two bugs from the first cut of this layout ───────────────────────────
describe('the controls stay put while you use them', () => {
    // Pressing a button starts with the textarea losing focus. A textarea-scoped
    // blur closed the box, unmounting the very button being pressed, so the
    // click never landed and every control "just reverted" the box.
    it('does not collapse when focus moves from the input to a control', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        const chip = container.querySelector('.mcomp-int-btn');

        // focusout whose relatedTarget is still inside the composer.
        await fireEvent.focusOut(ta(container), { relatedTarget: chip });
        expect(send(container), 'the row unmounted mid-press').toBeTruthy();
    });

    it('does collapse when focus leaves the composer entirely', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        await fireEvent.focusOut(container.querySelector('.mcomp'), { relatedTarget: document.body });
        await waitFor(() => expect(send(container)).toBeNull());
    });

    it('actually reaches the mode chip that a collapse used to eat', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        const build = [...container.querySelectorAll('.mcomp-int-btn')]
            .find(b => b.classList.contains('is-build'));
        await fireEvent.focusOut(ta(container), { relatedTarget: build });
        await fireEvent.click(build);
        await waitFor(() => expect(build.getAttribute('aria-pressed')).toBe('true'));
    });

    // Two controls labelled the same word do different things.
    it('does not label send with the mode word', async () => {
        const { container } = mount({ workspace: 'C:/proj' });
        await open(container);
        expect(send(container).textContent.trim()).not.toBe('聞く');
        expect(send(container).textContent.trim()).not.toBe('頼む');
    });
});

// ── Which mode gets guessed ──────────────────────────────────────────────────
// This used `looksComplex` ("does it need a PLAN?") when the question is
// `looksReadOnly` ("is it an ANSWER or a CHANGE?"). The two are different, and
// with the wrong one a short work request guessed 聞く — which runs with
// READ-ONLY tools, so it could not have done the job it was given.
describe('the mode guess', () => {
    const chip = (c, kind) => [...c.querySelectorAll('.mcomp-int-btn')]
        .find(b => b.classList.contains(`is-${kind}`));
    const guessed = (c) => (chip(c, 'ask').getAttribute('aria-pressed') === 'true' ? 'ask' : 'build');

    const type = async (container, text) => {
        await open(container);
        await fireEvent.input(ta(container), { target: { value: text } });
    };

    it.each([
        ['auth_middleware は何を素通しにしてる？', 'ask'],
        ['java LSP はどこかでダウンロードできますか', 'ask'],   // ますか, no question mark
        ['今日の天気を教えてください', 'ask'],
        ['この設計を調べて説明して', 'ask'],
        ['what does auth_middleware let through', 'ask'],
    ])('guesses 聞く for %s', async (text, want) => {
        const { container } = mount({ workspace: 'C:/proj' });
        await type(container, text);
        await waitFor(() => expect(guessed(container)).toBe(want));
    });

    it.each([
        // Work, but NOT multi-step work — the case looksComplex gets wrong.
        ['MCP の WS 再接続が落ちる件を直して', 'build'],
        ['認証まわりをリファクタして', 'build'],
        // A polite question that is still an instruction.
        ['実装してもらえますか', 'build'],
        ['調べて修正して', 'build'],
    ])('guesses 頼む for %s', async (text, want) => {
        const { container } = mount({ workspace: 'C:/proj' });
        await type(container, text);
        await waitFor(() => expect(guessed(container)).toBe(want));
    });

    it('sends what the chip shows', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await type(container, 'MCP の WS 再接続が落ちる件を直して');
        await fireEvent.click(send(container));
        await waitFor(() => expect(request).toHaveBeenCalled());
        expect(body(request).behavior.interaction).toBe('build');
    });

    it('sends the OVERRIDE when the user picks one', async () => {
        const { container, request } = mount({ workspace: 'C:/proj' });
        await type(container, 'MCP の WS 再接続が落ちる件を直して');
        await fireEvent.click(chip(container, 'ask'));
        await fireEvent.click(send(container));
        await waitFor(() => expect(request).toHaveBeenCalled());
        expect(body(request).behavior.interaction).toBe('ask');
    });
});

// ── One box, two places ──────────────────────────────────────────────────────
// With nothing selected the whole middle of Work is empty and the list column
// is 240px, so the composer moves there rather than a SECOND one appearing —
// two boxes would raise the question of which is the real one, and the draft
// would have to be kept in step between them.
describe('the hero placement', () => {
    it('is open from the start — there is nothing for a collapsed box to make room for', () => {
        const { container } = mount({ place: 'hero' });
        expect(send(container)).toBeTruthy();
        expect(container.querySelector('.mcomp-int')).toBeTruthy();
    });

    it('still collapses in the rail', () => {
        const { container } = mount({ place: 'rail' });
        expect(send(container)).toBeNull();
    });

    it('carries its place as a class, so the two can be sized differently', () => {
        const { container } = mount({ place: 'hero' });
        expect(container.querySelector('.mcomp-hero')).toBeTruthy();
    });
});

describe('the draft belongs to the view', () => {
    // The reason it was lifted: the box moves between mount points, and a
    // component-local draft would be lost the moment a task was clicked.
    it('reports every keystroke', async () => {
        const onText = vi.fn();
        const { container } = mount({ place: 'hero', onText });
        await fireEvent.input(ta(container), { target: { value: 'half a thou' } });
        expect(onText).toHaveBeenCalledWith('half a thou');
    });

    it('shows what the view hands it', () => {
        const { container } = mount({ place: 'hero', text: 'restored after a move' });
        expect(ta(container).value).toBe('restored after a move');
    });

    it('follows the view when the value changes underneath', async () => {
        const { container, rerender } = mount({ place: 'hero', text: 'first' });
        await rerender({ place: 'hero', text: 'second' });
        await waitFor(() => expect(ta(container).value).toBe('second'));
    });

    it('reports the clear after a successful create', async () => {
        const onText = vi.fn();
        const { container } = mount({ place: 'hero', workspace: 'C:/proj', onText });
        await fireEvent.input(ta(container), { target: { value: 'go' } });
        await fireEvent.click(send(container));
        await waitFor(() => expect(onText).toHaveBeenLastCalledWith(''));
    });
});
