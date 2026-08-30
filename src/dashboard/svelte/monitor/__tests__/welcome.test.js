// @vitest-environment jsdom
//
// Work's empty state.
//
// It replaced "Select a task / Choose an agent task from the left panel", which
// described the furniture. The reason you are on this screen with nothing
// selected is almost always that you have not started anything yet, so what is
// pinned here is that it OFFERS something, and that what it offers is real.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

import Welcome from '../Welcome.svelte';

const preset = (key, prompt, label = '') => ({ key, prompt, label });
const mount = (props = {}) => {
    const onPick = vi.fn();
    return { onPick, ...render(Welcome, { props: { onPick, ...props } }) };
};

afterEach(() => cleanup());

describe('the welcome', () => {
    it('asks the question the composer answers', () => {
        const { container } = mount();
        expect(container.querySelector('.wel-title').textContent).toContain('何をしますか');
    });

    it('offers the templates as starting points', () => {
        const { container } = mount({
            presets: [preset('a', 'read the config', 'Read config'), preset('b', 'x')],
        });
        expect(container.querySelectorAll('.wel-preset')).toHaveLength(2);
        expect(container.textContent).toContain('Read config');
    });

    it('hands the whole preset back, so the caller can record the use', async () => {
        const p = preset('a', 'read the config');
        const { container, onPick } = mount({ presets: [p] });
        await fireEvent.click(container.querySelector('.wel-preset'));
        expect(onPick).toHaveBeenCalledWith(p);
    });

    // The badge and the run have to agree: both come from looksComplex().
    it('labels a question 聞く and a job 頼む', () => {
        const { container } = mount({
            presets: [
                preset('q', 'auth_middleware は何を素通しにしてる？'),
                preset('j', 'MCP の WS 再接続が落ちる件を直して、テストも通して'),
            ],
        });
        const badges = [...container.querySelectorAll('.wel-badge')].map(b => b.textContent.trim());
        expect(badges).toEqual(['聞く', '頼む']);
    });

    it('keeps the full prompt as the title when the label is clipped', () => {
        const long = 'a'.repeat(200);
        const { container } = mount({ presets: [preset('a', long)] });
        const btn = container.querySelector('.wel-preset');
        expect(btn.getAttribute('title')).toBe(long);
        expect(btn.textContent.length).toBeLessThan(80);
    });

    // An empty frame says nothing. The thing to do is make a template, so say so.
    it('points at templates when there are none, instead of showing an empty box', () => {
        const { container } = mount({ presets: [] });
        expect(container.querySelectorAll('.wel-preset')).toHaveLength(0);
        const link = container.querySelector('.wel-add');
        expect(link).toBeTruthy();
        expect(link.getAttribute('href')).toBe('#config?tab=templates');
    });

    it('renders with no props at all rather than throwing', () => {
        const { container } = render(Welcome, { props: {} });
        expect(container.querySelector('.wel-title')).toBeTruthy();
    });
});
