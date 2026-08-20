// newTaskRequest — the "Create & Run" payload, without the modal.

import { describe, it, expect } from 'vitest';
import {
    attachmentBlocks, validateNewTask, taskBehavior, taskPayload, modeName, MODE_ICON,
} from '../newTaskRequest.js';
import { AGENT_MODES, DEFAULT_MODE_ID } from '../../../../modules/ai/AgentModes.js';

describe('attachmentBlocks', () => {
    it('is empty when nothing is attached', () => {
        expect(attachmentBlocks([])).toBe('');
        expect(attachmentBlocks(undefined)).toBe('');
    });

    it('fences each file under its name', () => {
        const out = attachmentBlocks([{ name: 'a.csv', content: '1,2' }, { name: 'b.txt', content: 'hi' }]);
        expect(out).toContain('[Attached File: a.csv]');
        expect(out).toContain('[Attached File: b.txt]');
        expect((out.match(/```/g) || []).length).toBe(4);
    });
});

describe('validateNewTask', () => {
    it('accepts a task with content and a workspace', () => {
        expect(validateNewTask({ hasContent: true, workspace: 'C:/ws' })).toEqual({ ok: true });
    });

    it('rejects an empty task without complaining about the workspace', () => {
        expect(validateNewTask({ hasContent: false, workspace: 'C:/ws' }))
            .toMatchObject({ ok: false, field: 'prompt' });
    });

    // An agent task with nowhere to work is accepted by the server and then
    // fails on its first tool, which is a much worse way to find out.
    it('rejects a missing or blank workspace, and says why', () => {
        for (const ws of ['', '   ', null, undefined]) {
            const v = validateNewTask({ hasContent: true, workspace: ws });
            expect(v.ok).toBe(false);
            expect(v.field).toBe('workspace');
            expect(v.reason).toMatch(/workspace/i);
        }
    });
});

describe('taskBehavior', () => {
    it('runs as an iterative agent with the chosen mode folded in', () => {
        const b = taskBehavior(DEFAULT_MODE_ID, []);
        expect(b.mode).toBe('iterative_agent');
        for (const key of Object.keys(AGENT_MODES[DEFAULT_MODE_ID].behavior || {})) {
            expect(b).toHaveProperty(key);
        }
    });

    // An OMITTED list means "every server". A server that connects mid-task —
    // Chat starts its configured servers asynchronously — would then leak its
    // tools into this task's later turns.
    it('sends an EXPLICIT empty list when nothing is checked', () => {
        const b = taskBehavior(DEFAULT_MODE_ID, []);
        expect(b).toHaveProperty('mcp_servers');
        expect(b.mcp_servers).toEqual([]);
    });

    it('passes exactly the checked servers, as its own array', () => {
        const picked = ['fs', 'github'];
        const b = taskBehavior(DEFAULT_MODE_ID, picked);
        expect(b.mcp_servers).toEqual(picked);
        expect(b.mcp_servers).not.toBe(picked);   // a later edit must not reach the payload
    });

    it('does not let the mode preset overwrite the server list', () => {
        expect(taskBehavior(DEFAULT_MODE_ID, ['fs']).mcp_servers).toEqual(['fs']);
    });
});

describe('taskPayload', () => {
    const base = { prompt: 'do it', workspace: 'C:/ws', modeId: DEFAULT_MODE_ID };

    it('carries the prompt, the workspace and the caller', () => {
        expect(taskPayload(base)).toMatchObject({
            prompt: 'do it', workspace_path: 'C:/ws', caller: 'NewTask',
        });
    });

    // The server distinguishes "no images" from "an empty image list" when it
    // picks a vision-capable model.
    it('omits images from the WIRE payload rather than sending an empty list', () => {
        // undefined on the object, which JSON.stringify then drops — the wire is
        // what the server sees, so that is what this asserts.
        expect(taskPayload(base).images).toBeUndefined();
        expect(JSON.parse(JSON.stringify(taskPayload(base)))).not.toHaveProperty('images');
        expect(JSON.parse(JSON.stringify(taskPayload({ ...base, images: [] })))).not.toHaveProperty('images');
    });

    it('sends the images when there are some', () => {
        expect(taskPayload({ ...base, images: ['data:image/png;base64,x'] }).images).toHaveLength(1);
    });

    it('lets the caller be named, for the launcher and the schedule', () => {
        expect(taskPayload({ ...base, caller: 'Schedule' }).caller).toBe('Schedule');
    });
});

describe('mode presentation', () => {
    it('strips the leading emoji so an SVG icon can stand in its place', () => {
        expect(modeName({ label: '🛠 Develop' })).toBe('Develop');
        expect(modeName({ label: 'Research' })).toBe('Research');
        expect(modeName({ id: 'automation' })).toBe('automation');
        expect(modeName(null)).toBe('');
    });

    it('names an icon for every mode the app offers', () => {
        for (const id of Object.keys(AGENT_MODES)) {
            expect(typeof (MODE_ICON[id] || 'gear')).toBe('string');
        }
    });
});
