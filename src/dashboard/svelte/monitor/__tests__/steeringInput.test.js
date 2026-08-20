// @vitest-environment jsdom
//
// The box under a task, after migration. The steer-versus-continue decision is
// pinned in views/monitor/__tests__/steering.test.js; this covers the box: what
// it collects, when it is usable, and the small API the view drives it through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const invoke = vi.fn(async () => null);

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock('../../../../modules/ai/PromptTemplateManager.js', () => ({
    promptTemplateManager: { loadFromConfig: vi.fn(), search: vi.fn(() => []) },
}));
vi.mock('../../../../modules/ai/SkillManager.js', () => ({
    skillManager: {
        refresh: vi.fn(async () => {}),
        search: vi.fn(() => [{ name: 'excel', title: 'Excel helper' }]),
        readContent: vi.fn(async () => 'SKILL BODY'),
    },
}));

const SteeringInput = (await import('../SteeringInput.svelte')).default;

afterEach(() => cleanup());
beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async () => null);
});

function mountBox(props = {}) {
    // An override has to be the one returned as well, or a test that supplies its
    // own onSend ends up asserting against the default spy.
    const onSend = props.onSend ?? vi.fn(async () => true);
    const onStop = props.onStop ?? vi.fn();
    const notify = props.notify ?? vi.fn();
    const utils = render(SteeringInput, {
        props: { enabled: true, ...props, onSend, onStop, notify },
    });
    return { ...utils, onSend, onStop, notify };
}

const box = (c) => c.querySelector('#input-steering');
const sendBtn = (c) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send');
const stopBtn = (c) => [...c.querySelectorAll('button')].find(b => /Stop/.test(b.textContent));
const type = (el, value) => fireEvent.input(el, { target: { value } });

describe('when it is usable', () => {
    // Nothing to steer until a socket opens or the task turns out to be finished.
    it('is disabled until the view enables it', () => {
        const h = mountBox({ enabled: false });
        expect(box(h.container).disabled).toBe(true);
        expect(sendBtn(h.container).disabled).toBe(true);
    });

    it('will not send an empty message even when enabled', () => {
        const h = mountBox();
        expect(box(h.container).disabled).toBe(false);
        expect(sendBtn(h.container).disabled).toBe(true);
    });

    it('enables Send once there is something to say', async () => {
        const h = mountBox();
        await type(box(h.container), 'keep going');
        await waitFor(() => expect(sendBtn(h.container).disabled).toBe(false));
    });

    // A skill ALONE is a valid message. SlashCommands mutates its own array,
    // which Svelte cannot observe, so it reports the change instead — without
    // that the button stayed dead next to a visible skill chip.
    it('enables Send for an attached skill with no text', async () => {
        const h = mountBox();
        await type(box(h.container), '/exc');
        const row = await waitFor(() => {
            const el = h.container.querySelector('.slash-popup-item');
            expect(el).toBeTruthy();
            return el;
        });
        await fireEvent.mouseDown(row);
        await waitFor(() => expect(h.container.querySelector('.sc-chip')).toBeTruthy());
        expect(box(h.container).value).toBe('');
        await waitFor(() => expect(sendBtn(h.container).disabled).toBe(false));
    });

    // The wording comes from the view (steerPlaceholder) — the box never derives
    // it, which is what seven copies of the same three sentences used to do.
    it('shows exactly the placeholder it was given', () => {
        const h = mountBox({ placeholder: '❓ Which file did you mean?' });
        expect(box(h.container).getAttribute('placeholder')).toBe('❓ Which file did you mean?');
    });
});

describe('sending', () => {
    it('hands the view the text and the expanded prompt', async () => {
        const h = mountBox();
        await type(box(h.container), '  do the thing  ');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(expect.objectContaining({
            text: 'do the thing', attachments: [],
        })));
    });

    // Enter and Shift+Enter insert newlines: a steering message is often a
    // paragraph, so only Ctrl+Enter sends.
    it('sends on Ctrl+Enter and not on plain Enter', async () => {
        const h = mountBox();
        await type(box(h.container), 'go');
        await fireEvent.keyDown(box(h.container), { key: 'Enter' });
        expect(h.onSend).not.toHaveBeenCalled();
        await fireEvent.keyDown(box(h.container), { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(h.onSend).toHaveBeenCalled());
    });

    it('clears itself once the view accepted the message', async () => {
        const h = mountBox();
        await type(box(h.container), 'go');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(box(h.container).value).toBe(''));
    });

    // A dropped socket means the message would go nowhere; keeping the text is
    // the difference between "retry" and "retype".
    it('keeps the text when the view refused to send it', async () => {
        const h = mountBox({ onSend: vi.fn(async () => false) });
        await type(box(h.container), 'precious');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.onSend).toHaveBeenCalled());
        expect(box(h.container).value).toBe('precious');
    });

    it('does not fire twice while the first send is in flight', async () => {
        let release;
        const onSend = vi.fn(() => new Promise(r => { release = r; }));
        const h = mountBox({ onSend });
        await type(box(h.container), 'go');
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        await fireEvent.click(sendBtn(h.container));
        expect(onSend).toHaveBeenCalledTimes(1);
        release(true);
    });
});

describe('attachments', () => {
    /**
     * Attach files through the hidden input.
     *
     * jsdom has no DataTransfer and `input.files` is read-only, so the list is
     * defined directly. The component only iterates it.
     */
    async function attachFiles(container, files) {
        const input = container.querySelector('.steer-file-input');
        Object.defineProperty(input, 'files', { value: files, configurable: true });
        await fireEvent.change(input);
    }

    it('shows what is attached and sends it along', async () => {
        const h = mountBox();
        await attachFiles(h.container, [new File(['a,b'], 'data.csv', { type: 'text/csv' })]);
        await waitFor(() => expect(h.container.textContent).toContain('data.csv'));
        await fireEvent.click(sendBtn(h.container));
        await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(expect.objectContaining({
            attachments: [expect.objectContaining({ name: 'data.csv' })],
        })));
    });

    it('lets an attachment be removed again', async () => {
        const h = mountBox();
        await attachFiles(h.container, [new File(['x'], 'note.txt', { type: 'text/plain' })]);
        await waitFor(() => expect(h.container.querySelector('.nt-prev-x')).toBeTruthy());
        await fireEvent.click(h.container.querySelector('.nt-prev-x'));
        await waitFor(() => expect(h.container.querySelector('.nt-prev')).toBeNull());
    });

    // An image alone is a legitimate message.
    it('can send with an attachment and no text', async () => {
        const h = mountBox();
        await attachFiles(h.container, [new File(['x'], 'note.txt', { type: 'text/plain' })]);
        await waitFor(() => expect(sendBtn(h.container).disabled).toBe(false));
    });

    it('reports a file it could not take rather than dropping it silently', async () => {
        const h = mountBox();
        const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
        Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 });
        await attachFiles(h.container, [big]);
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/too large/i)));
    });
});


describe('the stop button', () => {
    it('appears only while a run is going', async () => {
        const h = mountBox({ showStop: false });
        expect(stopBtn(h.container)).toBeUndefined();
        cleanup();
        const g = mountBox({ showStop: true });
        expect(stopBtn(g.container)).toBeTruthy();
    });

    it('reports the stop and says it is stopping', async () => {
        const h = mountBox({ showStop: true });
        await fireEvent.click(stopBtn(h.container));
        expect(h.onStop).toHaveBeenCalled();
        await waitFor(() => expect(stopBtn(h.container).textContent).toMatch(/Stopping/));
        expect(stopBtn(h.container).disabled).toBe(true);
    });
});

describe('the view-facing API', () => {
    // The view used to do these by reaching for the textarea by id, assigning
    // `.value` and clicking Send — which is how the answer card submitted.
    it('hands the view compose and submit', async () => {
        let api = null;
        mountBox({ onReady: (a) => { api = a; } });
        await waitFor(() => expect(api).toBeTruthy());
        expect(typeof api.compose).toBe('function');
        expect(typeof api.submit).toBe('function');
    });

    it('replaces the text and submits it — the answer-a-question path', async () => {
        let api = null;
        const h = mountBox({ onReady: (a) => { api = a; } });
        await waitFor(() => expect(api).toBeTruthy());
        api.compose('Yes, option 2', 'replace');
        await waitFor(() => expect(box(h.container).value).toBe('Yes, option 2'));
        api.submit();
        await waitFor(() => expect(h.onSend).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Yes, option 2',
        })));
    });

    // The hub strip appends a reference to what is already being typed.
    it('appends to what is already there by default', async () => {
        let api = null;
        const h = mountBox({ onReady: (a) => { api = a; } });
        await waitFor(() => expect(api).toBeTruthy());
        await type(box(h.container), 'look at');
        api.compose('@backlog/PROJ-1');
        await waitFor(() => expect(box(h.container).value).toBe('look at @backlog/PROJ-1'));
    });

    it('releases the API when the box goes away', async () => {
        const onReady = vi.fn();
        const h = mountBox({ onReady });
        await waitFor(() => expect(onReady).toHaveBeenCalledWith(expect.any(Object)));
        h.unmount();
        await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(null));
    });
});
