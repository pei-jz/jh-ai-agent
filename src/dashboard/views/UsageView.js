// UsageView — the shell. Everything else is svelte/config/UsageTab.svelte.
//
// Usage came OUT of the Dashboard in information-architecture.md §7 step 4 and
// went into Settings, on the reasoning that you read a cost breakdown when you
// are about to change something about cost. That was half right: the reasoning
// holds, but it put a thing you occasionally want to LOOK AT behind a door
// labelled "change how the app behaves".
//
// So it is a destination of its own, next to Memory — infrequent, but reachable
// without pretending to be on the way to a setting. The phase-routing controls
// it informs are one click away in Settings, which is the right distance for
// something you consult before deciding, not while deciding.
//
// The view contract main.js relies on is unchanged.

import UsageTab from '../svelte/config/UsageTab.svelte';
import { mountComponent, destroyComponent } from '../svelte/mount.svelte.js';
// Same reason as MemoryView: the panels are built out of the `.cfg-*` form
// vocabulary, which only the Settings shell used to emit.
import { CONFIG_SECTION_STYLES } from './ConfigView.styles.js';

const HOST_ID = 'usage-root';

export class UsageView {
    render() {
        return `<style>${CONFIG_SECTION_STYLES}</style><div id="${HOST_ID}"></div>`;
    }

    init() {
        this._host = document.getElementById(HOST_ID);
        mountComponent(UsageTab, this._host);
    }

    destroy() {
        destroyComponent(this._host);
        this._host = null;
    }
}
