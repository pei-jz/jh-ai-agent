// Provider-specific context window limits (in tokens).
// Keys are matched longest-first against the model name (exact, then substring),
// so list more-specific keys before generic ones where it matters.
const MODEL_LIMITS = {
    // ── OpenAI ──
    'gpt-4o-mini': 128000,
    'gpt-4o': 128000,
    'gpt-4.1': 1047576,
    'gpt-4-turbo': 128000,
    'gpt-4': 128000,
    'gpt-3.5-turbo': 16385,
    'o1': 200000,
    'o3': 200000,
    'o4': 200000,
    // ── Anthropic ──
    'claude-opus-4': 200000,
    'claude-sonnet-4': 200000,
    'claude-haiku-4': 200000,
    'claude-3-7-sonnet': 200000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-haiku': 200000,
    'claude': 200000,            // generic Claude fallback
    // ── Gemini ──
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.0-flash': 1048576,
    'gemini-1.5-pro': 2097152,
    'gemini-1.5-flash': 1048576,
    'gemini': 1048576,           // generic Gemini fallback
    // ── DeepSeek (OpenAI-compatible endpoint) ──
    'deepseek-v4': 1000000,      // V4 (flash/pro): 1M context, 384K max output
    'deepseek-reasoner': 65536,  // V3-era
    'deepseek-chat': 65536,      // V3-era
    'deepseek-v3': 65536,
    'deepseek-v2': 131072,
    'deepseek': 131072,          // generic fallback (raised — V3.1+ is ≥128K)
    // ── Qwen ──
    'qwen-max': 32768,
    'qwen-plus': 131072,
    'qwen2.5': 131072,
    'qwen': 32768,               // generic Qwen fallback
    // ── Others ──
    'mistral': 32768,
    'llama-3': 131072,
    'llama': 8192,
    // Conservative default for genuinely unknown models. Raised from the old
    // 8192/32000 because nearly every modern model is ≥ 32K; under-guessing
    // triggers premature compaction (history budget = limit × fraction).
    'default': 32000,
};

// Final fallback when even the provider is unknown. Modern models are large;
// 128K is a safe middle ground that avoids over-aggressive compaction without
// risking API overflow for the rare small-window model (the 0.9 hard-limit
// guard in AgentController still protects against genuine overflow).
const UNKNOWN_PROVIDER_DEFAULT = 128000;

// CJK character regex (Japanese, Chinese, Korean)
const CJK_REGEX = /[\u3000-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\u{20000}-\u{2FA1F}]/u;

class TokenEstimator {
    /**
     * Estimate token count for a string.
     * English: ~1 token per 4 chars (GPT-like tokenization)
     * CJK: ~1 token per 1-2 chars (each character is usually 1-2 tokens)
     * Code: ~1 token per 3.5 chars (symbols and short identifiers)
     * 
     * @param {string} text - Text to estimate tokens for
     * @returns {number} Estimated token count
     */
    estimateTokens(text) {
        if (!text) return 0;

        let tokenEstimate = 0;
        let i = 0;

        while (i < text.length) {
            const char = text[i];

            if (CJK_REGEX.test(char)) {
                // CJK characters: ~1.5 tokens per character on average
                tokenEstimate += 1.5;
                i++;
            } else if (char === ' ' || char === '\n' || char === '\t') {
                // Whitespace: usually merged with adjacent tokens
                tokenEstimate += 0.25;
                i++;
            } else {
                // ASCII / Latin: ~1 token per 4 characters
                tokenEstimate += 0.28;
                i++;
            }
        }

        // Add overhead for message framing (~4 tokens per message)
        return Math.ceil(tokenEstimate);
    }

    /**
     * Estimate tokens for a full conversation history.
     * @param {Array} history - Array of { role, content } messages
     * @param {string} systemPrompt - System prompt text
     * @returns {Object} { totalTokens, systemTokens, historyTokens, breakdown }
     */
    estimateConversation(history, systemPrompt = '') {
        const systemTokens = this.estimateTokens(systemPrompt) + 4; // framing overhead
        
        let historyTokens = 0;
        const breakdown = [];

        for (const msg of history) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            const tokens = this.estimateTokens(content) + 4; // per-message overhead
            historyTokens += tokens;
            breakdown.push({
                role: msg.role,
                tokens,
                contentLength: content.length
            });
        }

        return {
            totalTokens: systemTokens + historyTokens,
            systemTokens,
            historyTokens,
            breakdown
        };
    }

    /**
     * Get the context window limit for a given model.
     *
     * Resolution order:
     *   1. explicitOverride (per-connection context_window set by the user) — always wins
     *   2. exact / substring match against the MODEL_LIMITS table on the bare model name
     *   3. provider-based default (using the REAL provider, passed in — NOT the
     *      instance-id prefix that modelId carries in this app)
     *   4. UNKNOWN_PROVIDER_DEFAULT
     *
     * @param {string} modelId        - Model ID. May be 'model', 'provider:model',
     *                                   or 'instanceId:model' (this app uses the last form).
     * @param {string} [providerHint]  - The real provider name ("openai"/"anthropic"/
     *                                   "gemini"/"ollama"/...). Pass this because modelId's
     *                                   prefix is the instance id, not the provider.
     * @param {number} [explicitOverride] - Per-connection context_window (tokens). Highest priority.
     * @returns {number} Maximum token limit
     */
    getModelLimit(modelId, providerHint = '', explicitOverride = 0) {
        // 1. Explicit per-connection override always wins.
        if (Number.isFinite(explicitOverride) && explicitOverride > 0) {
            return Math.floor(explicitOverride);
        }

        if (!modelId && !providerHint) return MODEL_LIMITS['default'];

        // Strip any prefix ("provider:" or "instanceId:") to get the bare model name.
        const modelName = (modelId && modelId.includes(':'))
            ? modelId.split(':').slice(1).join(':')
            : (modelId || '');
        const lname = modelName.toLowerCase();

        // 2a. Exact match
        if (MODEL_LIMITS[lname]) return MODEL_LIMITS[lname];

        // 2b. Substring match — iterate longest key first so "gpt-4o-mini" wins over "gpt-4".
        const keys = Object.keys(MODEL_LIMITS)
            .filter(k => k !== 'default')
            .sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (lname.includes(key)) return MODEL_LIMITS[key];
        }

        // 3. Provider-based default — use the REAL provider hint, not modelId's prefix
        //    (which in this app is the instance id and would never match).
        const provider = (providerHint || '').toLowerCase();
        switch (provider) {
            case 'openai': return 128000;
            case 'azure':  return 128000;
            case 'anthropic': return 200000;
            case 'gemini': return 1048576;
            case 'ollama': return 8192;
        }

        // 4. Genuinely unknown — assume a modern large-ish window rather than tiny.
        return UNKNOWN_PROVIDER_DEFAULT;
    }

    /**
     * Calculate what percentage of the context window is used.
     * @param {number} usedTokens - Currently used tokens
     * @param {string} modelId - Model identifier
     * @returns {Object} { usedPercent, remaining, limit, isNearLimit }
     */
    getUsageInfo(usedTokens, modelId) {
        const limit = this.getModelLimit(modelId);
        const remaining = Math.max(0, limit - usedTokens);
        const usedPercent = (usedTokens / limit) * 100;

        return {
            usedPercent: Math.round(usedPercent * 10) / 10,
            remaining,
            limit,
            isNearLimit: usedPercent > 75,
            isCritical: usedPercent > 90
        };
    }

    /**
     * Trim text to fit within a token budget.
     * Prioritizes keeping the beginning and end of the text (most relevant for code).
     * @param {string} text - Text to trim
     * @param {number} maxTokens - Maximum tokens allowed
     * @returns {string} Trimmed text
     */
    trimToFit(text, maxTokens) {
        const currentTokens = this.estimateTokens(text);
        if (currentTokens <= maxTokens) return text;

        // Rough character estimate for target
        const ratio = maxTokens / currentTokens;
        const targetChars = Math.floor(text.length * ratio * 0.9); // 10% safety margin

        if (targetChars < 100) return text.substring(0, 100) + '\n... (truncated)';

        // Keep first 60% and last 30% of the budget
        const headChars = Math.floor(targetChars * 0.6);
        const tailChars = Math.floor(targetChars * 0.3);

        const head = text.substring(0, headChars);
        const tail = text.substring(text.length - tailChars);

        return head + '\n\n... (中略: コンテキスト制限により省略) ...\n\n' + tail;
    }
}

export const tokenEstimator = new TokenEstimator();
