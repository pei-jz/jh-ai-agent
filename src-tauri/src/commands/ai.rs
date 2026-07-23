use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use std::time::Duration;
use std::io::Write;
use chrono::Local;
use tauri::Manager;
use super::ai_providers::build_request_body;
use super::ai_config::AiConfig;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
    /// NATIVE tool-call history (standards-aligned): an assistant turn that
    /// invoked tools carries them here in OpenAI wire format
    /// `[{id, type:"function", function:{name, arguments:string}}]`.
    /// Providers are RL-trained on this structure — replaying prior turns as a
    /// JSON text envelope taught weak models to answer in text (KIMI K3 bug).
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    /// For role:"tool" result messages: the id of the call this answers.
    #[serde(default)]
    pub tool_call_id: Option<String>,
    /// For role:"tool" messages: the tool name (needed by Gemini's
    /// functionResponse; informational elsewhere).
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LlmRequest {
    pub provider: String,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub system_prompt: Option<String>,
    pub images: Option<Vec<String>>,
    pub base_url: Option<String>,
    pub api_version: Option<String>,
    pub api_key: Option<String>,
    pub proxy: Option<String>,
    pub request_id: String,
    /// Native tool definitions in OpenAI function-calling format.
    /// When present (and provider is openai/azure/generic), they're forwarded
    /// to the LLM API and the streaming response is parsed for delta.tool_calls
    /// fragments rather than relying on the text-based markdown JSON protocol.
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
    /// Max output tokens. None ⇒ provider default (Anthropic falls back to 8192
    /// since it's a required field there). Sent to all providers when present.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Sampling temperature. None ⇒ provider default. Sent to all providers when present.
    #[serde(default)]
    pub temperature: Option<f32>,
}

/// Token usage parsed from a provider's streaming response. Emitted on the final
/// (done) chunk so the JS layer can report *real* token counts instead of an
/// estimate. Fields default to 0 when the provider doesn't report a value.
#[derive(Debug, Serialize, Clone, Default)]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    /// Input tokens served FROM the prompt cache (billed at ~10%). Anthropic
    /// reports this as `cache_read_input_tokens`; OpenAI as
    /// `prompt_tokens_details.cached_tokens`; Gemini as `cachedContentTokenCount`.
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    /// Input tokens WRITTEN to the cache this call (Anthropic only; billed at
    /// ~125%). 0 for providers that don't report a separate cache-write count.
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}


#[derive(Debug, Serialize, Clone)]
pub struct StreamChunk {
    pub request_id: String,
    pub delta: String,
    pub done: bool,
    pub error: Option<String>,
    /// Present only on the final (done) chunk when the provider reported usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

/// Recursively shorten embedded base64 image payloads in a JSON value so a
/// request body can be dumped to a log file without megabytes of base64. Targets
/// `image_url.url` ("data:…;base64,…") and Anthropic `source.data`. ASCII-safe.
fn truncate_base64_in_place(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if let serde_json::Value::String(s) = val {
                    let looks_image = s.starts_with("data:image")
                        || ((k == "url" || k == "data") && s.len() > 256);
                    if looks_image && s.len() > 96 {
                        let head: String = s.chars().take(80).collect();
                        *val = serde_json::Value::String(
                            format!("{}…[truncated, {} chars total]", head, s.len()),
                        );
                    }
                } else {
                    truncate_base64_in_place(val);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                truncate_base64_in_place(item);
            }
        }
        _ => {}
    }
}

async fn get_client(proxy_url: Option<String>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10));

    if let Some(url) = proxy_url {
        if !url.is_empty() {
            let proxy = Proxy::all(url).map_err(|e| format!("Invalid proxy URL: {}", e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|e| format!("Failed to build HTTP client: {}", e))
}

#[tauri::command]
pub async fn llm_chat_native<R: Runtime>(
    app: AppHandle<R>,
    mut payload: LlmRequest,
) -> Result<(), String> {
    let client = get_client(payload.proxy).await?;
    let request_id = payload.request_id.clone();

    // Load Config for API Keys
    let config_dir = app.path().app_config_dir().map_err(|e: tauri::Error| e.to_string())?;
    let config_path = config_dir.join("ai_config.json");
    let config: AiConfig = if config_path.exists() {
        let json = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())?
    } else {
        return Err("AI configuration not found. Please set API keys in settings.".to_string());
    };

    // Lookup LLM Instance configuration
    let mut resolved_provider = payload.provider.clone();
    let mut resolved_api_key = None;
    let mut resolved_base_url = payload.base_url.clone();
    let mut resolved_api_version = payload.api_version.clone();
    // Response-control params: prefer the per-request payload value, then the
    // per-connection instance config. None ⇒ provider default.
    let mut resolved_max_tokens = payload.max_tokens;
    let mut resolved_temperature = payload.temperature;

    if let Some(instances) = &config.llm_instances {
        if let Some(inst) = instances.iter().find(|i| i.id == payload.provider) {
            resolved_provider = inst.provider.clone();
            resolved_api_key = inst.api_key.clone();
            if inst.base_url.is_some() {
                resolved_base_url = inst.base_url.clone();
            }
            if inst.api_version.is_some() {
                resolved_api_version = inst.api_version.clone();
            }
            if resolved_max_tokens.is_none() {
                resolved_max_tokens = inst.max_output_tokens;
            }
            if resolved_temperature.is_none() {
                resolved_temperature = inst.temperature;
            }
        }
    }

    // Determine target URL and headers based on provider
    let (url, headers, _api_key) = match resolved_provider.as_str() {
        "openai" => {
            let key = resolved_api_key.or(config.openai_key).ok_or("OpenAI API key not set")?;
            let base = resolved_base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Authorization", format!("Bearer {}", key).parse().unwrap());
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, key)
        }
        "anthropic" => {
            let key = resolved_api_key.or(config.anthropic_key).ok_or("Anthropic API key not set")?;
            let base = resolved_base_url.unwrap_or_else(|| "https://api.anthropic.com/v1".to_string());
            let url = format!("{}/messages", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("x-api-key", key.parse().unwrap());
            h.insert("anthropic-version", "2023-06-01".parse().unwrap());
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, key)
        }
        "gemini" => {
            let key = resolved_api_key.or(config.gemini_key).ok_or("Gemini API key not set")?;
            let base = resolved_base_url.unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string());
            let url = format!("{}/models/{}:streamGenerateContent?alt=sse&key={}", base.trim_end_matches('/'), payload.model, key);
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, key)
        }
        "ollama" => {
            let base = resolved_base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            let url = format!("{}/api/chat", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, String::new())
        }
        "azure" => {
            let key = resolved_api_key.or(config.azure_key).ok_or("Azure OpenAI API key not set")?;
            let base = resolved_base_url.or(config.azure_endpoint).ok_or("Azure OpenAI Base URL not set")?;
            // 2024-08-01-preview is the first Azure OpenAI api-version with
            // Structured Outputs (strict function calling) support.
            let api_version = resolved_api_version.or(payload.api_version).unwrap_or_else(|| "2024-08-01-preview".to_string());
            let url = format!(
                "{}/openai/deployments/{}/chat/completions?api-version={}",
                base.trim_end_matches('/'),
                payload.model,
                api_version
            );
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("api-key", key.parse().unwrap());
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, key)
        }
        "generic" => {
            let key = resolved_api_key.or(payload.api_key).unwrap_or_default();
            let base = resolved_base_url.unwrap_or_else(|| "http://localhost:11434/v1".to_string());
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            if !key.is_empty() {
                h.insert("Authorization", format!("Bearer {}", key).parse().unwrap());
            }
            h.insert("Content-Type", "application/json".parse().unwrap());
            (url, h, key)
        }
        _ => return Err(format!("Unsupported provider: {}", resolved_provider)),
    };

    // Construct body (Provider specific)
    // Construct body (provider-specific). See ai_providers::build_request_body.
    let body = build_request_body(
        &resolved_provider,
        &payload.model,
        std::mem::take(&mut payload.messages),
        payload.system_prompt.take(),
        &payload.images,
        &payload.tools,
        resolved_max_tokens,
        resolved_temperature,
    );

    // ── Surface the EXACT assembled request body to the frontend ──────────
    // This is the real wire payload (provider-specific: cache_control breakpoints,
    // the system stable/volatile split, the trailing volatile user message for
    // OpenAI, messages in send order, tools). The Monitor "API logs" modal shows
    // it as a "Sent (raw)" tab so caching behavior can be judged from what was
    // actually thrown. base64 image data is truncated to keep the payload small.
    {
        let mut sent = body.clone();
        truncate_base64_in_place(&mut sent);
        let _ = app.emit("llm-request-sent", serde_json::json!({
            "request_id": payload.request_id,
            "url": url,
            "provider": resolved_provider,
            "model": payload.model,
            "body": sent,
        }));
    }

    // ── Optional raw-request dump (opt-in via env JHAI_DEBUG_LLM_BODY=1) ──
    // Writes the EXACT request body actually sent to the provider — with base64
    // image data truncated so the file stays small — to the system temp dir.
    // This is the authoritative way to confirm whether image_url / image parts
    // reached the LLM (e.g. to verify a "vision not supported" drop). Off by
    // default; one file per request id.
    if std::env::var("JHAI_DEBUG_LLM_BODY").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false) {
        let mut dump = body.clone();
        truncate_base64_in_place(&mut dump);
        let pretty = serde_json::to_string_pretty(&serde_json::json!({
            "url": url,
            "provider": resolved_provider,
            "model": payload.model,
            "request_id": payload.request_id,
            "body": dump,
        })).unwrap_or_else(|_| "{}".to_string());
        let path = std::env::temp_dir().join(format!("jhai_llm_req_{}.json", payload.request_id));
        let _ = std::fs::write(&path, &pretty);
        eprintln!("[JHAI] LLM request body dumped to {}", path.display());
    }

    // Send Request
    let response = client.post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error accessing {}: {}", url, e))?;

    if !response.status().is_success() {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "API Error ({}):\nURL: {}\nStatus: {}\nResponse: {}", 
            resolved_provider, url, status, err_body
        ));
    }

    let mut stream = response.bytes_stream();
    let rid = request_id.clone();
    
    // Setup Logging if enabled
    let logging_config = {
        let config_dir = app.path().app_config_dir().unwrap_or_default();
        let config_path = config_dir.join("ai_config.json");
        if config_path.exists() {
            let json = std::fs::read_to_string(config_path).unwrap_or_default();
            serde_json::from_str::<AiConfig>(&json).ok()
        } else {
            None
        }
    };

    let log_enabled = logging_config.as_ref().and_then(|c| c.logging_enabled).unwrap_or(false);
    let log_dir = logging_config.as_ref().and_then(|c| c.log_dir.clone());
    let provider_name = resolved_provider.clone();
    let model_name = payload.model.clone();
    let request_payload = body.clone();

    tokio::spawn(async move {
        let mut full_response = String::new();
        // Real token usage, accumulated from the provider's streaming response.
        // Stays all-zero if the provider never reports it (JS then falls back to
        // its own estimator). See per-provider extraction in the parse loop below.
        let mut usage = TokenUsage::default();

        // ── Native tool_calls accumulator (OpenAI streaming format) ──
        // OpenAI / DeepSeek emit function-call results across many small SSE chunks:
        //   delta.tool_calls[0].id        ← appears once (first chunk)
        //   delta.tool_calls[0].function.name      ← appears once
        //   delta.tool_calls[0].function.arguments ← appears as STRING fragments
        // We accumulate per index, then emit ONE synthesized envelope at end-of-stream
        // so the JS chatWithTools path can JSON.parse it as a tool-call response.
        use std::collections::BTreeMap;
        let mut tool_calls_acc: BTreeMap<u64, serde_json::Value> = BTreeMap::new();
        // ── Anthropic tool_use accumulator ──
        // Anthropic emits: content_block_start(type=tool_use) then content_block_delta(input_json_delta)
        let mut anthropic_tool_acc: BTreeMap<u64, serde_json::Value> = BTreeMap::new();

        // ── SSE line reassembly ──────────────────────────────────────────
        // A network chunk boundary can fall ANYWHERE — including the middle of
        // an SSE `data:` line. The previous loop decoded each chunk on its own
        // and split it on '\n', so a split line produced two useless halves:
        // the head failed to parse as JSON and the tail didn't start with
        // "data: ", so BOTH were silently dropped. The characters in that
        // fragment were simply lost from the response.
        //
        // For prose that looks like a typo; for a streamed tool call it
        // corrupts the arguments, because the lost fragment is often just a
        // separator — which is exactly the observed damage:
        //     "name":"read_file"      → "nameread_file"     (lost `":`)
        //     "a.jsx","offset":1      → "a.jsxoffset":1     (lost `","`)
        // Decoding per chunk also mangled any multi-byte UTF-8 character
        // straddling a boundary into U+FFFD (garbled Japanese).
        //
        // Fix: accumulate BYTES and only ever decode/dispatch COMPLETE lines,
        // keeping the trailing partial line for the next chunk.
        let mut sse_buf: Vec<u8> = Vec::new();
        let mut eos = false;
        while !eos {
            let chunk: Option<Vec<u8>> = match stream.next().await {
                Some(Ok(b)) => Some(b.to_vec()),
                Some(Err(e)) => {
                    let _ = app.emit("llm-chunk", StreamChunk {
                        request_id: rid.clone(),
                        delta: String::new(),
                        done: true,
                        error: Some(format!("Stream error: {}", e)),
                        usage: None,
                    });
                    None
                }
                // End of stream: feed a synthetic newline so a final line that
                // arrived without its terminator is still processed, once.
                None => { eos = true; Some(b"\n".to_vec()) }
            };
            match chunk {
                Some(bytes) => {
                    sse_buf.extend_from_slice(&bytes);
                    for line in take_complete_lines(&mut sse_buf) {
                        let line = line.trim();
                        if line.is_empty() { continue; }

                        let delta = match resolved_provider.as_str() {
                            "openai" | "azure" | "generic" => {
                                if line.starts_with("data: ") && line != "data: [DONE]" {
                                    let json_str = &line[6..];
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        // ── Usage (final chunk carries choices:[] + usage:{...}) ──
                                        if json.get("usage").map_or(false, |u| u.is_object()) {
                                            let u = &json["usage"];
                                            let p = u["prompt_tokens"].as_u64().unwrap_or(0);
                                            let c = u["completion_tokens"].as_u64().unwrap_or(0);
                                            let t = u["total_tokens"].as_u64().unwrap_or(0);
                                            // Cached tokens are a SUBSET of prompt_tokens
                                            // (informational — already counted in total).
                                            // OpenAI:   prompt_tokens_details.cached_tokens
                                            // DeepSeek: prompt_cache_hit_tokens (its automatic
                                            //           context cache; prompt = hit + miss).
                                            let cached = u["prompt_tokens_details"]["cached_tokens"].as_u64()
                                                .or(u["prompt_cache_hit_tokens"].as_u64())
                                                .unwrap_or(0);
                                            if p > 0 { usage.prompt_tokens = p; }
                                            if c > 0 { usage.completion_tokens = c; }
                                            if t > 0 { usage.total_tokens = t; }
                                            if cached > 0 { usage.cache_read_input_tokens = cached; }
                                        }
                                        // ── Branch 1: regular content delta ──
                                        let content = json["choices"][0]["delta"]["content"]
                                            .as_str().unwrap_or_default().to_string();

                                        // ── Branch 2: tool_calls fragments ──
                                        // These flow across many chunks; we merge by index.
                                        if let Some(tcs) = json["choices"][0]["delta"]["tool_calls"].as_array() {
                                            for tc in tcs {
                                                let idx = tc["index"].as_u64().unwrap_or(0);
                                                let entry = tool_calls_acc.entry(idx).or_insert_with(|| serde_json::json!({
                                                    "id": "",
                                                    "type": "function",
                                                    "function": { "name": "", "arguments": "" }
                                                }));
                                                if let Some(id) = tc["id"].as_str() {
                                                    if !id.is_empty() { entry["id"] = serde_json::Value::String(id.to_string()); }
                                                }
                                                if let Some(t) = tc["type"].as_str() {
                                                    entry["type"] = serde_json::Value::String(t.to_string());
                                                }
                                                if let Some(name) = tc["function"]["name"].as_str() {
                                                    if !name.is_empty() {
                                                        entry["function"]["name"] = serde_json::Value::String(name.to_string());
                                                    }
                                                }
                                                if let Some(args_frag) = tc["function"]["arguments"].as_str() {
                                                    let cur = entry["function"]["arguments"].as_str().unwrap_or("").to_string();
                                                    entry["function"]["arguments"] = serde_json::Value::String(cur + args_frag);
                                                }
                                            }
                                        }
                                        content
                                    } else { String::new() }
                                } else { String::new() }
                            }
                            "anthropic" => {
                                if line.starts_with("data: ") {
                                    let json_str = &line[6..];
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        match json["type"].as_str().unwrap_or("") {
                                            "message_start" => {
                                                // input_tokens reported up-front; output_tokens
                                                // is the running tally (final value in message_delta).
                                                // With prompt caching, input_tokens counts ONLY the
                                                // uncached portion; cached/written counts are separate
                                                // and ADDITIVE to total input.
                                                let mu = &json["message"]["usage"];
                                                let p = mu["input_tokens"].as_u64().unwrap_or(0);
                                                let c = mu["output_tokens"].as_u64().unwrap_or(0);
                                                let cr = mu["cache_read_input_tokens"].as_u64().unwrap_or(0);
                                                let cc = mu["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                                                if p > 0 { usage.prompt_tokens = p; }
                                                if c > 0 { usage.completion_tokens = c; }
                                                if cr > 0 { usage.cache_read_input_tokens = cr; }
                                                if cc > 0 { usage.cache_creation_input_tokens = cc; }
                                                String::new()
                                            }
                                            "message_delta" => {
                                                // Final output_tokens count lands here.
                                                let c = json["usage"]["output_tokens"].as_u64().unwrap_or(0);
                                                if c > 0 { usage.completion_tokens = c; }
                                                String::new()
                                            }
                                            "content_block_start" => {
                                                // Capture tool_use block metadata (id + name)
                                                if json["content_block"]["type"] == "tool_use" {
                                                    let idx = json["index"].as_u64().unwrap_or(0);
                                                    let id = json["content_block"]["id"].as_str().unwrap_or("").to_string();
                                                    let name = json["content_block"]["name"].as_str().unwrap_or("").to_string();
                                                    anthropic_tool_acc.entry(idx).or_insert_with(|| serde_json::json!({
                                                        "id": id,
                                                        "type": "function",
                                                        "function": { "name": name, "arguments": "" }
                                                    }));
                                                }
                                                String::new()
                                            }
                                            "content_block_delta" => {
                                                let idx = json["index"].as_u64().unwrap_or(0);
                                                match json["delta"]["type"].as_str().unwrap_or("") {
                                                    "text_delta" => {
                                                        json["delta"]["text"].as_str().unwrap_or_default().to_string()
                                                    }
                                                    "input_json_delta" => {
                                                        // Accumulate tool input fragments
                                                        if let Some(entry) = anthropic_tool_acc.get_mut(&idx) {
                                                            let partial = json["delta"]["partial_json"].as_str().unwrap_or("");
                                                            let cur = entry["function"]["arguments"].as_str().unwrap_or("").to_string();
                                                            entry["function"]["arguments"] = serde_json::Value::String(cur + partial);
                                                        }
                                                        String::new()
                                                    }
                                                    _ => String::new()
                                                }
                                            }
                                            _ => String::new()
                                        }
                                    } else { String::new() }
                                } else { String::new() }
                            }
                            "gemini" => {
                                if line.starts_with("data: ") {
                                    let json_str = &line[6..];
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        // usageMetadata is cumulative per chunk — keep the latest.
                                        if let Some(um) = json.get("usageMetadata") {
                                            let p = um["promptTokenCount"].as_u64().unwrap_or(0);
                                            let c = um["candidatesTokenCount"].as_u64().unwrap_or(0);
                                            let t = um["totalTokenCount"].as_u64().unwrap_or(0);
                                            // Gemini cached tokens are a SUBSET of promptTokenCount.
                                            let cached = um["cachedContentTokenCount"].as_u64().unwrap_or(0);
                                            if p > 0 { usage.prompt_tokens = p; }
                                            if c > 0 { usage.completion_tokens = c; }
                                            if t > 0 { usage.total_tokens = t; }
                                            if cached > 0 { usage.cache_read_input_tokens = cached; }
                                        }
                                        // A Gemini chunk may carry multiple parts: text and/or
                                        // functionCall {name, args}. Accumulate text and convert
                                        // any functionCall into the shared tool_calls envelope.
                                        let mut text_acc = String::new();
                                        if let Some(parts) = json["candidates"][0]["content"]["parts"].as_array() {
                                            for part in parts {
                                                if let Some(t) = part["text"].as_str() {
                                                    text_acc.push_str(t);
                                                }
                                                if let Some(fc) = part.get("functionCall") {
                                                    let name = fc["name"].as_str().unwrap_or("").to_string();
                                                    let args = fc.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
                                                    let args_str = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                                                    let idx = tool_calls_acc.len() as u64;
                                                    tool_calls_acc.insert(idx, serde_json::json!({
                                                        "id": format!("call_{}", idx),
                                                        "type": "function",
                                                        "function": { "name": name, "arguments": args_str }
                                                    }));
                                                }
                                            }
                                        }
                                        text_acc
                                    } else { String::new() }
                                } else { String::new() }
                            }
                            "ollama" => {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                                    // Final message carries prompt_eval_count / eval_count.
                                    let p = json["prompt_eval_count"].as_u64().unwrap_or(0);
                                    let c = json["eval_count"].as_u64().unwrap_or(0);
                                    if p > 0 { usage.prompt_tokens = p; }
                                    if c > 0 { usage.completion_tokens = c; }
                                    json["message"]["content"].as_str().unwrap_or_default().to_string()
                                } else { String::new() }
                            }
                            _ => String::new()
                        };

                        if !delta.is_empty() {
                            full_response.push_str(&delta);
                            let _ = app.emit("llm-chunk", StreamChunk {
                                request_id: rid.clone(),
                                delta,
                                done: false,
                                error: None,
                                usage: None,
                            });
                        }
                    }
                }
                None => break,   // stream error — already reported above
            }
        }

        // ── Tool-call envelope emission ───────────────────────────────
        // Merge Anthropic tool_use accumulator into the shared tool_calls map
        // so both OpenAI-style and Anthropic-style tool calls use the same
        // emission path below.
        for (idx, tc) in anthropic_tool_acc {
            tool_calls_acc.insert(idx, tc);
        }

        // If we collected any tool_calls fragments, emit them as a single final
        // JSON envelope so the JS chatWithTools path can pick them up.
        // We send it as a delta (not done=true; the finalize emit below handles that).
        // The envelope shape MUST match what AgentController expects from
        // chatWithTools: `{ content, tool_calls: [{type:"function", function:{name, arguments}}] }`.
        if !tool_calls_acc.is_empty() {
            let tool_calls_array: Vec<serde_json::Value> = tool_calls_acc.into_values().collect();
            let envelope = serde_json::json!({
                "content": full_response.clone(),
                "tool_calls": tool_calls_array,
            });
            let envelope_str = serde_json::to_string(&envelope).unwrap_or_else(|_| String::from("{}"));
            // Replace the streamed full_response with the envelope — any partially-
            // streamed content was already captured inside the envelope's "content" field.
            full_response = envelope_str.clone();
            let _ = app.emit("llm-chunk", StreamChunk {
                request_id: rid.clone(),
                // Sentinel is a fixed ASCII marker that's vanishingly unlikely to
                // appear in regular LLM output. JS side strips it and treats the
                // remainder as the canonical envelope. Keep in sync with the
                // TOOL_ENVELOPE_SENTINEL constant in LLMService.js.
                delta: format!("<<<__TOOL_ENVELOPE__>>>{}", envelope_str),
                done: false,
                error: None,
                usage: None,
            });
        }

        // Final Logging
        if log_enabled {
            if let Some(dir) = log_dir {
                let _ = log_interaction(&dir, &provider_name, &model_name, &request_payload, &full_response);
            }
        }

        // Finalize — attach real token usage. Derive total if the provider only
        // gave us the two components (Anthropic/Ollama report parts, not a total).
        if usage.total_tokens == 0
            && (usage.prompt_tokens > 0 || usage.completion_tokens > 0
                || usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0)
        {
            // Anthropic/Ollama don't report a total. For Anthropic the cache counts
            // are SEPARATE from input_tokens, so include them to reflect full context
            // size. (OpenAI/Gemini report total directly, so this branch is skipped
            // and their cached counts stay subset-of-prompt as the providers intend.)
            usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
                + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        }
        let _ = app.emit("llm-chunk", StreamChunk {
            request_id: rid.clone(),
            delta: String::new(),
            done: true,
            error: None,
            usage: Some(usage),
        });
    });

    Ok(())
}

/// Split every COMPLETE line (one terminated by `\n`) off the SSE byte buffer,
/// leaving any trailing partial line in the buffer for the next network chunk.
///
/// Decoding is deliberately done here, per whole line, so a multi-byte UTF-8
/// character split across a chunk boundary is never lossy-decoded into U+FFFD.
/// Pure.
pub(crate) fn take_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    let mut consumed = 0usize;
    while let Some(pos) = buf[consumed..].iter().position(|&b| b == b'\n') {
        let end = consumed + pos;
        out.push(String::from_utf8_lossy(&buf[consumed..end]).into_owned());
        consumed = end + 1;
    }
    buf.drain(..consumed);
    out
}

fn log_interaction(dir: &str, provider: &str, model: &str, request: &serde_json::Value, response: &str) -> Result<(), String> {
    let log_path = std::path::Path::new(dir).join("ai_communication.log");
    
    // Check for rotation (5MB)
    if log_path.exists() {
        if let Ok(meta) = std::fs::metadata(&log_path) {
            if meta.len() > 5 * 1024 * 1024 {
                let ts = Local::now().format("%Y%m%d_%H%M%S").to_string();
                let new_path = std::path::Path::new(dir).join(format!("ai_communication_{}.log", ts));
                let _ = std::fs::rename(&log_path, new_path);
            }
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;

    let entry = serde_json::json!({
        "timestamp": Local::now().to_rfc3339(),
        "provider": provider,
        "model": model,
        "request": request,
        "response": response
    });

    writeln!(file, "{}", entry.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod sse_reassembly_tests {
    use super::take_complete_lines;

    /// Feed the buffer chunk by chunk, collecting every line the reader sees.
    fn drive(chunks: &[&[u8]]) -> Vec<String> {
        let mut buf: Vec<u8> = Vec::new();
        let mut seen = Vec::new();
        for c in chunks {
            buf.extend_from_slice(c);
            seen.extend(take_complete_lines(&mut buf));
        }
        // End-of-stream flush (the synthetic newline the reader appends).
        buf.push(b'\n');
        seen.extend(take_complete_lines(&mut buf));
        seen.into_iter().filter(|l| !l.trim().is_empty()).collect()
    }

    #[test]
    fn line_split_across_chunks_is_reassembled_not_lost() {
        // THE BUG: a tool-call argument fragment straddling a chunk boundary.
        // Splitting per chunk dropped both halves, silently deleting `","` from
        // the arguments and producing "a.jsxoffset".
        let lines = drive(&[
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"fun",
            b"ction\":{\"arguments\":\"\\\"a.jsx\\\",\\\"offset\\\"\"}}]}}]}\n",
        ]);
        assert_eq!(lines.len(), 1);
        let json: serde_json::Value =
            serde_json::from_str(lines[0].trim_start_matches("data: ")).expect("must parse");
        assert_eq!(
            json["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            "\"a.jsx\",\"offset\""
        );
    }

    #[test]
    fn multibyte_utf8_split_across_chunks_survives() {
        // "日本語" = 9 bytes; cut mid-character. Per-chunk lossy decoding turned
        // the halves into U+FFFD (garbled Japanese in narration and args).
        let s = "data: 日本語\n".as_bytes();
        let cut = 8; // inside the second char
        let lines = drive(&[&s[..cut], &s[cut..]]);
        assert_eq!(lines, vec!["data: 日本語".to_string()]);
        assert!(!lines[0].contains('\u{FFFD}'));
    }

    #[test]
    fn partial_line_is_retained_until_terminated() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: {\"a\":1}\ndata: partial");
        let first = take_complete_lines(&mut buf);
        assert_eq!(first, vec!["data: {\"a\":1}".to_string()]);
        assert_eq!(buf, b"data: partial");   // held for the next chunk
        buf.extend_from_slice(b"-rest\n");
        assert_eq!(take_complete_lines(&mut buf), vec!["data: partial-rest".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn handles_crlf_and_many_lines_in_one_chunk() {
        let lines = drive(&[b"data: a\r\ndata: b\r\n\r\ndata: [DONE]\r\n"]);
        let trimmed: Vec<&str> = lines.iter().map(|l| l.trim()).collect();
        assert_eq!(trimmed, vec!["data: a", "data: b", "data: [DONE]"]);
    }

    #[test]
    fn final_line_without_trailing_newline_is_still_delivered() {
        let lines = drive(&[b"data: {\"last\":true}"]);
        assert_eq!(lines, vec!["data: {\"last\":true}".to_string()]);
    }
}
