// OverviewView — the shell. Everything else is Svelte.
//
// Was 1,477 lines: seven regions of markup as template strings, a `_paint()`
// that rewrote three innerHTML blocks and re-attached every listener on any
// change (including on every socket packet), and the workarounds that shape
// forced — restoring the caret in the memory search box after each repaint, and
// reading `getElementById('dash-mem-ws').value` back out of the live DOM so a
// repaint would not clobber a path the user was halfway through typing.
//
// The view contract main.js relies on is unchanged — render() returns markup,
// init() wires it up, destroy() tears it down. See docs/design/svelte-migration.md.

import OverviewRoot from '../svelte/overview/OverviewRoot.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';

export { ATTENTION_WINDOW_H } from './overview/overviewModel.js';

const HOST_ID = 'overview-root';

export class OverviewView {
    render() {
        return `<div id="${HOST_ID}"></div>`;
    }

    init() {
        this._host = document.getElementById(HOST_ID);
        mountComponent(OverviewRoot, this._host);
    }

    destroy() {
        // The component's own $effect closes the task socket and clears the
        // relative-time timer; unmounting is what runs them.
        destroyComponent(this._host);
        this._host = null;
    }
}
