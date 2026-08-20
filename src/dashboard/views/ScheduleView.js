// ScheduleView — the shell. Everything else is Svelte.
//
// Was 836 lines: markup as template strings, form state living in the DOM and
// read back with a dozen getElementById().value calls on Save, and a
// _refreshList()/_refreshDetail() pair that had to follow every mutation.
//
// The view contract main.js relies on is unchanged — render() returns markup,
// init() wires it up, destroy() tears it down — so this is the only file that
// knows the app is not entirely Svelte yet. See docs/design/svelte-migration.md.

import ScheduleRoot from '../svelte/schedule/ScheduleRoot.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';

const HOST_ID = 'schedule-root';

export class ScheduleView {
    render() {
        return `<div id="${HOST_ID}" class="schedule-root"></div>`;
    }

    init() {
        this._host = document.getElementById(HOST_ID);
        mountComponent(ScheduleRoot, this._host);
    }

    destroy() {
        // The component's own $effect clears its interval and window listener;
        // unmounting is what runs it.
        destroyComponent(this._host);
        this._host = null;
    }
}
