import { describe, it, expect, vi } from 'vitest';

// The module exports a singleton; reset the module registry so every test
// starts from a manager that has loaded nothing.
const fresh = async () => {
    vi.resetModules();
    return (await import('../PromptTemplateManager.js')).promptTemplateManager;
};

describe('PromptTemplateManager.toConfigValue', () => {
    // The save reads null as "not mentioned — keep what is stored"
    // (merge_preserving). Deleting the last template sent null, and the
    // template came back after every reload.
    it('sends {} after the last template is removed, so the deletion is saved', async () => {
        const m = await fresh();
        m.loadFromConfig({ prompt_templates: { wiki: { label: 'wiki検索', prompt: 'wiki検索', icon: '①' } } });
        m.remove('wiki');
        expect(m.toConfigValue()).toEqual({});
    });

    it('sends {} for a loaded config that has no templates', async () => {
        const m = await fresh();
        m.loadFromConfig({});
        expect(m.toConfigValue()).toEqual({});
    });

    it('sends null before anything is loaded, so a stored map is not overwritten', async () => {
        const m = await fresh();
        expect(m.toConfigValue()).toBeNull();
    });

    it('sends the remaining templates after one of several is removed', async () => {
        const m = await fresh();
        m.loadFromConfig({ prompt_templates: { a: { label: 'A', prompt: 'a' }, b: { label: 'B', prompt: 'b' } } });
        m.remove('a');
        expect(m.toConfigValue()).toEqual({ b: { label: 'B', prompt: 'b' } });
    });

    it('sends a template added without a prior load', async () => {
        const m = await fresh();
        m.set('new', 'New', 'prompt');
        expect(m.toConfigValue()).toEqual({ new: { label: 'New', prompt: 'prompt', icon: '📝' } });
    });
});
