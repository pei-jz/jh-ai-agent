// ai_config — AiConfig/LlmInstance types + the config & skill-file Tauri
// commands, extracted from commands/ai.rs (Part A refactor). The streaming LLM
// dispatcher (llm_chat_native) stays in ai.rs and references AiConfig via
// use super::ai_config::AiConfig.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::secrets;

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

    /// Whether this connection's model accepts IMAGES.
    /// None ⇒ infer from the provider/model name (the historical behaviour).
    /// Set explicitly for models the name heuristic cannot know about: a local
    /// or OpenAI-compatible vision model (LLaVA, Qwen-VL, Llama Vision) has no
    /// "gpt" in its name and was silently treated as text-only.
    #[serde(default)]
    pub supports_vision: Option<bool>,

    // ── Per-model pricing (USD per 1M tokens) ─────────────────────────────
    // Used to estimate task cost with THIS model's real rates instead of a
    // single global placeholder. All optional; unset ⇒ falls back to the
    // legacy global cost_per_1m_* keys, then to a generic default.
    /// Full-priced (non-cached) input tokens — the "↑" figure.
    #[serde(default)]
    pub cost_per_1m_input: Option<f64>,
    /// Cache-read input tokens — the "⚡" figure (typically ~10% of input).
    #[serde(default)]
    pub cost_per_1m_cache_read: Option<f64>,
    /// Output/completion tokens — the "↓" figure.
    #[serde(default)]
    pub cost_per_1m_output: Option<f64>,
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
    pub tavily_api_key: Option<String>,
    pub proxy_url: Option<String>,
    pub logging_enabled: Option<bool>,
    pub log_dir: Option<String>,
    pub max_steps: Option<u32>,
    pub approved_projects: Option<Vec<String>>,
    /// Extra directories where the agent may write WITHOUT user approval,
    /// in addition to the active workspace. Configured from Settings.
    #[serde(default)]
    pub write_allowed_paths: Option<Vec<String>>,
    /// Hosts `fetch_url` may reach even though they resolve to a private or
    /// loopback address. Empty/None ⇒ nothing private is reachable, which is the
    /// default: a fetched page can instruct the agent to read an internal
    /// service, so the guard denies by construction and this is the opt-out.
    /// Matches exactly or as a domain suffix ("example.com" covers "api.example.com").
    #[serde(default)]
    pub fetch_allowed_hosts: Option<Vec<String>>,
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

    /// Step at which a run on the Fast tier is promoted to the Deep model.
    /// None / 0 ⇒ never (the default): a mid-run model change discards the
    /// prompt cache for the whole remainder, so it is opt-in.
    #[serde(default)]
    pub escalate_at_step: Option<u32>,

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

    /// Language the agent uses for its final user-facing responses (e.g.
    /// "Japanese", "English"). Injected into the system prompt by the frontend
    /// ContextBuilder. None ⇒ frontend default ("Japanese").
    #[serde(default)]
    pub output_language: Option<String>,

    /// Model routing — the "fast" tier model id ("{instance_id}:{model}"). Used for
    /// quick / single-shot tasks (app intents, freeform). None ⇒ no routing (active model).
    ///
    /// `None` also means "the caller did not mention this field" to the save
    /// merge, which then restores the previous value — so the UI sends an EMPTY
    /// STRING to mean "clear this". `clear_blank_routing` turns that back into
    /// `None` after merging; without it, "(not set)" could not be chosen.
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

    /// Pre-finish independent sub-agent review of file changes: "off" | "on".
    /// None ⇒ frontend default ("off").
    #[serde(default)]
    pub subagent_review: Option<String>,

    /// Whether learned memory (lessons / insights) is RECALLED into a run:
    /// "on" | "off" | "auto". "auto" withholds recall from a small random share
    /// of sessions to form a control group — learning continues either way, so a
    /// control session still produces data. None ⇒ frontend default ("on").
    /// See docs/design/agent-memory-layers.md §6.
    #[serde(default)]
    pub memory_recall: Option<String>,

    /// Move the run between the Fast and Deep tiers as it passes through
    /// plan -> execute -> review, instead of picking one tier for the whole
    /// task: "off" | "on". None => frontend default ("off").
    /// See src/modules/ai/agent/ModelPhaseRouter.js.
    #[serde(default)]
    pub phase_routing: Option<String>,

    /// Inject the extracted per-file-kind procedure (Step 6): "off" | "on".
    /// None => frontend default ("off"). Off because its precondition — a
    /// positive follow-through lift — is not met yet; see memory/Playbook.js.
    #[serde(default)]
    pub playbook: Option<String>,

    /// Point out a burst of one-file-at-a-time read_file calls: "off" | "on".
    /// None => frontend default ("off"). Off only so the injection experiment
    /// in flight keeps measuring three injections; see agent/ReadBatching.js.
    #[serde(default)]
    pub read_batch_hint: Option<String>,

    /// Inject summaries of PAST SESSIONS into the system prompt: "off" | "on".
    /// None => frontend default ("off"). The knob existed in ConversationMemory
    /// with no caller, so the heaviest memory layer was not adjustable at all.
    /// See docs/design/agent-memory-layers.md §7.
    #[serde(default)]
    pub episode_injection: Option<String>,
}

/// Turn the UI's explicit-clear sentinel back into "unset".
///
/// The field-wise merge cannot tell `null` ("caller omitted this") from `null`
/// ("caller cleared this"), so the UI sends `""` for the latter. Run this AFTER
/// merging: an empty tier means routing is off, not a model named "".
pub fn clear_blank_routing(cfg: &mut AiConfig) {
    if cfg.fast_model_id.as_deref().map(str::trim) == Some("") {
        cfg.fast_model_id = None;
    }
    if cfg.deep_model_id.as_deref().map(str::trim) == Some("") {
        cfg.deep_model_id = None;
    }
}

// ─── Where the keys actually live ──────────────────────────────────────────
//
// The credential store, not this JSON. `load_config_with_secrets` is the ONE
// reader that returns usable keys: everything else (get_ai_config, the UI) sees
// the masked form. The split is deliberate — a key that never enters the
// renderer cannot be logged, screenshotted or sent anywhere by accident.

/// Read the raw config file, with no key handling at all.
fn read_config_file(path: &std::path::Path) -> Option<AiConfig> {
    let json = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<AiConfig>(&json).ok()
}

/// Move any plaintext keys still in the JSON into the credential store.
///
/// Runs on every read, and is a no-op once there is nothing left to move — the
/// alternative, a one-shot flag, is wrong the moment a config is restored from a
/// backup that predates the migration.
///
/// The plaintext copy is cleared ONLY for a key that was written AND read back
/// (`secrets::migrate` confirms both). A store that reports success and holds
/// nothing would otherwise destroy the key.
///
/// @returns whether the file needs rewriting.
fn migrate_plaintext_keys(config: &mut AiConfig) -> bool {
    let mut changed = false;

    let mut take = |account: &str, slot: &mut Option<String>| {
        if let Some(value) = slot.clone() {
            match secrets::migrate(account, &value) {
                Ok(true) => {
                    *slot = None;
                    changed = true;
                }
                Ok(false) => {}
                // Keep the plaintext: an unreachable store is a reason to leave
                // the key where it works, not to lose it.
                Err(e) => eprintln!("[secrets] could not migrate {account}: {e}"),
            }
        }
    };

    take("openai_key", &mut config.openai_key);
    take("anthropic_key", &mut config.anthropic_key);
    take("gemini_key", &mut config.gemini_key);
    take("azure_key", &mut config.azure_key);
    take("tavily_api_key", &mut config.tavily_api_key);

    if let Some(instances) = &mut config.llm_instances {
        for inst in instances.iter_mut() {
            let account = secrets::instance_account(&inst.id);
            if let Some(value) = inst.api_key.clone() {
                match secrets::migrate(&account, &value) {
                    Ok(true) => {
                        inst.api_key = None;
                        changed = true;
                    }
                    Ok(false) => {}
                    Err(e) => eprintln!("[secrets] could not migrate {account}: {e}"),
                }
            }
        }
    }
    changed
}

/// Fill in the keys from the credential store.
///
/// A key still present in the JSON wins — that is the fallback path on a machine
/// with no usable store, and reading the store first would blank it.
fn apply_stored_secrets(config: &mut AiConfig) {
    let fill = |account: &str, slot: &mut Option<String>| {
        if slot.is_none() {
            if let Ok(Some(v)) = secrets::get(account) {
                *slot = Some(v);
            }
        }
    };
    fill("openai_key", &mut config.openai_key);
    fill("anthropic_key", &mut config.anthropic_key);
    fill("gemini_key", &mut config.gemini_key);
    fill("azure_key", &mut config.azure_key);
    fill("tavily_api_key", &mut config.tavily_api_key);

    if let Some(instances) = &mut config.llm_instances {
        for inst in instances.iter_mut() {
            if inst.api_key.is_none() {
                if let Ok(Some(v)) = secrets::get(&secrets::instance_account(&inst.id)) {
                    inst.api_key = Some(v);
                }
            }
        }
    }
}

/// The config WITH real keys. For the call path only — never for the renderer.
pub fn load_config_with_secrets(config_dir: &std::path::Path) -> Option<AiConfig> {
    let path = config_dir.join("ai_config.json");
    let mut config = read_config_file(&path)?;
    // Migrate first: a config that still holds plaintext must be drained before
    // it is used, or it never gets drained at all on a machine that only reads.
    if migrate_plaintext_keys(&mut config) {
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = std::fs::write(&path, json);
        }
    }
    apply_stored_secrets(&mut config);
    Some(config)
}

/// Write the keys to the credential store, and strip them from what gets saved.
///
/// On failure the key stays in `config` and therefore in the file: losing the
/// user's key to an unreachable keyring is worse than storing it as before, and
/// Settings reports which of the two happened.
fn extract_secrets(config: &mut AiConfig) {
    let store = |account: &str, slot: &mut Option<String>| {
        if let Some(value) = slot.clone() {
            match secrets::set(account, &value) {
                Ok(()) => *slot = None,
                Err(e) => eprintln!("[secrets] could not store {account}: {e}"),
            }
        }
    };
    store("openai_key", &mut config.openai_key);
    store("anthropic_key", &mut config.anthropic_key);
    store("gemini_key", &mut config.gemini_key);
    store("azure_key", &mut config.azure_key);
    store("tavily_api_key", &mut config.tavily_api_key);

    if let Some(instances) = &mut config.llm_instances {
        for inst in instances.iter_mut() {
            let account = secrets::instance_account(&inst.id);
            if let Some(value) = inst.api_key.clone() {
                match secrets::set(&account, &value) {
                    Ok(()) => inst.api_key = None,
                    Err(e) => eprintln!("[secrets] could not store {account}: {e}"),
                }
            }
        }
    }
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
            azure_endpoint: None, azure_deployment: None, tavily_api_key: None,
            proxy_url: None, logging_enabled: None, log_dir: None,
            max_steps: Some(100),
            approved_projects: Some(Vec::new()),
            write_allowed_paths: Some(Vec::new()),
            // Empty ⇒ fetch_url reaches nothing private. Opt-in only.
            fetch_allowed_hosts: Some(Vec::new()),
            mcp_servers: None,
            llm_instances: Some(Vec::new()),
            active_llm_instance_id: None,
            token_budget: None,
            wall_clock_minutes: None,
            no_progress_window: None,
            identical_call_threshold: None,
            cycle_detection_min_repeats: None,
            escalate_at_step: None,
            history_budget_ratio: None,
            history_compress_ratio: None,
            agent_temperature: None,
            plan_mode: None,
            output_language: None,
            fast_model_id: None,
            deep_model_id: None,
            prompt_templates: None,
            subagent_review: None,
            memory_recall: None,
            phase_routing: None,
            playbook: None,
            read_batch_hint: None,
            episode_injection: None,
        });
    }

    // Through the resolver: this also drains any plaintext key still in the file
    // into the credential store, so a config written before the migration is
    // cleaned up the first time it is read.
    let mut config = load_config_with_secrets(&config_dir)
        .ok_or_else(|| "Could not read ai_config.json".to_string())?;

    // Masked before it leaves this process. The renderer has never needed a real
    // key — Rust attaches the auth header — so it never receives one.
    if config.openai_key.is_some() { config.openai_key = Some("********".to_string()); }
    if config.anthropic_key.is_some() { config.anthropic_key = Some("********".to_string()); }
    if config.gemini_key.is_some() { config.gemini_key = Some("********".to_string()); }
    if config.azure_key.is_some() { config.azure_key = Some("********".to_string()); }
    if config.tavily_api_key.is_some() { config.tavily_api_key = Some("********".to_string()); }
    
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
    // The old config is read THROUGH the resolver, so "keep what was there" now
    // means the credential store rather than the file.
    let mut final_config = config;
    if config_path.exists() {
        {
            if let Some(old_config) = load_config_with_secrets(&config_dir) {
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
                if final_config.tavily_api_key == Some("********".to_string()) || final_config.tavily_api_key.is_none() {
                    final_config.tavily_api_key = old_config.tavily_api_key;
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
                if final_config.escalate_at_step.is_none() {
                    final_config.escalate_at_step = old_config.escalate_at_step;
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
                if final_config.output_language.is_none() {
                    final_config.output_language = old_config.output_language;
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
                if final_config.subagent_review.is_none() {
                    final_config.subagent_review = old_config.subagent_review;
                }
                if final_config.phase_routing.is_none() {
                    final_config.phase_routing = old_config.phase_routing.clone();
                }
                if final_config.playbook.is_none() {
                    final_config.playbook = old_config.playbook.clone();
                }
                if final_config.read_batch_hint.is_none() {
                    final_config.read_batch_hint = old_config.read_batch_hint.clone();
                }
                if final_config.memory_recall.is_none() {
                    final_config.memory_recall = old_config.memory_recall;
                }
                if final_config.episode_injection.is_none() {
                    final_config.episode_injection = old_config.episode_injection.clone();
                }
            }
        }
    }

    clear_blank_routing(&mut final_config);

    // The keys go to the credential store and are removed from what is written.
    // A key the store refused stays in `final_config` — and therefore in the
    // file — because losing it to an unreachable keyring would be worse than
    // storing it the way it was stored before. Settings reports which happened.
    extract_secrets(&mut final_config);

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
            tavily_api_key: None,
            proxy_url: None,
            logging_enabled: None,
            log_dir: None,
            max_steps: Some(100),
            approved_projects: Some(Vec::new()),
            write_allowed_paths: Some(Vec::new()),
            // Empty ⇒ fetch_url reaches nothing private. Opt-in only.
            fetch_allowed_hosts: Some(Vec::new()),
            mcp_servers: None,
            llm_instances: Some(Vec::new()),
            active_llm_instance_id: None,
            token_budget: None,
            wall_clock_minutes: None,
            no_progress_window: None,
            identical_call_threshold: None,
            cycle_detection_min_repeats: None,
            escalate_at_step: None,
            history_budget_ratio: None,
            history_compress_ratio: None,
            agent_temperature: None,
            plan_mode: None,
            output_language: None,
            fast_model_id: None,
            deep_model_id: None,
            prompt_templates: None,
            subagent_review: None,
            memory_recall: None,
            phase_routing: None,
            playbook: None,
            read_batch_hint: None,
            episode_injection: None,
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

// ─── Skills ────────────────────────────────────────────────────────────────
//
// A skill is a written procedure the agent can load on demand. Two layouts are
// read, because the flat one is what already exists on disk:
//
//   skills/<name>.md            flat — prose only
//   skills/<name>/SKILL.md      directory — may bundle scripts/ references/ assets/
//
// Listing returns metadata ONLY (name, title, description, bundled files). The
// body is fetched separately, which is what lets the agent be handed a catalogue
// of every skill for the cost of one line each.

/// Directories a skill may bundle. Anything else beside SKILL.md is ignored.
const SKILL_BUNDLE_DIRS: [&str; 3] = ["scripts", "references", "assets"];

/// Largest bundled file listing we walk into, so a skill that accidentally
/// contains a node_modules cannot stall the listing.
const SKILL_MAX_BUNDLED: usize = 200;

/// A skill name has to be safe as a path segment AND typeable after "/".
///
/// This is the only thing standing between a caller-supplied name and the
/// filesystem: every skill command joins it onto the skills directory.
fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn skills_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("skills"))
}

/// Where a skill's instructions live, whichever layout it uses.
///
/// The directory form wins when both exist: a `<name>/` that someone has added
/// scripts to is the one they meant, and silently reading the stale flat file
/// beside it would be the worst of the two outcomes.
fn skill_entry_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    if !valid_skill_name(name) {
        return Err(format!("Invalid skill name: '{}'", name));
    }
    let dir = skills_dir(app)?;
    let nested = dir.join(name).join("SKILL.md");
    if nested.is_file() {
        return Ok(nested);
    }
    Ok(dir.join(format!("{}.md", name)))
}

/// Split `---` frontmatter off the top of a skill file.
///
/// Deliberately not a YAML parser — a header is a handful of scalars, and the
/// JS side (skills/skillFormat.js) parses the same shapes. Anything unparseable
/// is left in the body, so a malformed header costs the metadata, never the skill.
fn split_frontmatter(text: &str) -> (std::collections::HashMap<String, String>, &str) {
    let mut meta = std::collections::HashMap::new();
    let trimmed = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = match trimmed.strip_prefix("---\r\n").or_else(|| trimmed.strip_prefix("---\n")) {
        Some(r) => r,
        None => return (meta, trimmed),
    };
    // The closing fence must be a line of its own.
    let mut offset = 0usize;
    let mut body_at = None;
    for line in rest.split_inclusive('\n') {
        let t = line.trim_end_matches(['\r', '\n']).trim();
        if t == "---" {
            body_at = Some(offset + line.len());
            break;
        }
        if !t.is_empty() && !t.starts_with('#') {
            if let Some(at) = t.find(':') {
                if at > 0 {
                    let key = t[..at].trim().to_string();
                    let value = t[at + 1..].trim().trim_matches('"').trim_matches('\'').to_string();
                    meta.insert(key, value);
                }
            }
        }
        offset += line.len();
    }
    match body_at {
        Some(at) => (meta, &rest[at..]),
        // No closing fence: this was not a header after all.
        None => (std::collections::HashMap::new(), trimmed),
    }
}

/// Title and description, from the header or from the old first-two-lines rule.
fn skill_summary(text: &str) -> (String, String, String) {
    let (meta, body) = split_frontmatter(text);
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("").to_string();
    let heading = first.trim_start_matches('#').trim().to_string();
    // Every skill written before frontmatter carries its description here.
    let fallback_desc = lines.find(|l| !l.starts_with('#')).unwrap_or("").to_string();

    let title = meta.get("title").filter(|v| !v.is_empty()).cloned().unwrap_or(heading);
    let description = meta
        .get("description")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or(fallback_desc);
    let allowed = meta.get("allowed-tools").or_else(|| meta.get("allowedTools")).cloned().unwrap_or_default();
    (title, description, allowed)
}

/// The files a directory-form skill bundles, as `{rel, path}` pairs.
fn bundled_files(dir: &std::path::Path) -> Vec<serde_json::Value> {
    let mut out = vec![];
    for sub in SKILL_BUNDLE_DIRS {
        let root = dir.join(sub);
        if !root.is_dir() {
            continue;
        }
        let mut stack = vec![root.clone()];
        while let Some(cur) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&cur) else { continue };
            for entry in entries.flatten() {
                if out.len() >= SKILL_MAX_BUNDLED {
                    return out;
                }
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let rel = path
                    .strip_prefix(dir)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                out.push(serde_json::json!({
                    "rel": rel,
                    "path": path.to_string_lossy(),
                }));
            }
        }
    }
    out.sort_by(|a, b| a["rel"].as_str().unwrap_or("").cmp(b["rel"].as_str().unwrap_or("")));
    out
}

/// List every skill with its metadata — never its body.
#[tauri::command]
pub async fn list_skill_files<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    let dir = skills_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut results = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    // Directory-form skills first, so a `<name>/SKILL.md` shadows a stale
    // `<name>.md` sitting beside it (same rule as skill_entry_path).
    let mut paths: Vec<std::path::PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort_by_key(|p| !p.is_dir());

    for path in paths {
        let (name, entry, skill_dir) = if path.is_dir() {
            let entry = path.join("SKILL.md");
            if !entry.is_file() {
                continue;
            }
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            (name, entry, Some(path.clone()))
        } else {
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            (name, path.clone(), None)
        };

        if name.is_empty() || !valid_skill_name(&name) || !seen.insert(name.clone()) {
            continue;
        }
        let content = std::fs::read_to_string(&entry).unwrap_or_default();
        let (title, description, allowed) = skill_summary(&content);
        let files = skill_dir.as_deref().map(bundled_files).unwrap_or_default();

        results.push(serde_json::json!({
            "name": name,
            "path": entry.to_string_lossy(),
            "dir": skill_dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
            "title": if title.is_empty() { name.clone() } else { title },
            "description": description,
            "allowedTools": allowed,
            "files": files,
        }));
    }
    results.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(results)
}

/// Read a skill's instructions, whichever layout it uses.
#[tauri::command]
pub async fn read_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<String, String> {
    let path = skill_entry_path(&app, &name)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read skill '{}': {}", name, e))
}

/// Read one file BUNDLED with a skill (`scripts/…`, `references/…`).
///
/// The relative path is resolved and then checked to still be inside the
/// skill's own directory: `..` in a skill body is the one way a written
/// procedure could reach the rest of the disk through this command.
#[tauri::command]
pub async fn read_skill_resource<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    rel: String,
) -> Result<String, String> {
    if !valid_skill_name(&name) {
        return Err(format!("Invalid skill name: '{}'", name));
    }
    let dir = skills_dir(&app)?.join(&name);
    let target = dir.join(rel.replace('\\', "/"));
    let (canon_dir, canon_target) = (
        std::fs::canonicalize(&dir).map_err(|e| e.to_string())?,
        std::fs::canonicalize(&target).map_err(|e| format!("Cannot read '{}': {}", rel, e))?,
    );
    if !canon_target.starts_with(&canon_dir) {
        return Err(format!("'{}' is outside the skill directory", rel));
    }
    std::fs::read_to_string(&canon_target).map_err(|e| format!("Cannot read '{}': {}", rel, e))
}

/// Write (create or update) a skill's instructions.
///
/// An existing directory-form skill keeps its layout — writing the flat file
/// beside it would leave the bundled scripts attached to a body nothing reads.
#[tauri::command]
pub async fn write_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    content: String,
) -> Result<(), String> {
    if !valid_skill_name(&name) {
        return Err(format!("Invalid skill name: '{}'", name));
    }
    let dir = skills_dir(&app)?;
    let nested_dir = dir.join(&name);
    let path = if nested_dir.is_dir() {
        nested_dir.join("SKILL.md")
    } else {
        dir.join(format!("{}.md", name))
    };
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Turn a flat skill into a directory one, so files can be bundled with it.
#[tauri::command]
pub async fn promote_skill_to_dir<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<String, String> {
    if !valid_skill_name(&name) {
        return Err(format!("Invalid skill name: '{}'", name));
    }
    let dir = skills_dir(&app)?;
    let nested = dir.join(&name);
    let entry = nested.join("SKILL.md");
    if entry.is_file() {
        return Ok(nested.to_string_lossy().to_string());
    }
    let flat = dir.join(format!("{}.md", name));
    let content = std::fs::read_to_string(&flat).unwrap_or_default();
    std::fs::create_dir_all(nested.join("scripts")).map_err(|e| e.to_string())?;
    std::fs::write(&entry, content).map_err(|e| e.to_string())?;
    // Only now: losing the original to a half-finished move is not recoverable.
    if flat.is_file() {
        let _ = std::fs::remove_file(&flat);
    }
    Ok(nested.to_string_lossy().to_string())
}

/// Delete a skill — the file, or the whole directory with what it bundles.
#[tauri::command]
pub async fn delete_skill_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<(), String> {
    if !valid_skill_name(&name) {
        return Err(format!("Invalid skill name: '{}'", name));
    }
    let dir = skills_dir(&app)?;
    let nested = dir.join(&name);
    if nested.is_dir() {
        std::fs::remove_dir_all(&nested).map_err(|e| e.to_string())?;
    }
    let flat = dir.join(format!("{}.md", name));
    if flat.is_file() {
        std::fs::remove_file(&flat).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    #[test]
    fn valid_names_are_path_segments() {
        assert!(valid_skill_name("excel-report"));
        assert!(valid_skill_name("a_1"));
    }

    // These are the ones that would escape the skills directory.
    #[test]
    fn traversal_and_separators_are_refused() {
        for bad in ["..", "../x", "a/b", "a\\b", "a b", "", "."] {
            assert!(!valid_skill_name(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn frontmatter_is_split_from_the_body() {
        let (meta, body) = split_frontmatter("---\ndescription: does a thing\n---\n# Title\ntext");
        assert_eq!(meta.get("description").map(String::as_str), Some("does a thing"));
        assert_eq!(body, "# Title\ntext");
    }

    #[test]
    fn a_file_without_a_header_is_all_body() {
        let (meta, body) = split_frontmatter("# Title\ntext");
        assert!(meta.is_empty());
        assert_eq!(body, "# Title\ntext");
    }

    // A `---` further down is a horizontal rule; an unterminated one is not a
    // header either, and eating the file as metadata would lose the skill.
    #[test]
    fn an_unterminated_header_is_left_as_body() {
        let (meta, body) = split_frontmatter("---\ndescription: x\n# Title\ntext");
        assert!(meta.is_empty());
        assert!(body.starts_with("---"));
    }

    #[test]
    fn quotes_are_stripped_and_crlf_is_handled() {
        let (meta, body) = split_frontmatter("---\r\ntitle: \"A: B\"\r\n---\r\nBODY");
        assert_eq!(meta.get("title").map(String::as_str), Some("A: B"));
        assert_eq!(body, "BODY");
    }

    #[test]
    fn the_header_supplies_title_and_description() {
        let (t, d, tools) = skill_summary("---\ntitle: T\ndescription: D\nallowed-tools: a, b\n---\n# H\nfirst");
        assert_eq!((t.as_str(), d.as_str(), tools.as_str()), ("T", "D", "a, b"));
    }

    // Every skill written before frontmatter looks like this.
    #[test]
    fn the_old_two_line_convention_still_reads() {
        let (t, d, _) = skill_summary("# Register a backlog item\nCreates the ticket.\n\nSteps…");
        assert_eq!(t, "Register a backlog item");
        assert_eq!(d, "Creates the ticket.");
    }

    #[test]
    fn a_heading_only_skill_has_no_description() {
        let (t, d, _) = skill_summary("# Just a title");
        assert_eq!(t, "Just a title");
        assert_eq!(d, "");
    }
}

#[cfg(test)]
mod routing_clear_tests {
    use super::*;

    fn cfg(fast: Option<&str>, deep: Option<&str>) -> AiConfig {
        let mut c = AiConfig::default();
        c.fast_model_id = fast.map(String::from);
        c.deep_model_id = deep.map(String::from);
        c
    }

    /// The reported bug: "(not set)" could not be chosen. The UI sends "" and the
    /// field-wise merge leaves it alone (it is not None), so this is what turns it
    /// back into a real "unset".
    #[test]
    fn an_empty_string_becomes_unset() {
        let mut c = cfg(Some(""), Some(""));
        clear_blank_routing(&mut c);
        assert!(c.fast_model_id.is_none());
        assert!(c.deep_model_id.is_none());
    }

    #[test]
    fn whitespace_counts_as_empty() {
        let mut c = cfg(Some("   "), None);
        clear_blank_routing(&mut c);
        assert!(c.fast_model_id.is_none());
    }

    #[test]
    fn a_real_selection_is_left_alone() {
        let mut c = cfg(Some("inst-1:gpt-4o"), Some("inst-2:claude"));
        clear_blank_routing(&mut c);
        assert_eq!(c.fast_model_id.as_deref(), Some("inst-1:gpt-4o"));
        assert_eq!(c.deep_model_id.as_deref(), Some("inst-2:claude"));
    }

    #[test]
    fn already_unset_stays_unset() {
        let mut c = cfg(None, None);
        clear_blank_routing(&mut c);
        assert!(c.fast_model_id.is_none() && c.deep_model_id.is_none());
    }

    #[test]
    fn the_two_tiers_are_independent() {
        let mut c = cfg(Some(""), Some("inst-2:claude"));
        clear_blank_routing(&mut c);
        assert!(c.fast_model_id.is_none());
        assert_eq!(c.deep_model_id.as_deref(), Some("inst-2:claude"));
    }
}

#[cfg(test)]
mod secret_migration_tests {
    use super::*;

    /// These tests share ONE real credential store, and the provider-level
    /// account names are fixed in the production code — so they cannot run
    /// concurrently with each other. cargo runs tests in parallel by default;
    /// this makes the sharing explicit rather than intermittently wrong.
    static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the lock, surviving a previous test's panic.
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        STORE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A scratch config dir per test, so runs cannot collide.
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jhai_cfg_{}_{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_config(dir: &std::path::Path, json: &str) {
        std::fs::write(dir.join("ai_config.json"), json).unwrap();
    }

    fn read_raw(dir: &std::path::Path) -> serde_json::Value {
        let txt = std::fs::read_to_string(dir.join("ai_config.json")).unwrap();
        serde_json::from_str(&txt).unwrap()
    }

    /// Remove whatever a test put in the credential store.
    fn cleanup(accounts: &[&str]) {
        for a in accounts {
            let _ = secrets::delete(a);
        }
    }

    // The whole point: a config written before this feature must end up with its
    // keys in the store and NOTHING left in the file.
    #[test]
    fn a_plaintext_key_moves_out_of_the_file() {
        let _g = lock();
        if !secrets::is_available() {
            eprintln!("no credential store — skipping");
            return;
        }
        let dir = scratch_dir("migrate");
        write_config(&dir, r#"{"openai_key":"sk-plaintext-123","logging_enabled":false}"#);

        let loaded = load_config_with_secrets(&dir).unwrap();
        // The caller still gets a usable key…
        assert_eq!(loaded.openai_key.as_deref(), Some("sk-plaintext-123"));
        // …and the file no longer holds one.
        let raw = read_raw(&dir);
        assert!(raw["openai_key"].is_null(), "the plaintext key survived: {raw}");

        cleanup(&["openai_key"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Running twice must not lose the key the first run stored.
    #[test]
    fn migration_is_idempotent() {
        let _g = lock();
        if !secrets::is_available() {
            return;
        }
        let dir = scratch_dir("twice");
        write_config(&dir, r#"{"anthropic_key":"sk-ant-abc"}"#);

        let _ = load_config_with_secrets(&dir).unwrap();
        let second = load_config_with_secrets(&dir).unwrap();
        assert_eq!(second.anthropic_key.as_deref(), Some("sk-ant-abc"));

        cleanup(&["anthropic_key"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Per-connection keys are namespaced, so two connections do not share one.
    #[test]
    fn each_connection_keeps_its_own_key() {
        let _g = lock();
        if !secrets::is_available() {
            return;
        }
        let dir = scratch_dir("instances");
        write_config(&dir, r#"{"llm_instances":[
            {"id":"a","name":"A","provider":"openai","model":"gpt-4o","api_key":"sk-A"},
            {"id":"b","name":"B","provider":"openai","model":"gpt-4o","api_key":"sk-B"}
        ]}"#);

        let loaded = load_config_with_secrets(&dir).unwrap();
        let insts = loaded.llm_instances.unwrap();
        assert_eq!(insts[0].api_key.as_deref(), Some("sk-A"));
        assert_eq!(insts[1].api_key.as_deref(), Some("sk-B"));

        let raw = read_raw(&dir);
        assert!(raw["llm_instances"][0]["api_key"].is_null());
        assert!(raw["llm_instances"][1]["api_key"].is_null());

        cleanup(&[&secrets::instance_account("a"), &secrets::instance_account("b")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A config that has already been migrated has nothing left to move, and the
    // resolver must still hand back a usable key.
    #[test]
    fn an_already_migrated_config_still_resolves() {
        let _g = lock();
        if !secrets::is_available() {
            return;
        }
        let dir = scratch_dir("resolved");
        secrets::set("gemini_key", "AIza-stored").unwrap();
        write_config(&dir, r#"{"logging_enabled":true}"#);

        let loaded = load_config_with_secrets(&dir).unwrap();
        assert_eq!(loaded.gemini_key.as_deref(), Some("AIza-stored"));

        cleanup(&["gemini_key"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // extract_secrets is what save_ai_config uses. The file it writes must not
    // carry a key, and the store must.
    #[test]
    fn saving_puts_the_key_in_the_store_and_not_in_the_config() {
        let _g = lock();
        if !secrets::is_available() {
            return;
        }
        let mut cfg = AiConfig::default();
        cfg.azure_key = Some("azure-secret".to_string());
        extract_secrets(&mut cfg);

        assert!(cfg.azure_key.is_none(), "the key stayed on the config");
        assert_eq!(secrets::get("azure_key").unwrap().as_deref(), Some("azure-secret"));

        cleanup(&["azure_key"]);
    }

    // NOTE: these tests share ONE real credential store, and the provider-level
    // account names are fixed in the production code. Each test therefore uses a
    // DIFFERENT provider field, and none asserts anything about an account it
    // does not own — asserting "openai_key is absent" here failed whenever the
    // migration test happened to be mid-flight.
    #[test]
    fn a_config_with_no_keys_is_left_alone() {
        let _g = lock();
        let dir = scratch_dir("nokeys");
        write_config(&dir, r#"{"logging_enabled":true}"#);
        let before = std::fs::read_to_string(dir.join("ai_config.json")).unwrap();

        let loaded = load_config_with_secrets(&dir).unwrap();
        assert_eq!(loaded.logging_enabled, Some(true));
        // Nothing to migrate ⇒ nothing rewritten.
        assert_eq!(std::fs::read_to_string(dir.join("ai_config.json")).unwrap(), before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_config_reads_as_none() {
        let _g = lock();
        assert!(load_config_with_secrets(&scratch_dir("absent")).is_none());
    }
}

#[cfg(test)]
mod secret_field_coverage {
    use super::*;

    /// Does this config field name look like it holds a credential?
    ///
    /// `connection_token` is deliberately NOT matched: it is the local server's
    /// auth token, read and written before anything else at startup, and it
    /// stays in the file on purpose.
    fn looks_like_a_credential(name: &str) -> bool {
        name.ends_with("_key") || name.ends_with("api_key")
    }

    /// Every credential-shaped field on AiConfig must be listed in
    /// `secrets::SECRET_FIELDS`.
    ///
    /// This is the guard against the failure that actually happens: someone adds
    /// `mistral_key` to the struct, the three functions that move secrets out of
    /// the JSON (migrate / apply / extract) name their fields one by one, and the
    /// new one is silently left in plaintext forever. Rust cannot index a struct
    /// by string, so those functions cannot be driven from a list — but this test
    /// can compare the serialized shape against one, and fail until the list and
    /// the functions are both updated.
    #[test]
    fn every_credential_field_is_accounted_for() {
        let json = serde_json::to_value(AiConfig::default()).unwrap();
        let obj = json.as_object().expect("AiConfig serializes to an object");

        let found: Vec<&String> = obj.keys().filter(|k| looks_like_a_credential(k)).collect();
        assert!(!found.is_empty(), "the field-name pattern matched nothing — has AiConfig changed shape?");

        for name in &found {
            assert!(
                secrets::SECRET_FIELDS.contains(&name.as_str()),
                "AiConfig has a credential field `{name}` that is not in secrets::SECRET_FIELDS. \
                 Add it there AND to migrate_plaintext_keys / apply_stored_secrets / extract_secrets, \
                 or it will stay in ai_config.json in plaintext."
            );
        }
    }

    /// …and nothing is listed that no longer exists.
    #[test]
    fn the_list_has_no_stale_entries() {
        let json = serde_json::to_value(AiConfig::default()).unwrap();
        let obj = json.as_object().unwrap();
        for name in secrets::SECRET_FIELDS {
            assert!(
                obj.contains_key(name),
                "secrets::SECRET_FIELDS names `{name}`, which AiConfig no longer has"
            );
        }
    }

    // The local server's token is not an LLM credential and stays in the file.
    #[test]
    fn the_connection_token_is_not_treated_as_one() {
        assert!(!looks_like_a_credential("connection_token"));
        assert!(!secrets::SECRET_FIELDS.contains(&"connection_token"));
    }
}
