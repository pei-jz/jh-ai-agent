// @vitest-environment jsdom
//
// Settings → Usage (docs/design/information-architecture.md §7 step 4).
//
// The spend panel's own rules are covered in views/overview/__tests__ — these
// are about the RELOCATION: the tab has to fetch the task list the Dashboard
// used to have lying around, and it has to say so when it cannot, rather than
// rendering a convincing $0.00.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

import UsageTab from '../UsageTab.svelte';

const NOW = new Date(2026, 7, 12, 12, 0).getTime();
const hAgo = (n) => new Date(NOW - n * 3600000).toISOString();

const task = (over = {}) => ({
    id: Math.random().toString(36).slice(2, 8),
    prompt: 'do a thing',
    status: 'completed',
    started_at: hAgo(1),
    completed_at: hAgo(0.5),
    token_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    ...over,
});

const RATED = [
    { id: 'i1', name: 'Flash', model: 'flash', cost_per_1m_input: 0.3, cost_per_1m_output: 1.2 },
    { id: 'i2', name: 'Kimi', model: 'k3', cost_per_1m_input: 3, cost_per_1m_output: 15 },
];

function mount({ tasks = [], config = {}, fail = false } = {}) {
    const request = vi.fn(async () => {
        if (fail) throw new Error('ECONNREFUSED');
        return { tasks };
    });
    invoke.mockImplementation(async (cmd) => (cmd === 'get_ai_config' ? config : ''));
    return { request, ...render(UsageTab, { props: { api: { request } } }) };
}

beforeEach(() => { localStorage.clear(); invoke.mockClear(); });
afterEach(() => cleanup());

describe('Settings → Usage', () => {
    it('fetches the task list itself — the Dashboard is not there to supply it', async () => {
        const { request } = mount({ tasks: [task()] });
        await waitFor(() => expect(request).toHaveBeenCalledWith('/tasks'));
    });

    it('bills what ran, per model', async () => {
        const { container } = mount({
            tasks: [task({ model_usage: { 'i2:k3': { prompt_tokens: 1_000_000, completion_tokens: 0 } } })],
            config: { llm_instances: RATED },
        });
        await waitFor(() => expect(container.textContent).toMatch(/Kimi|k3/));
    });

    // A failed fetch must not look like "you spent nothing".
    it('says the read failed instead of showing a convincing zero', async () => {
        const { container } = mount({ fail: true });
        await waitFor(() => expect(container.textContent).toMatch(/ECONNREFUSED/));
    });

    it('keeps the window pick across visits', async () => {
        const { container } = mount({ tasks: [task()] });
        const btn = await waitFor(() => {
            const b = container.querySelector('.ds-range-btn:not(.is-on)');
            expect(b).toBeTruthy();
            return b;
        });
        await fireEvent.click(btn);
        await waitFor(() => expect(localStorage.getItem('jhai_dash_spend_range')).toBeTruthy());
    });

    it('renders with no tasks at all rather than throwing', async () => {
        const { container } = mount({ tasks: [] });
        await waitFor(() => expect(container.querySelector('.cfg-usage')).toBeTruthy());
    });
});
