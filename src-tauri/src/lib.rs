// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tauri::{Manager, Listener, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::net::TcpListener;
use serde::Deserialize;
use chrono::Local;

mod server;
mod commands;
mod path_guard;

use crate::server::router::{create_router, AppState, TaskInfo};
use crate::server::auth::generate_token;
use crate::commands::indexer::IndexerState;
use crate::commands::mcp::{McpState, McpWsState};
use crate::path_guard::PathGuard;

// Tauri state to share token and port with frontend
pub struct ServerConfig {
    pub token: String,
    pub port: u16,
}

#[derive(Debug, Deserialize, Clone)]
struct BridgeEvent {
    #[serde(rename = "taskId")]
    task_id: String,
    event: String,
    data: serde_json::Value,
    priority: Option<String>,
    #[allow(dead_code)]
    timestamp: String,
}

#[tauri::command]
fn get_api_token(config: tauri::State<'_, ServerConfig>) -> String {
    config.token.clone()
}

#[tauri::command]
fn get_server_port(config: tauri::State<'_, ServerConfig>) -> u16 {
    config.port
}

#[derive(serde::Serialize)]
struct StorageUsage {
    task_history_bytes: u64,
    task_logs_bytes: u64,
    task_logs_count: u64,
    comm_log_bytes: u64,
    config_dir: String,
    log_dir: Option<String>,
}

/// Report on-disk storage used by the agent's logs/history so the UI can show
/// sizes and let the user prune. Covers task_history.json, the per-task
/// task_logs/ dir, and (if configured) the ai_communication.log file.
#[tauri::command]
fn get_storage_usage<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> StorageUsage {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let file_size = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);

    let task_history_bytes = file_size(&config_dir.join("task_history.json"));

    let mut task_logs_bytes = 0u64;
    let mut task_logs_count = 0u64;
    if let Ok(rd) = std::fs::read_dir(config_dir.join("task_logs")) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() { task_logs_bytes += m.len(); task_logs_count += 1; }
            }
        }
    }

    let mut comm_log_bytes = 0u64;
    let mut log_dir_out = None;
    if let Ok(txt) = std::fs::read_to_string(config_dir.join("ai_config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(ld) = v.get("log_dir").and_then(|x| x.as_str()) {
                if !ld.is_empty() {
                    log_dir_out = Some(ld.to_string());
                    comm_log_bytes = file_size(&std::path::Path::new(ld).join("ai_communication.log"));
                }
            }
        }
    }

    StorageUsage {
        task_history_bytes,
        task_logs_bytes,
        task_logs_count,
        comm_log_bytes,
        config_dir: config_dir.to_string_lossy().to_string(),
        log_dir: log_dir_out,
    }
}

/// Truncate the ai_communication.log file (if configured). Returns bytes freed.
#[tauri::command]
fn clear_comm_log<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> u64 {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    if let Ok(txt) = std::fs::read_to_string(config_dir.join("ai_config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(ld) = v.get("log_dir").and_then(|x| x.as_str()) {
                if !ld.is_empty() {
                    let p = std::path::Path::new(ld).join("ai_communication.log");
                    let freed = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    let _ = std::fs::write(&p, b"");
                    return freed;
                }
            }
        }
    }
    0
}

/// Bring the main app window to the foreground and hide the spotlight window.
/// Called from the spotlight overlay's "Open App" button.
#[tauri::command]
fn open_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(sp) = app.get_webview_window("spotlight") {
        let _ = sp.hide();
    }
}

/// Register additional directory roots the backend may write to / delete within
/// / use as a shell working dir. Idempotent and additive — the frontend calls
/// this at boot (approved projects, log dir) and per agent session (workspace),
/// plus whenever the user approves an out-of-workspace write.
#[tauri::command]
fn set_allowed_roots(roots: Vec<String>, guard: tauri::State<'_, PathGuard>) {
    guard.add_roots(&roots);
}

/// Diagnostics: current allowlist snapshot.
#[tauri::command]
fn list_allowed_roots(guard: tauri::State<'_, PathGuard>) -> Vec<String> {
    guard.list()
}

/// Compute the per-task logs directory next to `task_history.json`.
/// Returns `<config_dir>/task_logs/`.
fn task_logs_dir(history_path: &std::path::Path) -> PathBuf {
    history_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("task_logs")
}

/// Persist a task to disk: the metadata goes into the big `task_history.json`
/// (kept lean — logs stripped), while the full logs array is written to a
/// per-task sidecar `task_logs/<task_id>.json` so we don't blow up the main
/// history file (500 entries × thousands of log lines each = unreadable).
fn save_task_to_history(path: &std::path::Path, task: &TaskInfo) {
    let mut history: Vec<serde_json::Value> = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };

    let mut entry = serde_json::to_value(task).unwrap_or_default();
    if let Some(obj) = entry.as_object_mut() {
        obj.remove("logs");
    }

    // Update if exists, otherwise append
    if let Some(existing) = history.iter_mut().find(|e| {
        e.get("id").and_then(|id| id.as_str()) == Some(&task.id)
    }) {
        *existing = entry;
    } else {
        history.push(entry);
    }

    // Keep last 500 entries. Also clean up sidecar files for evicted ones.
    if history.len() > 500 {
        let logs_dir = task_logs_dir(path);
        let drain = history.len() - 500;
        let evicted: Vec<String> = history.drain(0..drain)
            .filter_map(|e| e.get("id").and_then(|id| id.as_str()).map(String::from))
            .collect();
        for id in evicted {
            let _ = std::fs::remove_file(logs_dir.join(format!("{}.json", id)));
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = std::fs::write(path, json);
    }

    // Write the per-task logs sidecar. Best-effort; failures are silent so
    // they don't break the metadata write.
    let logs_dir = task_logs_dir(path);
    if !logs_dir.exists() {
        let _ = std::fs::create_dir_all(&logs_dir);
    }
    let logs_path = logs_dir.join(format!("{}.json", task.id));
    if let Ok(logs_json) = serde_json::to_string(&task.logs) {
        let _ = std::fs::write(logs_path, logs_json);
    }
}

/// Load the persisted logs for a task from its sidecar file.
/// Returns an empty Vec on any error (file missing, parse failure, etc.) —
/// the caller treats "no logs found" and "task has no logs" the same way.
pub fn load_task_logs(history_path: &std::path::Path, task_id: &str) -> Vec<serde_json::Value> {
    let logs_path = task_logs_dir(history_path).join(format!("{}.json", task_id));
    if !logs_path.exists() { return vec![]; }
    std::fs::read_to_string(&logs_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Delete the persisted logs sidecar for a task (called on history deletion).
pub fn delete_task_logs(history_path: &std::path::Path, task_id: &str) {
    let logs_path = task_logs_dir(history_path).join(format!("{}.json", task_id));
    let _ = std::fs::remove_file(logs_path);
}

fn load_task_history(path: &std::path::Path) -> Vec<TaskInfo> {
    if !path.exists() { return vec![]; }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn get_free_port() -> Option<u16> {
    // Try to bind to port 14300 first to keep connection stable across restarts
    if std::net::TcpListener::bind("127.0.0.1:14300").is_ok() {
        return Some(14300);
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance guard MUST be the first plugin: launching a second
        // copy (e.g. `tauri dev` while a previous build still sits in the tray,
        // since the ✕ button hides instead of exiting) used to crash on the
        // duplicate Ctrl+Shift+Space hotkey registration. Now the second launch
        // exits immediately and the EXISTING instance shows/focuses its window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(IndexerState::default())
        .manage(McpState::default())
        .manage(McpWsState::default())
        .manage(PathGuard::default())
        .setup(|app| {
            // Save settings directory path
            let config_dir = app.path().app_config_dir().unwrap_or_default();
            if !config_dir.exists() {
                let _ = std::fs::create_dir_all(&config_dir);
            }
            let config_path = config_dir.join("ai_config.json");

            // ── Seed the path guard with always-allowed roots ──────────────
            // The app config dir (skills, history, session backups, artifacts)
            // and the OS temp dir must always be writable by the backend. The
            // frontend extends this list with the workspace / approved projects.
            {
                let guard = app.state::<PathGuard>();
                guard.add_root(&config_dir);
                guard.add_root(std::env::temp_dir());
            }

            // Load or generate auth token
            let mut auth_token = String::new();
            if config_path.exists() {
                if let Ok(json) = std::fs::read_to_string(&config_path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(t) = val.get("connection_token").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                auth_token = t.to_string();
                            }
                        }
                    }
                }
            }
            
            if auth_token.is_empty() {
                auth_token = generate_token();
                // Save it back to ai_config.json to persist it
                let json_str = std::fs::read_to_string(&config_path).unwrap_or_else(|_| "{}".to_string());
                if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    val["connection_token"] = serde_json::Value::String(auth_token.clone());
                    if let Ok(updated_json) = serde_json::to_string_pretty(&val) {
                        let _ = std::fs::write(&config_path, updated_json);
                    }
                }
            }
            
            // Find an open port, fallback to 14300
            let port = get_free_port().unwrap_or(14300);

            // Setup state
            let tasks = Arc::new(Mutex::new(HashMap::<String, TaskInfo>::new()));
            let task_senders = Arc::new(Mutex::new(HashMap::<String, tokio::sync::broadcast::Sender<String>>::new()));

            // Load historical tasks from previous sessions
            let history_path: PathBuf = config_dir.join("task_history.json");
            {
                let historical = load_task_history(&history_path);
                let mut map = tasks.lock().unwrap();
                for mut task in historical {
                    // Tasks that were running when the app closed are now failed
                    if task.status == "running" || task.status == "paused" {
                        task.status = "failed".to_string();
                        if task.completed_at.is_none() {
                            task.completed_at = Some(Local::now().to_rfc3339());
                        }
                    }
                    map.insert(task.id.clone(), task);
                }
            }

            let app_state = AppState {
                auth_token: auth_token.clone(),
                port,
                tasks: tasks.clone(),
                task_senders: task_senders.clone(),
                config_path,
                history_path: history_path.clone(),
                app_handle: app.handle().clone(),
            };

            // Manage server config for Tauri commands
            app.manage(ServerConfig {
                token: auth_token.clone(),
                port,
            });

            // Start Axum server in a background thread
            let router = create_router(app_state);
            let addr = format!("127.0.0.1:{}", port);
            
            let server_token = auth_token.clone();
            tauri::async_runtime::spawn(async move {
                let listener = TcpListener::bind(&addr).await.expect("Failed to bind port");
                println!("J.H AI Agent server running on http://{}", addr);
                println!("J.H AI Agent token: {}", server_token);
                axum::serve(listener, router).await.unwrap();
            });

            // Listen for events from tauri Webview and bridge them to WebSocket client
            let tasks_bridge = tasks.clone();
            let senders_bridge = task_senders.clone();
            let history_path_bridge = history_path.clone();
            
            app.listen("task-event-bridge", move |event| {
                if let Ok(payload) = serde_json::from_str::<BridgeEvent>(event.payload()) {
                    let task_id = payload.task_id.clone();
                    let event_type = payload.event.clone();

                    let ws_packet = serde_json::json!({
                        "event": event_type,
                        "data": payload.data,
                        "priority": payload.priority,
                        "timestamp": Local::now().to_rfc3339()
                    });

                    // 1. Update task info in-memory, store log entry, snapshot for persistence
                    let is_terminal = event_type == "complete" || event_type == "error";
                    let task_snapshot_for_history = {
                        let mut tasks = tasks_bridge.lock().unwrap();
                        let mut snapshot = None;
                        if let Some(task) = tasks.get_mut(&task_id) {
                            match event_type.as_str() {
                                "status" => {
                                    if let Some(status) = ws_packet["data"].get("status").and_then(|s| s.as_str()) {
                                        task.status = status.to_string();
                                    }
                                    if let Some(progress) = ws_packet["data"].get("progress").and_then(|p| p.as_f64()) {
                                        task.progress = progress as f32;
                                    }
                                }
                                "token_usage" => {
                                    // ACCUMULATE across LLM calls. Each token_usage event is
                                    // ONE call's usage; the task total is the sum of all calls.
                                    // (Previously these were assignments, so the persisted task
                                    // kept only the LAST step's usage — usually a tool-only step
                                    // with ~0 tokens → the "Tokens: 0" bug on completed tasks.)
                                    if let Some(prompt) = ws_packet["data"].get("prompt_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.prompt_tokens = task.token_usage.prompt_tokens.saturating_add(prompt as u32);
                                    }
                                    if let Some(completion) = ws_packet["data"].get("completion_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.completion_tokens = task.token_usage.completion_tokens.saturating_add(completion as u32);
                                    }
                                    // Accumulate cache tokens too, so the persisted/reloaded task
                                    // summary matches the per-step cache counts (was: never summed →
                                    // header showed ⚡0 while steps showed ⚡N).
                                    if let Some(cr) = ws_packet["data"].get("cache_read_input_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.cache_read_input_tokens = task.token_usage.cache_read_input_tokens.saturating_add(cr as u32);
                                    }
                                    if let Some(cc) = ws_packet["data"].get("cache_creation_input_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.cache_creation_input_tokens = task.token_usage.cache_creation_input_tokens.saturating_add(cc as u32);
                                    }
                                    task.token_usage.total_tokens = task.token_usage.prompt_tokens + task.token_usage.completion_tokens;
                                }
                                "complete" => {
                                    task.status = "completed".to_string();
                                    task.progress = 1.0;
                                    task.completed_at = Some(Local::now().to_rfc3339());
                                    // Persist the structured result summary for the API + Result tab.
                                    if let Some(rs) = ws_packet["data"].get("resultSummary") {
                                        if !rs.is_null() {
                                            task.result_summary = Some(rs.clone());
                                        }
                                    }
                                }
                                "error" => {
                                    task.status = "failed".to_string();
                                    task.completed_at = Some(Local::now().to_rfc3339());
                                }
                                _ => {}
                            }
                            // Store all non-stream events for historical replay
                            if event_type != "stream" {
                                task.logs.push(ws_packet.clone());
                            }
                            if is_terminal {
                                snapshot = Some(task.clone());
                            }
                        }
                        snapshot
                    }; // lock released here

                    // Persist terminal tasks to disk (in background thread)
                    if let Some(snapshot) = task_snapshot_for_history {
                        let hist_path = history_path_bridge.clone();
                        std::thread::spawn(move || save_task_to_history(&hist_path, &snapshot));
                    }

                    // 2. Relay the JSON packet to corresponding WebSocket client
                    {
                        let senders = senders_bridge.lock().unwrap();
                        if let Some(tx) = senders.get(&task_id) {
                            if let Ok(msg_str) = serde_json::to_string(&ws_packet) {
                                let _ = tx.send(msg_str);
                            }
                        }
                    }
                    // Remove sender after terminal events so WS relay loops exit cleanly
                    if is_terminal {
                        let mut senders = senders_bridge.lock().unwrap();
                        senders.remove(&task_id);
                    }
                }
            });

            // ── System tray setup ────────────────────────────────────
            let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip("J.H AI Agent")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            // Keep the tray icon alive for the entire app lifetime.
            // TrayIcon's Drop removes it from the system tray, so we
            // intentionally forget the handle here (one-time, tiny allocation).
            std::mem::forget(tray);

            // ── Close → hide to tray ─────────────────────────────────
            let main_win = app.get_webview_window("main").unwrap();
            let win_hide = main_win.clone();
            main_win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_hide.hide();
                }
            });

            // ── Spotlight window (frameless, transparent, always-on-top) ──
            // Hosts ONLY the quick-search / ask-AI overlay so Ctrl+Shift+Space
            // shows just a floating modal on the desktop instead of the full app.
            // Same bundle (index.html) — main.js detects the "spotlight" label and
            // renders only the overlay. Created hidden; shown by the shortcut.
            match tauri::WebviewWindowBuilder::new(
                app.handle(),
                "spotlight",
                tauri::WebviewUrl::App("index.html".into()),
            )
                .title("J.H AI Agent — Spotlight")
                .inner_size(720.0, 580.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                // Prevent the drag-region's double-click from maximizing the
                // spotlight to fullscreen.
                .maximizable(false)
                .visible(false)
                .center()
                .build()
            {
                Ok(spotlight) => {
                    // Auto-hide on focus loss (click elsewhere) — Spotlight behavior.
                    let sh = spotlight.clone();
                    spotlight.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            let _ = sh.hide();
                        }
                    });
                }
                Err(e) => eprintln!("Failed to create spotlight window: {}", e),
            }

            // ── Global shortcut: Ctrl+Shift+Space → show spotlight overlay ──
            // Registration can fail when ANOTHER process already holds the key —
            // most commonly a previous instance of this app still living in the
            // tray (the titlebar ✕ hides instead of exiting), or another tool.
            // That must NOT abort startup (it used to `?` → setup panic → the
            // whole app failed to launch); the spotlight shortcut is optional.
            let shortcut_handle = app.handle().clone();
            let shortcut_result = app.handle()
                .global_shortcut()
                .on_shortcut(
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                    move |_app, _sc, event| {
                        if event.state() == ShortcutState::Pressed {
                            // Don't pop the floating spotlight when the user is
                            // already inside the app: if the MAIN window is focused,
                            // suppress the shortcut entirely (the in-app UI is right
                            // there). The spotlight is for quick access from OUTSIDE.
                            let main_focused = shortcut_handle
                                .get_webview_window("main")
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or(false);
                            if main_focused {
                                return;
                            }

                            // Prefer the dedicated spotlight window: show only the modal.
                            if let Some(w) = shortcut_handle.get_webview_window("spotlight") {
                                let _ = w.center();
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = shortcut_handle.emit_to("spotlight", "show-search", ());
                            } else if let Some(w) = shortcut_handle.get_webview_window("main") {
                                // Fallback: spotlight unavailable → old in-app overlay.
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = shortcut_handle.emit("show-search", ());
                            }
                        }
                    },
                );
            if let Err(e) = shortcut_result {
                eprintln!(
                    "[JHAI] WARNING: Ctrl+Shift+Space global shortcut registration failed: {}. \
                     The quick-search spotlight won't open via the shortcut. \
                     Likely cause: another instance of this app is still running in the tray \
                     (the ✕ button hides instead of exiting) or another program owns the key. \
                     Close the other instance and restart to restore the shortcut.",
                    e
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_token,
            get_server_port,
            open_main_window,
            get_storage_usage,
            clear_comm_log,
            // Path guard (defense-in-depth write/exec allowlist)
            set_allowed_roots,
            list_allowed_roots,
            // AI commands
            commands::ai::llm_chat_native,
            commands::ai_config::get_ai_config,
            commands::ai_config::save_ai_config,
            commands::ai_config::set_rag_approval,
            commands::ai_config::export_connection_config,
            // RAG / Indexer
            commands::indexer::init_indexer,
            commands::indexer::query_workspace,
            commands::indexer::is_indexing,
            commands::indexer::get_directory_structure,
            // File operations
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::read_dir,
            commands::fs::create_dir,
            commands::fs::delete_dir,
            commands::fs::file_exists,
            commands::fs::select_folder,
            commands::fs::read_file_bytes,
            commands::fs::parse_excel_to_html,
            // Search & FS-mutation operations
            commands::search::grep_search,
            commands::search::glob_files,
            commands::search::delete_file,
            commands::search::move_file,
            // Shell operations
            commands::shell::run_command,
            commands::shell::open_path_default,
            // Web search (self-built, no API key — server-side to bypass CORS)
            commands::web::web_search,
            // MCP process management (bypasses shell plugin scope restrictions)
            commands::mcp::mcp_spawn,
            commands::mcp::mcp_ws_send,
            commands::mcp::mcp_ws_close,
            commands::mcp::mcp_write,
            commands::mcp::mcp_kill,
            // Skill file management
            commands::ai_config::get_app_config_dir,
            commands::ai_config::list_skill_files,
            commands::ai_config::read_skill_file,
            commands::ai_config::write_skill_file,
            commands::ai_config::delete_skill_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
