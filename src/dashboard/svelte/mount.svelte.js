// mount — the seam between the vanilla dashboard and migrated Svelte components.
//
// NOTE the `.svelte.js` extension: it is what lets this file use runes ($state).
// A plain .js file is not passed through the Svelte compiler, so `$state` there is
// an undefined function at runtime.
//
// The migration to Svelte is INCREMENTAL by design. A big-bang rewrite of
// MonitorView (4,200 lines) / ConfigView / ChatView would invalidate the whole
// test suite at once and leave the app unshippable for as long as it took, so
// instead each region is replaced one at a time behind this seam:
//
//     vanilla view renders its markup, including <div id="task-inspector">
//        └─ mountComponent(Inspector, host, props)   ← Svelte owns it from here
//
// The vanilla side keeps ONE responsibility for a migrated region: gather the
// props and call `update`. It must never touch that subtree's DOM again —
// innerHTML on a mounted host is what makes hybrid migrations rot.
//
// Why this file exists rather than calling Svelte's `mount()` directly:
//   • a view re-renders its shell often, so the same host id must re-mount
//     cleanly (and the OLD instance must be destroyed, or listeners leak);
//   • props arrive imperatively from a class, not from a parent component, so
//     each mount needs a $state box to push into;
//   • view teardown has to unmount everything it created, in one call.
//
// ── On flushing, and a mistake worth recording ────────────────────────────────
// `update()` is BATCHED. An earlier version called `flushSync()` on every push, so
// that vanilla callers could push props and read the DOM back in the same turn — the
// contract `innerHTML =` had given them.
//
// That was measurably wrong. `flushSync()` re-validates the whole reactive graph, and
// the Task view mounts one component per timeline item: with ~80 items a NO-OP push
// with byte-identical props cost ~31ms, against 0.03ms for all the model work behind
// it. Since a streaming run pushes on every line, the view got visibly slower the
// longer the task ran — reported as "it looks like it stalls near the end".
//
// So batching is the default, and a caller that genuinely must read back asks for it:
// `update(props, { sync: true })`, or `handle.flush()`.

import { mount, unmount, flushSync } from 'svelte';

/** host element → { instance, box, Component } for everything mounted here. */
const MOUNTED = new WeakMap();

/**
 * Mount (or re-target) a Svelte component onto a host element.
 *
 * Idempotent per (host, Component): calling it again with new props updates the
 * live instance instead of rebuilding it, so a parent re-render costs a prop
 * assignment rather than a teardown. Passing a DIFFERENT component for the same
 * host destroys the old one first.
 *
 * @param {any} Component a Svelte component (the module's default export)
 * @param {HTMLElement|null} host
 * @param {object} [props]
 * @returns {{update: (next: object) => void, destroy: () => void}|null}
 *          null when there is no host (a view that has since navigated away)
 */
export function mountComponent(Component, host, props = {}) {
    if (!host) return null;

    const existing = MOUNTED.get(host);
    if (existing && existing.Component === Component) {
        existing.handle.update(props);
        return existing.handle;
    }
    // A different component wants this host — the old one has to go, or two
    // instances write to the same subtree.
    if (existing) destroyComponent(host);

    // Svelte 5 props are not a mutable object we can reach into, so the props
    // live in a $state box the component spreads. Assigning to the box is what
    // makes an imperative `update()` from class code reactive.
    const box = $state({ ...props });
    const instance = mount(Component, {
        target: host,
        props: box,
    });

    const handle = {
        /**
         * Push props. BATCHED by default — see the note below.
         * @param {object} next
         * @param {{sync?: boolean}} [opts] sync:true flushes before returning, for a
         *        caller that must read the DOM back in the same turn.
         */
        update: (next = {}, opts = {}) => {
            Object.assign(box, next);
            if (opts.sync) flushSync();
        },
        /** Force the pending update into the DOM now. */
        flush: () => flushSync(),
        destroy: () => destroyComponent(host),
    };
    MOUNTED.set(host, { instance, box, Component, handle });
    return handle;
}

/**
 * Unmount whatever is mounted on `host`. Safe to call on a bare element.
 * @returns {boolean} true when something was actually unmounted
 */
export function destroyComponent(host) {
    if (!host) return false;
    const entry = MOUNTED.get(host);
    if (!entry) return false;
    MOUNTED.delete(host);
    try {
        unmount(entry.instance);
    } catch (e) {
        // A host already detached from the document can throw on cleanup. The
        // entry is gone either way; a teardown must not break the navigation
        // that triggered it.
        console.warn('Svelte unmount failed (host likely already detached):', e);
    }
    return true;
}

/**
 * Whether this host currently has a Svelte component on it.
 *
 * No production caller — mountComponent and destroyComponent are both idempotent, so
 * nothing needs to ask first. Kept because it is the only way for a TEST to assert
 * that teardown actually released the host, which is the seam's central promise.
 */
export function isMounted(host) {
    return !!(host && MOUNTED.has(host));
}
