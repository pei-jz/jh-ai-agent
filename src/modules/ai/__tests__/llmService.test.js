// LLMService — the decisions that steer the whole agent, tested without a
// provider: which protocol to speak (native tool-calls vs the JSON envelope),
// and how to report token usage when a provider under-reports it.
//
// `supportsNativeTools` is the single source of truth shared by ContextBuilder
// (which system prompt to build) and AgentController (which API to call). If the
// two ever disagree, the model is told one protocol and asked for another — the
// failure mode behind the "tool call arrives as text" bugs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const llmService = (await import('../LLMService.js')).default;

beforeEach(() => {
    llmService._models = [];
    llmService.currentProvider = '';
    llmService.currentModel = '';
    try {
        globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    } catch (_) { /* non-browser env */ }
});

describe('getCurrentProvider', () => {
    it('prefers the explicit provider', () => {
        llmService.currentProvider = 'anthropic';
        llmService.currentModel = 'openai:gpt-4o';
        expect(llmService.getCurrentProvider()).toBe('anthropic');
    });
    it('falls back to the prefix of the model id', () => {
        llmService.currentProvider = '';
        llmService.currentModel = 'azure:gpt-4o';
        expect(llmService.getCurrentProvider()).toBe('azure');
    });
    it('is empty when nothing is configured', () => {
        expect(llmService.getCurrentProvider()).toBe('');
    });
});

describe('supportsNativeTools — provider allowlist', () => {
    it('is true only for providers verified to implement function calling', () => {
        for (const p of ['openai', 'gemini', 'anthropic', 'azure']) {
            llmService.currentProvider = p;
            llmService.currentModel = `${p}:some-model`;
            expect(llmService.supportsNativeTools()).toBe(true);
        }
    });

    it('is false for providers without a reliable function-call API', () => {
        for (const p of ['ollama', 'generic', 'unknown']) {
            llmService.currentProvider = p;
            llmService.currentModel = `${p}:some-model`;
            expect(llmService.supportsNativeTools()).toBe(false);
        }
    });

    it('evaluates the model ACTUALLY being sent when one is passed', () => {
        // Current label says a native provider…
        llmService.currentProvider = 'openai';
        llmService.currentModel = 'openai:gpt-4o';
        llmService._models = [{ id: 'inst_1', provider: 'ollama' }];
        // …but the call is being made against an ollama connection.
        expect(llmService.supportsNativeTools('inst_1')).toBe(false);
    });

    it('derives the provider from the id prefix when the model is unknown', () => {
        expect(llmService.supportsNativeTools('anthropic:claude-x')).toBe(true);
        expect(llmService.supportsNativeTools('ollama:llama3')).toBe(false);
    });
});

describe('supportsNativeTools — per-model JSON-mode opt-out', () => {
    it('honours the user forcing a model into JSON tool mode', () => {
        globalThis.localStorage = {
            getItem: (k) => (k === 'jhai_json_mode_models' ? '["openai:kimi-k3"]' : null),
            setItem: () => {}, removeItem: () => {},
        };
        llmService.currentProvider = 'openai';
        llmService.currentModel = 'openai:kimi-k3';
        expect(llmService.supportsNativeTools()).toBe(false);
    });

    it('leaves other models on the native protocol', () => {
        globalThis.localStorage = {
            getItem: (k) => (k === 'jhai_json_mode_models' ? '["openai:kimi-k3"]' : null),
            setItem: () => {}, removeItem: () => {},
        };
        llmService.currentProvider = 'openai';
        llmService.currentModel = 'openai:gpt-4o';
        expect(llmService.supportsNativeTools()).toBe(true);
    });

    it('survives a corrupt opt-out list instead of throwing', () => {
        globalThis.localStorage = {
            getItem: () => '{not json',
            setItem: () => {}, removeItem: () => {},
        };
        llmService.currentProvider = 'openai';
        llmService.currentModel = 'openai:gpt-4o';
        expect(() => llmService.supportsNativeTools()).not.toThrow();
    });
});

describe('_resolveUsage', () => {
    const msgs = [{ role: 'user', content: 'hello world' }];

    it('trusts the provider when it reported input-side numbers', () => {
        const u = llmService._resolveUsage(
            { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, msgs, 'sys', 'resp');
        expect(u).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, estimated: false });
    });

    it('derives the total when the provider omits it', () => {
        const u = llmService._resolveUsage({ prompt_tokens: 10, completion_tokens: 5 }, msgs, '', '');
        expect(u.total_tokens).toBe(15);
    });

    it('counts Anthropic cache tokens into the total (they are additive)', () => {
        const u = llmService._resolveUsage(
            { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
            msgs, '', '');
        expect(u.total_tokens).toBe(265);
        expect(u.cache_read_input_tokens).toBe(200);
        expect(u.estimated).toBe(false);
    });

    it('treats a cache-only report as real usage, not as "nothing reported"', () => {
        const u = llmService._resolveUsage({ cache_read_input_tokens: 500 }, msgs, '', '');
        expect(u.estimated).toBe(false);
        expect(u.cache_read_input_tokens).toBe(500);
    });

    it('estimates BOTH sides when the provider reported nothing', () => {
        const u = llmService._resolveUsage(null, msgs, 'system prompt text', 'a response');
        expect(u.estimated).toBe(true);
        expect(u.prompt_tokens).toBeGreaterThan(0);
        expect(u.completion_tokens).toBeGreaterThan(0);
    });

    it('keeps a real completion count but estimates the missing prompt', () => {
        // Anthropic-shaped third-party endpoints report output only; showing
        // input as 0 would be misleading.
        const u = llmService._resolveUsage({ completion_tokens: 42 }, msgs, 'sys', 'resp');
        expect(u.completion_tokens).toBe(42);
        expect(u.prompt_tokens).toBeGreaterThan(0);
    });

    it('handles an empty message list without throwing', () => {
        expect(() => llmService._resolveUsage(null, [], '', '')).not.toThrow();
    });
});
