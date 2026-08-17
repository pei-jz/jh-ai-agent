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

    it('falls back to the resolved provider when the models list is unavailable', () => {
        // The id prefix of a configured connection is the INSTANCE id, never a
        // provider name. With no cached registry (getModels failed / not run
        // yet), the prefix alone would answer "no native tools" and the request
        // would be sent WITHOUT tools — silently, with no error to see.
        llmService._models = [];
        llmService.currentProvider = 'azure';
        llmService.currentModel = 'inst_1716:gpt-4o-deploy';
        expect(llmService.supportsNativeTools('inst_1716:gpt-4o-deploy')).toBe(true);
    });

    it('does not apply that fallback to a DIFFERENT model id', () => {
        llmService._models = [];
        llmService.currentProvider = 'azure';
        llmService.currentModel = 'inst_1716:gpt-4o-deploy';
        // A per-task override for another (unknown) connection must not inherit
        // the active connection's provider.
        expect(llmService.supportsNativeTools('inst_9999:llama3')).toBe(false);
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

// ── _sanitizeMessagesForWire ─────────────────────────────────────────────
// After a history compaction the conversation can contain entries a strict
// provider (Azure OpenAI) rejects: a missing/empty role, an orphaned
// role:"tool" result (its assistant turn was summarized away), or an
// assistant tool_call whose result was dropped. The sanitizer must repair or
// safely downgrade each of these BEFORE the request is serialized.
describe('_sanitizeMessagesForWire', () => {
    it('passes a well-formed user/assistant exchange through unchanged', () => {
        const h = [
            { role: 'user', content: 'goal' },
            { role: 'assistant', content: 'working' },
            { role: 'user', content: 'next' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out).toEqual(h);
    });

    it('keeps a valid assistant(tool_calls) + role:"tool" pair', () => {
        const h = [
            { role: 'assistant', content: 'reading', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'file body' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toHaveLength(1);
        expect(out[1].role).toBe('tool');
        expect(out[1].tool_call_id).toBe('c1');
    });

    it('downgrades an ORPHAN role:"tool" (no paired assistant call) to user text', () => {
        // compactHistory dropped the assistant(tool_calls) turn but kept the
        // tool result → Azure 400s on role:"tool" with no preceding call.
        const h = [
            { role: 'user', content: 'goal' },
            { role: 'tool', tool_call_id: 'cX', name: 'grep_search', content: 'results' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[1].role).toBe('user');
        expect(out[1].content).toContain('grep_search');
        expect(out[1].content).toContain('results');
        expect(out.some(m => m.role === 'tool')).toBe(false);
    });

    it('downgrades a role:"tool" with NO tool_call_id to user text', () => {
        const h = [{ role: 'tool', name: 'read_file', content: 'x' }];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[0].role).toBe('user');
    });

    it('assigns role "user" to a message with a missing/empty role (Azure role-required 400)', () => {
        const h = [
            { role: 'user', content: 'goal' },
            { content: 'leftover note with no role' },
            { role: '', content: 'empty role' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out).toHaveLength(3);
        expect(out.every(m => typeof m.role === 'string' && m.role.length > 0)).toBe(true);
        expect(out[1].role).toBe('user');
        expect(out[1].content).toContain('leftover note with no role');
        expect(out[2].role).toBe('user');
    });

    it('drops an assistant tool_call whose result was summarized away (dangling call)', () => {
        const h = [
            { role: 'assistant', content: 'calling tool', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
            { role: 'user', content: 'next step' },   // no role:"tool" reply for c9
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[0].role).toBe('assistant');
        expect(out[0].tool_calls).toBeUndefined();
        expect(out[0].content).toBe('calling tool');
    });

    it('keeps only the tool_calls that still have a matching result', () => {
        const h = [
            { role: 'assistant', content: '', tool_calls: [
                { id: 'keep', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                { id: 'drop', type: 'function', function: { name: 'write_file', arguments: '{}' } },
            ]},
            { role: 'tool', tool_call_id: 'keep', name: 'read_file', content: 'ok' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[0].tool_calls.map(c => c.id)).toEqual(['keep']);
        expect(out[1].role).toBe('tool');
    });

    it('emits an EMPTY STRING (never null) for a pure tool-call assistant turn', () => {
        // Rust's LlmMessage.content is a String: a null here failed the whole
        // invoke ("invalid args `payload` … invalid type: null, expected a
        // string"), and since the bad turn stayed in history every retry hit
        // the same error and the run stalled. "" → null is Rust's job.
        const h = [
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'body' },
        ];
        const out = llmService._sanitizeMessagesForWire(h);
        expect(out[0].content).toBe('');
        expect(out.every(m => typeof m.content === 'string')).toBe(true);
    });

    it('returns an empty array for non-array input and skips malformed entries', () => {
        expect(llmService._sanitizeMessagesForWire(null)).toEqual([]);
        expect(llmService._sanitizeMessagesForWire(undefined)).toEqual([]);
        const out = llmService._sanitizeMessagesForWire([null, 'x', { role: 'user', content: 'ok' }]);
        expect(out).toEqual([{ role: 'user', content: 'ok' }]);
    });
});
