// @vitest-environment jsdom
//
// The hub strip is how the product's one structural advantage becomes visible:
// which apps are connected, and which documents they currently have open.

import { describe, it, expect } from 'vitest';
import { hubApps, hubActionText } from '../hubStrip.js';

const clients = (arr) => new Map(arr.map(c => [c.name, c]));

describe('hubApps', () => {
    it('normalizes the client map and sorts by app name', () => {
        const apps = hubApps(clients([
            { name: 'task', resources: [] },
            { name: 'jheditor', resources: [{ uri: 'doc://current', name: 'Active buffer' }] },
        ]));
        expect(apps.map(a => a.name)).toEqual(['jheditor', 'task']);
        expect(apps[0].resources[0]).toEqual({ uri: 'doc://current', name: 'Active buffer' });
    });

    it('falls back to the uri when no name was declared', () => {
        const apps = hubApps(clients([{ name: 'a', resources: [{ uri: 'u' }] }]));
        expect(apps[0].resources[0].name).toBe('u');
    });

    it('drops entries with no uri rather than rendering empty chips', () => {
        const apps = hubApps(clients([{ name: 'a', resources: [{}, { uri: 'u' }] }]));
        expect(apps[0].resources).toHaveLength(1);
    });

    // Intents were removed (Report_20260913 §6-6). A client that still carries
    // the field must not bring the chips back.
    it('ignores an intents list a client may still carry', () => {
        const [app] = hubApps(clients([{ name: 'a', intents: [{ id: 'x' }], resources: [] }]));
        expect(app.intents).toBeUndefined();
    });

    it('accepts an array as well as a Map, and tolerates nothing', () => {
        expect(hubApps([{ name: 'a' }])[0].name).toBe('a');
        expect(hubApps(null)).toEqual([]);
        expect(hubApps(new Map())).toEqual([]);
    });
});

describe('hubActionText', () => {
    it('composes a resource read', () => {
        expect(hubActionText('resource', 'JHEditor', { uri: 'doc://x', name: 'X' })).toContain('JHEditor::doc://x');
    });

    it('composes nothing for an intent — there are none to run', () => {
        expect(hubActionText('intent', 'JHEditor', { id: 'impact' })).toBe('');
    });
});

// NOTE: the hubStripHtml tests moved to
// dashboard/svelte/monitor/__tests__/HubStrip.test.js with the markup itself.
