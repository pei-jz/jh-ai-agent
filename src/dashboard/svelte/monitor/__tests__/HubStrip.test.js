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

const app = (over = {}) => ({ name: 'JHEditor', intents: [], resources: [], ...over });
const mount = (props = {}) => render(HubStrip, { props: { apps: [], ...props } }).container;

describe('HubStrip', () => {
    const full = app({
        intents: [{ id: 'impact_analysis', title: 'Impact analysis' }],
        resources: [{ uri: 'doc://current', name: 'MonitorView.js' }],
    });

    it('renders a chip per intent and per resource, under the app name', () => {
        const el = mount({ apps: [full] });
        expect(el.querySelector('.hub-app-name').textContent).toContain('JHEditor');
        expect(el.querySelector('.hub-intent').textContent).toContain('Impact analysis');
        expect(el.querySelector('.hub-res').textContent).toContain('MonitorView.js');
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
        // Emoji render in whatever emoji font the machine has and cannot take the
        // theme colour — the reason a task looked different on another PC.
        const el = mount({ apps: [full] });
        expect(el.querySelector('.hub-intent svg')).not.toBe(null);
        expect(el.querySelector('.hub-res svg')).not.toBe(null);
    });

    it('escapes hostile app and item names', () => {
        const el = mount({ apps: [app({
            name: '<img src=x>',
            intents: [{ id: 'i', title: '<script>x</script>' }],
        })] });
        expect(el.querySelector('img')).toBe(null);
        expect(el.querySelector('script')).toBe(null);
    });

    it('COMPOSES an intent request rather than dispatching it', () => {
        // Nothing may be sent behind the user's back.
        const onCompose = vi.fn();
        mount({ apps: [full], onCompose }).querySelector('.hub-intent').click();
        const text = onCompose.mock.calls[0][0];
        expect(text).toContain('JHEditor');
        expect(text).toContain('Impact analysis');
        expect(text).toContain('impact_analysis');
        // Left mid-sentence on purpose: the user finishes the instruction.
        expect(text.endsWith(', then ')).toBe(true);
    });

    it('composes a resource read with the qualified reference read_resource needs', () => {
        const onCompose = vi.fn();
        mount({ apps: [full], onCompose }).querySelector('.hub-res').click();
        const text = onCompose.mock.calls[0][0];
        expect(text).toContain('JHEditor::doc://current');
        expect(text).toContain('read_resource');
    });

    it('keeps the data attributes the strip is identified by', () => {
        const el = mount({ apps: [full] });
        expect(el.querySelector('[data-hub-kind="intent"]').dataset.hubApp).toBe('JHEditor');
        expect(el.querySelector('[data-hub-kind="resource"]').dataset.hubUri).toBe('doc://current');
    });
});
