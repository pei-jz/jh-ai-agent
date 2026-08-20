// steering — the box under a task, without the box.

import { describe, it, expect } from 'vitest';
import {
    attachmentBlocks, hasSomethingToSend, steerMode, buildSteerMessage,
    steerPayload, steerFrame,
} from '../steering.js';

describe('hasSomethingToSend', () => {
    it('accepts text, an attachment, or an attached skill on its own', () => {
        expect(hasSomethingToSend({ text: 'go' })).toBe(true);
        expect(hasSomethingToSend({ text: '', attachments: [{ id: 'a' }] })).toBe(true);
        expect(hasSomethingToSend({ text: '', activeSkills: [{ name: 'x' }] })).toBe(true);
    });

    it('refuses an empty box', () => {
        expect(hasSomethingToSend({ text: '   ' })).toBe(false);
        expect(hasSomethingToSend({})).toBe(false);
    });
});

describe('steerMode', () => {
    // A finished run has no socket to talk to; the message starts a NEW run.
    it('continues a finished task', () => {
        expect(steerMode({ taskFinished: true, socketOpen: false })).toBe('continue');
    });

    // "Just keep going" is exactly what you want after a stall, so a stopped or
    // failed task takes the same path as a clean finish.
    it('continues a stopped or failed task the same way', () => {
        expect(steerMode({ taskFinished: true, socketOpen: true })).toBe('continue');
    });

    it('steers a live run down the open socket', () => {
        expect(steerMode({ taskFinished: false, socketOpen: true })).toBe('steer');
    });

    // Not finished and no socket: the connection dropped mid-run. Sending into
    // nothing would silently lose the message.
    it('does nothing when the run is live but the socket is gone', () => {
        expect(steerMode({ taskFinished: false, socketOpen: false })).toBe('none');
    });
});

describe('buildSteerMessage', () => {
    it('sends the expanded prompt but displays what was typed', () => {
        const m = buildSteerMessage({ text: 'check it', expandedPrompt: 'SKILL BODY\n\n---\n\ncheck it' });
        expect(m.body).toContain('SKILL BODY');
        expect(m.display).toBe('check it');
    });

    it('falls back to the raw text when nothing expanded it', () => {
        expect(buildSteerMessage({ text: 'plain' })).toMatchObject({ body: 'plain', display: 'plain' });
    });

    // Sending only an image is legitimate — the display falls back to the body
    // rather than showing an empty bubble.
    it('shows the body when there was no typed text', () => {
        const m = buildSteerMessage({
            text: '', expandedPrompt: 'from a skill',
            attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,x' }],
        });
        expect(m.display).toBe('from a skill');
        expect(m.images).toEqual(['data:image/png;base64,x']);
    });

    it('appends file contents to the body and keeps images separate', () => {
        const m = buildSteerMessage({
            text: 'look',
            attachments: [
                { type: 'file', name: 'a.txt', content: 'hello' },
                { type: 'image', dataUrl: 'data:image/png;base64,y' },
            ],
        });
        expect(m.body).toContain('[Attached File: a.txt]');
        expect(m.body).toContain('hello');
        expect(m.images).toHaveLength(1);
        expect(m.body).not.toContain('base64');
    });
});

describe('attachmentBlocks', () => {
    it('is empty when nothing is attached', () => {
        expect(attachmentBlocks([])).toBe('');
        expect(attachmentBlocks(undefined)).toBe('');
    });

    it('fences each file under its name', () => {
        const out = attachmentBlocks([{ name: 'a', content: '1' }, { name: 'b', content: '2' }]);
        expect((out.match(/```/g) || []).length).toBe(4);
        expect(out).toContain('[Attached File: b]');
    });
});

describe('steerPayload', () => {
    it('carries the message', () => {
        expect(steerPayload({ body: 'go' })).toEqual({ message: 'go' });
    });

    it('omits images rather than sending an empty list', () => {
        expect(steerPayload({ body: 'go', images: [] })).not.toHaveProperty('images');
        expect(steerPayload({ body: 'go', images: ['x'] }).images).toEqual(['x']);
    });
});

describe('steerFrame', () => {
    it('wraps the payload in the socket envelope', () => {
        expect(JSON.parse(steerFrame({ message: 'go' })))
            .toEqual({ event: 'steering', data: { message: 'go' } });
    });
});
