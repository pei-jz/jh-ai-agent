// ConfigView — the shell. Everything else is Svelte.
//
// Was 1,615 lines. The eight tab BODIES were already components; what remained
// was the shell that assembled their props, owned all the state, and — after
// almost every handler — called `reRender()`, which rebuilt the whole page's
// innerHTML and re-mounted all eight. Editing one template re-created the entire
// Settings view.
//
// The view contract main.js relies on is unchanged — render() returns markup,
// init() wires it up, destroy() tears it down. See docs/design/svelte-migration.md.

import ConfigRoot from '../svelte/config/ConfigRoot.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
import { CONFIG_SECTION_STYLES, CONFIG_MODAL_STYLES } from './ConfigView.styles.js';

const HOST_ID = 'config-root';

export class ConfigView {
    /** @param {string} [tab] deep-link target, e.g. `#config?tab=memory`. */
    constructor(tab = 'llm') {
        this._tab = tab;
    }

    render() {
        // Both style blocks are emitted for EVERY tab. CONFIG_SECTION_STYLES used
        // to live inside the General tab's branch, so `.cfg-*` — which the Memory
        // / RAG / Templates / Skills tabs are built out of — only existed while
        // General was the active tab: opening Settings on Memory rendered it with
        // no CSS at all.
        return `
            <style>${CONFIG_SECTION_STYLES}</style>
            <style>${CONFIG_MODAL_STYLES}</style>
            <div id="${HOST_ID}"></div>`;
    }

    init() {
        this._host = document.getElementById(HOST_ID);
        mountComponent(ConfigRoot, this._host, { initialTab: this._tab });
    }

    destroy() {
        // The component's own $effect drops the rag-progress listener; unmounting
        // is what runs it.
        destroyComponent(this._host);
        this._host = null;
    }
}
