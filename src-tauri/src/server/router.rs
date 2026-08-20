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
    /// Token usage broken down BY MODEL (model id → usage). A task can escalate
    /// tiers (fast → deep) or be resumed under a different connection, so a single
    /// `model` field would be lossy. Lets cost be priced with each model's own
    /// rates instead of whatever model happens to be active at report time.
    /// `serde(default)` keeps pre-existing persisted history loadable.
    #[serde(default)]
    pub model_usage: HashMap<String, TokenUsage>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub workspace_path: Option<String>,
    pub caller: Option<String>,
    /// Which MCP servers this task may use (from behavior.mcp_servers at creation).
    /// Persisted so a CONTINUATION ("add a message to continue the task") keeps
    /// the same tool scope: the task UI sends an explicit [] when the user
    /// unchecked every server, and an omitted/None here would silently re-enable
    /// ALL servers — including ones that connect MID-task.
    /// `serde(default)` keeps pre-existing persisted history loadable.
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
    /// Structured result summary emitted on completion: { summary, files:[{path,action,description}] }.
    /// Lets REST API consumers and the "Result" tab read the outcome without re-parsing logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<serde_json::Value>,
    /// Per-file before/after content emitted on completion: [{path, original, current}].
    /// Persisted so the editor can re-open a diff for a task loaded from HISTORY
    /// (live tasks already carry it on the WS `complete` event).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified_files: Vec<serde_json::Value>,
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
        .route("/tasks/:id/logs/:idx", get(get_task_log_entry))
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
        model_usage: HashMap::new(),
        started_at: Local::now().to_rfc3339(),
        completed_at: None,
        workspace_path: payload.workspace_path.clone(),
        caller: payload.caller.clone(),
        mcp_servers: payload.behavior.as_ref().and_then(|b| b.mcp_servers.clone()),
        result_summary: None,
        modified_files: vec![],
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

/// Clone a task's METADATA — every field except `logs`.
///
/// `t.clone()` followed by `t.logs = Vec::new()` reads the same but is not: the
/// clone deep-copies the whole log vector FIRST, and a long task's cached logs
/// run to hundreds of MB of `serde_json::Value` (the sidecar for one task in a
/// real install is 552 MB). Both /tasks and /tasks/:id were paying that copy on
/// every call, only to drop it again.
fn task_meta(t: &TaskInfo) -> TaskInfo {
    TaskInfo {
        id: t.id.clone(),
        prompt: t.prompt.clone(),
        status: t.status.clone(),
        progress: t.progress,
        token_usage: t.token_usage.clone(),
        model_usage: t.model_usage.clone(),
        started_at: t.started_at.clone(),
        completed_at: t.completed_at.clone(),
        workspace_path: t.workspace_path.clone(),
        caller: t.caller.clone(),
        mcp_servers: t.mcp_servers.clone(),
        result_summary: t.result_summary.clone(),
        modified_files: t.modified_files.clone(),
        logs: Vec::new(),
    }
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
    let list: Vec<TaskInfo> = tasks.values().map(task_meta).collect();
    Json(list)
}

async fn get_task(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<TaskInfo>, (StatusCode, String)> {
    let tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get(&id) {
        // METADATA only, like /tasks. Logs are served by GET /tasks/:id/logs,
        // which pages and slims them; once a big task's logs had been read into
        // the cache, this endpoint serialized the WHOLE un-slimmed vector on
        // every call — and the Monitor calls it on every task switch, for the
        // id and status alone.
        Ok(Json(task_meta(task)))
    } else {
        Err((StatusCode::NOT_FOUND, "Task not found".to_string()))
    }
}

/// Strip the QUADRATICALLY-growing fields from a log entry for LISTING /
/// REPLAY payloads: each per-step CHAT entry embeds the FULL conversation
/// history + system prompt + assembled request of that step, so a task's raw
/// logs grow O(steps²) — the dominant "selecting a task is slow" cost (see
/// docs/design/monitor-selection-performance.md). The stripped entry carries
/// `data.request._slim = true` and `data._idx` so the client can fetch the
/// FULL entry on demand via GET /tasks/:id/logs/:idx (CHAT detail modal).
pub(crate) fn slim_log_entry(entry: &serde_json::Value, idx: usize) -> serde_json::Value {
    let mut e = entry.clone();
    // `_idx` is how the client pages backwards ("load earlier"), so EVERY entry
    // must carry it — including ones with no `data` object, which would
    // otherwise leave the first entry of a page without an anchor.
    if let Some(obj) = e.as_object_mut() {
        if !obj.get("data").map(|d| d.is_object()).unwrap_or(false) {
            obj.insert("data".to_string(), serde_json::json!({}));
        }
    }
    if let Some(data) = e.get_mut("data") {
        let mut slimmed = false;
        if let Some(req) = data.get_mut("request") {
            if let Some(obj) = req.as_object_mut() {
                for k in ["history", "system_prompt", "sent_request", "tools"] {
                    if obj.remove(k).is_some() {
                        slimmed = true;
                    }
                }
                if slimmed {
                    obj.insert("_slim".to_string(), serde_json::Value::Bool(true));
                }
            }
        }
        if let Some(dobj) = data.as_object_mut() {
            dobj.insert("_idx".to_string(), serde_json::json!(idx));
        }
    }
    e
}

/// Query for GET /tasks/:id/logs.
///
/// Slimming alone was not enough: a long task still shipped every entry, and the
/// Task view only needs the recent tail to render. `limit` returns the LAST N
/// entries; `before` pages backwards from an index the client already has.
#[derive(serde::Deserialize, Default)]
pub struct LogsQuery {
    pub limit: Option<usize>,
    pub before: Option<usize>,
}

/// Pick the window of `logs` a request asked for.
///
/// Returns `(slice_start, entries)`. `slice_start` is the ORIGINAL index of the
/// first returned entry, so the client knows whether earlier ones exist — the
/// per-entry `_idx` used by the CHAT detail modal stays absolute either way.
pub(crate) fn log_window(total: usize, q: &LogsQuery) -> (usize, usize) {
    let end = q.before.map(|b| b.min(total)).unwrap_or(total);
    let limit = q.limit.filter(|n| *n > 0).unwrap_or(total);
    let start = end.saturating_sub(limit);
    (start, end)
}

async fn get_task_logs(
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<LogsQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, (StatusCode, String)> {
    // ONE index space over the sidecar followed by whatever the running task has
    // not checkpointed yet, so `_idx` means the same thing whichever side an
    // entry comes from. The alternative — "serve memory if it has anything, else
    // the file" — silently hid the whole earlier history of a task continued
    // after a restart, because memory then holds ONLY the new entries.
    //
    // And ONE index for both halves of the request: the count that sizes the
    // window and the entries it returns. Taking them separately scanned the file
    // twice — 0.9 s of the 1.0 s a real 552 MB sidecar cost to open.
    let index = crate::task_log_index(&state.history_path, &id);
    let on_disk = index.as_ref().map(|i| i.len()).unwrap_or(0);
    let (exists, tail) = {
        let tasks = state.tasks.lock().unwrap();
        match tasks.get(&id) {
            Some(task) => {
                // Only the un-checkpointed tail is copied. Cloning `task.logs`
                // (which is what stood here) deep-copies every entry to hand
                // back 400 of them — on a task with a 552 MB sidecar, per
                // request, and the Monitor issues one on every open.
                let p = crate::persisted_log_count(&id).min(task.logs.len());
                (true, task.logs[p..].to_vec())
            }
            None => (false, vec![]),
        }
    };

    if !exists {
        return Err((StatusCode::NOT_FOUND, "Task not found".to_string()));
    }

    let total = on_disk + tail.len();
    let (start, end) = log_window(total, &q);
    let mut entries: Vec<serde_json::Value> = Vec::new();
    // The file part: only these entries are parsed, the rest of the file having
    // been a byte scan. What stood here parsed EVERY entry of the whole file to
    // return the last 400, then kept the result in `task.logs` — which is why
    // opening a task with a long history cost both seconds and hundreds of MB of
    // resident memory for the life of the process.
    if let Some(index) = index.as_ref() {
        entries.extend(index.read_range(start, on_disk.min(end)));
    }
    // The live part.
    if end > on_disk {
        let from = start.saturating_sub(on_disk);
        let to = end - on_disk;
        entries.extend(tail[from.min(tail.len())..to.min(tail.len())].iter().cloned());
    }

    let slim: Vec<serde_json::Value> = entries.iter().enumerate()
        .map(|(i, l)| slim_log_entry(l, start + i)).collect();
    Ok(Json(slim))
}

/// GET /tasks/:id/logs/:idx — the FULL (un-slimmed) log entry at index `idx`.
/// Used by the Monitor's CHAT detail modal to lazily load the heavy request
/// payload (history / system_prompt / sent_request / tools) for one step.
async fn get_task_log_entry(
    Path((id, idx)): Path<(String, usize)>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // `idx` is absolute over (sidecar ++ un-checkpointed tail), the same space
    // GET /tasks/:id/logs indexes with. Reading it as a plain offset into
    // `task.logs` was only right while memory happened to hold the whole log.
    let on_disk = crate::task_log_line_count(&state.history_path, &id);
    let (exists, entry) = {
        let tasks = state.tasks.lock().unwrap();
        match tasks.get(&id) {
            Some(task) => {
                let base = on_disk.saturating_sub(crate::persisted_log_count(&id).min(task.logs.len()));
                (true, idx.checked_sub(base).and_then(|j| task.logs.get(j)).cloned())
            }
            None => (false, None),
        }
    };
    if !exists {
        return Err((StatusCode::NOT_FOUND, "Task not found".to_string()));
    }
    if let Some(e) = entry {
        return Ok(Json(e));
    }
    // Not in memory — take the ONE entry out of the sidecar rather than parsing
    // the whole file for it.
    let q = LogsQuery { limit: Some(1), before: Some(idx + 1) };
    let (_total, _start, entries) = crate::load_task_logs_window(&state.history_path, &id, &q);
    entries.into_iter().next()
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, format!("log index {} out of range", idx)))
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
                    // Atomic: a truncated write here would wipe the whole history.
                    let _ = crate::write_atomic(&state.history_path, json.as_bytes());
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
    let (workspace, caller, chat_context, mcp_servers) = {
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
        (task.workspace_path.clone(), task.caller.clone(), ctx, task.mcp_servers.clone())
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

    // Carry the task's original MCP scope into the continuation. The task UI
    // sends an explicit [] (no MCP servers) when every checkbox is unchecked;
    // dropping it here would re-enable ALL servers for the continuation — and
    // a server that connected mid-task would leak its tools into later turns.
    // (The same [] must reach AgentController's setMcpServerFilter → empty Set.)
    let behavior = mcp_servers.as_ref().map(|servers| AgentBehavior {
        mode: None,
        system_prompt: None,
        enabled_tools: None,
        max_iterations: None,
        response_format: None,
        extra_instructions: None,
        mcp_servers: Some(servers.clone()),
        mcp_context: None,
        intent: None,
    });

    let run_payload = RunTaskPayload {
        task_id: id.clone(),
        prompt: payload.message,
        workspace_path: workspace,
        context: None,
        behavior,
        images: payload.images,
        chat_context: Some(chat_context),
        caller,
    };
    let _ = state.app_handle.emit("run-task", run_payload);

    let ws_url = format!("ws://localhost:{}/ws/tasks/{}?token={}", state.port, id, state.auth_token);
    Ok(Json(serde_json::json!({ "task_id": id, "ws_url": ws_url, "status": "continuing" })))
}

/// Do the reported prompt tokens ALREADY include the cache reads?
///
/// Providers disagree. OpenAI-compatible endpoints (DeepSeek, Kimi/Moonshot,
/// Gemini) report `prompt_tokens` INCLUSIVE of the cached part, so
/// total = prompt + completion. Anthropic reports the two as separate buckets.
/// Guessing by vendor would be wrong the first time a new endpoint appeared, so
/// ask the data: which accounting reproduces the total the provider itself
/// reported?
///
/// This is the Rust twin of `cacheInsideInput` in
/// dashboard/views/monitor/inspector.js — keep the two in step.
fn cache_inside_input(u: &TokenUsage) -> bool {
    if u.cache_read_input_tokens == 0 { return false; }
    let inn = u.prompt_tokens as i64;
    let cache = u.cache_read_input_tokens as i64;
    let out = u.completion_tokens as i64;
    let total = u.total_tokens as i64;
    // No total to check against: the relative sizes are the only evidence.
    if total == 0 { return inn > cache; }
    (total - (inn + out)).abs() <= (total - (inn + out + cache)).abs()
}

/// USD for one model's slice of a task.
///
/// Prices ONLY the input tokens that missed the cache. Charging the whole
/// `prompt_tokens` at the input rate and then ADDING the cache reads at the
/// cache rate — which this did until 2026-08-13 — bills the cached tokens
/// twice. On a run with a 98% hit rate that overstated the input cost by
/// roughly 50x, and it is why /stats disagreed with the per-task figures the
/// Monitor inspector showed (the inspector always did this correctly).
fn cost_of(u: &TokenUsage, (rate_in, rate_cache, rate_out): (f64, f64, f64)) -> f64 {
    let cache = u.cache_read_input_tokens as f64;
    let fresh = if cache_inside_input(u) {
        (u.prompt_tokens as f64 - cache).max(0.0)
    } else {
        u.prompt_tokens as f64
    };
    fresh / 1_000_000.0 * rate_in
        + cache / 1_000_000.0 * rate_cache
        + (u.completion_tokens as f64) / 1_000_000.0 * rate_out
}

async fn get_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tasks = state.tasks.lock().unwrap();
    let mut total_tasks = 0;
    let mut total_tokens = 0;
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;
    let mut cache_read_tokens = 0u64;

    for task in tasks.values() {
        total_tasks += 1;
        prompt_tokens += task.token_usage.prompt_tokens as u64;
        completion_tokens += task.token_usage.completion_tokens as u64;
        cache_read_tokens += task.token_usage.cache_read_input_tokens as u64;
        total_tokens += task.token_usage.total_tokens;
    }

    // Cost is priced PER MODEL: each task records which model produced which
    // tokens (`model_usage`), so a mixed-model history (tier escalation, or a
    // connection switch between tasks) is costed with each model's own rates
    // instead of a single global guess. Tasks recorded before per-model
    // attribution existed (empty model_usage) fall back to the active model's
    // rates over their whole token volume. Cached input is billed at its own
    // (usually ~10%) rate, matching the ↑ / ⚡ / ↓ line items in the UI.
    let (table, fallback) = read_cost_table(&state.config_path);
    let (rate_in, rate_cache, rate_out) = fallback;
    let mut estimated_cost = 0.0f64;
    let mut attributed_tokens = 0u64;   // tokens priced with a model-specific rate
    for task in tasks.values() {
        if task.model_usage.is_empty() {
            // Legacy task: no attribution → price the whole task at fallback rates.
            estimated_cost += cost_of(&task.token_usage, fallback);
            continue;
        }
        for (model, u) in &task.model_usage {
            estimated_cost += cost_of(u, table.get(model.as_str()).copied().unwrap_or(fallback));
            attributed_tokens += u.total_tokens as u64;
        }
    }

    Json(serde_json::json!({
        "totalTasks": total_tasks,
        "totalTokens": total_tokens,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cacheReadTokens": cache_read_tokens,
        "estimatedCost": estimated_cost,
        // How much of the volume was priced with a MODEL-SPECIFIC rate (the rest
        // used the fallback) — so the UI can say how trustworthy the figure is.
        "attributedTokens": attributed_tokens,
        "costRates": { "input_per_1m": rate_in, "cache_read_per_1m": rate_cache, "output_per_1m": rate_out },
        // MODEL → rates. The per-task panel needs this to price a run that
        // switched models (tier escalation) with each model's own rates; with
        // only the flat `costRates` above it re-priced the whole task at
        // whatever model happened to be active, so the figure moved when the
        // model did.
        "costTable": table.iter().map(|(model, (i, c, o))| {
            (model.clone(), serde_json::json!({
                "input_per_1m": i, "cache_read_per_1m": c, "output_per_1m": o
            }))
        }).collect::<serde_json::Map<String, serde_json::Value>>()
    }))
}

/// Per-1M-token USD rates: (input, cache-read, output).
pub(crate) type CostRates = (f64, f64, f64);

/// Build a MODEL → rates table from the config, plus the fallback rates used for
/// models with no entry (and for legacy tasks with no per-model attribution).
///
/// Each configured LLM connection contributes one entry keyed by its `model`
/// name — that's what `token_usage.model` reports. Fallback resolution:
/// active instance's cost_per_1m_* → legacy global cost_per_1m_prompt/completion
/// → a generic placeholder. A missing cache-read rate defaults to ~10% of input
/// (the common industry ratio). Pure w.r.t. the passed path.
fn read_cost_table(config_path: &PathBuf) -> (HashMap<String, CostRates>, CostRates) {
    let mut table: HashMap<String, CostRates> = HashMap::new();
    let mut fb_in = 0.5;       // generic placeholder; configurable per model
    let mut fb_out = 1.5;
    let mut fb_cache: Option<f64> = None;

    if let Ok(txt) = std::fs::read_to_string(config_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            // Legacy global keys (kept for back-compat).
            if let Some(p) = v.get("cost_per_1m_prompt").and_then(|x| x.as_f64()) { fb_in = p; }
            if let Some(c) = v.get("cost_per_1m_completion").and_then(|x| x.as_f64()) { fb_out = c; }

            let active_id = v.get("active_llm_instance_id").and_then(|x| x.as_str());
            if let Some(insts) = v.get("llm_instances").and_then(|x| x.as_array()) {
                // One table entry per connection, keyed by its model name.
                for inst in insts {
                    let model = inst.get("model").and_then(|x| x.as_str()).unwrap_or("");
                    if model.is_empty() { continue; }
                    let i = inst.get("cost_per_1m_input").and_then(|x| x.as_f64());
                    let o = inst.get("cost_per_1m_output").and_then(|x| x.as_f64());
                    let c = inst.get("cost_per_1m_cache_read").and_then(|x| x.as_f64());
                    // Only index models that actually declare pricing; others fall
                    // through to the fallback rates.
                    if i.is_some() || o.is_some() || c.is_some() {
                        let ri = i.unwrap_or(fb_in);
                        table.insert(model.to_string(), (ri, c.unwrap_or(ri * 0.1), o.unwrap_or(fb_out)));
                    }
                }
                // Fallback = the ACTIVE instance's rates (or the first connection's).
                let active = insts.iter().find(|i| {
                    active_id.map_or(false, |id| i.get("id").and_then(|x| x.as_str()) == Some(id))
                }).or_else(|| insts.first());
                if let Some(inst) = active {
                    if let Some(x) = inst.get("cost_per_1m_input").and_then(|x| x.as_f64()) { fb_in = x; }
                    if let Some(x) = inst.get("cost_per_1m_output").and_then(|x| x.as_f64()) { fb_out = x; }
                    if let Some(x) = inst.get("cost_per_1m_cache_read").and_then(|x| x.as_f64()) { fb_cache = Some(x); }
                }
            }
        }
    }
    (table, (fb_in, fb_cache.unwrap_or(fb_in * 0.1), fb_out))
}

// Helpers
pub(crate) fn load_config(path: &PathBuf) -> Result<AiConfig, (StatusCode, String)> {
    if !path.exists() {
        return Ok(AiConfig::default());
    }
    let json = std::fs::read_to_string(path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    serde_json::from_str(&json).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[cfg(test)]
mod slim_log_tests {
    use super::*;

    #[test]
    fn every_entry_gets_an_absolute_index() {
        let e = slim_log_entry(&serde_json::json!({ "event": "status", "data": { "message": "x" } }), 7);
        assert_eq!(e["data"]["_idx"], 7);
    }

    /// The client pages backwards from `_idx`; an entry without one leaves the
    /// first row of a page with no anchor and "load earlier" cannot advance.
    #[test]
    fn an_entry_with_no_data_object_still_gets_one() {
        let e = slim_log_entry(&serde_json::json!({ "event": "ping" }), 3);
        assert_eq!(e["data"]["_idx"], 3);
    }

    #[test]
    fn a_non_object_data_field_is_replaced_rather_than_dropping_the_index() {
        let e = slim_log_entry(&serde_json::json!({ "event": "x", "data": "oops" }), 5);
        assert_eq!(e["data"]["_idx"], 5);
    }

    #[test]
    fn the_quadratic_request_fields_are_stripped_and_flagged() {
        let e = slim_log_entry(&serde_json::json!({
            "event": "log",
            "data": { "request": { "history": [1, 2], "system_prompt": "big", "purpose": "keep" } }
        }), 0);
        assert!(e["data"]["request"]["history"].is_null());
        assert!(e["data"]["request"]["system_prompt"].is_null());
        assert_eq!(e["data"]["request"]["purpose"], "keep");
        assert_eq!(e["data"]["request"]["_slim"], true);
    }

    #[test]
    fn an_entry_with_nothing_heavy_is_not_flagged_slim() {
        let e = slim_log_entry(&serde_json::json!({ "event": "log", "data": { "request": { "purpose": "x" } } }), 1);
        assert!(e["data"]["request"].get("_slim").is_none());
    }
}

#[cfg(test)]
mod task_meta_tests {
    use super::*;

    fn task_with_logs(n: usize) -> TaskInfo {
        TaskInfo {
            id: "t1".into(),
            prompt: "p".into(),
            status: "completed".into(),
            progress: 1.0,
            token_usage: TokenUsage::default(),
            model_usage: HashMap::new(),
            started_at: "2026-08-19T00:00:00+09:00".into(),
            completed_at: None,
            workspace_path: Some("C:/ws".into()),
            caller: Some("monitor".into()),
            mcp_servers: Some(vec!["backlog".into()]),
            result_summary: Some(serde_json::json!({ "summary": "done" })),
            modified_files: vec![serde_json::json!({ "path": "a.js" })],
            logs: (0..n).map(|i| serde_json::json!({ "event": "status", "i": i })).collect(),
        }
    }

    /// The listing and the detail endpoint both need everything BUT the logs.
    #[test]
    fn the_metadata_survives_and_the_logs_do_not() {
        let t = task_with_logs(1000);
        let m = task_meta(&t);

        assert!(m.logs.is_empty());
        assert_eq!(m.id, t.id);
        assert_eq!(m.status, t.status);
        assert_eq!(m.token_usage.total_tokens, t.token_usage.total_tokens);
        assert_eq!(m.workspace_path, t.workspace_path);
        assert_eq!(m.caller, t.caller);
        assert_eq!(m.mcp_servers, t.mcp_servers);
        assert_eq!(m.result_summary, t.result_summary);
        assert_eq!(m.modified_files, t.modified_files);
    }

    /// `logs` is skip_serializing_if = is_empty, so dropping it removes the
    /// field entirely — that is what keeps a cached 552 MB log out of a response
    /// whose caller only wants the status.
    #[test]
    fn the_serialized_response_carries_no_logs_field() {
        let json = serde_json::to_value(task_meta(&task_with_logs(10))).unwrap();
        assert!(json.get("logs").is_none());
        assert_eq!(json["id"], "t1");
    }
}

#[cfg(test)]
mod log_window_tests {
    use super::*;

    fn q(limit: Option<usize>, before: Option<usize>) -> LogsQuery {
        LogsQuery { limit, before }
    }

    #[test]
    fn no_query_returns_everything() {
        assert_eq!(log_window(50, &q(None, None)), (0, 50));
    }

    #[test]
    fn limit_returns_the_TAIL_not_the_head() {
        // The Task view renders the recent end of the conversation, so a capped
        // request must yield the newest entries.
        assert_eq!(log_window(50, &q(Some(10), None)), (40, 50));
    }

    #[test]
    fn limit_larger_than_the_log_is_harmless() {
        assert_eq!(log_window(3, &q(Some(100), None)), (0, 3));
    }

    #[test]
    fn before_pages_backwards_from_a_known_index() {
        // Client has 40..50; asking for the 10 before 40 yields 30..40.
        assert_eq!(log_window(50, &q(Some(10), Some(40))), (30, 40));
    }

    #[test]
    fn before_is_clamped_to_the_log_length() {
        assert_eq!(log_window(20, &q(Some(5), Some(999))), (15, 20));
    }

    #[test]
    fn paging_past_the_beginning_stops_at_zero_instead_of_wrapping() {
        assert_eq!(log_window(20, &q(Some(50), Some(10))), (0, 10));
    }

    #[test]
    fn a_zero_limit_is_treated_as_unset_rather_than_returning_nothing() {
        assert_eq!(log_window(7, &q(Some(0), None)), (0, 7));
    }

    #[test]
    fn an_empty_log_produces_an_empty_window() {
        assert_eq!(log_window(0, &q(Some(10), None)), (0, 0));
        assert_eq!(log_window(0, &q(None, Some(5))), (0, 0));
    }
}

#[cfg(test)]
mod cost_table_tests {
    use super::{read_cost_table, CostRates};
    use std::io::Write;

    /// Write a uniquely-named temp ai_config.json (tests run in parallel).
    fn cfg(name: &str, json: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("jhai_cfg_{}_{}.json", std::process::id(), name));
        std::fs::File::create(&p).unwrap().write_all(json.as_bytes()).unwrap();
        p
    }

    /// Rates are computed with f64 math (input * 0.1), so compare with epsilon.
    fn assert_rates(got: CostRates, want: CostRates) {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(
            close(got.0, want.0) && close(got.1, want.1) && close(got.2, want.2),
            "rates {:?} != expected {:?}", got, want
        );
    }

    #[test]
    fn missing_config_yields_placeholder_fallback() {
        let (table, fb) = read_cost_table(&std::path::PathBuf::from("/no/such/file.json"));
        assert!(table.is_empty());
        assert_rates(fb, (0.5, 0.05, 1.5)); // cache defaults to 10% of input
    }

    #[test]
    fn indexes_each_priced_model_and_defaults_cache_to_10_percent() {
        let p = cfg("indexed", r#"{
            "active_llm_instance_id": "i2",
            "llm_instances": [
                {"id":"i1","model":"gpt-4o","cost_per_1m_input":2.5,"cost_per_1m_output":10.0},
                {"id":"i2","model":"claude-sonnet","cost_per_1m_input":3.0,"cost_per_1m_cache_read":0.3,"cost_per_1m_output":15.0}
            ]
        }"#);
        let (table, fb) = read_cost_table(&p);
        // gpt-4o declares no cache rate -> 10% of input.
        assert_rates(table.get("gpt-4o").copied().unwrap(), (2.5, 0.25, 10.0));
        // claude-sonnet declares one explicitly.
        assert_rates(table.get("claude-sonnet").copied().unwrap(), (3.0, 0.3, 15.0));
        // Fallback follows the ACTIVE instance (i2).
        assert_rates(fb, (3.0, 0.3, 15.0));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn unpriced_models_are_not_indexed() {
        let p = cfg("unpriced", r#"{"llm_instances":[{"id":"i1","model":"local-llama"}]}"#);
        let (table, fb) = read_cost_table(&p);
        assert!(table.get("local-llama").is_none(), "no rates declared -> not indexed");
        assert_rates(fb, (0.5, 0.05, 1.5));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn legacy_global_keys_still_set_the_fallback() {
        let p = cfg("legacy", r#"{"cost_per_1m_prompt":1.0,"cost_per_1m_completion":4.0}"#);
        let (_t, fb) = read_cost_table(&p);
        assert_rates(fb, (1.0, 0.1, 4.0));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn no_active_id_falls_back_to_the_first_instance() {
        let p = cfg("firstinst", r#"{"llm_instances":[
            {"id":"i1","model":"a","cost_per_1m_input":7.0,"cost_per_1m_output":9.0}
        ]}"#);
        let (_t, fb) = read_cost_table(&p);
        assert_rates(fb, (7.0, 0.7, 9.0));
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod cost_tests {
    use super::*;

    fn usage(prompt: u32, completion: u32, cache: u32, total: u32) -> TokenUsage {
        TokenUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
            cache_read_input_tokens: cache,
            cache_creation_input_tokens: 0,
        }
    }

    /// $3 / $0.30 / $15 per 1M — the shape of a premium model with a 10% cache rate.
    const RATES: (f64, f64, f64) = (3.0, 0.3, 15.0);

    /// A real Kimi step: 137,506 prompt of which 135,680 cached, 211 out.
    /// total == prompt + completion, so the cache is a SUBSET of the prompt.
    #[test]
    fn an_openai_compatible_provider_reports_cache_inside_the_prompt_count() {
        assert!(cache_inside_input(&usage(137_506, 211, 135_680, 137_717)));
    }

    /// Anthropic: input and cache are separate buckets and the total holds both.
    #[test]
    fn anthropic_reports_cache_beside_the_prompt_count() {
        assert!(!cache_inside_input(&usage(1_000, 500, 50_000, 51_500)));
    }

    #[test]
    fn no_cache_reads_means_nothing_to_decide() {
        assert!(!cache_inside_input(&usage(1_000, 500, 0, 1_500)));
    }

    /// THE BUG THIS REPLACED: the old sum charged `prompt_tokens` at the full
    /// input rate AND added the cache reads at the cache rate, so every cached
    /// token was billed twice. At a 98.7% hit rate that is a ~50x overstatement
    /// of the input line.
    #[test]
    fn a_cached_token_is_billed_once_not_twice() {
        let u = usage(137_506, 211, 135_680, 137_717);
        let fresh = 137_506.0 - 135_680.0;
        let expected = fresh / 1e6 * 3.0 + 135_680.0 / 1e6 * 0.3 + 211.0 / 1e6 * 15.0;
        assert!((cost_of(&u, RATES) - expected).abs() < 1e-9);

        let double_charged = 137_506.0 / 1e6 * 3.0 + 135_680.0 / 1e6 * 0.3 + 211.0 / 1e6 * 15.0;
        assert!(cost_of(&u, RATES) < double_charged / 5.0,
            "the old accounting was more than 5x this figure; the fix must be far below it");
    }

    /// The mirror-image error: subtracting a cache that was never inside the
    /// prompt count drives the input line negative.
    #[test]
    fn an_additive_cache_is_not_subtracted() {
        let u = usage(1_000, 500, 50_000, 51_500);
        let expected = 1_000.0 / 1e6 * 3.0 + 50_000.0 / 1e6 * 0.3 + 500.0 / 1e6 * 15.0;
        assert!((cost_of(&u, RATES) - expected).abs() < 1e-9);
        assert!(cost_of(&u, RATES) > 0.0);
    }

    #[test]
    fn a_run_with_no_cache_prices_the_whole_prompt() {
        let u = usage(10_000, 1_000, 0, 11_000);
        let expected = 10_000.0 / 1e6 * 3.0 + 1_000.0 / 1e6 * 15.0;
        assert!((cost_of(&u, RATES) - expected).abs() < 1e-9);
    }

    #[test]
    fn zero_usage_costs_nothing() {
        assert_eq!(cost_of(&usage(0, 0, 0, 0), RATES), 0.0);
    }
}

#[cfg(test)]
mod continue_behavior_tests {
    use super::*;

    /// The continuation must carry the task's original MCP scope verbatim,
    /// including an EXPLICIT empty list (the task UI sends [] when every MCP
    /// checkbox is unchecked). Omitting it would re-enable ALL servers on the
    /// continuation — and one connecting mid-task would leak its tools in.
    #[test]
    fn an_empty_mcp_scope_is_preserved_not_treated_as_all_servers() {
        let task_mcp_servers = Some(vec![]);
        let behavior = task_mcp_servers.as_ref().map(|servers| AgentBehavior {
            mode: None,
            system_prompt: None,
            enabled_tools: None,
            max_iterations: None,
            response_format: None,
            extra_instructions: None,
            mcp_servers: Some(servers.clone()),
            mcp_context: None,
            intent: None,
        });
        let behavior = behavior.expect("an explicit [] must produce a Some behavior");
        assert_eq!(behavior.mcp_servers, Some(vec![]));
        // Round-trips through JSON the way the run-task event payload will.
        let json = serde_json::to_value(&behavior).unwrap();
        assert_eq!(json["mcp_servers"], serde_json::json!([]));
    }

    #[test]
    fn a_named_scope_is_preserved_too() {
        let task_mcp_servers = Some(vec!["backlog".to_string()]);
        let behavior = task_mcp_servers.as_ref().map(|servers| AgentBehavior {
            mode: None,
            system_prompt: None,
            enabled_tools: None,
            max_iterations: None,
            response_format: None,
            extra_instructions: None,
            mcp_servers: Some(servers.clone()),
            mcp_context: None,
            intent: None,
        });
        let json = serde_json::to_value(behavior.unwrap()).unwrap();
        assert_eq!(json["mcp_servers"], serde_json::json!(["backlog"]));
    }

    /// TaskInfo persistence: an empty MCP scope must survive the JSON round-trip
    /// that task_history.json performs (old history without the field loads as None).
    #[test]
    fn task_info_round_trips_the_mcp_scope() {
        let t = TaskInfo {
            id: "t1".into(),
            prompt: "p".into(),
            status: "completed".into(),
            progress: 1.0,
            token_usage: TokenUsage::default(),
            model_usage: HashMap::new(),
            started_at: "2026-01-01T00:00:00Z".into(),
            completed_at: Some("2026-01-01T00:01:00Z".into()),
            workspace_path: Some("C:/ws".into()),
            caller: Some("NewTask".into()),
            mcp_servers: Some(vec![]),
            result_summary: None,
            modified_files: vec![],
            logs: vec![],
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["mcp_servers"], serde_json::json!([]));
        let back: TaskInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back.mcp_servers, Some(vec![]));
    }

    #[test]
    fn old_history_without_the_field_loads_as_none() {
        let json = serde_json::json!({
            "id": "old", "prompt": "p", "status": "completed", "progress": 1.0,
            "token_usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
            "started_at": "2026-01-01T00:00:00Z", "completed_at": null,
            "workspace_path": "C:/ws", "caller": "NewTask",
            "result_summary": null, "logs": []
        });
        let t: TaskInfo = serde_json::from_value(json).unwrap();
        assert_eq!(t.mcp_servers, None);
        // Old history has no modified_files → defaults to empty (no panic).
        assert!(t.modified_files.is_empty());
    }

    /// TaskInfo persistence: the diff content must survive the JSON round-trip
    /// that task_history.json performs, so a task loaded from HISTORY can still
    /// re-open its per-file diffs.
    #[test]
    fn task_info_round_trips_modified_files() {
        let t = TaskInfo {
            id: "t1".into(),
            prompt: "p".into(),
            status: "completed".into(),
            progress: 1.0,
            token_usage: TokenUsage::default(),
            model_usage: HashMap::new(),
            started_at: "2026-01-01T00:00:00Z".into(),
            completed_at: Some("2026-01-01T00:01:00Z".into()),
            workspace_path: Some("C:/ws".into()),
            caller: Some("NewTask".into()),
            mcp_servers: None,
            result_summary: None,
            modified_files: vec![
                serde_json::json!({"path": "C:/ws/a.js", "original": "old", "current": "new"})
            ],
            logs: vec![],
        };
        let json = serde_json::to_value(&t).unwrap();
        let back: TaskInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back.modified_files.len(), 1);
        assert_eq!(back.modified_files[0]["path"], "C:/ws/a.js");
        assert_eq!(back.modified_files[0]["original"], "old");
        assert_eq!(back.modified_files[0]["current"], "new");
    }
}
