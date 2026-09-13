// @vitest-environment jsdom
//
// HubStrip — the connected apps, made visible. Region 7.
//
// Replaces `hubStripHtml` plus the `querySelectorAll('[data-hub-kind]')` loop that
// read the app, kind, id, uri and name back off each button's data attributes — to
// reconstruct exactly what it had just rendered from. The item goes straight to the
// callback now, so these tests can assert the composed TEXT rather than the round trip.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import HubStrip from '../HubStrip.svelte';

afterEach(() => cleanup());

const app = (over = {}) => ({ name: 'JHEditor', resources: [], ...over });
const mount = (props = {}) => render(HubStrip, { props: { apps: [], ...props } }).container;

describe('HubStrip', () => {
    const full = app({ resources: [{ uri: 'doc://current', name: 'MonitorView.js' }] });

    it('renders a chip per resource, under the app name', () => {
        const el = mount({ apps: [full] });
        expect(el.querySelector('.hub-app-name').textContent).toContain('JHEditor');
        expect(el.querySelector('.hub-res').textContent).toContain('MonitorView.js');
    });

    // Intents were removed (Report_20260913 §6-6).
    it('draws no intent chips, even for a client that still sends intents', () => {
        const el = mount({ apps: [{ ...full, intents: [{ id: 'impact', title: 'Impact' }] }] });
        expect(el.querySelector('.hub-intent')).toBe(null);
        expect(el.querySelector('[data-hub-kind="intent"]')).toBe(null);
    });

    it('renders NOTHING when no app offers anything — no empty chrome', () => {
        expect(mount({ apps: [app()] }).textContent.trim()).toBe('');
        expect(mount({ apps: [] }).textContent.trim()).toBe('');
        expect(mount({ apps: null }).textContent.trim()).toBe('');
    });

    it('skips an app with nothing to offer but keeps the ones that do', () => {
        const el = mount({ apps: [app({ name: 'Empty' }), full] });
        const names = [...el.querySelectorAll('.hub-app-name')].map(n => n.textContent.trim());
        expect(names).toHaveLength(1);
        expect(names[0]).toContain('JHEditor');
    });

    it('uses inline SVG icons, not emoji', () => {
        expect(mount({ apps: [full] }).querySelector('.hub-res svg')).not.toBe(null);
    });

    it('escapes hostile app and item names', () => {
        const el = mount({ apps: [app({
            name: '<img src=x>',
            resources: [{ uri: 'u', name: '<script>x</script>' }],
        })] });
        expect(el.querySelector('img')).toBe(null);
        expect(el.querySelector('script')).toBe(null);
    });

    it('composes a resource read with the qualified reference read_resource needs', () => {
        const onCompose = vi.fn();
        mount({ apps: [full], onCompose }).querySelector('.hub-res').click();
        const text = onCompose.mock.calls[0][0];
        expect(text).toContain('JHEditor::doc://current');
        expect(text).toContain('read_resource');
        // Left mid-sentence on purpose: the user finishes the instruction.
        expect(text.endsWith(', then ')).toBe(true);
    });

    it('keeps the data attributes the strip is identified by', () => {
        const el = mount({ apps: [full] });
        expect(el.querySelector('[data-hub-kind="resource"]').dataset.hubUri).toBe('doc://current');
    });
});
