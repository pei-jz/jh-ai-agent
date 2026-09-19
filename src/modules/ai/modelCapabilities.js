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

// ── Reasoning depth ──────────────────────────────────────────────────────
//
// `reasoning_effort` is the mirror image of `temperature`: the models that take
// one reject the other. Which is why the connection form shows the two fields
// by turns rather than both at once — a dialog offering a setting the model
// will 400 on is a dialog that teaches the wrong thing.
//
// The rule below is the SAME rule the backend applies (ai_providers.rs
// `is_reasoning_model`). It is duplicated rather than fetched because the form
// has to decide what to draw before anything has been sent anywhere; the
// backend still has the last word on what goes on the wire.

/** The depths the OpenAI API accepts, shallowest first. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/**
 * Does this provider/model spend hidden reasoning tokens before answering?
 * True ⇒ it takes `reasoning_effort` and rejects `temperature`.
 * @param {string} provider
 * @param {string} model
 */
export function inferReasoningModel(provider, model) {
    const p = String(provider || '').toLowerCase();
    // An OpenAI-family wire format is what makes the parameter meaningful.
    // Anthropic and Gemini think too, but through their own parameters.
    if (!['openai', 'azure', 'generic'].includes(p)) return false;
    const m = String(model || '').toLowerCase();
    // gpt-5-chat is the NON-reasoning variant of the family.
    return (m.includes('gpt-5') && !m.includes('chat'))
        || /^o[134]/.test(m) || /-o[134]/.test(m);
}

/**
 * "minimal" only exists on the gpt-5 family — the o-series rejects it. The form
 * hides what the model cannot take instead of offering a choice that 400s.
 * @param {string} model
 */
export function reasoningEffortsFor(model) {
    const m = String(model || '').toLowerCase();
    return m.includes('gpt-5') ? REASONING_EFFORTS : REASONING_EFFORTS.filter(e => e !== 'minimal');
}
