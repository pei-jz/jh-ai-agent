// modelCapabilities — PURE guesses about what a model can do, from its name.
//
// Extracted from LLMService.modelSupportsVision so the same rule can seed the
// connection form's checkbox and be unit-tested without a provider.
//
// These are GUESSES, and the reason the explicit per-connection flag exists:
//
//   • anthropic / gemini are assumed vision-capable wholesale, which is wrong
//     for the text-only models in those families;
//   • an OpenAI-COMPATIBLE endpoint (`generic`) is judged by whether "gpt" is
//     in the name, so LLaVA / Qwen-VL / Llama-Vision — vision models, all of
//     them — were treated as text-only and never got the image.
//
// So: `inferVisionSupport` is only the DEFAULT. A connection that says what it
// is beats anything guessed here.

/**
 * Does this provider/model look like it accepts images?
 * @param {string} provider e.g. 'openai' | 'anthropic' | 'gemini' | 'azure' | 'generic'
 * @param {string} model    model name (no instance prefix)
 */
export function inferVisionSupport(provider, model) {
    const p = String(provider || '').toLowerCase();
    const m = String(model || '').toLowerCase();
    if (p === 'gemini' || p === 'anthropic') return true;
    if (p === 'openai' || p === 'azure' || p === 'generic') {
        return m.includes('gpt') || m.includes('chatgpt')
            || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')
            || m.includes('-o1') || m.includes('-o3') || m.includes('-o4');
    }
    return false;
}

/**
 * The answer for a connection: its own setting when it has one, the name-based
 * guess otherwise.
 * @param {{provider?:string, model?:string, supports_vision?:boolean|null}} instance
 */
export function instanceSupportsVision(instance) {
    if (typeof instance?.supports_vision === 'boolean') return instance.supports_vision;
    return inferVisionSupport(instance?.provider, instance?.model);
}
