// @vitest-environment jsdom
//
// The hub strip is how the product's one structural advantage becomes visible:
// which apps are connected, what named actions they offer, and which documents
// they currently have open.

import { describe, it, expect } from 'vitest';
import { hubApps, hubActionText } from '../hubStrip.js';

const clients = (arr) => new Map(arr.map(c => [c.name, c]));

describe('hubApps', () => {
    it('normalizes the client map and sorts by app name', () => {
        const apps = hubApps(clients([
            { name: 'task', intents: [{ id: 'today' }], resources: [] },
            { name: 'jheditor', intents: [], resources: [{ uri: 'doc://current', name: 'Active buffer' }] },
        ]));
        expect(apps.map(a => a.name)).toEqual(['jheditor', 'task']);
        expect(apps[0].resources[0]).toEqual({ uri: 'doc://current', name: 'Active buffer' });
    });

    it('falls back to the id/uri when no title or name was declared', () => {
        const apps = hubApps(clients([{ name: 'a', intents: [{ id: 'x' }], resources: [{ uri: 'u' }] }]));
        expect(apps[0].intents[0].title).toBe('x');
        expect(apps[0].resources[0].name).toBe('u');
    });

    it('drops entries with no id/uri rather than rendering empty chips', () => {
        const apps = hubApps(clients([{ name: 'a', intents: [{}, { id: 'ok' }], resources: [{}, { uri: 'u' }] }]));
        expect(apps[0].intents).toHaveLength(1);
        expect(apps[0].resources).toHaveLength(1);
    });

    it('accepts an array as well as a Map, and tolerates nothing', () => {
        expect(hubApps([{ name: 'a' }])[0].name).toBe('a');
        expect(hubApps(null)).toEqual([]);
        expect(hubApps(new Map())).toEqual([]);
    });
});

// NOTE: the hubStripHtml tests moved to
// dashboard/svelte/monitor/__tests__/HubStrip.test.js with the markup itself.
