import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ApiLogStore } from '../storage/ApiLogStore.js';
import { tokenEstimator } from './TokenEstimator.js';

class LLMService {
    constructor() {
        this.activeRequestStreams = new Map();
        // Filled in by initFromConfig() once apiClient is ready.
        // Format: "{instance_id}:{model_name}" — instance_id is resolved server-side
        // back to provider/api_key/base_url, so this string IS the routing key.
        this.currentModel = '';
        // The underlying provider name ("openai"/"gemini"/"anthropic"/"azure"/...).
        // Cached separately because currentModel's prefix is the instance-id, not the provider,
        // and several places need to switch behavior on the real provider (e.g. native tool calling).
        this.currentProvider = '';
        // Per-connection context_window (tokens) for the active model, if the user set one.
        // 0/null ⇒ no override; fall back to TokenEstimator's per-model table.
        this.currentContextWindow = 0;
        // Per-connection response-control overrides for the active model.
        // null ⇒ not set; the Rust side falls back to provider defaults
        // (Anthropic uses 8192 for max_tokens since it's required there).
        this.currentMaxOutputTokens = null;
        this.currentTemperature = null;
        this._initNativeListener();
    }

    /**
     * Load the active LLM model from the saved configuration.
     * Picks, in priority order:
     *   1. config.active_llm_instance_id (the user's explicit choice)
     *   2. The first instance in llm_instances
     *   3. Whatever `/api/models` returns first (legacy/fallback path)
     * Throws no errors — silently no-ops if no apiClient yet, so callers can
     * safely await it without try/catch every time.
     */
    async initFromConfig() {
        try {
            if (!window.apiClient) return null;

            // /api/models already emits each instance as `{inst.id}:{inst.model}`
            const res = await window.apiClient.getModels();
            const models = res?.models || [];
            if (models.length === 0) return null;

            // Try to read the saved "active" preference
            let activeId = null;
            try {
                const cfg = await invoke('get_ai_config');
                activeId = cfg?.active_llm_instance_id || null;
            } catch (_) { /* config not available — fall through */ }

            // 1. Honor explicit user choice if it still exists in the model list
            if (activeId) {
                const match = models.find(m => m.id.startsWith(`${activeId}:`));
                if (match) {
                    this.currentModel = match.id;
                    this.currentProvider = match.provider || match.id.split(':')[0];
                    this.currentContextWindow = Number(match.context_window) || 0;
                    this.currentMaxOutputTokens = Number(match.max_output_tokens) || null;
                    this.currentTemperature = (match.temperature ?? null);
                    return match.id;
                }
            }

            // 2. Otherwise default to the first available model
            this.currentModel = models[0].id;
            this.currentProvider = models[0].provider || models[0].id.split(':')[0];
            this.currentContextWindow = Number(models[0].context_window) || 0;
            this.currentMaxOutputTokens = Number(models[0].max_output_tokens) || null;
            this.currentTemperature = (models[0].temperature ?? null);
            return models[0].id;
        } catch (e) {
            console.warn('LLMService.initFromConfig failed:', e);
            return null;
        }
    }

    /** Returns the underlying provider name ("openai", "gemini", "anthropic", ...). */
    getCurrentProvider() {
        return this.currentProvider || (this.currentModel ? this.currentModel.split(':')[0] : '');
    }

    /**
     * Single source of truth for "does the current model support native function calling?".
     *
     * Design rules:
     *  1. Only providers known to implement the OpenAI-style function-call API return true.
     *  2. A per-connection override stored in the model registry takes precedence (field
     *     `tool_calling_mode: "json"` forces JSON mode regardless of provider).
     *  3. Model-name heuristics can opt-out specific models that are accessed via an
     *     OpenAI-compatible endpoint but do not reliably honour function calls.
     *
     * Called by both ContextBuilder (to pick the right system-prompt protocol) and
     * AgentController (to pick chatWithTools vs chat).  Having it in one place
     * guarantees those two always agree.
     */
    supportsNativeTools() {
        const provider = this.getCurrentProvider() || '';
        const model    = (this.getCurrentModel()   || '').toLowerCase();

        // 1. Provider allowlist — these are verified to support function-call API.
        const NATIVE_PROVIDERS = ['openai', 'gemini', 'anthropic', 'azure'];
        if (!NATIVE_PROVIDERS.includes(provider)) return false;

        // 2. Model-name opt-outs — models served via an OpenAI-compatible endpoint
        //    (provider = "openai") that do not reliably use the function-call mechanism.
        //    Add a model prefix/substring here if you observe "CALL: tool" text output
        //    instead of actual function calls.
        const JSON_MODE_MODELS = [
            // none currently confirmed — remove this comment once DeepSeek is retested
            // 'deepseek',   // uncomment if DeepSeek still misfires after prompt fix
        ];
        if (JSON_MODE_MODELS.some(m => model.includes(m))) return false;

        return true;
    }

    async _initNativeListener() {
        await listen('llm-chunk', (event) => {
            const { request_id, delta, done, error } = event.payload;
            const callback = this.activeRequestStreams.get(request_id);
            if (callback) {
                if (error) {
                    console.error('Native LLM Error:', error);
                    callback(null, true, error);
                    this.activeRequestStreams.delete(request_id);
                } else if (done) {
                    callback('', true);
                    this.activeRequestStreams.delete(request_id);
                } else {
                    callback(delta, false);
                }
            }
        });
    }

    setCurrentModel(modelId) {
        this.currentModel = modelId;
        // Best-effort re-resolution of currentProvider. ChatView typically calls
        // setCurrentModel with an id like "inst_xxx:gemini-2.5-flash" — to figure
        // out the real provider we have to consult the models list (async),
        // so we do that in the background. The immediate value (split prefix) is
        // a sane interim because chat() works either way; the difference only
        // matters for native-tool detection in agent flows.
        this.currentProvider = modelId ? modelId.split(':')[0] : '';
        // Reset per-connection overrides; _refreshCurrentProvider repopulates them
        // from the matched instance config asynchronously.
        this.currentContextWindow = 0;
        this.currentMaxOutputTokens = null;
        this.currentTemperature = null;
        this._refreshCurrentProvider().catch(() => {});
    }

    /** Background lookup of the real provider name for the currently-selected model id. */
    async _refreshCurrentProvider() {
        if (!window.apiClient || !this.currentModel) return;
        try {
            const res = await window.apiClient.getModels();
            const match = (res?.models || []).find(m => m.id === this.currentModel);
            if (match) {
                if (match.provider) this.currentProvider = match.provider;
                this.currentContextWindow = Number(match.context_window) || 0;
                this.currentMaxOutputTokens = Number(match.max_output_tokens) || null;
                this.currentTemperature = (match.temperature ?? null);
            }
        } catch (_) { /* no-op */ }
    }

    getCurrentModel() {
        return this.currentModel;
    }

    /** Per-connection context window override (tokens), or 0 if none set. */
    getContextWindow() {
        return this.currentContextWindow || 0;
    }

    /**
     * Single source of truth for "how many tokens fit in the active model's context window".
     * Combines the per-connection override (if set), the real provider name (not the
     * instance-id prefix), and TokenEstimator's per-model table. All compaction/budget
     * logic should call THIS rather than tokenEstimator.getModelLimit() directly, so the
     * user's per-connection context_window is always honored.
     */
    getEffectiveModelLimit() {
        return tokenEstimator.getModelLimit(
            this.currentModel,
            this.getCurrentProvider(),
            this.currentContextWindow
        );
    }

    async generate(prompt, systemPrompt, onStream, abortSignal) {
        return await this.chat([{ role: 'user', content: prompt }], systemPrompt, onStream, abortSignal);
    }

    async chat(messages, systemPrompt, onStream, abortSignal, images = []) {
        // If no model is set yet (e.g. agent started before initFromConfig finished),
        // try to load it on-demand. Fail with a clear message if there's still none.
        if (!this.currentModel) {
            await this.initFromConfig();
        }
        const modelId = this.currentModel;
        if (!modelId) {
            throw new Error(
                'No LLM connection configured. Open Settings → LLM Connections and add at least one connection (and Save).'
            );
        }

        const [providerName] = modelId.split(':');
        const modelName = modelId.substring(modelId.indexOf(':') + 1);

        const requestId = Math.random().toString(36).substring(7);
        let fullResponse = '';
        const _startTime = Date.now();

        // Load config via Tauri
        const config = await invoke('get_ai_config');

        // Prepare request payload for Rust backend
        const payload = {
            provider: providerName,
            model: modelName,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            system_prompt: systemPrompt || null,
            images: images.length > 0 ? images : null,
            base_url: providerName === 'azure' ? config.azure_endpoint : (providerName === 'ollama' ? 'http://localhost:11434' : null),
            api_version: providerName === 'azure' ? '2024-02-15-preview' : null,
            api_key: null,
            proxy: config.proxy_url || null,
            request_id: requestId,
            // Response-control overrides (null ⇒ Rust resolves from instance config / provider default)
            max_tokens: this.currentMaxOutputTokens || null,
            temperature: (this.currentTemperature ?? null)
        };

        return new Promise(async (resolve, reject) => {
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    this.activeRequestStreams.delete(requestId);
                    reject(new Error('AbortError: Request cancelled by user'));
                });
            }

            this.activeRequestStreams.set(requestId, (delta, done, error) => {
                if (error) {
                    ApiLogStore.save({
                        id: requestId,
                        timestamp: new Date().toISOString(),
                        model: modelId,
                        provider: providerName,
                        messages_count: messages.length,
                        prompt_preview: (messages[messages.length - 1]?.content || '').substring(0, 120),
                        response_preview: '',
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                        latency_ms: Date.now() - _startTime,
                        error: String(error)
                    });
                    reject(new Error(error));
                } else if (done) {
                    const usage = {
                        prompt_tokens: 0,
                        completion_tokens: fullResponse.length,
                        total_tokens: fullResponse.length
                    };
                    ApiLogStore.save({
                        id: requestId,
                        timestamp: new Date().toISOString(),
                        model: modelId,
                        provider: providerName,
                        messages_count: messages.length,
                        prompt_preview: (messages[messages.length - 1]?.content || '').substring(0, 120),
                        response_preview: fullResponse.substring(0, 120),
                        prompt_tokens: usage.prompt_tokens,
                        completion_tokens: usage.completion_tokens,
                        total_tokens: usage.total_tokens,
                        latency_ms: Date.now() - _startTime,
                        error: null
                    });
                    resolve({ content: fullResponse, usage });
                } else {
                    fullResponse += delta;
                    onStream?.(delta);
                }
            });

            try {
                await invoke('llm_chat_native', { payload });
            } catch (e) {
                this.activeRequestStreams.delete(requestId);
                reject(e);
            }
        });
    }

    /**
     * Chat with native tool/function calling support.
     * Sends tool definitions to the Rust backend for provider-specific formatting.
     * @param {Array} messages - Chat messages
     * @param {string} systemPrompt - System prompt
     * @param {Array} tools - Tool definitions in OpenAI format
     * @param {AbortSignal} abortSignal - Optional abort signal
     * @param {Array} images - Optional base64 images
     * @returns {Object} { content: string, toolCalls: Array|null, usage: Object }
     */
    async chatWithTools(messages, systemPrompt, tools, abortSignal, images = []) {
        // If no model is set yet (e.g. agent started before initFromConfig finished),
        // try to load it on-demand. Fail with a clear message if there's still none.
        if (!this.currentModel) {
            await this.initFromConfig();
        }
        const modelId = this.currentModel;
        if (!modelId) {
            throw new Error(
                'No LLM connection configured. Open Settings → LLM Connections and add at least one connection (and Save).'
            );
        }

        // `providerName` here is the routing token sent to Rust — it may be either a real
        // provider name ("openai") or an instance id ("inst_1716..."). Either is fine because
        // the Rust handler resolves instance ids back to the underlying provider.
        const [providerName] = modelId.split(':');
        const modelName = modelId.substring(modelId.indexOf(':') + 1);

        // For the native-tool-calling capability check, use the *underlying* provider —
        // an instance id like "inst_1716..." would otherwise miss this whitelist.
        const underlyingProvider = this.getCurrentProvider();
        const supportsNativeTools = ['openai', 'gemini', 'anthropic', 'azure'].includes(underlyingProvider);
        if (!supportsNativeTools) {
            // Fallback: use regular chat (tool calls will be parsed from response text)
            const result = await this.chat(messages, systemPrompt, null, abortSignal, images);
            return { ...result, toolCalls: null };
        }

        const requestId = Math.random().toString(36).substring(7);
        let fullResponse = '';

        const config = await invoke('get_ai_config');

        const payload = {
            provider: providerName,
            model: modelName,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            system_prompt: systemPrompt || null,
            images: images.length > 0 ? images : null,
            base_url: providerName === 'azure' ? config.azure_endpoint : (providerName === 'ollama' ? 'http://localhost:11434' : null),
            api_version: providerName === 'azure' ? '2024-02-15-preview' : null,
            api_key: null,
            proxy: config.proxy_url || null,
            request_id: requestId,
            tools: tools,  // Native tool definitions
            // Response-control overrides (null ⇒ Rust resolves from instance config / provider default)
            max_tokens: this.currentMaxOutputTokens || null,
            temperature: (this.currentTemperature ?? null)
        };

        return new Promise(async (resolve, reject) => {
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    this.activeRequestStreams.delete(requestId);
                    reject(new Error('AbortError: Request cancelled by user'));
                });
            }

            // Sentinel prefix used by the Rust streaming parser to deliver a
            // synthesized tool-call envelope as a single final delta. When we see
            // it, we discard everything streamed so far and use the envelope as
            // the canonical response. Keep in sync with ai.rs envelope emission.
            // (Rewriting this line clean — earlier version contained literal NULs.)
            const TOOL_ENVELOPE_SENTINEL = '<<<__TOOL_ENVELOPE__>>>';

            this.activeRequestStreams.set(requestId, (delta, done, error) => {
                if (error) {
                    reject(new Error(error));
                } else if (done) {
                    const usage = {
                        prompt_tokens: 0,
                        completion_tokens: fullResponse.length,
                        total_tokens: fullResponse.length
                    };

                    // Try to parse native tool calls from the response
                    let toolCalls = null;
                    try {
                        const parsed = JSON.parse(fullResponse);
                        if (parsed && parsed.tool_calls) {
                            toolCalls = parsed.tool_calls;
                            resolve({ content: parsed.content || '', toolCalls, usage });
                            return;
                        }
                    } catch (e) {
                        // Not a tool call response, return as regular text
                    }

                    resolve({ content: fullResponse, toolCalls: null, usage });
                } else {
                    // Detect the Rust-emitted tool-call envelope sentinel. When present,
                    // the delta payload after the sentinel IS the complete envelope JSON,
                    // and any previously-streamed content should be discarded (the
                    // envelope already contains its own "content" field).
                    if (delta && delta.startsWith(TOOL_ENVELOPE_SENTINEL)) {
                        fullResponse = delta.slice(TOOL_ENVELOPE_SENTINEL.length);
                    } else {
                        fullResponse += delta;
                    }
                }
            });

            try {
                await invoke('llm_chat_native', { payload });
            } catch (e) {
                this.activeRequestStreams.delete(requestId);
                reject(e);
            }
        });
    }
}
export default new LLMService();
