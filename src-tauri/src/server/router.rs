use axum::{
    routing::{get, post, delete},
    Router,
    Json,
    extract::{Path, State},
    http::StatusCode,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::path::PathBuf;
use chrono::Local;
use uuid::Uuid;
use tokio::sync::broadcast;
use tauri::Emitter;
use crate::commands::ai_config::AiConfig;
use crate::server::auth::{auth_middleware, AuthToken};
use crate::server::ws::ws_handler;
use crate::server::config_routes::{get_models, get_config, update_config, test_connection};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInfo {
    pub id: String,
    pub prompt: String,
    pub status: String, // "running", "paused", "completed", "aborted", "failed"
    pub progress: f32,
    pub token_usage: TokenUsage,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub workspace_path: Option<String>,
    pub caller: Option<String>,
    /// Structured result summary emitted on completion: { summary, files:[{path,action,description}] }.
    /// Lets REST API consumers and the "Result" tab read the outcome without re-parsing logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub logs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    // Cache tokens (DeepSeek prompt_cache_hit / OpenAI cached_tokens — a SUBSET of
    // prompt; Anthropic cache_read — additive). #[serde(default)] keeps old
    // persisted history JSON (without these fields) deserializable.
    #[serde(default)]
    pub cache_read_input_tokens: u32,
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
}

#[derive(Clone)]
pub struct AppState {
    pub auth_token: String,
    pub port: u16,
    pub tasks: Arc<Mutex<HashMap<String, TaskInfo>>>,
    pub task_senders: Arc<Mutex<HashMap<String, broadcast::Sender<String>>>>,
    pub config_path: PathBuf,
    pub history_path: PathBuf,
    pub app_handle: tauri::AppHandle,
}

/// Per-request execution behavior. Callers fully control this — JH AI Agent
/// does NOT store named profiles. Each request carries its own behavior, so
/// adding a new use case (new app, new feature) requires zero changes here.
///
/// All fields are optional with sensible defaults:
///   mode             = "iterative_agent"  (full agent loop with tools)
///   system_prompt    = ContextBuilder.getSystemPrompt() (the built-in heavy prompt)
///   enabled_tools    = None (all tools allowed)
///   max_iterations   = config's max_steps (0 = unlimited)
///   response_format  = "text"
///   extra_instructions = None (no append)
#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct AgentBehavior {
    /// "single_shot" → one LLM call, return result. No agent loop, no tools.
    /// "iterative_agent" → full agent loop (existing AgentController behavior).
    pub mode: Option<String>,

    /// Replaces the built-in system prompt entirely. When None, the caller
    /// inherits all built-in safety rules (anti-loop, verify, etc.).
    pub system_prompt: Option<String>,

    /// Tool allowlist. None = all tools enabled. [] = no tools (effectively
    /// degrades iterative_agent into a chat-style call). Otherwise a subset.
    pub enabled_tools: Option<Vec<String>>,

    /// Per-task override of max_steps. 0 = unlimited. Ignored in single_shot.
    pub max_iterations: Option<u32>,

    /// "text" (default) / "code" / "json". Hints the LLM about output shape
    /// and (for json) requests structured output where the provider supports it.
    pub response_format: Option<String>,

    /// Free-form text appended AFTER the system prompt (built-in or overridden).
    /// Use this for small per-call tweaks without rewriting the whole prompt.
    pub extra_instructions: Option<String>,

    /// MCP server names this task may use (scopes which servers' tools are
    /// exposed to the LLM). None ⇒ all connected servers. Must be a struct field
    /// or it is dropped at the HTTP boundary before reaching the JS agent.
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,

    /// Opaque per-task MCP context (e.g. { app, windowId, documentId }) injected
    /// into every `tools/call` request's `params._meta.jhai`, so an app-hosted
    /// MCP server can resolve which live document/window the call targets.
    #[serde(default)]
    pub mcp_context: Option<serde_json::Value>,

    /// Named AI action (Intent/Recipe). Either a string id (resolved against the
    /// intent registry the calling app declared) or an inline object
    /// { systemPrompt?, tools?[], resultKind? }. Expanded by the JS agent into
    /// enabled_tools / extra_instructions before the loop.
    #[serde(default)]
    pub intent: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub prompt: String,
    pub workspace_path: Option<String>,
    pub caller: Option<String>,
    /// Arbitrary caller-supplied context (schema, current file, ER graph, etc.)
    /// Passed through to the agent without interpretation.
    pub context: Option<serde_json::Value>,
    /// Per-request execution behavior. See AgentBehavior for fields.
    pub behavior: Option<AgentBehavior>,
    /// Base64 data URLs of images attached by the user (e.g. "data:image/png;base64,...").
    /// Forwarded to the agent's first LLM call unchanged.
    #[serde(default)]
    pub images: Option<Vec<String>>,
    /// Prior conversation messages [{role, content}] forwarded as agent chatContext
    /// so the agent loop has full history of the current chat session.
    #[serde(default)]
    pub chat_context: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
pub struct CreateTaskResponse {
    pub task_id: String,
    pub ws_url: String,
}

#[derive(Debug, Deserialize)]
pub struct SteeringRequest {
    pub message: String,
    #[serde(default)]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
struct RunTaskPayload {
    #[serde(rename = "taskId")]
    task_id: String,
    prompt: String,
    #[serde(rename = "workspacePath")]
    workspace_path: Option<String>,
    /// Pass-through caller context (kept opaque on the Rust side).
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<serde_json::Value>,
    /// Pass-through behavior. TaskBridge in JS will dispatch on `behavior.mode`.
    #[serde(skip_serializing_if = "Option::is_none")]
    behavior: Option<AgentBehavior>,
    /// Base64 data URLs forwarded from the caller to the agent's first LLM call.
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
    /// Prior conversation messages forwarded to the JS TaskBridge as chatContext.
    #[serde(rename = "chatContext", skip_serializing_if = "Option::is_none")]
    chat_context: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caller: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TestConnectionRequest {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub api_version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TestConnectionResponse {
    pub success: bool,
    pub message: String,
}

pub fn create_router(state: AppState) -> Router {
    let auth_token = state.auth_token.clone();
    
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        .allow_origin(tower_http::cors::Any);

    // API Routes that require Authentication
    let api_routes = Router::new()
        .route("/models", get(get_models))
        .route("/tasks", post(create_task).get(list_tasks))
        .route("/tasks/:id", get(get_task).delete(abort_task))
        .route("/tasks/:id/logs", get(get_task_logs))
        .route("/tasks/:id/steering", post(send_steering))
        .route("/tasks/:id/continue", post(continue_task))
        .route("/tasks/:id/history", delete(delete_task_history))
        .route("/config", get(get_config).put(update_config))
        .route("/config/test", post(test_connection))
        .route("/stats", get(get_stats))
        .layer(axum::middleware::from_fn(auth_middleware))
        .layer(Extension(AuthToken(auth_token.clone())));

    // Public / Hybrid routes
    Router::new()
        .route("/api/health", get(health_check))
        .nest("/api", api_routes)
        .route("/ws/tasks/:id", get(ws_handler))
        // Inbound MCP-over-WebSocket (Part A / T1): apps dial in and act as the
        // MCP server (tool provider); auth via the `token` query param in-handler.
        .route("/mcp/ws", get(crate::server::mcp_ws::mcp_ws_handler))
        .layer(cors)
        .with_state(state)
}

// Handler implementations

async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "version": "0.1.0",
        "time": Local::now().to_rfc3339()
    }))
}

async fn create_task(
    State(state): State<AppState>,
    Json(payload): Json<CreateTaskRequest>,
) -> Json<CreateTaskResponse> {
    let mut payload = payload;
    let task_id = Uuid::new_v4().to_string();
    let ws_url = format!("ws://localhost:{}/ws/tasks/{}?token={}", state.port, task_id, state.auth_token);

    // Extract images from behavior.mcp_context if not present at the top level
    if payload.images.is_none() || payload.images.as_ref().map_or(true, |v| v.is_empty()) {
        if let Some(behavior) = &payload.behavior {
            if let Some(mcp_context) = &behavior.mcp_context {
                if let Some(images_val) = mcp_context.get("images") {
                    if let Some(images_arr) = images_val.as_array() {
                        let extracted_images: Vec<String> = images_arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect();
                        if !extracted_images.is_empty() {
                            payload.images = Some(extracted_images);
                        }
                    }
                }
            }
        }
    }

    // Extract context from behavior.mcp_context if not present at the top level
    if payload.context.is_none() {
        if let Some(behavior) = &payload.behavior {
            if let Some(mcp_context) = &behavior.mcp_context {
                payload.context = Some(mcp_context.clone());
            }
        }
    }
    
    let task = TaskInfo {
        id: task_id.clone(),
        prompt: payload.prompt.clone(),
        status: "running".to_string(),
        progress: 0.0,
        token_usage: TokenUsage::default(),
        started_at: Local::now().to_rfc3339(),
        completed_at: None,
        workspace_path: payload.workspace_path.clone(),
        caller: payload.caller.clone(),
        result_summary: None,
        logs: vec![],
    };
    
    // Register task
    state.tasks.lock().unwrap().insert(task_id.clone(), task);
    
    // Create broadcast channel for WebSocket streaming
    let (tx, _rx) = broadcast::channel(100);
    state.task_senders.lock().unwrap().insert(task_id.clone(), tx);
    
    // Emit "run-task" event to tauri Webview to kickstart JS Agent loop.
    // The behavior (if any) is passed through so the JS-side TaskBridge can
    // dispatch into single_shot vs iterative_agent path.
    let run_payload = RunTaskPayload {
        task_id: task_id.clone(),
        prompt: payload.prompt,
        workspace_path: payload.workspace_path,
        context: payload.context,
        behavior: payload.behavior,
        images: payload.images,
        chat_context: payload.chat_context,
        caller: payload.caller,
    };
    let _ = state.app_handle.emit("run-task", run_payload);
    
    Json(CreateTaskResponse { task_id, ws_url })
}

async fn list_tasks(State(state): State<AppState>) -> Json<Vec<TaskInfo>> {
    let tasks = state.tasks.lock().unwrap();
    // The list view needs METADATA only (id / status / prompt / tokens /
    // result_summary). Strip each task's `logs` here: with logs, /tasks shipped
    // EVERY step's full request (system + history + tools + sent_request) for
    // EVERY task on each call — the dominant cause of "Monitor / spotlight feels
    // heavy" (both call listTasks). The detail view loads logs on demand via
    // GET /tasks/:id. (`logs` has skip_serializing_if = Vec::is_empty, so an empty
    // vec is simply omitted from the JSON.)
    let list: Vec<TaskInfo> = tasks.values().map(|t| {
        let mut t = t.clone();
        t.logs = Vec::new();
        t
    }).collect();
    Json(list)
}

async fn get_task(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<TaskInfo>, (StatusCode, String)> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        Ok(Json(task.clone()))
    } else {
        Err((StatusCode::NOT_FOUND, "Task not found".to_string()))
    }
}

async fn get_task_logs(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    // Snapshot the in-memory state quickly, then release the lock before
    // doing any disk I/O (avoids holding the mutex during sidecar file read).
    let (exists, in_mem_logs) = {
        let tasks = state.tasks.lock().unwrap();
        match tasks.get(&id) {
            Some(task) => (true, task.logs.clone()),
            None => (false, vec![]),
        }
    };

    if !exists {
        return Err((StatusCode::NOT_FOUND, "Task not found".to_string()));
    }

    // If the task still has logs in memory (live or recently completed in this
    // session), return them as-is. Otherwise it's a task loaded from disk after
    // an app restart — load its logs from the sidecar file lazily.
    if !in_mem_logs.is_empty() {
        return Ok(Json(in_mem_logs));
    }

    let disk_logs = crate::load_task_logs(&state.history_path, &id);

    // Cache the loaded logs back into memory so subsequent calls don't re-read disk.
    if !disk_logs.is_empty() {
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(&id) {
            if task.logs.is_empty() {
                task.logs = disk_logs.clone();
            }
        }
    }

    Ok(Json(disk_logs))
}

async fn abort_task(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Notify Frontend Webview to abort the task execution
    let _ = state.app_handle.emit("abort-task", serde_json::json!({ "taskId": id }));
    
    let mut tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get_mut(&id) {
        task.status = "aborted".to_string();
        task.completed_at = Some(Local::now().to_rfc3339());
        Ok(Json(serde_json::json!({ "status": "aborted" })))
    } else {
        Err((StatusCode::NOT_FOUND, "Task not found".to_string()))
    }
}

/// Permanently delete a task from history (memory + disk).
/// Returns the task's time window so the client can scope API-log cleanup.
async fn delete_task_history(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // 1. Remove from in-memory store
    let removed = {
        let mut tasks = state.tasks.lock().unwrap();
        tasks.remove(&id)
    };

    let task = removed.ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;

    // 2. Remove from persisted history file
    if state.history_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&state.history_path) {
            if let Ok(mut history) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                history.retain(|e| {
                    e.get("id").and_then(|v| v.as_str()) != Some(&id)
                });
                if let Ok(json) = serde_json::to_string_pretty(&history) {
                    let _ = std::fs::write(&state.history_path, json);
                }
            }
        }
    }

    // 2b. Remove the per-task logs sidecar file too — otherwise stale logs
    // would resurface if a future task happens to reuse the same UUID
    // (very unlikely, but the orphaned file is wasted disk space regardless).
    crate::delete_task_logs(&state.history_path, &id);

    // 3. Drop any active WS sender so any lingering relay loop exits
    {
        let mut senders = state.task_senders.lock().unwrap();
        senders.remove(&id);
    }

    Ok(Json(serde_json::json!({
        "status": "deleted",
        "id": id,
        "started_at": task.started_at,
        "completed_at": task.completed_at,
    })))
}

async fn send_steering(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<SteeringRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Notify Frontend Webview of steering message
    let _ = state.app_handle.emit("steering-task", serde_json::json!({
        "taskId": id,
        "message": payload.message,
        "images": payload.images
    }));
    Ok(Json(serde_json::json!({ "status": "steered" })))
}

/// Continue a COMPLETED task with a new user message — re-runs the agent under
/// the SAME task id so its results accumulate in one place. Reconstructs a minimal
/// chat_context (original goal + the last final response) and re-emits run-task.
async fn continue_task(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<SteeringRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Gather context from the existing (completed) task. The chat_context is
    // rebuilt from EVERY completed run of this task (request → answer pairs),
    // not just the first prompt + last answer — so after several continues the
    // agent still sees which requests were already completed, in order.
    // AgentController labels these as "[Completed request]" and pins the NEW
    // message as the current goal.
    let (workspace, caller, chat_context) = {
        let tasks = state.tasks.lock().unwrap();
        let task = tasks.get(&id)
            .ok_or((StatusCode::NOT_FOUND, "task not found".to_string()))?;

        // Bound context growth: older answers get clipped harder than the
        // most recent one (the requests themselves are kept in full).
        fn clip(s: &str, max: usize) -> String {
            if s.chars().count() <= max { s.to_string() }
            else {
                let cut: String = s.chars().take(max).collect();
                format!("{}…\n[answer truncated]", cut)
            }
        }

        let completes: Vec<&serde_json::Value> = task.logs.iter()
            .filter(|l| l.get("event").and_then(|e| e.as_str()) == Some("complete"))
            .collect();
        let n = completes.len();
        let mut ctx: Vec<serde_json::Value> = Vec::new();
        for (i, l) in completes.iter().enumerate() {
            let data = l.get("data");
            // Per-run request: recorded in resultSummary.request; the very first
            // run falls back to the task's original prompt.
            let req = data
                .and_then(|d| d.get("resultSummary"))
                .and_then(|r| r.get("request"))
                .and_then(|m| m.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| if i == 0 { task.prompt.clone() } else { String::new() });
            let ans = data
                .and_then(|d| d.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            let is_last = i + 1 == n;
            if !req.is_empty() {
                ctx.push(serde_json::json!({ "role": "user", "content": req }));
            }
            if !ans.is_empty() {
                ctx.push(serde_json::json!({
                    "role": "assistant",
                    "content": clip(ans, if is_last { 8000 } else { 2000 })
                }));
            }
        }
        // No completed run recorded (edge case) → fall back to the original prompt.
        if ctx.is_empty() {
            ctx.push(serde_json::json!({ "role": "user", "content": task.prompt.clone() }));
        }
        (task.workspace_path.clone(), task.caller.clone(), ctx)
    };

    // Re-open the task and create a fresh broadcast channel (the previous one was
    // dropped when the task first completed).
    {
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(&id) {
            task.status = "running".to_string();
            task.completed_at = None;
        }
    }
    let (tx, _rx) = broadcast::channel(100);
    state.task_senders.lock().unwrap().insert(id.clone(), tx);

    let run_payload = RunTaskPayload {
        task_id: id.clone(),
        prompt: payload.message,
        workspace_path: workspace,
        context: None,
        behavior: None,
        images: payload.images,
        chat_context: Some(chat_context),
        caller,
    };
    let _ = state.app_handle.emit("run-task", run_payload);

    let ws_url = format!("ws://localhost:{}/ws/tasks/{}?token={}", state.port, id, state.auth_token);
    Ok(Json(serde_json::json!({ "task_id": id, "ws_url": ws_url, "status": "continuing" })))
}

async fn get_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tasks = state.tasks.lock().unwrap();
    let mut total_tasks = 0;
    let mut total_tokens = 0;
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;
    
    for task in tasks.values() {
        total_tasks += 1;
        prompt_tokens += task.token_usage.prompt_tokens;
        completion_tokens += task.token_usage.completion_tokens;
        total_tokens += task.token_usage.total_tokens;
    }
    
    // Cost is an ESTIMATE from configurable per-token rates (USD per 1M tokens),
    // computed separately for prompt vs completion. Rates are read from
    // ai_config.json (cost_per_1m_prompt / cost_per_1m_completion) so they can be
    // set to the active model's real pricing instead of a single hardcoded number.
    let (rate_p, rate_c) = read_cost_rates(&state.config_path);
    let estimated_cost = (prompt_tokens as f64 / 1_000_000.0) * rate_p
        + (completion_tokens as f64 / 1_000_000.0) * rate_c;

    Json(serde_json::json!({
        "totalTasks": total_tasks,
        "totalTokens": total_tokens,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "estimatedCost": estimated_cost,
        "costRates": { "prompt_per_1m": rate_p, "completion_per_1m": rate_c }
    }))
}

/// Read per-1M-token USD cost rates from ai_config.json. Falls back to a generic
/// low estimate when unset; set cost_per_1m_prompt / cost_per_1m_completion to the
/// real pricing of the model you use (e.g. DeepSeek vs GPT-4o differ ~50×).
fn read_cost_rates(config_path: &PathBuf) -> (f64, f64) {
    let mut prompt_rate = 0.5;       // generic placeholder; configurable
    let mut completion_rate = 1.5;
    if let Ok(txt) = std::fs::read_to_string(config_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(p) = v.get("cost_per_1m_prompt").and_then(|x| x.as_f64()) { prompt_rate = p; }
            if let Some(c) = v.get("cost_per_1m_completion").and_then(|x| x.as_f64()) { completion_rate = c; }
        }
    }
    (prompt_rate, completion_rate)
}

// Helpers
pub(crate) fn load_config(path: &PathBuf) -> Result<AiConfig, (StatusCode, String)> {
    if !path.exists() {
        return Ok(AiConfig::default());
    }
    let json = std::fs::read_to_string(path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    serde_json::from_str(&json).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}
