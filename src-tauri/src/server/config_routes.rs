// config_routes — HTTP handlers for the config & connection endpoints, extracted
// from server/router.rs (Part A refactor): GET /models, GET/PUT /config,
// POST /config/test. These are the dashboard's settings + connection-test path
// (apiClient.updateConfig → PUT /config lands in `update_config` here, NOT in the
// `save_ai_config` Tauri command). create_router (router.rs) wires them via
// `use super::config_routes::{...}`.

use std::time::Duration;
use axum::{Json, extract::State, http::StatusCode};

use super::router::{AppState, TestConnectionRequest, TestConnectionResponse, load_config};
use crate::commands::ai_config::AiConfig;

/// GET /api/models — list configured models (dynamic instances, then legacy keys).
pub(crate) async fn get_models(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let config = load_config(&state.config_path)?;
    let mut models = vec![];

    // Load from dynamic instances first
    if let Some(instances) = &config.llm_instances {
        for inst in instances {
            if !inst.model.is_empty() {
                let id = format!("{}:{}", inst.id, inst.model);
                let name = format!("{} ({})", inst.name, inst.model);
                models.push(serde_json::json!({
                    "id": id,
                    "name": name,
                    "provider": inst.provider,
                    "context_window": inst.context_window,
                    "max_output_tokens": inst.max_output_tokens,
                    "temperature": inst.temperature,
                    // null ⇒ the frontend infers from provider/model name.
                    "supports_vision": inst.supports_vision
                }));
            }
        }
    }

    // Fallback to legacy configuration keys if no instances exist
    if models.is_empty() {
        if config.openai_key.is_some() {
            models.push(serde_json::json!({ "id": "openai:gpt-4o", "name": "GPT-4o", "provider": "openai" }));
            models.push(serde_json::json!({ "id": "openai:gpt-4-turbo", "name": "GPT-4 Turbo", "provider": "openai" }));
        }
        if config.anthropic_key.is_some() {
            models.push(serde_json::json!({ "id": "anthropic:claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet", "provider": "anthropic" }));
            models.push(serde_json::json!({ "id": "anthropic:claude-3-opus-20240229", "name": "Claude 3 Opus", "provider": "anthropic" }));
        }
        if config.gemini_key.is_some() {
            models.push(serde_json::json!({ "id": "gemini:gemini-1.5-pro", "name": "Gemini 1.5 Pro", "provider": "gemini" }));
            models.push(serde_json::json!({ "id": "gemini:gemini-1.5-flash", "name": "Gemini 1.5 Flash", "provider": "gemini" }));
        }
    }

    if models.is_empty() {
        models.push(serde_json::json!({ "id": "anthropic:claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet (Default)", "provider": "anthropic" }));
        models.push(serde_json::json!({ "id": "openai:gpt-4o", "name": "GPT-4o (Default)", "provider": "openai" }));
        models.push(serde_json::json!({ "id": "gemini:gemini-1.5-flash", "name": "Gemini 1.5 Flash (Default)", "provider": "gemini" }));
    }

    Ok(Json(serde_json::json!({ "models": models })))
}

/// GET /api/config — current config with API keys masked.
pub(crate) async fn get_config(
    State(state): State<AppState>,
) -> Result<Json<AiConfig>, (StatusCode, String)> {
    let mut config = load_config(&state.config_path)?;

    // Mask keys
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

    Ok(Json(config))
}

/// PUT /api/config — save config, preserving secrets/settings the client omits
/// (masked "********" keys, agent safety limits, plan/temperature, etc.).
pub(crate) async fn update_config(
    State(state): State<AppState>,
    Json(new_config): Json<AiConfig>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut final_config = new_config;
    if state.config_path.exists() {
        if let Ok(json) = std::fs::read_to_string(&state.config_path) {
            if let Ok(old_config) = serde_json::from_str::<AiConfig>(&json) {
                if final_config.openai_key == Some("********".to_string()) || final_config.openai_key.is_none() {
                    final_config.openai_key = old_config.openai_key.clone();
                }
                if final_config.anthropic_key == Some("********".to_string()) || final_config.anthropic_key.is_none() {
                    final_config.anthropic_key = old_config.anthropic_key.clone();
                }
                if final_config.gemini_key == Some("********".to_string()) || final_config.gemini_key.is_none() {
                    final_config.gemini_key = old_config.gemini_key.clone();
                }
                if final_config.azure_key == Some("********".to_string()) || final_config.azure_key.is_none() {
                    final_config.azure_key = old_config.azure_key.clone();
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

                // Everything else: any field the caller did not mention keeps
                // its stored value. Structural, so no field can be forgotten.
                final_config = crate::commands::ai_config::merge_preserving(&final_config, &old_config)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;


            }
        }
    }

    crate::commands::ai_config::clear_blank_routing(&mut final_config);

    let json = serde_json::to_string_pretty(&final_config).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::write(&state.config_path, json).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({ "status": "saved" })))
}

/// POST /api/config/test — ping a provider to verify a connection works.
pub(crate) async fn test_connection(
    State(state): State<AppState>,
    Json(payload): Json<TestConnectionRequest>,
) -> Result<Json<TestConnectionResponse>, (StatusCode, String)> {
    // 1. Get proxy settings from saved config if any
    let proxy_url = if let Ok(json) = std::fs::read_to_string(&state.config_path) {
        if let Ok(config) = serde_json::from_str::<AiConfig>(&json) {
            config.proxy_url
        } else {
            None
        }
    } else {
        None
    };

    // 2. Build HTTP Client
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10));
    if let Some(url) = proxy_url {
        if !url.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(url) {
                builder = builder.proxy(proxy);
            }
        }
    }
    let client = builder.build().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to build client: {}", e)))?;

    // 3. Determine URL, Headers, and Body
    let provider = payload.provider.as_str();
    let model = payload.model.as_str();
    let api_key = payload.api_key.unwrap_or_default();

    // Fallback mask check (if frontend sent masked asterisk string, load from saved configuration)
    let final_api_key = if api_key == "********" {
        // Load original key from config
        if let Ok(json) = std::fs::read_to_string(&state.config_path) {
            if let Ok(config) = serde_json::from_str::<AiConfig>(&json) {
                match provider {
                    "openai" => config.openai_key,
                    "anthropic" => config.anthropic_key,
                    "gemini" => config.gemini_key,
                    "azure" => config.azure_key,
                    _ => None,
                }.unwrap_or_default()
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        api_key
    };

    let base_url = payload.base_url.unwrap_or_default();
    let api_version = payload.api_version.unwrap_or_default();

    let (url, headers, body) = match provider {
        "openai" => {
            let base = if base_url.is_empty() { "https://api.openai.com/v1" } else { &base_url };
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Authorization", format!("Bearer {}", final_api_key).parse().map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid API Key header format: {}", e)))?);
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5
            });
            (url, h, body)
        }
        "anthropic" => {
            let base = if base_url.is_empty() { "https://api.anthropic.com/v1" } else { &base_url };
            let url = format!("{}/messages", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("x-api-key", final_api_key.parse().map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid API Key header format: {}", e)))?);
            h.insert("anthropic-version", "2023-06-01".parse().unwrap());
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5
            });
            (url, h, body)
        }
        "gemini" => {
            let base = if base_url.is_empty() { "https://generativelanguage.googleapis.com/v1beta" } else { &base_url };
            let url = format!("{}/models/{}:generateContent?key={}", base.trim_end_matches('/'), model, final_api_key);
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "contents": [{"parts": [{"text": "ping"}]}],
                "generationConfig": {
                    "maxOutputTokens": 5
                }
            });
            (url, h, body)
        }
        "azure" => {
            let api_v = if api_version.is_empty() { "2024-08-01-preview" } else { &api_version };
            let url = format!("{}/openai/deployments/{}/chat/completions?api-version={}", base_url.trim_end_matches('/'), model, api_v);
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("api-key", final_api_key.parse().map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid API Key header format: {}", e)))?);
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5
            });
            (url, h, body)
        }
        "ollama" => {
            let base = if base_url.is_empty() { "http://localhost:11434" } else { &base_url };
            let url = format!("{}/api/chat", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "stream": false
            });
            (url, h, body)
        }
        "generic" => {
            let base = if base_url.is_empty() { "http://localhost:11434/v1" } else { &base_url };
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let mut h = reqwest::header::HeaderMap::new();
            if !final_api_key.is_empty() {
                h.insert("Authorization", format!("Bearer {}", final_api_key).parse().map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid API Key header format: {}", e)))?);
            }
            h.insert("Content-Type", "application/json".parse().unwrap());
            let body = serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5
            });
            (url, h, body)
        }
        _ => return Err((StatusCode::BAD_REQUEST, format!("Unsupported provider: {}", provider))),
    };

    // 4. Send request and handle response
    match client.post(&url).headers(headers).json(&body).send().await {
        Ok(res) => {
            if res.status().is_success() {
                Ok(Json(TestConnectionResponse {
                    success: true,
                    message: "Connection verified successfully!".to_string(),
                }))
            } else {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_default();
                Ok(Json(TestConnectionResponse {
                    success: false,
                    message: format!("API returned error status ({}): {}", status, err_text),
                }))
            }
        }
        Err(e) => {
            Ok(Json(TestConnectionResponse {
                success: false,
                message: format!("Network error: {}", e),
            }))
        }
    }
}
