// MemoryView — the shell. Everything else is svelte/memory/MemoryRoot.svelte.
//
// Memory became a destination in docs/design/information-architecture.md §7
// step 4. Before that it was in two places, and neither was somewhere you could
// go: the Dashboard's right pane (a region that swaps to the live run the moment
// one starts, so the panel disappears exactly when there is something to have
// learned) and a Settings tab (where you change behaviour and leave, not where
// you review what the agent believes).
//
// The view contract main.js relies on is unchanged — render() returns markup,
// init() wires it up, destroy() tears it down. See docs/design/svelte-migration.md.

import MemoryRoot from '../svelte/memory/MemoryRoot.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
// The editor half is built out of the `.cfg-*` form vocabulary — cards, input
// groups, inline rows, the table. That block used to be emitted only by the
// Settings shell, so moving the editor to its own route left it with no CSS
// and it rendered at the browser's default sizes.
//
// ConfigView.js records the SAME failure happening once before (the rules were
// inside the General tab's branch, so opening Settings on Memory had no styles).
// The prefix is a misnomer now: these are the app's form styles, and two routes
// use them.
import { CONFIG_SECTION_STYLES } from './ConfigView.styles.js';

const HOST_ID = 'memory-root';

export class MemoryView {
    /** @param {string} tab 'digest' | 'edit' — from #memory?tab=edit */
    constructor(tab = 'digest') {
        this._tab = tab === 'edit' ? 'edit' : 'digest';
    }

    render() {
        return `<style>${CONFIG_SECTION_STYLES}</style><div id="${HOST_ID}"></div>`;
    }

    init() {
        this._host = document.getElementById(HOST_ID);
        mountComponent(MemoryRoot, this._host, { initialTab: this._tab });
    }

    destroy() {
        destroyComponent(this._host);
        this._host = null;
    }
}
