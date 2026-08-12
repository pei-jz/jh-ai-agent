// modelCapabilities — what the name heuristic claims, and where a connection's
// own setting has to override it.
//
// The heuristic is a guess and always was; these tests pin BOTH that it keeps
// its old answers (so nothing regresses for existing connections) and that an
// explicit setting beats it.

import { describe, it, expect } from 'vitest';
import { inferVisionSupport, instanceSupportsVision } from '../modelCapabilities.js';

describe('inferVisionSupport', () => {
    it.each([
        ['anthropic', 'claude-3-5-sonnet-20241022', true],
        ['gemini', 'gemini-1.5-pro', true],
        ['openai', 'gpt-4o', true],
        ['openai', 'chatgpt-4o-latest', true],
        ['openai', 'o1-preview', true],
        ['azure', 'my-gpt4o-deployment', true],
        ['openai', 'text-embedding-3-large', false],
        ['ollama', 'llama3', false],
    ])('%s / %s → %s', (provider, model, expected) => {
        expect(inferVisionSupport(provider, model)).toBe(expected);
    });

    it('is case- and junk-tolerant', () => {
        expect(inferVisionSupport('OpenAI', 'GPT-4O')).toBe(true);
        expect(inferVisionSupport(null, null)).toBe(false);
        expect(inferVisionSupport(undefined, 'gpt-4o')).toBe(false);
    });

    // The two failure modes that made the per-connection flag necessary.
    it('MISSES local vision models — no "gpt" in the name', () => {
        expect(inferVisionSupport('generic', 'llava:13b')).toBe(false);
        expect(inferVisionSupport('generic', 'qwen2-vl-7b')).toBe(false);
    });

    it('claims vision for EVERY anthropic/gemini model, including text-only ones', () => {
        expect(inferVisionSupport('anthropic', 'claude-instant-1.2')).toBe(true);
        expect(inferVisionSupport('gemini', 'text-embedding-004')).toBe(true);
    });
});

describe('instanceSupportsVision', () => {
    it('uses the connection setting when it has one', () => {
        expect(instanceSupportsVision({ provider: 'generic', model: 'llava:13b', supports_vision: true })).toBe(true);
        expect(instanceSupportsVision({ provider: 'anthropic', model: 'claude-instant-1.2', supports_vision: false })).toBe(false);
    });

    it('falls back to the guess when the connection says nothing', () => {
        // Every connection saved before the flag existed lands here, which is why
        // absent must keep behaving exactly as before rather than defaulting off.
        expect(instanceSupportsVision({ provider: 'openai', model: 'gpt-4o' })).toBe(true);
        expect(instanceSupportsVision({ provider: 'generic', model: 'llava:13b' })).toBe(false);
        expect(instanceSupportsVision({ provider: 'openai', model: 'gpt-4o', supports_vision: null })).toBe(true);
    });

    it('treats a non-boolean setting as "not set"', () => {
        expect(instanceSupportsVision({ provider: 'openai', model: 'gpt-4o', supports_vision: 'yes' })).toBe(true);
    });

    it('survives an empty instance', () => {
        expect(instanceSupportsVision({})).toBe(false);
        expect(instanceSupportsVision(null)).toBe(false);
    });
});
