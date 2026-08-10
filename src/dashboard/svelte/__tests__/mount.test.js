// @vitest-environment jsdom
//
// The seam between the vanilla dashboard and migrated Svelte components.
//
// These are the properties the incremental migration actually depends on:
// re-mounting the same host must not leave two live instances writing to one
// subtree, an imperative props push must reach the DOM, and view teardown must
// release everything. Getting any of them wrong is how a hybrid migration starts
// leaking listeners and showing the previous task's data.

import { describe, it, expect, afterEach } from 'vitest';
import { tick } from 'svelte';
import { mountComponent, destroyComponent, isMounted } from '../mount.svelte.js';
import Inspector from '../monitor/Inspector.svelte';
import FileTree from '../monitor/FileTree.svelte';

let host;
const makeHost = () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    return host;
};
afterEach(() => {
    if (host) destroyComponent(host);
    document.body.innerHTML = '';
    host = null;
});

const task = { id: 'abc12345', caller: 'IDE', status: 'running', workspace_path: 'C:/proj' };

describe('mountComponent', () => {
    it('renders the component into the host', () => {
        mountComponent(Inspector, makeHost(), { task });
        expect(host.textContent).toContain('#abc12345');
        expect(isMounted(host)).toBe(true);
    });

    it('returns null for a host that is not there', () => {
        // A view that navigated away between gathering props and pushing them.
        expect(mountComponent(Inspector, null, { task })).toBe(null);
    });

    // Svelte 5 batches reactive work into a microtask, so an assertion about the
    // DOM has to come after a tick. That is also the contract for the app: a
    // caller pushes props and must not read the subtree back in the same turn.
    it('UPDATES in place rather than re-mounting on a second call', async () => {
        const first = mountComponent(Inspector, makeHost(), { task });
        const second = mountComponent(Inspector, host, { task: { ...task, caller: 'CLI' } });
        // Same handle back = the instance was reused, not rebuilt.
        expect(second).toBe(first);
        await tick();
        expect(host.textContent).toContain('CLI');
        expect(host.textContent).not.toContain('IDE');
    });

    it('an imperative update() reaches the DOM', async () => {
        const handle = mountComponent(Inspector, makeHost(), { task });
        expect(host.textContent).toContain('running');
        handle.update({ task: { ...task, status: 'completed' } });
        await tick();
        expect(host.textContent).toContain('completed');
    });

    it('a partial update leaves the other props alone', async () => {
        const handle = mountComponent(Inspector, makeHost(), {
            task, usage: { total_tokens: 12400 },
        });
        handle.update({ activeChapter: 'i3' });
        await tick();
        expect(host.textContent).toContain('12.4k');   // usage survived
    });

    it('swapping the component for a host destroys the first one', async () => {
        mountComponent(Inspector, makeHost(), { task });
        expect(host.textContent).toContain('#abc12345');
        // FileTree wants an empty tree; the point is only that Inspector is gone.
        mountComponent(FileTree, host, { node: { name: '', dirs: new Map(), files: [] } });
        await tick();
        expect(host.textContent).not.toContain('#abc12345');
    });
});

describe('destroyComponent', () => {
    it('unmounts and forgets the host', () => {
        mountComponent(Inspector, makeHost(), { task });
        expect(destroyComponent(host)).toBe(true);
        expect(isMounted(host)).toBe(false);
        expect(host.textContent.trim()).toBe('');
    });

    it('is safe on a bare element and on null', () => {
        expect(destroyComponent(document.createElement('div'))).toBe(false);
        expect(destroyComponent(null)).toBe(false);
    });

    it('is idempotent — teardown paths can overlap', () => {
        mountComponent(Inspector, makeHost(), { task });
        expect(destroyComponent(host)).toBe(true);
        expect(destroyComponent(host)).toBe(false);
    });

    it('survives a host already detached from the document', () => {
        mountComponent(Inspector, makeHost(), { task });
        host.remove();
        // Must not throw: this runs during the navigation that detached it.
        expect(() => destroyComponent(host)).not.toThrow();
    });

    it('lets the same host be mounted again afterwards', async () => {
        mountComponent(Inspector, makeHost(), { task });
        destroyComponent(host);
        mountComponent(Inspector, host, { task: { ...task, caller: 'CLI' } });
        await tick();
        expect(host.textContent).toContain('CLI');
        // Exactly one instance, not two stacked copies.
        expect(host.querySelectorAll('.insp-h').length).toBeGreaterThan(0);
        expect((host.textContent.match(/CLI/g) || []).length).toBe(1);
    });
});
