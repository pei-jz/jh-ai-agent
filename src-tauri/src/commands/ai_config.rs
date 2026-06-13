// ai_config — AiConfig/LlmInstance types + the config & skill-file Tauri
// commands, extracted from commands/ai.rs (Part A refactor). The streaming LLM
// dispatcher (llm_chat_native) stays in ai.rs and references AiConfig via
// use super::ai_config::AiConfig.

use serde::{Deserialize, Serialize};
use tauri::Manager;

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

    /// Fraction (0–1) of the model's context window above which the agent
    /// per-step compresses old tool results in history. None ⇒ frontend default
    /// (0.5). Below this, history is left BYTE-STABLE so the LLM prompt cache can
    /// reuse it (big token savings on multi-step tasks); above it, compression
    /// kicks in to stay under the budget. Lower = compress sooner (less cache,
    /// smaller prompts); higher = keep history stable longer (more cache hits).
    #[serde(default)]
    pub history_compress_ratio: Option<f32>,

    /// Sampling temperature for the agent loop (0–2). None ⇒ frontend default (0.2).
    #[serde(default)]
    pub agent_temperature: Option<f32>,

    /// Plan-first gate policy: "off" | "auto" (gate complex tasks) | "always".
    /// None ⇒ frontend default ("auto").
    #[serde(default)]
    pub plan_mode: Option<String>,

    /// Model routing — the "fast" tier model id ("{instance_id}:{model}"). Used for
    /// quick / single-shot tasks (app intents, freeform). None ⇒ no routing (active model).
    #[serde(default)]
    pub fast_model_id: Option<String>,

    /// Model routing — the "deep" tier model id ("{instance_id}:{model}"). Used for
    /// complex / plan-first tasks and auto-escalation. None ⇒ no routing (active model).
    #[serde(default)]
    pub deep_model_id: Option<String>,

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
            history_compress_ratio: None,
            agent_temperature: None,
            plan_mode: None,
            fast_model_id: None,
            deep_model_id: None,
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
                if final_config.history_budget_ratio.is_none() {
                    final_config.history_budget_ratio = old_config.history_budget_ratio;
                }
                if final_config.history_compress_ratio.is_none() {
                    final_config.history_compress_ratio = old_config.history_compress_ratio;
                }
                if final_config.agent_temperature.is_none() {
                    final_config.agent_temperature = old_config.agent_temperature;
                }
                if final_config.plan_mode.is_none() {
                    final_config.plan_mode = old_config.plan_mode;
                }
                if final_config.fast_model_id.is_none() {
                    final_config.fast_model_id = old_config.fast_model_id;
                }
                if final_config.deep_model_id.is_none() {
                    final_config.deep_model_id = old_config.deep_model_id;
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
            history_compress_ratio: None,
            agent_temperature: None,
            plan_mode: None,
            fast_model_id: None,
            deep_model_id: None,
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
