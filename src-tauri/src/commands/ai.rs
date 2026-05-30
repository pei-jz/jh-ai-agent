use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use std::time::Duration;
use std::io::Write;
use chrono::Local;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
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

#[derive(Debug, Serialize, Clone)]
pub struct StreamChunk {
    pub request_id: String,
    pub delta: String,
    pub done: bool,
    pub error: Option<String>,
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
    payload: LlmRequest,
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
            let api_version = resolved_api_version.or(payload.api_version).unwrap_or_else(|| "2024-02-15-preview".to_string());
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

    // ── Image data-URL helper ─────────────────────────────────────────────────
    // Frontend sends images as full data-URLs ("data:image/jpeg;base64,...") so
    // we can extract the real MIME type instead of hardcoding "image/png".
    fn parse_image_data_url(s: &str) -> (String, String) {
        // "data:<mime>;base64,<data>"
        if let Some(rest) = s.strip_prefix("data:") {
            if let Some(semi) = rest.find(';') {
                let mime = rest[..semi].to_string();
                let after = &rest[semi + 1..];
                if let Some(data) = after.strip_prefix("base64,") {
                    return (mime, data.to_string());
                }
            }
        }
        // Plain base64 fallback (backward-compat with old callers)
        ("image/png".to_string(), s.to_string())
    }

    // Construct body (Provider specific)
    let body = match resolved_provider.as_str() {
        "openai" | "ollama" | "azure" | "generic" => {
            let mut full_messages = Vec::new();
            if let Some(sys) = payload.system_prompt {
                full_messages.push(serde_json::json!({ "role": "system", "content": sys }));
            }

            let msg_len = payload.messages.len();
            for (i, m) in payload.messages.into_iter().enumerate() {
                // Attach images to the last user message
                if m.role == "user" && i == msg_len - 1 && payload.images.as_ref().map_or(false, |imgs| !imgs.is_empty()) {
                    let mut content_parts = Vec::new();
                    content_parts.push(serde_json::json!({ "type": "text", "text": m.content }));

                    if let Some(images) = &payload.images {
                        for img in images {
                            let (mime, data) = parse_image_data_url(img);
                            content_parts.push(serde_json::json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:{};base64,{}", mime, data) }
                            }));
                        }
                    }
                    full_messages.push(serde_json::json!({ "role": m.role, "content": content_parts }));
                } else {
                    full_messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
                }
            }
            let mut body_obj = serde_json::json!({
                "model": payload.model,
                "messages": full_messages,
                "stream": true
            });
            // Response-control params (OpenAI-compatible): only set when provided,
            // so unconfigured connections keep the provider's default behavior.
            if let Some(obj) = body_obj.as_object_mut() {
                if let Some(mt) = resolved_max_tokens {
                    obj.insert("max_tokens".to_string(), serde_json::json!(mt));
                }
                if let Some(temp) = resolved_temperature {
                    obj.insert("temperature".to_string(), serde_json::json!(temp));
                }
            }
            // Forward native tool definitions if provided. Excluded for "ollama"
            // (its OpenAI-compat layer doesn't reliably support function calling
            // — falls back to text JSON via the system prompt).
            if resolved_provider != "ollama" {
                if let Some(tools) = &payload.tools {
                    if let Some(obj) = body_obj.as_object_mut() {
                        obj.insert("tools".to_string(), tools.clone());
                        obj.insert("tool_choice".to_string(), serde_json::json!("auto"));
                    }
                }
            }
            body_obj
        }
        "anthropic" => {
            let mut full_messages = Vec::new();
            let msg_len = payload.messages.len();
            for (i, m) in payload.messages.into_iter().enumerate() {
                if m.role == "user" && i == msg_len - 1 && payload.images.as_ref().map_or(false, |imgs| !imgs.is_empty()) {
                    let mut content_parts = Vec::new();
                    content_parts.push(serde_json::json!({ "type": "text", "text": m.content }));

                    if let Some(images) = &payload.images {
                        for img in images {
                            let (mime, data) = parse_image_data_url(img);
                            content_parts.push(serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": data
                                }
                            }));
                        }
                    }
                    full_messages.push(serde_json::json!({ "role": m.role, "content": content_parts }));
                } else {
                    full_messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
                }
            }
            {
                // Anthropic REQUIRES max_tokens. Use the configured value, else a
                // sane 8192 default (previously a hardcoded 8096 — a typo that also
                // ignored model capability). temperature is optional.
                let mut body = serde_json::json!({
                    "model": payload.model,
                    "system": payload.system_prompt,
                    "messages": full_messages,
                    "stream": true,
                    "max_tokens": resolved_max_tokens.unwrap_or(8192)
                });
                if let Some(temp) = resolved_temperature {
                    body["temperature"] = serde_json::json!(temp);
                }
                // Convert OpenAI-format tools to Anthropic format:
                // { type, function: { name, description, parameters } }
                // → { name, description, input_schema }
                if let Some(tools) = &payload.tools {
                    if let Some(arr) = tools.as_array() {
                        let anthropic_tools: Vec<serde_json::Value> = arr.iter()
                            .filter_map(|t| {
                                let f = &t["function"];
                                let name = f["name"].as_str()?;
                                Some(serde_json::json!({
                                    "name": name,
                                    "description": f["description"].as_str().unwrap_or(""),
                                    "input_schema": f["parameters"].clone()
                                }))
                            })
                            .collect();
                        if !anthropic_tools.is_empty() {
                            body["tools"] = serde_json::Value::Array(anthropic_tools);
                        }
                    }
                }
                body
            }
        }
        "gemini" => {
            let mut contents = Vec::new();
            let msg_len = payload.messages.len();
            for (i, m) in payload.messages.into_iter().enumerate() {
                let role = if m.role == "assistant" { "model" } else { "user" };
                let mut parts = Vec::new();
                parts.push(serde_json::json!({ "text": m.content }));

                // Attach images to the last user message
                if m.role == "user" && i == msg_len - 1 {
                    if let Some(images) = &payload.images {
                        for img in images {
                            let (mime, data) = parse_image_data_url(img);
                            parts.push(serde_json::json!({
                                "inline_data": {
                                    "mime_type": mime,
                                    "data": data
                                }
                            }));
                        }
                    }
                }
                
                contents.push(serde_json::json!({
                    "role": role,
                    "parts": parts
                }));
            }
            // Build optional generationConfig (maxOutputTokens / temperature).
            let mut gen_config = serde_json::Map::new();
            if let Some(mt) = resolved_max_tokens {
                gen_config.insert("maxOutputTokens".to_string(), serde_json::json!(mt));
            }
            if let Some(temp) = resolved_temperature {
                gen_config.insert("temperature".to_string(), serde_json::json!(temp));
            }

            let mut g_body = if let Some(sys) = payload.system_prompt {
                serde_json::json!({
                    "contents": contents,
                    "system_instruction": {
                        "parts": [{ "text": sys }]
                    }
                })
            } else {
                serde_json::json!({
                    "contents": contents
                })
            };
            if !gen_config.is_empty() {
                g_body["generationConfig"] = serde_json::Value::Object(gen_config);
            }
            g_body
        }
        _ => unreachable!(),
    };

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

        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.split('\n') {
                        let line = line.trim();
                        if line.is_empty() { continue; }

                        let delta = match resolved_provider.as_str() {
                            "openai" | "azure" | "generic" => {
                                if line.starts_with("data: ") && line != "data: [DONE]" {
                                    let json_str = &line[6..];
                                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
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
                                        json["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or_default().to_string()
                                    } else { String::new() }
                                } else { String::new() }
                            }
                            "ollama" => {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
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
                            });
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit("llm-chunk", StreamChunk {
                        request_id: rid.clone(),
                        delta: String::new(),
                        done: true,
                        error: Some(format!("Stream error: {}", e)),
                    });
                    break;
                }
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
            });
        }

        // Final Logging
        if log_enabled {
            if let Some(dir) = log_dir {
                let _ = log_interaction(&dir, &provider_name, &model_name, &request_payload, &full_response);
            }
        }

        // Finalize
        let _ = app.emit("llm-chunk", StreamChunk {
            request_id: rid.clone(),
            delta: String::new(),
            done: true,
            error: None,
        });
    });

    Ok(())
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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LlmInstance {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: String,
    pub api_version: Option<String>,
    /// Optional explicit context-window size (in tokens) for this connection.
    /// Used by the frontend's compaction logic. When set, it overrides the
    /// built-in per-model table — essential for models we don't recognize
    /// (e.g. DeepSeek, Qwen) whose real window differs from the default guess.
    #[serde(default)]
    pub context_window: Option<u32>,
    /// Optional max output tokens for responses from this connection.
    /// None ⇒ provider default (Anthropic uses 8192 since it's required there).
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    /// Optional sampling temperature (0.0–2.0). None ⇒ provider default.
    /// For agentic tool-use, a low value (e.g. 0.2) improves reliability.
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiConfig {
    pub connection_token: Option<String>,
    pub openai_key: Option<String>,
    pub anthropic_key: Option<String>,
    pub gemini_key: Option<String>,
    pub azure_key: Option<String>,
    pub azure_endpoint: Option<String>,
    pub azure_deployment: Option<String>,
    pub proxy_url: Option<String>,
    pub logging_enabled: Option<bool>,
    pub log_dir: Option<String>,
    pub max_steps: Option<u32>,
    pub approved_projects: Option<Vec<String>>,
    /// Extra directories where the agent may write WITHOUT user approval,
    /// in addition to the active workspace. Configured from Settings.
    #[serde(default)]
    pub write_allowed_paths: Option<Vec<String>>,
    pub mcp_servers: Option<serde_json::Value>,
    pub llm_instances: Option<Vec<LlmInstance>>,
    /// The instance id (from llm_instances) that should be used by default
    /// for the agent and for chat sessions. None ⇒ fall back to first instance.
    #[serde(default)]
    pub active_llm_instance_id: Option<String>,

    // ── Agent Safety Limits ───────────────────────────────────────────
    // All Option<u32>/u64 — None or 0 means "disabled / unlimited".
    // Stored centrally so they can be tuned from Settings → General without
    // a code rebuild and so the JSON document is self-describing.

    /// Hard cap on cumulative prompt+completion tokens per task run.
    /// None or 0 ⇒ no cost cap.
    #[serde(default)]
    pub token_budget: Option<u64>,

    /// Hard cap on wall-clock minutes per task run. None or 0 ⇒ no time cap.
    #[serde(default)]
    pub wall_clock_minutes: Option<u32>,

    /// Number of consecutive iterations with no file-mutating tool calls
    /// before the agent gets a "you're stuck" reminder. 0 ⇒ disabled.
    #[serde(default)]
    pub no_progress_window: Option<u32>,

    /// How many consecutive identical tool calls before a SOFT warning fires.
    /// The HARD stop is at 3× this number. 0 ⇒ disabled entirely.
    #[serde(default)]
    pub identical_call_threshold: Option<u32>,

    /// How many full cycle repeats (ABAB or ABCABC) before a SOFT warning fires.
    /// 0 ⇒ disabled. Higher = more permissive (rare false positives but slower to catch loops).
    #[serde(default)]
    pub cycle_detection_min_repeats: Option<u32>,

    /// Fraction (0–1) of the model's context window that conversation history
    /// (including the injected file cache) may occupy before compaction triggers.
    /// None ⇒ frontend default (0.7). Lower = compact sooner (less context, cheaper);
    /// higher = keep more history (richer context, closer to the window limit).
    #[serde(default)]
    pub history_budget_ratio: Option<f32>,

    /// Named prompt templates / slash-command snippets.
    /// Object: { "key": { "label": "...", "prompt": "...", "icon": "..." } }
    #[serde(default)]
    pub prompt_templates: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn get_ai_config<R: tauri::Runtime>(
    app: tauri::AppHandle<R>
) -> Result<AiConfig, String> {
    let config_dir = app.path().app_config_dir().map_err(|e: tauri::Error| e.to_string())?;
    let config_path = config_dir.join("ai_config.json");
    
    if !config_path.exists() {
        return Ok(AiConfig {
            connection_token: None,
            openai_key: None, anthropic_key: None, gemini_key: None, azure_key: None,
            azure_endpoint: None, azure_deployment: None,
            proxy_url: None, logging_enabled: None, log_dir: None,
            max_steps: Some(100),
            approved_projects: Some(Vec::new()),
            write_allowed_paths: Some(Vec::new()),
            mcp_servers: None,
            llm_instances: Some(Vec::new()),
            active_llm_instance_id: None,
            token_budget: None,
            wall_clock_minutes: None,
            no_progress_window: None,
            identical_call_threshold: None,
            cycle_detection_min_repeats: None,
            history_budget_ratio: None,
            prompt_templates: None,
        });
    }

    let json = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut config: AiConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    
    // Sanitize Keys
    if config.openai_key.is_some() { config.openai_key = Some("********".to_string()); }
    if config.anthropic_key.is_some() { config.anthropic_key = Some("********".to_string()); }
    if config.gemini_key.is_some() { config.gemini_key = Some("********".to_string()); }
    if config.azure_key.is_some() { config.azure_key = Some("********".to_string()); }
    
    if let Some(instances) = &mut config.llm_instances {
        for inst in instances {
            if inst.api_key.is_some() {
                inst.api_key = Some("********".to_string());
            }
        }
    }
    
    Ok(config)
}

#[tauri::command]
pub async fn save_ai_config<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    config: AiConfig
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    
    // Ensure dir exists
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    }

    let config_path = config_dir.join("ai_config.json");
    
    // Merge logic: If existing config exists, keep keys if not provided in new config
    let mut final_config = config;
    if config_path.exists() {
        if let Ok(json) = std::fs::read_to_string(&config_path) {
            if let Ok(old_config) = serde_json::from_str::<AiConfig>(&json) {
                if final_config.connection_token.is_none() {
                    final_config.connection_token = old_config.connection_token;
                }
                if final_config.openai_key == Some("********".to_string()) || final_config.openai_key.is_none() {
                    final_config.openai_key = old_config.openai_key;
                }
                if final_config.anthropic_key == Some("********".to_string()) || final_config.anthropic_key.is_none() {
                    final_config.anthropic_key = old_config.anthropic_key;
                }
                if final_config.gemini_key == Some("********".to_string()) || final_config.gemini_key.is_none() {
                    final_config.gemini_key = old_config.gemini_key;
                }
                if final_config.azure_key == Some("********".to_string()) || final_config.azure_key.is_none() {
                    final_config.azure_key = old_config.azure_key;
                }
                if final_config.approved_projects.is_none() {
                    final_config.approved_projects = old_config.approved_projects;
                }
                if final_config.write_allowed_paths.is_none() {
                    final_config.write_allowed_paths = old_config.write_allowed_paths;
                }
                if final_config.mcp_servers.is_none() {
                    final_config.mcp_servers = old_config.mcp_servers;
                }
                
                // Merge llm_instances keys
                if let Some(final_insts) = &mut final_config.llm_instances {
                    if let Some(old_insts) = &old_config.llm_instances {
                        for final_inst in final_insts {
                            if final_inst.api_key == Some("********".to_string()) || final_inst.api_key.is_none() {
                                if let Some(old_inst) = old_insts.iter().find(|o| o.id == final_inst.id) {
                                    final_inst.api_key = old_inst.api_key.clone();
                                }
                            }
                        }
                    }
                }

                // Preserve active_llm_instance_id if the client did not send it
                if final_config.active_llm_instance_id.is_none() {
                    final_config.active_llm_instance_id = old_config.active_llm_instance_id;
                }

                // Preserve Agent Safety Limits if the client didn't send them.
                // (Sent as `null` from JS when the user explicitly wants to clear/disable
                //  a setting — vs not sending the field at all. We use a `Some(0)` marker
                //  in the UI for "explicitly disabled", so we only fall through to the old
                //  value when the field is genuinely missing.)
                if final_config.token_budget.is_none() {
                    final_config.token_budget = old_config.token_budget;
                }
                if final_config.wall_clock_minutes.is_none() {
                    final_config.wall_clock_minutes = old_config.wall_clock_minutes;
                }
                if final_config.no_progress_window.is_none() {
                    final_config.no_progress_window = old_config.no_progress_window;
                }
                if final_config.identical_call_threshold.is_none() {
                    final_config.identical_call_threshold = old_config.identical_call_threshold;
                }
                if final_config.cycle_detection_min_repeats.is_none() {
                    final_config.cycle_detection_min_repeats = old_config.cycle_detection_min_repeats;
                }
                if final_config.prompt_templates.is_none() {
                    final_config.prompt_templates = old_config.prompt_templates;
                }
            }
        }
    }

    let json = serde_json::to_string_pretty(&final_config).map_err(|e| e.to_string())?;
    std::fs::write(config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn set_rag_approval<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    approved: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join("ai_config.json");
    
    let mut config = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str::<AiConfig>(&json).map_err(|e| e.to_string())?
    } else {
        AiConfig {
            connection_token: None,
            openai_key: None,
            anthropic_key: None,
            gemini_key: None,
            azure_key: None,
            azure_endpoint: None,
            azure_deployment: None,
            proxy_url: None,
            logging_enabled: None,
            log_dir: None,
            max_steps: Some(100),
            approved_projects: Some(Vec::new()),
            write_allowed_paths: Some(Vec::new()),
            mcp_servers: None,
            llm_instances: Some(Vec::new()),
            active_llm_instance_id: None,
            token_budget: None,
            wall_clock_minutes: None,
            no_progress_window: None,
            identical_call_threshold: None,
            cycle_detection_min_repeats: None,
            history_budget_ratio: None,
            prompt_templates: None,
        }
    };

    let projects = config.approved_projects.get_or_insert_with(Vec::new);
    if approved {
        if !projects.contains(&path) {
            projects.push(path);
        }
    } else {
        projects.retain(|p| p != &path);
    }

    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Export the JH AI Agent connection settings (host / port / token) to a
/// standard path that all "JH-family" client apps look up automatically.
///
/// Platform-specific path used:
///   Windows : %APPDATA%/JH/ai-connection.json
///   macOS   : $HOME/Library/Application Support/JH/ai-connection.json
///   Linux   : $HOME/.config/JH/ai-connection.json
///
/// Once written, any JH client app using `@jh/ai-client` (or the equivalent
/// hand-rolled connection logic) can connect without any user-side setup.
///
/// `port` and `token` are passed in by the JS UI from the live Tauri state.
#[tauri::command]
pub async fn export_connection_config(
    port: u16,
    token: String,
) -> Result<String, String> {
    let base_dir = if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .map_err(|_| "APPDATA environment variable not set".to_string())?
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        std::path::PathBuf::from(home).join("Library/Application Support")
    } else {
        // Linux / others: XDG_CONFIG_HOME or ~/.config
        std::env::var("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|_| {
                std::env::var("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".config"))
            })
            .map_err(|_| "Neither XDG_CONFIG_HOME nor HOME is set".to_string())?
    };

    let jh_dir = base_dir.join("JH");
    if !jh_dir.exists() {
        std::fs::create_dir_all(&jh_dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let conn_path = jh_dir.join("ai-connection.json");

    let payload = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "token": token,
        "exported_at": chrono::Local::now().to_rfc3339(),
        "endpoint_base": format!("http://127.0.0.1:{}/api", port),
        "ws_base": format!("ws://127.0.0.1:{}/ws", port),
    });

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&conn_path, json)
        .map_err(|e| format!("Failed to write to {}: {}", conn_path.display(), e))?;

    Ok(conn_path.to_string_lossy().to_string())
}

/// Return the app config directory path (used by JS to read/write skill .md files).
#[tauri::command]
pub async fn get_app_config_dir<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// List skill .md files from `<config_dir>/skills/`.
/// Returns a list of `{ name, path, title }` objects.
#[tauri::command]
pub async fn list_skill_files<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("skills");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut results = vec![];
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let title = content.lines().next()
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| name.clone());
        results.push(serde_json::json!({
            "name": name,
            "path": path.to_string_lossy(),
            "title": title,
        }));
    }
    results.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(results)
}

/// Read a skill file's content.
#[tauri::command]
pub async fn read_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<String, String> {
    use tauri::Manager;
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?
        .join("skills")
        .join(format!("{}.md", name));
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read skill '{}': {}", name, e))
}

/// Write (create or update) a skill file.
#[tauri::command]
pub async fn write_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    content: String,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("skills");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let path = dir.join(format!("{}.md", name));
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Delete a skill file.
#[tauri::command]
pub async fn delete_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<(), String> {
    use tauri::Manager;
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?
        .join("skills")
        .join(format!("{}.md", name));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
